import type { QueryStatEntry, ShardMetrics } from "../../lib/admin";

/** One shard's metrics fetch outcome: the snapshot, or the error that shard returned. */
export interface ShardMetricsResult {
    error: null | string;
    metrics: null | ShardMetrics;
    shard: string;
}

/** Totals rolled up across every successfully-fetched shard. */
export interface AggregateMetrics {
    /** Shards that returned an error (couldn't be reached / unauthorized). */
    failed: number;
    /** Combined reactive-cache hit rate across shards with a cache, or `null` when none has one. */
    hitRate: null | number;
    /** Shards that returned a snapshot. */
    reachable: number;
    /** Sum of `databaseSize` across reachable shards (skips shards reporting `null`). */
    totalDatabaseSize: number;
    totalErrors: number;
    totalRequests: number;
}

/**
 * Roll up per-shard metrics into repo-wide totals. Errors-per-shard are kept as
 * `failed` (a shard that's down is data, not a hard failure), and counters are
 * summed only over reachable shards. The combined cache hit-rate weights by each
 * shard's hits+misses so a busy shard dominates a quiet one.
 */
export const aggregateMetrics = (results: ReadonlyArray<ShardMetricsResult>): AggregateMetrics => {
    let totalRequests = 0;
    let totalErrors = 0;
    let totalDatabaseSize = 0;
    let reachable = 0;
    let failed = 0;
    let cacheHits = 0;
    let cacheTotal = 0;

    for (const { metrics } of results) {
        if (metrics === null) {
            // A null snapshot is counted as failed regardless of whether an error
            // string came with it, so `reachable + failed === results.length`
            // always holds — a result that is neither reachable nor failed would
            // otherwise vanish from the totals.
            failed += 1;

            continue;
        }

        reachable += 1;
        totalRequests += metrics.requests;
        totalErrors += metrics.errors;
        totalDatabaseSize += metrics.databaseSize ?? 0;

        if (metrics.cache !== null) {
            cacheHits += metrics.cache.hits;
            cacheTotal += metrics.cache.hits + metrics.cache.misses;
        }
    }

    return {
        failed,
        // eslint-disable-next-line unicorn/no-null -- hitRate is part of the public AggregateMetrics type, which models "no cache" as null
        hitRate: cacheTotal === 0 ? null : cacheHits / cacheTotal,
        reachable,
        totalDatabaseSize,
        totalErrors,
        totalRequests,
    };
};

/**
 * The shard keys to aggregate over. Durable Objects aren't enumerable, so this
 * is the union of the root shard (`""`), an explicit current shard, and the
 * recently-visited shards — de-duplicated, order-stable (root first). It's a
 * best-effort "shards we know about", not every shard that exists.
 */
export const shardsToAggregate = (current: string, recents: ReadonlyArray<string>): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const shard of ["", current.trim(), ...recents]) {
        if (!seen.has(shard)) {
            seen.add(shard);
            out.push(shard);
        }
    }

    return out;
};

/* -------------------------------------------------------------------------- */
/* Percentile computation                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Compute the Pth percentile of `values` using the nearest-rank method.
 * `values` need not be sorted. Returns `0` for an empty array and the sole
 * element when `values.length === 1`.
 * @param values The sample population (mutated via in-place sort).
 * @param p Percentile in [0, 100] (e.g. `90` for P90).
 */
export const percentile = (values: number[], p: number): number => {
    if (values.length === 0) {
        return 0;
    }

    values.sort((a, b) => a - b);

    if (p <= 0) {
        return values[0] ?? 0;
    }

    if (p >= 100) {
        return values.at(-1) ?? 0;
    }

    // Nearest-rank: ceil(p/100 * n) — 1-based index.
    const index = Math.ceil((p / 100) * values.length) - 1;

    return values[index] ?? 0;
};

/**
 * Compute the P90 and P95 handler duration from the current per-function
 * stats in a snapshot. Returns `{ p90: 0, p95: 0 }` when no function data
 * is present (pre-feature worker or cold shard).
 *
 * Each function contributes its `totalDurationMs / calls` average as a
 * sample, weighted by call count so hot functions dominate the percentile.
 * This is an approximation — per-call duration histograms would be more
 * accurate but are not currently emitted by the DO.
 */
export const computeLatencyPercentiles = (snapshot: ShardMetrics): { p90: number; p95: number } => {
    const snap = snapshot as { functions?: { calls: number; totalDurationMs: number }[] };
    const functionList = snap.functions;

    if (!functionList || functionList.length === 0) {
        return { p90: 0, p95: 0 };
    }

    // Build a synthetic sample: one data point per call (avg duration repeated
    // `calls` times). This keeps the percentile weighted correctly for busy
    // functions.  We cap per-function repetitions at 1000 to avoid blowing the
    // array on high-traffic shards.
    const CAP = 1000;
    const samples: number[] = [];

    for (const functionStat of functionList) {
        if (functionStat.calls <= 0) {
            continue;
        }

        const avg = functionStat.totalDurationMs / functionStat.calls;
        const reps = Math.min(functionStat.calls, CAP);

        for (let index = 0; index < reps; index += 1) {
            samples.push(avg);
        }
    }

    if (samples.length === 0) {
        return { p90: 0, p95: 0 };
    }

    return {
        p90: percentile([...samples], 90),
        p95: percentile([...samples], 95),
    };
};

/* -------------------------------------------------------------------------- */
/* Trend deltas                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The change in a scalar metric relative to a baseline. `delta` is the
 * absolute difference (`current - baseline`); `pct` is the percentage change
 * (`delta / baseline * 100`), or `null` when baseline is zero (division by
 * zero). `direction` encodes whether this metric increasing is `"good"`,
 * `"bad"`, or `"neutral"` — used by the panel to pick badge colours.
 */
export interface MetricDelta {
    delta: number;
    direction: "bad" | "good" | "neutral";
    pct: null | number;
}

/**
 * Compute the delta of a scalar metric between a `baseline` and `current`
 * snapshot value.
 * @param baseline The earlier snapshot's value.
 * @param current The current snapshot's value.
 * @param direction Whether an increase is `"good"`, `"bad"`, or `"neutral"`.
 */
export const computeDelta = (baseline: number, current: number, direction: MetricDelta["direction"] = "neutral"): MetricDelta => {
    const delta = current - baseline;
    // eslint-disable-next-line unicorn/no-null -- pct is null when baseline is 0 (undefined percentage)
    const pct = baseline === 0 ? null : (delta / baseline) * 100;

    return { delta, direction, pct };
};

/**
 * Enrich {@link QueryStatEntry} rows with derived fields. Splits the entry
 * from the wire shape (which the DO emits) into a display-ready record that
 * adds `avgDurationMs` so the leaderboard doesn't recompute it per row.
 */
export interface EnrichedQueryStat extends QueryStatEntry {
    avgDurationMs: number;
}

/**
 * Compute `avgDurationMs = totalDurationMs / execCount` for each entry.
 * Entries with `execCount === 0` get `avgDurationMs = 0` (shouldn't occur
 * on valid wire data but guard defensively).
 */
export const enrichQueryStats = (entries: ReadonlyArray<QueryStatEntry>): EnrichedQueryStat[] =>
    entries.map((entry) => {
        return {
            ...entry,
            avgDurationMs: entry.execCount > 0 ? entry.totalDurationMs / entry.execCount : 0,
        };
    });
