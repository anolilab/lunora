/**
 * Read-only D1 introspection for the studio's database browser.
 *
 * The DO twin (`@lunora/do`'s `introspect.ts`) lists shard-local tables and
 * pages their rows from the DO's JSON-blob SQLite. This is the D1 counterpart.
 *
 * It surfaces **every** real table in the D1 database, not just the ones the
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

import type { D1Exec } from "./d1-ctx-db";
import { decodeGlobalRow, runD1GlobalTableMigrations } from "./d1-ctx-db";
// The one canonical SQL identifier quoter (bundler-inlined via `./dialect` from
// `shared/quote-identifier.ts`). Reused here rather than re-declared: the shared
// helper is a security-relevant injection-defense primitive that must have a
// single definition, not byte-identical copies that can drift.
import { quoteIdentifier } from "./dialect";

/**
 * Provision the schema's `.global()` tables before the browser reads them, so a
 * fresh database lists/pages them instead of failing with `no such table`. The
 * DDL is idempotent (`CREATE … IF NOT EXISTS`) and admin introspection isn't a
 * hot path, so it runs unmemoised — correct for any (exec, schema) pair rather
 * than caching against a single binding. The hot read/write path memoises this
 * per-ctx-db; see `createD1CtxDb`.
 */
const ensureGlobalTables = (exec: D1Exec, schema: SchemaLike): Promise<void> => runD1GlobalTableMigrations(exec, schema);

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
 * value** the facet returned (a SQLite scalar), bound as a parameter and never
 * interpolated. AND-combined with the other clauses.
 */
interface GlobalFilterClause {
    column: string;
    value: unknown;
}

interface ReadGlobalTablePageOptions {
    filters?: GlobalFilterClause[];
    limit?: number;
    offset?: number;
    table: string;
}

/**
 * Options for {@link facetGlobalColumn} — the read-only "what values does this
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
 * Payload of a {@link facetGlobalColumn} call: the top-N distinct `values` (each
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
 * Bookkeeping tables that must never surface in the browser: SQLite internals
 * (`sqlite_*`), Cloudflare D1 internals (`_cf_*`, `d1_*`), and Lunora index
 * companions (`__agg_`/`__rank_`/`__fts_` infixes, the `__cdc_log`). Everything
 * else — the schema's `.global()` tables and any external/auth tables — is fair
 * game.
 */
const INTERNAL_TABLE = /^sqlite_|^_cf_|^d1_|^__cdc|__agg_|__rank_|__fts_/u;

const isInternalTable = (name: string): boolean => INTERNAL_TABLE.test(name);

/** Column names whose values are redacted in non-schema tables, so auth secrets can't leak through the browser. */
const SENSITIVE_COLUMN = /password|secret|token|hash|salt|credential/iu;

/** List every browsable D1 table name (internal/companion tables excluded), sorted. */
const listTableNames = async (exec: D1Exec): Promise<string[]> => {
    const rows = await exec.all("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", []);

    return rows.map((row) => String(row["name"])).filter((name) => !isInternalTable(name));
};

const countRows = async (exec: D1Exec, quotedTable: string, whereSql = "", whereParams: unknown[] = []): Promise<number> => {
    const rows = await exec.all(`SELECT COUNT(*) AS c FROM ${quotedTable}${whereSql}`, whereParams);

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
    schema.tables[table] !== undefined && displayColumn === "_id" ? "id" : displayColumn;

/**
 * Compile a list of eq constraints into a bound `WHERE` fragment for the global
 * read/facet paths. Each clause's column is validated against the table's
 * displayed columns (typed 404 if unknown) and mapped to its physical, quoted
 * identifier; a nullish value compiles to `IS NULL` (SQL's `= NULL` never
 * matches), everything else to `= ?` with the raw value bound. Returns
 * `undefined` when there are no clauses, so callers append nothing.
 */
const buildEqPredicate = (
    schema: SchemaLike,
    table: string,
    displayColumns: string[],
    filters: GlobalFilterClause[] | undefined,
): { params: unknown[]; where: string } | undefined => {
    if (filters === undefined || filters.length === 0) {
        return undefined;
    }

    const clauses: string[] = [];
    const params: unknown[] = [];

    for (const filter of filters) {
        if (!displayColumns.includes(filter.column)) {
            throw new LunoraError("UNKNOWN_COLUMN", `unknown column: ${filter.column}`, { status: 404 });
        }

        // An eq filter on a redacted column of an external (non-schema) table
        // would leak an equality oracle: `total`/count reveals whether a guessed
        // value matched, bypassing the '•••' redaction. Reject it, mirroring the
        // facet path's masked-bucket collapse. Declared `.global()` tables (whose
        // values are not redacted) intentionally bypass this guard.
        if (schema.tables[table] === undefined && SENSITIVE_COLUMN.test(filter.column)) {
            throw new LunoraError("FORBIDDEN", `cannot filter on a redacted column: ${filter.column}`, { status: 403 });
        }

        const quoted = quoteIdentifier(physicalColumnName(schema, table, filter.column));

        if (filter.value === null || filter.value === undefined) {
            clauses.push(`${quoted} IS NULL`);
        } else {
            clauses.push(`${quoted} = ?`);
            params.push(filter.value);
        }
    }

    return { params, where: clauses.join(" AND ") };
};

/**
 * Decode a SELECTed D1 row. A schema `.global()` table is decoded via the shared
 * {@link decodeGlobalRow} (re-exposing `_id`, JSON/bigint/boolean round-trips);
 * any other table (e.g. a better-auth table) is passed through with its real
 * columns, redacting obviously-sensitive values.
 */
const decodeRow = (schema: SchemaLike, table: string, row: Record<string, unknown>): Record<string, unknown> => {
    const definition = schema.tables[table];

    if (definition) {
        return decodeGlobalRow(definition, row);
    }

    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        redacted[key] = value !== null && value !== undefined && SENSITIVE_COLUMN.test(key) ? "•••" : value;
    }

    return redacted;
};

/**
 * Columns the browser shows for `table`: a schema `.global()` table uses its
 * declared fields plus the framework columns (`_id`, `_creationTime`); any other
 * table uses its real physical columns from `PRAGMA table_info`.
 */
const resolveColumns = async (exec: D1Exec, schema: SchemaLike, table: string): Promise<string[]> => {
    const definition = schema.tables[table];

    if (definition) {
        return ["_id", "_creationTime", ...Object.keys(definition.shape)];
    }

    const info = await exec.all(`PRAGMA table_info(${quoteIdentifier(table)})`, []);

    return info.map((column) => String(column["name"]));
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
const resolveReferences = async (exec: D1Exec, schema: SchemaLike, table: string): Promise<Record<string, string> | undefined> => {
    if (schema.tables[table]) {
        return undefined;
    }

    const rows = await exec.all(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`, []);

    if (rows.length === 0) {
        return undefined;
    }

    const references: Record<string, string> = {};

    for (const row of rows) {
        const from = String(row["from"]);
        const target = String(row["table"]);

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
const listGlobalTables = async (exec: D1Exec, schema: SchemaLike): Promise<GlobalTableInfo[]> => {
    await ensureGlobalTables(exec, schema);

    const names = await listTableNames(exec);

    // Independent COUNT(*) probes — fan out and preserve the sorted order.
    return Promise.all(
        names.map(async (name) => {
            return { name, rowCount: await countRows(exec, quoteIdentifier(name)) };
        }),
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
const readGlobalTablePage = async (exec: D1Exec, schema: SchemaLike, options: ReadGlobalTablePageOptions): Promise<GlobalTablePage> => {
    const { table } = options;

    await ensureGlobalTables(exec, schema);

    const tableNames = await listTableNames(exec);

    if (!tableNames.includes(table)) {
        throw new LunoraError("UNKNOWN_TABLE", `unknown table: ${table}`, { status: 404 });
    }

    const limit = clamp(Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const quoted = quoteIdentifier(table);
    const columns = await resolveColumns(exec, schema, table);
    const predicate = buildEqPredicate(schema, table, columns, options.filters);
    const whereSql = predicate === undefined ? "" : ` WHERE ${predicate.where}`;
    const whereParams = predicate?.params ?? [];

    const total = await countRows(exec, quoted, whereSql, whereParams);
    const raw = await exec.all(`SELECT * FROM ${quoted}${whereSql} LIMIT ? OFFSET ?`, [...whereParams, limit, offset]);
    const rows = raw.map((row) => decodeRow(schema, table, row));
    const references = await resolveReferences(exec, schema, table);

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
 */
const facetGlobalColumn = async (exec: D1Exec, schema: SchemaLike, options: FacetGlobalColumnOptions): Promise<GlobalFacetResult> => {
    const { column, table } = options;

    await ensureGlobalTables(exec, schema);

    const tableNames = await listTableNames(exec);

    if (!tableNames.includes(table)) {
        throw new LunoraError("UNKNOWN_TABLE", `unknown table: ${table}`, { status: 404 });
    }

    const columns = await resolveColumns(exec, schema, table);

    if (!columns.includes(column)) {
        throw new LunoraError("UNKNOWN_COLUMN", `unknown column: ${column}`, { status: 404 });
    }

    const quoted = quoteIdentifier(table);
    const predicate = buildEqPredicate(schema, table, columns, options.filters);
    const whereSql = predicate === undefined ? "" : ` WHERE ${predicate.where}`;
    const whereParams = predicate?.params ?? [];

    // Faceting a sensitive column on an external table would expose the very
    // values the page browser redacts — collapse it to one masked bucket instead.
    if (schema.tables[table] === undefined && SENSITIVE_COLUMN.test(column)) {
        const total = await countRows(exec, quoted, whereSql, whereParams);

        return { truncated: false, values: total === 0 ? [] : [{ count: total, value: "•••" }] };
    }

    const limit = clamp(Math.trunc(options.limit ?? DEFAULT_FACET_LIMIT), 1, MAX_FACET_LIMIT);
    const physical = quoteIdentifier(physicalColumnName(schema, table, column));

    // Over-fetch one row past the cap to detect (and report) truncation.
    const rows = await exec.all(`SELECT ${physical} AS value, COUNT(*) AS count FROM ${quoted}${whereSql} GROUP BY ${physical} ORDER BY count DESC LIMIT ?`, [
        ...whereParams,
        limit + 1,
    ]);

    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;

    return {
        truncated,
        values: kept.map((row) => {
            return { count: Number(row["count"]), value: row["value"] };
        }),
    };
};

export { facetGlobalColumn, listGlobalTables, readGlobalTablePage };
export type { FacetGlobalColumnOptions, GlobalFacetResult, GlobalFacetValue, GlobalFilterClause, GlobalTableInfo, GlobalTablePage, ReadGlobalTablePageOptions };
