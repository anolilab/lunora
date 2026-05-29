/**
 * Rank-index runtime — schema-level decls (`rankIndex`) plus `rank(row)` and
 * `rankPage()` reads over a sorted companion (btree-backed via SQLite's row
 * index) maintained by the trigger seam.
 *
 * Coupling seam (mirrors aggregates.ts §3.1):
 *
 *   - Reader paths accept a {@link RestrictableQueryOptions}; `baseWhere` is
 *     AND-merged into the `where` argument before partition resolution so an
 *     RLS-aware ctx's policy participates in `rank()` exactly like it does in
 *     `count()` (a policy-restricted reader sees the policy-filtered rank,
 *     not the global one).
 *   - `restrictsCounts: true` makes `rank()` throw the same
 *     `CountRlsUnsupportedError` aggregates throws — the position is a
 *     `count(rows-strictly-before) + 1`, so the count constraint applies
 *     identically.
 *
 * Storage layout (per declared rankIndex):
 *
 *   T__rank_<name> (
 *     __id__         TEXT PRIMARY KEY,
 *     __partition__  TEXT NOT NULL,   -- canonical-JSON tuple of partitionBy keys (or "")
 *     __sort_k0__    BLOB,            -- one column per sortBy key (typeless)
 *     __sort_k1__    BLOB,
 *     ...
 *   );
 *
 *   CREATE INDEX T__rank_<name>__btree
 *       ON T__rank_<name> (__partition__, __sort_k0__ <dir0>, ..., __id__ ASC);
 *
 * Auto-backfill: a rank companion is **lazily** populated on the first read
 * or write that targets an empty companion, by scanning the source table
 * once (`ensureRankBackfilled`). Same pattern as aggregates; cheap and
 * correct for dev, and production hosts can pre-populate via
 * {@link backfillRankIndexes}.
 */

import type { RestrictableQueryOptions } from "./aggregates.js";

export type RankDirection = "asc" | "desc";

export interface RankSortKeyLike {
    readonly direction: RankDirection;
    readonly field: string;
}

/**
 * Structural mirror of `@cirrus/server`'s `RankIndexDefinition` — kept local
 * so this package doesn't take a hard dep on `@cirrus/server` (same reasoning
 * as `AggregateIndexDefinitionLike` in aggregates.ts).
 */
export interface RankIndexDefinitionLike {
    readonly name: string;
    readonly on: string;
    readonly partitionBy?: ReadonlyArray<string>;
    readonly sortBy: ReadonlyArray<RankSortKeyLike>;
    readonly where?: Record<string, unknown>;
}

/** 1-based position within a partition under the declared sort, plus the partition's row total. */
export interface RankResult {
    position: number;
    total: number;
}

/**
 * Args for `rank()`. `row` is either the row id (`string`) or a full row
 * doc (we read its `_id` to look up the companion entry). The
 * `RestrictableQueryOptions` half (`where`/`baseWhere`/`restrictsCounts`)
 * scopes the rank — useful when an RLS policy or the caller's `where` should
 * narrow the partition (e.g. only ranking non-archived rows).
 */
export interface RankOptions extends RestrictableQueryOptions {
    row: Record<string, unknown> | string;
}

/** Args for `rankPage()` — sorted pagination over the index's companion table. */
export interface RankPageOptions extends RestrictableQueryOptions {
    /** Opaque cursor from the prior page's `continueCursor`; `null`/omitted starts at the first page. */
    cursor?: null | string;
    /** Page size; defaults to 100. Capped at 1000 to keep a single fan-out manageable. */
    take?: number;
}

/** One page returned by `rankPage()`. */
export interface RankPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Array<Record<string, unknown>>;
}

/**
 * Canonical-JSON encoding of the partition tuple, matching the aggregate
 * encoding's stability so the same row is filed under the same partition key
 * across runs. Empty `partitionBy` keys on `""` (single global partition).
 */
export const encodePartitionKey = (partitionBy: ReadonlyArray<string>, source: Record<string, unknown>): string => {
    if (partitionBy.length === 0) {
        return "";
    }

    const ordered: Record<string, unknown> = {};

    for (const field of [...partitionBy].sort()) {
        ordered[field] = source[field] ?? null;
    }

    return JSON.stringify(ordered);
};

/**
 * The implicit final tiebreak appended to every rank sort so the order is
 * total and `rank()` returns a deterministic position — same role the `_id`
 * tiebreak plays in `compileOrderBy`/`buildSeekWhere`.
 */
export const RANK_TIEBREAK = "__id__";

/**
 * Sort-key column name in the companion table. We use positional names so the
 * companion stays stable when an `INDEX` is rebuilt: a future rename of the
 * source field doesn't require ALTERing the rank table.
 */
export const sortColumnName = (i: number): string => `__sort_k${i}__`;

/** Cheap predicate test against the index's static `where` (literal equality / `{ eq }` only). */
export const matchesRankStaticWhere = (document: Record<string, unknown>, predicate: Record<string, unknown>): boolean => {
    for (const [field, expected] of Object.entries(predicate)) {
        const actual = document[field];

        if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
            const operatorKeys = Object.keys(expected as Record<string, unknown>);

            if (operatorKeys.length === 1 && operatorKeys[0] === "eq") {
                if (actual !== (expected as { eq: unknown }).eq) {
                    return false;
                }

                continue;
            }

            return false;
        }

        if (actual !== expected) {
            return false;
        }
    }

    return true;
};

/**
 * Resolve a `where`-style partition selector — the user supplies the partition
 * keys via the same flat object DSL aggregates use (`{ projectId: "p1" }` or
 * `{ projectId: { eq: "p1" } }`). Returns `undefined` if the request doesn't
 * fully cover the partition tuple (the reader will fall back to scanning).
 *
 * `index.where` participates: any key the index bakes in is folded into the
 * partition tuple if the request doesn't override it.
 */
export const resolveRankPartition = (index: RankIndexDefinitionLike, where: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    const partitionBy = index.partitionBy ?? [];
    const requested = where ?? {};

    // Boolean combinators belong to the scan path, not partition lookup.
    for (const key of Object.keys(requested)) {
        if (key === "AND" || key === "OR" || key === "NOT") {
            return undefined;
        }
    }

    const resolved: Record<string, unknown> = {};

    for (const field of partitionBy) {
        if (field in requested) {
            const value = (requested as Record<string, unknown>)[field];

            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                const operatorKeys = Object.keys(value as Record<string, unknown>);

                if (operatorKeys.length === 1 && operatorKeys[0] === "eq") {
                    resolved[field] = (value as { eq: unknown }).eq;

                    continue;
                }

                // Non-equality operators on a partition key — the index can't
                // resolve a single partition; fall back to scan.
                return undefined;
            }

            resolved[field] = value;
        } else if (index.where && field in index.where) {
            // The request didn't name this partition key but the index's
            // static `where` does — fold the static value in.
            resolved[field] = index.where[field];
        } else {
            // Missing a partition key — without it we can't isolate one
            // partition.
            return undefined;
        }
    }

    return resolved;
};

/**
 * Companion-table name for a rankIndex. The `__rank_` infix is reserved so
 * `runShardMigrations` can create it next to user tables without collision.
 */
export const rankTableName = (table: string, indexName: string): string => `${table}__rank_${indexName}`;
