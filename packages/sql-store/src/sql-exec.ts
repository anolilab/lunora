/**
 * The engine-facing plumbing every `.global()` store module shares: the exec
 * seam, drizzle rendering, idempotent DDL, the row decoder, and the keyset page
 * walker.
 *
 * Extracted from `ctx-db.ts` so the store core is not the only place these can
 * live — `ctx-db-search.ts` needs the same primitives, and importing them from
 * `ctx-db.ts` would be a cycle. Mirrors how `@lunora/do` splits `do-exec` /
 * `do-sql` out from its own ctx-db.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "sql-exec" sits beside "ctx-db", the established module naming in this package. */
/* eslint-disable no-restricted-syntax -- `sql\`…\` here is the drizzle tagged-template SQL builder, not a string conversion; the rule misfires on the inner TemplateLiteral. */

import { LunoraError } from "@lunora/errors";
import type { ColumnMetaLike, TableDefinitionLike } from "@lunora/shard-engine";
import { needsWireEncoding } from "@lunora/wire";
import { SQL, sql } from "drizzle-orm";

import type { RangeOperandType } from "../../../shared/json-field-path";
import { FieldPathError, isFieldPath, splitFieldPath, SQLITE_JSON_TYPE_NAMES } from "../../../shared/json-field-path";
import { jsonPathSegment } from "../../../shared/json-path-segment";
import type { SqlDialect, SqlRunResult } from "./dialect";
import { effectiveColumnKind, sqliteDecode, sqliteEncode } from "./value-codec";

/** Logical field → physical column name (`_id`/`id` → `id`; everything else, incl. `_creationTime`, is itself). */
const physicalColumn = (field: string): string => (field === "_id" || field === "id" ? "id" : field);

/** Logical-field → physical column reference as a drizzle {@link SQL}; the engine's dialect quotes it at render time (`_id`/`id` → `id`). */
const columnRefSql = (field: string): SQL => sql`${sql.identifier(physicalColumn(field))}`;

/** The segments of a dotted field path, with a malformed one reported as the `VALIDATION_ERROR` a caller expects. */
const pathSegments = (field: string): string[] => {
    try {
        return splitFieldPath(field);
    } catch (error) {
        if (!(error instanceof FieldPathError)) {
            throw error;
        }

        throw new LunoraError("VALIDATION_ERROR", error.message);
    }
};

/**
 * The text form of each path reference {@link fieldRefSql} builds on Postgres or MySQL, keyed by the reference. The
 * WHERE compiler hands the reference back to `containsExpr`, which reads its text form from here; a plain column has
 * no entry and is searched as it always was.
 */
const pathTextReferences = new WeakMap<SQL, SQL>();

/** The text form of a path reference, or `undefined` for a plain column. */
const pathTextReference = (reference: SQL): SQL | undefined => pathTextReferences.get(reference);

/**
 * Postgres: the object's member at `segments`, as `jsonb`, with a JSON `null` as SQL NULL. The keys are bound
 * parameters, and each step is `->` with a text key, which reads an object member only: `#>` would index into an
 * array, so `list.0` would return the first element where the SQLite and DO stores read NULL. A JSON `null` leaf is
 * returned as SQL NULL, as `json_extract` does.
 */
const postgresMember = (column: SQL, segments: ReadonlyArray<string>): SQL => {
    let member = sql`${column}::jsonb`;

    for (const segment of segments) {
        member = sql`${member} -> ${segment}::text`;
    }

    return sql`NULLIF(${member}, 'null'::jsonb)`;
};

/**
 * Postgres: the member as a `jsonb` reference, guarded by `pg_input_is_valid` (Postgres 16+), the non-raising check
 * for text that is not JSON. A cast would raise on it.
 */
const postgresPathSql = (column: SQL, segments: ReadonlyArray<string>): SQL =>
    sql`CASE WHEN pg_input_is_valid(${column}, 'jsonb') THEN ${postgresMember(column, segments)} END`;

/** Postgres: the member's text, unquoted, as `contains` searches it. A string leaf is its own text; a number is its digits. */
const postgresPathTextSql = (column: SQL, segments: ReadonlyArray<string>): SQL =>
    sql`CASE WHEN pg_input_is_valid(${column}, 'jsonb') THEN ${postgresMember(column, segments)} #>> '{}' END`;

/**
 * MySQL: the member through `JSON_EXTRACT`, as a JSON reference guarded by `JSON_VALID`. The path is one bound
 * parameter built with the SQLite quoting rule, so a key containing `.`, `"` or `\` addresses the real key. MySQL's
 * `$.key` reads object members only, so an array step is NULL. A JSON `null` leaf is returned as SQL NULL.
 */
const mysqlMember = (column: SQL, segments: ReadonlyArray<string>): SQL => {
    const path = `$${segments.map((segment) => `.${jsonPathSegment(segment)}`).join("")}`;

    return sql`NULLIF(JSON_EXTRACT(${column}, ${path}), CAST('null' AS JSON))`;
};

const mysqlPathSql = (column: SQL, segments: ReadonlyArray<string>): SQL => sql`CASE WHEN JSON_VALID(${column}) THEN ${mysqlMember(column, segments)} END`;

/** MySQL: the member's text, unquoted, as `contains` searches it. */
const mysqlPathTextSql = (column: SQL, segments: ReadonlyArray<string>): SQL =>
    sql`CASE WHEN JSON_VALID(${column}) THEN JSON_UNQUOTE(${mysqlMember(column, segments)}) END`;

/**
 * The needle of a `contains` over a path: the term's own text, unquoted, so `"ada"` searches for `ada`. `term` is the
 * bound value fragment; a NULL term stays NULL and matches nothing, as it does on SQLite.
 */
const pathContainsNeedle = (engine: "mysql" | "postgres", term: SQL): SQL =>
    engine === "postgres" ? sql`(${term})::jsonb #>> '{}'` : sql`JSON_UNQUOTE(${term})`;

/**
 * SQLite: `fn(column, '$.path')` over the object column, guarded by `json_valid`. SQLite raises on text that is not
 * valid JSON instead of returning NULL, and a column can hold such text: a bigint, bytes or Date inside an object is
 * stored wire-encoded, a string or id column is not JSON at all. The Durable Object store always keeps valid JSON
 * and reads NULL there, so the read is guarded to agree with it. The path is one bound parameter.
 */
const sqliteJsonCall = (fn: "json_extract" | "json_type", field: string): SQL => {
    const [root = "", ...rest] = pathSegments(field);
    const column = columnRefSql(root);

    return sql`CASE WHEN json_valid(${column}) THEN ${sql.raw(fn)}(${column}, ${`$.${rest.map((segment) => jsonPathSegment(segment)).join(".")}`}) END`;
};

/**
 * A `where`/`orderBy` field as SQL: a column, or a dotted path into an object column
 * (`profile.plan` → `json_extract("profile", '$.plan')`).
 *
 * Object columns are stored as JSON text. SQLite reads them with `json_extract`; Postgres and MySQL read them
 * with `->` and `JSON_EXTRACT` (see {@link postgresPathSql}, {@link mysqlPathSql}). Every dialect returns NULL for a
 * missing key, a step through a non-object, a JSON `null` and text that is not JSON.
 * @throws LunoraError `VALIDATION_ERROR` for a malformed or too-deep path.
 */
const fieldRefSql = (dialect: SqlDialect, field: string): SQL => {
    if (!isFieldPath(field)) {
        return columnRefSql(field);
    }

    if (dialect.name === "sqlite") {
        return sqliteJsonCall("json_extract", field);
    }

    const [root = "", ...rest] = pathSegments(field);
    const column = columnRefSql(root);
    const postgres = dialect.name === "postgres";
    const reference = postgres ? postgresPathSql(column, rest) : mysqlPathSql(column, rest);

    pathTextReferences.set(reference, postgres ? postgresPathTextSql(column, rest) : mysqlPathTextSql(column, rest));

    return reference;
};

/** The JSON text behind each bound path value, so a list of them can be sent as one array parameter ({@link pathInList}). */
const pathJsonText = new WeakMap<SQL, string>();

/**
 * A JSON text parameter as `jsonb`. The explicit text cast is load-bearing: a parameter cast straight to `jsonb`
 * takes its type from that cast, and a driver that sends strings as `text` (postgres.js with `fetch_types: false`)
 * then yields the JSON string `"30"` where `30` was meant, so a number path matched the text row. The same
 * double cast is what shard-engine's Postgres `in` uses (`postgresElements`).
 */
const pgJsonParam = (json: string): SQL => sql`CAST(CAST(${json} AS text) AS jsonb)`;

/**
 * The test that the leaf at path `field` is a JSON value of `type`, ANDed onto a range over it so that `gt: 5`
 * matches number leaves only on every engine (see `WhereSqlStrategy.rangeTypeGuard`).
 *
 * SQLite reads `json_type`, because `json_extract` flattens `true` to `1`. Postgres and MySQL read the type of the
 * `jsonb`/`JSON` reference the comparison already uses, which is NULL for text that is not JSON.
 */
const pathTypeGuardSql = (dialect: SqlDialect, field: string, type: RangeOperandType): SQL => {
    if (dialect.name === "sqlite") {
        return sql`NULLIF(${sqliteJsonCall("json_type", field)}, 'null') IN (${sql.raw(SQLITE_JSON_TYPE_NAMES[type])})`;
    }

    const reference = fieldRefSql(dialect, field);

    if (dialect.name === "postgres") {
        return sql`jsonb_typeof(${reference}) = ${sql.raw(`'${type}'`)}`;
    }

    const names = { boolean: "'BOOLEAN'", number: "'INTEGER', 'UNSIGNED INTEGER', 'DOUBLE', 'DECIMAL'", string: "'STRING'" }[type];

    return sql`JSON_TYPE(${reference}) IN (${sql.raw(names)})`;
};

/**
 * The bound form of one value compared against a path on Postgres or MySQL.
 *
 * It is bound as JSON, not as the SQLite storage form: `sqliteEncode` turns `true` into `1`, and JSON `true`
 * does not equal `1` on either engine, while `30` must not equal `"30"`. A value that cannot be JSON (a bigint,
 * bytes, a Date) is stored wire-encoded, which the path reads as NULL, so it is bound as NULL and matches
 * nothing. `undefined` goes through unchanged so the driver rejects it, as it does everywhere else.
 */
const pathValueSql = (engine: "mysql" | "postgres", value: unknown): unknown => {
    if (value === undefined) {
        return value;
    }

    if (typeof value === "bigint" || needsWireEncoding(value)) {
        return engine === "postgres" ? sql`CAST(NULL AS jsonb)` : sql`CAST(NULL AS JSON)`;
    }

    const json = JSON.stringify(value);
    const bound = engine === "postgres" ? sql`${pgJsonParam(json)}` : sql`CAST(${json} AS JSON)`;

    pathJsonText.set(bound, json);

    return bound;
};

/**
 * `IN` / `NOT IN` over path values, sent as ONE JSON array parameter that the engine unpacks into a set, as the
 * column form does past its literal bound.
 *
 * Bound item by item, a long list overruns the parameter count the wire protocol carries, and the statement
 * then matches nothing without raising. A NULL item, or a value that cannot be JSON (a bigint), can never equal a
 * stored path, so it is dropped from an `IN`; in a `NOT IN` it makes the whole predicate NULL, which matches no row.
 * @throws LunoraError `BAD_REQUEST` for an `undefined` item, which the driver would otherwise have rejected.
 */
const pathInList = (engine: "mysql" | "postgres", reference: SQL, items: ReadonlyArray<unknown>, negated: boolean): SQL => {
    const texts: string[] = [];
    let nonMatching = false;

    for (const item of items) {
        if (item === undefined) {
            throw new LunoraError("BAD_REQUEST", "an `in` list holds an undefined value");
        }

        const text = item instanceof SQL ? pathJsonText.get(item) : undefined;

        if (text === undefined) {
            nonMatching = true;
        } else {
            texts.push(text);
        }
    }

    if (texts.length === 0 || (negated && nonMatching)) {
        return sql`1 = 0`;
    }

    const array = `[${texts.join(",")}]`;
    const elements =
        engine === "postgres"
            ? sql`SELECT e.v FROM jsonb_array_elements(${pgJsonParam(array)}) AS e(v)`
            : sql`SELECT jt.v FROM JSON_TABLE(${array}, '$[*]' COLUMNS (v JSON PATH '$')) AS jt`;

    return negated ? sql`${reference} NOT IN (${elements})` : sql`${reference} IN (${elements})`;
};

/**
 * The value a where/index/aggregate site binds for `field`. `encodeColumn` is the column-aware SQLite
 * encode the site already used; it is what every dialect keeps for a plain column, and for a path on SQLite.
 * A path on Postgres or MySQL is bound as JSON instead (see {@link pathValueSql}). `null` is left as `null`
 * on every path so the caller's NULL handling still applies.
 */
const serializeFieldValue = (dialect: SqlDialect, field: string, value: unknown, encodeColumn: (value: unknown) => unknown): unknown => {
    if (dialect.name === "sqlite" || !isFieldPath(field) || value === null) {
        return encodeColumn(value);
    }

    return pathValueSql(dialect.name, value);
};

/**
 * Table-qualified twin of {@link columnRefSql}, for the one thing an unqualified
 * reference cannot do: **fail** when the column is absent.
 *
 * workerd and D1 build SQLite with the double-quoted-string misfeature enabled,
 * so a bare `"slug"` that resolves to no column is silently reinterpreted as the
 * string literal `'slug'` and the statement succeeds. Any probe that reads a
 * throw as "missing" therefore answers "present" for every database on the
 * runtime this store actually ships to. A qualified name has no string-literal
 * reading, so `"t"."slug"` raises `no such column: t.slug` on workerd, D1 and
 * `node:sqlite` alike.
 *
 * Only for references against a table the caller has aliased
 * (`FROM "x" AS "t"`); every other site keeps {@link columnRefSql}, whose
 * statements name no alias to qualify with.
 */
const qualifiedColumnRefSql = (alias: string, field: string): SQL => sql`${sql.identifier(alias)}.${sql.identifier(physicalColumn(field))}`;

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
 * Run a composable drizzle {@link SQL} read through the (string-based) exec:
 * render it for the dialect's engine — quoting + placeholders handled by drizzle
 * — then run the resulting `{ sql, params }`. The exec interface is unchanged, so
 * D1/PlanetScale execs need no edits; the per-engine `?`→`$N` / `"…"`→backtick
 * rewrites become redundant once every site is on this path.
 */
const queryAll = (exec: SqlCtxExec, dialect: SqlDialect, query: SQL): Promise<Record<string, unknown>[]> => {
    const { params, sql: text } = dialect.render(query);

    return exec.all(text, params);
};

/** Write twin of {@link queryAll}: render a drizzle {@link SQL} for the engine and run it. */
// eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `void` is intentional: mirrors SqlExec.run, whose union accepts a void-returning exec (no affected-rows count)
const queryRun = (exec: SqlCtxExec, dialect: SqlDialect, query: SQL): Promise<SqlRunResult | void> => {
    const { params, sql: text } = dialect.render(query);

    return exec.run(text, params);
};

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
 * The row version a guarded write leaves, in the two forms the store needs: as
 * SQL for the write's own `SET`, where it costs no bound parameter, and as the
 * value that SQL produces from the version the writer read, for the search
 * companion's guard. One definition, so the two cannot drift — if they did,
 * every guarded companion write would miss and fall back to the re-check.
 */
const nextRowVersion = {
    sql: (reference: SQL): SQL => sql`COALESCE(${reference}, 0) + 1`,
    value: (read: unknown): number => (read === null || read === undefined ? 0 : Number(read)) + 1,
};

/**
 * Run several write statements as one round trip when the exec exposes
 * {@link SqlCtxExec.batch}; falls back to the historical sequential
 * `run()`-per-statement loop when it doesn't, so an exec built before `batch`
 * existed keeps working unchanged.
 *
 * **The statements must be mutually independent.** An implementation MAY
 * reorder or parallelize across the array — the Hyperdrive Postgres and MySQL
 * adapters dispatch every element with `Promise.all` — so nothing here may rely
 * on array order between elements. A purge-then-insert pair belongs in separate
 * sequential {@link queryRun} calls, not one `queryBatch`. (D1's own
 * `client.batch` happens to preserve order and run atomically; that is one
 * engine's guarantee, not this function's contract.)
 *
 * The one place that renders and dispatches a companion write batch — the
 * search-index chunk insert, the aggregate tally backfill, and the rank-tuple
 * backfill all route through this instead of each re-deriving the
 * has-`batch`-or-fall-back branch.
 */
const queryBatch = async (exec: SqlCtxExec, dialect: SqlDialect, queries: ReadonlyArray<SQL>): Promise<void> => {
    if (queries.length === 0) {
        return;
    }

    if (!exec.batch) {
        for (const query of queries) {
            // eslint-disable-next-line no-await-in-loop -- fallback path: this exec has no batch seam, so statements run sequentially like every write did before batch existed.
            await queryRun(exec, dialect, query);
        }

        return;
    }

    await exec.batch(queries.map((query) => dialect.render(query)));
};

/**
 * Run statements that must not be separated: in order, and on the `sqlite`
 * dialect, where an exec's `batch` is D1's ordered transaction, as one atomic
 * unit — no other writer lands between them. An exec without `batch` runs them
 * sequentially, which leaves them open to interleaving with another writer.
 */
const runInOrder = async (exec: SqlCtxExec, dialect: SqlDialect, queries: ReadonlyArray<SQL>): Promise<void> => {
    if (exec.batch && dialect.name === "sqlite") {
        await exec.batch(queries.map((query) => dialect.render(query)));

        return;
    }

    for (const query of queries) {
        // eslint-disable-next-line no-await-in-loop -- the statements depend on each other's effects; order is the point.
        await queryRun(exec, dialect, query);
    }
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
    spec: { columns: SQL; concurrently?: boolean; name: string; table: string; unique: boolean },
): Promise<void> => {
    const unique = spec.unique ? sql`UNIQUE ` : sql``;
    // Postgres only: build without blocking writes. It cannot run inside a
    // transaction, which a Hyperdrive exec never opens. MySQL's InnoDB builds a
    // secondary index online by default.
    const concurrently = spec.concurrently === true && dialect.name === "postgres" ? sql`CONCURRENTLY ` : sql``;

    if (dialect.name === "mysql") {
        try {
            await queryRun(exec, dialect, sql`CREATE ${unique}INDEX ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`);
        } catch (error) {
            // ER_DUP_KEYNAME. Drivers disagree on which field carries it —
            // mysql2 sets `errno`, others only the symbolic `code` — so accept
            // either rather than rethrowing a re-run of idempotent DDL.
            const duplicate = error as { code?: unknown; errno?: unknown };

            if (duplicate.errno !== 1061 && duplicate.code !== "ER_DUP_KEYNAME" && duplicate.code !== 1061) {
                throw error;
            }
        }

        return;
    }

    await queryRun(
        exec,
        dialect,
        sql`CREATE ${unique}INDEX ${concurrently}IF NOT EXISTS ${sql.identifier(spec.name)} ON ${sql.identifier(spec.table)} (${spec.columns})`,
    );
};

/**
 * The oid of index `name` on `table`, or NULL. Looked up through the table rather than by the index's own
 * name, which `search_path` could resolve to a same-named index on another schema's table. `quote_ident`,
 * so a mixed-case table resolves as the DDL created it; `::name`, so a name past 63 bytes is truncated as
 * the DDL truncated it.
 */
const postgresIndexOf = (table: string, name: string): SQL =>
    sql`(SELECT ${sql.identifier("c")}.oid FROM pg_index ${sql.identifier("i")} JOIN pg_class ${sql.identifier("c")} ON ${sql.identifier("c")}.oid = ${sql.identifier("i")}.indexrelid WHERE ${sql.identifier("i")}.indrelid = to_regclass(quote_ident(${table})) AND ${sql.identifier("c")}.relname = ${name}::name)`;

/**
 * Drop an index if it exists. MySQL has no `DROP INDEX IF EXISTS` and names the
 * table, so it drops unconditionally and swallows the "can't drop" error
 * (errno 1091) an absent index raises — the mirror of
 * {@link createIndexIfNotExists}.
 */
const dropIndexIfExists = async (exec: SqlCtxExec, dialect: SqlDialect, table: string, name: string): Promise<void> => {
    if (dialect.name === "postgres") {
        // A bare name resolves through `search_path` and can reach a same-named index on another schema's
        // table. Drop the one on `table`, qualified with its schema from the catalog: `regclass::text` leaves
        // the schema off when the index is visible on this session's `search_path`, and nothing guarantees
        // the session that runs the drop has the same one.
        const [owned] = await queryAll(
            exec,
            dialect,
            sql`SELECT quote_ident(${sql.identifier("n")}.nspname) || '.' || quote_ident(${sql.identifier("c")}.relname) AS ${sql.identifier("qualified")} FROM pg_class ${sql.identifier("c")} JOIN pg_namespace ${sql.identifier("n")} ON ${sql.identifier("n")}.oid = ${sql.identifier("c")}.relnamespace WHERE ${sql.identifier("c")}.oid = ${postgresIndexOf(table, name)}`,
        );
        const qualified = owned?.["qualified"];

        if (typeof qualified === "string") {
            await queryRun(exec, dialect, sql`DROP INDEX IF EXISTS ${sql.raw(qualified)}`);
        }

        return;
    }

    if (dialect.name !== "mysql") {
        await queryRun(exec, dialect, sql`DROP INDEX IF EXISTS ${sql.identifier(name)}`);

        return;
    }

    try {
        await queryRun(exec, dialect, sql`DROP INDEX ${sql.identifier(name)} ON ${sql.identifier(table)}`);
    } catch (error) {
        // ER_CANT_DROP_FIELD_OR_KEY; drivers disagree on the field, as for 1061.
        const missing = error as { code?: unknown; errno?: unknown };

        if (missing.errno !== 1091 && missing.code !== "ER_CANT_DROP_FIELD_OR_KEY" && missing.code !== 1091) {
            throw error;
        }
    }
};

/**
 * Whether index `name` on `table` exists, and whether it is usable. Only
 * Postgres can hold an `invalid` one: what a `CREATE INDEX CONCURRENTLY` that
 * failed part way leaves behind, which `IF NOT EXISTS` treats as present.
 */
const indexState = async (exec: SqlCtxExec, dialect: SqlDialect, table: string, name: string): Promise<"absent" | "invalid" | "valid"> => {
    switch (dialect.name) {
        case "mysql": {
            const rows = await queryAll(
                exec,
                dialect,
                sql`SELECT 1 AS ${sql.identifier("present")} FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ${table} AND index_name = ${name} LIMIT 1`,
            );

            return rows.length > 0 ? "valid" : "absent";
        }
        case "postgres": {
            const rows = await queryAll(exec, dialect, sql`SELECT indisvalid FROM pg_index WHERE indexrelid = ${postgresIndexOf(table, name)}`);

            if (rows.length === 0) {
                return "absent";
            }

            return rows[0]?.["indisvalid"] === true ? "valid" : "invalid";
        }
        default: {
            const rows = await queryAll(
                exec,
                dialect,
                sql`SELECT 1 AS ${sql.identifier("present")} FROM sqlite_master WHERE type = 'index' AND name = ${name}`,
            );

            return rows.length > 0 ? "valid" : "absent";
        }
    }
};

/**
 * Async SQL surface the D1 ORM needs: `all` for reads, `run` for writes.
 * Satisfied by a `D1Session`/`D1Client` in production and a `node:sqlite`
 * adapter in tests, so the query logic runs against a real SQLite engine.
 */
interface SqlCtxExec {
    all: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<Record<string, unknown>[]>;
    // Optional, mirroring `SqlExec.batch` (see dialect.ts): run several
    // mutually-independent write statements as one round trip. No caller
    // consumes a return value — some engines dispatch these concurrently, so
    // there's no ordered result to report — hence `void`. Absent it,
    // `queryBatch` falls back to the sequential `run()` loop every companion
    // write used before this existed.
    batch?: (statements: ReadonlyArray<{ params: ReadonlyArray<unknown>; sql: string }>) => Promise<void>;
    // `void` for D1/node:sqlite (the result is ignored on those paths); a
    // `SqlRunResult` ({ rowsAffected }) for engines whose OCC needs the affected
    // count (MySQL, which has no `RETURNING`). The union lets a PlanetScale
    // `SqlExec` satisfy this without forcing the D1 execs to report a count.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- `void` is intentional: accepts a void-returning exec (one that reports no affected-rows count)
    run: (sql: string, parameters: ReadonlyArray<unknown>) => Promise<SqlRunResult | void>;
}

/**
 * SQLite storage encode for `.global()` column values — the shared
 * `@lunora/sql-store` codec (SQLite has no boolean, so true/false → 1/0).
 *
 * Kind-blind, because it is also what binds every WHERE comparison and the rank
 * companion's sort keys, where the two sides have to agree byte for byte.
 * A write that knows which column it is filling uses
 * {@link serializeDocumentColumn} instead.
 */
const serializeColumnValue: (value: unknown) => unknown = sqliteEncode;

/**
 * Does this validator's type admit the value `null`?
 *
 * `.nullable()` — the one modifier that clears `notNull` — is the explicit
 * signal, and it used to be the ONLY one read. That made the answer a proxy for
 * "was `.nullable()` called", not for "can this hold null", and several
 * validators admit null without it:
 *
 * - `v.any()` accepts every value, `null` included.
 * - `v.null()` accepts nothing else.
 * - `v.literal(null)` permits exactly that one value.
 * - `v.union(...)` admits null when any MEMBER does — `v.union(v.string(), v.null())`
 *   is the shape that gets written in practice.
 *
 * `v.from(schema)` is the one shape left out: an external Standard Schema
 * decides `null` in code we cannot read without running it, so it keeps the
 * conservative answer it already had.
 */
const acceptsNull = (validator: TableDefinitionLike["shape"][string] | undefined): boolean => {
    if (validator === undefined) {
        return false;
    }

    if (validator._meta?.column?.notNull === false) {
        return true;
    }

    switch (validator.kind) {
        case "any":
        case "null": {
            return true;
        }
        case "literal": {
            return validator._meta?.value === null;
        }
        case "optional": {
            return acceptsNull(validator._meta?.inner);
        }
        case "union": {
            return validator._meta?.members?.some((member) => acceptsNull(member)) === true;
        }
        default: {
            return false;
        }
    }
};

/**
 * Does a stored SQL NULL in this column mean the field is ABSENT rather than
 * null?
 *
 * The DO store keeps documents as JSON, where an unset `v.optional(...)` field
 * simply has no key. A `.global()` table keeps real columns, so the same field is
 * a NULL — and decoding that back as `null` is a lie about the declared type
 * (`v.optional(v.string())` is `string | undefined`, never `null`). It also broke
 * the export/import round trip outright: the exported line carried
 * `"field": null` and the importer ran `optional(string).parse(null)`, which
 * throws, so every row that simply had no value for an optional column was
 * missing from the restore.
 *
 * A column whose inner type ADMITS null is the opposite case — NULL is a value
 * the column genuinely holds — so those keep it. That covers
 * `v.optional(v.string().nullable())`, and (this is what {@link acceptsNull} was
 * widened for) `v.optional(v.any())` and
 * `v.optional(v.union(v.string(), v.null()))`, where a `null` the caller wrote
 * EXPLICITLY was being discarded as "field unset" while the DO plane kept it.
 *
 * One column cannot hold both answers: SQL NULL is the only thing either case
 * can store, so a table reads it one way or the other. Reading it as `null`
 * whenever the type admits null is the direction that never loses a written
 * value, and it never produces one outside the declared type either —
 * `v.optional(v.any())` infers `any` and `v.optional(v.union(v.string(), v.null()))`
 * infers `string | null | undefined`; both accept `null`. What remains is that an
 * UNSET field of such a column reads back as `null` rather than as missing. That
 * is a shape the declared type permits; discarding a written value was not.
 */
const nullMeansAbsent = (validator: TableDefinitionLike["shape"][string]): boolean => validator.kind === "optional" && !acceptsNull(validator);

/**
 * The `field → [effective column kind, NULL means absent]` mapping for a table,
 * derived once per (immutable) definition and memoized. Both halves are pure over
 * the validator and the shape never mutates after `defineSchema`, so the mapping
 * is static per definition — precomputing it removes the per-row
 * `Object.entries(definition.shape)` + `effectiveColumnKind` recomputation on the
 * decode hot path (a page/global read decodes R rows × M columns). Keyed on the
 * definition object identity (stable: definitions come from `defineSchema`).
 */
const columnKindCache = new WeakMap<TableDefinitionLike, [string, string | undefined, boolean][]>();

const columnKinds = (definition: TableDefinitionLike): [string, string | undefined, boolean][] => {
    let kinds = columnKindCache.get(definition);

    if (kinds === undefined) {
        kinds = Object.entries(definition.shape).map(
            ([field, validator]) => [field, effectiveColumnKind(validator), nullMeansAbsent(validator)] as [string, string | undefined, boolean],
        );
        columnKindCache.set(definition, kinds);
    }

    return kinds;
};

/**
 * `field → effective column kind` for the write path, keyed and memoized like
 * {@link columnKinds} (which is ordered for the row decode; a write looks one
 * field up at a time, so it wants a map).
 */
const columnKindByFieldCache = new WeakMap<TableDefinitionLike, Map<string, string | undefined>>();

const columnKindOf = (definition: TableDefinitionLike, field: string): string | undefined => {
    let byField = columnKindByFieldCache.get(definition);

    if (byField === undefined) {
        byField = new Map(columnKinds(definition).map(([name, kind]) => [name, kind]));
        columnKindByFieldCache.set(definition, byField);
    }

    return byField.get(field);
};

/**
 * Storage encode for one column of a document being WRITTEN, with the column's
 * declared kind in hand.
 *
 * The inverse of {@link decodeGlobalRow}, and it exists for the same reason:
 * `v.any()`/`v.union()`/`v.from()` store in a TEXT column whatever their runtime
 * value happens to be, so a number or boolean was coerced to text on the way in
 * and had no type to be reversed with on the way out — `42` read back `"42.0"`.
 * Only a caller that knows the column can encode those unambiguously.
 */
const serializeDocumentColumn = (definition: TableDefinitionLike, field: string, value: unknown): unknown =>
    sqliteEncode(value, columnKindOf(definition, field));

/**
 * Decode a SELECTed row back into a document: `id` → `_id`, `_creationTime`
 * preserved, and every column run through the shared {@link sqliteDecode} so the
 * stored form is reversed back into its JS shape. Exported so the data-browser
 * (`introspect.ts`) and admin export/import paths share the exact same decode.
 *
 * The decode is engine-agnostic: every backend stores SQLite-shaped values
 * (boolean → 1/0, JSON → text, bigint → an order-preserving text key), and `sqliteDecode` is
 * robust to a driver returning either the stored string OR a natively-parsed
 * value (e.g. mysql2 returns JSON columns pre-parsed) — so the same decoder is
 * correct on SQLite, Postgres and MySQL.
 */
const decodeGlobalRow = (definition: TableDefinitionLike, row: Record<string, unknown>): Record<string, unknown> => {
    const decoded: Record<string, unknown> = {};

    for (const [field, kind, absentOnNull] of columnKinds(definition)) {
        const raw = row[field];

        if (raw === undefined || (absentOnNull && raw === null)) {
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

/** Fixed page size for the keyset-paged table scans the backfill helpers use. */
const BACKFILL_BATCH_SIZE = 500;

/** One keyset page of `tableName`'s raw rows in `id` order, past `after` when given. */
const readRowsPage = (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    tableName: string,
    after: string | undefined,
    limit: number,
): Promise<Record<string, unknown>[]> => {
    const id = sql`${sql.identifier(tableName)}.${sql.identifier("id")}`;
    const seek = after === undefined ? sql`` : sql` WHERE ${id} > ${after}`;

    return queryAll(exec, dialect, sql`SELECT * FROM ${sql.identifier(tableName)}${seek} ORDER BY ${id} ASC LIMIT ${sql.raw(String(limit))}`);
};

/**
 * Stream rows of `tableName` to `onDoc` in `id`-keyset order, decoding each row
 * into a document first. Pages by the last row's `id` (not OFFSET) so an
 * unbounded table never has to fit in a single result buffer. Rows that fail to
 * decode are skipped. Shared by the aggregate-, rank-counter and search-index
 * backfills.
 *
 * `options.after` resumes past an id already handled and `options.limit` bounds
 * the walk — together they let the search backfill index a table one bounded
 * page per pass instead of blocking a request behind a full-table scan. Absent,
 * the walk covers the whole table.
 *
 * `onDoc` may return a promise (the search backfill writes companion rows per
 * document); it is awaited before the next row, keeping companion writes
 * sequential on the shared connection like every other write path here.
 */
const forEachRowPaged = async (
    exec: SqlCtxExec,
    dialect: SqlDialect,
    definition: TableDefinitionLike,
    tableName: string,
    onDoc: (document: Record<string, unknown>) => Promise<void> | void,
    options: { after?: string; limit?: number } = {},
): Promise<void> => {
    let cursorId: string | undefined = options.after;
    let remaining = options.limit;
    let hasMore = true;

    while (hasMore && (remaining === undefined || remaining > 0)) {
        const pageSize = remaining === undefined ? BACKFILL_BATCH_SIZE : Math.min(BACKFILL_BATCH_SIZE, remaining);
        // eslint-disable-next-line no-await-in-loop -- keyset paging is inherently sequential: each page's WHERE depends on the prior page's last id.
        const pageRows = await readRowsPage(exec, dialect, tableName, cursorId, pageSize);

        for (const row of pageRows) {
            const decoded = decodeRow(definition, row);

            if (decoded) {
                // eslint-disable-next-line no-await-in-loop -- an async `onDoc` (the search backfill) writes companion rows on the single shared connection; sequential is the point.
                await onDoc(decoded);
            }
        }

        cursorId = pageRows.at(-1)?.["id"] as string | undefined;
        hasMore = pageRows.length === pageSize;
        remaining = remaining === undefined ? undefined : remaining - pageRows.length;
    }
};

export type { SqlCtxExec };
export {
    BACKFILL_BATCH_SIZE,
    columnRefSql,
    createIndexIfNotExists,
    decodeGlobalRow,
    decodeRow,
    decodeRows,
    dropIndexIfExists,
    fieldRefSql,
    forEachRowPaged,
    indexState,
    nextRowVersion,
    nullSafeEqualsSql,
    pathContainsNeedle,
    pathInList,
    pathTextReference,
    pathTypeGuardSql,
    qualifiedColumnRefSql,
    queryAll,
    queryBatch,
    queryRun,
    readRowsPage,
    runInOrder,
    serializeColumnValue,
    serializeDocumentColumn,
    serializeFieldValue,
    tableColumns,
};

export { OCC_VERSION_COLUMN } from "../../../shared/occ-version-column";
