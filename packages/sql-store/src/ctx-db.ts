/**
 * D1 column-dialect twin of the DO `createShardCtxDb` (`@lunora/do`).
 *
 * Global (`.global()`) tables live in D1 with a real column-per-field physical
 * schema — not the DO's JSON blob — so `where`/`orderBy`/keyset-cursor refer to
 * actual columns (`"field"`) rather than `json_extract(...)`. The query and
 * cursor logic is identical to the DO path: it reuses the shared keyset/order
 * helpers from `@lunora/do`, but compiles `WHERE` through the drizzle-emitting
 * `compileWhereSql` with a `WhereSqlStrategy` (column refs + value
 * serialization) so the generated `ctx.db.<table>` facade (1.2.7) is
 * backend-agnostic.
 */
/* eslint-disable unicorn/prevent-abbreviations -- "d1-ctx-db" is the established public module name: src/index.ts and every test import it as "./d1-ctx-db.js", and it deliberately mirrors @lunora/do's "ctx-db.ts" twin. Renaming would break those importers. */

/* eslint-disable no-restricted-syntax -- `sql\`…\`` here is the drizzle tagged-template SQL builder, not a string conversion; the rule misfires on the inner TemplateLiteral. */
import { LunoraError } from "@lunora/errors";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/search-core is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import {
    assertSearchWithinCap,
    createSearchAnalyzer,
    createSearchBuilder,
    finishSearchPage,
    planSearchPage,
    resolveSearchScan,
    searchPageScan,
} from "@lunora/search-core";
import type {
    AggregateIndexDefinitionLike,
    AggregateOptions,
    AggregateResult,
    AggregateTally,
    CdcChange,
    CrossShardReadArgs,
    DatabaseWriterLike,
    GroupByEntry,
    GroupByOptions,
    QueryPage,
    RankIndexDefinitionLike,
    RankPage,
    RankResult,
    SchedulerLike,
    SchemaLike,
    ServerDefaultContextLike,
    TableDefinitionLike,
    TableReaderLike,
    TriggerContextLike,
    TriggerEventLike,
    TriggerOpLike,
    TriggerTimingLike,
    WhereInput,
    WhereSqlStrategy,
} from "@lunora/shard-engine";
import {
    aggregateSqlFunction,
    aggregateTableName,
    applyOnDelete,
    applySelect,
    assertFlatPredicate,
    assertNoExplicitUndefined,
    assertValidClientId,
    buildSeekWhere,
    CDC_LOG_TABLE,
    CDC_LOG_TABLE_SEQ_INDEX,
    cdcTrimmedError,
    coerceAggregateNumber,
    compileWhereSql,
    ConflictError,
    CountRlsUnsupportedError,
    CURSOR_PREFIX,
    cursorBelowRetainedFloor,
    decodeCursor,
    encodeAggregateKey,
    encodeCursor,
    encodePartitionKey,
    fanOutScalarCounts,
    foldAggregateTally,
    hasTrigger,
    literalInList,
    matchesRankStaticWhere,
    matchesStaticWhere,
    mergeWhere,
    normalizeCountArgument,
    normalizeIdStructurally,
    normalizeOrderKeys,
    NotFoundError,
    NotUniqueError,
    RANK_TIEBREAK,
    rankTableName,
    readAggregateValue,
    relationHooks,
    resolveRankPartition,
    resolveRankSeekTuple,
    resolveRelationPredicates,
    resolveWith,
    runRowValidators,
    runTriggers,
    selectIndexForAggregate,
    selectIndexForCount,
    selectIndexForGroupBy,
    softDeleteScope,
    sortColumnName,
    throwingScheduler,
    tiebreakDirectionFor,
} from "@lunora/shard-engine";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { evictOldestEntry } from "../../../shared/evict-oldest";
import { decodeWire, encodeWire, needsWireEncoding } from "../../../shared/wire-codec";
import { runSqlAggregateMigrations, runSqlGlobalTableMigrations, runSqlRankMigrations } from "./ctx-db-migrations";
import type { SearchStage } from "./ctx-db-search";
import { createSearchSync, runSqlSearch, runSqlSearchMigrations } from "./ctx-db-search";
import { migrateSearchState } from "./ctx-db-search-state";
import type { SqlDialect } from "./dialect";
import { createPointReadBatcher } from "./point-read-batcher";
import type { SqlCtxExec } from "./sql-exec";
import {
    BACKFILL_BATCH_SIZE,
    columnRefSql,
    createIndexIfNotExists,
    decodeRow,
    decodeRows,
    forEachRowPaged,
    OCC_VERSION_COLUMN,
    queryAll,
    queryBatch,
    queryRun,
    serializeColumnValue,
    tableColumns,
} from "./sql-exec";
import { bigintSqlKey, effectiveColumnKind } from "./value-codec";

/** Order fields that already provide a stable tiebreak (no extra `id` term needed). */
const ID_ORDER_FIELDS = new Set(["_id", "id"]);

/**
 * NULL-safe equality for a bound value, rendered per engine: SQLite `IS`,
 * Postgres `IS NOT DISTINCT FROM`, MySQL's `<=>` null-safe-equal operator. A bare
 * `col IS <literal>` is SQLite-only — it is a syntax error on Postgres/MySQL — so
 * every cross-dialect equality predicate (the OCC guard and the rank seek/before
 * builders) must route through this rather than emitting `IS` directly.
 */
const nullSafeEqualsSql = (engine: SqlDialect["name"], reference: SQL, value: unknown): SQL => {
    if (engine === "postgres") {
        return sql`${reference} IS NOT DISTINCT FROM ${value}`;
    }

    if (engine === "mysql") {
        return sql`${reference} <=> ${value}`;
    }

    return sql`${reference} IS ${value}`;
};

/**
 * Where this engine puts NULLs, spelled out, for the keys that can hold one.
 *
 * `buildSeekWhere` is shared and dialect-blind: its NULL-aware pivot assumes the
 * SQLite/MySQL default, NULLs FIRST ascending and LAST descending. Postgres is
 * the mirror (`DESC` implies NULLS FIRST), so an ORDER BY that leans on the
 * engine default puts the NULL group on the side the seek does NOT expect. The
 * visible failure is a `desc` page over a nullable column: the seek's
 * `OR col IS NULL` arm re-selects the NULL group, Postgres sorts it back to the
 * top of every page, and with at least `limit` NULL rows the cursor stops
 * advancing and pagination loops on the same page forever.
 *
 * Stating the placement here rather than branching `pivotCondition` on a dialect
 * keeps the seek builder pure and dialect-blind, and fixes the `asc` and
 * null-pivot shapes in the same stroke — they disagreed with the seek on
 * Postgres too, just less visibly.
 *
 * Emitted only for a NULLABLE key on Postgres: MySQL has no `NULLS` clause in
 * its grammar at all, SQLite already agrees, and on a non-nullable column the
 * clause is noise that can cost the index — Postgres cannot answer
 * `ORDER BY c DESC NULLS LAST` from a plain btree walk.
 * @returns the ` NULLS FIRST`/` NULLS LAST` suffix, or `""` when the engine default already agrees
 */
const nullsPlacement = (dialect: SqlDialect, key: { direction?: string; nullable?: boolean }): string => {
    if (dialect.name !== "postgres" || key.nullable !== true) {
        return "";
    }

    return key.direction === "desc" ? " NULLS LAST" : " NULLS FIRST";
};

/**
 * Drizzle `ORDER BY` list — the SQL-object twin of `@lunora/do`'s string
 * `compileOrderBy`: each key as `<col> ASC|DESC`, with an `id` tiebreak appended
 * unless an id field is already ordered (keeps paging deterministic).
 *
 * The tiebreak follows the last key's direction, via the shared
 * `tiebreakDirectionFor`. Declared indexes here now carry the same
 * `(<fields>, _creationTime, id)` sort keys the DO builds (see
 * `indexSortKeys` below), and `normalizeOrderKeys` splices `_creationTime` in
 * ahead of the tiebreak, so an ordered read is an index walk on this backend
 * too — a single direction throughout is what keeps it one.
 *
 * NULL placement is the other half of that agreement — see {@link nullsPlacement}.
 */
const compileOrderBySql = (keys: ReadonlyArray<{ direction?: string; field: string; nullable?: boolean }>, dialect: SqlDialect): SQL => {
    const parts = keys.map((key) => sql`${columnRefSql(key.field)} ${sql.raw(`${key.direction === "desc" ? "DESC" : "ASC"}${nullsPlacement(dialect, key)}`)}`);

    if (!keys.some((key) => ID_ORDER_FIELDS.has(key.field))) {
        // No adaptation: the helper reads `direction` off the last key and
        // nothing else, so the keys go in as they are.
        const tiebreak = tiebreakDirectionFor(keys);

        parts.push(sql`${columnRefSql("id")} ${sql.raw(tiebreak === "desc" ? "DESC" : "ASC")}`);
    }

    return sql.join(parts, sql`, `);
};

interface SqlCtxDbOptions {
    /**
     * Resolved request auth handed to `.serverDefault(fn)` column factories so
     * server-trusted columns (owner/tenant ids) stamp from the verified caller,
     * never the client. The generated worker passes the per-request identity;
     * absent it, server-trusted columns stamp the anonymous slice (`userId: null`).
     */
    auth?: ServerDefaultContextLike["auth"];

    /**
     * Opt into change-data-capture: when `true`, every committed write appends a
     * post-image to the `__cdc_log` table (created lazily alongside the other
     * companion tables). Backs CDC streaming export for `.global()` tables — the
     * log is for export/CDC consumers, NOT point-in-time recovery: D1's PITR is
     * the platform's own Time Travel (`wrangler d1 time-travel restore`), an
     * atomic restore, not a changelog replay. Leave undefined for zero-cost
     * legacy behaviour.
     */
    cdc?: boolean;

    /**
     * How long `.global()` changelog entries are kept, in milliseconds. Absent
     * (the default) means forever — the log grows for the life of the database.
     *
     * Opt-in for the same reason the shard-local windows are, and the reason is
     * not caution: this log's streaming-export consumers hold opaque cursors
     * issued outside this deployment, and nothing here can see where they sit.
     * A default window would be a guess whose failure mode is silent data loss
     * in someone's warehouse. A deployment that wants the log bounded states a
     * window it knows covers its consumers; `.global()` shape pollers are then
     * protected exactly, by the floor this read path reports rather than by the
     * window. See `sweepSqlCdcRetention`.
     *
     * Time rather than rows because the log is SHARED: every shard in every
     * region writes it, so a row count is not a bound any single consumer can
     * reason about, while "older than N" is exactly what they compare their own
     * lag against.
     */
    cdcRetentionMs?: number;
    clock?: () => number;

    /**
     * Cross-shard counter for **reverse cross-backend relations** — the `_count`
     * mirror of the `crossShardReader` option below.
     */
    crossShardCounter?: DatabaseWriterLike["count"];

    /**
     * Optional cross-shard reader for **reverse cross-backend relations**: a
     * `.global()` (D1) parent loading a shard-local (`.shardBy()`/root) child.
     * Such a child's rows are partitioned across every shard DO, so the local D1
     * writer can't resolve it. When provided, the relation loader routes the
     * child's read through this (the host wires it to the Query Coordinator's
     * RLS-correct `fanOut`, with identity forwarded so each shard applies its own
     * RLS). Absent it, loading such a relation throws a clear "not supported"
     * error (legacy behaviour). The forward direction (shard-local parent →
     * global child) and same-backend relations never touch this.
     *
     * Takes {@link CrossShardReadArgs}, not `QueryArgs`: the hop is JSON, so the
     * RLS filters are handed over as data (see that type's docblock).
     */
    crossShardReader?: (table: string, args: CrossShardReadArgs) => Promise<QueryPage>;

    /**
     * The SQL dialect that shapes every statement (identifier quoting, value
     * encode/decode, column types, upserts, RETURNING vs affected-rows).
     * `@lunora/d1` passes its `sqliteDialect`; the PlanetScale/Hyperdrive backend
     * passes its Postgres/MySQL dialect. Required — the core is engine-blind.
     */
    dialect: SqlDialect;
    exec: SqlCtxExec;
    idGenerator?: () => string;

    /**
     * Ceiling on the number of child join keys a relation-crossing `where`
     * predicate may materialize before the semijoin pre-resolver fails closed
     * (`relation predicate … exceeding the N-key limit`). D1 has no EXISTS
     * push-down, so an overflow here can only fail closed — never truncate the
     * `IN (...)` and silently mis-match. Defaults to the pre-resolver's shared
     * key cap when omitted.
     */
    maxRelationKeys?: number;

    /**
     * Scheduler exposed to global-table trigger handlers as `ctx.scheduler`.
     * Absent it, `ctx.scheduler` is a stub that throws on use — pass one when
     * triggers on `.global()` tables need to enqueue follow-up work.
     */
    scheduler?: SchedulerLike;
    schema: SchemaLike;
}

/** Cap on re-entrant trigger writes before we treat it as a self-triggering loop. */
const MAX_TRIGGER_DEPTH = 50;

/**
 * Fill any field absent from `document` that declares a `.default()` literal or
 * `.$defaultFn()` factory. The factory wins when both are present; a literal is
 * applied on presence so `null`/`false`/`0` defaults survive.
 *
 * A `.serverDefault(fn)` column is SERVER-trusted: it is always stamped from
 * `auth` (overwriting any client-supplied value), so owner/tenant ids can never
 * be set by the client.
 */
const applyInsertDefaults = (
    definition: TableDefinitionLike,
    document: Record<string, unknown>,
    auth: ServerDefaultContextLike["auth"],
): Record<string, unknown> => {
    const result = { ...document };

    for (const [field, column] of tableColumns(definition)) {
        if (column.serverDefault) {
            result[field] = column.serverDefault({ auth });

            continue;
        }

        if (result[field] !== undefined) {
            continue;
        }

        if (column.defaultFn) {
            result[field] = column.defaultFn();
        } else if ("defaultValue" in column) {
            result[field] = column.defaultValue;
        }
    }

    return result;
};

/** Recompute every `.$onUpdateFn()` field the caller did not set explicitly, mutating `target` in place. */
const applyOnUpdate = (
    definition: TableDefinitionLike,
    provided: Record<string, unknown>,
    target: Record<string, unknown>,
    auth: ServerDefaultContextLike["auth"],
): void => {
    for (const [field, column] of tableColumns(definition)) {
        if (column.serverDefault) {
            // Server-trusted: if the client tried to set this field, overwrite it
            // with the server value so the column is never client-controllable. An
            // untouched field keeps its stored value (no re-stamp to the caller).
            if (field in provided) {
                // eslint-disable-next-line no-param-reassign -- documented mutate-in-place contract (see jsdoc above)
                target[field] = column.serverDefault({ auth });
            }

            continue;
        }

        if (column.onUpdateFn && !(field in provided)) {
            // Deliberate in-place mutation: callers pass the row they want
            // updated (e.g. `merged`/`replaced`) so the recomputed onUpdate
            // values land on the object that is about to be persisted.
            // eslint-disable-next-line no-param-reassign -- documented mutate-in-place contract (see jsdoc above)
            target[field] = column.onUpdateFn();
        }
    }
};

/**
 * Capacity of the per-ctx-db `id → tableName` LRU. Bounded so a long-lived ctx
 * (the writer outlives a single request) doesn't accumulate unbounded entries.
 */
const TABLE_NAME_CACHE_CAPACITY = 128;

/**
 * LRU cache over `id → tableName` resolutions. Backed by a `Map` whose insertion
 * order is the LRU order: on hit we delete-then-reinsert to move the key to the
 * tail; on overflow we evict the head (the oldest entry). Per-instance so a new
 * ctx-db starts cold and a unit test never inherits another's cache.
 */
const createTableNameCache = (): {
    delete: (id: string) => void;
    get: (id: string) => string | undefined;
    set: (id: string, table: string) => void;
} => {
    const map = new Map<string, string>();

    return {
        delete: (id) => {
            map.delete(id);
        },

        get: (id): string | undefined => {
            const hit = map.get(id);

            if (hit === undefined) {
                return undefined;
            }

            // Move to tail (most-recently-used) by re-inserting.
            map.delete(id);
            map.set(id, hit);

            return hit;
        },
        set: (id, table) => {
            if (map.has(id)) {
                map.delete(id);
            } else {
                // New key: bound the cache before inserting. The move-to-tail on
                // `get` above is what makes this LRU; the eviction itself is the
                // shared FIFO primitive.
                evictOldestEntry(map, TABLE_NAME_CACHE_CAPACITY);
            }

            map.set(id, table);
        },
    };
};

/**
 * Probe each table for `id`, mirroring the DO's id-only `get`/`patch`/`delete`
 * resolution. The schema handed in is the global-table subset, so this is a
 * small fixed scan — we fan the probes out in parallel and return on the first
 * hit. A small LRU caches successful lookups so a hot id (e.g. the same row
 * updated repeatedly within a request) avoids the fan-out on every call.
 *
 * Callers route through the ctx-db's `resolveTableName`, which provisions the
 * tables (memoized) first — so the probes always hit existing tables and no
 * missing-table handling is needed here.
 */
const tableNameFromId = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    schema: SchemaLike,
    id: string,
    cache: ReturnType<typeof createTableNameCache>,
): Promise<string | undefined> => {
    const cached = cache.get(id);

    if (cached !== undefined) {
        return cached;
    }

    // Skip tables that don't live in D1 — `.shardBy()` is spread across many
    // DOs and would never have a D1 row to find. The default root mode is also
    // DO-side; we only need to probe `.global()` tables. (Schemas authored
    // before the `.global()` flag existed don't set shardMode at all — preserve
    // the legacy "probe every table" behaviour there so existing fixtures keep
    // working.)
    const candidates = Object.entries(schema.tables)
        .filter(([, definition]) => definition.shardMode === undefined || definition.shardMode.kind === "global")
        .map(([tableName]) => tableName);

    // Fire every probe at once; the first non-empty result wins.
    const probes = await Promise.all(
        candidates.map(async (tableName) => {
            const rows = await queryAll(exec, dialect, sql`SELECT 1 FROM ${sql.identifier(tableName)} WHERE ${sql.identifier("id")} = ${id} LIMIT 1`);

            return { found: rows.length > 0, tableName };
        }),
    );

    for (const result of probes) {
        if (result.found) {
            cache.set(id, result.tableName);

            return result.tableName;
        }
    }

    return undefined;
};

/** Coerce a SQL aggregate scalar into `GroupByEntry.value` (`number | null`). */
// eslint-disable-next-line unicorn/no-null -- GroupByEntry.value / AggregateResult are `number | null`; an empty reduction is null.
const aggregateScalar = (value: unknown): null | number => (value === null || value === undefined ? null : Number(value));

/** Map raw `GROUP BY` result rows into `GroupByEntry` records, rebuilding each group's key tuple. */
const mapGroupByRows = (by: ReadonlyArray<string>, rows: ReadonlyArray<Record<string, unknown>>): GroupByEntry[] =>
    rows.map((row) => {
        const key: Record<string, unknown> = {};

        for (const field of by) {
            // eslint-disable-next-line unicorn/no-null -- GroupByEntry.key mirrors SQL group values; an absent grouped column is null in the result shape.
            key[field] = row[field] ?? null;
        }

        return { key, value: aggregateScalar((row as { value: unknown }).value) };
    });

/**
 * Whether none of the fields a rank index reads (partition / sort / static
 * `where`) differ between two row versions — the fast path that lets a patch of
 * an unrelated field skip the rank companion's DELETE+INSERT. Twin of
 * `@lunora/do`'s `rankIndexFieldsUnchanged` (replicated rather than imported —
 * it is a private helper there). This is also what keeps `restore()`'s forced
 * rank re-add correct: a marker-clearing patch touches no rank field, so the
 * patch-path sync skips and `restore()` performs the single re-INSERT.
 */
const rankIndexFieldsUnchanged = (index: RankIndexDefinitionLike, previous: Record<string, unknown>, next: Record<string, unknown>): boolean => {
    const fields = [...(index.partitionBy ?? []), ...index.sortBy.map((key) => key.field), ...(index.where ? Object.keys(index.where) : [])];

    return fields.every((field) => previous[field] === next[field]);
};

/**
 * Build the lexicographic "strictly before" OR-of-AND branches for a rank
 * position count. Each pivot fixes the higher-priority sort columns with `IS ?`
 * equality and applies the directional less-than/greater-than comparison on the
 * pivot column; the final branch tie-breaks on the id column. Returns the SQL
 * branch strings and their bind params in matching order.
 */
/** Join AND-conditions into one SQL, parenthesizing only when there's more than one. */
const andBranch = (conditions: SQL[]): SQL => (conditions.length === 1 ? (conditions[0] as SQL) : sql`(${sql.join(conditions, sql` AND `)})`);

/** Comma-joined quoted identifier list (column lists, SELECT lists). */
const identifierList = (names: ReadonlyArray<string>): SQL =>
    sql.join(
        names.map((name) => sql`${sql.identifier(name)}`),
        sql`, `,
    );

/** Comma-joined bound-value list (`VALUES (…)` tuples, `IN (…)` lists). */
const bindList = (values: ReadonlyArray<unknown>): SQL =>
    sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
    );

const buildRankBeforeBranches = (
    engine: SqlDialect["name"],
    index: RankIndexDefinitionLike,
    sortColumns: ReadonlyArray<string>,
    own: Record<string, unknown>,
    rowId: string,
): SQL | undefined => {
    const branches: SQL[] = [];

    for (let pivot = 0; pivot < sortColumns.length + 1; pivot += 1) {
        const conditions: SQL[] = sortColumns
            .slice(0, pivot)
            .map((prefixColumn) => nullSafeEqualsSql(engine, sql`${sql.identifier(prefixColumn)}`, own[prefixColumn]));
        const column = sortColumns[pivot];
        const sortKey = index.sortBy[pivot];

        if (pivot < sortColumns.length && column !== undefined && sortKey !== undefined) {
            conditions.push(sql`${sql.identifier(column)} ${sql.raw(sortKey.direction === "desc" ? ">" : "<")} ${own[column]}`);
        } else {
            conditions.push(sql`${sql.identifier(RANK_TIEBREAK)} < ${rowId}`);
        }

        branches.push(andBranch(conditions));
    }

    return branches.length > 0 ? sql.join(branches, sql` OR `) : undefined;
};

/**
 * Build the lexicographic seek predicate for a rankPage cursor. `columns` is the
 * ordered `[partition, ...sortColumns, id]` tuple with each column's direction;
 * `decoded` is the cursor's value tuple. Pushes its bind params onto `params`
 * (after any already present) and returns the `(... OR ...)` clause, or
 * `undefined` when the decoded cursor length doesn't match the column tuple.
 */
const buildRankCursorSeek = (
    engine: SqlDialect["name"],
    columns: ReadonlyArray<{ column: string; direction: "asc" | "desc" }>,
    decoded: ReadonlyArray<unknown>,
): SQL | undefined => {
    if (decoded.length !== columns.length) {
        return undefined;
    }

    const branches: SQL[] = [];

    for (const [pivot, col] of columns.entries()) {
        const conditions: SQL[] = [];

        for (let prefix = 0; prefix < pivot; prefix += 1) {
            const prefixCol = columns[prefix];

            if (prefixCol === undefined) {
                continue;
            }

            conditions.push(nullSafeEqualsSql(engine, sql`${sql.identifier(prefixCol.column)}`, decoded[prefix]));
        }

        conditions.push(sql`${sql.identifier(col.column)} ${sql.raw(col.direction === "desc" ? "<" : ">")} ${decoded[pivot]}`);
        branches.push(andBranch(conditions));
    }

    return sql`(${sql.join(branches, sql` OR `)})`;
};

/**
 * The rankPage column tuple in sort order: `[partition, ...sortColumns, id]`.
 * Partition and id sort ascending; each sort column follows its index direction.
 */
const rankPageColumns = (index: RankIndexDefinitionLike, sortColumns: ReadonlyArray<string>): { column: string; direction: "asc" | "desc" }[] => {
    // A rank index with no sort columns degenerates the cursor tuple to
    // `[__partition__, RANK_TIEBREAK]`, which lets `buildRankCursorSeek` silently
    // mismatch and return a wrong/empty page. The schema builder already requires
    // a non-empty `sortBy` (packages/server/src/schema.ts), so this is a
    // belt-and-suspenders guard that fails loudly instead of paginating wrong.
    if (index.sortBy.length === 0) {
        throw new LunoraError("INTERNAL", `rankIndex "${index.name}" requires at least one "sortBy" column for stable pagination`);
    }

    const columns: { column: string; direction: "asc" | "desc" }[] = [{ column: "__partition__", direction: "asc" }];

    for (const [i, sortKey] of index.sortBy.entries()) {
        columns.push({ column: sortColumns[i] ?? sortColumnName(i), direction: sortKey.direction });
    }

    columns.push({ column: RANK_TIEBREAK, direction: "asc" });

    return columns;
};

/**
 * Hydrate the source rows for a page of rank-companion ids, preserving the
 * companion's order. Batches the lookups into `IN (?, …)` chunks: D1 documents a
 * 100-parameter statement ceiling (https://developers.cloudflare.com/d1/platform/limits/),
 * so a 50-id chunk leaves headroom. A 100-row page issues ⌈n/50⌉ queries instead
 * of one-per-row. Rows that fail to decode are dropped.
 */
const hydrateRankRows = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    ids: ReadonlyArray<string>,
): Promise<Record<string, unknown>[]> => {
    const IN_CHUNK_SIZE = 50;
    const chunks: string[][] = [];

    for (let cursor = 0; cursor < ids.length; cursor += IN_CHUNK_SIZE) {
        chunks.push(ids.slice(cursor, cursor + IN_CHUNK_SIZE));
    }

    const fetched = await Promise.all(
        chunks.map(async (chunk) =>
            queryAll(exec, dialect, sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${sql.identifier("id")} IN (${bindList(chunk)})`),
        ),
    );

    const byId = new Map<string, Record<string, unknown>>();

    for (const rows of fetched) {
        for (const row of rows) {
            byId.set(row["id"] as string, row);
        }
    }

    const documents: Record<string, unknown>[] = [];

    for (const id of ids) {
        const decoded = decodeRow(definition, byId.get(id));

        if (decoded) {
            documents.push(decoded);
        }
    }

    return documents;
};

/**
 * Base64-encode a rankPage continuation cursor (the `[partition, ...sortValues, id]`
 * tuple) as JSON, behind the shared cursor marker.
 *
 * The marker is not decoration: `decodeCursor` refuses anything without it, so
 * a mint site that forgets it produces cursors its own reader rejects. This one
 * did, and only the rank pagination test caught it.
 */
const encodeRankCursor = (cursorValues: ReadonlyArray<unknown>): string => {
    const json = JSON.stringify(cursorValues);
    const bytes = new TextEncoder().encode(json);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return CURSOR_PREFIX + btoa(binary);
};

/**
 * Refuse a SQL-side reduce or group over a column stored as an order-preserving
 * key rather than as its value.
 *
 * A `v.bigint()` column holds the zero-padded key {@link bigintSqlKey} builds, so
 * `SUM` over it coerces to nonsense (1.5e40 for a couple of small amounts),
 * `MIN`/`MAX` hand back the padded string, and a `GROUP BY` key comes back as 40
 * characters of padding. All three look like answers, and `SUM` past 2^53 used
 * instead to escape as a raw driver `RangeError`.
 *
 * The maintained `__agg_` companion is what the error names instead. It is exact
 * per contribution — `coerceAggregateNumber` refuses any single `bigint` past
 * 2^53 outright — but its running total accumulates in a REAL column, so a sum
 * of in-range values can still cross 2^53 and round there. The message says so
 * rather than promising exactness the companion cannot give. Applied at every SQL-reducing entry point —
 * `aggregate`'s scan and both halves of `groupBy` — matching the shard twin's
 * `assertReducibleBySql`, which shipped guarding one and not its sibling.
 * @throws LunoraError `BAD_REQUEST` when `field` is stored as an order-preserving key
 */
const assertReducibleBySql = (definition: SchemaLike["tables"][string], field: string, label: string): void => {
    const validator = definition.shape[field];

    if (validator !== undefined && effectiveColumnKind(validator) === "bigint") {
        throw new LunoraError(
            "BAD_REQUEST",
            `${label}: "${field}" is stored as an order-preserving key, which SQL cannot reduce or group — declare an aggregateIndex covering this (by, field, op) so the maintained companion answers it instead (its running total is a REAL, so it stays exact only while the total is inside 2^53)`,
        );
    }
};

/**
 * Whether a column of this validator **could** hold a `bigint` — i.e. whether
 * `sqliteEncode` may have stored an order-preserving key there rather than a
 * value SQL can reduce.
 *
 * Deliberately wider than {@link assertReducibleBySql}'s test, which stays on the
 * declared kind because it REFUSES a read. This one only decides whether the
 * min/max write path reduces in SQL or folds in JS, and over-including costs a
 * scan where under-including writes a confident wrong number. `sqliteEncode`
 * keys off the RUNTIME type, so a `v.any()` / `v.union()` / `v.from()` column
 * holding a bigint is stored as a padded key exactly like a declared one; gating
 * on the declared kind alone is how the shard twin wrote ~1e39 into a companion,
 * one declaration away.
 * @returns `true` when a value in this column may be a `bigint` key
 */
const mayHoldBigintKey = (validator: SchemaLike["tables"][string]["shape"][string] | undefined): boolean => {
    if (validator === undefined) {
        return false;
    }

    const kind = effectiveColumnKind(validator);

    return kind === "any" || kind === "bigint" || kind === "from" || kind === "union";
};

/** Applies {@link assertReducibleBySql} to every field a `groupBy` scan hands to SQL: the `by` keys and the reducer's own field. */
const assertGroupByReducibleBySql = (
    definition: SchemaLike["tables"][string],
    tableName: string,
    by: ReadonlyArray<string>,
    agg: { field?: string; op: string },
): void => {
    for (const field of by) {
        assertReducibleBySql(definition, field, `groupBy(${tableName}, { by: [..."${field}"] })`);
    }

    if (agg.field !== undefined) {
        assertReducibleBySql(definition, agg.field, `groupBy(${tableName}, { agg: { op: "${agg.op}", field: "${agg.field}" } })`);
    }
};

/**
 * The two changelog identifiers, imported from `@lunora/shard-engine` rather than
 * re-declared. The `.global()` log and the DO log are the same table under two
 * dialects, and a name that differed between them would break every consumer
 * that reads both — so the shared thing is shared, and only the DIALECT
 * differences (the MySQL key prefix below, the `SELECT` forms) live here.
 */
/* The changelog identifiers come from `@lunora/shard-engine` — see the import. */

/** Single-row table holding the `.global()` sweep lease — the fleet's only retention coordination. */
const CDC_SWEEP_TABLE = "__cdc_sweep";

/** The lease row's fixed key. One log, one sweeper, one row. */
const CDC_SWEEP_ROW = "global";

/**
 * How long a winning sweeper holds the lease, and therefore roughly how often
 * the FLEET sweeps in total — not how often each shard does.
 *
 * A shard-local sweep can pick its own interval because it is alone. Here the
 * interval has to be a property of the log, or a deployment's sweep rate would
 * scale with its shard count.
 */
const CDC_SWEEP_LEASE_MS = 60_000;

/**
 * Rows one `.global()` sweep pass may delete.
 *
 * Same REASON as the shard-local `SHARD_CDC_SWEEP_MAX_ROWS` in `@lunora/do` — an
 * unbounded first sweep over an accumulated backlog aborts and retries forever —
 * but deliberately a fifth of its value, and named apart from it so neither
 * reads as a re-export of the other. That sweep deletes from the shard's own
 * workerd SQLite; this one goes over the network to D1 or PlanetScale, where the
 * same row count is a much larger statement.
 */
const GLOBAL_CDC_SWEEP_MAX_ROWS = 10_000;

/**
 * Minimum spacing between LEASE ATTEMPTS on one isolate.
 *
 * The lease is what stops the fleet sweeping N times; this is what stops a busy
 * isolate paying a compare-and-set on every single `.global()` write. It is
 * module-level, so it is per-isolate and deliberately approximate — many
 * isolates means many attempts, but each is one small conditional `UPDATE` that
 * mostly matches nothing, and the lease makes the ones that do match harmless.
 */
const CDC_SWEEP_ATTEMPT_MS = 30_000;

/**
 * When this isolate last tried to claim the sweep lease. See
 * {@link CDC_SWEEP_ATTEMPT_MS}.
 *
 * One counter for the whole isolate, deliberately: an app has a single global
 * changelog, so "this isolate" and "this log" are the same scope. A worker that
 * ever bound two `.global()` backends would share the throttle between them and
 * sweep at most one per window — key this by store at that point, not before.
 */
let lastSweepAttemptAt = 0;

/** Create the `__cdc_log` table. Idempotent; only run when CDC is enabled. */
const runSqlCdcMigration = async (exec: SqlCtxExec, dialect: SqlDialect): Promise<void> => {
    const { autoincrementPrimaryKey, key, real, text } = dialect.companionTypes;

    // `doc` holds the full post-image JSON, which can be arbitrarily large — it
    // uses the unbounded `text` type, never the index-bounded `key` (`key` is
    // VARCHAR(768) on MySQL, which would silently truncate big rows).
    await queryRun(
        exec,
        dialect,
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(CDC_LOG_TABLE)} (${sql.identifier("seq")} ${sql.raw(autoincrementPrimaryKey)}, ${sql.identifier("ts")} ${sql.raw(real)} NOT NULL, ${sql.identifier("table")} ${sql.raw(key)} NOT NULL, ${sql.identifier("id")} ${sql.raw(key)} NOT NULL, ${sql.identifier("op")} ${sql.raw(key)} NOT NULL, ${sql.identifier("doc")} ${sql.raw(text)})`,
    );

    // `("table", seq)` covers both the filter and the ordering of every
    // table-scoped changelog read (the `.global()` shape delta path); without it
    // that read scans the whole log in commit order and discards other tables'
    // rows. Mirrors the DO twin's `CDC_LOG_TABLE_SEQ_INDEX`.
    //
    // The key prefix is what makes this legal on MySQL. `key` is `VARCHAR(768)`
    // there precisely because 768 utf8mb4 characters is InnoDB's limit for a
    // SINGLE-column index (768 × 4 = 3072 bytes) — so adding `seq` to it puts the
    // composite key over that limit and the migration fails outright with
    // ER_TOO_LONG_KEY. A prefix bounds `table`'s contribution; it costs nothing in
    // selectivity because the column holds a table name, not user data. Engines
    // that index text directly (SQLite, Postgres) return no prefix and index the
    // whole column.
    const tablePrefix = dialect.indexKeyPrefix?.("string");

    await createIndexIfNotExists(exec, dialect, {
        columns: sql`${tablePrefix === undefined ? sql`${sql.identifier("table")}` : sql`${sql.identifier("table")}(${sql.raw(String(tablePrefix))})`}, ${sql.identifier("seq")}`,
        name: CDC_LOG_TABLE_SEQ_INDEX,
        table: CDC_LOG_TABLE,
        unique: false,
    });

    // The sweep lease. One row, and it is the whole of the cross-shard
    // coordination: see {@link sweepSqlCdcRetention}.
    await queryRun(
        exec,
        dialect,
        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(CDC_SWEEP_TABLE)} (${sql.identifier("id")} ${sql.raw(key)} NOT NULL PRIMARY KEY, ${sql.identifier("lease_until")} ${sql.raw(real)} NOT NULL)`,
    );

    // Seed it expired so the first writer to look can claim it. `DO NOTHING` on
    // conflict: every shard in the fleet runs this migration, and the row must
    // survive their races without any of them resetting a live lease.
    await queryRun(
        exec,
        dialect,
        sql`INSERT INTO ${sql.identifier(CDC_SWEEP_TABLE)} (${sql.identifier("id")}, ${sql.identifier("lease_until")}) VALUES (${CDC_SWEEP_ROW}, ${0}) ${
            // MySQL has no `DO NOTHING`; the conventional no-op assignment is the
            // same trick the upsert builder above uses for its dialect split.
            dialect.name === "mysql"
                ? sql`ON DUPLICATE KEY UPDATE ${sql.identifier("id")} = ${sql.identifier("id")}`
                : sql`ON CONFLICT(${sql.identifier("id")}) DO NOTHING`
        }`,
    );
};

/**
 * Try to become the fleet's sweeper for one window.
 *
 * The `.global()` changelog differs from the shard-local one in exactly one way
 * that matters here: it has no owner. Every shard writes it, from every region,
 * and none of them is the one that should trim it. Left to themselves they would
 * all trim it at once — N concurrent unbounded `DELETE`s against one D1 database.
 *
 * A lease row settles it without a registry: whoever wins the compare-and-set
 * sweeps, everyone else returns immediately, and the lease doubles as the
 * interval (a winner holds it for {@link CDC_SWEEP_LEASE_MS}, so the fleet
 * sweeps about that often in total rather than once per shard). A sweeper that
 * dies mid-pass loses nothing: the lease simply expires and the next writer
 * picks up where the `ts` cutoff says to.
 */
const acquireSqlCdcSweepLease = async (exec: SqlCtxExec, dialect: SqlDialect, now: number): Promise<boolean> => {
    const claim = sql`UPDATE ${sql.identifier(CDC_SWEEP_TABLE)} SET ${sql.identifier("lease_until")} = ${now + CDC_SWEEP_LEASE_MS} WHERE ${sql.identifier("id")} = ${CDC_SWEEP_ROW} AND ${sql.identifier("lease_until")} <= ${now}`;

    // Same compare-and-set idiom as the OCC write path: `RETURNING` where the
    // engine has it, affected-rows where it does not (MySQL).
    if (dialect.supportsReturning) {
        const claimed = await queryAll(exec, dialect, sql`${claim} RETURNING ${sql.identifier("id")}`);

        return claimed.length > 0;
    }

    const result = await queryRun(exec, dialect, claim);

    return (dialect.affectedRows ? dialect.affectedRows(result ?? { rowsAffected: 0 }) : 0) > 0;
};

/**
 * Delete `.global()` changelog entries older than `retentionMs`, at most
 * {@link GLOBAL_CDC_SWEEP_MAX_ROWS} per pass, and only if this writer wins the lease.
 *
 * **Time, not rows.** The shard-local twin bounds its log by row count because
 * one shard owns it and a row count is a memory bound on that one object. This
 * log is shared, so a row count means nothing to any individual consumer — but
 * "older than N" is directly what every consumer needs to reason about, and it
 * is the unit an operator can compare against their own connector's lag.
 *
 * **Which consumers this can strand, and what protects each:**
 *
 * - `.global()` shape pollers hold in-memory cursors this store cannot see. They
 *   are protected EXACTLY rather than approximately: {@link readSqlCdcChangedTables}
 *   reports the retained floor, and a poller below it treats the tick as "no
 *   visibility" and re-reads every shape. That is the same self-healing path a
 *   changelog error already takes, so a trimmed poller is slow for one tick, not
 *   wrong. No cursor registry, no assumption about how far behind a shard can be.
 * - Streaming-export / warehouse consumers hold opaque cursors issued outside
 *   this deployment. Nothing here can see them, so nothing here guesses:
 *   {@link readSqlCdcChanges} refuses a page below the floor rather than serving
 *   the surviving tail, and retention stays OFF unless an operator states a
 *   window they know covers their connector.
 */
const sweepSqlCdcRetention = async (exec: SqlCtxExec, dialect: SqlDialect, retentionMs: number, now: number): Promise<void> => {
    if (!(await acquireSqlCdcSweepLease(exec, dialect, now))) {
        return;
    }

    const cutoff = now - retentionMs;

    // Bounded per pass for the same reason the shard-local sweep is: the first
    // sweep after an operator enables retention faces the entire accumulated
    // log, and an unbounded DELETE that aborts leaves no progress behind.
    //
    // The bounded select is wrapped in a derived table, which looks redundant
    // and is not: MySQL rejects a `LIMIT` inside an `IN (subquery)` outright
    // ("This version of MySQL doesn't yet support 'LIMIT & IN/ALL/ANY/SOME
    // subquery'"), so the direct form throws on every Hyperdrive-MySQL
    // deployment while working fine on SQLite and Postgres. Materialising the
    // subquery through a derived table is the one form all three accept —
    // MySQL's own `DELETE … ORDER BY … LIMIT` would need a dialect split,
    // since Postgres has no such syntax. Postgres requires the alias, so it is
    // not optional either.
    await queryRun(
        exec,
        dialect,
        sql`
            DELETE FROM ${sql.identifier(CDC_LOG_TABLE)} WHERE ${sql.identifier("seq")} IN (
                        SELECT ${sql.identifier("seq")} FROM (
                            SELECT ${sql.identifier("seq")} FROM ${sql.identifier(CDC_LOG_TABLE)} WHERE ${sql.identifier("ts")} <= ${cutoff} ORDER BY ${sql.identifier("seq")} ASC LIMIT ${sql.raw(String(GLOBAL_CDC_SWEEP_MAX_ROWS))}
                        ) AS ${sql.identifier("expired")}
                    )
        `,
    );
};

/** Oldest `seq` still retained in the `.global()` changelog, or `undefined` when it is empty. */
const readSqlCdcFloor = async (exec: SqlCtxExec, dialect: SqlDialect): Promise<number | undefined> => {
    const rows = await queryAll(exec, dialect, sql`SELECT MIN(${sql.identifier("seq")}) AS ${sql.identifier("seq")} FROM ${sql.identifier(CDC_LOG_TABLE)}`);
    const floor = Number(rows[0]?.["seq"] ?? Number.NaN);

    return Number.isFinite(floor) ? floor : undefined;
};

/** Serialize a changelog post-image, tagging the leaves JSON cannot carry. Identity for a pure-JSON document. */
const encodeCdcDocJson = (doc: Record<string, unknown>): string => JSON.stringify(needsWireEncoding(doc) ? encodeWire(doc) : doc);

/**
 * Append one committed mutation to the changelog (post-image JSON, or NULL for
 * delete).
 *
 * The post-image is a decoded document — a `v.bigint()` column is a real
 * `bigint` and a `v.bytes()` column an `ArrayBuffer` — so it goes through
 * `encodeWire` before `JSON.stringify`, exactly as the DO twin's
 * `encodeDocJson` does. A bare `JSON.stringify` throws on the former and
 * silently records `{}` for the latter, and it throws AFTER the row is already
 * committed. `needsWireEncoding` keeps the common pure-JSON document on the
 * allocation-free path and byte-identical to what it was before.
 */
const appendSqlCdcChange = async (
    exec: SqlCtxExec,
    ts: number,
    table: string,
    id: string,
    op: CdcChange["op"],
    doc: Record<string, unknown> | undefined,
    dialect: SqlDialect,
): Promise<void> => {
    await queryRun(
        exec,
        dialect,
        sql`INSERT INTO ${sql.identifier(CDC_LOG_TABLE)} (${sql.identifier("ts")}, ${sql.identifier("table")}, ${sql.identifier("id")}, ${sql.identifier("op")}, ${sql.identifier("doc")}) VALUES (${ts}, ${table}, ${id}, ${op}, ${
            // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct post-image for a delete; the `id` identifies the removed row.
            doc === undefined ? null : encodeCdcDocJson(doc)
        })`,
    );
};

/**
 * Read changelog entries newer than `sinceSeq` in commit order, up to `limit`
 * (clamped to [1, 10000]); plus the cursor to resume from.
 */
const readSqlCdcChanges = async (
    exec: SqlCtxExec,
    options: { limit?: number; sinceSeq?: number },
    dialect: SqlDialect,
): Promise<{ changes: CdcChange[]; cursor: number }> => {
    const sinceSeq = options.sinceSeq ?? 0;
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));

    // Retention-gap guard, mirroring the shard-local `runShardCdcSync`. Without
    // it a consumer resuming below a swept floor is handed the surviving tail
    // with an advanced cursor and no indication anything was skipped — a
    // warehouse table permanently missing the trimmed range, reported nowhere.
    // `+ 1` because a consumer sitting exactly at `floor - 1` has seen
    // everything below the floor.
    //
    // Unconditional, unlike `readSqlCdcChangedTables`, which reads the floor only
    // when retention is configured. That reader runs on the 2s shape poll and its
    // consumers self-heal by re-reading; this one serves opaque warehouse cursors
    // that cannot. Skipping the probe when retention is currently off would
    // disarm the guard for a deployment that swept and then turned retention
    // back off — one round trip per export page is not worth trading a silent
    // gap for.
    const floor = await readSqlCdcFloor(exec, dialect);

    if (floor !== undefined && cursorBelowRetainedFloor(floor, sinceSeq)) {
        throw cdcTrimmedError(floor, sinceSeq, "global");
    }

    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT seq, ts, ${sql.identifier("table")}, id, op, doc FROM ${sql.identifier(CDC_LOG_TABLE)} WHERE seq > ${sinceSeq} ORDER BY seq ASC LIMIT ${sql.raw(String(limit))}`,
    );

    const changes = rows.map((row): CdcChange => {
        const { doc } = row;
        const base = { id: String(row.id), op: String(row.op) as CdcChange["op"], seq: Number(row.seq), table: String(row.table), ts: Number(row.ts) };

        // `decodeWire` mirrors the `encodeWire` on the append side, so a
        // `v.bigint()` / `v.bytes()` post-image comes back as the real value
        // rather than its tagged form. Identity for a pure-JSON document.
        return typeof doc === "string" ? { ...base, doc: decodeWire(JSON.parse(doc)) as Record<string, unknown> } : base;
    });

    return { changes, cursor: changes.at(-1)?.seq ?? sinceSeq };
};

/**
 * Which tables the changelog recorded a write to after `sinceSeq`, plus the
 * cursor to resume from. Metadata only — it reads no `doc`, so its cost is a
 * grouped scan over an index range rather than the size of the documents in it.
 *
 * The `.global()` shape poll asks this once per tick for the whole shard, and a
 * shape whose table is absent from the answer skips its membership read
 * entirely.
 *
 * **One statement, and the cursor comes out of the same rows as the tables.**
 * Reading the head separately — in either order — opens a window where a write
 * commits between the two round trips and ends up absent from `tables` while
 * sitting at or below the adopted `cursor`, which loses it for good. Deriving
 * the cursor as the max `seq` actually returned closes that window by
 * construction: the caller can never advance past a row this scan did not see.
 *
 * **What it does NOT close**, and the poll's resync interval is what covers it:
 * Postgres and MySQL allocate `seq` from a sequence BEFORE commit, so a
 * transaction holding a lower `seq` can commit after one holding a higher one.
 * No single read can see the uncommitted row, so a change can land below a
 * cursor already adopted. That change is invisible to the changelog probe until
 * the next unconditional pass — bounded by `GLOBAL_SHAPE_RESYNC_MS`, which is
 * the same bound already accepted for an out-of-band writer. D1 has no such
 * window (single writer, and `withSession` gives both reads one snapshot).
 */
const readSqlCdcChangedTables = async (
    exec: SqlCtxExec,
    sinceSeq: number,
    dialect: SqlDialect,
    options: { cursorOnly?: boolean; retained?: boolean } = {},
): Promise<{ cursor: number; floor?: number; tables: string[] }> => {
    if (options.cursorOnly) {
        // The caller is reading everything this pass regardless, so the table
        // list would be discarded — and on the cold-instance case that produces
        // it, computing it means grouping the entire changelog. `MAX(seq)` over
        // the primary key answers what is actually wanted.
        const head = await queryAll(exec, dialect, sql`SELECT MAX(seq) AS seq FROM ${sql.identifier(CDC_LOG_TABLE)}`);
        const rawCursor = Number(head[0]?.["seq"] ?? sinceSeq);

        return { cursor: Number.isFinite(rawCursor) ? rawCursor : sinceSeq, tables: [] };
    }

    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT ${sql.identifier("table")} AS ${sql.identifier("table")}, MAX(seq) AS seq FROM ${sql.identifier(CDC_LOG_TABLE)} WHERE seq > ${sinceSeq} GROUP BY ${sql.identifier("table")}`,
    );

    let cursor = sinceSeq;
    const tables: string[] = [];

    for (const row of rows) {
        const seq = Number(row["seq"]);

        if (Number.isFinite(seq) && seq > cursor) {
            cursor = seq;
        }

        tables.push(String(row["table"]));
    }

    // The retained floor, so a caller can tell "nothing changed" from "what
    // changed was swept away". Read AFTER the scan, not before: the floor only
    // ever rises, so a sweep interleaving between the two makes this report a
    // gap that has only just opened — one wasted full pass. Reading it first
    // would let a sweep land after it and hide a gap that is real.
    //
    // Only when retention is configured. With no sweep the floor never moves off
    // the log's first row, so the gap it detects cannot occur — and this is a
    // read on a two-second poll, which is the wrong place to spend a round trip
    // proving something that is true by construction.
    const floor = options.retained === true ? await readSqlCdcFloor(exec, dialect) : undefined;

    return { cursor, tables, ...(floor === undefined ? {} : { floor }) };
};

/** SQLite phrases `SQLITE_TOOBIG` as "string or blob too big"; D1, workerd and `node:sqlite` all surface that same text. */
const SQLITE_ROW_TOO_BIG_RE = /string or blob too big/iu;

/** Postgres' wording for a heap tuple that will not fit its page (`ERROR: row is too big: size 8168, maximum size 8160`). */
const PG_ROW_TOO_BIG_RE = /row is too big/iu;

/**
 * Does `error` say the row this write tried to store is over the engine's
 * per-row ceiling, and if so, what is that ceiling called? Returns `undefined`
 * when the error is anything else.
 *
 * Recognised per dialect, because only the wording is shared with the
 * shard-local plane:
 *
 * - **SQLite** (D1, workerd, `node:sqlite`) phrases `SQLITE_TOOBIG` as "string
 *   or blob too big" — the same text the `lunora-row-too-big` solutions entry
 *   in `@lunora/errors` keys on.
 * - **MySQL** raises `ER_TOO_BIG_ROWSIZE`. Drivers disagree on which field
 *   carries it — mysql2 sets `errno`, others only the symbolic `code` — so
 *   accept either, the way `createIndexIfNotExists` already accepts
 *   `ER_DUP_KEYNAME`.
 * - **Postgres** raises `program_limit_exceeded` (SQLSTATE 54000) with "row is
 *   too big"; the code alone is too broad (it also covers target-list and
 *   argument-count limits), so the message is what decides.
 */
const rowTooBigLimit = (dialect: SqlDialect, error: unknown): string | undefined => {
    const { code, errno } = error as { code?: unknown; errno?: unknown };
    const message = error instanceof Error ? error.message : "";

    switch (dialect.name) {
        case "mysql": {
            return errno === 1118 || code === "ER_TOO_BIG_ROWSIZE"
                ? "InnoDB's per-row ceiling — roughly 8 KB, half a 16 KB page, for the part of the row stored inline"
                : undefined;
        }
        case "postgres": {
            return PG_ROW_TOO_BIG_RE.test(message) ? "the 8 KB heap page a tuple must fit once its wide columns have been TOASTed out" : undefined;
        }
        default: {
            return SQLITE_ROW_TOO_BIG_RE.test(message) ? "the storage engine's per-row ceiling (2 MB on D1)" : undefined;
        }
    }
};

/**
 * Row-size overflow is the one storage-engine limit a caller can act on, so it
 * must survive the wire. None of the three engines raises a `LunoraError`, and
 * `toErrorBody` redacts every foreign throw to `INTERNAL` / "Internal error" /
 * 500 — leaving the operator a redacted 500 for a document they can simply move
 * to R2. `PAYLOAD_TOO_LARGE` is catalogued non-internal (413), so this message
 * reaches the client with the limit named.
 *
 * The shard-local plane does the same thing in its own `runWrite`
 * (`@lunora/shard-engine`); the recogniser is not shared because the engine
 * ceilings and their error shapes are not.
 */
const throwIfRowTooBig = (dialect: SqlDialect, error: unknown, table: string): void => {
    const limit = rowTooBigLimit(dialect, error);

    if (limit === undefined) {
        return;
    }

    throw new LunoraError(
        "PAYLOAD_TOO_LARGE",
        `document is too large to store in "${table}": a single row cannot exceed ${limit}. The limit is on the STORED bytes, which are UTF-8. Keep the payload in R2 (ctx.storage) and store a reference on the row.`,
    );
};

/**
 * Remap a write's raw engine error to the coded one a caller can act on, then
 * rethrow — the single `catch` body every write path shares.
 *
 * A UNIQUE-index breach is a {@link ConflictError} (`CONFLICT`, 409): the caller
 * lost a race or wrote a duplicate, both of which they can answer. A row over
 * the engine's ceiling is {@link throwIfRowTooBig}'s `PAYLOAD_TOO_LARGE`.
 * Anything else is rethrown untouched — guessing at an unrecognised engine error
 * is how a redacted 500 becomes a wrong 409.
 *
 * Takes `dialect` rather than a pre-destructured `isUniqueViolation`, matching
 * `throwIfRowTooBig`: the two used to disagree, which is why the identical catch
 * body could not simply be lifted out.
 */
const mapWriteError = (dialect: SqlDialect, error: unknown, table: string): never => {
    if (dialect.isUniqueViolation(error)) {
        throw new ConflictError(`unique constraint violation on "${table}"`, "unique");
    }

    throwIfRowTooBig(dialect, error, table);

    throw error;
};

const createSqlCtxDb = (options: SqlCtxDbOptions): DatabaseWriterLike => {
    const { crossShardCounter, crossShardReader, exec, maxRelationKeys, schema } = options;

    // The engine dialect for this ctx-db. Destructured into the names the body
    // already uses so the (large) closure body is unchanged — these block-scoped
    // locals shadow the module-level SQLite helpers/imports. `@lunora/hyperdrive/global`
    // injects a Postgres/MySQL dialect; absent one, this is the SQLite default.
    const { dialect } = options;
    // Value encode stays the shared SQLite codec (`serializeColumnValue`) on every
    // engine — storage is SQLite-shaped everywhere. Identifier quoting and
    // placeholder numbering are drizzle's job (rendered per-engine via renderSql),
    // so the strategy only carries the per-engine WHERE differences: the
    // substring test's position function, and (on D1) the bound-parameter budget.
    const whereSqlStrategy: WhereSqlStrategy = {
        fieldRef: columnRefSql,
        serialize: serializeColumnValue,
        // `contains` keeps whatever case behaviour each engine's substring test
        // already gives callers, which is NOT the same across the three: SQLite is
        // ASCII-case-insensitive (the compiler's `instr(lower(…), lower(…))`
        // default), while Postgres (`strpos`) and MySQL (`LOCATE`) are both
        // byte-exact. MySQL's `LOCATE` follows the column collation and
        // `@lunora/hyperdrive`'s dialect pins every character column to
        // `utf8mb4_0900_bin` — a column's collation beats a bound literal's — so it
        // is case-SENSITIVE there, not case-insensitive as this comment used to say.
        // Left as-is deliberately: there is no majority to fold toward, and making
        // MySQL insensitive would silently widen every shipped `contains` filter.
        ...(dialect.name === "mysql" ? { containsExpr: (reference, term) => sql`LOCATE(${term}, ${reference}) > 0` } : {}),
        ...(dialect.name === "postgres" ? { containsExpr: (reference, term) => sql`strpos(${reference}, ${term}) > 0` } : {}),
        // The compiler defaults `inList` to SQLite's bounded `json_each` form,
        // because D1 is the same Workerd build as a Durable Object and caps a
        // statement at 100 bound parameters. The other two engines bind
        // thousands and have no `json_each`, so they take the literal list.
        ...(dialect.name === "sqlite" ? {} : { inList: literalInList }),
    };

    /** NULL-safe equality for the OCC guard, bound to this ctx-db's engine (see the module-level {@link nullSafeEqualsSql}). */
    const nullSafeEquals = (reference: SQL, value: unknown): SQL => nullSafeEqualsSql(dialect.name, reference, value);

    /**
     * Build an `INSERT … VALUES … <conflict clause>` upsert as a drizzle SQL for
     * the aggregate counters. SQLite/Postgres emit `ON CONFLICT(<key>) DO UPDATE
     * SET …`; MySQL emits `ON DUPLICATE KEY UPDATE …` (keyed off `dialect.name`).
     * The `set` callback returns `{ <unquoted column>: <update expression> }`
     * pairs, building expressions from `excluded(col)` (the proposed row) and
     * `current(col)` (the existing row — qualified with the table name on Postgres,
     * where a bare reference is ambiguous between the target and `excluded`).
     */
    const upsertSql = (config: {
        columns: ReadonlyArray<string>;
        conflictKey: string;
        set: (excluded: (column: string) => SQL, current: (column: string) => SQL) => Record<string, SQL>;
        table: string;
        values: ReadonlyArray<unknown>;
    }): SQL => {
        const columnList = identifierList(config.columns);
        const valueList = bindList(config.values);
        const excluded = (column: string): SQL => (dialect.name === "mysql" ? sql`VALUES(${sql.identifier(column)})` : sql`excluded.${sql.identifier(column)}`);
        // Postgres can't resolve a bare existing-row column in the SET RHS (it's in
        // both the target and `excluded` scopes) — qualify with the table name.
        const current = (column: string): SQL =>
            dialect.name === "postgres" ? sql`${sql.identifier(config.table)}.${sql.identifier(column)}` : sql`${sql.identifier(column)}`;
        const assignments = sql.join(
            Object.entries(config.set(excluded, current)).map(([column, expression]) => sql`${sql.identifier(column)} = ${expression}`),
            sql`, `,
        );
        const conflict =
            dialect.name === "mysql"
                ? sql`ON DUPLICATE KEY UPDATE ${assignments}`
                : sql`ON CONFLICT(${sql.identifier(config.conflictKey)}) DO UPDATE SET ${assignments}`;

        return sql`INSERT INTO ${sql.identifier(config.table)} (${columnList}) VALUES (${valueList}) ${conflict}`;
    };

    const clock = options.clock ?? (() => Date.now());
    const generateId = options.idGenerator ?? (() => crypto.randomUUID());
    const cdcEnabled = options.cdc ?? false;
    // Positive-and-finite only: a zero or negative window would mean "delete
    // everything ever written", which is never what an operator means by a
    // retention setting and is not a state this should be able to reach by typo.
    const cdcRetentionMs =
        typeof options.cdcRetentionMs === "number" && Number.isFinite(options.cdcRetentionMs) && options.cdcRetentionMs > 0
            ? options.cdcRetentionMs
            : undefined;
    // Resolved request auth for `.serverDefault(fn)` column factories; defaults
    // to the anonymous slice when the writer is built without a caller identity.
    // eslint-disable-next-line unicorn/no-null -- the auth slice models the anonymous caller as null identity/userId (mirrors `ServerDefaultContext`)
    const auth: ServerDefaultContextLike["auth"] = options.auth ?? { identity: null, userId: null };

    /**
     * Append a post-image to the changelog when CDC is enabled; a no-op
     * otherwise. Like the aggregate/rank/search companion writes on this
     * backend, the append is a separate statement after the row write (D1 has
     * no multi-statement transaction here), so a crash between the two can leave
     * a committed write without its changelog entry — the same at-least-once
     * companion caveat the other D1 sync hooks carry. The DO backend appends
     * inside the row write's transaction and so is atomic.
     */
    const recordCdc = async (table: string, id: string, op: CdcChange["op"], doc?: Record<string, unknown>): Promise<void> => {
        if (!cdcEnabled) {
            return;
        }

        await appendSqlCdcChange(exec, clock(), table, id, op, doc, dialect);

        if (cdcRetentionMs === undefined) {
            return;
        }

        const now = clock();

        // Per-isolate throttle before the fleet-wide lease: the lease is a write,
        // and attempting it on every changelog append would double this path's
        // cost. See {@link CDC_SWEEP_ATTEMPT_MS}.
        if (now - lastSweepAttemptAt < CDC_SWEEP_ATTEMPT_MS) {
            return;
        }

        lastSweepAttemptAt = now;

        try {
            await sweepSqlCdcRetention(exec, dialect, cdcRetentionMs, now);
        } catch {
            // Retention is maintenance. A failed sweep must never surface on a
            // write whose row and changelog entry have already committed — the
            // log simply stays larger until a later pass claims the lease.
        }
    };
    const scheduler = options.scheduler ?? throwingScheduler;

    // Per-ctx-db LRU bounding the `id → tableName` resolution cost. See
    // {@link createTableNameCache} for the size cap rationale.
    const tableNameCache = createTableNameCache();

    let triggerDepth = 0;

    // Memoized companion-DDL guard. In production NOTHING outside this ctx-db
    // calls the `runD1*Migrations` helpers (they're exported for tests/dev
    // hosts), so without this every search write would hit a non-existent fts5
    // shadow table ("no such table") and every aggregate/rank read would fall
    // back to a scan. We run all three CREATE-IF-NOT-EXISTS migrations exactly
    // once per ctx-db, lazily, before any path that can touch a companion. The
    // cached value is the resolving `Promise` so concurrent first-callers share
    // the single round-trip rather than racing duplicate DDL (mirrors the
    // dialect's fts5 flag). CREATE IF NOT EXISTS is idempotent, so running it
    // once per instance is cheap.
    let migratedPromise: Promise<void> | undefined;

    const ensureMigrated = async (): Promise<void> => {
        migratedPromise ??= (async (): Promise<void> => {
            // Base `.global()` tables first — the companion migrations below and
            // every read/write path assume they exist.
            await runSqlGlobalTableMigrations(exec, schema, dialect);
            await runSqlAggregateMigrations(exec, schema, dialect);
            await runSqlRankMigrations(exec, schema, dialect);
            // The search companions record their backfill progress, so the state
            // table has to exist before the first page runs.
            await migrateSearchState(exec, dialect);
            await runSqlSearchMigrations(exec, schema, dialect);

            if (cdcEnabled) {
                await runSqlCdcMigration(exec, dialect);
            }
        })().catch((error: unknown) => {
            // Don't cache a rejection — a transient DDL failure (e.g. a dropped
            // connection) would otherwise poison every later call on this
            // ctx-db. Clear the cache so the next call retries the idempotent
            // CREATE-IF-NOT-EXISTS migrations.
            migratedPromise = undefined;
            throw error;
        });

        return migratedPromise;
    };

    /**
     * Resolve the table an `id` belongs to — the single choke-point for the
     * id-addressed ops (`get`/`patch`/`replace`/`delete`). Provisioning runs
     * first (memoized), so the per-table probe always hits existing tables: the
     * tables are a hard precondition, not a maybe, which is why `tableNameFromId`
     * needs no missing-table handling.
     */
    const resolveTableName = async (id: string, expectedTable?: string): Promise<string | undefined> => {
        await ensureMigrated();

        const tableName = await tableNameFromId(exec, dialect, schema, id, tableNameCache);

        // When the caller pins a table (the `ctx.db.<table>.get/delete/...`
        // by-id facade forwards its bound name), an id that resolves to a
        // different table is treated as absent — a foreign id can never read or
        // mutate cross-table through a branded `Id<"posts">` (IDOR).
        if (expectedTable !== undefined && tableName !== expectedTable) {
            return undefined;
        }

        return tableName;
    };

    // Per-(table, index) backfill state. The map records the outcome of the
    // probe: `true` once the counter companion table was found and rebuilt;
    // `false` once we've checked and the user hasn't materialized it, so we
    // know to skip the indexed path on every subsequent read for this ctx-db.
    const backfilled = new Map<string, boolean>();

    /**
     * Whether `table` has a corresponding `__agg_<index>` companion table on
     * the D1 binding. Global tables ship with their own DDL — counter tables
     * are opt-in: if the user hasn't defined one, we silently fall back to a
     * SCAN-based count. The same opt-in shape is what `runSqlAggregateMigrations`
     * (the helper exported for tests/dev hosts) uses to materialize it.
     */
    const counterTableExists = async (table: string, indexName: string): Promise<boolean> => {
        const aggTable = aggregateTableName(table, indexName);
        const rows = await queryAll(exec, dialect, dialect.tableExists(aggTable));

        return rows.length > 0;
    };

    /**
     * Rebuild a counter from a paged table scan. Cheap to call (cache-guarded);
     * idempotent — TRUNCATE then re-tally so a previously-skewed counter heals.
     * Pages via a keyset cursor on `id` (the table's primary key) with a fixed
     * batch size, so a large global table never has to fit in a single result
     * buffer.
     */
    const ensureBackfilled = async (tableName: string, index: AggregateIndexDefinitionLike): Promise<boolean> => {
        const cacheKey = `${tableName}::${index.name}`;
        const cached = backfilled.get(cacheKey);

        if (cached !== undefined) {
            return cached;
        }

        const exists = await counterTableExists(tableName, index.name);

        if (!exists) {
            backfilled.set(cacheKey, false);

            return false;
        }

        const definition = schema.tables[tableName];

        if (!definition) {
            backfilled.set(cacheKey, false);

            return false;
        }

        const by = index.by ?? [];
        const tallies = new Map<string, AggregateTally>();

        // Keyset pagination on `id` — tallies accumulate incrementally so the
        // memory footprint is `unique(by)` keys, not row count. The fold is
        // op-aware (sum/avg accumulate the running sum, min/max the extreme),
        // mirroring the DO backfill.
        await forEachRowPaged(exec, dialect, definition, tableName, (document) => {
            if (index.where && !matchesStaticWhere(document, index.where)) {
                return;
            }

            const encoded = encodeAggregateKey(by, document);

            foldAggregateTally(tallies, encoded, index, document);
        });

        const aggTable = aggregateTableName(tableName, index.name);

        await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(aggTable)}`);

        const inserts: SQL[] = [];

        for (const [encoded, tally] of tallies) {
            inserts.push(
                sql`INSERT INTO ${sql.identifier(aggTable)} (${sql.identifier("__key__")}, ${sql.identifier("__value__")}, ${sql.identifier("__count__")}) VALUES (${encoded}, ${tally.value}, ${tally.count})`,
            );
        }

        // One round trip for the whole backfill when the exec exposes `batch`
        // (rows are keyed by distinct `__key__`, so order across them doesn't
        // matter); a sequential `run()` loop otherwise.
        await queryBatch(exec, dialect, inserts);

        backfilled.set(cacheKey, true);

        return true;
    };

    /**
     * Recompute a min/max group's extreme from the source table, scoped to the
     * group's `by`-tuple and the index's static `where`, against the D1 column
     * dialect. Runs AFTER the physical row write, so it sees the post-write
     * source and returns the surviving extreme (`null` when none survives). The
     * caller pins `__count__` from its own tracked tally.
     *
     * A `bigint` is stored as the order-preserving key {@link bigintSqlKey}
     * builds, and `MIN`/`MAX` over that hands back padded text whose `Number()`
     * is `1e+39` for a group whose real extreme is `900`. The reader refuses that
     * coercion on its own scan ({@link assertReducibleBySql}), but this is the
     * write path: refusing here would break `delete`. So a column that may hold
     * one is reduced in JS off the decoded rows instead — through
     * {@link foldAggregateTally}, the same fold both backfills seed a group with,
     * so a recomputed extreme cannot disagree with a rebuilt one.
     *
     * Not `ORDER BY <col> LIMIT 1` either: the key is order-preserving only
     * against other keys, and SQLite orders every TEXT after every numeric — so
     * on a mixed `v.any()` column the extreme would be decided by storage class
     * rather than by magnitude.
     */
    const recomputeExtreme = async (tableName: string, index: AggregateIndexDefinitionLike, document: Record<string, unknown>): Promise<null | number> => {
        const field = index.field ?? "";
        const conditions: SQL[] = [];

        for (const key of index.by ?? []) {
            // eslint-disable-next-line unicorn/no-null -- canonical key tuple: a missing by-field is matched as NULL, mirroring encodeAggregateKey's null-fill
            const value = serializeColumnValue(document[key] ?? null);

            conditions.push(value === null ? sql`${columnRefSql(key)} IS NULL` : sql`${columnRefSql(key)} = ${value}`);
        }

        for (const [key, expected] of Object.entries(index.where ?? {})) {
            const literal = expected !== null && typeof expected === "object" && !Array.isArray(expected) ? (expected as { eq: unknown }).eq : expected;
            const value = serializeColumnValue(literal);

            conditions.push(value === null ? sql`${columnRefSql(key)} IS NULL` : sql`${columnRefSql(key)} = ${value}`);
        }

        const whereSql = conditions.length > 0 ? sql` WHERE ${sql.join(conditions, sql` AND `)}` : sql``;
        const definition = schema.tables[tableName];

        if (definition && mayHoldBigintKey(definition.shape[field])) {
            // Just the reduced column — the fold reads nothing else, and this
            // runs inside a request against a remote engine. `decodeRow` skips
            // the columns the projection left out.
            const rows = await queryAll(exec, dialect, sql`SELECT ${columnRefSql(field)} FROM ${sql.identifier(tableName)}${whereSql}`);
            // The canonical reducer, not a second copy of it. Single-group, so
            // the key is the empty string and only `value` is read — the caller
            // pins `__count__` from its own tracked tally.
            const tallies = new Map<string, AggregateTally>();

            for (const decoded of decodeRows(definition, rows)) {
                foldAggregateTally(tallies, "", index, decoded);
            }

            // eslint-disable-next-line unicorn/no-null -- an extreme-less group stores NULL, matching what both backfills seed
            return tallies.get("")?.value ?? null;
        }

        const sqlFunction = aggregateSqlFunction(index.op);
        const rows = await queryAll(
            exec,
            dialect,
            sql`SELECT ${sql.raw(sqlFunction)}(${columnRefSql(field)}) AS ${sql.identifier("value")} FROM ${sql.identifier(tableName)}${whereSql}`,
        );

        return aggregateScalar(rows[0]?.["value"]);
    };

    /**
     * Drop a companion group row whose last contributing source row was just
     * removed. An emptied group must be ABSENT (not a zeroed row): the indexed
     * `groupBy` walk enumerates every companion row, so a leftover zeroed row
     * (value `null`/0, count 0) would surface a phantom group a SQL `GROUP BY`
     * omits. We trigger strictly on a non-positive `__count__` — never on a zero value,
     * since a `sum` can legitimately be 0 with rows present. A scalar
     * `aggregate()`/`count()` reads an absent key as null/0, identical to the
     * zeroed row it replaces, so removing it keeps those paths correct.
     */
    const pruneEmptyGroup = async (aggTable: string, encoded: string): Promise<void> => {
        await queryRun(
            exec,
            dialect,
            sql`DELETE FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded} AND ${sql.identifier("__count__")} <= 0`,
        );
    };

    /**
     * Op-aware companion maintenance for a single index, against the D1 column
     * dialect. Mirrors the DO `applyAggregateDelta`: count/sum/avg step
     * `__value__`/`__count__` directly; min/max bump cheaply on the add side and
     * recompute from the source when the stored extreme leaves or the group
     * empties. An update is remove-old then add-new. Companion maintenance runs
     * after the physical row write, so the recompute sees the post-write source.
     */
    /* eslint-disable sonarjs/cognitive-complexity -- op-aware (count/sum/avg/min/max) maintenance over remove-old + add-new branches; splitting it would scatter the single companion-row update across helpers and read worse */
    const applyAggregateDelta = async (
        tableName: string,
        index: AggregateIndexDefinitionLike,
        previous: Record<string, unknown> | undefined,
        next: Record<string, unknown> | undefined,
    ): Promise<void> => {
        const aggTable = aggregateTableName(tableName, index.name);
        const { op } = index;
        const field = index.field ?? "";

        const removes = previous && (!index.where || matchesStaticWhere(previous, index.where)) ? previous : undefined;
        const adds = next && (!index.where || matchesStaticWhere(next, index.where)) ? next : undefined;

        if (!removes && !adds) {
            return;
        }

        if (op === "count" || op === "sum" || op === "avg") {
            // Track the group keys we touched so an emptied group can be pruned
            // (a `by`-changing update steps both the removes and the adds key;
            // only the removes side can reach `__count__ <= 0`).
            const touched = new Set<string>();

            for (const [document, sign] of [
                [removes, -1],
                [adds, 1],
            ] as const) {
                if (!document) {
                    continue;
                }

                // count steps `__value__` by ±1; sum/avg step it by the row's
                // numeric field value (skipping rows without one).
                const numeric = op === "count" ? 1 : coerceAggregateNumber(document[field]);

                if (numeric === undefined) {
                    continue;
                }

                const encoded = encodeAggregateKey(index.by ?? [], document);

                touched.add(encoded);

                // eslint-disable-next-line no-await-in-loop -- sequential counter step on the shared connection
                await queryRun(
                    exec,
                    dialect,
                    upsertSql({
                        columns: ["__key__", "__value__", "__count__"],
                        conflictKey: "__key__",
                        set: (excluded, current) => {
                            return {
                                __count__: sql`${current("__count__")} + ${excluded("__count__")}`,
                                // count's `__value__` is never NULL (seeded with the
                                // delta); a sum/avg group seeded by a valueless row can
                                // be, hence the COALESCE on that side only.
                                __value__:
                                    op === "count"
                                        ? sql`${current("__value__")} + ${excluded("__value__")}`
                                        : sql`COALESCE(${current("__value__")}, 0) + ${excluded("__value__")}`,
                            };
                        },
                        table: aggTable,
                        values: [encoded, sign * numeric, sign],
                    }),
                );
            }

            for (const encoded of touched) {
                // eslint-disable-next-line no-await-in-loop -- sequential prune on the shared connection (see above).
                await pruneEmptyGroup(aggTable, encoded);
            }

            return;
        }

        // min/max.
        if (removes) {
            const encoded = encodeAggregateKey(index.by ?? [], removes);
            const removedValue = coerceAggregateNumber(removes[field]);
            const existingRows = await queryAll(
                exec,
                dialect,
                sql`SELECT ${sql.identifier("__value__")} AS ${sql.identifier("value")}, ${sql.identifier("__count__")} AS ${sql.identifier("count")} FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded}`,
            );
            const existing = existingRows[0] as { count: number; value: null | number } | undefined;
            const existingValue = aggregateScalar(existing?.value);
            const remainingCount = (existing?.count ?? 0) - 1;

            if (remainingCount <= 0) {
                // Last contributing row left: remove the group row entirely so
                // the indexed `groupBy` walk omits it (a zeroed row would surface
                // a phantom group a SQL `GROUP BY` skips). Scalar `aggregate()`
                // reads an absent min/max group as null, same as the prior NULL
                // row, so this stays correct.
                await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded}`);
            } else if (existing && removedValue !== undefined && existingValue !== null && removedValue === existingValue) {
                const recomputed = await recomputeExtreme(tableName, index, removes);

                await queryRun(
                    exec,
                    dialect,
                    sql`UPDATE ${sql.identifier(aggTable)} SET ${sql.identifier("__value__")} = ${recomputed}, ${sql.identifier("__count__")} = ${remainingCount} WHERE ${sql.identifier("__key__")} = ${encoded}`,
                );
            } else {
                await queryRun(
                    exec,
                    dialect,
                    sql`UPDATE ${sql.identifier(aggTable)} SET ${sql.identifier("__count__")} = ${sql.identifier("__count__")} - 1 WHERE ${sql.identifier("__key__")} = ${encoded}`,
                );
            }
        }

        if (adds) {
            const encoded = encodeAggregateKey(index.by ?? [], adds);
            const addedValue = coerceAggregateNumber(adds[field]);

            if (addedValue === undefined) {
                await queryRun(
                    exec,
                    dialect,
                    upsertSql({
                        columns: ["__key__", "__value__", "__count__"],
                        conflictKey: "__key__",
                        set: (_excluded, current) => {
                            return { __count__: sql`${current("__count__")} + 1` };
                        },
                        table: aggTable,
                        // eslint-disable-next-line unicorn/no-null -- seeds an extreme-less group with NULL value; the literal 1 seeds the count
                        values: [encoded, null, 1],
                    }),
                );
            } else {
                const op2 = op === "min" ? "MIN" : "MAX";

                await queryRun(
                    exec,
                    dialect,
                    upsertSql({
                        columns: ["__key__", "__value__", "__count__"],
                        conflictKey: "__key__",
                        set: (excluded, current) => {
                            return {
                                __count__: sql`${current("__count__")} + 1`,
                                __value__: sql`${sql.raw(op2)}(COALESCE(${current("__value__")}, ${excluded("__value__")}), ${excluded("__value__")})`,
                            };
                        },
                        table: aggTable,
                        values: [encoded, addedValue, 1],
                    }),
                );
            }
        }
    };
    /* eslint-enable sonarjs/cognitive-complexity */

    /** Pre-write hook: rebuild counters once per ctx-db before the row mutation. */
    const ensureBackfilledForTable = async (tableName: string): Promise<void> => {
        const indexes = schema.tables[tableName]?.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            // eslint-disable-next-line no-await-in-loop -- backfills run sequentially on the single shared D1 connection to avoid interleaving DELETE/INSERT statements.
            await ensureBackfilled(tableName, index);
        }
    };

    /** Post-write hook: apply `-prev + next` step for every declared counter. */
    const syncAggregates = async (
        tableName: string,
        previous: Record<string, unknown> | undefined,
        next: Record<string, unknown> | undefined,
    ): Promise<void> => {
        const indexes = schema.tables[tableName]?.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            // Skip when the user hasn't materialized the counter companion
            // table — the SCAN fallback still answers correctly. The pre-write
            // `ensureBackfilledForTable` hook always runs immediately before
            // this sync (see insert/patch/replace/delete), populating
            // `backfilled` with the authoritative existence answer under the
            // same cache key. Read that instead of re-probing `sqlite_master`
            // on the hot path; fall back to a fresh probe only on a Map miss.
            const cacheKey = `${tableName}::${index.name}`;
            const cached = backfilled.get(cacheKey);
            // eslint-disable-next-line no-await-in-loop -- probe runs only on a cache miss, sequentially on the single shared D1 connection so the -prev/+next writes don't interleave across indexes.
            const exists = cached ?? (await counterTableExists(tableName, index.name));

            if (!exists) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- op-aware step runs sequentially on the shared D1 connection (see above).
            await applyAggregateDelta(tableName, index, previous, next);
        }
    };

    // Per-(table, rankIndex) backfill state, same shape as aggregate
    // counters. `true` ⇒ companion exists and has been rebuilt; `false` ⇒
    // companion missing (skip indexed path forever for this ctx-db).
    const rankBackfilled = new Map<string, boolean>();

    const rankTableExists = async (table: string, indexName: string): Promise<boolean> => {
        const rankTable = rankTableName(table, indexName);
        const rows = await queryAll(exec, dialect, dialect.tableExists(rankTable));

        return rows.length > 0;
    };

    /**
     * Lazy backfill of a rank companion. Mirrors the aggregate counter twin —
     * `ensureBackfilled`. TRUNCATE then re-insert; cached per ctx-db.
     *
     * Bounded end to end, not just on the read: the source table is paged by
     * keyset cursor on `id`, and the tuples that page produces are flushed
     * before the next one is read, so neither the buffered `SQL` objects nor the
     * dispatched batch ever grows to the row count.
     */
    const ensureRankBackfilled = async (tableName: string, index: RankIndexDefinitionLike): Promise<boolean> => {
        const cacheKey = `${tableName}::rank::${index.name}`;
        const cached = rankBackfilled.get(cacheKey);

        if (cached !== undefined) {
            return cached;
        }

        const exists = await rankTableExists(tableName, index.name);

        if (!exists) {
            rankBackfilled.set(cacheKey, false);

            return false;
        }

        const definition = schema.tables[tableName];

        if (!definition) {
            rankBackfilled.set(cacheKey, false);

            return false;
        }

        const rankTable = rankTableName(tableName, index.name);

        await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(rankTable)}`);

        const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
        const insertColumnList = identifierList(["__id__", "__partition__", ...sortColumns]);

        // One INSERT per source row, flushed a page at a time. The aggregate
        // twin buffers its whole insert list because that list is `unique(by)`
        // keys, not rows; a rank tuple is per ROW, so buffering the same way put
        // the entire table — plus one drizzle `SQL` object per row — in the
        // isolate and handed the engine an N-statement batch, on a path that
        // runs lazily inside a request (every first write, and every first
        // `rank()`/`rankPage()`, against a table with a declared rankIndex).
        //
        // `forEachRowPaged` awaits an async `onDoc`, so the flush happens from
        // inside the walk: the writes go to the companion table while the walk
        // pages the source, and the peak is one page of tuples either way.
        let pending: SQL[] = [];

        const flush = async (): Promise<void> => {
            if (pending.length === 0) {
                return;
            }

            const batch = pending;

            pending = [];

            // Rows are keyed by distinct `__id__`, so order across a batch
            // doesn't matter; a `run()`-per-statement loop when the exec has no
            // `batch` seam.
            await queryBatch(exec, dialect, batch);
        };

        await forEachRowPaged(exec, dialect, definition, tableName, async (document) => {
            if (index.where && !matchesRankStaticWhere(document, index.where)) {
                return;
            }

            const partitionKey = encodePartitionKey(index.partitionBy ?? [], document);
            // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent sort-key column must bind `null`, not undefined.
            const sortValues = index.sortBy.map((key) => serializeColumnValue(document[key.field] ?? null));

            pending.push(
                sql`INSERT INTO ${sql.identifier(rankTable)} (${insertColumnList}) VALUES (${bindList([document["_id"], partitionKey, ...sortValues])})`,
            );

            if (pending.length >= BACKFILL_BATCH_SIZE) {
                await flush();
            }
        });

        await flush();

        rankBackfilled.set(cacheKey, true);

        return true;
    };

    /** Pre-write hook: rebuild rank companions once per ctx-db. */
    const ensureRankBackfilledForTable = async (tableName: string): Promise<void> => {
        const indexes = schema.tables[tableName]?.rankIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
            // eslint-disable-next-line no-await-in-loop -- rank backfills run sequentially on the single shared D1 connection to avoid interleaving DELETE/INSERT statements.
            await ensureRankBackfilled(tableName, index);
        }
    };

    /**
     * Post-write hook: DELETE+INSERT keeps the companion in lockstep with the
     * source row. Skips silently when the user hasn't materialized the
     * companion (the SCAN-free rank path will be unavailable, but the data
     * remains correct).
     */
    const syncRanks = async (
        tableName: string,
        id: string,
        previous: Record<string, unknown> | undefined,
        next: Record<string, unknown> | undefined,
        // eslint-disable-next-line sonarjs/cognitive-complexity -- rank companion sync: fast-path + soft-delete + per-index branches are inherent
    ): Promise<void> => {
        const definition = schema.tables[tableName];
        const indexes = definition?.rankIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        // A soft-deleted `next` row must never (re-)enter the rank companion:
        // `delete()`'s soft path drops the entry, and any later write into the
        // still-deleted row (admin fix-up, `$onUpdateFn` stamp, `onSetNull`
        // cascade) must not resurrect it into `rank()`/`rankPage()`. `restore()`
        // clears the marker *before* re-adding, so its INSERT still runs.
        /* eslint-disable @typescript-eslint/no-unnecessary-condition -- the schema type over-narrows softDeleteMode; this guard defends the real runtime shape */
        const softField = definition?.softDeleteMode?.field;
        const nextFieldValue = softField === undefined || next === undefined ? undefined : next[softField];
        const nextSoftDeleted = nextFieldValue !== null && nextFieldValue !== undefined;
        /* eslint-enable @typescript-eslint/no-unnecessary-condition */

        for (const index of indexes) {
            // Fast path: both images exist and no field THIS index reads
            // (partition / sort / static `where`) changed — the companion entry
            // is already correct, so skip the DELETE+INSERT pair entirely
            // (mirrors the DO twin). Besides the write saving, this is what makes
            // `restore()`'s forced re-add correct (a marker-clearing patch leaves
            // every rank field unchanged, so the patch-path sync skips and the
            // forced `restore()` INSERT is the sole re-add — no duplicate PK).
            if (previous !== undefined && next !== undefined && rankIndexFieldsUnchanged(index, previous, next)) {
                continue;
            }

            // eslint-disable-next-line no-secrets/no-secrets -- false positive: this is a function name referenced in a comment, not a secret.
            // The pre-write `ensureRankBackfilledForTable` hook always runs
            // immediately before this sync, populating `rankBackfilled` with
            // the authoritative existence answer under the same cache key.
            // Read that instead of re-probing `sqlite_master` on the hot path;
            // fall back to a fresh probe only on a Map miss.
            const cacheKey = `${tableName}::rank::${index.name}`;
            const cached = rankBackfilled.get(cacheKey);
            // eslint-disable-next-line no-await-in-loop -- probe runs only on a cache miss, sequentially on the single shared D1 connection so DELETE/INSERT pairs don't interleave across indexes.
            const exists = cached ?? (await rankTableExists(tableName, index.name));

            if (!exists) {
                continue;
            }

            const rankTable = rankTableName(tableName, index.name);

            if (previous) {
                // eslint-disable-next-line no-await-in-loop -- sequential companion DELETE on the shared D1 connection (see above).
                await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(rankTable)} WHERE ${sql.identifier("__id__")} = ${id}`);
            }

            if (next && !nextSoftDeleted) {
                if (index.where && !matchesRankStaticWhere(next, index.where)) {
                    continue;
                }

                const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
                const columnList = identifierList(["__id__", "__partition__", ...sortColumns]);
                const partitionKey = encodePartitionKey(index.partitionBy ?? [], next);
                // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent sort-key column must bind `null`, not undefined.
                const sortValues = index.sortBy.map((key) => serializeColumnValue(next[key.field] ?? null));

                // eslint-disable-next-line no-await-in-loop -- sequential companion INSERT on the shared D1 connection (see above).
                await queryRun(
                    exec,
                    dialect,
                    sql`INSERT INTO ${sql.identifier(rankTable)} (${columnList}) VALUES (${bindList([id, partitionKey, ...sortValues])})`,
                );
            }
        }
    };

    // Search companions (fts5 shadow or portable inverted table) are maintained
    // by `ctx-db-search`, which owns both layouts; the writer only needs the
    // hook.
    const syncSearch = createSearchSync({ dialect, exec, schema });

    /**
     * Precomputed `(table → timing → op)` matcher: matches the DO ctx-db
     * fast-path so writer methods can skip the `await fireTriggers(...)`
     * microtask when no trigger is declared for the (timing, op).
     */
    const triggerMatchers = new Set<string>();

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        for (const trigger of Object.values(definition.triggerMap ?? {})) {
            triggerMatchers.add(`${tableName} ${trigger.timing} ${trigger.op}`);
        }
    }

    const hasMatchingTrigger = (tableName: string, timing: TriggerTimingLike, op: TriggerOpLike): boolean =>
        triggerMatchers.has(`${tableName} ${timing} ${op}`);

    // Forward-declared here so `fireTriggers` (defined below) can close over it;
    // assigned only after `writer` is built. It is read solely while a write is
    // in flight — long after construction finishes — so the binding is always
    // initialized by the time a trigger fires.
    let triggerContext: TriggerContextLike;

    /** Fire matching triggers with a depth guard against runaway self-triggering. */
    const fireTriggers = async (timing: TriggerTimingLike, op: TriggerOpLike, event: TriggerEventLike): Promise<void> => {
        triggerDepth += 1;

        if (triggerDepth > MAX_TRIGGER_DEPTH) {
            triggerDepth -= 1;

            throw new ConflictError(
                `trigger recursion exceeded ${String(MAX_TRIGGER_DEPTH)} levels on "${event.table}" — check for a self-triggering write`,
                "trigger",
            );
        }

        try {
            // `triggerCtx` is declared after `writer` (further below) but is only
            // read here, while a write is in flight — long after construction has
            // initialized the binding. Referencing it lazily keeps `fireTriggers`
            // defined before `writer` without a forward use-before-define.
            await runTriggers({ ctx: triggerContext, event, op, schema, tableName: event.table, timing });
        } finally {
            triggerDepth -= 1;
        }
    };

    /**
     * Run a write, remapping a UNIQUE-index breach to a {@link ConflictError}
     * (code `CONFLICT`, 409).
     */
    const runWrite = async (table: string, query: SQL): Promise<void> => {
        try {
            await queryRun(exec, dialect, query);
        } catch (error) {
            mapWriteError(dialect, error, table);
        }
    };

    /**
     * Snapshot the RAW stored row (physical column values, not decoded into a
     * document) for `id` in `tableName`. Captured BEFORE a write's before-
     * trigger / onDelete-cascade `await` window so the optimistic-concurrency
     * CAS can compare stored-value to stored-value. Returns `undefined` when the
     * row is gone.
     */
    const rawRow = async (tableName: string, id: string): Promise<Record<string, unknown> | undefined> => {
        const rows = await queryAll(exec, dialect, sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${sql.identifier("id")} = ${id}`);

        return rows[0];
    };

    /**
     * Run an optimistic-concurrency-guarded write — the D1 twin of the DO
     * dialect's `runGuardedWrite`. D1 stores rows as real columns (no `__doc__`
     * blob) and `SqlCtxExec.run` returns no rows-affected count, so the CAS is
     * expressed as `WHERE "id" IS ? AND "_version" IS ? ... RETURNING "id"` run
     * via `exec.all` (both D1 and node:sqlite support `RETURNING`). The bound
     * values are the RAW column values captured at read time ({@link rawRow});
     * `IS` gives NULL-safe equality, which is what makes a row written before
     * {@link OCC_VERSION_COLUMN} existed (version `NULL`) still guardable. An
     * empty RETURNING set means a concurrent write committed during the
     * intervening `await` and changed the row — surfaced as a
     * {@link ConflictError}.
     *
     * The guard binds TWO parameters at any table width. Comparing every
     * physical column instead — which is what this did — cost `2N+2` parameters
     * on an `UPDATE` and blew D1's 100-per-statement ceiling from 50 declared
     * fields up, so a table that provisioned and inserted fine lost every update
     * to a redacted "Internal error". The version bump rides in the `SET` list
     * as `COALESCE("_version", 0) + 1`, an expression rather than a bound value,
     * so it costs nothing against that budget either.
     *
     * Bumping on every guarded write also gives MySQL a real affected-rows
     * signal: a `patch` that writes back identical field values would otherwise
     * report 0 rows changed and read as a phantom conflict.
     *
     * `snapshot` of `undefined` means there was nothing on disk at read time
     * (only happens on the delete path when the row was already gone); the
     * guard is skipped because there is no write to perform.
     */
    const runGuardedWrite = async (
        table: string,
        verb: "DELETE" | "UPDATE",
        setClause: SQL | undefined,
        snapshot: Record<string, unknown> | undefined,
    ): Promise<void> => {
        if (snapshot === undefined) {
            return;
        }

        const versionRef = sql`${sql.identifier(OCC_VERSION_COLUMN)}`;
        const guardClause = sql.join(
            [
                nullSafeEquals(sql`${sql.identifier("id")}`, snapshot["id"]),
                // eslint-disable-next-line unicorn/no-null -- SQL bind value: `?? null` so a row written before this column existed (or a driver that omits it) compares against SQL NULL.
                nullSafeEquals(versionRef, snapshot[OCC_VERSION_COLUMN] ?? null),
            ],
            sql` AND `,
        );
        const base =
            verb === "UPDATE"
                ? sql`UPDATE ${sql.identifier(table)} SET ${setClause}, ${versionRef} = COALESCE(${versionRef}, 0) + 1 WHERE ${guardClause}`
                : sql`DELETE FROM ${sql.identifier(table)} WHERE ${guardClause}`;

        const occConflict = (): never => {
            throw new ConflictError(`optimistic concurrency conflict on "${table}" — the row changed during this mutation; refetch and retry`, "occ");
        };

        try {
            if (dialect.supportsReturning) {
                // SQLite/Postgres: a `RETURNING "id"` row proves the CAS matched;
                // an empty set means a concurrent write changed the row.
                const returned = await queryAll(exec, dialect, sql`${base} RETURNING ${sql.identifier("id")}`);

                if (returned.length === 0) {
                    occConflict();
                }
            } else {
                // MySQL: no RETURNING — the affected-row count is the CAS signal.
                const result = await queryRun(exec, dialect, base);
                const affected = dialect.affectedRows ? dialect.affectedRows(result ?? { rowsAffected: 0 }) : 0;

                if (affected === 0) {
                    occConflict();
                }
            }
        } catch (error) {
            mapWriteError(dialect, error, table);
        }
    };

    /** Serialize a document into the ordered `[id, _creationTime, ...fields]` column tuple. */
    const columnTuple = (
        definition: TableDefinitionLike,
        id: string,
        creationTime: number,
        document: Record<string, unknown>,
    ): { columns: string[]; values: unknown[] } => {
        const fields = Object.keys(definition.shape);

        return {
            // Raw (unquoted) column names — the INSERT quotes them via `sql.identifier`.
            columns: ["id", "_creationTime", ...fields],
            // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent column must bind `null`, not undefined.
            values: [id, creationTime, ...fields.map((field) => serializeColumnValue(document[field] ?? null))],
        };
    };

    /**
     * Indexed groupBy fast-path: when an aggregateIndex's `by` matches the
     * request, every group answer is already in the reducer-aware `__agg_`
     * companion — read each group's `__value__`/`__count__` and project via
     * `readAggregateValue`. Covers every op (count/sum/avg/min/max). Returns the
     * group entries, or `undefined` to signal "fall through to the SQL
     * `GROUP BY` scan" (no matching index, or its counter isn't built).
     */
    const tryIndexedGroupBy = async (
        tableName: string,
        aggregateIndexes: ReadonlyArray<AggregateIndexDefinitionLike>,
        agg: NonNullable<GroupByOptions["agg"]>,
        groupOptions: GroupByOptions,
    ): Promise<GroupByEntry[] | undefined> => {
        const planned = selectIndexForGroupBy(aggregateIndexes, agg.op, agg.field, groupOptions.by, groupOptions.where);

        if (!planned) {
            return undefined;
        }

        const counterReady = await ensureBackfilled(tableName, planned.index);

        if (!counterReady) {
            return undefined;
        }

        const aggTable = aggregateTableName(tableName, planned.index.name);
        const partialKeys = Object.keys(planned.partial);

        // Fully-specified group key → at most one companion row.
        if (partialKeys.length === (planned.index.by ?? []).length && partialKeys.length > 0) {
            const encoded = encodeAggregateKey(planned.index.by ?? [], planned.partial);
            const rowsIndexed = await queryAll(
                exec,
                dialect,
                sql`SELECT ${sql.identifier("__value__")} AS ${sql.identifier("value")}, ${sql.identifier("__count__")} AS ${sql.identifier("count")} FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded}`,
            );

            if (rowsIndexed.length === 0) {
                return [];
            }

            const row = rowsIndexed[0] as { count: number; value: null | number };

            return [{ key: { ...planned.partial }, value: readAggregateValue(agg.op, { count: row.count, value: aggregateScalar(row.value) }) }];
        }

        // A partially-constraining request (`where` pins a strict subset of the
        // index's `by`-tuple → `partialKeys.length > 0` but not the full length,
        // since the fully-specified case returned above) can't be answered by
        // enumerating the whole companion: that would leak the groups the `where`
        // filters out (indexed/scan divergence). Fall back to the SQL `GROUP BY`
        // scan, which compiles and honours the `where`. The static-`where`-carry
        // case (a partial key sourced from the index's own baked-in `where`, on a
        // field the request never mentioned) also falls back here — the companion
        // is scoped to that value, so it likewise can't answer an unfiltered
        // request over it; the scan is the correct, complete answer either way.
        if (partialKeys.length > 0) {
            return undefined;
        }

        // Fully open group key (no constraint) → enumerate every companion row.
        const rowsIndexed = await queryAll(
            exec,
            dialect,
            sql`SELECT ${sql.identifier("__key__")} AS ${sql.identifier("key")}, ${sql.identifier("__value__")} AS ${sql.identifier("value")}, ${sql.identifier("__count__")} AS ${sql.identifier("count")} FROM ${sql.identifier(aggTable)}`,
        );

        return rowsIndexed.map((row) => {
            const typed = row as { count: number; key: string; value: null | number };

            return {
                // `encodeAggregateKey` writes `JSON.stringify(encodeWire(ordered))`,
                // so a bare `JSON.parse` hands back the wire-tagged ARRAY rather
                // than the value — a `v.bigint()` group key came out as
                // `["$lunora.wire$","bigint","42"]`. The shard twin decodes it;
                // this side did not, so one query returned different key shapes
                // depending on backend and index materialisation.
                key: decodeWire(JSON.parse(typed.key)) as Record<string, unknown>,
                value: readAggregateValue(agg.op, { count: typed.count, value: aggregateScalar(typed.value) }),
            };
        });
    };

    /**
     * Is `childTable` an explicitly shard-local relation target (`.shardBy()` or
     * root)? Such children live across every shard DO, so a `.global()` parent
     * can only load them via the injected cross-shard reader. `global`/undefined
     * children stay on the local D1 writer (same-backend / forward direction).
     */
    const isShardLocalTarget = (childTable: string): boolean => {
        const kind = schema.tables[childTable]?.shardMode?.kind;

        return kind === "shardBy" || kind === "root";
    };

    const crossBackendUnsupported = (childTable: string): never => {
        throw new LunoraError(
            "INTERNAL",
            `cross-backend relation: a global table cannot load the shard-local relation '${childTable}' (it spans every shard) — wire a cross-shard reader to support it`,
        );
    };

    /**
     * SECURITY (RLS across the fan-out): the cross-shard hop is a JSON envelope,
     * so the two carriers the relation loader uses to enforce the CHILD table's
     * read policy can't ride along as-is — and dropping them silently returns
     * every child row for the FK, since the serving shard reads through its RAW
     * ctx-db. Convert both to data (see {@link CrossShardReadArgs}):
     *
     * - `baseWhere` (this hop's policy filter) is ANDed into `where`.
     * - `relationBaseWhere` (a function, for NESTED `with` levels) is projected
     *   into a table → filter map. Projecting every schema table is cheaper than
     *   walking the `with` tree and can't miss a hop; `readBase` is memoized
     *   upstream, and tables with no restricting policy simply don't appear.
     *
     * `relationMask` has the same problem and NO such projection: a mask policy
     * isn't serializable (a custom `MaskFn` is a closure over the request, and
     * `"hash"` needs the caller context). THIS hop's own rows are still masked —
     * the relation loader applies the mask to whatever the fetcher returns — but a
     * nested `with` is hydrated on the serving shard, past the mask's reach. So a
     * masked read that would cross with nested relations is REFUSED rather than
     * served in the clear, matching how the mask middleware already fails closed
     * on `aggregate`/`groupBy` over a masked column.
     */
    const toCrossShardArgs = (childTable: string, childArgs: Parameters<DatabaseWriterLike["findMany"]>[1]): CrossShardReadArgs => {
        if (childArgs?.relationMask !== undefined && childArgs.with !== undefined && Object.keys(childArgs.with).length > 0) {
            throw new LunoraError(
                "MASK_UNSUPPORTED",
                `masking cannot follow a nested \`with\` across the cross-shard relation hop to "${childTable}" — the nested rows are hydrated on the serving shard, where the mask policy does not exist. Read the nested relation at its own (masked) call site instead.`,
            );
        }

        const relationPolicies: Record<string, WhereInput> = {};

        if (childArgs?.relationBaseWhere) {
            for (const table of Object.keys(schema.tables)) {
                const policy = childArgs.relationBaseWhere(table);

                if (policy !== undefined) {
                    relationPolicies[table] = policy;
                }
            }
        }

        return {
            orderBy: childArgs?.orderBy,
            relationPolicies,
            where: mergeWhere(childArgs?.baseWhere, childArgs?.where),
            with: childArgs?.with,
        };
    };

    // Backend-routed child fetch for the relation pre-resolver, available to the
    // aggregate/count/groupBy paths (the `findMany` method aliases this for its
    // nested `with` load). Mutually recursive with `writer`, so it reads
    // `writer` at call time.
    const relationPredicateFetcher: DatabaseWriterLike["findMany"] = (childTable, childArgs) => {
        if (!isShardLocalTarget(childTable)) {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure read of post-construction `writer`
            return writer.findMany(childTable, childArgs);
        }

        return crossShardReader ? crossShardReader(childTable, toCrossShardArgs(childTable, childArgs)) : crossBackendUnsupported(childTable);
    };

    /**
     * Resolve relation-crossing predicates on the aggregate/count/groupBy paths
     * (the ones that compile `where` directly). D1 has no EXISTS push-down, so
     * this is semijoin-only and an oversized child key set fails closed via the
     * configured key cap. The child read honours its own RLS through
     * `relationBaseWhere`, so a relation-filtered aggregate can never measure
     * rows the caller can't see. Returns the input reference unchanged when no
     * relation predicate is present — callers use that to keep their indexed
     * fast-path.
     */
    const resolveAggregateRelations = (
        where: WhereInput | undefined,
        predicateTable: string,
        relationBaseWhere: ((table: string) => undefined | WhereInput) | undefined,
    ): Promise<WhereInput | undefined> =>
        resolveRelationPredicates(where, {
            fetcher: relationPredicateFetcher,
            maxRelationKeys,
            relationBaseWhere,
            schema,
            tableName: predicateTable,
        });

    /**
     * Point-read coalescer for `get`. Rows come back keyed by id so a missing
     * id resolves to `null` rather than shifting the result order.
     */
    const pointReads = createPointReadBatcher<Record<string, unknown>>(async (table, ids) => {
        const rows = await queryAll(exec, dialect, sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.identifier("id")} IN (${bindList(ids)})`);
        const byId = new Map<string, Record<string, unknown>>();

        for (const row of rows) {
            const { id } = row;

            if (typeof id === "string") {
                byId.set(id, row);
            }
        }

        return byId;
    });

    const writer: DatabaseWriterLike = {
        /**
         * Which tables the changelog saw a write to after `sinceSeq` (see
         * {@link DatabaseWriterLike.cdcChangedTables}) — `undefined` when this
         * store has CDC disabled, since there is then no log to answer from and
         * the caller must fall back to re-reading. A missing/never-migrated log
         * table reports the same way rather than throwing: "no visibility" is a
         * state the caller already handles, and a poll tick is the wrong place
         * to surface a migration problem.
         */
        async cdcChangedTables(
            sinceSeq: number,
            readOptions?: { cursorOnly?: boolean },
        ): Promise<{ cursor: number; floor?: number; tables: string[] } | undefined> {
            if (!cdcEnabled) {
                return undefined;
            }

            try {
                await ensureMigrated();

                return await readSqlCdcChangedTables(exec, sinceSeq, dialect, { ...readOptions, retained: cdcRetentionMs !== undefined });
            } catch {
                return undefined;
            }
        },

        // eslint-disable-next-line sonarjs/cognitive-complexity -- routes count/sum/avg/min/max through the indexed companion vs scan fallback; the branching reads clearer inline than split across per-op helpers
        async aggregate(tableName, aggOptions: AggregateOptions): Promise<AggregateResult> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            // Ensure the companion tables exist so the indexed fast-path can
            // find (and backfill) the `__agg_` companion instead of falling
            // back to a scan on a binding that never ran the migration helper.
            await ensureMigrated();

            // Reject an off-allowlist `op` up front (it's a compile-time-only
            // type) before it can reach any SQL-emitting path.
            aggregateSqlFunction(aggOptions.op);

            if (aggOptions.op === "count") {
                return writer.count(tableName, {
                    baseWhere: aggOptions.baseWhere,
                    relationBaseWhere: aggOptions.relationBaseWhere,
                    restrictsCounts: aggOptions.restrictsCounts,
                    where: aggOptions.where,
                });
            }

            if (!aggOptions.field) {
                throw new LunoraError("INTERNAL", `aggregate(${tableName}, { op: "${aggOptions.op}" }): "field" is required for non-count reducers`);
            }

            // Soft delete: aggregate over LIVE rows only; force the scan path (the
            // indexed companion counts deleted rows too).
            const aggScope = softDeleteScope(definition.softDeleteMode, undefined);
            const effective = mergeWhere(mergeWhere(aggOptions.baseWhere, aggOptions.where), aggScope);
            // Rewrite any relation-crossing predicate to a flat semijoin clause
            // before compiling. The resolver returns `effective` unchanged when
            // there is none, so `hasRelation` skips the no-op fetch and disables
            // the indexed fast-path (which can't honour a relation filter and
            // would otherwise silently over-aggregate).
            const resolved = await resolveAggregateRelations(effective, tableName, aggOptions.relationBaseWhere);
            const hasRelation = resolved !== effective;

            // Indexed fast-path: the `__agg_` companion is now reducer-aware
            // (`__value__` holds the sum / running sum / extreme, `__count__`
            // the row count), so a matching `(by, field, op)` index whose
            // counter is materialized answers sum/avg/min/max in one row lookup.
            // We only attempt it when no baseWhere is set; the RLS predicate
            // falls through to the SQL scan below.
            if (definition.aggregateIndexes && !aggOptions.baseWhere && !hasRelation && !aggScope) {
                const planned = selectIndexForAggregate(definition.aggregateIndexes, aggOptions.op, aggOptions.field, aggOptions.where);

                if (planned) {
                    const counterReady = await ensureBackfilled(tableName, planned.index);

                    if (counterReady) {
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                        const aggTable = aggregateTableName(tableName, planned.index.name);
                        const rows = await queryAll(
                            exec,
                            dialect,
                            sql`SELECT ${sql.identifier("__value__")} AS ${sql.identifier("value")}, ${sql.identifier("__count__")} AS ${sql.identifier("count")} FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded}`,
                        );
                        const row = rows[0] as { count: number; value: null | number } | undefined;

                        return readAggregateValue(aggOptions.op, row === undefined ? undefined : { count: row.count, value: aggregateScalar(row.value) });
                    }
                }
            }

            assertReducibleBySql(definition, aggOptions.field, `aggregate(${tableName}, { op: "${aggOptions.op}", field: "${aggOptions.field}" })`);

            const whereCondition = compileWhereSql(resolved, whereSqlStrategy);
            const aggregateFunction = sql.raw(aggregateSqlFunction(aggOptions.op));
            const query = sql`SELECT ${aggregateFunction}(${columnRefSql(aggOptions.field)}) AS ${sql.identifier("value")} FROM ${sql.identifier(tableName)}`;
            const rows = await queryAll(exec, dialect, whereCondition ? sql`${query} WHERE ${whereCondition}` : query);
            const value = rows[0]?.["value"];

            // eslint-disable-next-line unicorn/no-null -- AggregateResult is `number | null`; an empty reduction returns null per the public contract.
            return value === null || value === undefined ? null : Number(value);
        },

        async count(tableName, whereOrOptions) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            // Ensure the `__agg_` companion exists so the indexed count path
            // can find (and backfill) it rather than scanning.
            await ensureMigrated();

            const countOptions = normalizeCountArgument(whereOrOptions);

            if (countOptions.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            // Soft delete: a `count()` reflects LIVE rows; force the scan path.
            const countScope = softDeleteScope(definition.softDeleteMode, undefined);
            const effective = mergeWhere(mergeWhere(countOptions.baseWhere, countOptions.where), countScope);
            // Rewrite any relation-crossing predicate to a flat semijoin clause
            // before compiling. `hasRelation` (resolver returned a new tree)
            // disables the indexed counter, which can't honour a relation filter.
            const resolved = await resolveAggregateRelations(effective, tableName, countOptions.relationBaseWhere);
            const hasRelation = resolved !== effective;

            // Indexed path: same planner as the DO dialect (see ctx-db.ts).
            // We only attempt the counter when no baseWhere is set; otherwise
            // we route uniformly through SQL so the RLS predicate participates.
            if (definition.aggregateIndexes && !countOptions.baseWhere && !hasRelation && !countScope) {
                const planned = selectIndexForCount(definition.aggregateIndexes, countOptions.where);

                if (planned) {
                    const counterReady = await ensureBackfilled(tableName, planned.index);

                    if (counterReady) {
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                        const aggTable = aggregateTableName(tableName, planned.index.name);
                        const rows = await queryAll(
                            exec,
                            dialect,
                            sql`SELECT ${sql.identifier("__value__")} AS ${sql.identifier("value")} FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded}`,
                        );

                        return Number(rows[0]?.["value"] ?? 0);
                    }
                }
            }

            const whereCondition = compileWhereSql(resolved, whereSqlStrategy);
            const query = sql`SELECT COUNT(*) AS ${sql.identifier("count")} FROM ${sql.identifier(tableName)}`;
            const rows = await queryAll(exec, dialect, whereCondition ? sql`${query} WHERE ${whereCondition}` : query);

            return Number(rows[0]?.["count"] ?? 0);
        },

        async delete(id, expectedTable, deleteOptions) {
            const tableName = await resolveTableName(id, expectedTable);

            if (!tableName) {
                return;
            }

            // Apply declared `onDelete` actions to holder rows before the
            // physical delete, mirroring the DO path. Snapshot the RAW stored
            // row up front so the optimistic-concurrency CAS below compares
            // stored-value to stored-value across the cascade `await` window.
            const definition = schema.tables[tableName];

            if (!definition) {
                return;
            }

            const snapshot = await rawRow(tableName, id);
            const existing = decodeRow(definition, snapshot);
            // Soft delete unless `hard` was forced; `softField` undefined ⇒ legacy
            // physical path. A delete cascades as a delete (soft→soft, hard→hard).
            const hard = deleteOptions?.hard === true;
            const softField = !hard && definition.softDeleteMode ? definition.softDeleteMode.field : undefined;

            // Idempotent: re-soft-deleting an already-soft-deleted (or absent) row
            // is a no-op so the cascade + companion sync don't fire spuriously.
            if (softField && (!existing || (existing[softField] !== null && existing[softField] !== undefined))) {
                return;
            }

            // `before` fires ahead of cascade resolution so a throwing guard
            // aborts the delete before any holder rows are touched.
            if (hasMatchingTrigger(tableName, "before", "delete")) {
                await fireTriggers("before", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });
            }

            // D1 → shard cascade is the hard direction: holders that live on
            // a `.shardBy()` table are spread across many DOs and would need
            // Query Coordinator fan-out. v1 routes every holder through this
            // D1 writer — same-backend (D1 → D1) cascades work, and shard
            // holders simply won't have rows here so cascades are no-ops.
            // For the explicit shardBy case we'd want a hard error; deferred.
            await applyOnDelete({
                deletedId: id,
                deletedReference: (references) => existing?.[references],
                findHolders: async (holderTable, field, value) => {
                    if (schema.tables[holderTable]?.shardMode?.kind === "shardBy") {
                        throw new LunoraError(
                            "INTERNAL",
                            `cross-backend cascade from global '${tableName}' into shardBy '${holderTable}' is not supported — would require Query Coordinator fan-out across shards`,
                        );
                    }

                    // A hard delete must see soft-deleted holders to remove them; a
                    // soft delete skips already-deleted holders.
                    const holders = await writer.findMany(holderTable, { includeDeleted: hard, where: { [field]: value } });

                    return holders.page;
                },
                onCascade: (_holderTable, holderId) => writer.delete(holderId, undefined, deleteOptions),
                onRestrict: (message) => {
                    throw new ConflictError(message, "restrict");
                },
                // eslint-disable-next-line unicorn/no-null -- onSetNull writes a SQL NULL into the holder column; that is the literal value being persisted.
                onSetNull: (_holderTable, holderId, field) => writer.patch(holderId, { [field]: null }),
                schema,
                tableName,
            });

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            if (softField && existing) {
                // Soft delete: keep the row, stamp the marker via an all-column
                // UPDATE (same encoding as `patch`). Companions re-sync to the
                // merged row; read scoping (not companion removal) hides it.
                const merged: Record<string, unknown> = { ...existing, [softField]: clock() };
                const assignments = sql.join(
                    // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent column binds `null`, matching the patch path.
                    Object.keys(definition.shape).map((field) => sql`${sql.identifier(field)} = ${serializeColumnValue(merged[field] ?? null)}`),
                    sql`, `,
                );

                await runGuardedWrite(tableName, "UPDATE", assignments, snapshot);

                // The rank companion has no marker column to filter on, so a soft
                // delete REMOVES the rank entry (like a physical delete); search +
                // aggregates stay maintained (search hides via the read filter).
                // `restore()` re-adds the rank entry through the patch path.
                await syncAggregates(tableName, existing, merged);
                await syncRanks(tableName, id, existing, undefined);
                await syncSearch(tableName, id, merged, existing);
                await recordCdc(tableName, id, "update", merged);

                // `delete()` was called → fire the DELETE triggers (the flag flip
                // is the storage detail of how the delete is recorded).
                if (hasMatchingTrigger(tableName, "after", "delete")) {
                    await fireTriggers("after", "delete", { id, op: "delete", previous: existing, table: tableName });
                }

                return;
            }

            await runGuardedWrite(tableName, "DELETE", undefined, snapshot);

            // The id no longer lives in `tableName`; drop the stale cache entry
            // so a later re-insert of the same id into a different global table
            // re-probes instead of resolving to the now-empty original table.
            tableNameCache.delete(id);

            await syncAggregates(tableName, existing ?? undefined, undefined);
            await syncRanks(tableName, id, existing ?? undefined, undefined);
            await syncSearch(tableName, id, undefined);
            await recordCdc(tableName, id, "delete");

            if (hasMatchingTrigger(tableName, "after", "delete")) {
                await fireTriggers("after", "delete", { id, op: "delete", previous: existing ?? undefined, table: tableName });
            }
        },

        async findFirst(tableName, args = {}) {
            const result = await writer.findMany(tableName, { ...args, limit: 1 });

            // eslint-disable-next-line unicorn/no-null -- findFirst's public return is `doc | null`; no match returns null.
            return result.page[0] ?? null;
        },

        async findFirstOrThrow(tableName, args = {}) {
            const document = await writer.findFirst(tableName, args);

            if (document === null) {
                throw new NotFoundError(`findFirstOrThrow: no "${tableName}" document matched`);
            }

            return document;
        },

        async findMany(tableName, args = {}) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            // The primary list read — provision the global tables first so a
            // fresh database returns an empty page instead of `no such table`.
            await ensureMigrated();

            const orderKeys = normalizeOrderKeys(args.orderBy, definition.shape);
            const seek = args.cursor ? buildSeekWhere(orderKeys, decodeCursor(args.cursor)) : undefined;

            // Relation reads routed by the child's backend (shard-local child of
            // this global parent → injected cross-shard reader; global/same-
            // backend → local D1 writer). Shared with the aggregate/count paths
            // as the top-level `relationPredicateFetcher`; aliased here for the
            // nested `with` load.
            const relationFetcher = relationPredicateFetcher;

            /**
             * Grouped aggregate counter for `_count` relation loading. For
             * local D1 children, issues one `SELECT :whereField AS __fk__,
             * COUNT(*) … GROUP BY :whereField` and returns all tallies in a
             * single round-trip. For shard-local (cross-shard reverse
             * direction), fans out parallel scalar `crossShardCounter` calls
             * since the coordinator interface doesn't expose grouped counts.
             *
             * CORRECTNESS: `policyWhere` may contain relation predicates (e.g.
             * `{author:{is:W}}`). These are resolved via `resolveAggregateRelations`
             * BEFORE `compileWhereSql` so they are rewritten into flat IN clauses
             * rather than compiled raw as scalar equality (which never matches).
             * The cross-shard fan-out path routes through `crossShardCounter`,
             * which uses the full `count()` method and resolves predicates
             * internally — so only the local D1 path needs this step.
             */
            const relationGroupedCounter = async (
                childTable: string,
                whereField: string,
                values: unknown[],
                policyWhere?: WhereInput,
            ): Promise<Map<unknown, number>> => {
                if (isShardLocalTarget(childTable)) {
                    // Cross-shard reverse direction: parallel scalar counts per FK value.
                    if (!crossShardCounter) {
                        return crossBackendUnsupported(childTable);
                    }

                    return fanOutScalarCounts(crossShardCounter, childTable, whereField, values, policyWhere);
                }

                // Local D1 child: one grouped SQL query.
                const childDefinition = schema.tables[childTable];

                if (!childDefinition) {
                    throw new LunoraError("INTERNAL", `unknown table: ${childTable}`);
                }

                // Build WHERE: whereField IN (values) [AND policyWhere] [AND softDeleteScope].
                // Then resolve any relation predicates before SQL compilation — without
                // this, a relation predicate in policyWhere is compiled as scalar equality
                // and silently returns 0 for every group (fail-closed but wrong).
                const softScope = softDeleteScope(childDefinition.softDeleteMode, undefined);
                const inFilter: WhereInput = { [whereField]: { in: values } };
                const combined = mergeWhere(mergeWhere(inFilter, policyWhere), softScope);
                // resolveAggregateRelations rewrites relation-crossing predicates (e.g.
                // {author:{is:W}}) into flat IN clauses — consistent with count() /
                // findMany(). Pass `undefined` for relationBaseWhere (no nested policy
                // threading, matching what the old scalar counter did).
                const resolvedCombined = await resolveAggregateRelations(combined, childTable, undefined);
                const whereCondition = compileWhereSql(resolvedCombined, whereSqlStrategy);

                // `physicalColumn` maps `_id`/`id` → `id`; all other fields are themselves.
                const fieldRef = columnRefSql(whereField);

                let groupQuery = sql`SELECT ${fieldRef} AS __fk__, COUNT(*) AS ${sql.identifier("count")} FROM ${sql.identifier(childTable)}`;

                if (whereCondition) {
                    groupQuery = sql`${groupQuery} WHERE ${whereCondition}`;
                }

                groupQuery = sql`${groupQuery} GROUP BY ${fieldRef}`;

                const groupRows = await queryAll(exec, dialect, groupQuery);
                const result = new Map<unknown, number>();

                for (const row of groupRows) {
                    // JS SameValueZero Map lookup: safe for string ids; numeric FK
                    // values must arrive from SQL as the same JS type as parent[parentField]
                    // (the SQL→JS key-equality invariant introduced by the grouped path).
                    result.set(row["__fk__"], Number(row["count"] ?? 0));
                }

                return result;
            };

            // RLS (3.2) / aggregates (3.1) inject `baseWhere` we AND-merge
            // before the keyset seek so policy + cursor compose cleanly.
            let predicate: undefined | WhereInput = mergeWhere(args.baseWhere, args.where);

            // Soft delete: hide rows whose marker column is set unless the caller
            // opted in via `includeDeleted`. Relation `with` loads route back
            // through this `findMany`, so they inherit the scope automatically.
            predicate = mergeWhere(predicate, softDeleteScope(definition.softDeleteMode, args.includeDeleted));

            // Rewrite relation-crossing predicates into flat `IN`/`NOT IN` via a
            // backend-routed child fetch before compiling. `relationBaseWhere` is
            // threaded through so a child table's RLS read filter applies on the
            // hop — as it is on the `with`-load `resolveWith` calls below.
            predicate = await resolveRelationPredicates(predicate, {
                fetcher: relationFetcher,
                maxRelationKeys,
                relationBaseWhere: args.relationBaseWhere,
                schema,
                tableName,
            });

            if (seek) {
                predicate = predicate ? { AND: [predicate, seek] } : seek;
            }

            const whereCondition = compileWhereSql(predicate, whereSqlStrategy);
            const orderBy = compileOrderBySql(orderKeys, dialect);

            let query = sql`SELECT * FROM ${sql.identifier(tableName)}`;

            if (whereCondition) {
                query = sql`${query} WHERE ${whereCondition}`;
            }

            query = sql`${query} ORDER BY ${orderBy}`;

            const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;

            if (limit !== undefined) {
                // Over-fetch by one row to learn whether another page exists.
                query = sql`${query} LIMIT ${sql.raw(String(limit + 1))}`;
            }

            const rows = await queryAll(exec, dialect, query);
            const documents = decodeRows(definition, rows);

            if (limit === undefined) {
                if (args.with) {
                    await resolveWith({
                        fetcher: relationFetcher,
                        groupedCounter: relationGroupedCounter,
                        parents: documents,
                        ...relationHooks(args),
                        schema,
                        tableName,
                        with: args.with,
                    });
                }

                // eslint-disable-next-line unicorn/no-null -- findMany's public return uses `continueCursor: string | null`; an unpaged result has no cursor.
                return { continueCursor: null, isDone: true, page: applySelect(documents, args.select, args.with) };
            }

            const hasMore = documents.length > limit;
            const page = hasMore ? documents.slice(0, limit) : documents;
            const last = page.at(-1);

            if (args.with) {
                await resolveWith({
                    fetcher: relationFetcher,
                    groupedCounter: relationGroupedCounter,
                    parents: page,
                    ...relationHooks(args),
                    schema,
                    tableName,
                    with: args.with,
                });
            }

            return {
                // The cursor is encoded from `last` (the full, unprojected row), so
                // `applySelect` only trims the returned payload — paging is intact.
                // eslint-disable-next-line unicorn/no-null -- public return shape: `continueCursor` is `string | null`; `null` marks the final page.
                continueCursor: hasMore && last ? encodeCursor(last, orderKeys) : null,
                isDone: !hasMore,
                page: applySelect(page, args.select, args.with),
            };
        },

        async get(id, expectedTable) {
            const tableName = await resolveTableName(id, expectedTable);

            if (!tableName) {
                // eslint-disable-next-line unicorn/no-null -- writer.get's public return is `doc | null`; an unresolved id returns null.
                return null;
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                // eslint-disable-next-line unicorn/no-null -- writer.get's public return is `doc | null` (see above).
                return null;
            }

            // Coalesced: every `get` issued in this tick against `tableName`
            // becomes ONE `IN (…)` round-trip. `Promise.all(ids.map(ctx.db.get))`
            // is the idiomatic join, and against a remote store each of those
            // would otherwise be its own network hop.
            return decodeRow(definition, await pointReads.load(tableName, id));
        },

        async groupBy(tableName, groupOptions: GroupByOptions): Promise<ReadonlyArray<GroupByEntry>> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            // Ensure the `__agg_` companion exists so the indexed groupBy path
            // can find (and backfill) it rather than scanning.
            await ensureMigrated();

            const agg = groupOptions.agg ?? { op: "count" };

            // Reject an off-allowlist reducer `op` before any SQL is emitted.
            aggregateSqlFunction(agg.op);

            if (agg.op !== "count" && !agg.field) {
                throw new LunoraError("INTERNAL", `groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
            }

            // Soft delete: group over LIVE rows only; force the scan path.
            const groupScope = softDeleteScope(definition.softDeleteMode, undefined);
            const effective = mergeWhere(mergeWhere(groupOptions.baseWhere, groupOptions.where), groupScope);
            // Rewrite any relation-crossing predicate to a flat semijoin clause
            // before compiling. `hasRelation` disables the indexed companion,
            // which can't honour a relation filter and would over-aggregate.
            const resolved = await resolveAggregateRelations(effective, tableName, groupOptions.relationBaseWhere);
            const hasRelation = resolved !== effective;

            // Indexed path: when no baseWhere is set and an aggregateIndex's
            // `by` exactly matches `groupOptions.by`, every group answer is
            // already in the reducer-aware companion table — covers every op
            // (count/sum/avg/min/max) now that `__value__`/`__count__` are
            // maintained per op. baseWhere falls through to scan so RLS composes.
            if (definition.aggregateIndexes && !groupOptions.baseWhere && !hasRelation && !groupScope) {
                const indexed = await tryIndexedGroupBy(tableName, definition.aggregateIndexes, agg, groupOptions);

                if (indexed !== undefined) {
                    return indexed;
                }
            }

            // Whatever the companion above would have answered is exactly what
            // the scan refuses here: every field this hands to SQL — the `by`
            // keys AND the reducer's field.
            assertGroupByReducibleBySql(definition, tableName, groupOptions.by, agg);

            const whereCondition = compileWhereSql(resolved, whereSqlStrategy);

            const select: SQL[] = groupOptions.by.map((field) => sql`${columnRefSql(field)} AS ${sql.identifier(field)}`);

            if (agg.op === "count") {
                select.push(sql`COUNT(*) AS ${sql.identifier("value")}`);
            } else {
                // `agg.field` is asserted present for non-count reducers by the
                // guard above; re-check locally so the column ref stays typed
                // without a non-null assertion.
                if (!agg.field) {
                    throw new LunoraError("INTERNAL", `groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
                }

                select.push(sql`${sql.raw(aggregateSqlFunction(agg.op))}(${columnRefSql(agg.field)}) AS ${sql.identifier("value")}`);
            }

            const groupBy = sql.join(
                groupOptions.by.map((field) => columnRefSql(field)),
                sql`, `,
            );

            let query = sql`SELECT ${sql.join(select, sql`, `)} FROM ${sql.identifier(tableName)}`;

            if (whereCondition) {
                query = sql`${query} WHERE ${whereCondition}`;
            }

            query = sql`${query} GROUP BY ${groupBy}`;

            const rows = await queryAll(exec, dialect, query);

            return mapGroupByRows(groupOptions.by, rows);
        },

        /**
         * Insert a document. A client-chosen `_id` is **ignored** by default —
         * a caller able to pick its own id can collide with peer rows, defeat
         * unique constraints, and forge references in foreign tables.
         *
         * Two opt-ins override that: a validated `options.clientId` (public —
         * a UUID an optimistic client supplies so a sync engine can reconcile by
         * key) or `options.allowExplicitId` (the trusted dev/admin import path,
         * honoring a verbatim `_id` on `document`). Otherwise a fresh id is
         * minted even if a handler forwards a raw client payload.
         */
        async insert(tableName, document, insertOptions) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            // Companion DDL must exist before the sync hooks below run an
            // INSERT against the fts/agg/rank tables.
            await ensureMigrated();

            const withDefaults = applyInsertDefaults(definition, document, auth);

            // Refinements declared via `.check(predicate)` fire on the
            // post-default row so a defaulted value still passes its checks.
            runRowValidators(definition, withDefaults);

            let id: string;
            // Whether the id was pinned by the caller (validated `clientId` or the
            // trusted-import `allowExplicitId`) rather than freshly minted — drives
            // the tableName-cache pin below.
            let usedExplicitId = true;

            if (insertOptions?.clientId !== undefined) {
                assertValidClientId(insertOptions.clientId);
                id = insertOptions.clientId;
            } else if (insertOptions?.allowExplicitId && typeof withDefaults["_id"] === "string") {
                id = withDefaults["_id"];
            } else {
                id = generateId();
                usedExplicitId = false;
            }
            // Like `_id` above, a document-supplied `_creationTime` is only honored
            // under the trusted-import `allowExplicitId` opt-in. The default mutation
            // path (and the optimistic `clientId` path) mints from `clock()` so a
            // raw-forwarded client payload can't backdate/forward-date the row —
            // sync reconciles by `clientId`, not by a client-chosen time.
            const creationTime = insertOptions?.allowExplicitId && typeof withDefaults["_creationTime"] === "number" ? withDefaults["_creationTime"] : clock();

            const documentWithMeta: Record<string, unknown> = { ...withDefaults, _creationTime: creationTime, _id: id };

            // `before` sees a shallow copy so an abort-only handler can't reassign
            // the row's top-level fields before they persist. Nested values are
            // still shared by reference — before-handlers are abort/side-effect
            // only, never row transformers (use `.$defaultFn`/`.$onUpdateFn`).
            if (hasMatchingTrigger(tableName, "before", "insert")) {
                await fireTriggers("before", "insert", { doc: { ...documentWithMeta }, id, op: "insert", table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const { columns, values } = columnTuple(definition, id, creationTime, withDefaults);

            await runWrite(tableName, sql`INSERT INTO ${sql.identifier(tableName)} (${identifierList(columns)}) VALUES (${bindList(values)})`);

            // A caller-pinned id may collide with a stale cache entry from a
            // prior delete/re-insert in this ctx-db lifetime; point the cache
            // at the table the row now actually lives in. (Generated ids are
            // random and never pre-seeded, so this only matters for the
            // explicit-id import path.)
            if (usedExplicitId) {
                tableNameCache.set(id, tableName);
            }

            await syncAggregates(tableName, undefined, documentWithMeta);
            await syncRanks(tableName, id, undefined, documentWithMeta);
            await syncSearch(tableName, id, documentWithMeta);
            await recordCdc(tableName, id, "insert", documentWithMeta);

            if (hasMatchingTrigger(tableName, "after", "insert")) {
                await fireTriggers("after", "insert", { doc: documentWithMeta, id, op: "insert", table: tableName });
            }

            return id;
        },

        normalizeId(tableName, id) {
            return normalizeIdStructurally(schema, tableName, id);
        },

        async patch(id, patch, expectedTable) {
            // A key present with value `undefined` is a silent-data-loss footgun:
            // `runRowValidators` skips it (`v.optional(x).parse(undefined)` is
            // fine) and `serializeColumnValue(merged[field] ?? null)` then wrote
            // SQL NULL, so `patch(id, { bio: undefined })` cleared the column with
            // no error. The shard twin has refused this since it was found there;
            // sharing its guard rather than restating it is what keeps the two
            // from drifting again.
            assertNoExplicitUndefined("patch", patch);
            const tableName = await resolveTableName(id, expectedTable);

            if (!tableName) {
                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            // Capture the RAW stored row alongside the decoded `existing` — the
            // raw values seed the optimistic-concurrency CAS below, before the
            // before-update trigger's `await` window can let a concurrent write
            // slip in.
            const snapshot = await rawRow(tableName, id);
            const existing = decodeRow(definition, snapshot);

            if (!existing) {
                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            const merged: Record<string, unknown> = { ...existing, ...patch, _id: id };

            applyOnUpdate(definition, patch, merged, auth);

            // Refinement checks fire on the merged row so a patch that flips
            // a field to an invalid value is rejected before D1 sees it.
            runRowValidators(definition, merged, true);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...merged }, id, op: "update", previous: existing, table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const fields = Object.keys(definition.shape);
            const assignments = sql.join(
                // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent column must bind `null`, not undefined.
                fields.map((field) => sql`${sql.identifier(field)} = ${serializeColumnValue(merged[field] ?? null)}`),
                sql`, `,
            );

            await runGuardedWrite(tableName, "UPDATE", assignments, snapshot);

            await syncAggregates(tableName, existing, merged);
            await syncRanks(tableName, id, existing, merged);
            await syncSearch(tableName, id, merged, existing);
            await recordCdc(tableName, id, "update", merged);

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: merged, id, op: "update", previous: existing, table: tableName });
            }
        },

        async restore(id, expectedTable) {
            const tableName = await resolveTableName(id, expectedTable);

            if (!tableName) {
                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            const definition = schema.tables[tableName];
            const field = definition?.softDeleteMode?.field;

            if (!definition || !field) {
                throw new LunoraError("INTERNAL", `ctx.db.restore: table "${tableName}" is not a .softDelete() table`);
            }

            // Snapshot the raw row before the patch so we know whether it was
            // actually soft-deleted (drives the rank re-add) and have its sort
            // fields to rebuild the rank-companion entry.
            const snapshot = await rawRow(tableName, id);
            const wasDeleted = snapshot?.[field] !== null && snapshot?.[field] !== undefined;

            // eslint-disable-next-line unicorn/no-null -- clearing the soft-delete marker writes SQL NULL into the column
            await writer.patch(id, { [field]: null }, expectedTable);

            // Soft delete dropped this row's rank-companion entry; `patch`'s rank
            // sync skips re-adding it (rank fields unchanged, so its fast path
            // treats the entry as present), so force a pure INSERT
            // (`previous=undefined`) — only when restoring an actually soft-deleted
            // row, to avoid a duplicate on a no-op restore. Re-add the RESTORED
            // image (marker cleared): `snapshot` predates the patch and still
            // carries the marker, and `syncRanks`' soft-delete guard would skip a
            // still-deleted `next`.
            if (wasDeleted) {
                const row = decodeRow(definition, snapshot);

                if (row !== null) {
                    // eslint-disable-next-line unicorn/no-null -- the restored image clears the soft-delete marker, matching what `patch` persisted.
                    await syncRanks(tableName, id, undefined, { ...row, [field]: null });
                }
            }
        },

        query(tableName) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            const LEGACY_READER_ERROR = "the legacy query()/withIndex() reader is not available on the D1 (global) backend; use findMany";

            // The D1 backend doesn't expose the scan/index reader — `findMany`
            // is the public read surface there. Only `.withSearchIndex()` is
            // supported, so a staged search runs and every other terminal op
            // throws the same legacy-reader error the bare `query()` used to.
            // Predicates pushed on by `.filter()`. RLS installs one of these on
            // every restricted read, so a search reader that refused them would
            // make `.withSearchIndex()` unusable on any table with a read policy.
            const searchFilters: ((document: Record<string, unknown>) => boolean)[] = [];

            const passesSearchFilters = (document: Record<string, unknown>): boolean => searchFilters.every((predicate) => predicate(document));

            const runSearch = async (stage: SearchStage, limit: number | undefined): Promise<Record<string, unknown>[]> => {
                // Ensure the search companion exists (and is backfilled) before
                // reading it — the fts5 shadow, or the portable inverted table.
                await ensureMigrated();

                // Relevance order bounds the read: the caller's limit when there
                // is one, `MAX_SEARCH_SCAN` otherwise. An in-memory filter
                // narrows *within* that window rather than widening the read, so
                // it reads the full window and trims after.
                const filtered = searchFilters.length > 0;
                const rows = await runSqlSearch(exec, dialect, definition, tableName, stage, resolveSearchScan(filtered ? undefined : limit));

                if (!filtered) {
                    // An unbounded read asked for one row past the cap; a full
                    // window means the caller would get a prefix that looks whole.
                    if (limit === undefined) {
                        assertSearchWithinCap(rows);
                    }

                    return rows;
                }

                const kept = rows.filter((row) => passesSearchFilters(row));

                return limit === undefined ? kept : kept.slice(0, limit);
            };

            const buildReader = (stage: SearchStage | undefined): TableReaderLike => {
                const reader: TableReaderLike = {
                    /**
                     * Lazy row iteration, paging through `paginate` exactly as the
                     * shard reader does — so `for await` behaves the same on a
                     * `.global()` table as on a sharded one, and hits the same
                     * directed `LEGACY_READER_ERROR` when the chain is not a
                     * search stage (via `paginate` below). Without this the
                     * public `TableReader` type promised an iterator that only
                     * one backend had.
                     */
                    // eslint-disable-next-line generator-star-spacing -- prettier owns this spacing and formats it as `async *[…]`; the rule wants `async* […]`, and prettier runs last
                    async *[Symbol.asyncIterator]() {
                        if (!stage) {
                            throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
                        }

                        // Runs the same unbounded read `.collect()` runs, rather
                        // than paging.
                        //
                        // Paging here could not terminate honestly. A page is
                        // capped at `MAX_SEARCH_SCAN`, and a page sized to the
                        // cap cannot fetch the probe row that tells "exactly
                        // that many matches" from "ten times as many" — so
                        // `planSearchPage` refuses it rather than reporting a
                        // false `isDone`. A `for await` built on paging would
                        // therefore die at the cap with a `BAD_REQUEST` it
                        // cannot act on, while `.collect()` on the same query
                        // raises the cap error. The unbounded read gives one
                        // answer for both.
                        //
                        // Nothing is given up: the page size was the cap, so
                        // the old loop already read the whole window in one
                        // query and a `break` saved nothing. Relevance order is
                        // why — a scored search has to rank its whole window
                        // before it knows which row is first.
                        yield* await runSearch(stage, undefined);
                    },
                    async collect() {
                        if (!stage) {
                            throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
                        }

                        return runSearch(stage, undefined);
                    },
                    // eslint-disable-next-line @typescript-eslint/require-await -- declared `() => Promise<...>` so every caller can uniformly `await`/`.rejects` it; `async` here (rather than a bare throw) is what turns this into a rejected promise instead of a synchronous throw
                    async collectWithScores() {
                        // The three search layouts (`search-layout.ts`) compute and
                        // order by `__score__` in SQL exactly like the sharded FTS5
                        // path does, but none of them selects it back out of the
                        // final row set — the same discard `.global()`'s `collect()`
                        // has always done. Surfacing it needs plumbing through all
                        // three layouts, not just this reader, so — like
                        // `withGeoIndex()` below — this fails closed with a clear
                        // error instead of a confusing "not a function" for now.
                        throw new LunoraError(
                            // A backend limitation the caller can act on, not a
                            // fault in Lunora. `INTERNAL` made it a 500 that read
                            // as a bug and could not be branched on; the
                            // `*_UNSUPPORTED` codes are how every other
                            // topology limit in the catalogue is expressed.
                            "GLOBAL_SEARCH_SCORES_UNSUPPORTED",
                            `collectWithScores() is not supported on \`.global()\` tables (table "${tableName}") — relevance scores are not yet surfaced on this backend; use .collect() instead`,
                        );
                    },
                    filter(predicate) {
                        // Chainable on the bare reader (like `order()` below): RLS
                        // installs a predicate at query() time, BEFORE the caller
                        // can stage `.withSearchIndex()`. `searchFilters` is
                        // scoped to the whole query() call, so a pre-stage
                        // predicate carries into the search stage; a non-search
                        // chain still surfaces LEGACY_READER_ERROR at its
                        // terminal.
                        searchFilters.push(predicate);

                        return reader;
                    },
                    async first() {
                        if (!stage) {
                            throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
                        }

                        const rows = await runSearch(stage, 1);

                        // eslint-disable-next-line unicorn/no-null -- documented `first()` result shape (Doc | null) returned to callers
                        return rows[0] ?? null;
                    },
                    order() {
                        // `.order()` is meaningful only on the scan/index reader,
                        // which D1 doesn't expose (search returns relevance order);
                        // it stays chainable so a non-search chain still surfaces
                        // the same legacy-reader error at its terminal.
                        return reader;
                    },
                    async paginate(pageOptions) {
                        if (!stage) {
                            throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
                        }

                        // Cursor decoding, the bounded-page refusal and the cap
                        // are the shared policy in `search-query`, so both
                        // backends page identically; one row past the page is
                        // fetched so `hasMore` is observed, not guessed.
                        const plan = planSearchPage(pageOptions);

                        return finishSearchPage(await runSearch(stage, searchPageScan(plan)), plan);
                    },
                    async take(limit) {
                        if (!stage) {
                            throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
                        }

                        return runSearch(stage, limit);
                    },
                    async unique() {
                        if (!stage) {
                            throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
                        }

                        // Over-fetch one past the single row we expect: 0 → null,
                        // 1 → the row, ≥2 → ambiguous (an error). Mirrors Convex.
                        const rows = await runSearch(stage, 2);

                        if (rows.length > 1) {
                            throw new NotUniqueError(`unique() on table "${tableName}" matched ${String(rows.length)} documents; expected at most one`);
                        }

                        // eslint-disable-next-line unicorn/no-null -- documented `unique()` result shape (Doc | null) returned to callers
                        return rows[0] ?? null;
                    },
                    withGeoIndex() {
                        // Geospatial (`.geoIndex()` / `.near()` / `.within()`) is a
                        // sharded DO-SQLite feature; `.global()` tables have no
                        // geohash companion, so codegen types this `never` and the
                        // runtime refuses it rather than returning wrong results.
                        throw new LunoraError(
                            "INTERNAL",
                            `geo indexes are not supported on \`.global()\` tables (table "${tableName}") — geospatial queries run only on sharded tables`,
                        );
                    },
                    withIndex() {
                        throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
                    },
                    withSearchIndex(indexName, search) {
                        // eslint-disable-next-line sonarjs/no-nested-functions -- the .find predicate sits inside the reader builder's terminal; hoisting it out for one lookup would be more indirection than it saves
                        const searchDefinition = (definition.searchIndexes ?? []).find((index) => index.name === indexName);

                        if (!searchDefinition) {
                            throw new LunoraError("INTERNAL", `unknown search index "${indexName}" on table "${tableName}"`);
                        }

                        const searchStage: SearchStage = {
                            definition: searchDefinition,
                            field: searchDefinition.field,
                            filters: [],
                            hasQuery: false,
                            indexName,
                            query: "",
                        };

                        search(createSearchBuilder(searchStage, tableName, createSearchAnalyzer(searchDefinition.language)));

                        if (!searchStage.hasQuery) {
                            throw new LunoraError("INTERNAL", `search index "${indexName}" on table "${tableName}" requires a .search(field, query) call`);
                        }

                        return buildReader(searchStage);
                    },
                };

                return reader;
            };

            return buildReader(undefined);
        },

        async rank(tableName, indexName, rankOptions): Promise<null | RankResult> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new LunoraError("INTERNAL", `unknown rankIndex "${indexName}" on table "${tableName}"`);
            }

            // Same RLS coupling-seam semantics as count(): position is a
            // count-rows-strictly-before; an RLS-restricted ctx can't return
            // a correct count, so the rank throws the same error.
            if (rankOptions.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            // Ensure the `__rank_` companion exists so the indexed rank path
            // can find (and backfill) it rather than returning null.
            await ensureMigrated();

            const counterReady = await ensureRankBackfilled(tableName, index);

            if (!counterReady) {
                // No companion table — caller can't get a rank from D1 in
                // this dialect. Surface as null (the row may exist in the
                // source table but isn't tracked).
                // eslint-disable-next-line unicorn/no-null -- rank's public return is `RankResult | null`; an untracked row reads as null.
                return null;
            }

            const rowId = typeof rankOptions.row === "string" ? rankOptions.row : (rankOptions.row["_id"] as string | undefined);

            if (!rowId) {
                // eslint-disable-next-line unicorn/no-null -- rank's public return is `RankResult | null` (see above).
                return null;
            }

            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
            const selectList = identifierList(["__partition__", ...sortColumns]);
            const ownRows = await queryAll(
                exec,
                dialect,
                sql`SELECT ${selectList} FROM ${sql.identifier(rankTable)} WHERE ${sql.identifier("__id__")} = ${rowId}`,
            );

            const own = ownRows[0];

            if (!own) {
                // eslint-disable-next-line unicorn/no-null -- rank's public return is `RankResult | null` (see above).
                return null;
            }

            const partitionKey = own["__partition__"] as string;

            const effective = mergeWhere(rankOptions.baseWhere, rankOptions.where);

            // rank() uses `where` solely to pin/validate the partition, never as
            // a row filter — a relation-crossing predicate has nowhere to apply,
            // so resolving it would silently drop it (fail-**open**). Reject it.
            assertFlatPredicate(effective, schema, tableName, "rank");

            const partitionFromWhere = resolveRankPartition(index, effective);

            if (partitionFromWhere) {
                const requestedKey = encodePartitionKey(index.partitionBy ?? [], partitionFromWhere);

                if (requestedKey !== partitionKey) {
                    // eslint-disable-next-line unicorn/no-null -- rank's public return is `RankResult | null`; a partition mismatch reads as null.
                    return null;
                }
            }

            const beforeClause = buildRankBeforeBranches(dialect.name, index, sortColumns, own, rowId);

            const beforeRows = await queryAll(
                exec,
                dialect,
                sql`SELECT COUNT(*) AS c FROM ${sql.identifier(rankTable)} WHERE ${sql.identifier("__partition__")} = ${partitionKey}${beforeClause ? sql` AND (${beforeClause})` : sql``}`,
            );
            const totalRows = await queryAll(
                exec,
                dialect,
                sql`SELECT COUNT(*) AS c FROM ${sql.identifier(rankTable)} WHERE ${sql.identifier("__partition__")} = ${partitionKey}`,
            );

            return { position: Number(beforeRows[0]?.["c"] ?? 0) + 1, total: Number(totalRows[0]?.["c"] ?? 0) };
        },

        async rankPage(tableName, indexName, rankPageOptions = {}): Promise<RankPage> {
            // Parity with rank(): rankPage's `where` only pins the partition, never
            // a row filter, so a relation-crossing predicate would be silently
            // dropped (fail-**open**). Reject it first — mirrors the DO twin, which
            // guards before the rankIndex lookup.
            assertFlatPredicate(mergeWhere(rankPageOptions.baseWhere, rankPageOptions.where), schema, tableName, "rankPage");

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new LunoraError("INTERNAL", `unknown rankIndex "${indexName}" on table "${tableName}"`);
            }

            // Ensure the `__rank_` companion exists so the indexed rankPage path
            // can find (and backfill) it rather than returning an empty page.
            await ensureMigrated();

            const counterReady = await ensureRankBackfilled(tableName, index);

            if (!counterReady) {
                // eslint-disable-next-line unicorn/no-null -- RankPage's public `continueCursor` is `string | null`; an unbuilt companion returns an empty page with a null cursor.
                return { continueCursor: null, isDone: true, page: [] };
            }

            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
            const take = Math.max(1, Math.min(1000, Math.floor(rankPageOptions.take ?? 100)));
            const effective = mergeWhere(rankPageOptions.baseWhere, rankPageOptions.where);
            const partitionFromWhere = resolveRankPartition(index, effective);

            // Column tuple in rank order: [partition, ...sortColumns, id], all
            // ascending except the sort columns, which follow their index.
            const rankColumns = rankPageColumns(index, sortColumns);
            const orderBy = sql.join(
                rankColumns.map((col) => sql`${sql.identifier(col.column)} ${sql.raw(col.direction === "desc" ? "DESC" : "ASC")}`),
                sql`, `,
            );

            const whereClauses: SQL[] = [];

            // A pre-encoded `partitionKey` from the cross-shard coordinator pins
            // the partition directly; shard-local callers omit it and the
            // partition resolves from `where`. This side read only the `where`
            // form, so a coordinator-issued page silently scanned every partition.
            if (typeof rankPageOptions.partitionKey === "string") {
                whereClauses.push(sql`${sql.identifier("__partition__")} = ${rankPageOptions.partitionKey}`);
            } else if (partitionFromWhere) {
                whereClauses.push(sql`${sql.identifier("__partition__")} = ${encodePartitionKey(index.partitionBy ?? [], partitionFromWhere)}`);
            }

            // `after` wins over `cursor`, sharing the shard twin's resolver: the
            // cross-shard coordinator forwards a structured `{ partitionKey,
            // sortValues, rowId }` key, and this side read only `cursor`. A caller
            // paging with `after` got page one every time — an `after` loop never
            // terminated — with no error, because both fields sit on the SHARED
            // `RankPageOptions` and the facade forwards the object verbatim.
            const seekTuple = resolveRankSeekTuple(rankPageOptions);

            if (seekTuple !== undefined) {
                const seek = buildRankCursorSeek(dialect.name, rankColumns, seekTuple);

                if (seek !== undefined) {
                    whereClauses.push(seek);
                }
            }

            const selectColumns = identifierList([RANK_TIEBREAK, "__partition__", ...sortColumns]);

            let query = sql`SELECT ${selectColumns} FROM ${sql.identifier(rankTable)}`;

            if (whereClauses.length > 0) {
                query = sql`${query} WHERE ${sql.join(whereClauses, sql` AND `)}`;
            }

            query = sql`${query} ORDER BY ${orderBy} LIMIT ${sql.raw(String(take + 1))}`;
            const rankRows = await queryAll(exec, dialect, query);
            const hasMore = rankRows.length > take;
            const usable = hasMore ? rankRows.slice(0, take) : rankRows;

            const ids = usable.map((rankRow) => rankRow[RANK_TIEBREAK] as string);
            const documents = await hydrateRankRows(exec, dialect, definition, tableName, ids);

            // eslint-disable-next-line unicorn/no-null -- RankPage's public `continueCursor` is `string | null`; `null` marks the final page.
            let continueCursor: null | string = null;

            const last = usable.at(-1);

            if (hasMore && last !== undefined) {
                const cursorValues: unknown[] = [last["__partition__"], ...sortColumns.map((column) => last[column]), last[RANK_TIEBREAK]];

                continueCursor = encodeRankCursor(cursorValues);
            }

            return { continueCursor, isDone: !hasMore, page: documents };
        },

        async replace(id, document, expectedTable, replaceOptions) {
            assertNoExplicitUndefined("replace", document);
            const tableName = await resolveTableName(id, expectedTable);

            if (!tableName) {
                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            // Always snapshot the RAW stored row — it seeds the optimistic-
            // concurrency CAS below. `previous` (the decoded prior doc) is only
            // needed when a trigger or an aggregate/rank index has to step the
            // old `by`-tuple; decode it from the same snapshot to avoid a second
            // round-trip.
            const snapshot = await rawRow(tableName, id);

            if (snapshot === undefined) {
                throw new LunoraError("INTERNAL", `document not found: ${id}`);
            }

            const needsPrevious =
                hasTrigger(schema, tableName, "update") || (definition.aggregateIndexes ?? []).length > 0 || (definition.rankIndexes ?? []).length > 0;
            const previous = needsPrevious ? (decodeRow(definition, snapshot) ?? undefined) : undefined;
            // A client-supplied `_creationTime` is honored only under the
            // trusted-replay `allowExplicitId` opt-in (CDC replay, data-migration
            // rewrite — both replay a row's original creation time). The default
            // mutation path mints from `clock()` so a forged document
            // `_creationTime` can't overwrite the persisted timestamp.
            const creationTime = replaceOptions?.allowExplicitId && typeof document["_creationTime"] === "number" ? document["_creationTime"] : clock();
            const replaced: Record<string, unknown> = { ...document, _creationTime: creationTime, _id: id };

            applyOnUpdate(definition, document, replaced, auth);

            // Refinement checks fire on the post-onUpdate row so a defaulted
            // field still has to satisfy its `.check()` predicate.
            runRowValidators(definition, replaced);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...replaced }, id, op: "update", previous, table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const fields = Object.keys(definition.shape);
            const assignments = sql.join(
                [
                    sql`${sql.identifier("_creationTime")} = ${creationTime}`,
                    // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent column must bind `null`, not undefined.
                    ...fields.map((field) => sql`${sql.identifier(field)} = ${serializeColumnValue(replaced[field] ?? null)}`),
                ],
                sql`, `,
            );

            await runGuardedWrite(tableName, "UPDATE", assignments, snapshot);

            await syncAggregates(tableName, previous, replaced);
            await syncRanks(tableName, id, previous, replaced);
            await syncSearch(tableName, id, replaced, previous);
            await recordCdc(tableName, id, "update", replaced);

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: replaced, id, op: "update", previous, table: tableName });
            }
        },
    };

    triggerContext = { db: writer, scheduler };

    return writer;
};

export { createSqlCtxDb, readSqlCdcChangedTables, readSqlCdcChanges, readSqlCdcFloor, runSqlCdcMigration, sweepSqlCdcRetention };
export { backfillSqlSearchIndexes, runSqlSearchMigrations } from "./ctx-db-search";
export type { SqlCtxDbOptions };

export { decodeGlobalRow, type SqlCtxExec } from "./sql-exec";
