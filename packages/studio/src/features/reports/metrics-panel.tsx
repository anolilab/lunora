import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { LiveError } from "../../components/live-status";
import { ShardInput } from "../../components/shard-input";
import { Button } from "../../components/ui/button";
import type { AdminQueryResult } from "../../hooks/use-admin-query";
import { useAdminQuery } from "../../hooks/use-admin-query";
import useOpenTrace from "../../hooks/use-open-trace";
import { useShardKey } from "../../hooks/use-shard-key";
import useStudioClient from "../../hooks/use-studio-client";
import { useT } from "../../i18n/i18n-context";
import type { MetricsSnapshot, ShardMetrics } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { CLOUDFLARE_DURABLE_OBJECTS_URL } from "../../lib/cf-links";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import { loadRecentShards, recordShard } from "../../lib/shard-history";
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

const EMPTY_HISTORY: ReadonlyArray<number> = [];

type MetricsTab = "overview" | "query-insights";

/**
 * The tab actually shown. The query-insights tab only exists while the active
 * shard/snapshot carries `queryStats`; if it vanishes while selected, fall back to
 * overview so the body never blanks pointing at a tab that no longer renders.
 */
const resolveTab = (hasQueryStats: boolean, activeTab: MetricsTab): MetricsTab => (hasQueryStats ? activeTab : "overview");

/**
 * The committed shard's `getMetrics` read, plus the requests-per-sample
 * sparkline series accumulated from each fresh snapshot (one-shot or live push);
 * also records the browsed shard.
 *
 * An inherently stream-accumulating side effect: each new `data` value is
 * diffed against the prior sample (held in refs) to derive one more series
 * point, which can only be computed when a new snapshot lands. The first sample
 * and any counter reset (DO hibernation) are skipped (no prior point / a bogus
 * delta).
 *
 * The series is tagged with its shard and reads as empty under any other: a new
 * shard's counters are unrelated to the previous shard's, and resetting by tag
 * rather than by a `setState` in the effect means a switch never renders the
 * old shard's series for a frame.
 */
const useShardMetrics = (queryShardKey: string): AdminQueryResult<ShardMetrics> & { history: ReadonlyArray<number> } => {
    // One-shot read + always-on live subscription for the committed shard. Each
    // server push folds in like a refresh; `liveError` holds a rejection message
    // (e.g. missing admin token) so the panel can say why it stopped updating. The
    // one-shot read remains the source of truth.
    const query = useAdminQuery<ShardMetrics>(ADMIN_FUNCTIONS.getMetrics, {}, { live: true, shardKey: queryShardKey });
    const { data } = query;
    const [series, setSeries] = useState<{ points: ReadonlyArray<number>; shard: null | string }>({ points: [], shard: null });

    // Latest cumulative `requests` count, used to derive the per-sample delta,
    // plus the shard it belongs to so a shard switch starts a new series instead
    // of diffing against the previous shard's counters.
    const lastRequestsRef = useRef<null | number>(null);
    const lastShardRef = useRef<null | string>(null);

    useEffect(() => {
        if (data !== undefined) {
            recordShard(queryShardKey);
        }
    }, [data, queryShardKey]);

    useEffect(() => {
        if (data === undefined) {
            return;
        }

        const next = data;
        const previous = lastShardRef.current === next.shard ? lastRequestsRef.current : null;

        lastShardRef.current = next.shard;
        lastRequestsRef.current = next.requests;

        if (previous !== null && next.requests >= previous) {
            setSeries((prior) => {
                return { points: [...(prior.shard === next.shard ? prior.points : []), next.requests - previous].slice(-MAX_HISTORY), shard: next.shard };
            });
        }
    }, [data]);

    return { ...query, history: series.shard !== null && series.shard === data?.shard ? series.points : EMPTY_HISTORY };
};

/**
 * The cross-shard aggregate behind "All shards": a manual fan-out of
 * `getMetrics` across the root, current and recently-visited shards.
 */
const useShardAggregate = (
    shardKey: string,
): {
    aggregate: ReturnType<typeof aggregateMetrics> | null;
    aggregating: boolean;
    clearAggregate: () => void;
    runAggregate: () => void;
    shardResults: ShardMetricsResult[] | null;
} => {
    const client = useStudioClient();

    // Avoid setState after unmount from the manual all-shards aggregate.
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    // Per-shard results for the shards we know about
    // (root + current + recently-visited). `null` = aggregate view not loaded.
    // Tagged with the shard in the input when the fan-out started: the set it
    // covers includes that shard, so the results are shown only while the input
    // still holds it — not under a shard chosen mid-flight or afterwards.
    const [aggregated, setAggregated] = useState<null | { results: ShardMetricsResult[]; shard: string }>(null);
    const [aggregating, setAggregating] = useState<boolean>(false);

    const aggregateAll = async (): Promise<void> => {
        setAggregating(true);

        const startedFor = shardKey;
        const shards = shardsToAggregate(startedFor, loadRecentShards());

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
                setAggregated({ results, shard: startedFor });
            }
        } finally {
            if (mountedRef.current) {
                setAggregating(false);
            }
        }
    };

    const shardResults = aggregated?.shard === shardKey ? aggregated.results : null;

    return {
        aggregate: shardResults === null ? null : aggregateMetrics(shardResults),
        aggregating,
        clearAggregate: (): void => {
            setAggregated(null);
        },
        runAggregate: (): void => {
            fireAndForget(aggregateAll());
        },
        shardResults,
    };
};

/**
 * Enriched query stats, when the snapshot carries `queryStats`.
 * `MetricsSnapshot` extends `ShardMetrics` with the optional `queryStats`
 * field surfaced by post-feature workers. Use an `in` guard to narrow safely
 * without a cast that the type-assertion lint flags.
 */
const queryStatsOf = (metrics: ShardMetrics | null): ReturnType<typeof enrichQueryStats> | undefined => {
    if (!metrics || !("queryStats" in metrics)) {
        return undefined;
    }

    const snapQs = (metrics as MetricsSnapshot).queryStats;

    if (!snapQs || !Array.isArray(snapQs)) {
        return undefined;
    }

    return enrichQueryStats(snapQs);
};

const tabClass = (active: boolean): string =>
    `pb-2 text-sm font-medium transition-colors ${active ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`;

/** The overview / query-insights tab strip; the insights tab carries the query count. */
const MetricsTabs = ({
    activeTab,
    onSelect,
    queryCount,
}: {
    readonly activeTab: MetricsTab;
    readonly onSelect: (tab: MetricsTab) => void;
    readonly queryCount: number;
}): ReactElement => {
    const t = useT();

    const selectOverview = (): void => {
        onSelect("overview");
    };

    const selectQueryInsights = (): void => {
        onSelect("query-insights");
    };

    return (
        <div className="flex gap-2 border-b" data-testid="mt-tabs">
            <button className={tabClass(activeTab === "overview")} data-testid="mt-tab-overview" onClick={selectOverview} type="button">
                {t("Overview")}
            </button>
            <button className={tabClass(activeTab === "query-insights")} data-testid="mt-tab-query-insights" onClick={selectQueryInsights} type="button">
                {t("Query insights")}
                {queryCount > 0 && <span className="ml-1.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{queryCount}</span>}
            </button>
        </div>
    );
};

/** The overview stat cards for one shard's snapshot and its request series. */
const MetricsOverview = ({ history, metrics }: { readonly history: ReadonlyArray<number>; readonly metrics: ShardMetrics }): ReactElement => (
    <MetricsOverviewStats
        currentDelta={history.at(-1) ?? 0}
        errorRate={metrics.requests === 0 ? "—" : `${((metrics.errors / metrics.requests) * 100).toFixed(1)}%`}
        history={history}
        // P90/P95 latency computed from per-function stats in the snapshot.
        // `computeLatencyPercentiles` reads `snapshot.functions` via a cast inside;
        // pre-feature workers return a snapshot without that field → both return 0.
        latencyPercentiles={computeLatencyPercentiles(metrics)}
        metrics={metrics}
    />
);

/** Shard picker, live-error badge, the all-shards aggregate toggle and the Cloudflare link. */
const MetricsToolbar = ({
    aggregating,
    liveError,
    onAggregate,
    onClearAggregate,
    onShardKeyChange,
    shardKey,
}: {
    readonly aggregating: boolean;
    readonly liveError: string | undefined;
    readonly onAggregate: () => void;
    /** Present only while an aggregate is shown. */
    readonly onClearAggregate: (() => void) | undefined;
    readonly onShardKeyChange: (value: string) => void;
    readonly shardKey: string;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-wrap items-center gap-2">
            <ShardInput onChange={onShardKeyChange} testId="mt-shard-input" value={shardKey} />
            <LiveError message={liveError} prefix="mt" />
            <Button data-testid="mt-aggregate" disabled={aggregating} onClick={onAggregate} size="sm" type="button" variant="secondary">
                {aggregating ? t("Aggregating…") : t("All shards")}
            </Button>
            {onClearAggregate !== undefined && (
                <Button data-testid="mt-aggregate-clear" onClick={onClearAggregate} size="sm" type="button" variant="ghost">
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
    );
};

/**
 * Health snapshot for a single shard: request / error counts (since the DO last
 * woke), its live SQLite size, and reactive-cache hit/miss stats when a cache is
 * configured. Reads via the `__lunora_admin__:getMetrics` RPC over the
 * {@link useStudioClient} client; gated by the server's `LUNORA_ADMIN_TOKEN`.
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
    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);
    /** Active panel tab: "overview" (default) or "query-insights" (shown when queryStats present). */
    const [activeTab, setActiveTab] = useState<MetricsTab>("overview");

    // Exemplar drill-down: open the trace a metric point sampled, on the shard the
    // series was queried from.
    const openTrace = useOpenTrace(queryShardKey);

    const { data, error, history, liveError } = useShardMetrics(queryShardKey);

    const metrics = data ?? null;

    const { aggregate, aggregating, clearAggregate, runAggregate, shardResults } = useShardAggregate(shardKey);

    const queryStats = useMemo(() => queryStatsOf(metrics), [metrics]);

    // The shown tab, falling back to overview when the active shard/snapshot has no
    // query insights (see {@link resolveTab}) so a vanished tab never blanks the body.
    const effectiveTab = resolveTab(queryStats !== undefined, activeTab);

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-metrics">
            <MetricsToolbar
                aggregating={aggregating}
                liveError={liveError}
                onAggregate={runAggregate}
                onClearAggregate={shardResults === null ? undefined : clearAggregate}
                onShardKeyChange={setShardKey}
                shardKey={shardKey}
            />

            {error !== null && (
                <p className="text-sm text-destructive" data-testid="mt-error" role="alert">
                    {error}
                </p>
            )}

            {/* Tab selector — shown only when query insights are available. */}
            {queryStats !== undefined && <MetricsTabs activeTab={effectiveTab} onSelect={setActiveTab} queryCount={queryStats.length} />}

            {/* Query Insights tab — rendered only when present and selected. */}
            {effectiveTab === "query-insights" && queryStats !== undefined && <QueryInsightsRange shardKey={queryShardKey} />}

            {effectiveTab === "overview" && metrics !== null && <MetricsOverview history={history} metrics={metrics} />}

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
