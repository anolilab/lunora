import type { FunctionCallStat, MetricsHistoryBucket, MetricsSnapshot, MigrationStatus, MigrationStatusRow } from "../../lib/admin";

/** Severity order so a dedupe across shards surfaces the worst state of a shared migration id. */
const STATUS_RANK: Record<MigrationStatus, number> = { completed: 0, failed: 2, in_progress: 1 };

/**
 * One shard's SLO fetch outcome. A `null` metrics snapshot means that shard
 * couldn't be reached (down / unauthorized); `functions` and `migrations`
 * default to empty so a partial shard never poisons the rollup.
 */
interface ShardSloResult {
    functions: FunctionCallStat[];
    metrics: MetricsSnapshot | null;
    migrations: MigrationStatusRow[];
}

/** App-wide request / error totals + concatenated history, rolled up across reachable shards. */
interface SloTotals {
    errors: number;
    /** Shards that returned no snapshot (down / unauthorized). */
    failed: number;
    /** Every shard's per-function buckets, concatenated; collapse on `bucketMs` for the trend sparkline. */
    history: MetricsHistoryBucket[];

    /**
     * True when ANY reachable shard's `history` was cut by its read limit — one
     * truncated shard is enough to make the app-wide trend a partial window, so
     * this is an OR across shards, not a per-shard flag the caller re-derives.
     */
    historyTruncated: boolean;
    /** Shards that returned a snapshot. */
    reachable: number;
    requests: number;
}

/**
 * Sum request / error counters across every reachable shard and concatenate
 * their per-function history buckets. Durable Objects aren't enumerable, so the
 * caller passes the best-effort "shards we know about" set; an unreachable shard
 * is counted as `failed`, not a hard error.
 */
const sumShardMetrics = (results: ReadonlyArray<ShardSloResult>): SloTotals => {
    let requests = 0;
    let errors = 0;
    let reachable = 0;
    let failed = 0;
    let historyTruncated = false;
    const history: MetricsHistoryBucket[] = [];

    for (const { metrics } of results) {
        if (metrics === null) {
            failed += 1;

            continue;
        }

        reachable += 1;
        requests += metrics.requests;
        errors += metrics.errors;
        history.push(...(metrics.history ?? []));
        historyTruncated ||= metrics.historyTruncated === true;
    }

    return { errors, failed, history, historyTruncated, reachable, requests };
};

/**
 * Merge per-shard {@link FunctionCallStat}s by `path` so a function sharded
 * across many DOs reports one app-wide row: call/error/duration counters sum,
 * `maxDurationMs` / `lastCalledAt` take the max, and the most recent shard's
 * error message wins. `scannedTables` keeps the first shard's attribution (the
 * SLO view reads only the error rate, so a precise per-table merge isn't worth
 * the cost). Returns an unsorted list — the caller orders it.
 */
const mergeFunctionStats = (perShard: ReadonlyArray<ReadonlyArray<FunctionCallStat>>): FunctionCallStat[] => {
    const byPath = new Map<string, FunctionCallStat>();

    for (const shard of perShard) {
        for (const stat of shard) {
            const existing = byPath.get(stat.path);

            if (existing === undefined) {
                byPath.set(stat.path, { ...stat });

                continue;
            }

            existing.calls += stat.calls;
            existing.errors += stat.errors;
            existing.totalDurationMs += stat.totalDurationMs;
            existing.scans = (existing.scans ?? 0) + (stat.scans ?? 0);
            existing.maxDurationMs = Math.max(existing.maxDurationMs, stat.maxDurationMs);
            existing.lastCalledAt = Math.max(existing.lastCalledAt, stat.lastCalledAt);

            if ((stat.lastErrorAt ?? 0) > (existing.lastErrorAt ?? 0)) {
                existing.lastErrorAt = stat.lastErrorAt;
                existing.lastErrorMessage = stat.lastErrorMessage;
            }
        }
    }

    return [...byPath.values()];
};

/**
 * Dedupe migration rows by `id` across shards, keeping the WORST status (a single
 * shard mid-migration or failed should dominate the app-level tile) and, on a
 * tie, the most recently updated row.
 */
const dedupeMigrations = (perShard: ReadonlyArray<ReadonlyArray<MigrationStatusRow>>): MigrationStatusRow[] => {
    const byId = new Map<string, MigrationStatusRow>();

    for (const shard of perShard) {
        for (const row of shard) {
            const existing = byId.get(row.id);

            if (existing === undefined) {
                byId.set(row.id, row);

                continue;
            }

            const rankDelta = STATUS_RANK[row.status] - STATUS_RANK[existing.status];

            if (rankDelta > 0 || (rankDelta === 0 && (row.updatedAt ?? 0) > (existing.updatedAt ?? 0))) {
                byId.set(row.id, row);
            }
        }
    }

    return [...byId.values()];
};

export { dedupeMigrations, mergeFunctionStats, sumShardMetrics };
export type { ShardSloResult, SloTotals };
