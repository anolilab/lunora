import { useCirrus } from "@cirrus/react";
import { type ChangeEvent, type ReactElement, useCallback, useEffect, useState } from "react";

import { ADMIN_FUNCTIONS, type ShardMetrics } from "./admin.js";
import { adminRef, callOptions, errorMessage } from "./internal.js";

export interface MetricsPanelProps {
    /** Shard key the panel reports on. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const GET_METRICS = adminRef(ADMIN_FUNCTIONS.getMetrics);

/** Render a byte count compactly (e.g. `1.4 MB`). */
const formatBytes = (bytes: null | number): string => {
    if (bytes === null) {
        return "—";
    }

    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit]}`;
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
 */
export function MetricsPanel({ initialShardKey }: MetricsPanelProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [metrics, setMetrics] = useState<ShardMetrics | null>(null);
    const [error, setError] = useState<null | string>(null);

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setError(null);

            try {
                setMetrics((await client.query(GET_METRICS, {}, callOptions(shard))) as ShardMetrics);
            } catch (error_) {
                setMetrics(null);
                setError(errorMessage(error_));
            }
        },
        [client],
    );

    useEffect(() => {
        void refresh(initialShardKey ?? "");
    }, [refresh, initialShardKey]);

    const errorRate = metrics === null || metrics.requests === 0 ? "—" : `${((metrics.errors / metrics.requests) * 100).toFixed(1)}%`;

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
