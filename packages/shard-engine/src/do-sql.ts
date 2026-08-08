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

import { LunoraError } from "@lunora/errors";
import type { Name, SQL } from "drizzle-orm";
import { sql as dsql } from "drizzle-orm";

import { jsonPathSegment } from "../../../shared/json-path-segment";
import { quoteIdentifier } from "../../../shared/quote-identifier";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { ColumnMetaLike, SqlExec, TableDefinitionLike } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { sqlComparableProjection } from "./sql-projection";

/** The stored JSON document column every DO table carries alongside `id` / `_creationTime`. */
const DOC_COLUMN = "__doc__";

/**
 * Reserved top-level key inside the `__doc__` blob holding the **wire-tagged
 * originals** of the top-level fields that {@link encodeDocJson} projected to a
 * SQL-comparable scalar. See {@link encodeDocJson} for why the projection
 * exists. Named for its contents: it holds the values SQL canNOT read, not the
 * ones it can.
 *
 * **Nothing upstream reserves this name.** The only reserved-name enforcement in
 * the stack is `RESERVED_TABLE_NAMES` in `@lunora/codegen`'s `discover-schema`,
 * which covers TABLE names colliding with `ctx.db` members, and
 * `SYSTEM_INDEX_FIELDS` in `@lunora/server`'s `schema`, which is the two-entry
 * list `["_creationTime", "_id"]` of indexable system fields. Neither prohibits
 * a user field name, and there is no `__`-prefix guard anywhere.
 *
 * {@link encodeDocJson} therefore refuses the name itself. That guard is
 * **prospective**: it stops new writes, and it cannot speak for a row already on
 * disk that carries the name from before it existed. {@link decodeDocJson}
 * narrows the remaining exposure by claiming the key only when its value is a
 * plain object — a scalar or array under this name is left where it is rather
 * than spread across the document — but a pre-existing plain-object field of
 * this exact name would still be hoisted. No released version has ever written
 * it, so the window is a schema that declared the name independently.
 */
const DOC_ORIGINALS_KEY = "__originals__";

/**
 * Encode a document into the `__doc__` blob's on-disk string form.
 *
 * Two things happen, in this order.
 *
 * First, top-level `bigint` / bytes fields are projected to a SQL-comparable
 * scalar via {@link sqlComparableProjection} — the same function the query side
 * binds through — and their wire-tagged originals are parked under
 * {@link DOC_ORIGINALS_KEY}. `json_extract(__doc__, '$.f')` is the only way this
 * store reads a field — every `where`, `.index()`, `ORDER BY` and SQL-scan
 * aggregate goes through it — and it addresses top-level fields exclusively.
 * Storing a `bigint` in its tagged-array form put the array's raw JSON text on
 * the other side of all of those: `filter`/`withIndex` silently matched nothing,
 * `SUM` read 0, `MAX` handed the raw tagged string back to the caller. The
 * projection is what makes those answers right; the parked original is what
 * keeps the round-trip exact, since the projection is a sort key rather than the
 * value.
 *
 * Second, whatever remains goes through `encodeWire` (`shared/wire-codec.ts`),
 * which covers the nested leaves SQL never addresses — a `bigint` inside a
 * `v.object()`, a `v.bytes()` in an array — plus `Date`/`Map`/`Set`.
 *
 * A document with none of those leaves is untouched by both steps and encodes
 * byte-identically to plain `JSON.stringify` — the property the OCC
 * compare-and-swap and every already-stored row depend on.
 * @throws LunoraError `BAD_REQUEST` when the document declares the reserved {@link DOC_ORIGINALS_KEY} field, or holds a value no codec can store (a class instance, a cycle, nesting past the wire codec's 64-level cap)
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- "DocJson" mirrors the established `DOC_COLUMN`/`__doc__` naming this module already uses throughout.
const encodeDocJson = (document: Record<string, unknown>): string => {
    // Refuse the reserved key rather than clobber it. Both outcomes of letting
    // it through are silent data loss ON WRITE: a projected document overwrites
    // the user's value with the originals map, and one with nothing to project
    // still decodes as though the key were ours — spreading the user's own
    // object up to the top level and dropping the field. Nothing upstream
    // rejects the name (see DOC_ORIGINALS_KEY), so this is the only guard.
    if (Object.hasOwn(document, DOC_ORIGINALS_KEY)) {
        throw new LunoraError(
            "BAD_REQUEST",
            `"${DOC_ORIGINALS_KEY}" is reserved by the row store's document encoding and cannot be used as a field name — rename the field`,
        );
    }

    let projected: Record<string, unknown> | undefined;
    let originals: Record<string, unknown> | undefined;

    for (const [field, value] of Object.entries(document)) {
        const comparable = sqlComparableProjection(value);

        if (comparable !== undefined) {
            // Cloned lazily and in insertion order, so a document needing no
            // projection stays byte-identical and one that does only gains the
            // reserved key, at the end.
            projected ??= { ...document };
            // Null-prototype: a field literally named `__proto__` would otherwise
            // hit `Object.prototype`'s setter and the value would vanish instead
            // of being parked. The wire codec guards the same key for the same
            // reason.
            originals ??= Object.create(null) as Record<string, unknown>;
            projected[field] = comparable;
            originals[field] = value;
        }
    }

    if (projected && originals) {
        projected[DOC_ORIGINALS_KEY] = originals;
    }

    try {
        return JSON.stringify(encodeWire(projected ?? document));
    } catch (error: unknown) {
        // `encodeWire` throws a bare `TypeError` for a non-plain object and a
        // `RangeError` past its depth cap. Unwrapped, both reach the caller as
        // an opaque redacted `RPC_FAILED`; re-thrown as a typed error the
        // writer names what it could not store.
        throw new LunoraError("BAD_REQUEST", `this document cannot be stored: ${error instanceof Error ? error.message : String(error)}`);
    }
};

/**
 * Inverse of {@link encodeDocJson}. `decodeWire` runs first and turns every
 * tagged leaf — including the ones parked under {@link DOC_ORIGINALS_KEY} —
 * back into real `bigint`/`ArrayBuffer`/`Date` values, so restoring the
 * projected fields is a plain overwrite.
 *
 * Accepts every blob this store has ever written: a pre-codec plain-JSON row
 * (no sentinel, no reserved key — `decodeWire` is the identity on it) and a row
 * written while `bigint`s were stored tagged in place (the sentinel decodes;
 * there is nothing to un-project).
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- see encodeDocJson above.
const decodeDocJson = (raw: string): Record<string, unknown> => {
    const decoded = decodeWire(JSON.parse(raw)) as Record<string, unknown>;
    const { [DOC_ORIGINALS_KEY]: originals, ...fields } = decoded;

    // Claim the key only when it looks like ours. `encodeDocJson` always writes
    // a plain object here, so a scalar or array under this name predates the
    // write guard and belongs to the user — spreading a string would explode it
    // into `{"0":"h","1":"e",…}`, which is worse than leaving it alone.
    if (originals === null || typeof originals !== "object" || Array.isArray(originals)) {
        return decoded;
    }

    return { ...fields, ...(originals as Record<string, unknown>) };
};

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

    // Two grammars, both owed, in this order: `jsonPathSegment` quotes for
    // SQLite's JSON-path grammar (`a.b` is one key, not a nested lookup), then
    // `'` doubling escapes the finished path for the SQL string literal it sits
    // in. Doing only the second is what let `$.a.b` read the wrong slot.
    return `json_extract(${prefix}${DOC_COLUMN}, '$.${jsonPathSegment(field).replaceAll("'", "''")}')`;
};

const jsonPath = (field: string): string => documentPath("", field);

/**
 * Drizzle field reference for the DO store. Wraps the string {@link jsonPath} in
 * `dsql.raw` to keep the **literal** `json_extract(__doc__, '$.field')` path —
 * binding the path as a parameter would defeat SQLite's expression indexes.
 *
 * The raw embed is injection-safe because {@link documentPath} escapes the name
 * for both grammars it crosses — not because the name is trusted. Do not read
 * the older "field names come from schema-defined query keys" claim back into
 * this: it holds for the schema-sourced callers (indexes, TTL, relations), but
 * `ctx.db.<table>.findMany({ where, orderBy })` passes its keys through
 * `where-sql.ts`'s storage-blind compiler with no `definition.shape` lookup, so
 * a procedure that spreads an argument into `where` reaches here with a name off
 * the wire.
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
    DOC_ORIGINALS_KEY,
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
