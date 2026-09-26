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

        // Truthy, not `!== null`: a shard that sends no `cache` key at all reads
        // as `undefined`, and `undefined !== null` took the present branch and
        // threw — killing the whole rollup over one bad shard, mid-render.
        if (metrics.cache) {
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

/**
 * Compute the P90 and P95 handler duration from the current per-function
 * stats in a snapshot. Returns `{ p90: 0, p95: 0 }` when no function data
 * is present (pre-feature worker or cold shard).
 *
 * Each function contributes its `totalDurationMs / calls` average as a
 * sample, weighted by its full call count so hot functions dominate the
 * percentile. This is an approximation — per-call duration histograms would be
 * more accurate but are not currently emitted by the DO.
 */
export const computeLatencyPercentiles = (snapshot: ShardMetrics): { p90: number; p95: number } => {
    const snap = snapshot as { functions?: { calls: number; totalDurationMs: number }[] };
    const samples: { avg: number; calls: number }[] = [];
    let totalCalls = 0;

    for (const functionStat of snap.functions ?? []) {
        if (functionStat.calls > 0) {
            samples.push({ avg: functionStat.totalDurationMs / functionStat.calls, calls: functionStat.calls });
            totalCalls += functionStat.calls;
        }
    }

    samples.sort((a, b) => a.avg - b.avg);

    // Weighted nearest-rank: the smallest average whose cumulative call count
    // reaches p% of all calls. Weighting by the real count (not a capped
    // repetition) is what keeps a million 1ms calls from being outvoted by a
    // thousand 900ms ones.
    const weightedPercentile = (p: number): number => {
        const rank = Math.ceil((p / 100) * totalCalls);
        let cumulative = 0;

        for (const sample of samples) {
            cumulative += sample.calls;

            if (cumulative >= rank) {
                return sample.avg;
            }
        }

        return samples.at(-1)?.avg ?? 0;
    };

    return { p90: weightedPercentile(90), p95: weightedPercentile(95) };
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
