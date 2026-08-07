/**
 * The DO store's shared SQL string/expression helpers, extracted from
 * `ctx-db.ts` so both `ctx-db.ts` and its sibling modules (notably
 * `ctx-db-migrations`) build the same `json_extract(__doc__, …)` paths,
 * identifier quoting, `CREATE INDEX` scaffold, aggregate-counter columns, and
 * the shared row/column shape probes from one place.
 *
 * These are pure helpers over the DO's column layout: `DOC_COLUMN` is the
 * stored JSON document column, `jsonPath`/`qualifiedJsonPath` map schema field
 * names onto the literal `json_extract` (or the dedicated `id`/`_creationTime`
 * columns), and their `…Sql` twins wrap the literal path in `dsql.raw` so
 * SQLite's expression indexes still match. `serializeSqlValue` is re-exported
 * from `./serialize-sql` so callers have a single SQL-helper import surface.
 */

import type { Name, SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { ColumnMetaLike, SqlExec, TableDefinitionLike } from "./ctx-db";
import { runDrizzle } from "./do-exec";

/** The stored JSON document column every DO table carries alongside `id` / `_creationTime`. */
const DOC_COLUMN = "__doc__";

/**
 * Encode a document into the `__doc__` blob's on-disk string form. Wraps
 * `encodeWire` (the repo's tagged JSON-safe value codec, `shared/wire-codec.ts`)
 * so `v.bigint()` (a real `bigint` — `JSON.stringify` throws on it) and
 * `v.bytes()` (an `ArrayBuffer` — `JSON.stringify` silently corrupts it to
 * `{}`) round-trip through storage. A document with no bigint/bytes/Date/Map/
 * Set leaves encodes byte-identically to plain `JSON.stringify` (the wire
 * codec's documented fidelity guarantee) — load-bearing for the OCC
 * compare-and-swap and every `json_extract(__doc__, …)` read, which must see
 * the same stored string for a doc this change doesn't touch.
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- "DocJson" mirrors the established `DOC_COLUMN`/`__doc__` naming this module already uses throughout.
const encodeDocJson = (document: Record<string, unknown>): string => JSON.stringify(encodeWire(document));

/**
 * Inverse of {@link encodeDocJson}. Accepts both new tagged blobs and
 * pre-existing plain-JSON blobs unchanged — `decodeWire` is a no-op on a tree
 * with no `$lunora.wire$` sentinel, so rows written before this codec shipped
 * keep parsing exactly as they did under bare `JSON.parse`.
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- see encodeDocJson above.
const decodeDocJson = (raw: string): Record<string, unknown> => decodeWire(JSON.parse(raw)) as Record<string, unknown>;

/** The geohash-companion table name for `.geoIndex(name)` on `table` (mirrors `ftsTableName`'s `__fts_` convention). */
const geoTableName = (table: string, indexName: string): string => `${table}__geo_${indexName}`;

/**
 * Shared body of {@link jsonPath} / {@link qualifiedJsonPath}; `prefix` is `""`
 * or a quoted `"table".` qualifier. Internal columns live alongside the doc;
 * expose them via the dedicated stored column so SQLite can hit the regular
 * index lookup path instead of decoding JSON.
 */
const documentPath = (prefix: string, field: string): string => {
    if (field === "_id" || field === "id") {
        return `${prefix}id`;
    }

    if (field === "_creationTime") {
        return `${prefix}_creationTime`;
    }

    return `json_extract(${prefix}${DOC_COLUMN}, '$.${field.replaceAll("'", "''")}')`;
};

const jsonPath = (field: string): string => documentPath("", field);

/**
 * Drizzle field reference for the DO store. Wraps the string {@link jsonPath} in
 * `dsql.raw` to keep the **literal** `json_extract(__doc__, '$.field')` path —
 * binding the path as a parameter would defeat SQLite's expression indexes.
 * Field names come from schema-defined query keys (already `'`-escaped), so the
 * raw embed is injection-safe.
 */
const jsonPathSql = (field: string): SQL => dsql.raw(jsonPath(field));

/**
 * Table-qualified twin of {@link jsonPath}, for the correlation refs in a
 * pushed-down EXISTS subquery: the parent side must name the outer table and
 * the child side its alias, so neither binds to the wrong scope on a
 * self-relation. Mirrors `jsonPath`'s `_id`/`id`/`_creationTime` column mapping.
 */
const qualifiedJsonPath = (table: string, field: string): string => documentPath(`${quoteIdentifier(table)}.`, field);

/** Table-qualified twin of {@link jsonPathSql} for EXISTS correlation refs. */
const qualifiedJsonPathSql = (table: string, field: string): SQL => dsql.raw(qualifiedJsonPath(table, field));

/** A `CREATE [UNIQUE] INDEX IF NOT EXISTS <name> ON <table> (<columns>)` — the DO-local twin of sql-store's `createIndexIfNotExists` (single-engine SQLite, so no per-engine branching). */
const createIndexSql = (name: string, table: string, columns: SQL, unique: boolean): SQL =>
    dsql`CREATE ${unique ? dsql`UNIQUE ` : dsql``}INDEX IF NOT EXISTS ${dsql.identifier(name)} ON ${dsql.identifier(table)} (${columns})`;

/** The aggregate-companion column identifiers, built once and reused across every aggregate statement (drizzle `SQL` chunks are immutable + safe to share). */
const AGG_KEY: Name = dsql.identifier("__key__");
const AGG_VALUE: Name = dsql.identifier("__value__");
const AGG_COUNT: Name = dsql.identifier("__count__");

/**
 * An aggregate-counter upsert: `INSERT INTO <agg> (__key__, __value__, __count__)
 * VALUES (key, value, count) ON CONFLICT(__key__) DO UPDATE SET <set>`. The
 * seeded value/count and the conflict-merge `set` vary per reducer (count / sum /
 * avg / min / max); the INSERT + ON CONFLICT scaffold is shared here.
 */
const aggUpsertSql = (aggTable: string, key: unknown, value: unknown, count: unknown, set: SQL): SQL =>
    dsql`INSERT INTO ${dsql.identifier(aggTable)} (${AGG_KEY}, ${AGG_VALUE}, ${AGG_COUNT}) VALUES (${key}, ${value}, ${count}) ON CONFLICT(${AGG_KEY}) DO UPDATE SET ${set}`;

/** The schema-declared columns of a table, as `[field, columnMeta]` pairs (skips fields without a `.column()` validator meta). */
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
 * @returns the parsed document fields, or `undefined` when the row is absent
 */
const rowToDocument = (row: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!row) {
        return undefined;
    }

    const raw = row[DOC_COLUMN];
    let parsed: Record<string, unknown>;

    if (typeof raw === "string") {
        parsed = decodeDocJson(raw);
    } else if (raw && typeof raw === "object") {
        parsed = raw as Record<string, unknown>;
    } else {
        parsed = {};
    }

    const { id } = row;

    if (typeof id === "string") {
        parsed["_id"] = id;
    }

    const creationTime = row["_creationTime"];

    if (typeof creationTime === "number") {
        parsed["_creationTime"] = creationTime;
    }

    return parsed;
};

/**
 * Parse a stored row into a document, yielding `undefined` for an unparseable
 * blob rather than throwing — the tolerant twin of {@link rowToDocument}.
 *
 * Every caller that walks *many* rows wants this one: the search backfill and
 * the LIKE-scan search both read whole pages, and one corrupt document there
 * would otherwise take down a shard's cold start or every search on the table,
 * rather than costing the single row it belongs to. Callers reading one row by
 * id want the throw, so this is a separate function rather than a flag.
 */
const tryRowToDocument = (row: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    try {
        return rowToDocument(row);
    } catch {
        return undefined;
    }
};

/**
 * Memoized per-`SqlExec` FTS5 capability probe. Cloudflare Durable Objects ship
 * SQLite with FTS5; `node:sqlite` (used in tests) does not. We create and drop a
 * throwaway virtual table once per handle and cache the result — the DO's `sql`
 * object is stable for the object's lifetime, so this runs at most once per DO.
 */
const ftsAvailabilityCache = new WeakMap<SqlExec, boolean>();

const isFtsAvailable = (sql: SqlExec): boolean => {
    const cached = ftsAvailabilityCache.get(sql);

    if (cached !== undefined) {
        return cached;
    }

    let available: boolean;

    try {
        runDrizzle(sql, dsql`CREATE VIRTUAL TABLE IF NOT EXISTS ${dsql.identifier("__lunora_fts_probe")} USING fts5(x)`);
        available = true;
    } catch {
        available = false;
    } finally {
        // Always attempt the DROP so the probe table never lingers — if the
        // CREATE threw, the IF EXISTS makes the DROP a no-op; if the CREATE
        // succeeded but a later statement threw (today there isn't one,
        // but keep the invariant for future probes), the DROP still runs.
        try {
            runDrizzle(sql, dsql`DROP TABLE IF EXISTS ${dsql.identifier("__lunora_fts_probe")}`);
        } catch {
            // The probe table cleanup is best-effort; swallow so the
            // availability decision still propagates.
        }
    }

    ftsAvailabilityCache.set(sql, available);

    return available;
};

export { quoteIdentifier } from "../../../shared/quote-identifier";
export {
    AGG_COUNT,
    AGG_KEY,
    AGG_VALUE,
    aggUpsertSql,
    createIndexSql,
    decodeDocJson,
    DOC_COLUMN,
    encodeDocJson,
    geoTableName,
    isFtsAvailable,
    jsonPath,
    jsonPathSql,
    qualifiedJsonPath,
    qualifiedJsonPathSql,
    rowToDocument,
    tableColumns,
    tryRowToDocument,
};

export { serializeSqlValue } from "./serialize-sql";
