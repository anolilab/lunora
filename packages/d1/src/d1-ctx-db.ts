/**
 * D1 column-dialect twin of the DO `createShardCtxDb` (`@lunora/do`).
 *
 * Global (`.global()`) tables live in D1 with a real column-per-field physical
 * schema — not the DO's JSON blob — so `where`/`orderBy`/keyset-cursor refer to
 * actual columns (`"field"`) rather than `json_extract(...)`. The query and
 * cursor logic is identical to the DO path: it reuses the shared, dialect-
 * agnostic compiler (`compileWhere`), order-by builder, and keyset helpers from
 * `@lunora/do`, swapping only the {@link WhereCompilerStrategy} (column refs +
 * value serialization) so the generated `ctx.db.&lt;table>` facade (1.2.7) is
 * backend-agnostic.
 */
/* eslint-disable unicorn/prevent-abbreviations -- "d1-ctx-db" is the established public module name: src/index.ts and every test import it as "./d1-ctx-db.js", and it deliberately mirrors @lunora/do's "ctx-db.ts" twin. Renaming would break those importers. */
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
    TableDefinitionLike,
    TableReaderLike,
    TriggerContextLike,
    TriggerEventLike,
    TriggerOpLike,
    TriggerTimingLike,
    ValidatorLike,
    WhereCompilerStrategy,
    WhereInput,
} from "@lunora/do";
import {
    aggregateSqlFunction,
    aggregateTableName,
    applyOnDelete,
    assertValidClientId,
    buildFtsMatch,
    buildSeekWhere,
    coerceAggregateNumber,
    compileOrderBy,
    compileWhere,
    ConflictError,
    CountRlsUnsupportedError,
    decodeCursor,
    encodeAggregateKey,
    encodeCursor,
    encodePartitionKey,
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
    resolveRankPartition,
    resolveRelationPredicates,
    resolveWith,
    runRowValidators,
    runTriggers,
    scoreDocument,
    selectIndexForAggregate,
    selectIndexForCount,
    selectIndexForGroupBy,
    sortColumnName,
    stringifySearchText,
    throwingScheduler,
    tokenizeSearch,
} from "@lunora/do";

import { columnRef, frameworkColumnDdl, physicalIndexName, quoteIdentifier, sqlAffinityForKind } from "./dialect";

/**
 * Async SQL surface the D1 ORM needs: `all` for reads, `run` for writes.
 * Satisfied by a `D1Session`/`D1Client` in production and a `node:sqlite`
 * adapter in tests, so the query logic runs against a real SQLite engine.
 */
interface D1Exec {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    run: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<void>;
}

interface D1ContextDatabaseOptions {
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
     * Cross-shard counter for **reverse cross-backend relations** — mirrors
     * {@link D1ContextDatabaseOptions.crossShardReader} for `_count`.
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
    exec: D1Exec;
    idGenerator?: () => string;

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

/** Map a JS value onto its SQLite storage form — SQLite has no boolean, so true/false → 1/0. */
const serializeColumnValue = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    return JSON.stringify(value);
};

/** D1 dialect: fields resolve to real columns; values via {@link serializeColumnValue}. */
const d1WhereStrategy: WhereCompilerStrategy = { fieldRef: columnRef, serialize: serializeColumnValue };

/**
 * Memoized per-`D1Exec` FTS5 capability probe. D1's SQLite ships FTS5;
 * `node:sqlite` (used in tests) does not. We create and drop a throwaway virtual
 * table once per handle and cache the resolving promise — the exec handle is
 * stable for the ctx-db's lifetime, so this runs at most once per binding. The
 * cached value is a `Promise` so concurrent first-callers share the single probe
 * rather than racing two CREATE/DROP round-trips.
 */
const ftsAvailabilityCache = new WeakMap<D1Exec, Promise<boolean>>();

const isFtsAvailable = (exec: D1Exec): Promise<boolean> => {
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
 * Inverse of {@link serializeColumnValue}: map a SQLite storage value back onto
 * its JS form, driven by the field's declared validator `kind`. Without this,
 * `serializeColumnValue` JSON-encodes objects/arrays/records and stringifies
 * bigints on write, but reads return those storage strings verbatim — so a
 * stored `{x:1}` comes back as the literal string `'{"x":1}'`, a bigint as a
 * decimal string, etc. The decode reverses each serialized case:
 *
 * - `boolean`: 1/0 → true/false (SQLite has no boolean type).
 * - `bigint`: decimal string → `BigInt`.
 * - `object`/`array`/`record`: JSON string → parsed value.
 * - `union`/`any`: these only get JSON-encoded when the runtime value was
 * non-scalar, so a stored *string* is parsed back when it is valid JSON for a
 * non-scalar shape, and otherwise returned as-is (a scalar union member
 * round-trips through SQLite's native column type, never as JSON).
 * - everything else (string/number/date/timestamp/id/literal): stored natively,
 * returned verbatim.
 *
 * `v.optional(inner)` columns are decoded by their inner kind (see
 * {@link effectiveColumnKind}) — the optional wrapper only affects insert-time
 * presence, never the storage form of a present value.
 */
/** Parse `raw` as JSON, returning `raw` unchanged when it is not valid JSON. */
const tryJsonParse = (raw: string): unknown => {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return raw;
    }
};

/** Decode a `bigint` column: a decimal string back into a `BigInt`, else verbatim. */
const decodeBigint = (raw: unknown): unknown => {
    if (typeof raw !== "string") {
        return raw;
    }

    try {
        return BigInt(raw);
    } catch {
        return raw;
    }
};

/**
 * Resolve the *effective* storage kind of a column validator. `serializeColumnValue`
 * encodes by the runtime value's JS type, so an `v.optional(inner)` column stores
 * its present value exactly as `inner` would (boolean → 1/0, object → JSON, …).
 * The validator's own `kind` is `"optional"`, which hides that — unwrap to the
 * inner validator's kind so the decode reverses the real storage form. The inner
 * validator is stashed on `_meta.inner` by `@lunora/values`' `createValidator`.
 */
const effectiveColumnKind = (validator: ValidatorLike): string | undefined => {
    if (validator.kind !== "optional") {
        return validator.kind;
    }

    const inner = (validator._meta as { inner?: ValidatorLike } | undefined)?.inner;

    return inner ? effectiveColumnKind(inner) : validator.kind;
};

const decodeColumnValue = (kind: string | undefined, raw: unknown): unknown => {
    if (raw === null) {
        return raw;
    }

    switch (kind) {
        case "any":
        case "union": {
            // Scalars round-trip natively; only a JSON-encoded non-scalar was
            // ever stored as a string. Parse those, but leave plain strings
            // (the value really was a string) untouched.
            return typeof raw === "string" && (raw.startsWith("{") || raw.startsWith("[")) ? tryJsonParse(raw) : raw;
        }
        case "array":
        case "object":
        case "record": {
            return typeof raw === "string" ? tryJsonParse(raw) : raw;
        }
        case "bigint": {
            return decodeBigint(raw);
        }
        case "boolean": {
            return raw === 0 || raw === 1 ? raw === 1 : raw;
        }
        default: {
            return raw;
        }
    }
};

/**
 * Decode a SELECTed row back into a document: `id` → `_id`, `_creationTime`
 * preserved, and every column run through {@link decodeColumnValue} so the
 * stored form is reversed back into its JS shape. Exported so the data-browser
 * (`introspect.ts`) and admin export/import paths share the exact same decode.
 */
const decodeGlobalRow = (definition: TableDefinitionLike, row: Record<string, unknown>): Record<string, unknown> => {
    const decoded: Record<string, unknown> = {};

    for (const [field, validator] of Object.entries(definition.shape)) {
        const raw = row[field];

        if (raw === undefined) {
            continue;
        }

        decoded[field] = decodeColumnValue(effectiveColumnKind(validator), raw);
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
 */
const applyInsertDefaults = (definition: TableDefinitionLike, document: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...document };

    for (const [field, column] of tableColumns(definition)) {
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
const applyOnUpdate = (definition: TableDefinitionLike, provided: Record<string, unknown>, target: Record<string, unknown>): void => {
    for (const [field, column] of tableColumns(definition)) {
        if (column.onUpdateFn && !(field in provided)) {
            // Deliberate in-place mutation: callers pass the row they want
            // updated (e.g. `merged`/`replaced`) so the recomputed onUpdate
            // values land on the object that is about to be persisted.
            // eslint-disable-next-line no-param-reassign -- documented mutate-in-place contract (see jsdoc above)
            target[field] = column.onUpdateFn();
        }
    }
};

/** Both workerd and node:sqlite phrase a UNIQUE-index breach as "UNIQUE constraint failed". Hoisted to avoid per-call recompilation. */
const UNIQUE_VIOLATION_RE = /unique constraint failed/i;

/** Both workerd and node:sqlite phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const isUniqueViolation = (error: unknown): boolean => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message);

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
        get: (id) => {
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
            } else if (map.size >= TABLE_NAME_CACHE_CAPACITY) {
                const oldest = map.keys().next().value;

                if (oldest !== undefined) {
                    map.delete(oldest);
                }
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
const tableNameFromId = async (exec: D1Exec, schema: SchemaLike, id: string, cache: ReturnType<typeof createTableNameCache>): Promise<string | undefined> => {
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
            const rows = await exec.all(`SELECT 1 FROM ${quoteIdentifier(tableName)} WHERE "id" = ? LIMIT 1`, [id]);

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
    exec: D1Exec,
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
    const where: string[] = [`f."__text__" MATCH ?`];
    const params: unknown[] = [buildFtsMatch(tokens)];

    for (const filter of search.filters) {
        where.push(`m.${columnRef(filter.field)} = ?`);
        params.push(serializeColumnValue(filter.value));
    }

    // `f.rank` is FTS5's bm25 relevance (best first); the `_creationTime DESC`
    // tiebreak matches the scan fallback so equal-rank rows order newest-first
    // on both engines.
    let querySql = `SELECT m.* FROM ${quoteIdentifier(ftName)} f JOIN ${quoteIdentifier(tableName)} m ON m."id" = f."__id__" WHERE ${where.join(" AND ")} ORDER BY f.rank, m."_creationTime" DESC`;

    if (typeof limit === "number") {
        querySql += ` LIMIT ${String(Math.max(0, Math.floor(limit)))}`;
    }

    const rows = await exec.all(querySql, params);

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
    exec: D1Exec,
    definition: TableDefinitionLike,
    tableName: string,
    search: SearchStage,
    limit: number | undefined,
): Promise<Record<string, unknown>[]> => {
    const tokens = tokenizeSearch(search.query);

    if (tokens.length === 0) {
        return [];
    }

    const where: string[] = [];
    const params: unknown[] = [];

    for (const filter of search.filters) {
        where.push(`${columnRef(filter.field)} = ?`);
        params.push(serializeColumnValue(filter.value));
    }

    let querySql = `SELECT * FROM ${quoteIdentifier(tableName)}`;

    if (where.length > 0) {
        querySql += ` WHERE ${where.join(" AND ")}`;
    }

    const rows = await exec.all(querySql, params);
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
                throw new Error(`field "${field}" is not a filter field of search index "${search.indexName}" on table "${tableName}"`);
            }

            search.filters.push({ field, value });

            return builder;
        },
        search: (field: string, query: string) => {
            if (field !== search.definition.field) {
                throw new Error(`search index "${search.indexName}" on table "${tableName}" indexes "${search.definition.field}", not "${field}"`);
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
 * Build the lexicographic "strictly before" OR-of-AND branches for a rank
 * position count. Each pivot fixes the higher-priority sort columns with `IS ?`
 * equality and applies the directional less-than/greater-than comparison on the
 * pivot column; the final branch tie-breaks on the id column. Returns the SQL
 * branch strings and their bind params in matching order.
 */
const buildRankBeforeBranches = (
    index: RankIndexDefinitionLike,
    sortColumns: ReadonlyArray<string>,
    own: Record<string, unknown>,
    rowId: string,
): { branches: string[]; params: unknown[] } => {
    const branches: string[] = [];
    const params: unknown[] = [];

    for (let pivot = 0; pivot < sortColumns.length + 1; pivot += 1) {
        const conditions: string[] = [];

        for (let prefix = 0; prefix < pivot; prefix += 1) {
            const prefixColumn = sortColumns[prefix];

            if (prefixColumn === undefined) {
                continue;
            }

            conditions.push(`${quoteIdentifier(prefixColumn)} IS ?`);
            params.push(own[prefixColumn]);
        }

        const column = sortColumns[pivot];
        const sortKey = index.sortBy[pivot];

        if (pivot < sortColumns.length && column !== undefined && sortKey !== undefined) {
            conditions.push(`${quoteIdentifier(column)} ${sortKey.direction === "desc" ? ">" : "<"} ?`);
            params.push(own[column]);
        } else {
            conditions.push(`${quoteIdentifier(RANK_TIEBREAK)} < ?`);
            params.push(rowId);
        }

        branches.push(conditions.length === 1 ? conditions.join(" AND ") : `(${conditions.join(" AND ")})`);
    }

    return { branches, params };
};

/**
 * Build the lexicographic seek predicate for a rankPage cursor. `columns` is the
 * ordered `[partition, ...sortColumns, id]` tuple with each column's direction;
 * `decoded` is the cursor's value tuple. Pushes its bind params onto `params`
 * (after any already present) and returns the `(... OR ...)` clause, or
 * `undefined` when the decoded cursor length doesn't match the column tuple.
 */
const buildRankCursorSeek = (
    columns: ReadonlyArray<{ column: string; direction: "asc" | "desc" }>,
    decoded: ReadonlyArray<unknown>,
    params: unknown[],
): string | undefined => {
    if (decoded.length !== columns.length) {
        return undefined;
    }

    const branches: string[] = [];

    for (const [pivot, col] of columns.entries()) {
        const conditions: string[] = [];

        for (let prefix = 0; prefix < pivot; prefix += 1) {
            const prefixCol = columns[prefix];

            if (prefixCol === undefined) {
                continue;
            }

            conditions.push(`${quoteIdentifier(prefixCol.column)} IS ?`);
            params.push(decoded[prefix]);
        }

        conditions.push(`${quoteIdentifier(col.column)} ${col.direction === "desc" ? "<" : ">"} ?`);
        params.push(decoded[pivot]);
        branches.push(conditions.length === 1 ? conditions.join(" AND ") : `(${conditions.join(" AND ")})`);
    }

    return `(${branches.join(" OR ")})`;
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
        throw new Error(`rankIndex "${index.name}" requires at least one "sortBy" column for stable pagination`);
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
    exec: D1Exec,
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
            const placeholders = chunk.map(() => "?").join(", ");

            return exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" IN (${placeholders})`, chunk);
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
    exec: D1Exec,
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
                  await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} ORDER BY "id" ASC LIMIT ?`, [BACKFILL_BATCH_SIZE])
                : // eslint-disable-next-line no-await-in-loop -- keyset paging is inherently sequential: each page's WHERE depends on the prior page's last id.
                  await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" > ? ORDER BY "id" ASC LIMIT ?`, [cursorId, BACKFILL_BATCH_SIZE]);

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
const globalColumnAffinity = (validator: ValidatorLike): ReturnType<typeof sqlAffinityForKind> => sqlAffinityForKind(effectiveColumnKind(validator));

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
/** Build the column DDL for a global table: framework columns plus a typed column per declared field. */
const globalTableColumnsDdl = (definition: SchemaLike["tables"][string]): string => {
    const fieldColumns: string[] = [];

    for (const [field, validator] of Object.entries(definition.shape)) {
        if (!validator._meta?.column) {
            continue;
        }

        // Required, non-optional fields get NOT NULL; optional ones stay nullable
        // so an insert that omits them can't trip a constraint.
        const notNull = validator._meta.column.notNull && validator.kind !== "optional" ? " NOT NULL" : "";

        fieldColumns.push(`${quoteIdentifier(field)} ${globalColumnAffinity(validator)}${notNull}`);
    }

    return [...frameworkColumnDdl(), ...fieldColumns].join(", ");
};

/** Create a global table's declared secondary indexes and its synthesized `.unique()` column indexes. */
const createGlobalTableIndexes = async (exec: D1Exec, tableName: string, definition: SchemaLike["tables"][string]): Promise<void> => {
    for (const index of definition.indexes) {
        const expressions = index.fields.map((field) => columnRef(field)).join(", ");

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection.
        await exec.run(
            `CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${physicalIndexName(tableName, index.name)} ON ${quoteIdentifier(tableName)} (${expressions})`,
            [],
        );
    }

    // `.unique()` columns synthesize a UNIQUE index so SQLite enforces the
    // constraint (the write layer maps breaches to ConflictError), mirroring the
    // DO twin's `migrateSecondaryIndexes`.
    for (const [field, column] of tableColumns(definition)) {
        if (!column.unique) {
            continue;
        }

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection.
        await exec.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tableName}_unique_${field}`)} ON ${quoteIdentifier(tableName)} (${columnRef(field)})`,
            [],
        );
    }
};

const runD1GlobalTableMigrations = async (exec: D1Exec, schema: SchemaLike): Promise<void> => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        if (definition.shardMode?.kind !== "global") {
            continue;
        }

        const columns = globalTableColumnsDdl(definition);

        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the single shared D1 connection; the table must exist before its indexes below.
        await exec.run(`CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${columns})`, []);
        // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially; indexes follow the table.
        await createGlobalTableIndexes(exec, tableName, definition);
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
const runD1AggregateMigrations = async (exec: D1Exec, schema: SchemaLike): Promise<void> => {
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
            // eslint-disable-next-line no-await-in-loop -- DDL statements run sequentially on the single shared D1 connection.
            await exec.run(
                `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(aggTable)} (
                    "__key__" TEXT PRIMARY KEY,
                    "__value__" REAL,
                    "__count__" INTEGER NOT NULL DEFAULT 0
                )`,
                [],
            );

            // Alpha-era companion-rebuild caveat: a binding that materialized
            // this table before `__count__` existed gets the column added here
            // (defaulted 0). `CREATE TABLE IF NOT EXISTS` won't reshape an
            // existing table, so we pragma-check then ALTER — the first read/
            // write that touches the index re-backfills with real per-op values.
            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection.
            const columns = await exec.all(`PRAGMA table_info(${quoteIdentifier(aggTable)})`, []);

            if (!columns.some((column) => column["name"] === "__count__")) {
                // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection.
                await exec.run(`ALTER TABLE ${quoteIdentifier(aggTable)} ADD COLUMN "__count__" INTEGER NOT NULL DEFAULT 0`, []);
            }
        }
    }
};

/**
 * Materialize the `__rank_&lt;index>` companion tables for every declared
 * `rankIndex` on a global table. Mirrors `runD1AggregateMigrations` — same
 * opt-in pattern so production hosts decide whether to spend the DDL.
 *
 * Idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`).
 */
const runD1RankMigrations = async (exec: D1Exec, schema: SchemaLike): Promise<void> => {
    for (const [tableName, definition] of Object.entries(schema.tables)) {
        const indexes = definition.rankIndexes;

        if (!indexes || indexes.length === 0) {
            continue;
        }

        for (const index of indexes) {
            const rankTable = rankTableName(tableName, index.name);
            const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
            const columnDdl = sortColumns.map((column) => `${quoteIdentifier(column)} BLOB`).join(", ");
            const columnPart = sortColumns.length > 0 ? `, ${columnDdl}` : "";

            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection; the table must exist before its index below.
            await exec.run(
                `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(rankTable)} (
                    "__id__" TEXT PRIMARY KEY,
                    "__partition__" TEXT NOT NULL${columnPart}
                )`,
                [],
            );

            const orderedColumns = ['"__partition__" ASC'];

            for (const [i, sortKey] of index.sortBy.entries()) {
                orderedColumns.push(`${quoteIdentifier(sortColumnName(i))} ${sortKey.direction === "desc" ? "DESC" : "ASC"}`);
            }

            orderedColumns.push('"__id__" ASC');

            const btreeName = `${tableName}__rank_${index.name}__btree`;

            // eslint-disable-next-line no-await-in-loop -- DDL runs sequentially on the shared D1 connection (the CREATE INDEX follows its CREATE TABLE).
            await exec.run(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(btreeName)} ON ${quoteIdentifier(rankTable)} (${orderedColumns.join(", ")})`, []);
        }
    }
};

/**
 * Materialize the `__fts_&lt;index>` FTS5 shadow tables for every declared
 * `.searchIndex()` on a global table. Mirrors `runD1AggregateMigrations` — same
 * opt-in pattern so production hosts decide whether to spend the DDL. Only runs
 * on engines that ship FTS5 (D1 does; the `node:sqlite` test runner doesn't,
 * where `.search()` transparently falls back to a scan). `__text__` holds the
 * indexed field; `__id__` (UNINDEXED) joins back to the row.
 *
 * Idempotent (`CREATE VIRTUAL TABLE IF NOT EXISTS`).
 */
const runD1SearchMigrations = async (exec: D1Exec, schema: SchemaLike): Promise<void> => {
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

            // eslint-disable-next-line no-await-in-loop -- DDL statements run sequentially on the single shared D1 connection.
            await exec.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdentifier(ftName)} USING fts5("__text__", "__id__" UNINDEXED)`, []);
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

/** Create the `__cdc_log` table in D1. Idempotent; only run when CDC is enabled. */
const runD1CdcMigration = async (exec: D1Exec): Promise<void> => {
    await exec.run(
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(CDC_LOG_TABLE)} (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            ts REAL NOT NULL,
            "table" TEXT NOT NULL,
            id TEXT NOT NULL,
            op TEXT NOT NULL,
            doc TEXT
        )`,
        [],
    );
};

/** Append one committed mutation to the changelog (post-image JSON, or NULL for delete). */
const appendD1CdcChange = async (
    exec: D1Exec,
    ts: number,
    table: string,
    id: string,
    op: CdcChange["op"],
    doc: Record<string, unknown> | undefined,
): Promise<void> => {
    await exec.run(
        `INSERT INTO ${quoteIdentifier(CDC_LOG_TABLE)} (ts, "table", id, op, doc) VALUES (?, ?, ?, ?, ?)`,
        // eslint-disable-next-line unicorn/no-null -- SQL NULL is the correct post-image for a delete; the `id` identifies the removed row.
        [ts, table, id, op, doc === undefined ? null : JSON.stringify(doc)],
    );
};

/**
 * Read changelog entries newer than `sinceSeq` in commit order, up to `limit`
 * (clamped to [1, 10000]); plus the cursor to resume from.
 */
const readD1CdcChanges = async (exec: D1Exec, options: { limit?: number; sinceSeq?: number } = {}): Promise<{ changes: CdcChange[]; cursor: number }> => {
    const sinceSeq = options.sinceSeq ?? 0;
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));

    const rows = await exec.all(`SELECT seq, ts, "table", id, op, doc FROM ${quoteIdentifier(CDC_LOG_TABLE)} WHERE seq > ? ORDER BY seq ASC LIMIT ?`, [
        sinceSeq,
        limit,
    ]);

    const changes = rows.map((row): CdcChange => {
        const { doc } = row;
        const base = { id: String(row.id), op: String(row.op) as CdcChange["op"], seq: Number(row.seq), table: String(row.table), ts: Number(row.ts) };

        return typeof doc === "string" ? { ...base, doc: JSON.parse(doc) as Record<string, unknown> } : base;
    });

    return { changes, cursor: changes.at(-1)?.seq ?? sinceSeq };
};

/** Drop changelog entries at or below a checkpointed `throughSeq` (retention). */
const trimD1CdcChanges = async (exec: D1Exec, throughSeq: number): Promise<void> => {
    await exec.run(`DELETE FROM ${quoteIdentifier(CDC_LOG_TABLE)} WHERE seq <= ?`, [throughSeq]);
};

const createD1ContextDatabase = (options: D1ContextDatabaseOptions): DatabaseWriterLike => {
    const { crossShardCounter, crossShardReader, exec, schema } = options;
    const clock = options.clock ?? (() => Date.now());
    const generateId = options.idGenerator ?? (() => crypto.randomUUID());
    const cdcEnabled = options.cdc ?? false;

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
            await appendD1CdcChange(exec, clock(), table, id, op, doc);
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
            await runD1GlobalTableMigrations(exec, schema);
            await runD1AggregateMigrations(exec, schema);
            await runD1RankMigrations(exec, schema);
            await runD1SearchMigrations(exec, schema);

            if (cdcEnabled) {
                await runD1CdcMigration(exec);
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

        const tableName = await tableNameFromId(exec, schema, id, tableNameCache);

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
     * SCAN-based count. The same opt-in shape is what `runD1AggregateMigrations`
     * (the helper exported for tests/dev hosts) uses to materialize it.
     */
    const counterTableExists = async (table: string, indexName: string): Promise<boolean> => {
        const aggTable = aggregateTableName(table, indexName);
        const rows = await exec.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [aggTable]);

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
        await forEachRowPaged(exec, definition, tableName, (document) => {
            if (index.where && !matchesStaticWhere(document, index.where)) {
                return;
            }

            const encoded = encodeAggregateKey(by, document);

            foldAggregateTally(tallies, encoded, index, document);
        });

        const aggTable = aggregateTableName(tableName, index.name);

        await exec.run(`DELETE FROM ${quoteIdentifier(aggTable)}`, []);

        for (const [encoded, tally] of tallies) {
            // eslint-disable-next-line no-await-in-loop -- counter rows are inserted sequentially on the single shared D1 connection; D1Exec exposes no batch API here.
            await exec.run(`INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, ?)`, [
                encoded,
                tally.value,
                tally.count,
            ]);
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
        const conditions: string[] = [];
        const params: unknown[] = [];

        for (const key of index.by ?? []) {
            // eslint-disable-next-line unicorn/no-null -- canonical key tuple: a missing by-field is matched as NULL, mirroring encodeAggregateKey's null-fill
            const value = serializeColumnValue(document[key] ?? null);

            if (value === null) {
                conditions.push(`${columnRef(key)} IS NULL`);
            } else {
                conditions.push(`${columnRef(key)} = ?`);
                params.push(value);
            }
        }

        for (const [key, expected] of Object.entries(index.where ?? {})) {
            const literal = expected !== null && typeof expected === "object" && !Array.isArray(expected) ? (expected as { eq: unknown }).eq : expected;
            const value = serializeColumnValue(literal);

            if (value === null) {
                conditions.push(`${columnRef(key)} IS NULL`);
            } else {
                conditions.push(`${columnRef(key)} = ?`);
                params.push(value);
            }
        }

        const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
        const rows = await exec.all(`SELECT ${sqlFunction}(${columnRef(field)}) AS value FROM ${quoteIdentifier(tableName)}${whereSql}`, params);

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
        await exec.run(`DELETE FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ? AND "__count__" <= 0`, [encoded]);
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

                // eslint-disable-next-line no-await-in-loop -- sequential counter step on the shared D1 connection
                await exec.run(
                    `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, ?)
                     ON CONFLICT("__key__") DO UPDATE SET "__value__" = "__value__" + excluded."__value__", "__count__" = "__count__" + excluded."__count__"`,
                    [encoded, delta, delta],
                );
            }

            for (const encoded of touched) {
                // eslint-disable-next-line no-await-in-loop -- sequential prune on the shared D1 connection (see above).
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

                // eslint-disable-next-line no-await-in-loop -- sequential counter step on the shared D1 connection
                await exec.run(
                    `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, ?)
                     ON CONFLICT("__key__") DO UPDATE SET "__value__" = COALESCE("__value__", 0) + excluded."__value__", "__count__" = "__count__" + excluded."__count__"`,
                    [encoded, sign * numeric, sign],
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
            const existingRows = await exec.all(`SELECT "__value__" AS value, "__count__" AS count FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, [
                encoded,
            ]);
            const existing = existingRows[0] as { count: number; value: null | number } | undefined;
            const existingValue = aggregateScalar(existing?.value);
            const remainingCount = (existing?.count ?? 0) - 1;

            if (remainingCount <= 0) {
                // Last contributing row left: remove the group row entirely so
                // the indexed `groupBy` walk omits it (a zeroed row would surface
                // a phantom group a SQL `GROUP BY` skips). Scalar `aggregate()`
                // reads an absent min/max group as null, same as the prior NULL
                // row, so this stays correct.
                await exec.run(`DELETE FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, [encoded]);
            } else if (existing && removedValue !== undefined && existingValue !== null && removedValue === existingValue) {
                const recomputed = await recomputeExtreme(tableName, index, removes);

                await exec.run(`UPDATE ${quoteIdentifier(aggTable)} SET "__value__" = ?, "__count__" = ? WHERE "__key__" = ?`, [
                    recomputed,
                    remainingCount,
                    encoded,
                ]);
            } else {
                await exec.run(`UPDATE ${quoteIdentifier(aggTable)} SET "__count__" = "__count__" - 1 WHERE "__key__" = ?`, [encoded]);
            }
        }

        if (adds) {
            const encoded = encodeAggregateKey(index.by ?? [], adds);
            const addedValue = coerceAggregateNumber(adds[field]);

            if (addedValue === undefined) {
                await exec.run(
                    `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, 1)
                     ON CONFLICT("__key__") DO UPDATE SET "__count__" = "__count__" + 1`,
                    // eslint-disable-next-line unicorn/no-null -- seeds an extreme-less group with NULL value
                    [encoded, null],
                );
            } else {
                const op2 = op === "min" ? "MIN" : "MAX";

                await exec.run(
                    `INSERT INTO ${quoteIdentifier(aggTable)} ("__key__", "__value__", "__count__") VALUES (?, ?, 1)
                     ON CONFLICT("__key__") DO UPDATE SET "__value__" = ${op2}(COALESCE("__value__", excluded."__value__"), excluded."__value__"), "__count__" = "__count__" + 1`,
                    [encoded, addedValue],
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
        const rows = await exec.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [rankTable]);

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

        await exec.run(`DELETE FROM ${quoteIdentifier(rankTable)}`, []);

        const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
        const columnList = ["__id__", "__partition__", ...sortColumns].map((column) => quoteIdentifier(column)).join(", ");
        const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
        const insertSql = `INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`;

        // Collect the rank tuples during the keyset scan, then insert them
        // sequentially below (the scan callback can't itself await on the
        // shared connection).
        const rankTuples: unknown[][] = [];

        await forEachRowPaged(exec, definition, tableName, (document) => {
            if (index.where && !matchesRankStaticWhere(document, index.where)) {
                return;
            }

            const partitionKey = encodePartitionKey(index.partitionBy ?? [], document);
            // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent sort-key column must bind `null`, not undefined.
            const sortValues = index.sortBy.map((key) => serializeColumnValue(document[key.field] ?? null));

            rankTuples.push([document["_id"], partitionKey, ...sortValues]);
        });

        for (const tuple of rankTuples) {
            // eslint-disable-next-line no-await-in-loop -- rank rows are inserted sequentially on the single shared D1 connection; D1Exec exposes no batch API here.
            await exec.run(insertSql, tuple);
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
    ): Promise<void> => {
        const indexes = schema.tables[tableName]?.rankIndexes;

        if (!indexes || indexes.length === 0) {
            return;
        }

        for (const index of indexes) {
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
                await exec.run(`DELETE FROM ${quoteIdentifier(rankTable)} WHERE "__id__" = ?`, [id]);
            }

            if (next) {
                if (index.where && !matchesRankStaticWhere(next, index.where)) {
                    continue;
                }

                const sortColumns = index.sortBy.map((_, i) => sortColumnName(i));
                const columnList = ["__id__", "__partition__", ...sortColumns].map((column) => quoteIdentifier(column)).join(", ");
                const placeholders = ["?", "?", ...sortColumns.map(() => "?")].join(", ");
                const partitionKey = encodePartitionKey(index.partitionBy ?? [], next);
                // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent sort-key column must bind `null`, not undefined.
                const sortValues = index.sortBy.map((key) => serializeColumnValue(next[key.field] ?? null));

                // eslint-disable-next-line no-await-in-loop -- sequential companion INSERT on the shared D1 connection (see above).
                await exec.run(`INSERT INTO ${quoteIdentifier(rankTable)} (${columnList}) VALUES (${placeholders})`, [id, partitionKey, ...sortValues]);
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
            await exec.run(`DELETE FROM ${quoteIdentifier(ftName)} WHERE "__id__" = ?`, [id]);

            if (document) {
                // eslint-disable-next-line no-await-in-loop -- sequential companion INSERT on the shared D1 connection (see above).
                await exec.run(`INSERT INTO ${quoteIdentifier(ftName)} ("__text__", "__id__") VALUES (?, ?)`, [stringifySearchText(document[index.field]), id]);
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
    const runWrite = async (table: string, sql: string, parameters: ReadonlyArray<unknown>): Promise<void> => {
        try {
            await exec.run(sql, parameters);
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
        const rows = await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" = ?`, [id]);

        return rows[0];
    };

    /**
     * Run an optimistic-concurrency-guarded write — the D1 twin of the DO
     * dialect's `runGuardedWrite`. D1 stores rows as real columns (no `__doc__`
     * blob) and `D1Exec.run` returns no rows-affected count, so the CAS is
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
        setClause: string,
        setValues: ReadonlyArray<unknown>,
        snapshot: Record<string, unknown> | undefined,
    ): Promise<void> => {
        if (snapshot === undefined) {
            return;
        }

        const guardColumns = Object.keys(snapshot);
        const guardClause = guardColumns.map((column) => `${quoteIdentifier(column)} IS ?`).join(" AND ");
        const guardValues = guardColumns.map((column) => snapshot[column]);

        const sql =
            verb === "UPDATE"
                ? `UPDATE ${quoteIdentifier(table)} SET ${setClause} WHERE ${guardClause} RETURNING "id"`
                : `DELETE FROM ${quoteIdentifier(table)} WHERE ${guardClause} RETURNING "id"`;

        const parameters = verb === "UPDATE" ? [...setValues, ...guardValues] : guardValues;

        let returned: Record<string, unknown>[];

        try {
            returned = await exec.all(sql, parameters);
        } catch (error) {
            if (isUniqueViolation(error)) {
                throw new ConflictError(`unique constraint violation on "${table}"`, "unique");
            }

            throw error;
        }

        if (returned.length === 0) {
            throw new ConflictError(`optimistic concurrency conflict on "${table}" — the row changed during this mutation; refetch and retry`, "occ");
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
            columns: ["id", "_creationTime", ...fields].map((column) => quoteIdentifier(column)),
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
            const rowsIndexed = await exec.all(`SELECT "__value__" AS value, "__count__" AS count FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, [
                encoded,
            ]);

            if (rowsIndexed.length === 0) {
                return [];
            }

            const row = rowsIndexed[0] as { count: number; value: null | number };

            return [{ key: { ...planned.partial }, value: readAggregateValue(agg.op, { count: row.count, value: aggregateScalar(row.value) }) }];
        }

        // Open group key → enumerate every companion row.
        const rowsIndexed = await exec.all(`SELECT "__key__" AS key, "__value__" AS value, "__count__" AS count FROM ${quoteIdentifier(aggTable)}`, []);

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
        throw new Error(
            `cross-backend relation: a global table cannot load the shard-local relation '${childTable}' (it spans every shard) — wire a cross-shard reader to support it`,
        );
    };

    const writer: DatabaseWriterLike = {
        // eslint-disable-next-line sonarjs/cognitive-complexity -- routes count/sum/avg/min/max through the indexed companion vs scan fallback; the branching reads clearer inline than split across per-op helpers
        async aggregate(tableName, aggOptions: AggregateOptions): Promise<AggregateResult> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
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
                    restrictsCounts: aggOptions.restrictsCounts,
                    where: aggOptions.where,
                });
            }

            if (!aggOptions.field) {
                throw new Error(`aggregate(${tableName}, { op: "${aggOptions.op}" }): "field" is required for non-count reducers`);
            }

            // Indexed fast-path: the `__agg_` companion is now reducer-aware
            // (`__value__` holds the sum / running sum / extreme, `__count__`
            // the row count), so a matching `(by, field, op)` index whose
            // counter is materialized answers sum/avg/min/max in one row lookup.
            // We only attempt it when no baseWhere is set; the RLS predicate
            // falls through to the SQL scan below.
            if (definition.aggregateIndexes && !aggOptions.baseWhere) {
                const planned = selectIndexForAggregate(definition.aggregateIndexes, aggOptions.op, aggOptions.field, aggOptions.where);

                if (planned) {
                    const counterReady = await ensureBackfilled(tableName, planned.index);

                    if (counterReady) {
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                        const aggTable = aggregateTableName(tableName, planned.index.name);
                        const rows = await exec.all(`SELECT "__value__" AS value, "__count__" AS count FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, [
                            encoded,
                        ]);
                        const row = rows[0] as { count: number; value: null | number } | undefined;

                        return readAggregateValue(aggOptions.op, row === undefined ? undefined : { count: row.count, value: aggregateScalar(row.value) });
                    }
                }
            }

            const effective = mergeWhere(aggOptions.baseWhere, aggOptions.where);
            const { params, sql: whereSql } = compileWhere(effective, d1WhereStrategy);

            let querySql = `SELECT ${aggregateSqlFunction(aggOptions.op)}(${columnRef(aggOptions.field)}) AS value FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const rows = await exec.all(querySql, params);
            const value = rows[0]?.["value"];

            // eslint-disable-next-line unicorn/no-null -- AggregateResult is `number | null`; an empty reduction returns null per the public contract.
            return value === null || value === undefined ? null : Number(value);
        },

        async count(tableName, whereOrOptions) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            // Ensure the `__agg_` companion exists so the indexed count path
            // can find (and backfill) it rather than scanning.
            await ensureMigrated();

            const countOptions = normalizeCountArgument(whereOrOptions);

            if (countOptions.restrictsCounts) {
                throw new CountRlsUnsupportedError(tableName);
            }

            // Indexed path: same planner as the DO dialect (see ctx-db.ts).
            // We only attempt the counter when no baseWhere is set; otherwise
            // we route uniformly through SQL so the RLS predicate participates.
            if (definition.aggregateIndexes && !countOptions.baseWhere) {
                const planned = selectIndexForCount(definition.aggregateIndexes, countOptions.where);

                if (planned) {
                    const counterReady = await ensureBackfilled(tableName, planned.index);

                    if (counterReady) {
                        const encoded = encodeAggregateKey(planned.index.by ?? [], planned.key);
                        const aggTable = aggregateTableName(tableName, planned.index.name);
                        const rows = await exec.all(`SELECT "__value__" AS value FROM ${quoteIdentifier(aggTable)} WHERE "__key__" = ?`, [encoded]);

                        return Number(rows[0]?.["value"] ?? 0);
                    }
                }
            }

            const effective = mergeWhere(countOptions.baseWhere, countOptions.where);
            const { params, sql: whereSql } = compileWhere(effective, d1WhereStrategy);

            let querySql = `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            const rows = await exec.all(querySql, params);

            return Number(rows[0]?.["count"] ?? 0);
        },

        async delete(id, expectedTable) {
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
                        throw new Error(
                            `cross-backend cascade from global '${tableName}' into shardBy '${holderTable}' is not supported — would require Query Coordinator fan-out across shards`,
                        );
                    }

                    const holders = await writer.findMany(holderTable, { where: { [field]: value } });

                    return holders.page;
                },
                onCascade: (_holderTable, holderId) => writer.delete(holderId),
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

            await runGuardedWrite(tableName, "DELETE", "", [], snapshot);

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
                throw new Error(`unknown table: ${tableName}`);
            }

            // The primary list read — provision the global tables first so a
            // fresh database returns an empty page instead of `no such table`.
            await ensureMigrated();

            const orderKeys = normalizeOrderKeys(args.orderBy);
            const seek = args.cursor ? buildSeekWhere(orderKeys, decodeCursor(args.cursor)) : undefined;

            // Relation reads/counts routed by the child's backend: a shard-local
            // child of this global parent fans out via the injected cross-shard
            // reader (or throws when unwired); global/same-backend children stay
            // on the local D1 writer. Defined here so referencing `writer` is at
            // call time (the routed fetcher and `writer.findMany` are mutually
            // recursive for nested `with`) and so the relation-predicate
            // pre-resolver below can reuse the same routing.
            const relationFetcher: DatabaseWriterLike["findMany"] = (childTable, childArgs) => {
                if (!isShardLocalTarget(childTable)) {
                    return writer.findMany(childTable, childArgs);
                }

                return crossShardReader ? crossShardReader(childTable, childArgs) : crossBackendUnsupported(childTable);
            };
            const relationCounter: DatabaseWriterLike["count"] = (childTable, where) => {
                if (!isShardLocalTarget(childTable)) {
                    return writer.count(childTable, where);
                }

                return crossShardCounter ? crossShardCounter(childTable, where) : crossBackendUnsupported(childTable);
            };

            // RLS (3.2) / aggregates (3.1) inject `baseWhere` we AND-merge
            // before the keyset seek so policy + cursor compose cleanly.
            let predicate: undefined | WhereInput = mergeWhere(args.baseWhere, args.where);

            // Rewrite relation-crossing predicates into flat `IN`/`NOT IN` via a
            // backend-routed child fetch before compiling. `relationBaseWhere` is
            // threaded through so a child table's RLS read filter applies on the
            // hop (the `with`-load `resolveWith` calls below omit it — a separate
            // pre-existing gap; the pre-resolver does not depend on that).
            predicate = await resolveRelationPredicates(predicate, {
                fetcher: relationFetcher,
                relationBaseWhere: args.relationBaseWhere,
                schema,
                tableName,
            });

            if (seek) {
                predicate = predicate ? { AND: [predicate, seek] } : seek;
            }

            const { params, sql: whereSql } = compileWhere(predicate, d1WhereStrategy);

            let querySql = `SELECT * FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            querySql += ` ORDER BY ${compileOrderBy(orderKeys, columnRef)}`;

            const limit = typeof args.limit === "number" ? Math.max(0, Math.floor(args.limit)) : undefined;

            if (limit !== undefined) {
                // Over-fetch by one row to learn whether another page exists.
                querySql += ` LIMIT ${String(limit + 1)}`;
            }

            const rows = await exec.all(querySql, params);
            const documents = decodeRows(definition, rows);

            if (limit === undefined) {
                if (args.with) {
                    await resolveWith({ counter: relationCounter, fetcher: relationFetcher, parents: documents, schema, tableName, with: args.with });
                }

                // eslint-disable-next-line unicorn/no-null -- findMany's public return uses `continueCursor: string | null`; an unpaged result has no cursor.
                return { continueCursor: null, isDone: true, page: documents };
            }

            const hasMore = documents.length > limit;
            const page = hasMore ? documents.slice(0, limit) : documents;
            const last = page.at(-1);

            if (args.with) {
                await resolveWith({ counter: relationCounter, fetcher: relationFetcher, parents: page, schema, tableName, with: args.with });
            }

            return {
                // eslint-disable-next-line unicorn/no-null -- public return shape: `continueCursor` is `string | null`; `null` marks the final page.
                continueCursor: hasMore && last ? encodeCursor(last, orderKeys) : null,
                isDone: !hasMore,
                page,
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

            const rows = await exec.all(`SELECT * FROM ${quoteIdentifier(tableName)} WHERE "id" = ?`, [id]);

            return decodeRow(definition, rows[0]);
        },

        async groupBy(tableName, groupOptions: GroupByOptions): Promise<ReadonlyArray<GroupByEntry>> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            // Ensure the `__agg_` companion exists so the indexed groupBy path
            // can find (and backfill) it rather than scanning.
            await ensureMigrated();

            const agg = groupOptions.agg ?? { op: "count" };

            // Reject an off-allowlist reducer `op` before any SQL is emitted.
            aggregateSqlFunction(agg.op);

            if (agg.op !== "count" && !agg.field) {
                throw new Error(`groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
            }

            // Indexed path: when no baseWhere is set and an aggregateIndex's
            // `by` exactly matches `groupOptions.by`, every group answer is
            // already in the reducer-aware companion table — covers every op
            // (count/sum/avg/min/max) now that `__value__`/`__count__` are
            // maintained per op. baseWhere falls through to scan so RLS composes.
            if (definition.aggregateIndexes && !groupOptions.baseWhere) {
                const indexed = await tryIndexedGroupBy(tableName, definition.aggregateIndexes, agg, groupOptions);

                if (indexed !== undefined) {
                    return indexed;
                }
            }

            const effective = mergeWhere(groupOptions.baseWhere, groupOptions.where);
            const { params, sql: whereSql } = compileWhere(effective, d1WhereStrategy);

            const select = groupOptions.by.map((field) => `${columnRef(field)} AS ${quoteIdentifier(field)}`);

            if (agg.op === "count") {
                select.push(`COUNT(*) AS value`);
            } else {
                // `agg.field` is asserted present for non-count reducers by the
                // guard above; re-check locally so the column ref stays typed
                // without a non-null assertion.
                if (!agg.field) {
                    throw new Error(`groupBy(${tableName}, { agg: { op: "${agg.op}" } }): "field" is required for non-count reducers`);
                }

                select.push(`${aggregateSqlFunction(agg.op)}(${columnRef(agg.field)}) AS value`);
            }

            let querySql = `SELECT ${select.join(", ")} FROM ${quoteIdentifier(tableName)}`;

            if (whereSql) {
                querySql += ` WHERE ${whereSql}`;
            }

            querySql += ` GROUP BY ${groupOptions.by.map((field) => columnRef(field)).join(", ")}`;

            const rows = await exec.all(querySql, params);

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
                throw new Error(`unknown table: ${tableName}`);
            }

            // Companion DDL must exist before the sync hooks below run an
            // INSERT against the fts/agg/rank tables.
            await ensureMigrated();

            const withDefaults = applyInsertDefaults(definition, document);

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
            const creationTime = typeof withDefaults["_creationTime"] === "number" ? withDefaults["_creationTime"] : clock();

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
            const placeholders = columns.map(() => "?").join(", ");

            await runWrite(tableName, `INSERT INTO ${quoteIdentifier(tableName)} (${columns.join(", ")}) VALUES (${placeholders})`, values);

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
                throw new Error(`document not found: ${id}`);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`document not found: ${id}`);
            }

            // Capture the RAW stored row alongside the decoded `existing` — the
            // raw values seed the optimistic-concurrency CAS below, before the
            // before-update trigger's `await` window can let a concurrent write
            // slip in.
            const snapshot = await rawRow(tableName, id);
            const existing = decodeRow(definition, snapshot);

            if (!existing) {
                throw new Error(`document not found: ${id}`);
            }

            const merged: Record<string, unknown> = { ...existing, ...patch, _id: id };

            applyOnUpdate(definition, patch, merged);

            // Refinement checks fire on the merged row so a patch that flips
            // a field to an invalid value is rejected before D1 sees it.
            runRowValidators(definition, merged);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...merged }, id, op: "update", previous: existing, table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const fields = Object.keys(definition.shape);
            const assignments = fields.map((field) => `${quoteIdentifier(field)} = ?`).join(", ");
            // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent column must bind `null`, not undefined.
            const values = fields.map((field) => serializeColumnValue(merged[field] ?? null));

            await runGuardedWrite(tableName, "UPDATE", assignments, values, snapshot);

            await syncAggregates(tableName, existing, merged);
            await syncRanks(tableName, id, existing, merged);
            await syncSearch(tableName, id, merged);
            await recordCdc(tableName, id, "update", merged);

            if (hasMatchingTrigger(tableName, "after", "update")) {
                await fireTriggers("after", "update", { doc: merged, id, op: "update", previous: existing, table: tableName });
            }
        },

        query(tableName) {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
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
                    ? searchViaFts(exec, definition, tableName, stage, limit)
                    : searchViaScan(exec, definition, tableName, stage, limit);
            };

            const buildReader = (stage: SearchStage | undefined): TableReaderLike => {
                const reader: TableReaderLike = {
                    async collect() {
                        if (!stage) {
                            throw new Error(LEGACY_READER_ERROR);
                        }

                        return runSearch(stage, undefined);
                    },
                    filter() {
                        throw new Error(LEGACY_READER_ERROR);
                    },
                    async first() {
                        if (!stage) {
                            throw new Error(LEGACY_READER_ERROR);
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
                            throw new Error("pagination is not supported on search queries; use .take(n) or .collect()");
                        }

                        throw new Error(LEGACY_READER_ERROR);
                    },
                    async take(limit) {
                        if (!stage) {
                            throw new Error(LEGACY_READER_ERROR);
                        }

                        return runSearch(stage, limit);
                    },
                    async unique() {
                        if (!stage) {
                            throw new Error(LEGACY_READER_ERROR);
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
                    withIndex() {
                        throw new Error(LEGACY_READER_ERROR);
                    },
                    withSearchIndex(indexName, search) {
                        // eslint-disable-next-line sonarjs/no-nested-functions -- the .find predicate sits inside the reader builder's terminal; hoisting it out for one lookup would be more indirection than it saves
                        const searchDefinition = (definition.searchIndexes ?? []).find((index) => index.name === indexName);

                        if (!searchDefinition) {
                            throw new Error(`unknown search index "${indexName}" on table "${tableName}"`);
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
                            throw new Error(`search index "${indexName}" on table "${tableName}" requires a .search(field, query) call`);
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
                throw new Error(`unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new Error(`unknown rankIndex "${indexName}" on table "${tableName}"`);
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
            const sortColumnList = sortColumns.map((column) => quoteIdentifier(column)).join(", ");
            const ownRows = await exec.all(
                `SELECT "__partition__"${sortColumnList ? `, ${sortColumnList}` : ""} FROM ${quoteIdentifier(rankTable)} WHERE "__id__" = ?`,
                [rowId],
            );

            const own = ownRows[0];

            if (!own) {
                // eslint-disable-next-line unicorn/no-null -- rank's public return is `RankResult | null` (see above).
                return null;
            }

            const partitionKey = own["__partition__"] as string;

            const effective = mergeWhere(rankOptions.baseWhere, rankOptions.where);
            const partitionFromWhere = resolveRankPartition(index, effective);

            if (partitionFromWhere) {
                const requestedKey = encodePartitionKey(index.partitionBy ?? [], partitionFromWhere);

                if (requestedKey !== partitionKey) {
                    // eslint-disable-next-line unicorn/no-null -- rank's public return is `RankResult | null`; a partition mismatch reads as null.
                    return null;
                }
            }

            const { branches: beforeBranches, params: beforeParams } = buildRankBeforeBranches(index, sortColumns, own, rowId);

            const beforeRows = await exec.all(
                `SELECT COUNT(*) AS c FROM ${quoteIdentifier(rankTable)} WHERE "__partition__" = ? AND (${beforeBranches.join(" OR ")})`,
                [partitionKey, ...beforeParams],
            );
            const totalRows = await exec.all(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(rankTable)} WHERE "__partition__" = ?`, [partitionKey]);

            return { position: Number(beforeRows[0]?.["c"] ?? 0) + 1, total: Number(totalRows[0]?.["c"] ?? 0) };
        },

        async rankPage(tableName, indexName, rankPageOptions = {}): Promise<RankPage> {
            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`unknown table: ${tableName}`);
            }

            const index = definition.rankIndexes?.find((i) => i.name === indexName);

            if (!index) {
                throw new Error(`unknown rankIndex "${indexName}" on table "${tableName}"`);
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
            const orderClauses = rankColumns.map((col) => `${quoteIdentifier(col.column)} ${col.direction === "desc" ? "DESC" : "ASC"}`);

            const whereClauses: string[] = [];
            const params: unknown[] = [];

            if (partitionFromWhere) {
                whereClauses.push(`"__partition__" = ?`);
                params.push(encodePartitionKey(index.partitionBy ?? [], partitionFromWhere));
            }

            if (rankPageOptions.cursor) {
                const seek = buildRankCursorSeek(rankColumns, decodeCursor(rankPageOptions.cursor), params);

                if (seek !== undefined) {
                    whereClauses.push(seek);
                }
            }

            const sortColumnList = sortColumns.map((column) => quoteIdentifier(column)).join(", ");
            const idColumn = quoteIdentifier(RANK_TIEBREAK);
            const partitionColumn = `"__partition__"`;
            const innerWhere = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(" AND ")}` : "";
            const selectColumns = sortColumns.length > 0 ? `${idColumn}, ${partitionColumn}, ${sortColumnList}` : `${idColumn}, ${partitionColumn}`;
            const querySql = `SELECT ${selectColumns} FROM ${quoteIdentifier(rankTable)}${innerWhere} ORDER BY ${orderClauses.join(", ")} LIMIT ${String(take + 1)}`;
            const rankRows = await exec.all(querySql, params);
            const hasMore = rankRows.length > take;
            const usable = hasMore ? rankRows.slice(0, take) : rankRows;

            const ids = usable.map((rankRow) => rankRow[RANK_TIEBREAK] as string);
            const documents = await hydrateRankRows(exec, definition, tableName, ids);

            // eslint-disable-next-line unicorn/no-null -- RankPage's public `continueCursor` is `string | null`; `null` marks the final page.
            let continueCursor: null | string = null;

            const last = usable.at(-1);

            if (hasMore && last !== undefined) {
                const cursorValues: unknown[] = [last["__partition__"], ...sortColumns.map((column) => last[column]), last[RANK_TIEBREAK]];

                continueCursor = encodeRankCursor(cursorValues);
            }

            return { continueCursor, isDone: !hasMore, page: documents };
        },

        async replace(id, document, expectedTable) {
            const tableName = await resolveTableName(id, expectedTable);

            if (!tableName) {
                throw new Error(`document not found: ${id}`);
            }

            const definition = schema.tables[tableName];

            if (!definition) {
                throw new Error(`document not found: ${id}`);
            }

            // Always snapshot the RAW stored row — it seeds the optimistic-
            // concurrency CAS below. `previous` (the decoded prior doc) is only
            // needed when a trigger or an aggregate/rank index has to step the
            // old `by`-tuple; decode it from the same snapshot to avoid a second
            // round-trip.
            const snapshot = await rawRow(tableName, id);

            if (snapshot === undefined) {
                throw new Error(`document not found: ${id}`);
            }

            const needsPrevious =
                hasTrigger(schema, tableName, "update") || (definition.aggregateIndexes ?? []).length > 0 || (definition.rankIndexes ?? []).length > 0;
            const previous = needsPrevious ? (decodeRow(definition, snapshot) ?? undefined) : undefined;
            const creationTime = typeof document["_creationTime"] === "number" ? document["_creationTime"] : clock();
            const replaced: Record<string, unknown> = { ...document, _creationTime: creationTime, _id: id };

            applyOnUpdate(definition, document, replaced);

            // Refinement checks fire on the post-onUpdate row so a defaulted
            // field still has to satisfy its `.check()` predicate.
            runRowValidators(definition, replaced);

            if (hasMatchingTrigger(tableName, "before", "update")) {
                await fireTriggers("before", "update", { doc: { ...replaced }, id, op: "update", previous, table: tableName });
            }

            await ensureBackfilledForTable(tableName);
            await ensureRankBackfilledForTable(tableName);

            const fields = Object.keys(definition.shape);
            const assignments = ['"_creationTime" = ?', ...fields.map((field) => `${quoteIdentifier(field)} = ?`)].join(", ");
            // eslint-disable-next-line unicorn/no-null -- SQL bind value: an absent column must bind `null`, not undefined.
            const values = [creationTime, ...fields.map((field) => serializeColumnValue(replaced[field] ?? null))];

            await runGuardedWrite(tableName, "UPDATE", assignments, values, snapshot);

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
    createD1ContextDatabase as createD1CtxDb,
    decodeGlobalRow,
    readD1CdcChanges,
    runD1AggregateMigrations,
    runD1CdcMigration,
    runD1GlobalTableMigrations,
    runD1RankMigrations,
    runD1SearchMigrations,
    trimD1CdcChanges,
};
export type { D1ContextDatabaseOptions as D1CtxDbOptions, D1Exec };
