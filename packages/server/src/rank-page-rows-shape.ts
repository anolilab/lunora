/**
 * Structural mirrors of `@lunora/shard-engine`'s rank-page-row shapes
 * (`RankPageRowKey` / `RankPageRow` / `ShardRankPageResult`) — the return type
 * of the writer's `rankPageRows` seam, the cross-shard companion to
 * `rankPage`.
 *
 * Shared by `../rls/middleware` and `../mask/middleware`: both wrap
 * `rankPageRows` structurally (no `@lunora/shard-engine` import, mirroring how
 * every other method on their `DatabaseWriterLike`/`MaskDatabase` projections
 * is hand-mirrored rather than imported) and both need the exact same result
 * shape to type their overrides. A single copy here means the two wrappers
 * can't drift out of lockstep with each other — see AGENTS.md's platform
 * parity note on `ShardSqlExec` and the canonical binding `*Like` projections
 * shipping wrong for exactly this reason (two hand-maintained mirrors of one
 * upstream type).
 */

/** Structural mirror of `@lunora/shard-engine`'s `RankPageRowKey`. */
interface RankPageRowKeyLike {
    partitionKey: string;
    rowId: string;
    sortValues: ReadonlyArray<unknown>;
}

/** Structural mirror of `@lunora/shard-engine`'s `RankPageRow`. */
interface RankPageRowLike {
    doc: Record<string, unknown>;
    key: RankPageRowKeyLike;
}

/** Structural mirror of `@lunora/shard-engine`'s `ShardRankPageResult` — the `rankPageRows` return shape. */
interface ShardRankPageResultLike {
    directions: ReadonlyArray<"asc" | "desc">;
    hasMore: boolean;
    rows: ReadonlyArray<RankPageRowLike>;
}

export type { RankPageRowKeyLike, RankPageRowLike, ShardRankPageResultLike };
