import { useLunora } from "@lunora/react";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import useLiveAdmin from "../../hooks/use-live-admin";
import { useT } from "../../i18n/i18n-context";
import type { MetricsSnapshot, ShardMetrics } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { CLOUDFLARE_DURABLE_OBJECTS_URL } from "../../lib/cf-links";
import { adminRef, callOptions, errorMessage, fireAndForget, formatBytes } from "../../lib/internal";
import { loadRecentShards, recordShard } from "../../lib/shard-history";
import useLiveShardSeed from "../data/hooks/use-live-shard-seed";
import type { ShardMetricsResult } from "./metrics-aggregate";
import { aggregateMetrics, computeLatencyPercentiles, enrichQueryStats, shardsToAggregate } from "./metrics-aggregate";
import { QueryInsights } from "./query-insights";
import { SPARK_HEIGHT, SPARK_WIDTH, sparklinePoints } from "./sparkline";

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

/** Cache hit-rate as a percentage string, or `—` when there's been no traffic. */
const hitRate = (hits: number, misses: number): string => {
    const total = hits + misses;

    return total === 0 ? "—" : `${((hits / total) * 100).toFixed(1)}%`;
};

/** A single labelled metric rendered as a compact stat Card. */
const StatCard = ({ label, testId, value, valueSize = "lg" }: { label: string; testId?: string; value: ReactNode; valueSize?: "lg" | "xl" }): ReactElement => (
    <Card className="rounded-md">
        <CardHeader className="pb-2">
            <CardTitle className="text-xs font-normal text-muted-foreground">{label}</CardTitle>
        </CardHeader>
        <CardContent
            className={valueSize === "xl" ? "text-2xl font-semibold tabular-nums text-foreground" : "text-lg font-semibold tabular-nums text-foreground"}
            data-testid={testId}
        >
            {value}
        </CardContent>
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

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [metrics, setMetrics] = useState<ShardMetrics | null>(null);
    const [error, setError] = useState<null | string>(null);
    /** Active panel tab: "overview" (default) or "query-insights" (shown when queryStats present). */
    const [activeTab, setActiveTab] = useState<"overview" | "query-insights">("overview");
    // The live channel is always on once a shard is committed; this only holds a
    // rejection message (e.g. missing admin token) so the panel can say why it
    // stopped updating. The one-shot seed remains the source of truth.
    const [liveError, setLiveError] = useState<string | undefined>(undefined);
    const [history, setHistory] = useState<ReadonlyArray<number>>([]);

    // Avoid setState after unmount.
    const mountedRef = useRef(true);
    // Latest cumulative `requests` count, used to derive the per-sample delta,
    // plus the shard it belongs to so a shard switch resets the series instead
    // of diffing against the previous shard's counters.
    const lastRequestsRef = useRef<null | number>(null);
    const lastShardRef = useRef<null | string>(null);

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    // Fold a fresh metrics snapshot (one-shot or live push) into panel state,
    // extending the requests-per-sample sparkline series. A fresh sample means
    // the channel is healthy, so clear any stale live-unavailable notice.
    const applySample = useCallback(
        (next: ShardMetrics): void => {
            setError(null);
            setLiveError(undefined);
            setMetrics(next);

            const previous = lastRequestsRef.current;
            // A new shard's counters are unrelated to the previous shard's, so
            // reset the series rather than emit a spurious cross-shard delta.
            const shardChanged = lastShardRef.current !== null && lastShardRef.current !== next.shard;

            lastShardRef.current = next.shard;
            lastRequestsRef.current = next.requests;

            if (shardChanged) {
                setHistory([]);

                return;
            }

            // Skip the first sample (no prior point to diff against) and any counter
            // reset (DO hibernation), which would yield a bogus delta.
            if (previous !== null && next.requests >= previous) {
                setHistory((prior) => [...prior, next.requests - previous].slice(-MAX_HISTORY));
            }
        },
        [setLiveError],
    );

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            try {
                const next = (await client.query(GET_METRICS, {}, callOptions(shard))) as ShardMetrics;

                recordShard(shard);

                if (mountedRef.current) {
                    applySample(next);
                }
            } catch (error_) {
                if (mountedRef.current) {
                    setMetrics(null);
                    setError(errorMessage(error_));
                }

                // Rethrow so the shard-seed hook doesn't commit a shard that failed.
                throw error_;
            }
        },
        [client, applySample],
    );

    // Debounced shard seed + commit-on-success; the live channel keys on the
    // committed shard (replaces the old Refresh button).
    const committedShard = useLiveShardSeed(shardKey, refresh);

    // Live channel: always on once the seed commits a shard; each server push
    // folds in like a refresh.
    useLiveAdmin(
        ADMIN_FUNCTIONS.getMetrics,
        {},
        committedShard ?? "",
        (next) => {
            if (mountedRef.current) {
                applySample(next as ShardMetrics);
            }
        },
        committedShard !== undefined,
        (message) => {
            if (mountedRef.current) {
                setLiveError(message);
            }
        },
    );

    // Cross-shard aggregate: per-shard results for the shards we know about
    // (root + current + recently-visited). `null` = aggregate view not loaded.
    const [shardResults, setShardResults] = useState<null | ShardMetricsResult[]>(null);
    const [aggregating, setAggregating] = useState<boolean>(false);

    const aggregateAll = useCallback(async (): Promise<void> => {
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
    }, [client, shardKey]);

    const aggregate = shardResults === null ? null : aggregateMetrics(shardResults);

    const errorRate = metrics === null || metrics.requests === 0 ? "—" : `${((metrics.errors / metrics.requests) * 100).toFixed(1)}%`;
    const currentDelta = history.length > 0 ? (history.at(-1) as number) : 0;
    // Memoize the polyline so unrelated re-renders (e.g. shard-input typing)
    // don't recompute Math.max/min over the history on every render.
    const sparkline = useMemo(() => sparklinePoints(history), [history]);

    // P90/P95 latency computed from per-function stats in the snapshot.
    // `computeLatencyPercentiles` reads `snapshot.functions` via a cast inside;
    // pre-feature workers return a snapshot without that field → both return 0.
    const latencyPercentiles = useMemo(() => (metrics ? computeLatencyPercentiles(metrics) : { p90: 0, p95: 0 }), [metrics]);

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

    const runAggregate = useCallback((): void => {
        fireAndForget(aggregateAll());
    }, [aggregateAll]);

    const clearAggregate = useCallback((): void => {
        setShardResults(null);
    }, []);

    const switchToOverview = useCallback((): void => {
        setActiveTab("overview");
    }, []);

    const switchToQueryInsights = useCallback((): void => {
        setActiveTab("query-insights");
    }, []);

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

            <div className="flex items-center gap-3 text-sm text-muted-foreground" data-testid="mt-trend">
                <span>{t("Requests / interval")}</span>
                {history.length < 2 && <span data-testid="mt-sparkline-empty">{t("collecting samples…")}</span>}
                {history.length >= 2 && (
                    <>
                        <svg
                            aria-label={t("Requests per interval over time")}
                            className="text-primary"
                            data-testid="mt-sparkline"
                            height={SPARK_HEIGHT}
                            preserveAspectRatio="none"
                            role="img"
                            viewBox={`0 0 ${SPARK_WIDTH.toString()} ${SPARK_HEIGHT.toString()}`}
                            width={SPARK_WIDTH}
                        >
                            <polyline fill="none" points={sparkline} stroke="currentColor" strokeWidth={1} />
                        </svg>
                        <span className="font-medium tabular-nums text-foreground" data-testid="mt-sparkline-value">
                            {currentDelta}
                        </span>
                    </>
                )}
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
                        className={`pb-2 text-sm font-medium transition-colors ${activeTab === "overview" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        data-testid="mt-tab-overview"
                        onClick={switchToOverview}
                        type="button"
                    >
                        {t("Overview")}
                    </button>
                    <button
                        className={`pb-2 text-sm font-medium transition-colors ${activeTab === "query-insights" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
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
            {activeTab === "query-insights" && queryStats !== undefined && <QueryInsights queryStats={queryStats} />}

            {activeTab === "overview" && metrics !== null && (
                <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="mt-stats">
                    <StatCard label={t("Shard")} testId="mt-shard" value={metrics.shard} />
                    <StatCard label={t("Requests")} testId="mt-requests" value={metrics.requests} valueSize="xl" />
                    <StatCard
                        label={t("Errors")}
                        testId="mt-errors"
                        value={
                            <>
                                {metrics.errors} ({errorRate})
                            </>
                        }
                        valueSize="xl"
                    />
                    <StatCard label={t("Uptime")} testId="mt-uptime" value={formatDuration(metrics.uptimeMs)} />
                    <StatCard label={t("Database size")} testId="mt-db-size" value={formatBytes(metrics.databaseSize)} />
                    <StatCard
                        label={t("Cache hit rate")}
                        testId="mt-cache"
                        value={
                            metrics.cache === null
                                ? t("no cache configured")
                                : t("{rate} ({count} entries)", { count: metrics.cache.entries, rate: hitRate(metrics.cache.hits, metrics.cache.misses) })
                        }
                    />
                    {latencyPercentiles.p90 > 0 && <StatCard label={t("P90 latency")} testId="mt-p90" value={formatMs(latencyPercentiles.p90)} />}
                    {latencyPercentiles.p95 > 0 && <StatCard label={t("P95 latency")} testId="mt-p95" value={formatMs(latencyPercentiles.p95)} />}
                </dl>
            )}

            {activeTab === "overview" && metrics === null && null}

            {activeTab === "overview" && aggregate !== null && shardResults !== null && (
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
                        <StatCard label={t("Total requests")} testId="mt-agg-requests" value={aggregate.totalRequests} valueSize="xl" />
                        <StatCard label={t("Total errors")} testId="mt-agg-errors" value={aggregate.totalErrors} valueSize="xl" />
                        <StatCard label={t("Total database size")} testId="mt-agg-db-size" value={formatBytes(aggregate.totalDatabaseSize)} />
                        <StatCard
                            label={t("Combined cache hit rate")}
                            testId="mt-agg-cache"
                            value={aggregate.hitRate === null ? t("no cache configured") : `${(aggregate.hitRate * 100).toFixed(1)}%`}
                        />
                    </dl>

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
                </div>
            )}
        </div>
    );
};

export type { MetricsPanelProps };
