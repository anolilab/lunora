/**
 * Metric formatting shared by the metrics panel and its extracted surfaces.
 *
 * Its own module so the panel, the single-shard readout, and the cross-shard
 * rollup agree on how a duration and a hit rate read, instead of each carrying
 * a copy of the thresholds.
 */

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

/** A duration for display: `—` when there is none, microseconds under a millisecond. */
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

export { formatDuration, formatMs, hitRate };
