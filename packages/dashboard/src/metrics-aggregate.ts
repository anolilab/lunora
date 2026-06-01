import type { ShardMetrics } from "./admin.js";

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
export const aggregateMetrics = (results: readonly ShardMetricsResult[]): AggregateMetrics => {
    let totalRequests = 0;
    let totalErrors = 0;
    let totalDatabaseSize = 0;
    let reachable = 0;
    let failed = 0;
    let cacheHits = 0;
    let cacheTotal = 0;

    for (const { error, metrics } of results) {
        if (metrics === null) {
            if (error !== null) {
                failed += 1;
            }

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
export const shardsToAggregate = (current: string, recents: readonly string[]): string[] => {
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
