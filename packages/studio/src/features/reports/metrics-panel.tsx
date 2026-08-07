import { useLunora } from "@lunora/react";
import { useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useShardKey } from "../../hooks/use-shard-key";
import { useT } from "../../i18n/i18n-context";
import type { MetricsSnapshot, ShardMetrics } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { CLOUDFLARE_DURABLE_OBJECTS_URL } from "../../lib/cf-links";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { loadRecentShards, recordShard } from "../../lib/shard-history";
import { writePendingTraceFilter } from "../../lib/trace-handoff";
import { InstrumentsTable } from "./instruments-table";
import type { ShardMetricsResult } from "./metrics-aggregate";
import { aggregateMetrics, computeLatencyPercentiles, enrichQueryStats, shardsToAggregate } from "./metrics-aggregate";
import MetricsAggregateView from "./metrics-aggregate-view";
import MetricsOverviewStats from "./metrics-overview-stats";
import QueryInsightsRange from "./query-insights-range";

interface MetricsPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);

/** Maximum number of samples retained in the rolling history window. */
const MAX_HISTORY = 30;

/**
 * The tab actually shown. The query-insights tab only exists while the active
 * shard/snapshot carries `queryStats`; if it vanishes while selected, fall back to
 * overview so the body never blanks pointing at a tab that no longer renders.
 */
const resolveTab = (hasQueryStats: boolean, activeTab: "overview" | "query-insights"): "overview" | "query-insights" =>
    hasQueryStats ? activeTab : "overview";

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

    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);
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

    // Exemplar drill-down: stash the trace id — and the shard the series was queried
    // on, so the Traces panel searches the right ring rather than the root — for the
    // Traces panel to pick up and pre-filter on mount, then navigate there. A
    // one-shot handoff keeps the two panels decoupled from the router's search schema.
    const openTrace = (traceId: string): void => {
        writePendingTraceFilter({ shardKey: queryShardKey, traceId });
        fireAndForget(navigate({ to: "/traces" }));
    };

    // One-shot read + always-on live subscription for the committed shard. Each
    // server push folds in like a refresh; `liveError` holds a rejection message
    // (e.g. missing admin token) so the panel can say why it stopped updating. The
    // one-shot read remains the source of truth.
    const { data, error, liveError } = useAdminQuery<ShardMetrics>(ADMIN_FUNCTIONS.getMetrics, {}, { live: true, shardKey: queryShardKey });

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

        recordShard(queryShardKey);

        const next = data;
        const previous = lastRequestsRef.current;
        const shardChanged = lastShardRef.current !== null && lastShardRef.current !== next.shard;

        lastShardRef.current = next.shard;
        lastRequestsRef.current = next.requests;

        if (shardChanged) {
            /* eslint-disable react-x/set-state-in-effect -- resetting the per-shard series is part of folding a new snapshot into derived stream state, not an unconditional mount-time reset. */
            // react-doctor-disable-next-line react-doctor/no-chain-state-updates -- the two updates belong to different phases of one async aggregate (start vs result) and cannot be written together
            setHistory([]);
            /* eslint-enable react-x/set-state-in-effect */

            return;
        }

        if (previous !== null && next.requests >= previous) {
            setHistory((prior) => [...prior, next.requests - previous].slice(-MAX_HISTORY));
        }
    }, [data, queryShardKey]);

    // Cross-shard aggregate: per-shard results for the shards we know about
    // (root + current + recently-visited). `null` = aggregate view not loaded.
    const [shardResults, setShardResults] = useState<null | ShardMetricsResult[]>(null);
    const [aggregating, setAggregating] = useState<boolean>(false);

    const aggregateAll = async (): Promise<void> => {
        setAggregating(true);

        const shards = shardsToAggregate(shardKey, loadRecentShards());

        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `try` without `catch`; the `finally` must still clear the busy flag on the throw path, and adding a catch just to satisfy the compiler would swallow the error
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
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- `metrics` is derived from `data` above and listed in the deps
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
            {effectiveTab === "query-insights" && queryStats !== undefined && <QueryInsightsRange shardKey={queryShardKey} />}

            {effectiveTab === "overview" && metrics !== null && (
                <MetricsOverviewStats
                    currentDelta={currentDelta}
                    errorRate={errorRate}
                    history={history}
                    latencyPercentiles={latencyPercentiles}
                    metrics={metrics}
                />
            )}

            {effectiveTab === "overview" && metrics === null && null}

            {/*
             * The third observability signal: aggregated `ctx.metrics.*` series for
             * this shard. Self-contained (its own live read), renders nothing until a
             * series exists, and sits below the shard-health cards on the overview.
             */}
            {effectiveTab === "overview" && <InstrumentsTable onOpenTrace={openTrace} shardKey={queryShardKey} />}

            {effectiveTab === "overview" && aggregate !== null && shardResults !== null && (
                <MetricsAggregateView aggregate={aggregate} shardResults={shardResults} />
            )}
        </div>
    );
};

export type { MetricsPanelProps };
