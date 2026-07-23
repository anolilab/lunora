/**
 * Rank-index runtime — schema-level decls (`rankIndex`) plus `rank(row)` and
 * `rankPage()` reads over a sorted companion (btree-backed via SQLite's row
 * index) maintained by the trigger seam.
 *
 * Coupling seam (mirrors aggregates.ts §3.1):
 *
 * - Reader paths accept a restrictable query option set; `baseWhere` is
 * AND-merged into the `where` argument before partition resolution so an
 * RLS-aware ctx's policy participates in `rank()` exactly like it does in
 * `count()` (a policy-restricted reader sees the policy-filtered rank,
 * not the global one).
 * - `restrictsCounts: true` makes `rank()` throw the same
 * `CountRlsUnsupportedError` aggregates throws — the position is a
 * `count(rows-strictly-before) + 1`, so the count constraint applies
 * identically.
 *
 * Storage layout (per declared rankIndex):
 *
 * T__rank_&lt;name> (
 * __id__         TEXT PRIMARY KEY,
 * __partition__  TEXT NOT NULL,   -- canonical-JSON tuple of partitionBy keys (or "")
 * __sort_k0__    BLOB,            -- one column per sortBy key (typeless)
 * __sort_k1__    BLOB,
 * ...
 * );
 *
 * CREATE INDEX T__rank_&lt;name>__btree
 * ON T__rank_&lt;name> (__partition__, __sort_k0__ &lt;dir0>, ..., __id__ ASC);
 *
 * Auto-backfill: a rank companion is **lazily** populated on the first read
 * or write that targets an empty companion, by scanning the source table
 * once (`ensureRankBackfilled`). Same pattern as aggregates; cheap and
 * correct for dev, and production hosts can pre-populate via
 * `backfillRankIndexes`.
 */

import { serializeSqlValue } from "@lunora/shard-engine";

import type { RestrictableQueryOptions } from "./aggregates";

/** Code-point-stable string comparator (no locale dependence) for canonical key ordering. */
const compareStrings = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

/** Sentinel returned by {@link resolvePartitionValue} when a field can't pin a single partition. */
const NOT_RESOLVABLE = Symbol("not-resolvable");

/**
 * Resolve a single partition field from the requested `where` value. Returns
 * the literal partition value, or the `NOT_RESOLVABLE` sentinel when a
 * non-equality operator means the index can't isolate one partition (caller
 * falls back to scanning).
 */
const resolvePartitionValue = (value: unknown): unknown => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const operatorKeys = Object.keys(value);

        if (operatorKeys.length === 1 && operatorKeys[0] === "eq") {
            return (value as { eq: unknown }).eq;
        }

        // Non-equality operators on a partition key — the index can't
        // resolve a single partition; fall back to scan.
        return NOT_RESOLVABLE;
    }

    return value;
};

type RankDirection = "asc" | "desc";

interface RankSortKeyLike {
    readonly direction: RankDirection;
    readonly field: string;
}

/**
 * Structural mirror of `@lunora/server`'s `RankIndexDefinition` — kept local
 * so this package doesn't take a hard dep on `@lunora/server` (same reasoning
 * as `AggregateIndexDefinitionLike` in aggregates.ts).
 */
interface RankIndexDefinitionLike {
    readonly name: string;
    readonly on: string;
    readonly partitionBy?: ReadonlyArray<string>;
    readonly sortBy: ReadonlyArray<RankSortKeyLike>;
    readonly where?: Record<string, unknown>;
}

/** 1-based position within a partition under the declared sort, plus the partition's row total. */
interface RankResult {
    position: number;
    total: number;
}

/**
 * Args for `rank()`. `row` is either the row id (`string`) or a full row
 * doc (we read its `_id` to look up the companion entry). The restrictable
 * half (`where`/`baseWhere`/`restrictsCounts`) scopes the rank — useful
 * when an RLS policy or the caller's `where` should narrow the partition
 * (e.g. only ranking non-archived rows).
 */
interface RankOptions extends RestrictableQueryOptions {
    row: Record<string, unknown> | string;
}

/**
 * Args for the cross-shard `rankBefore()` primitive. Unlike `rank()`, the key
 * is supplied explicitly (built off the row doc via `rankKeyFromDocument`) so
 * a PEER shard — one that doesn't store the row being ranked — can still count
 * its local rows strictly-before that key. Scope is fixed by the explicit
 * `partitionKey`; unlike `rank()` there is no `where`/`baseWhere` (the caller
 * pins the partition up front), only the `restrictsCounts` RLS seam.
 */
interface RankBeforeOptions {
    /** Canonical-JSON partition tuple — `encodePartitionKey(index.partitionBy, doc)`. */
    partitionKey: string;
    /** Mirrors `rank()`/`count()`: a restricted ctx can't be trusted for a strict-before count. */
    restrictsCounts?: boolean;
    /** The `__id__` tiebreak value — `doc._id`. */
    rowId: string;
    /** Sort-key values in `index.sortBy` order. `rankKeyFromDocument` serializes them to the stored `__sort_k&lt;i>__` form; `rankBefore` re-applies `serializeSqlValue` idempotently, so raw values from a direct caller work too. */
    sortValues: ReadonlyArray<unknown>;
}

/** Per-shard `rankBefore()` payload: rows strictly-before the key locally, plus the local partition total. */
interface RankBeforeResult {
    before: number;
    total: number;
}

/** Args for `rankPage()` — sorted pagination over the index's companion table. */
interface RankPageOptions extends RestrictableQueryOptions {
    /**
     * Cross-shard resume key from the prior page (`{ partitionKey, sortValues,
     * rowId }`). The cross-shard coordinator forwards each shard's per-shard
     * resume key here so the shard pages strictly-after that row under the same
     * `(__partition__, __sort_k&lt;i>__, __id__)` order. Equivalent to `cursor` but
     * structured (so the coordinator never re-encodes an opaque string); when
     * both are set, `after` wins. Shard-local callers use `cursor`.
     */
    after?: RankPageRowKey;
    /** Opaque cursor from the prior page's `continueCursor`; `null`/omitted starts at the first page. */
    cursor?: null | string;

    /**
     * Pre-encoded partition tuple (`encodePartitionKey(index.partitionBy, where)`)
     * that pins the page to one partition without re-deriving it from `where`.
     * The cross-shard coordinator forwards this so each shard scopes its local
     * slice to the same partition; when set it takes precedence over any
     * partition resolved from `where`. Shard-local callers leave it unset and
     * let the partition resolve from `where`.
     */
    partitionKey?: string;
    /** Page size; defaults to 100. Capped at 1000 to keep a single fan-out manageable. */
    take?: number;
}

/** One page returned by `rankPage()`. */
interface RankPage {
    continueCursor: null | string;
    isDone: boolean;
    page: Record<string, unknown>[];
}

/**
 * Per-row rank key emitted by the cross-shard `rankPageRows()`. Byte-identical
 * to what the rank companion's `ORDER BY __partition__, __sort_k&lt;i>__, __id__`
 * compares on, so the query coordinator's k-way merge orders rows across shards
 * the same way each shard pages them locally:
 *
 * - `partitionKey` is the companion's `__partition__` column — `encodePartitionKey(index.partitionBy, doc)`.
 * - `sortValues[i]` is the companion's `__sort_k&lt;i>__` column — `serializeSqlValue(doc[index.sortBy[i].field])` (always `null | number | string`, JSON-safe over the wire).
 * - `rowId` is the `__id__` tiebreak (`doc._id`).
 */
interface RankPageRowKey {
    /** Canonical-JSON partition tuple — the companion's `__partition__`. */
    partitionKey: string;
    /** The `__id__` tiebreak (`doc._id`). */
    rowId: string;
    /** Serialized sort-key values in `index.sortBy` order (`null | number | string`). */
    sortValues: ReadonlyArray<unknown>;
}

/** One row of a shard-local `rankPageRows()` slice: the hydrated doc plus its rank key. */
interface RankPageRow {
    doc: Record<string, unknown>;
    key: RankPageRowKey;
}

/**
 * A single shard's `rankPageRows()` payload — the structural contract the query
 * coordinator's `orchestrateRankPage` consumes (mirrored as `ShardRankPageResult`
 * in `@lunora/runtime`). `rows` is the shard's local ranked slice (already in
 * `(__partition__, sortcols, __id__)` order); `hasMore` says whether the shard
 * had rows beyond the slice it returned.
 */
interface ShardRankPageResult {
    /**
     * Per-sort-key directions (`index.sortBy[i].direction`) the shard actually
     * ordered its slice by — the authoritative sort order. The coordinator's
     * k-way merge uses these (not the caller-supplied request `directions`) so
     * the cross-shard merge order is guaranteed to match each shard's local
     * `ORDER BY`, even if a caller passed `directions` that disagree with the
     * named index.
     */
    directions: ReadonlyArray<RankDirection>;
    hasMore: boolean;
    rows: ReadonlyArray<RankPageRow>;
}

/**
 * Canonical-JSON encoding of the partition tuple, matching the aggregate
 * encoding's stability so the same row is filed under the same partition key
 * across runs. Empty `partitionBy` keys on `""` (single global partition).
 */
const encodePartitionKey = (partitionBy: ReadonlyArray<string>, source: Record<string, unknown>): string => {
    if (partitionBy.length === 0) {
        return "";
    }

    const ordered: Record<string, unknown> = {};

    for (const field of [...partitionBy].toSorted(compareStrings)) {
        // eslint-disable-next-line unicorn/no-null -- canonical JSON partition key: a missing field must serialize as null (stable across runs), not be dropped by JSON.stringify
        ordered[field] = source[field] ?? null;
    }

    return JSON.stringify(ordered);
};

/**
 * The implicit final tiebreak appended to every rank sort so the order is
 * total and `rank()` returns a deterministic position — same role the `_id`
 * tiebreak plays in `compileOrderBySql`/`buildSeekWhere`.
 */
const RANK_TIEBREAK = "__id__";

/**
 * Sort-key column name in the companion table. We use positional names so the
 * companion stays stable when an `INDEX` is rebuilt: a future rename of the
 * source field doesn't require ALTERing the rank table.
 */
const sortColumnName = (i: number): string => `__sort_k${String(i)}__`;

/** Cheap predicate test against the index's static `where` (literal equality / `{ eq }` only). */
const matchesRankStaticWhere = (document: Record<string, unknown>, predicate: Record<string, unknown>): boolean => {
    for (const [field, expected] of Object.entries(predicate)) {
        const actual = document[field];

        if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
            const operatorKeys = Object.keys(expected);

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
 * @returns the resolved partition key map, or `undefined` when the request doesn't fully cover the partition tuple
 */
const resolveRankPartition = (index: RankIndexDefinitionLike, where: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
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
            const value = resolvePartitionValue(requested[field]);

            if (value === NOT_RESOLVABLE) {
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
const rankTableName = (table: string, indexName: string): string => `${table}__rank_${indexName}`;

/**
 * The fan-out key tuple for a single doc under a rankIndex, derived purely from
 * the doc (no companion lookup). A caller holding the full row builds this to
 * ask peer shards "count your local rows strictly before this one" via
 * `rankBefore` — the cross-shard `rank()` path for a partition that spans
 * multiple shards (e.g. a global leaderboard sharded by user).
 *
 * The values mirror what the trigger seam (`syncRankIndexEntry`) stores:
 *
 * - `partitionKey` === `encodePartitionKey(index.partitionBy ?? [], doc)`, the same canonical-JSON tuple filed in `__partition__`.
 * - `sortValues[i]` === `serializeSqlValue(doc[index.sortBy[i].field])` — the same transform `syncRankIndexEntry` applies to the stored `__sort_k&lt;i>__` column, so the comparison is byte-for-byte (and JSON-safe for the cross-shard wire) regardless of which shard owns the row. `rankBefore` re-applies it idempotently, so a direct caller passing raw values still works.
 * - `rowId` === `doc._id`, the `__id__` tiebreak.
 */
const rankKeyFromDocument = (
    index: RankIndexDefinitionLike,
    document_: Record<string, unknown>,
): { partitionKey: string; rowId: string; sortValues: unknown[] } => {
    return {
        partitionKey: encodePartitionKey(index.partitionBy ?? [], document_),
        rowId: document_["_id"] as string,
        // Serialize each sort value the same way `syncRankIndexEntry` writes the
        // stored `__sort_k<i>__` column, so a peer shard's comparison matches
        // byte-for-byte. This also makes the values JSON-safe for the
        // cross-shard RPC wire — `serializeSqlValue` turns bigint/Date/object
        // into a string|number|null, where raw bigint would crash JSON.stringify
        // and a raw Date would serialize to a different shape than the store.
        // eslint-disable-next-line unicorn/no-null -- mirrors syncRankIndexEntry: a missing field serializes via `?? null` so the stored and wire bytes agree
        sortValues: index.sortBy.map((key) => serializeSqlValue(document_[key.field] ?? null)),
    };
};

export {
    encodePartitionKey,
    matchesRankStaticWhere,
    RANK_TIEBREAK,
    rankKeyFromDocument as rankKeyFromDoc,
    rankTableName,
    resolveRankPartition,
    sortColumnName,
};
export type {
    RankBeforeOptions,
    RankBeforeResult,
    RankDirection,
    RankIndexDefinitionLike,
    RankOptions,
    RankPage,
    RankPageOptions,
    RankPageRow,
    RankPageRowKey,
    RankResult,
    RankSortKeyLike,
    ShardRankPageResult,
};
