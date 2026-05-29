import type { SqlExec } from "./ctx-db.js";

/**
 * Reserved `functionPath` prefix for admin introspection RPCs. These travel
 * over the same `/_cirrus/rpc` → shard `/rpc` path as ordinary functions, but
 * {@link ShardDO} intercepts them before user dispatch and serves them from the
 * helpers below. The `__cirrus_` namespace is reserved (it also backs the FTS
 * capability probe), so a real generated `<file>:<function>` can never collide.
 */
export const ADMIN_FUNCTION_PREFIX = "__cirrus_admin__:";

/**
 * Fully-qualified reserved paths the data browser invokes. The
 * `__cirrus_admin__:` prefix is spelled out inline rather than interpolated so
 * the values stay emittable under `--isolatedDeclarations`.
 */
export const ADMIN_FUNCTIONS = {
    exportShard: "__cirrus_admin__:exportShard",
    importShard: "__cirrus_admin__:importShard",
    listTables: "__cirrus_admin__:listTables",
    migrationStatus: "__cirrus_admin__:migrationStatus",
    readTablePage: "__cirrus_admin__:readTablePage",
    runMigration: "__cirrus_admin__:runMigration",
} as const;

/** A user table plus its current row count. */
export interface TableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one table, plus the column list and total size. */
export interface TablePage {
    columns: string[];
    rows: Record<string, unknown>[];
    total: number;
}

export interface ReadTablePageOptions {
    limit?: number;
    offset?: number;
    table: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/**
 * Tables the data browser must never surface: SQLite's own bookkeeping
 * (`sqlite_*`), Cloudflare's Durable Object KV mirror (`_cf_*`), the Cirrus FTS
 * capability probe and any FTS5 shadow tables (whose names carry the reserved
 * `__fts_` infix, e.g. `messages__fts_body` and its internal `*_data` / `*_idx`
 * siblings).
 */
const isInternalTable = (name: string): boolean =>
    name.startsWith("sqlite_") || name.startsWith("_cf_") || name.startsWith("__cirrus") || name.includes("__fts_");

/** Double-quote a SQL identifier, escaping any embedded double quotes. */
const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

const countRows = (sql: SqlExec, quotedTable: string): number => {
    const row = sql.exec<{ c: number | bigint }>(`SELECT COUNT(*) AS c FROM ${quotedTable}`).one();

    return Number(row.c);
};

/**
 * List every user table in this shard's SQLite database with its row count,
 * ordered by name. Internal and FTS shadow tables are filtered out.
 */
export const listTables = (sql: SqlExec): TableInfo[] => {
    const names = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray();

    const tables: TableInfo[] = [];

    for (const { name } of names) {
        if (isInternalTable(name)) {
            continue;
        }

        tables.push({ name, rowCount: countRows(sql, quoteIdentifier(name)) });
    }

    return tables;
};

/**
 * Read a page of rows from one user table. The table name is validated against
 * the live `sqlite_master` allowlist (and rejected if it is internal or
 * unknown) before it is ever interpolated into SQL, so this cannot be coerced
 * into reading bookkeeping tables or injecting SQL. `limit` is clamped to
 * `[1, 500]`; `offset` floors at `0`.
 */
export const readTablePage = (sql: SqlExec, options: ReadTablePageOptions): TablePage => {
    const { table } = options;

    if (isInternalTable(table) || !tableExists(sql, table)) {
        throw Object.assign(new Error(`unknown table: ${table}`), { name: "CirrusError", code: "UNKNOWN_TABLE", status: 404 });
    }

    const limit = clamp(Math.trunc(options.limit ?? DEFAULT_PAGE_SIZE), 1, MAX_PAGE_SIZE);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const quoted = quoteIdentifier(table);

    const total = countRows(sql, quoted);
    const rows = sql.exec(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, limit, offset).toArray();
    const columns = sql
        .exec<{ name: string }>(`PRAGMA table_info(${quoted})`)
        .toArray()
        .map((column) => column.name);

    return { columns, rows, total };
};

const tableExists = (sql: SqlExec, table: string): boolean =>
    sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", table).toArray().length > 0;
