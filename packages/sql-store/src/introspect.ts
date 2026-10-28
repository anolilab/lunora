/**
 * Read-only `.global()` introspection for the studio's database browser, on any
 * engine the store core drives (D1/SQLite, Postgres, MySQL).
 *
 * The DO twin (`@lunora/do`'s `introspect.ts`) lists shard-local tables and
 * pages their rows from the DO's JSON-blob SQLite. This is the SQL-store
 * counterpart; every statement renders through the engine's {@link SqlDialect},
 * and the catalog reads (tables, columns, keys) are the only per-engine SQL.
 *
 * It surfaces **every** real table in the database, not just the ones the
 * schema marks `.global()` — so the studio reflects the actual database,
 * including tables managed by other libraries (e.g. better-auth's
 * `user`/`session`/`account`/`verification`). Two guardrails keep that safe:
 *
 * - Internal/bookkeeping tables (SQLite, Cloudflare D1, Lunora companions for
 * aggregate/rank/fts/cdc indexes) are filtered out — see {@link isInternalTable}.
 * - Values in obviously-sensitive columns (password/token/secret/hash/salt) are
 * redacted, so browsing an external auth table can't leak credentials.
 *
 * `.global()` tables declared in the schema are decoded back into their doc
 * shape (re-exposing `_id`, folding booleans); any other table is shown with its
 * real physical columns.
 */

import { LunoraError } from "@lunora/errors";
import type { SchemaLike } from "@lunora/shard-engine";
import { isInternalTableName } from "@lunora/shard-engine";
import { encodeWire, needsWireEncoding } from "@lunora/wire";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { runSqlGlobalTableMigrations } from "./ctx-db-global-provisioning";
import type { SqlDialect } from "./dialect";
import type { SqlCtxExec as SqlContextExec } from "./sql-exec";
import { decodeGlobalRow, MAX_BOUND_PARAMETERS, queryAll } from "./sql-exec";
import { effectiveColumnKind, sqliteDecode, sqliteEncode } from "./value-codec";

/** A table plus its current row count. */
interface GlobalTableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one table, plus the column list and total size. */
interface GlobalTablePage {
    columns: string[];

    /**
     * Foreign-key columns (local column → referenced table) for tables that carry
     * real SQL `REFERENCES` constraints — recovered from `PRAGMA foreign_key_list`.
     * Schema `.global()` tables omit this (their refs come from `describeTables`);
     * external tables (e.g. better-auth's `session`/`twoFactor`) expose it so the
     * schema diagram can draw their global→global FK edges.
     */
    refs?: Record<string, string>;
    rows: Record<string, unknown>[];
    total: number;
}

/**
 * One equality constraint a facet-value click adds to the global browser's view:
 * `column = value` (or `column IS NULL` when `value` is nullish). `column` is a
 * displayed column name, validated against the table's columns and mapped to its
 * physical column (`_id` → `id`) before it is quoted; `value` is the **raw stored
 * value** the facet returned (a SQLite scalar — including a BLOB, which reaches
 * here as bytes because the facet payload is wire-encoded), normalised by
 * {@link sqliteEncode} and bound as a parameter, never interpolated.
 * AND-combined with the other clauses.
 *
 * Only `eq` is compiled on this path. `operator` and `path` exist so that a
 * request asking for anything else is refused by {@link buildEqPredicate} rather
 * than read as an equality: a `has` or `contains` clause matched as `= ?` would
 * return rows the caller did not ask for.
 */
interface GlobalFilterClause {
    column: string;
    /** Must be absent or `"eq"`; any other operator is refused. */
    operator?: string;
    /** Must be absent or empty; a nested path is refused (D1 columns are physical). */
    path?: string[];
    value: unknown;
}

interface ReadGlobalTablePageOptions {
    filters?: GlobalFilterClause[];
    limit?: number;
    offset?: number;
    table: string;
}

/**
 * Options for {@link facetSqlGlobalColumn} — the read-only "what values does this
 * column hold?" summary for the global (D1) browser. `column` is the displayed
 * column to group by (validated and mapped to its physical column, never
 * interpolated); `filters` mirrors {@link ReadGlobalTablePageOptions}'s eq
 * constraints so the facet reflects the **active view** (the same rows the
 * browser is previewing); `limit` caps the distinct values returned (clamped).
 */
interface FacetGlobalColumnOptions {
    column: string;
    filters?: GlobalFilterClause[];
    limit?: number;
    table: string;
}

/** One distinct value of a faceted global column with its row count over the active view. */
interface GlobalFacetValue {
    count: number;
    value: unknown;
}

/**
 * Payload of a {@link facetSqlGlobalColumn} call: the top-N distinct `values` (each
 * with a `count`) ordered by frequency, plus `truncated` — `true` when more
 * distinct values existed beyond the cap, so the UI can say so rather than imply
 * the list is exhaustive. Mirrors the shard browser's `FacetColumnResult`.
 */
interface GlobalFacetResult {
    truncated: boolean;
    values: GlobalFacetValue[];
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** Default cap on the number of distinct values a single global facet returns. */
const DEFAULT_FACET_LIMIT = 30;

/** Hard cap on facet values, so a wide column can't return an unbounded group set. */
const MAX_FACET_LIMIT = 200;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * A paging bound as a whole number in `[min, max]`, or `fallback` when it is not finite. Limits and offsets are inlined
 * as SQL literals, so a NaN would print as `NaN` and a huge value as `1e+21`, both invalid SQL.
 */
const pagingBound = (value: number | undefined, fallback: number, min: number, max: number): number =>
    clamp(Math.trunc(value !== undefined && Number.isFinite(value) ? value : fallback), min, max);

/**
 * Bookkeeping tables that must never surface in the browser: everything the
 * shard browser also hides ({@link isInternalTableName} — SQLite and Cloudflare
 * internals, every `__`-prefixed framework table such as `@lunora/d1`'s
 * `__drizzle_migrations`, every index companion), plus D1's own `d1_*`
 * internals — on the SQLite/D1 catalog only, since a Postgres or MySQL table may
 * legitimately carry that prefix. Everything else — the schema's `.global()`
 * tables and any external/auth tables — is fair game.
 */
const isInternalTable = (name: string, dialect: SqlDialect): boolean => isInternalTableName(name) || (dialect.name === "sqlite" && name.startsWith("d1_"));

/** `information_schema`'s scope for the connection's own schema/database, so a shared server never shows another database's tables. */
const schemaScope = (dialect: SqlDialect): SQL => (dialect.name === "postgres" ? sql`current_schema()` : sql`DATABASE()`);

/**
 * The catalog reads, the only SQL here that differs by engine. SQLite keeps the
 * `PRAGMA` statements D1 authorises; Postgres and MySQL read `information_schema`.
 */
const catalog = {
    columns: async (exec: SqlContextExec, dialect: SqlDialect, table: string): Promise<string[]> => {
        const rows =
            dialect.name === "sqlite"
                ? await queryAll(exec, dialect, sql`PRAGMA table_info(${sql.identifier(table)})`)
                : await queryAll(
                      exec,
                      dialect,
                      sql`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = ${schemaScope(dialect)} AND table_name = ${table} ORDER BY ordinal_position`,
                  );

        return rows.map((row) => String(row["name"]));
    },
    // Only references into the connection's own schema: the browser lists that schema alone, so a cross-schema
    // target would otherwise link to a same-named table there.
    foreignKeys: async (exec: SqlContextExec, dialect: SqlDialect, table: string): Promise<{ from: string; target: string }[]> => {
        let query: SQL;

        if (dialect.name === "sqlite") {
            query = sql`PRAGMA foreign_key_list(${sql.identifier(table)})`;
        } else if (dialect.name === "mysql") {
            query = sql`SELECT column_name AS ${sql.identifier("from")}, referenced_table_name AS ${sql.identifier("table")} FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ${table} AND referenced_table_name IS NOT NULL AND referenced_table_schema = DATABASE()`;
        } else {
            query = sql`SELECT kcu.column_name AS ${sql.identifier("from")}, ccu.table_name AS ${sql.identifier("table")} FROM information_schema.table_constraints AS tc JOIN information_schema.key_column_usage AS kcu ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema() AND tc.table_name = ${table} AND ccu.table_schema = current_schema()`;
        }

        const rows = await queryAll(exec, dialect, query);

        return rows.map((row) => {
            return { from: String(row["from"]), target: String(row["table"]) };
        });
    },
    primaryKey: async (exec: SqlContextExec, dialect: SqlDialect, table: string): Promise<string[]> => {
        if (dialect.name === "sqlite") {
            const info = await queryAll(exec, dialect, sql`PRAGMA table_info(${sql.identifier(table)})`);

            return info.filter((column) => Number(column["pk"] ?? 0) > 0).map((column) => String(column["name"]));
        }

        const rows = await queryAll(
            exec,
            dialect,
            sql`SELECT kcu.column_name AS name FROM information_schema.table_constraints AS tc JOIN information_schema.key_column_usage AS kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = ${schemaScope(dialect)} AND tc.table_name = ${table} ORDER BY kcu.ordinal_position`,
        );

        return rows.map((row) => String(row["name"]));
    },
    tables: async (exec: SqlContextExec, dialect: SqlDialect): Promise<string[]> => {
        const rows =
            dialect.name === "sqlite"
                ? await queryAll(exec, dialect, sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
                : await queryAll(
                      exec,
                      dialect,
                      sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ${schemaScope(dialect)} AND table_type = 'BASE TABLE' ORDER BY table_name`,
                  );

        return rows.map((row) => String(row["name"]));
    },
};

/** Column names whose values are redacted in non-schema tables, so auth secrets can't leak through the browser. */
const SENSITIVE_COLUMN = /password|secret|token|hash|salt|credential/iu;

/**
 * Token-bearing columns whose NAME looks innocent, keyed by table. better-auth
 * stores its one-time tokens in `verification.value`, which no name pattern can
 * catch without masking every `value` column in every table. Names are compared
 * lower-cased with `_` removed, so `two_factor`/`twoFactor` and
 * `backup_codes`/`backupCodes` both hit.
 */
const SENSITIVE_TABLE_COLUMNS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["apikey", new Set(["key"])],
    ["jwks", new Set(["privatekey"])],
    ["twofactor", new Set(["backupcodes"])],
    ["verification", new Set(["value"])],
]);

const normaliseName = (name: string): string => name.toLowerCase().replaceAll("_", "");

/** Whether an external table's column is masked: by name pattern, or by being a known token column of that table. */
const isRedactedColumn = (table: string, column: string): boolean =>
    SENSITIVE_COLUMN.test(column) || SENSITIVE_TABLE_COLUMNS.get(normaliseName(table))?.has(normaliseName(column)) === true;

/**
 * The schema definition that describes THIS D1 table, or `undefined` when the
 * table is not one the schema stores here.
 *
 * `shardMode?.kind === "global"` is the whole test, and it is not a formality:
 * only a `.global()` table lives in D1, so a same-named `.shardBy()`/root table
 * describes a Durable Object's storage, not this one. A schema declaring (say) a
 * shard-local `user` alongside better-auth's D1 `user` table made every read of
 * the D1 table take the schema branch — decoding it as a `.global()` row, so
 * {@link SENSITIVE_COLUMN} redaction never ran, and simultaneously turning off
 * the two guards that exist because redaction is imperfect
 * ({@link buildEqPredicate}'s equality oracle and {@link facetSqlGlobalColumn}'s
 * masked bucket). Same test the admin export/import path applies.
 */
const globalTableDefinition = (schema: SchemaLike, table: string): SchemaLike["tables"][string] | undefined => {
    const definition = schema.tables[table];

    return definition?.shardMode?.kind === "global" ? definition : undefined;
};

/** List every browsable table name (internal/companion tables excluded), sorted. */
const listTableNames = async (exec: SqlContextExec, dialect: SqlDialect): Promise<string[]> => {
    const names = await catalog.tables(exec, dialect);

    return names.filter((name) => !isInternalTable(name, dialect));
};

/**
 * Provision the schema's `.global()` tables (idempotent DDL, unmemoised — admin
 * introspection isn't a hot path, and this stays correct for any (exec, schema)
 * pair; the hot read/write path memoises per-ctx-db, see `createD1CtxDb`), then
 * assert `table` is in the live browsable-table list (typed 404 otherwise) so a
 * caller-supplied name can never reach an interpolated identifier.
 */
const assertBrowsableTable = async (exec: SqlContextExec, dialect: SqlDialect, schema: SchemaLike, table: string): Promise<void> => {
    await runSqlGlobalTableMigrations(exec, schema, dialect);

    const tableNames = await listTableNames(exec, dialect);

    if (!tableNames.includes(table)) {
        throw new LunoraError("UNKNOWN_TABLE", `unknown table: ${table}`, { status: 404 });
    }
};

const countRows = async (exec: SqlContextExec, dialect: SqlDialect, table: string, where: SQL = sql``): Promise<number> => {
    const rows = await queryAll(exec, dialect, sql`SELECT COUNT(*) AS c FROM ${sql.identifier(table)}${where}`);

    return Number(rows[0]?.["c"] ?? 0);
};

/**
 * Map a displayed column name to its physical D1 column. Schema `.global()` tables
 * expose `_id` (the primary key is physically `id`); every other displayed column
 * — meta `_creationTime`, a schema field, or an external table's physical column —
 * is stored under its own name. The caller validates membership first; this only
 * resolves the storage name so a quoted identifier never leaks `_id`.
 */
const physicalColumnName = (schema: SchemaLike, table: string, displayColumn: string): string =>
    globalTableDefinition(schema, table) !== undefined && displayColumn === "_id" ? "id" : displayColumn;

/** Declared storage kind of a `.global()` table's field, or `undefined` for a framework column or an external table. */
const globalColumnKind = (schema: SchemaLike, table: string, column: string): string | undefined => {
    const validator = globalTableDefinition(schema, table)?.shape[column];

    return validator === undefined ? undefined : effectiveColumnKind(validator);
};

/** An integer literal a `v.bigint()` filter accepts as typed text. */
const INTEGER_TEXT = /^-?\d+$/u;

/**
 * Refuse a D1 statement that would bind more parameters than workerd accepts.
 * @throws LunoraError `BAD_REQUEST` when `count` exceeds {@link MAX_BOUND_PARAMETERS}
 */
const assertParameterBudget = (table: string, count: number): void => {
    if (count > MAX_BOUND_PARAMETERS) {
        throw new LunoraError(
            "BAD_REQUEST",
            `the query over ${table} binds ${String(count)} parameters, and a statement takes at most ${String(MAX_BOUND_PARAMETERS)} — remove some filters`,
        );
    }
};

/**
 * The bound form of an eq filter value. An external Postgres/MySQL table stores
 * native values, and its facets hand those back (a `timestamp` as a `Date`), so
 * the value binds as it came, with only the wire's `ArrayBuffer` turned into the
 * `Uint8Array` the drivers bind as bytes. Anywhere else it is the writer's own
 * {@link sqliteEncode}, given the column's kind. A `v.bigint()` column stores a zero-padded TEXT sort
 * key, and a browser sends the operator's `10` as a number (or, past 2^53, as the
 * exact digit string) — bound raw, that never equals the key. Integer input is
 * parsed to a `bigint` first so it encodes to the key the row was written with.
 */
const bindGlobalFilterValue = (value: unknown, kind: string | undefined, nativeStorage: boolean): unknown => {
    if (nativeStorage) {
        return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
    }

    if (kind !== "bigint") {
        // Only bigint needs its kind here. An untyped column (`union`/`any`/
        // `from`) stores its scalars in the marked form, and the facet hands that
        // stored text straight back as the clicked value: encoding it again with
        // the kind would mark it a second time and it would never match.
        return sqliteEncode(value);
    }

    const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : undefined;

    return sqliteEncode(text !== undefined && INTEGER_TEXT.test(text) ? BigInt(text) : value, kind);
};

/**
 * Refuse a clause this path cannot compile. The wire carries `operator` and
 * `path` so a request for `has`, `contains` or a nested field is refused here
 * rather than read as an equality on the parent column.
 *
 * This is why `has` is refused on a `v.any` or union column too. Those are stored
 * as JSON text in a plain D1 column, and this path compiles eq only: there is no
 * `json_each` over that storage, so membership cannot be tested here. An eq on
 * the text would answer a different question, and `has` read as eq would return
 * the wrong rows, so the refusal stays.
 * @throws LunoraError `BAD_REQUEST` naming the operator or the nested path
 */
const assertEqOnlyClause = (filter: GlobalFilterClause): void => {
    if (filter.operator !== undefined && filter.operator !== "eq") {
        throw new LunoraError("BAD_REQUEST", `operator "${filter.operator}" is not supported on the global browser — only eq is`);
    }

    if (filter.path !== undefined && !(Array.isArray(filter.path) && filter.path.length === 0)) {
        throw new LunoraError("BAD_REQUEST", `a nested path is not supported on the global browser, so ${filter.column} must be a top-level column`);
    }
};

/**
 * Compile a list of eq constraints into a bound ` WHERE …` fragment for the
 * global read/facet paths. Each clause's column is validated against the table's
 * displayed columns (typed 404 if unknown) and mapped to its physical, quoted
 * identifier; a nullish value compiles to `IS NULL` (SQL's `= NULL` never
 * matches), everything else to `= ?` with the value bound through
 * {@link bindGlobalFilterValue}. No clauses yields an empty `where`, so callers
 * append it unconditionally.
 */
const buildEqPredicate = (
    schema: SchemaLike,
    dialect: SqlDialect,
    table: string,
    displayColumns: string[],
    filters: GlobalFilterClause[] | undefined,
): { bound: number; where: SQL } => {
    const clauses: SQL[] = [];
    const nativeStorage = globalTableDefinition(schema, table) === undefined && dialect.name !== "sqlite";
    let bound = 0;

    for (const filter of filters ?? []) {
        assertEqOnlyClause(filter);

        if (!displayColumns.includes(filter.column)) {
            throw new LunoraError("UNKNOWN_COLUMN", `unknown column: ${filter.column}`, { status: 404 });
        }

        // An eq filter on a redacted column of an external (non-schema) table
        // would leak an equality oracle: `total`/count reveals whether a guessed
        // value matched, bypassing the '•••' redaction. Reject it, mirroring the
        // facet path's masked-bucket collapse. Declared `.global()` tables (whose
        // values are not redacted) intentionally bypass this guard.
        if (globalTableDefinition(schema, table) === undefined && isRedactedColumn(table, filter.column)) {
            throw new LunoraError("FORBIDDEN", `cannot filter on a redacted column: ${filter.column}`, { status: 403 });
        }

        const column = sql.identifier(physicalColumnName(schema, table, filter.column));

        if (filter.value === null || filter.value === undefined) {
            clauses.push(sql`${column} IS NULL`);
        } else {
            const value = bindGlobalFilterValue(filter.value, globalColumnKind(schema, table, filter.column), nativeStorage);

            // A Postgres driver reads a zone-less `timestamp`/`date` as local time but binds a `Date` as
            // UTC text, whose offset such a column drops, so outside a UTC process the two never meet.
            // Comparing both sides as instants reads the column in the session zone the driver parsed it in.
            clauses.push(
                nativeStorage && dialect.name === "postgres" && value instanceof Date
                    ? sql`${column}::timestamptz = ${value}::timestamptz`
                    : sql`${column} = ${value}`,
            );
            bound += 1;
        }
    }

    return { bound, where: clauses.length > 0 ? sql` WHERE ${sql.join(clauses, sql` AND `)}` : sql`` };
};

/**
 * Decode a SELECTed D1 row. A schema `.global()` table is decoded via the shared
 * {@link decodeGlobalRow} (re-exposing `_id`, JSON/bigint/boolean round-trips);
 * any other table (e.g. a better-auth table) is passed through with its real
 * columns, redacting obviously-sensitive values.
 */
const decodeRow = (schema: SchemaLike, table: string, row: Record<string, unknown>): Record<string, unknown> => {
    const definition = globalTableDefinition(schema, table);

    if (definition) {
        return decodeGlobalRow(definition, row);
    }

    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        redacted[key] = value !== null && value !== undefined && isRedactedColumn(table, key) ? "•••" : value;
    }

    return redacted;
};

/**
 * Columns the browser shows for `table`: a schema `.global()` table uses its
 * declared fields plus the framework columns (`_id`, `_creationTime`); any other
 * table uses its real physical columns from `PRAGMA table_info`.
 */
const resolveColumns = async (exec: SqlContextExec, dialect: SqlDialect, schema: SchemaLike, table: string): Promise<string[]> => {
    const definition = globalTableDefinition(schema, table);

    if (definition) {
        return ["_id", "_creationTime", ...Object.keys(definition.shape)];
    }

    return catalog.columns(exec, dialect, table);
};

/**
 * Foreign keys for `table`, recovered from `PRAGMA foreign_key_list` as a
 * `{ localColumn: referencedTable }` map. Schema `.global()` tables return
 * `undefined` — their FK metadata flows authoritatively through `describeTables`,
 * so we don't double-source it here. External tables (e.g. better-auth's, which
 * emit real `REFERENCES` constraints) return their declared FKs, letting the
 * schema diagram draw their global→global edges. Returns `undefined` when there
 * are no foreign keys, so callers can omit the field rather than send `{}`.
 */
const resolveReferences = async (exec: SqlContextExec, dialect: SqlDialect, schema: SchemaLike, table: string): Promise<Record<string, string> | undefined> => {
    if (globalTableDefinition(schema, table)) {
        return undefined;
    }

    const rows = await catalog.foreignKeys(exec, dialect, table);

    if (rows.length === 0) {
        return undefined;
    }

    const references: Record<string, string> = {};

    for (const row of rows) {
        const { from, target } = row;

        // First constraint wins per column — composite FKs are rare here and the
        // diagram links a column to a single table.
        references[from] ??= target;
    }

    return references;
};

/**
 * List every browsable D1 table with its row count, ordered by name. Surfaces
 * both the schema's `.global()` tables (provisioned first) and external tables
 * (auth, etc.); internal/companion tables are excluded.
 */
const listSqlGlobalTables = async (exec: SqlContextExec, schema: SchemaLike, dialect: SqlDialect): Promise<GlobalTableInfo[]> => {
    await runSqlGlobalTableMigrations(exec, schema, dialect);

    const names = await listTableNames(exec, dialect);

    // Independent COUNT(*) probes — fan out and preserve the sorted order.
    return Promise.all(
        names.map(async (name) => {
            return { name, rowCount: await countRows(exec, dialect, name) };
        }),
    );
};

/**
 * The column a page is ordered by, so `LIMIT`/`OFFSET` is real pagination.
 *
 * The two table kinds name their columns differently and cannot share a test:
 * {@link resolveColumns} returns DISPLAY names for a `.global()` table (`_id`,
 * whose physical column is `id`) and PHYSICAL names for an external one. Keying
 * off `columns.includes("_id")` therefore ordered an external table that happens
 * to have a literal `_id` column by an `id` it does not have.
 *
 * External tables are asked for their own primary key instead, which also covers
 * `WITHOUT ROWID` — those have no `rowid` to fall back on.
 */
const pageOrderKey = async (exec: SqlContextExec, dialect: SqlDialect, schema: SchemaLike, table: string, columns: ReadonlyArray<string>): Promise<SQL> => {
    if (globalTableDefinition(schema, table) !== undefined) {
        // eslint-disable-next-line no-restricted-syntax -- `sql` is the drizzle tagged-template builder, not a string conversion
        return sql`${sql.identifier("id")}`;
    }

    const primaryKey = await catalog.primaryKey(exec, dialect, table);

    if (primaryKey.length > 0) {
        return sql.join(
            primaryKey.map((name) => sql.identifier(name)),
            sql`, `,
        );
    }

    if (columns.includes("id")) {
        // eslint-disable-next-line no-restricted-syntax -- `sql` is the drizzle tagged-template builder, not a string conversion
        return sql`${sql.identifier("id")}`;
    }

    // SQLite: a keyless table always has a stable `rowid` (a `WITHOUT ROWID`
    // table must declare a primary key, so it took the branch above). Postgres/MySQL have no rowid, so
    // a keyless external table is ordered by every column: ordering by one
    // column alone leaves ties in an undefined order, and OFFSET pages would
    // then overlap or skip rows. Rows equal in every column are indistinguishable.
    // Postgres has no ordering for some types (native `json`), so its columns are
    // compared as text: the order only has to be stable, not meaningful.
    if (dialect.name === "sqlite") {
        return sql.raw("rowid");
    }

    return sql.join(
        columns.map((name) => (dialect.name === "postgres" ? sql`${sql.identifier(name)}::text` : sql.identifier(name))),
        sql`, `,
    );
};

/**
 * Read a page of rows from one D1 table. The table is validated against the live
 * browsable-table list before its name is interpolated, so this can't be coerced
 * into reading an internal table or injecting SQL. `limit` is clamped to
 * `[1, 500]`; `offset` floors at `0`. `filters` AND-narrows the page to rows
 * matching each `column = value` eq constraint (a facet-value drill-down), bound
 * through {@link buildEqPredicate} so they never inject SQL.
 */
const readSqlGlobalTablePage = async (
    exec: SqlContextExec,
    schema: SchemaLike,
    dialect: SqlDialect,
    options: ReadGlobalTablePageOptions,
): Promise<GlobalTablePage> => {
    const { table } = options;

    await assertBrowsableTable(exec, dialect, schema, table);

    const limit = pagingBound(options.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = pagingBound(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const columns = await resolveColumns(exec, dialect, schema, table);
    const { bound, where } = buildEqPredicate(schema, dialect, table, columns, options.filters);

    assertParameterBudget(table, bound);

    const total = await countRows(exec, dialect, table, where);
    // `LIMIT ? OFFSET ?` with no ORDER BY is not pagination: SQLite may return
    // the rows in whatever order the plan produces, and two identical requests
    // are free to disagree — so a row can show up on two pages, or on none. The
    // shard browser keyset-paginates for the same reason. See `pageOrderKey`
    // for how the ordering column is chosen for each table kind.
    const orderColumn = await pageOrderKey(exec, dialect, schema, table, columns);
    // LIMIT/OFFSET are clamped integers inlined as literals: mysql2's prepared
    // statements reject a bound `LIMIT ?`.
    const raw = await queryAll(
        exec,
        dialect,
        sql`SELECT * FROM ${sql.identifier(table)}${where} ORDER BY ${orderColumn} LIMIT ${sql.raw(String(limit))} OFFSET ${sql.raw(String(offset))}`,
    );
    // Wire-encode on the way out. `decodeGlobalRow` reverses the storage form,
    // so a `v.bigint()` column is a real `bigint` and a `v.bytes()` column an
    // `ArrayBuffer` — the browser's transport is JSON, where the former throws
    // and the latter silently becomes `{}`. External (non-schema) tables get the
    // same treatment for their BLOB columns. `needsWireEncoding` leaves a
    // pure-JSON row untouched.
    const rows = raw.map((row) => {
        const decoded = decodeRow(schema, table, row);

        return needsWireEncoding(decoded) ? (encodeWire(decoded) as Record<string, unknown>) : decoded;
    });
    const references = await resolveReferences(exec, dialect, schema, table);

    return references === undefined ? { columns, rows, total } : { columns, refs: references, rows, total };
};

/**
 * Summarise the distinct values of one displayed column over the **active view**
 * (the same eq `filters` the global browser is previewing) — the D1 twin of the
 * shard browser's `facetColumn`. Read-only: a `SELECT col AS value, COUNT(*) AS
 * count … GROUP BY col ORDER BY count DESC LIMIT N+1`, with the column validated
 * against the table's displayed columns (typed 404 if unknown), mapped to its
 * physical column, and quoted — never interpolated from caller input. The extra
 * over-fetched row is dropped and surfaced as `truncated`. A sensitive column on
 * an external (non-schema) table is never grouped — it collapses to a single
 * redacted `•••` bucket — mirroring the page browser's value redaction so the
 * facet can't leak credentials. The returned `value` is the raw stored scalar, so
 * a click feeds it straight back as an eq filter.
 *
 * The payload is wire-encoded on the way out, like the page read's rows: a BLOB
 * column's stored value is bytes, and `Response.json` flattens those to `{}` —
 * which is not a display glitch but a broken drill-down, since the flattened
 * value is what the click sends back as the filter. `needsWireEncoding` leaves a
 * facet over an ordinary text/numeric column untouched.
 */
const facetSqlGlobalColumn = async (
    exec: SqlContextExec,
    schema: SchemaLike,
    dialect: SqlDialect,
    options: FacetGlobalColumnOptions,
): Promise<GlobalFacetResult> => {
    const { column, table } = options;

    await assertBrowsableTable(exec, dialect, schema, table);

    const columns = await resolveColumns(exec, dialect, schema, table);

    if (!columns.includes(column)) {
        throw new LunoraError("UNKNOWN_COLUMN", `unknown column: ${column}`, { status: 404 });
    }

    const { bound, where } = buildEqPredicate(schema, dialect, table, columns, options.filters);

    assertParameterBudget(table, bound);

    // Faceting a sensitive column on an external table would expose the very
    // values the page browser redacts — collapse it to one masked bucket instead.
    if (globalTableDefinition(schema, table) === undefined && isRedactedColumn(table, column)) {
        const total = await countRows(exec, dialect, table, where);

        return { truncated: false, values: total === 0 ? [] : [{ count: total, value: "•••" }] };
    }

    const limit = pagingBound(options.limit, DEFAULT_FACET_LIMIT, 1, MAX_FACET_LIMIT);
    const physical = sql.identifier(physicalColumnName(schema, table, column));

    // Over-fetch one row past the cap to detect (and report) truncation. The
    // `${physical} ASC` tiebreaker is what makes the cut deterministic: on
    // `count DESC` alone, which of several equally-frequent values land in the
    // top-N — and therefore whether the result reports `truncated` — is up to
    // the planner, so two identical requests could answer differently.
    const rows = await queryAll(
        exec,
        dialect,
        sql`SELECT ${physical} AS value, COUNT(*) AS count FROM ${sql.identifier(table)}${where} GROUP BY ${physical} ORDER BY count DESC, ${physical} ASC LIMIT ${sql.raw(String(limit + 1))}`,
    );

    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;

    // A `v.bigint()` value is stored as its 40-character sort key; the facet reads
    // `4200n`, not that key, and a click on it re-encodes to the same key. Every
    // other kind stays the raw stored scalar, which already binds back as-is.
    const isBigint = globalColumnKind(schema, table, column) === "bigint";
    const values = kept.map((row) => {
        return { count: Number(row["count"]), value: isBigint ? sqliteDecode(row["value"], "bigint") : row["value"] };
    });

    return { truncated, values: needsWireEncoding(values) ? (encodeWire(values) as GlobalFacetValue[]) : values };
};

export { facetSqlGlobalColumn, listSqlGlobalTables, readSqlGlobalTablePage };
export type { FacetGlobalColumnOptions, GlobalFacetResult, GlobalFacetValue, GlobalFilterClause, GlobalTableInfo, GlobalTablePage, ReadGlobalTablePageOptions };
