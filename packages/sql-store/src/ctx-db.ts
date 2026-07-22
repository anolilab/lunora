/**
 * D1 column-dialect twin of the DO `createShardCtxDb` (`@lunora/do`).
 *
 * Global (`.global()`) tables live in D1 with a real column-per-field physical
 * schema — not the DO's JSON blob — so `where`/`orderBy`/keyset-cursor refer to
 * actual columns (`"field"`) rather than `json_extract(...)`. The query and
 * cursor logic is identical to the DO path: it reuses the shared keyset/order
 * helpers from `@lunora/do`, but compiles `WHERE` through the drizzle-emitting
 * `compileWhereSql` with a `WhereSqlStrategy` (column refs + value
 * serialization) so the generated `ctx.db.&lt;table>` facade (1.2.7) is
 * backend-agnostic.
 */
/* eslint-disable unicorn/prevent-abbreviations -- "d1-ctx-db" is the established public module name: src/index.ts and every test import it as "./d1-ctx-db.js", and it deliberately mirrors @lunora/do's "ctx-db.ts" twin. Renaming would break those importers. */

/* eslint-disable no-restricted-syntax -- `sql\`…\`` here is the drizzle tagged-template SQL builder, not a string conversion; the rule misfires on the inner TemplateLiteral. */
import type {
    AggregateIndexDefinitionLike,
    AggregateOptions,
    AggregateResult,
    AggregateTally,
    ColumnMetaLike,
    DatabaseWriterLike,
    GroupByEntry,
    GroupByOptions,
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
    ValidatorLike,
    WhereInput,
    WhereSqlStrategy,
} from "@lunora/do";
import {
    aggregateSqlFunction,
    aggregateTableName,
    applyOnDelete,
    applySelect,
    assertFlatPredicate,
    assertValidClientId,
    buildFtsMatch,
    buildSeekWhere,
    coerceAggregateNumber,
    compileWhereSql,
    ConflictError,
    CountRlsUnsupportedError,
    decodeCursor,
    encodeAggregateKey,
    encodeCursor,
    encodePartitionKey,
    fanOutScalarCounts,
    foldAggregateTally,
    ftsTableName,
    hasTrigger,
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
    renderSql,
    resolveRankPartition,
    resolveRelationPredicates,
    resolveWith,
    runRowValidators,
    runTriggers,
    scoreDocument,
    selectIndexForAggregate,
    selectIndexForCount,
    selectIndexForGroupBy,
    softDeleteScope,
    sortColumnName,
    stringifySearchText,
    throwingScheduler,
    tokenizeSearch,
} from "@lunora/do";
import { LunoraError } from "@lunora/errors";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { evictOldestEntry } from "../../../shared/evict-oldest";
import type { SqlDialect, SqlRunResult } from "./dialect";
import { effectiveColumnKind, sqliteDecode, sqliteEncode } from "./value-codec";

/** Logical field → physical column name (`_id`/`id` → `id`; everything else, incl. `_creationTime`, is itself). */
const physicalColumn = (field: string): string => (field === "_id" || field === "id" ? "id" : field);

/** Logical-field → physical column reference as a drizzle {@link SQL}; the engine's dialect quotes it at render time (`_id`/`id` → `id`). */
const columnRefSql = (field: string): SQL => sql`${sql.identifier(physicalColumn(field))}`;

/** Order fields that already provide a stable tiebreak (no extra `id ASC` needed). */
const ID_ORDER_FIELDS = new Set(["_id", "id"]);

/**
 * NULL-safe equality for a bound value, rendered per engine: SQLite `IS`,
 * Postgres `IS NOT DISTINCT FROM`, MySQL's `&lt;=>` null-safe-equal operator. A bare
 * `col IS &lt;literal>` is SQLite-only — it is a syntax error on Postgres/MySQL — so
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
 * Drizzle `ORDER BY` list — the SQL-object twin of `@lunora/do`'s string
 * `compileOrderBy`: each key as `&lt;col> ASC|DESC`, with an `id ASC` tiebreak
 * appended unless an id field is already ordered (keeps paging deterministic).
 */
const compileOrderBySql = (keys: ReadonlyArray<{ direction?: string; field: string }>): SQL => {
    const parts = keys.map((key) => sql`${columnRefSql(key.field)} ${sql.raw(key.direction === "desc" ? "DESC" : "ASC")}`);

    if (!keys.some((key) => ID_ORDER_FIELDS.has(key.field))) {
        parts.push(sql`${columnRefSql("id")} ASC`);
    }

    return sql.join(parts, sql`, `);
};

/**
 * Run a composable drizzle {@link SQL} read through the (string-based) exec:
 * render it for the dialect's engine — quoting + placeholders handled by drizzle
 * — then run the resulting `{ sql, params }`. The exec interface is unchanged, so
 * D1/PlanetScale execs need no edits; the per-engine `?`→`$N` / `"…"`→backtick
 * rewrites become redundant once every site is on this path.
 */
const queryAll = (exec: SqlCtxExec, dialect: SqlDialect, query: SQL): Promise<Record<string, unknown>[]> => {
    const { params, sql: text } = renderSql(dialect.name, query);

    return exec.all(text, params);
};

/** Write twin of {@link queryAll}: render a drizzle {@link SQL} for the engine and run it. */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `void` is intentional: mirrors SqlExec.run, whose union accepts a void-returning exec (no affected-rows count)
const queryRun = (exec: SqlCtxExec, dialect: SqlDialect, query: SQL): Promise<SqlRunResult | void> => {
    const { params, sql: text } = renderSql(dialect.name, query);

    return exec.run(text, params);
};

/**
 * Create an index idempotently across engines. SQLite/Postgres support
 * `CREATE [UNIQUE] INDEX IF NOT EXISTS`; **MySQL does not** (only `CREATE TABLE`
 * takes `IF NOT EXISTS`), so it creates unconditionally and swallows the
 * "duplicate key name" error (errno 1061) a re-run raises.
 */
const createIndexIfNotExists = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    spec: { columns: SQL; name: string; table: string; unique: boolean },
): Promise<void> => {
    const unique = spec.unique ? sql`UNIQUE ` : sql``;

    if (dialect.name === "mysql") {
        try {
            await queryRun(exec, dialect, sql`CREATE ${unique}INDEX ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`);
        } catch (error) {
            if ((error as { errno?: number }).errno !== 1061) {
                throw error;
            }
        }

        return;
    }

    await queryRun(exec, dialect, sql`CREATE ${unique}INDEX IF NOT EXISTS ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`);
};

/**
 * Async SQL surface the D1 ORM needs: `all` for reads, `run` for writes.
 * Satisfied by a `D1Session`/`D1Client` in production and a `node:sqlite`
 * adapter in tests, so the query logic runs against a real SQLite engine.
 */
interface SqlCtxExec {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    // `void` for D1/node:sqlite (the result is ignored on those paths); a
    // `SqlRunResult` ({ rowsAffected }) for engines whose OCC needs the affected
    // count (MySQL, which has no `RETURNING`). The union lets a PlanetScale
    // `SqlExec` satisfy this without forcing the D1 execs to report a count.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `void` is intentional: accepts a void-returning exec (one that reports no affected-rows count)
    run: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<SqlRunResult | void>;
}

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
     */
    crossShardReader?: DatabaseWriterLike["findMany"];

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
 * Structural shape of a `.searchIndex()` declaration. Kept local (not imported
 * from `@lunora/do`) because that file owns the FTS surface and doesn't export
 * the type — mirrored byte-for-byte so a parity test could compare the two.
 */
interface SearchIndexDefinitionLike {
    readonly field: string;
    readonly filterFields?: ReadonlyArray<string>;
    readonly name: string;
}

/** SQLite storage encode for `.global()` column values — the shared `@lunora/sql-store` codec (SQLite has no boolean, so true/false → 1/0). */
const serializeColumnValue = sqliteEncode;

/**
 * Memoized per-`SqlCtxExec` FTS5 capability probe. D1's SQLite ships FTS5;
 * `node:sqlite` (used in tests) does not. We create and drop a throwaway virtual
 * table once per handle and cache the resolving promise — the exec handle is
 * stable for the ctx-db's lifetime, so this runs at most once per binding. The
 * cached value is a `Promise` so concurrent first-callers share the single probe
 * rather than racing two CREATE/DROP round-trips.
 */
const ftsAvailabilityCache = new WeakMap<SqlCtxExec, Promise<boolean>>();

const isFtsAvailable = (exec: SqlCtxExec): Promise<boolean> => {
    const cached = ftsAvailabilityCache.get(exec);

    if (cached !== undefined) {
        return cached;
    }

    const probe = (async (): Promise<boolean> => {
        let available: boolean;

        try {
            await exec.run(`CREATE VIRTUAL TABLE IF NOT EXISTS "__lunora_fts_probe" USING fts5(x)`, []);
            available = true;
        } catch {
            available = false;
        } finally {
            // Always attempt the DROP so the probe table never lingers — if the
            // CREATE threw, the IF EXISTS makes the DROP a no-op.
            try {
                await exec.run(`DROP TABLE IF EXISTS "__lunora_fts_probe"`, []);
            } catch {
                // The probe table cleanup is best-effort; swallow so the
                // availability decision still propagates.
            }
        }

        return available;
    })();

    ftsAvailabilityCache.set(exec, probe);

    return probe;
};

/** A table's fields paired with their column meta, skipping fields that declare none. */
const tableColumns = (definition: TableDefinitionLike): [string, ColumnMetaLike][] => {
    const columns: [string, ColumnMetaLike][] = [];

    for (const [field, validator] of Object.entries(definition.shape)) {
        const column = validator._meta?.column;

        if (column) {
            columns.push([field, column]);
        }
    }

    return columns;
};

/**
 * The `field → effective column kind` mapping for a table, derived once per
 * (immutable) definition and memoized. `effectiveColumnKind` is pure over the
 * validator and the shape never mutates after `defineSchema`, so the mapping is
 * static per definition — precomputing it removes the per-row
 * `Object.entries(definition.shape)` + `effectiveColumnKind` recomputation on the
 * decode hot path (a page/global read decodes R rows × M columns). Keyed on the
 * definition object identity (stable: definitions come from `defineSchema`).
 */
const columnKindCache = new WeakMap<TableDefinitionLike, [string, string | undefined][]>();

const columnKinds = (definition: TableDefinitionLike): [string, string | undefined][] => {
    let kinds = columnKindCache.get(definition);

    if (kinds === undefined) {
        kinds = Object.entries(definition.shape).map(([field, validator]) => [field, effectiveColumnKind(validator)] as [string, string | undefined]);
        columnKindCache.set(definition, kinds);
    }

    return kinds;
};

/**
 * Decode a SELECTed row back into a document: `id` → `_id`, `_creationTime`
 * preserved, and every column run through the shared {@link sqliteDecode} so the
 * stored form is reversed back into its JS shape. Exported so the data-browser
 * (`introspect.ts`) and admin export/import paths share the exact same decode.
 *
 * The decode is engine-agnostic: every backend stores SQLite-shaped values
 * (boolean → 1/0, JSON → text, bigint → decimal string), and `sqliteDecode` is
 * robust to a driver returning either the stored string OR a natively-parsed
 * value (e.g. mysql2 returns JSON columns pre-parsed) — so the same decoder is
 * correct on SQLite, Postgres and MySQL.
 */
const decodeGlobalRow = (definition: TableDefinitionLike, row: Record<string, unknown>): Record<string, unknown> => {
    const decoded: Record<string, unknown> = {};

    for (const [field, kind] of columnKinds(definition)) {
        const raw = row[field];

        if (raw === undefined) {
            continue;
        }

        decoded[field] = sqliteDecode(raw, kind);
    }

    decoded["_id"] = row["id"];
    decoded["_creationTime"] = row["_creationTime"];

    return decoded;
};

/** Decode a SELECTed row back into a document, or `null` when the row is absent. */

const decodeRow = (definition: TableDefinitionLike, row: Record<string, unknown> | undefined): Record<string, unknown> | null => {
    if (!row) {
        // eslint-disable-next-line unicorn/no-null -- a missing row decodes to `null`, the value writer.get() returns per the public DatabaseWriterLike contract.
        return null;
    }

    return decodeGlobalRow(definition, row);
};

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

    const candidates: string[] = [];

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        // Skip tables that don't live in D1 — `.shardBy()` is spread across
        // many DOs and would never have a D1 row to find. The default root
        // mode is also DO-side; we only need to probe `.global()` tables.
        // (Schemas authored before the `.global()` flag existed don't set
        // shardMode at all — preserve the legacy "probe every table" behaviour
        // there so existing fixtures keep working.)
        if (definition.shardMode !== undefined && definition.shardMode.kind !== "global") {
            continue;
        }

        candidates.push(tableName);
    }

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

/** Decode a result set into documents, dropping any row that fails to decode. */
const decodeRows = (definition: TableDefinitionLike, rows: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>[] => {
    const documents: Record<string, unknown>[] = [];

    for (const row of rows) {
        const decoded = decodeRow(definition, row);

        if (decoded) {
            documents.push(decoded);
        }
    }

    return documents;
};

/** The staged `.withSearchIndex().search()` query the D1 reader executes. */
interface SearchStage {
    definition: SearchIndexDefinitionLike;
    field: string;
    filters: { field: string; value: unknown }[];
    hasQuery: boolean;
    indexName: string;
    query: string;
}

/**
 * Run a search via the FTS5 shadow table: MATCH the query against the indexed
 * text column, JOIN back to the document table on the stored id, narrow by any
 * `.eq()` filter fields (real columns in the D1 dialect), and order by FTS5's
 * `rank` (bm25 — best first). Mirrors the DO twin, swapping the JSON-blob SELECT
 * for the column-per-field `m.*` and `columnRef` filter quoting.
 */
const searchViaFts = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    search: SearchStage,
    limit: number | undefined,
): Promise<Record<string, unknown>[]> => {
    const tokens = tokenizeSearch(search.query);

    if (tokens.length === 0) {
        return [];
    }

    const ftName = ftsTableName(tableName, search.indexName);
    // MATCH must target the FTS table (by name or an indexed column), never the
    // bare alias `f` — `f MATCH ?` is a "no such column: f" error in SQLite.
    // We match the indexed `__text__` column so the alias join still works.
    const conditions: SQL[] = [sql`f.${sql.identifier("__text__")} MATCH ${buildFtsMatch(tokens)}`];

    for (const filter of search.filters) {
        conditions.push(sql`m.${columnRefSql(filter.field)} = ${serializeColumnValue(filter.value)}`);
    }

    // Soft delete: hide soft-deleted rows from search (qualified to the joined
    // doc table `m`).
    if (definition.softDeleteMode) {
        conditions.push(sql`m.${columnRefSql(definition.softDeleteMode.field)} IS NULL`);
    }

    // `f.rank` is FTS5's bm25 relevance (best first); the `_creationTime DESC`
    // tiebreak matches the scan fallback so equal-rank rows order newest-first
    // on both engines.
    let query = sql`SELECT m.* FROM ${sql.identifier(ftName)} f JOIN ${sql.identifier(tableName)} m ON m.${sql.identifier("id")} = f.${sql.identifier("__id__")} WHERE ${sql.join(conditions, sql` AND `)} ORDER BY f.rank, m.${sql.identifier("_creationTime")} DESC`;

    if (typeof limit === "number") {
        query = sql`${query} LIMIT ${sql.raw(String(Math.max(0, Math.floor(limit))))}`;
    }

    const rows = await queryAll(exec, dialect, query);

    return decodeRows(definition, rows);
};

/**
 * Portable fallback for engines without FTS5 (the `node:sqlite` test runner):
 * pull candidate rows (narrowed by `.eq()` filters in SQL), tokenize the indexed
 * field in JS, and rank with `scoreDocument`. Matches the FTS path's AND +
 * prefix-on-last-token semantics; relevance order is term-frequency, ties broken
 * by creation time (newest first).
 */
const searchViaScan = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    search: SearchStage,
    limit: number | undefined,
): Promise<Record<string, unknown>[]> => {
    const tokens = tokenizeSearch(search.query);

    if (tokens.length === 0) {
        return [];
    }

    const conditions = search.filters.map((filter) => sql`${columnRefSql(filter.field)} = ${serializeColumnValue(filter.value)}`);

    // Soft delete: hide soft-deleted rows from the scan fallback too.
    if (definition.softDeleteMode) {
        conditions.push(sql`${columnRefSql(definition.softDeleteMode.field)} IS NULL`);
    }

    let query = sql`SELECT * FROM ${sql.identifier(tableName)}`;

    if (conditions.length > 0) {
        query = sql`${query} WHERE ${sql.join(conditions, sql` AND `)}`;
    }

    const rows = await queryAll(exec, dialect, query);
    const scored: { creationTime: number; doc: Record<string, unknown>; score: number }[] = [];

    for (const record of decodeRows(definition, rows)) {
        const score = scoreDocument(stringifySearchText(record[search.field]), tokens);

        if (score > 0) {
            scored.push({ creationTime: typeof record["_creationTime"] === "number" ? record["_creationTime"] : 0, doc: record, score });
        }
    }

    scored.sort((a, b) => b.score - a.score || b.creationTime - a.creationTime);

    const documents = scored.map((entry) => entry.doc);

    return typeof limit === "number" ? documents.slice(0, Math.max(0, Math.floor(limit))) : documents;
};

/**
 * Builder passed to `.withSearchIndex(name, q => …)`: `.search(field, query)`
 * stages the full-text match (exactly once), `.eq(field, value)` narrows by a
 * declared filter field. Mirrors the DO `createSearchBuilder` guards verbatim.
 */
const createSearchBuilder = (
    search: SearchStage,
    tableName: string,
): { eq: (field: string, value: unknown) => unknown; search: (field: string, query: string) => unknown } => {
    const builder = {
        eq: (field: string, value: unknown) => {
            if (!search.definition.filterFields?.includes(field)) {
                throw new LunoraError("INTERNAL", `field "${field}" is not a filter field of search index "${search.indexName}" on table "${tableName}"`);
            }

            search.filters.push({ field, value });

            return builder;
        },
        search: (field: string, query: string) => {
            if (field !== search.definition.field) {
                throw new LunoraError(
                    "INTERNAL",
                    `search index "${search.indexName}" on table "${tableName}" indexes "${search.definition.field}", not "${field}"`,
                );
            }

            // Mutate the caller-owned stage in place (same object the reader
            // executes); alias to a local so the param itself isn't reassigned.
            const stage = search;

            stage.field = field;
            stage.query = query;
            stage.hasQuery = true;

            return builder;
        },
    };

    return builder;
};

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
        chunks.map(async (chunk) => {
            const list = sql.join(
                chunk.map((value) => sql`${value}`),
                sql`, `,
            );

            return queryAll(exec, dialect, sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${sql.identifier("id")} IN (${list})`);
        }),
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

/** Base64-encode a rankPage continuation cursor (the `[partition, ...sortValues, id]` tuple) as JSON. */
const encodeRankCursor = (cursorValues: ReadonlyArray<unknown>): string => {
    const json = JSON.stringify(cursorValues);
    const bytes = new TextEncoder().encode(json);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

/** Fixed page size for the keyset-paged table scans the backfill helpers use. */
const BACKFILL_BATCH_SIZE = 500;

/**
 * Stream every row of `tableName` to `onDoc` in `id`-keyset order, decoding each
 * row into a document first. Pages by the last row's `id` (not OFFSET) so an
 * unbounded table never has to fit in a single result buffer. Rows that fail to
 * decode are skipped. Shared by the aggregate- and rank-counter backfills.
 */
const forEachRowPaged = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    onDoc: (document: Record<string, unknown>) => void,
): Promise<void> => {
    let cursorId: string | undefined;
    let hasMore = true;

    while (hasMore) {
        const pageRows =
            cursorId === undefined
                ? // eslint-disable-next-line no-await-in-loop -- keyset paging is inherently sequential: each page's WHERE depends on the prior page's last id.
                  await queryAll(
                      exec,
                      dialect,
                      sql`SELECT * FROM ${sql.identifier(tableName)} ORDER BY ${sql.identifier("id")} ASC LIMIT ${sql.raw(String(BACKFILL_BATCH_SIZE))}`,
                  )
                : // eslint-disable-next-line no-await-in-loop -- keyset paging is inherently sequential: each page's WHERE depends on the prior page's last id.
                  await queryAll(
                      exec,
                      dialect,
                      sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${sql.identifier("id")} > ${cursorId} ORDER BY ${sql.identifier("id")} ASC LIMIT ${sql.raw(String(BACKFILL_BATCH_SIZE))}`,
                  );

        for (const row of pageRows) {
            const decoded = decodeRow(definition, row);

            if (decoded) {
                onDoc(decoded);
            }
        }

        cursorId = pageRows.at(-1)?.["id"] as string | undefined;
        hasMore = pageRows.length === BACKFILL_BATCH_SIZE;
    }
};

/**
 * SQLite affinity for a column. Resolves the *effective* validator kind (so
 * `v.optional(inner)` stores as `inner` would) and defers to the shared dialect
 * (`@lunora/d1/dialect`) — the same mapping the `lunora migrate generate` SQL
 * emitter uses, so auto-provisioned and hand-migrated tables stay identical.
 */
const globalColumnAffinity = (validator: ValidatorLike, dialect: SqlDialect): string => dialect.columnType(effectiveColumnKind(validator));

/**
 * Auto-provision every `.global()` table from the schema: `CREATE TABLE IF NOT
 * EXISTS` with the physical `id`/`_creationTime` columns plus a typed column per
 * declared field, then its secondary and `.unique()` indexes. This is the D1
 * twin of `@lunora/do`'s `runShardMigrations` (which self-creates shard-local
 * tables) — it makes the schema the single source of truth for global tables
 * too, so a fresh database serves them without a hand-applied migration. The
 * column set and dialect match exactly what this module reads and writes
 * (`columnRef`, `serializeColumnValue`, `decodeGlobalRow`).
 *
 * Idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`); additive only — it never
 * drops or retypes an existing column, so destructive schema changes still need
 * an explicit migration.
 */
/** Build the column DDL for a global table as a drizzle `SQL`: framework columns plus a typed column per declared field. */
const globalTableColumnsDdl = (definition: SchemaLike["tables"][string], dialect: SqlDialect): SQL => {
    const fieldColumns: SQL[] = [];

    for (const [field, validator] of Object.entries(definition.shape)) {
        if (!validator._meta?.column) {
            continue;
        }

        // Required, non-optional fields get NOT NULL; optional ones stay nullable
        // so an insert that omits them can't trip a constraint.
        const notNull = validator._meta.column.notNull && validator.kind !== "optional" ? " NOT NULL" : "";

        fieldColumns.push(sql`${sql.identifier(field)} ${sql.raw(`${globalColumnAffinity(validator, dialect)}${notNull}`)}`);
    }

    const frameworkColumns = dialect.frameworkColumns().map((column) => sql`${sql.identifier(column.name)} ${sql.raw(column.type)}`);

    return sql.join([...frameworkColumns, ...fieldColumns], sql`, `);
};

/** Create a global table's declared secondary indexes and its synthesized `.unique()` column indexes. */
const createGlobalTableIndexes = async (exec: SqlCtxExec, tableName: string, definition: SchemaLike["tables"][string], dialect: SqlDialect): Promise<void> => {
    // Index column reference as drizzle SQL, with a key prefix where the engine
    // demands it (MySQL can't index its now-unbounded TEXT string columns without
    // one). Framework columns (id/_creationTime — absent from `shape`) are already
    // index-safe types, so they get no prefix.
    const indexRef = (field: string): SQL => {
        const reference = columnRefSql(field);
        const validator = definition.shape[field];
        const prefix = validator && dialect.indexKeyPrefix ? dialect.indexKeyPrefix(effectiveColumnKind(validator)) : undefined;

        return prefix === undefined ? reference : sql`${reference}(${sql.raw(String(prefix))})`;
    };

    for (const index of definition.indexes) {
        const expressions = sql.join(
            index.fields.map((field) => indexRef(field)),
            sql`, `,
        );

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection.
        await createIndexIfNotExists(exec, dialect, {
            columns: expressions,
            name: `${tableName}_${index.name}`,
            table: tableName,
            unique: index.unique ?? false,
        });
    }

    // `.unique()` columns synthesize a UNIQUE index so the engine enforces the
    // constraint (the write layer maps breaches to ConflictError), mirroring the
    // DO twin's `migrateSecondaryIndexes`.
    for (const [field, column] of tableColumns(definition)) {
        if (!column.unique) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection.
        await createIndexIfNotExists(exec, dialect, { columns: indexRef(field), name: `${tableName}_unique_${field}`, table: tableName, unique: true });
    }
};

const runSqlGlobalTableMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind !== "global") {
            continue;
        }

        const columns = globalTableColumnsDdl(definition, dialect);

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the single shared D1 connection; the table must exist before its indexes below.
        await queryRun(exec, dialect, sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(tableName)} (${columns})`);
        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially; indexes follow the table.
        await createGlobalTableIndexes(exec, tableName, definition, dialect);
    }
};

/**
 * Materialize the `__agg_&lt;index>` companion tables for every declared
 * `aggregateIndex` on a global table. Global tables in Lunora ship their own
 * DDL — counter tables are opt-in so production hosts can decide where they
 * live. Tests and dev hosts can call this once after their schema migration to
 * unlock O(1) counts.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS`).
 */
const runSqlAggregateMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    const { integer, key, real } = dialect.companionTypes;

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        const indexes = definition.aggregateIndexes;

        if (!indexes || indexes.length === 0) {
            continue;
        }

        for (const index of indexes) {
            const aggTable = aggregateTableName(tableName, index.name);

            // `__value__` is op-aware now (count / running sum / extreme — NULL
            // for an empty min/max group) and `__count__` tracks the row count
            // (avg divisor + empty-group detection). It is nullable; the pre-
            // reducer-aware shape declared it `NOT NULL`.
            // eslint-disable-next-line no-await-in-loop -- DDL statements run sequentially on the single shared connection.
            await queryRun(
                exec,
                dialect,
                sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(aggTable)} (${sql.identifier("__key__")} ${sql.raw(key)} PRIMARY KEY, ${sql.identifier("__value__")} ${sql.raw(real)}, ${sql.identifier("__count__")} ${sql.raw(integer)} NOT NULL DEFAULT 0)`,
            );

            // Alpha-era companion-rebuild caveat (SQLite/D1 only): a binding that
            // materialized this table before `__count__` existed gets the column
            // added here (defaulted 0). `CREATE TABLE IF NOT EXISTS` won't reshape
            // an existing table, so we pragma-check then ALTER. Fresh PG/MySQL
            // tables are created with `__count__` already, so this legacy reshape
            // is skipped off SQLite.
            if (dialect.name === "sqlite") {
                // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
                const columns = await queryAll(exec, dialect, sql`PRAGMA table_info(${sql.identifier(aggTable)})`);

                if (!columns.some((column) => column["name"] === "__count__")) {
                    // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection.
                    await queryRun(
                        exec,
                        dialect,
                        sql`ALTER TABLE ${sql.identifier(aggTable)} ADD COLUMN ${sql.identifier("__count__")} ${sql.raw(integer)} NOT NULL DEFAULT 0`,
                    );
                }
            }
        }
    }
};

/**
 * A rank btree index column. MySQL can't index a full VARCHAR(768)/TEXT column in
 * a *composite* index (3072-byte key limit), so VARCHAR/TEXT key columns get a
 * 191-char utf8mb4 prefix (keeps several columns under the cap); SQLite/Postgres
 * — and number/real columns everywhere — index in full.
 */
const rankIndexColumn = (dialect: SqlDialect, column: string, direction: "ASC" | "DESC", needsPrefix: boolean): SQL => {
    const reference = dialect.name === "mysql" && needsPrefix ? sql`${sql.identifier(column)}(191)` : sql`${sql.identifier(column)}`;

    return sql`${reference} ${sql.raw(direction)}`;
};

/** The rank btree key tuple in sort order: `__partition__`, the sort columns, then `__id__` — each prefixed where MySQL's type demands it. */
const rankBtreeColumns = (dialect: SqlDialect, index: RankIndexDefinitionLike, definition: SchemaLike["tables"][string]): SQL[] => {
    // __partition__/__id__ are the VARCHAR(768) `key` type → always prefixed on MySQL.
    const columns: SQL[] = [rankIndexColumn(dialect, "__partition__", "ASC", true)];

    for (const [i, sortKey] of index.sortBy.entries()) {
        const validator = definition.shape[sortKey.field];
        const needsPrefix = validator !== undefined && dialect.indexKeyPrefix?.(effectiveColumnKind(validator)) !== undefined;

        columns.push(rankIndexColumn(dialect, sortColumnName(i), sortKey.direction === "desc" ? "DESC" : "ASC", needsPrefix));
    }

    columns.push(rankIndexColumn(dialect, "__id__", "ASC", true));

    return columns;
};

/** Each rank sort column is typed by its source field's kind (the same type + serialized form the main table uses), so it accepts the stored sort key and orders correctly. A generic BLOB would reject the value on Postgres (BYTEA is strict). */
const rankSortColumnDefs = (dialect: SqlDialect, index: RankIndexDefinitionLike, definition: SchemaLike["tables"][string]): SQL[] =>
    index.sortBy.map((sortKey, i) => {
        const validator = definition.shape[sortKey.field];
        const columnType = dialect.columnType(validator ? effectiveColumnKind(validator) : undefined);

        return sql`${sql.identifier(sortColumnName(i))} ${sql.raw(columnType)}`;
    });

/**
 * Materialize the `__rank_&lt;index>` companion tables for every declared
 * `rankIndex` on a global table. Mirrors `runSqlAggregateMigrations` — same
 * opt-in pattern so production hosts decide whether to spend the DDL.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS` + `createIndexIfNotExists`).
 */
const runSqlRankMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    const { key } = dialect.companionTypes;

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        const indexes = definition.rankIndexes;

        if (!indexes || indexes.length === 0) {
            continue;
        }

        for (const index of indexes) {
            const rankTable = rankTableName(tableName, index.name);
            const sortColumnDefs = rankSortColumnDefs(dialect, index, definition);
            const columnPart = sortColumnDefs.length > 0 ? sql`, ${sql.join(sortColumnDefs, sql`, `)}` : sql``;

            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared connection; the table must exist before its index below.
            await queryRun(
                exec,
                dialect,
                sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(rankTable)} (${sql.identifier("__id__")} ${sql.raw(key)} PRIMARY KEY, ${sql.identifier("__partition__")} ${sql.raw(key)} NOT NULL${columnPart})`,
            );

            const orderedColumns = rankBtreeColumns(dialect, index, definition);
            const btreeName = `${tableName}__rank_${index.name}__btree`;

            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection (the CREATE INDEX follows its CREATE TABLE).
            await createIndexIfNotExists(exec, dialect, {
                columns: sql.join(orderedColumns, sql`, `),
                name: btreeName,
                table: rankTable,
                unique: false,
            });
        }
    }
};

/**
 * Materialize the `__fts_&lt;index>` FTS5 shadow tables for every declared
 * `.searchIndex()` on a global table. Mirrors `runSqlAggregateMigrations` — same
 * opt-in pattern so production hosts decide whether to spend the DDL. Only runs
 * on engines that ship FTS5 (D1 does; the `node:sqlite` test runner doesn't,
 * where `.search()` transparently falls back to a scan). `__text__` holds the
 * indexed field; `__id__` (UNINDEXED) joins back to the row.
 *
 * Idempotent (`CREATE VIRTUAL TABLE IF NOT EXISTS`).
 */
const runSqlSearchMigrations = async (exec: SqlCtxExec, schema: SchemaLike, dialect: SqlDialect): Promise<void> => {
    // fts5 is a SQLite/D1 feature. On engines without it (`node:sqlite`,
    // Postgres, MySQL) the probe fails and this no-ops — `.search()` then
    // transparently falls back to a portable scan.
    if (!(await isFtsAvailable(exec))) {
        return;
    }

    for (const [tableName, definition] of Object.entries(schema.tables)) {
        const indexes = definition.searchIndexes;

        if (!indexes || indexes.length === 0) {
            continue;
        }

        for (const index of indexes) {
            const ftName = ftsTableName(tableName, index.name);

            // eslint-disable-next-line no-await-in-loop -- DDL statements run sequentially on the single shared connection.
            await queryRun(
                exec,
                dialect,
                sql`CREATE VIRTUAL TABLE IF NOT EXISTS ${sql.identifier(ftName)} USING fts5(${sql.identifier("__text__")}, ${sql.identifier("__id__")} UNINDEXED)`,
            );
        }
    }
};

/** Reserved append-only changelog table backing CDC streaming export for global tables (CDC consumers only — D1 point-in-time recovery is the platform's Time Travel, not a changelog replay). */
const CDC_LOG_TABLE = "__cdc_log";

/** One change-data-capture entry: a committed mutation, in monotonic `seq` order. Mirrors the DO twin. */
interface CdcChange {
    /** Post-image document for insert/update; absent for delete (the `id` identifies the removed row). */
    doc?: Record<string, unknown>;
    id: string;
    op: "delete" | "insert" | "update";
    /** Monotonic per-database cursor — strictly increasing, never reused. */
    seq: number;
    table: string;
    /** Wall-clock millis when the change committed (the ctx-db `clock`). */
    ts: number;
}

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
};

/** Append one committed mutation to the changelog (post-image JSON, or NULL for delete). */
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
            doc === undefined ? null : JSON.stringify(doc)
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

    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT seq, ts, ${sql.identifier("table")}, id, op, doc FROM ${sql.identifier(CDC_LOG_TABLE)} WHERE seq > ${sinceSeq} ORDER BY seq ASC LIMIT ${sql.raw(String(limit))}`,
    );

    const changes = rows.map((row): CdcChange => {
        const { doc } = row;
        const base = { id: String(row.id), op: String(row.op) as CdcChange["op"], seq: Number(row.seq), table: String(row.table), ts: Number(row.ts) };

        return typeof doc === "string" ? { ...base, doc: JSON.parse(doc) as Record<string, unknown> } : base;
    });

    return { changes, cursor: changes.at(-1)?.seq ?? sinceSeq };
};

/** Drop changelog entries at or below a checkpointed `throughSeq` (retention). */
const trimSqlCdcChanges = async (exec: SqlCtxExec, throughSeq: number, dialect: SqlDialect): Promise<void> => {
    await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(CDC_LOG_TABLE)} WHERE ${sql.identifier("seq")} <= ${throughSeq}`);
};

const createSqlCtxDb = (options: SqlCtxDbOptions): DatabaseWriterLike => {
    const { crossShardCounter, crossShardReader, exec, maxRelationKeys, schema } = options;

    // The engine dialect for this ctx-db. Destructured into the names the body
    // already uses so the (large) closure body is unchanged — these block-scoped
    // locals shadow the module-level SQLite helpers/imports. `@lunora/hyperdrive/global`
    // injects a Postgres/MySQL dialect; absent one, this is the SQLite default.
    const { dialect } = options;
    const { isUniqueViolation } = dialect;
    // Value encode stays the shared SQLite codec (`serializeColumnValue`) on every
    // engine — storage is SQLite-shaped everywhere. Identifier quoting and
    // placeholder numbering are drizzle's job (rendered per-engine via renderSql),
    // so the strategy only carries the one per-engine WHERE difference: MySQL has
    // no `||` string concat, so `contains` uses `CONCAT`.
    const whereSqlStrategy: WhereSqlStrategy = {
        fieldRef: columnRefSql,
        serialize: serializeColumnValue,
        // MySQL has no `||` string concat; the rest use the portable form compileWhereSql defaults to.
        // The term is wildcard-escaped by compileContains, so pair it with a backslash `ESCAPE` for literal
        // matching. MySQL treats backslash as a string-literal escape, so the SQL text must contain a DOUBLED
        // backslash (`ESCAPE '\\'`) to denote one literal backslash; drizzle's `sql` tag uses the COOKED
        // template string, so `'\\\\'` here renders `'\\'` in the SQL (a single `'\'` would escape the closing
        // quote and raise a syntax error). SQLite/Postgres take backslash literally and use the portable default.
        ...(dialect.name === "mysql" ? { likeContains: (reference, term) => sql`${reference} LIKE CONCAT('%', ${term}, '%') ESCAPE '\\\\'` } : {}),
    };

    /** NULL-safe equality for the OCC guard, bound to this ctx-db's engine (see the module-level {@link nullSafeEqualsSql}). */
    const nullSafeEquals = (reference: SQL, value: unknown): SQL => nullSafeEqualsSql(dialect.name, reference, value);

    /**
     * Build an `INSERT … VALUES … &lt;conflict clause>` upsert as a drizzle SQL for
     * the aggregate counters. SQLite/Postgres emit `ON CONFLICT(&lt;key>) DO UPDATE
     * SET …`; MySQL emits `ON DUPLICATE KEY UPDATE …` (keyed off `dialect.name`).
     * The `set` callback returns `{ &lt;unquoted column>: &lt;update expression> }`
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
        const columnList = sql.join(
            config.columns.map((column) => sql`${sql.identifier(column)}`),
            sql`, `,
        );
        const valueList = sql.join(
            config.values.map((value) => sql`${value}`),
            sql`, `,
        );
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
        if (cdcEnabled) {
            await appendSqlCdcChange(exec, clock(), table, id, op, doc, dialect);
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
    // `isFtsAvailable` probe). CREATE IF NOT EXISTS is idempotent, so running it
    // once per instance is cheap.
    let migratedPromise: Promise<void> | undefined;

    const ensureMigrated = async (): Promise<void> => {
        migratedPromise ??= (async (): Promise<void> => {
            // Base `.global()` tables first — the companion migrations below and
            // every read/write path assume they exist.
            await runSqlGlobalTableMigrations(exec, schema, dialect);
            await runSqlAggregateMigrations(exec, schema, dialect);
            await runSqlRankMigrations(exec, schema, dialect);
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
     * Whether `table` has a corresponding `__agg_&lt;index>` companion table on
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

        for (const [encoded, tally] of tallies) {
            // eslint-disable-next-line no-await-in-loop -- counter rows are inserted sequentially on the single shared D1 connection; SqlCtxExec exposes no batch API here.
            await queryRun(
                exec,
                dialect,
                sql`INSERT INTO ${sql.identifier(aggTable)} (${sql.identifier("__key__")}, ${sql.identifier("__value__")}, ${sql.identifier("__count__")}) VALUES (${encoded}, ${tally.value}, ${tally.count})`,
            );
        }

        backfilled.set(cacheKey, true);

        return true;
    };

    /**
     * Recompute a min/max group's extreme from the source table, scoped to the
     * group's `by`-tuple and the index's static `where`, against the D1 column
     * dialect. Runs AFTER the physical row write, so it sees the post-write
     * source and returns the surviving extreme (`null` when none survives). The
     * caller pins `__count__` from its own tracked tally.
     */
    const recomputeExtreme = async (tableName: string, index: AggregateIndexDefinitionLike, document: Record<string, unknown>): Promise<null | number> => {
        const sqlFunction = aggregateSqlFunction(index.op);
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

        const query = sql`SELECT ${sql.raw(sqlFunction)}(${columnRefSql(field)}) AS value FROM ${sql.identifier(tableName)}`;
        const rows = await queryAll(exec, dialect, conditions.length > 0 ? sql`${query} WHERE ${sql.join(conditions, sql` AND `)}` : query);

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

        if (op === "count") {
            // Track the group keys we touched so an emptied group can be pruned
            // (count steps both the removes and the adds key on a `by`-changing
            // update; only the removes side can reach 0).
            const touched = new Set<string>();

            for (const [document, delta] of [
                [removes, -1],
                [adds, 1],
            ] as const) {
                if (!document) {
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
                                __value__: sql`${current("__value__")} + ${excluded("__value__")}`,
                            };
                        },
                        table: aggTable,
                        values: [encoded, delta, delta],
                    }),
                );
            }

            for (const encoded of touched) {
                // eslint-disable-next-line no-await-in-loop -- sequential prune on the shared connection (see above).
                await pruneEmptyGroup(aggTable, encoded);
            }

            return;
        }

        if (op === "sum" || op === "avg") {
            // Same prune-after-step contract as count: a group whose last row
            // left drops to `__count__ <= 0` and must be removed, not zeroed.
            const touched = new Set<string>();

            for (const [document, sign] of [
                [removes, -1],
                [adds, 1],
            ] as const) {
                if (!document) {
                    continue;
                }

                const numeric = coerceAggregateNumber(document[field]);

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
                                __value__: sql`COALESCE(${current("__value__")}, 0) + ${excluded("__value__")}`,
                            };
                        },
                        table: aggTable,
                        values: [encoded, sign * numeric, sign],
                    }),
                );
            }

            for (const encoded of touched) {
                // eslint-disable-next-line no-await-in-loop -- sequential prune on the shared D1 connection (see above).
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
                sql`SELECT ${sql.identifier("__value__")} AS value, ${sql.identifier("__count__")} AS count FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded}`,
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
     * `ensureBackfilled`. TRUNCATE then re-insert; cached per ctx-db. Pages
     * the source table via keyset cursor on `id` so an unbounded table never
     * has to fit in a single SELECT.
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
        const insertColumnList = sql.join(
            ["__id__", "__partition__", ...sortColumns].map((column) => sql`${sql.identifier(column)}`),
            sql`, `,
        );

        // Collect the rank tuples during the keyset scan, then insert them
        // sequentially below (the scan callback can't itself await on the
        // shared connection).
        const rankTuples: unknown[][] = [];

        await forEachRowPaged(exec, dialect, definition, tableName, (document) => {
            if (index.where && !matchesRankStaticWhere(document, index.where)) {
                return;
            }

            const partitionKey = encodePartitionKey(index.partitionBy ?? [], document);
            // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent sort-key column must bind `null`, not undefined.
            const sortValues = index.sortBy.map((key) => serializeColumnValue(document[key.field] ?? null));

            rankTuples.push([document["_id"], partitionKey, ...sortValues]);
        });

        for (const tuple of rankTuples) {
            const valueList = sql.join(
                tuple.map((value) => sql`${value}`),
                sql`, `,
            );

            // eslint-disable-next-line no-await-in-loop -- rank rows are inserted sequentially on the single shared D1 connection; SqlCtxExec exposes no batch API here.
            await queryRun(exec, dialect, sql`INSERT INTO ${sql.identifier(rankTable)} (${insertColumnList}) VALUES (${valueList})`);
        }

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
                const columnList = sql.join(
                    ["__id__", "__partition__", ...sortColumns].map((column) => sql`${sql.identifier(column)}`),
                    sql`, `,
                );
                const partitionKey = encodePartitionKey(index.partitionBy ?? [], next);
                // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent sort-key column must bind `null`, not undefined.
                const sortValues = index.sortBy.map((key) => serializeColumnValue(next[key.field] ?? null));
                const valueList = sql.join(
                    [id, partitionKey, ...sortValues].map((value) => sql`${value}`),
                    sql`, `,
                );

                // eslint-disable-next-line no-await-in-loop -- sequential companion INSERT on the shared D1 connection (see above).
                await queryRun(exec, dialect, sql`INSERT INTO ${sql.identifier(rankTable)} (${columnList}) VALUES (${valueList})`);
            }
        }
    };

    /**
     * Keep the FTS5 shadow tables in step with a row write. A no-op when the
     * table declares no search indexes or when FTS5 is unavailable (the scan
     * fallback reads the live table, so nothing to mirror). Delete then insert
     * makes it idempotent across insert/update; `document === undefined` deletes
     * only (row removal). The DO twin gates on the same availability probe.
     */
    const syncSearch = async (tableName: string, id: string, document: Record<string, unknown> | undefined): Promise<void> => {
        const indexes = schema.tables[tableName]?.searchIndexes;

        if (!indexes || indexes.length === 0 || !(await isFtsAvailable(exec))) {
            return;
        }

        for (const index of indexes) {
            const ftName = ftsTableName(tableName, index.name);

            // eslint-disable-next-line no-await-in-loop -- FTS syncs run sequentially on the single shared D1 connection so DELETE/INSERT pairs don't interleave across indexes.
            await queryRun(exec, dialect, sql`DELETE FROM ${sql.identifier(ftName)} WHERE ${sql.identifier("__id__")} = ${id}`);

            if (document) {
                // eslint-disable-next-line no-await-in-loop -- sequential companion INSERT on the shared D1 connection (see above).
                await queryRun(
                    exec,
                    dialect,
                    sql`INSERT INTO ${sql.identifier(ftName)} (${sql.identifier("__text__")}, ${sql.identifier("__id__")}) VALUES (${stringifySearchText(document[index.field])}, ${id})`,
                );
            }
        }
    };

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
            if (isUniqueViolation(error)) {
                throw new ConflictError(`unique constraint violation on "${table}"`, "unique");
            }

            throw error;
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
     * expressed as `WHERE "id" IS ? AND "&lt;col>" IS ? ... RETURNING "id"` run via
     * `exec.all` (both D1 and node:sqlite support `RETURNING`). The bound values
     * are the RAW column values captured at read time ({@link rawRow}) so the
     * comparison is faithful; `IS` gives NULL-safe equality. An empty RETURNING
     * set means a concurrent write committed during the intervening `await` and
     * changed the row — surfaced as a {@link ConflictError}.
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

        const guardClause = sql.join(
            Object.keys(snapshot).map((column) => nullSafeEquals(sql`${sql.identifier(column)}`, snapshot[column])),
            sql` AND `,
        );
        const base =
            verb === "UPDATE"
                ? sql`UPDATE ${sql.identifier(table)} SET ${setClause} WHERE ${guardClause}`
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
            if (isUniqueViolation(error)) {
                throw new ConflictError(`unique constraint violation on "${table}"`, "unique");
            }

            throw error;
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
                sql`SELECT ${sql.identifier("__value__")} AS value, ${sql.identifier("__count__")} AS count FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded}`,
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
            sql`SELECT ${sql.identifier("__key__")} AS key, ${sql.identifier("__value__")} AS value, ${sql.identifier("__count__")} AS count FROM ${sql.identifier(aggTable)}`,
        );

        return rowsIndexed.map((row) => {
            const typed = row as { count: number; key: string; value: null | number };

            return {
                key: JSON.parse(typed.key) as Record<string, unknown>,
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

    // Backend-routed child fetch for the relation pre-resolver, available to the
    // aggregate/count/groupBy paths (the `findMany` method aliases this for its
    // nested `with` load). Mutually recursive with `writer`, so it reads
    // `writer` at call time.
    const relationPredicateFetcher: DatabaseWriterLike["findMany"] = (childTable, childArgs) => {
        if (!isShardLocalTarget(childTable)) {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure read of post-construction `writer`
            return writer.findMany(childTable, childArgs);
        }

        return crossShardReader ? crossShardReader(childTable, childArgs) : crossBackendUnsupported(childTable);
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

    const writer: DatabaseWriterLike = {
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
                            sql`SELECT ${sql.identifier("__value__")} AS value, ${sql.identifier("__count__")} AS count FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded}`,
                        );
                        const row = rows[0] as { count: number; value: null | number } | undefined;

                        return readAggregateValue(aggOptions.op, row === undefined ? undefined : { count: row.count, value: aggregateScalar(row.value) });
                    }
                }
            }

            const whereCondition = compileWhereSql(resolved, whereSqlStrategy);
            const aggregateFunction = sql.raw(aggregateSqlFunction(aggOptions.op));
            const query = sql`SELECT ${aggregateFunction}(${columnRefSql(aggOptions.field)}) AS value FROM ${sql.identifier(tableName)}`;
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
                            sql`SELECT ${sql.identifier("__value__")} AS value FROM ${sql.identifier(aggTable)} WHERE ${sql.identifier("__key__")} = ${encoded}`,
                        );

                        return Number(rows[0]?.["value"] ?? 0);
                    }
                }
            }

            const whereCondition = compileWhereSql(resolved, whereSqlStrategy);
            const query = sql`SELECT COUNT(*) AS count FROM ${sql.identifier(tableName)}`;
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
                await syncSearch(tableName, id, merged);
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

            const orderKeys = normalizeOrderKeys(args.orderBy);
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

                let groupQuery = sql`SELECT ${fieldRef} AS __fk__, COUNT(*) AS count FROM ${sql.identifier(childTable)}`;

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
            // hop (the `with`-load `resolveWith` calls below omit it — a separate
            // pre-existing gap; the pre-resolver does not depend on that).
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
            const orderBy = compileOrderBySql(orderKeys);

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
                await resolveWith({ fetcher: relationFetcher, groupedCounter: relationGroupedCounter, parents: page, schema, tableName, with: args.with });
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

            const rows = await queryAll(exec, dialect, sql`SELECT * FROM ${sql.identifier(tableName)} WHERE ${sql.identifier("id")} = ${id}`);

            return decodeRow(definition, rows[0]);
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

            const whereCondition = compileWhereSql(resolved, whereSqlStrategy);

            const select: SQL[] = groupOptions.by.map((field) => sql`${columnRefSql(field)} AS ${sql.identifier(field)}`);

            if (agg.op === "count") {
                select.push(sql`COUNT(*) AS value`);
            } else {
                // `agg.field` is asserted present for non-count reducers by the
                // guard above; re-check locally so the column ref stays typed
                // without a non-null assertion.
                if (!agg.field) {
                    throw new LunoraError("INTERNAL", `groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
                }

                select.push(sql`${sql.raw(aggregateSqlFunction(agg.op))}(${columnRefSql(agg.field)}) AS value`);
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
            const columnList = sql.join(
                columns.map((column) => sql`${sql.identifier(column)}`),
                sql`, `,
            );
            const valueList = sql.join(
                values.map((value) => sql`${value}`),
                sql`, `,
            );

            await runWrite(tableName, sql`INSERT INTO ${sql.identifier(tableName)} (${columnList}) VALUES (${valueList})`);

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
            runRowValidators(definition, merged);

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
            await syncSearch(tableName, id, merged);
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
            const runSearch = async (stage: SearchStage, limit: number | undefined): Promise<Record<string, unknown>[]> => {
                // Ensure the fts5 shadow table exists before a MATCH reads it;
                // on a no-fts5 engine the scan fallback reads the live table.
                await ensureMigrated();

                return (await isFtsAvailable(exec))
                    ? searchViaFts(exec, dialect, definition, tableName, stage, limit)
                    : searchViaScan(exec, dialect, definition, tableName, stage, limit);
            };

            const buildReader = (stage: SearchStage | undefined): TableReaderLike => {
                const reader: TableReaderLike = {
                    async collect() {
                        if (!stage) {
                            throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
                        }

                        return runSearch(stage, undefined);
                    },
                    filter() {
                        throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
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
                    // eslint-disable-next-line @typescript-eslint/require-await -- TableReaderLike.paginate returns a Promise; search queries don't support pagination on either backend
                    async paginate() {
                        if (stage) {
                            throw new LunoraError("INTERNAL", "pagination is not supported on search queries; use .take(n) or .collect()");
                        }

                        throw new LunoraError("INTERNAL", LEGACY_READER_ERROR);
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

                        search(createSearchBuilder(searchStage, tableName) as Parameters<typeof search>[0]);

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
            const selectList = sql.join([sql`${sql.identifier("__partition__")}`, ...sortColumns.map((column) => sql`${sql.identifier(column)}`)], sql`, `);
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

            if (partitionFromWhere) {
                whereClauses.push(sql`${sql.identifier("__partition__")} = ${encodePartitionKey(index.partitionBy ?? [], partitionFromWhere)}`);
            }

            if (rankPageOptions.cursor) {
                const seek = buildRankCursorSeek(dialect.name, rankColumns, decodeCursor(rankPageOptions.cursor));

                if (seek !== undefined) {
                    whereClauses.push(seek);
                }
            }

            const selectColumns = sql.join(
                [
                    sql`${sql.identifier(RANK_TIEBREAK)}`,
                    sql`${sql.identifier("__partition__")}`,
                    ...sortColumns.map((column) => sql`${sql.identifier(column)}`),
                ],
                sql`, `,
            );

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
            await syncSearch(tableName, id, replaced);
            await recordCdc(tableName, id, "update", replaced);

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: replaced, id, op: "update", previous, table: tableName });
            }
        },
    };

    triggerContext = { db: writer, scheduler };

    return writer;
};

export {
    createSqlCtxDb,
    decodeGlobalRow,
    readSqlCdcChanges,
    runSqlAggregateMigrations,
    runSqlCdcMigration,
    runSqlGlobalTableMigrations,
    runSqlRankMigrations,
    runSqlSearchMigrations,
    trimSqlCdcChanges,
};
export type { SqlCtxDbOptions, SqlCtxExec };
