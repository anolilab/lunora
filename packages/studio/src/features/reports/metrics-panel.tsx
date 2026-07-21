import { useLunora } from "@lunora/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { writePendingTraceFilter } from "../../lib/trace-handoff";

import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import type { MetricsSnapshot, ShardMetrics } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { CLOUDFLARE_DURABLE_OBJECTS_URL } from "../../lib/cf-links";
import { adminRef, callOptions, errorMessage, fireAndForget, formatBytes } from "../../lib/internal";
import { loadRecentShards, recordShard } from "../../lib/shard-history";
import { InstrumentsTable } from "./instruments-table";
import type { ShardMetricsResult } from "./metrics-aggregate";
import { aggregateMetrics, computeLatencyPercentiles, enrichQueryStats, shardsToAggregate } from "./metrics-aggregate";
import { QueryInsights } from "./query-insights";
import { Sparkline } from "./sparkline";

interface MetricsPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);

/** Maximum number of samples retained in the rolling history window. */
const MAX_HISTORY = 30;

/** Render an elapsed-millisecond duration as `1h 2m`, `3m 4s`, or `5s`. */
const formatDuration = (ms: number): string => {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return `${hours.toString()}h ${minutes.toString()}m`;
    }

    if (minutes > 0) {
        return `${minutes.toString()}m ${seconds.toString()}s`;
    }

    return `${seconds.toString()}s`;
};

/**
 * The tab actually shown. The query-insights tab only exists while the active
 * shard/snapshot carries `queryStats`; if it vanishes while selected, fall back to
 * overview so the body never blanks pointing at a tab that no longer renders.
 */
const resolveTab = (hasQueryStats: boolean, activeTab: "overview" | "query-insights"): "overview" | "query-insights" =>
    hasQueryStats ? activeTab : "overview";

/** Cache hit-rate as a percentage string, or `—` when there's been no traffic. */
const hitRate = (hits: number, misses: number): string => {
    const total = hits + misses;

    return total === 0 ? "—" : `${((hits / total) * 100).toFixed(1)}%`;
};

/**
 * One labelled metric as a KPI card: an uppercase label on top, the value (with
 * an optional sparkline beside it), and an optional tinted footer band — the
 * studio's shared stat-card anatomy.
 */
const StatCard = ({
    chart,
    footer,
    label,
    testId,
    value,
}: {
    chart?: ReactNode;
    footer?: ReactNode;
    label: string;
    testId?: string;
    value: ReactNode;
}): ReactElement => (
    <Card className="justify-between gap-0 py-0">
        <div className="flex flex-col gap-2.5 p-4">
            <span className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">{label}</span>
            <div className="flex items-center justify-between gap-3">
                <span className="truncate text-2xl font-semibold tabular-nums text-foreground" data-testid={testId}>
                    {value}
                </span>
                {chart}
            </div>
        </div>
        {footer != null && <div className="border-t border-border bg-muted/50 px-4 py-2.5 text-[11px] text-muted-foreground">{footer}</div>}
    </Card>
);

/**
 * Health snapshot for a single shard: request / error counts (since the DO last
 * woke), its live SQLite size, and reactive-cache hit/miss stats when a cache is
 * configured. Reads via the `__lunora_admin__:getMetrics` RPC over the
 * {@link useLunora} client; gated by the server's `LUNORA_ADMIN_TOKEN`.
 *
 * Counters are per-DO-instance and reset on hibernation/restart — this is a
 * "since this instance woke" readout, not a durable time series.
 *
 * The panel is always live: a `getMetrics` WebSocket subscription opens once the
 * first one-shot seed commits a shard and re-pushes on every server write-flush,
 * accumulating a client-side, in-memory series of requests-per-sample (the delta
 * of `requests` between consecutive samples), rendered as an inline-SVG
 * sparkline. The series is capped at {@link MAX_HISTORY} points and is lost on
 * remount.
 */
export const MetricsPanel = ({ initialShardKey }: MetricsPanelProps): ReactElement => {
    const client = useLunora();
    const t = useT();
    const navigate = useNavigate();

    // Exemplar drill-down: stash the trace id — and the shard the series was queried
    // on, so the Traces panel searches the right ring rather than the root — for the
    // Traces panel to pick up and pre-filter on mount, then navigate there. A
    // one-shot handoff keeps the two panels decoupled from the router's search schema.
    const openTrace = (traceId: string): void => {
        writePendingTraceFilter({ shardKey: debouncedShard, traceId });
        fireAndForget(navigate({ to: "/traces" }));
    };

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    /** Active panel tab: "overview" (default) or "query-insights" (shown when queryStats present). */
    const [activeTab, setActiveTab] = useState<"overview" | "query-insights">("overview");
    const [history, setHistory] = useState<ReadonlyArray<number>>([]);

    // Latest cumulative `requests` count, used to derive the per-sample delta,
    // plus the shard it belongs to so a shard switch resets the series instead
    // of diffing against the previous shard's counters.
    const lastRequestsRef = useRef<null | number>(null);
    const lastShardRef = useRef<null | string>(null);

    // Avoid setState after unmount from the manual all-shards aggregate.
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    // The shard the read targets, debounced so typing a key settles before
    // refetching (and re-subscribing) rather than firing per keystroke.
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    // One-shot read + always-on live subscription for the committed shard. Each
    // server push folds in like a refresh; `liveError` holds a rejection message
    // (e.g. missing admin token) so the panel can say why it stopped updating. The
    // one-shot read remains the source of truth.
    const { data, error, liveError } = useAdminQuery<ShardMetrics>(ADMIN_FUNCTIONS.getMetrics, {}, { live: true, shardKey: debouncedShard });

    const metrics = data ?? null;

    // Fold each fresh metrics snapshot (one-shot or live push) into the
    // requests-per-sample sparkline series as it arrives — an inherently
    // stream-accumulating side effect: each new `data` value is diffed against the
    // prior sample (held in refs) to derive one more series point, which can only
    // be computed when a new snapshot lands. A new shard's counters are unrelated
    // to the previous shard's, so reset the series rather than emit a spurious
    // cross-shard delta; the first sample and any counter reset (DO hibernation)
    // are skipped (no prior point / a bogus delta). Also records the browsed shard.
    useEffect(() => {
        if (data === undefined) {
            return;
        }

        recordShard(debouncedShard);

        const next = data;
        const previous = lastRequestsRef.current;
        const shardChanged = lastShardRef.current !== null && lastShardRef.current !== next.shard;

        lastShardRef.current = next.shard;
        lastRequestsRef.current = next.requests;

        if (shardChanged) {
            // eslint-disable-next-line react-x/set-state-in-effect -- resetting the per-shard series is part of folding a new snapshot into derived stream state, not an unconditional mount-time reset.
            setHistory([]);

            return;
        }

        if (previous !== null && next.requests >= previous) {
            setHistory((prior) => [...prior, next.requests - previous].slice(-MAX_HISTORY));
        }
    }, [data, debouncedShard]);

    // Cross-shard aggregate: per-shard results for the shards we know about
    // (root + current + recently-visited). `null` = aggregate view not loaded.
    const [shardResults, setShardResults] = useState<null | ShardMetricsResult[]>(null);
    const [aggregating, setAggregating] = useState<boolean>(false);

    const aggregateAll = async (): Promise<void> => {
        setAggregating(true);

        const shards = shardsToAggregate(shardKey, loadRecentShards());

        try {
            const results = await Promise.all(
                shards.map(async (shard): Promise<ShardMetricsResult> => {
                    try {
                        const snapshot = (await client.query(GET_METRICS, {}, callOptions(shard))) as ShardMetrics;

                        return { error: null, metrics: snapshot, shard: shard === "" ? snapshot.shard : shard };
                    } catch (error_) {
                        return { error: errorMessage(error_), metrics: null, shard: shard === "" ? "__root__" : shard };
                    }
                }),
            );

            if (mountedRef.current) {
                setShardResults(results);
            }
        } finally {
            if (mountedRef.current) {
                setAggregating(false);
            }
        }
    };

    const aggregate = shardResults === null ? null : aggregateMetrics(shardResults);

    const errorRate = metrics === null || metrics.requests === 0 ? "—" : `${((metrics.errors / metrics.requests) * 100).toFixed(1)}%`;
    const currentDelta = history.length > 0 ? (history.at(-1) as number) : 0;

    // P90/P95 latency computed from per-function stats in the snapshot.
    // `computeLatencyPercentiles` reads `snapshot.functions` via a cast inside;
    // pre-feature workers return a snapshot without that field → both return 0.
    const latencyPercentiles = metrics ? computeLatencyPercentiles(metrics) : { p90: 0, p95: 0 };

    // Format a millisecond duration for the P90/P95 stat cards.
    const formatMs = (ms: number): string => {
        if (ms <= 0) {
            return "—";
        }

        if (ms < 1) {
            return `${(ms * 1000).toFixed(0)}μs`;
        }

        if (ms < 1000) {
            return `${ms.toFixed(1)}ms`;
        }

        return `${(ms / 1000).toFixed(2)}s`;
    };

    // Enriched query stats — derived when the snapshot contains `queryStats`.
    // `MetricsSnapshot` extends `ShardMetrics` with the optional `queryStats`
    // field surfaced by post-feature workers. Use an `in` guard to narrow safely
    // without a cast that the type-assertion lint flags.
    const queryStats = useMemo((): ReturnType<typeof enrichQueryStats> | undefined => {
        if (!metrics || !("queryStats" in metrics)) {
            return undefined;
        }

        const snapQs = (metrics as MetricsSnapshot).queryStats;

        if (!snapQs || !Array.isArray(snapQs)) {
            return undefined;
        }

        return enrichQueryStats(snapQs);
    }, [metrics]);

    // The shown tab, falling back to overview when the active shard/snapshot has no
    // query insights (see {@link resolveTab}) so a vanished tab never blanks the body.
    const effectiveTab = resolveTab(queryStats !== undefined, activeTab);

    const runAggregate = (): void => {
        fireAndForget(aggregateAll());
    };

    const clearAggregate = (): void => {
        setShardResults(null);
    };

    const switchToOverview = (): void => {
        setActiveTab("overview");
    };

    const switchToQueryInsights = (): void => {
        setActiveTab("query-insights");
    };

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-metrics">
            <div className="flex flex-wrap items-center gap-2">
                <ShardInput onChange={setShardKey} testId="mt-shard-input" value={shardKey} />
                <LiveError message={liveError} prefix="mt" />
                <Button data-testid="mt-aggregate" disabled={aggregating} onClick={runAggregate} size="sm" type="button" variant="secondary">
                    {aggregating ? t("Aggregating…") : t("All shards")}
                </Button>
                {shardResults !== null && (
                    <Button data-testid="mt-aggregate-clear" onClick={clearAggregate} size="sm" type="button" variant="ghost">
                        {t("Hide")}
                    </Button>
                )}
                <a
                    className="text-sm text-primary underline-offset-4 hover:underline"
                    data-testid="mt-cf-link"
                    href={CLOUDFLARE_DURABLE_OBJECTS_URL}
                    rel="noreferrer"
                    target="_blank"
                >
                    {t("Open in Cloudflare")}
                </a>
            </div>

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="mt-error" role="alert">
                    {error}
                </p>
            )}

            {/* Tab selector — shown only when query insights are available. */}
            {queryStats !== undefined && (
                <div className="flex gap-2 border-b" data-testid="mt-tabs">
                    <button
                        className={`pb-2 text-sm font-medium transition-colors ${effectiveTab === "overview" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        data-testid="mt-tab-overview"
                        onClick={switchToOverview}
                        type="button"
                    >
                        {t("Overview")}
                    </button>
                    <button
                        className={`pb-2 text-sm font-medium transition-colors ${effectiveTab === "query-insights" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        data-testid="mt-tab-query-insights"
                        onClick={switchToQueryInsights}
                        type="button"
                    >
                        {t("Query insights")}
                        {queryStats.length > 0 && (
                            <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{queryStats.length}</span>
                        )}
                    </button>
                </div>
            )}

            {/* Query Insights tab — rendered only when present and selected. */}
            {effectiveTab === "query-insights" && queryStats !== undefined && <QueryInsights queryStats={queryStats} />}

            {effectiveTab === "overview" && metrics !== null && (
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-testid="mt-stats">
                    <StatCard
                        chart={
                            history.length >= 2 ? (
                                <Sparkline
                                    ariaLabel={t("Requests per interval over time")}
                                    className="h-7 w-24 text-foreground"
                                    series={history}
                                    testId="mt-sparkline"
                                />
                            ) : undefined
                        }
                        footer={
                            history.length >= 2 ? (
                                <>
                                    <span className="font-semibold text-foreground">{`+${currentDelta.toLocaleString()}`}</span> {t("last interval")}
                                </>
                            ) : (
                                <span data-testid="mt-sparkline-empty">{t("collecting samples…")}</span>
                            )
                        }
                        label={t("Requests")}
                        testId="mt-requests"
                        value={metrics.requests}
                    />
                    <StatCard
                        footer={t("{rate} error rate", { rate: errorRate })}
                        label={t("Errors")}
                        testId="mt-errors"
                        value={
                            <>
                                {metrics.errors} ({errorRate})
                            </>
                        }
                    />
                    <StatCard
                        footer={latencyPercentiles.p90 > 0 ? `P90 ${formatMs(latencyPercentiles.p90)}` : undefined}
                        label={t("P95 latency")}
                        testId="mt-p95"
                        value={latencyPercentiles.p95 > 0 ? formatMs(latencyPercentiles.p95) : "—"}
                    />
                    <StatCard
                        footer={metrics.cache === null ? undefined : `${metrics.cache.entries.toLocaleString()} ${t("cache entries")}`}
                        label={t("Database size")}
                        testId="mt-db-size"
                        value={formatBytes(metrics.databaseSize)}
                    />
                    <StatCard label={t("Shard")} testId="mt-shard" value={metrics.shard} />
                    <StatCard label={t("Uptime")} testId="mt-uptime" value={formatDuration(metrics.uptimeMs)} />
                    <StatCard
                        label={t("Cache hit rate")}
                        testId="mt-cache"
                        value={
                            metrics.cache === null
                                ? t("no cache configured")
                                : t("{rate} ({count} entries)", { count: metrics.cache.entries, rate: hitRate(metrics.cache.hits, metrics.cache.misses) })
                        }
                    />
                </dl>
            )}

            {effectiveTab === "overview" && metrics === null && null}

            {/*
             * The third observability signal: aggregated `ctx.metrics.*` series for
             * this shard. Self-contained (its own live read), renders nothing until a
             * series exists, and sits below the shard-health cards on the overview.
             */}
            {effectiveTab === "overview" && <InstrumentsTable onOpenTrace={openTrace} shardKey={debouncedShard} />}

            {effectiveTab === "overview" && aggregate !== null && shardResults !== null && (
                <div className="flex flex-col gap-4" data-testid="mt-aggregate-view">
                    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="mt-aggregate-stats">
                        <StatCard
                            label={t("Shards")}
                            testId="mt-agg-shards"
                            value={
                                aggregate.failed > 0
                                    ? t("{reachable} reachable, {failed} unreachable", { failed: aggregate.failed, reachable: aggregate.reachable })
                                    : t("{reachable} reachable", { reachable: aggregate.reachable })
                            }
                        />
                        <StatCard label={t("Total requests")} testId="mt-agg-requests" value={aggregate.totalRequests} />
                        <StatCard label={t("Total errors")} testId="mt-agg-errors" value={aggregate.totalErrors} />
                        <StatCard label={t("Total database size")} testId="mt-agg-db-size" value={formatBytes(aggregate.totalDatabaseSize)} />
                        <StatCard
                            label={t("Combined cache hit rate")}
                            testId="mt-agg-cache"
                            value={aggregate.hitRate === null ? t("no cache configured") : `${(aggregate.hitRate * 100).toFixed(1)}%`}
                        />
                    </dl>

                    <Card className="overflow-hidden py-0">
                        <CardContent className="px-0">
                            <Table data-testid="mt-agg-table">
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t("shard")}</TableHead>
                                        <TableHead>{t("requests")}</TableHead>
                                        <TableHead>{t("errors")}</TableHead>
                                        <TableHead>{t("db size")}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {shardResults.map((result) => (
                                        <TableRow data-testid={`mt-agg-row-${result.shard}`} key={result.shard}>
                                            <TableCell>{result.shard}</TableCell>
                                            {result.metrics === null ? (
                                                <TableCell className="text-destructive" colSpan={3}>
                                                    {result.error ?? t("unreachable")}
                                                </TableCell>
                                            ) : (
                                                <>
                                                    <TableCell className="tabular-nums">{result.metrics.requests}</TableCell>
                                                    <TableCell className="tabular-nums">{result.metrics.errors}</TableCell>
                                                    <TableCell className="tabular-nums">{formatBytes(result.metrics.databaseSize)}</TableCell>
                                                </>
                                            )}
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
};

export type { MetricsPanelProps };
