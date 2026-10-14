/**
 * How the metrics surfaces render a duration, a hit rate, a USD amount and a token count.
 *
 * Its own module so the formatting is testable without a render — these are pure
 * branch tables, and asserting `999μs` vs `1.0ms` through a component was the
 * reason those boundaries went unchecked. Only the single-shard readout imports it
 * today; the rollup's hit rate arrives already reduced to a fraction, so it does
 * not share `hitRate`'s hits/misses inputs.
 */

/** A span of wall-clock time (uptime, age) as `1h 2m`, `3m 4s`, or `5s`. */
const formatElapsed = (ms: number): string => {
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

/** A per-operation latency: `—` when there is none, microseconds under a millisecond. */
const formatLatency = (ms: number): string => {
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

/**
 * USD for display, in `locale` (default: the renderer's, like the rest of
 * Studio's `toLocaleString()` formatting). Per-call LLM spend is routinely a
 * fraction of a cent, so values under a dollar keep three significant digits
 * (`$0.00042`) instead of rounding to a misleading `$0.00`.
 */
const formatUsd = (value: number, locale?: string): string =>
    new Intl.NumberFormat(
        locale,
        value === 0 || Math.abs(value) >= 1
            ? { currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2, style: "currency" }
            : { currency: "USD", maximumSignificantDigits: 3, style: "currency" },
    ).format(value);

/** Token counts with thousands separators, in `locale` (default: the renderer's). */
const formatTokens = (value: number, locale?: string): string => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);

export { formatElapsed, formatLatency, formatTokens, formatUsd, hitRate };
