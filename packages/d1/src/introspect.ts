/**
 * Read-only D1 introspection for the dashboard's database browser.
 *
 * The DO twin (`@cirrus/do`'s `introspect.ts`) lists shard-local tables and
 * pages their rows from the DO's JSON-blob SQLite. This is the D1 counterpart.
 *
 * It surfaces **every** real table in the D1 database, not just the ones the
 * schema marks `.global()` — so the dashboard reflects the actual database,
 * including tables managed by other libraries (e.g. better-auth's
 * `user`/`session`/`account`/`verification`). Two guardrails keep that safe:
 *
 * - Internal/bookkeeping tables (SQLite, Cloudflare D1, Cirrus companions for
 *   aggregate/rank/fts/cdc indexes) are filtered out — see {@link isInternalTable}.
 * - Values in obviously-sensitive columns (password/token/secret/hash/salt) are
 *   redacted, so browsing an external auth table can't leak credentials.
 *
 * `.global()` tables declared in the schema are decoded back into their doc
 * shape (re-exposing `_id`, folding booleans); any other table is shown with its
 * real physical columns.
 */
import type { SchemaLike } from "@cirrus/do";

import type { D1Exec } from "./d1-ctx-db.js";
import { decodeGlobalRow, runD1GlobalTableMigrations } from "./d1-ctx-db.js";

/**
 * Provision the schema's `.global()` tables before the browser reads them, so a
 * fresh database lists/pages them instead of failing with `no such table`. The
 * DDL is idempotent (`CREATE … IF NOT EXISTS`) and admin introspection isn't a
 * hot path, so it runs unmemoised — correct for any (exec, schema) pair rather
 * than caching against a single binding. The hot read/write path memoises this
 * per-ctx-db; see {@link createD1CtxDb}.
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
    rows: Record<string, unknown>[];
    total: number;
}

interface ReadGlobalTablePageOptions {
    limit?: number;
    offset?: number;
    table: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Bookkeeping tables that must never surface in the browser: SQLite internals
 * (`sqlite_*`), Cloudflare D1 internals (`_cf_*`, `d1_*`), and Cirrus index
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

const countRows = async (exec: D1Exec, quotedTable: string): Promise<number> => {
    const rows = await exec.all(`SELECT COUNT(*) AS c FROM ${quotedTable}`, []);

    return Number(rows[0]?.["c"] ?? 0);
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
 * List every browsable D1 table with its row count, ordered by name. Surfaces
 * both the schema's `.global()` tables (provisioned first) and external tables
 * (auth, etc.); internal/companion tables are excluded.
 */
const listGlobalTables = async (exec: D1Exec, schema: SchemaLike): Promise<GlobalTableInfo[]> => {
    await ensureGlobalTables(exec, schema);

    const names = await listTableNames(exec);

    // Independent COUNT(*) probes — fan out and preserve the sorted order.
    return Promise.all(names.map(async (name) => ({ name, rowCount: await countRows(exec, quoteIdentifier(name)) })));
};

/**
 * Read a page of rows from one D1 table. The table is validated against the live
 * browsable-table list before its name is interpolated, so this can't be coerced
 * into reading an internal table or injecting SQL. `limit` is clamped to
 * `[1, 500]`; `offset` floors at `0`.
 */
const readGlobalTablePage = async (exec: D1Exec, schema: SchemaLike, options: ReadGlobalTablePageOptions): Promise<GlobalTablePage> => {
    const { table } = options;

    await ensureGlobalTables(exec, schema);

    if (!(await listTableNames(exec)).includes(table)) {
        throw Object.assign(new Error(`unknown table: ${table}`), { code: "UNKNOWN_TABLE", name: "CirrusError", status: 404 });
    }

    const limit = clamp(Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const quoted = quoteIdentifier(table);

    const total = await countRows(exec, quoted);
    const raw = await exec.all(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, [limit, offset]);
    const rows = raw.map((row) => decodeRow(schema, table, row));

    return { columns: await resolveColumns(exec, schema, table), rows, total };
};

export { listGlobalTables, readGlobalTablePage };
export type { GlobalTableInfo, GlobalTablePage, ReadGlobalTablePageOptions };
