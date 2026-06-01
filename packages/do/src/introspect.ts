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
    getLogs: "__cirrus_admin__:getLogs",
    getMetrics: "__cirrus_admin__:getMetrics",
    importShard: "__cirrus_admin__:importShard",
    listTables: "__cirrus_admin__:listTables",
    migrationStatus: "__cirrus_admin__:migrationStatus",
    readTablePage: "__cirrus_admin__:readTablePage",
    runMigration: "__cirrus_admin__:runMigration",
    writeRow: "__cirrus_admin__:writeRow",
} as const;

/** A user table plus its current row count. */
export interface TableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one table, plus the column list and total size. */
export interface TablePage {
    columns: string[];
    /**
     * Map of column → target table for foreign-key columns (those declared
     * `v.id("target")` in the schema), so a UI can render them as links. Absent
     * when the caller passes no `refs` (the base, schema-free read).
     */
    refs?: Record<string, string>;
    rows: Record<string, unknown>[];
    total: number;
}

export interface ReadTablePageOptions {
    limit?: number;
    offset?: number;
    /**
     * Foreign-key map (doc field → target table) from the schema, echoed back on
     * the page so a UI can link `v.id("target")` cells. The base read has no
     * schema and passes nothing; the codegen subclass supplies it.
     */
    refs?: Record<string, string>;
    /**
     * Case-insensitive substring filter applied across every column server-side
     * (each column `CAST … AS TEXT LIKE`). When set, `total` reflects the
     * matching-row count so pagination stays correct over the filtered set.
     * Empty/whitespace is treated as no filter.
     */
    search?: string;
    table: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** The physical columns of a canonical Cirrus shard table (user fields live in `__doc__`). */
const DOC_COLUMN = "__doc__";

/** JSON-parse to a plain object, or `null` when the text isn't a JSON object. */
const safeParseObject = (text: string): Record<string, unknown> | null => {
    try {
        const value = JSON.parse(text) as unknown;

        return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

/**
 * Expand the JSON-blob storage into per-field columns for display. A canonical
 * Cirrus shard table physically has `id`, `_creationTime` and a `__doc__` JSON
 * string holding every user field; raw, the data browser would show one opaque
 * blob cell. This parses each row's `__doc__` and lifts its keys to top-level
 * columns (meta columns first, then the page's union of doc keys in first-seen
 * order). Conservative: expands only when EVERY row's `__doc__` parses to an
 * object — otherwise (or for non-doc tables, e.g. the synthetic test fixtures)
 * it returns the rows untouched, so this is fully backward-compatible.
 */
const expandDocRows = (columns: string[], rows: Record<string, unknown>[]): { columns: string[]; rows: Record<string, unknown>[] } => {
    if (!columns.includes(DOC_COLUMN)) {
        return { columns, rows };
    }

    const parsed: Record<string, unknown>[] = [];

    for (const row of rows) {
        const raw = row[DOC_COLUMN];
        const doc = typeof raw === "string" ? safeParseObject(raw) : null;

        if (doc === null) {
            // A row whose doc isn't a JSON object — bail on expansion entirely
            // rather than emit a ragged, half-expanded page.
            return { columns, rows };
        }

        const { [DOC_COLUMN]: _omit, ...meta } = row;

        parsed.push({ ...meta, ...doc });
    }

    const metaColumns = columns.filter((name) => name !== DOC_COLUMN);
    const docKeys: string[] = [];
    const seen = new Set<string>(metaColumns);

    for (const doc of parsed) {
        for (const key of Object.keys(doc)) {
            if (!seen.has(key)) {
                seen.add(key);
                docKeys.push(key);
            }
        }
    }

    return { columns: [...metaColumns, ...docKeys], rows: parsed };
};

/** Escape LIKE wildcards so a user's literal `%`/`_`/`\` match themselves (paired with `ESCAPE '\'`). */
const escapeLike = (value: string): string => value.replaceAll(/[\\%_]/g, (character) => `\\${character}`);

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

const tableExists = (sql: SqlExec, table: string): boolean =>
    sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", table).toArray().length > 0;

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

    const columns = sql
        .exec<{ name: string }>(`PRAGMA table_info(${quoted})`)
        .toArray()
        .map((column) => column.name);

    const needle = options.search?.trim() ?? "";

    // Echo only the refs whose column actually surfaces (a UI links those cells).
    const withRefs = (page: { columns: string[]; rows: Record<string, unknown>[]; total: number }): TablePage => {
        if (options.refs === undefined) {
            return page;
        }

        const refs: Record<string, string> = {};

        for (const column of page.columns) {
            const target = options.refs[column];

            if (target !== undefined) {
                refs[column] = target;
            }
        }

        return Object.keys(refs).length > 0 ? { ...page, refs } : page;
    };

    // No filter: a plain windowed read against the full row count. Rows are
    // expanded from `__doc__` so the user fields show as columns (no-op for the
    // synthetic column-per-field tables used in tests).
    if (needle === "" || columns.length === 0) {
        const total = countRows(sql, quoted);
        const rawRows = sql.exec(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, limit, offset).toArray();
        const expanded = expandDocRows(columns, rawRows);

        return withRefs({ ...expanded, total });
    }

    // Server-side search: OR a case-insensitive LIKE across every PHYSICAL column.
    // For doc-stored tables the `__doc__` JSON text contains every field value,
    // so a substring match over it covers all user fields. Column names come from
    // PRAGMA (validated) and the pattern is a bound parameter, so neither injects
    // SQL. `total` is the filtered count, keeping the client's pager honest.
    const pattern = `%${escapeLike(needle)}%`;
    const where = columns.map((name) => String.raw`CAST(${quoteIdentifier(name)} AS TEXT) LIKE ? ESCAPE '\'`).join(" OR ");
    const matchParams = columns.map(() => pattern);

    const total = Number(sql.exec<{ c: number | bigint }>(`SELECT COUNT(*) AS c FROM ${quoted} WHERE ${where}`, ...matchParams).one().c);
    const rawRows = sql.exec(`SELECT * FROM ${quoted} WHERE ${where} LIMIT ? OFFSET ?`, ...matchParams, limit, offset).toArray();
    const expanded = expandDocRows(columns, rawRows);

    return withRefs({ ...expanded, total });
};
