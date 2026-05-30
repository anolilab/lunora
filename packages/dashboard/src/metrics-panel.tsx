import { useCirrus } from "@cirrus/react";
import { type ChangeEvent, type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { ADMIN_FUNCTIONS, type ShardMetrics } from "./admin.js";
import { adminRef, callOptions, errorMessage, formatBytes } from "./internal.js";

export interface MetricsPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);

/** Auto-refresh polling cadence, in milliseconds. */
const POLL_INTERVAL_MS = 2000;

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
const sparklinePoints = (series: readonly number[]): string => {
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
        return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
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
 * An opt-in auto-refresh toggle polls {@link GET_METRICS} every
 * {@link POLL_INTERVAL_MS} ms and accumulates a client-side, in-memory series of
 * requests-per-interval (the delta of `requests` between consecutive samples),
 * rendered as an inline-SVG sparkline. The series is capped at
 * {@link MAX_HISTORY} points and is lost on remount.
 */
export function MetricsPanel({ initialShardKey }: MetricsPanelProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [metrics, setMetrics] = useState<ShardMetrics | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
    const [history, setHistory] = useState<readonly number[]>([]);

    // Avoid setState after unmount and overlapping in-flight polls.
    const mountedRef = useRef(true);
    const inFlightRef = useRef(false);
    // Latest cumulative `requests` count, used to derive the per-interval delta.
    const lastRequestsRef = useRef<null | number>(null);

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            if (inFlightRef.current) {
                return;
            }

            inFlightRef.current = true;
            setError(null);

            try {
                const next = (await client.query(GET_METRICS, {}, callOptions(shard))) as ShardMetrics;

                if (!mountedRef.current) {
                    return;
                }

                setMetrics(next);

                const previous = lastRequestsRef.current;

                lastRequestsRef.current = next.requests;

                // Skip the first sample (no prior point to diff against) and any
                // counter reset (DO hibernation), which would yield a bogus delta.
                if (previous !== null && next.requests >= previous) {
                    setHistory((prior) => [...prior, next.requests - previous].slice(-MAX_HISTORY));
                }
            } catch (error_) {
                if (!mountedRef.current) {
                    return;
                }

                setMetrics(null);
                setError(errorMessage(error_));
            } finally {
                inFlightRef.current = false;
            }
        },
        [client],
    );

    useEffect(() => {
        void refresh(initialShardKey ?? "");
    }, [refresh, initialShardKey]);

    useEffect(() => {
        if (!autoRefresh) {
            return undefined;
        }

        const id = setInterval(() => {
            void refresh(shardKey);
        }, POLL_INTERVAL_MS);

        return () => {
            clearInterval(id);
        };
    }, [autoRefresh, refresh, shardKey]);

    const errorRate = metrics === null || metrics.requests === 0 ? "—" : `${((metrics.errors / metrics.requests) * 100).toFixed(1)}%`;
    const currentDelta = history.length > 0 ? (history.at(-1) as number) : 0;

    return (
        <div data-testid="cirrus-metrics">
            <div>
                <input
                    aria-label="Shard key"
                    data-testid="mt-shard-input"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setShardKey(event.target.value);
                    }}
                    placeholder="shard key (optional)"
                    value={shardKey}
                />
                <button
                    data-testid="mt-refresh"
                    onClick={() => {
                        void refresh(shardKey);
                    }}
                    type="button"
                >
                    Refresh
                </button>
                <button
                    aria-pressed={autoRefresh}
                    data-testid="mt-autorefresh"
                    onClick={() => {
                        setAutoRefresh((on) => !on);
                    }}
                    type="button"
                >
                    {autoRefresh ? "Auto-refresh: on" : "Auto-refresh: off"}
                </button>
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
                            viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
                            width={SPARK_WIDTH}
                        >
                            <polyline fill="none" points={sparklinePoints(history)} stroke="currentColor" strokeWidth={1} />
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
                            : `${hitRate(metrics.cache.hits, metrics.cache.misses)} (${metrics.cache.entries} entries)`}
                    </dd>
                </dl>
            )}
        </div>
    );
}
