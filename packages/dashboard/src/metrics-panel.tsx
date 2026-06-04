import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ShardMetrics } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { adminRef, callOptions, errorMessage, fireAndForget, formatBytes } from "./internal.js";
import { LiveToggle } from "./live-toggle.js";
import type { ShardMetricsResult } from "./metrics-aggregate.js";
import { aggregateMetrics, shardsToAggregate } from "./metrics-aggregate.js";
import { loadRecentShards, recordShard } from "./shard-history.js";
import { ShardInput } from "./shard-input.js";
import useLiveAdmin from "./use-live-admin.js";
import { useLiveToggle } from "./use-live-toggle.js";

interface MetricsPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);

/** Maximum number of samples retained in the rolling history window. */
const MAX_HISTORY = 30;

/** Inline-SVG sparkline geometry. */
const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 24;

/**
 * Build an SVG polyline `points` string for a series, scaled to fit the
 * {@link SPARK_WIDTH} x {@link SPARK_HEIGHT} viewbox. A flat series renders along
 * the vertical midline.
 */
const sparklinePoints = (series: ReadonlyArray<number>): string => {
    if (series.length < 2) {
        return "";
    }

    const max = Math.max(...series);
    const min = Math.min(...series);
    const span = max - min;
    const stepX = SPARK_WIDTH / (series.length - 1);

    return series
        .map((value, index) => {
            const x = index * stepX;
            const y = span === 0 ? SPARK_HEIGHT / 2 : SPARK_HEIGHT - ((value - min) / span) * SPARK_HEIGHT;

            return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
};

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

/**
 * Health snapshot for a single shard: request / error counts (since the DO last
 * woke), its live SQLite size, and reactive-cache hit/miss stats when a cache is
 * configured. Reads via the `__cirrus_admin__:getMetrics` RPC over the
 * {@link useCirrus} client; gated by the server's `CIRRUS_ADMIN_TOKEN`.
 *
 * Counters are per-DO-instance and reset on hibernation/restart — this is a
 * "since this instance woke" readout, not a durable time series.
 *
 * An opt-in **Live** toggle opens a `getMetrics` WebSocket subscription that
 * re-pushes on every server write-flush, accumulating a client-side, in-memory
 * series of requests-per-sample (the delta of `requests` between consecutive
 * samples), rendered as an inline-SVG sparkline. The series is capped at
 * {@link MAX_HISTORY} points and is lost on remount.
 */
export const MetricsPanel = ({ initialShardKey }: MetricsPanelProps): ReactElement => {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    // The shard a successful one-shot last targeted. The live channel keys on
    // this committed value (not the live `shardKey` input) so editing the shard
    // box without refreshing doesn't resubscribe to a half-typed shard on every
    // keystroke — mirroring DataBrowser's `loaded.shard`.
    const [committedShard, setCommittedShard] = useState<null | string>(null);
    const [metrics, setMetrics] = useState<ShardMetrics | null>(null);
    const [error, setError] = useState<null | string>(null);
    const { live, liveError, setLiveError, toggle } = useLiveToggle();
    const [history, setHistory] = useState<ReadonlyArray<number>>([]);

    // Avoid setState after unmount and overlapping in-flight one-shot loads.
    const mountedRef = useRef(true);
    const inFlightRef = useRef(false);
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
            if (inFlightRef.current) {
                return;
            }

            inFlightRef.current = true;

            try {
                const next = (await client.query(GET_METRICS, {}, callOptions(shard))) as ShardMetrics;

                recordShard(shard);

                if (mountedRef.current) {
                    setCommittedShard(shard);
                    applySample(next);
                }
            } catch (error_) {
                if (mountedRef.current) {
                    setMetrics(null);
                    setError(errorMessage(error_));
                }
            } finally {
                inFlightRef.current = false;
            }
        },
        [client, applySample],
    );

    useEffect(() => {
        fireAndForget(refresh(initialShardKey ?? ""));
    }, [refresh, initialShardKey]);

    // Live channel: while toggled on, each server push folds in like a refresh.
    useLiveAdmin(
        ADMIN_FUNCTIONS.getMetrics,
        {},
        committedShard ?? "",
        (next) => {
            if (mountedRef.current) {
                applySample(next as ShardMetrics);
            }
        },
        live && committedShard !== null,
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

    const refreshCurrent = useCallback((): void => {
        fireAndForget(refresh(shardKey));
    }, [refresh, shardKey]);

    const runAggregate = useCallback((): void => {
        fireAndForget(aggregateAll());
    }, [aggregateAll]);

    const clearAggregate = useCallback((): void => {
        setShardResults(null);
    }, []);

    return (
        <div data-testid="cirrus-metrics">
            <div>
                <ShardInput onChange={setShardKey} testId="mt-shard-input" value={shardKey} />
                <button data-testid="mt-refresh" onClick={refreshCurrent} type="button">
                    Refresh
                </button>
                <LiveToggle live={live} liveError={liveError} onToggle={toggle} prefix="mt" />
                <button data-testid="mt-aggregate" disabled={aggregating} onClick={runAggregate} type="button">
                    {aggregating ? "Aggregating…" : "All shards"}
                </button>
                {shardResults !== null && (
                    <button data-testid="mt-aggregate-clear" onClick={clearAggregate} type="button">
                        Hide
                    </button>
                )}
            </div>

            <div data-testid="mt-trend">
                <span>Requests / interval</span>
                {history.length < 2 && <span data-testid="mt-sparkline-empty">collecting samples…</span>}
                {history.length >= 2 && (
                    <>
                        <svg
                            aria-label="Requests per interval over time"
                            data-testid="mt-sparkline"
                            height={SPARK_HEIGHT}
                            preserveAspectRatio="none"
                            role="img"
                            viewBox={`0 0 ${SPARK_WIDTH.toString()} ${SPARK_HEIGHT.toString()}`}
                            width={SPARK_WIDTH}
                        >
                            <polyline fill="none" points={sparkline} stroke="currentColor" strokeWidth={1} />
                        </svg>
                        <span data-testid="mt-sparkline-value">{currentDelta}</span>
                    </>
                )}
            </div>

            {error !== null && (
                <p data-testid="mt-error" role="alert">
                    {error}
                </p>
            )}

            {metrics !== null && (
                <dl data-testid="mt-stats">
                    <dt>Shard</dt>
                    <dd data-testid="mt-shard">{metrics.shard}</dd>

                    <dt>Requests</dt>
                    <dd data-testid="mt-requests">{metrics.requests}</dd>

                    <dt>Errors</dt>
                    <dd data-testid="mt-errors">
                        {metrics.errors} ({errorRate})
                    </dd>

                    <dt>Uptime</dt>
                    <dd data-testid="mt-uptime">{formatDuration(metrics.uptimeMs)}</dd>

                    <dt>Database size</dt>
                    <dd data-testid="mt-db-size">{formatBytes(metrics.databaseSize)}</dd>

                    <dt>Cache hit rate</dt>
                    <dd data-testid="mt-cache">
                        {metrics.cache === null
                            ? "no cache configured"
                            : `${hitRate(metrics.cache.hits, metrics.cache.misses)} (${metrics.cache.entries.toString()} entries)`}
                    </dd>
                </dl>
            )}

            {aggregate !== null && shardResults !== null && (
                <div data-testid="mt-aggregate-view">
                    <dl data-testid="mt-aggregate-stats">
                        <dt>Shards</dt>
                        <dd data-testid="mt-agg-shards">
                            {aggregate.reachable} reachable
                            {aggregate.failed > 0 ? `, ${aggregate.failed.toString()} unreachable` : ""}
                        </dd>

                        <dt>Total requests</dt>
                        <dd data-testid="mt-agg-requests">{aggregate.totalRequests}</dd>

                        <dt>Total errors</dt>
                        <dd data-testid="mt-agg-errors">{aggregate.totalErrors}</dd>

                        <dt>Total database size</dt>
                        <dd data-testid="mt-agg-db-size">{formatBytes(aggregate.totalDatabaseSize)}</dd>

                        <dt>Combined cache hit rate</dt>
                        <dd data-testid="mt-agg-cache">{aggregate.hitRate === null ? "no cache configured" : `${(aggregate.hitRate * 100).toFixed(1)}%`}</dd>
                    </dl>

                    <table data-testid="mt-agg-table">
                        <thead>
                            <tr>
                                <th>shard</th>
                                <th>requests</th>
                                <th>errors</th>
                                <th>db size</th>
                            </tr>
                        </thead>
                        <tbody>
                            {shardResults.map((result) => (
                                <tr data-testid={`mt-agg-row-${result.shard}`} key={result.shard}>
                                    <td>{result.shard}</td>
                                    {result.metrics === null ? (
                                        <td colSpan={3}>{result.error ?? "unreachable"}</td>
                                    ) : (
                                        <>
                                            <td>{result.metrics.requests}</td>
                                            <td>{result.metrics.errors}</td>
                                            <td>{formatBytes(result.metrics.databaseSize)}</td>
                                        </>
                                    )}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
};

export type { MetricsPanelProps };
