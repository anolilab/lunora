import type { SqlExec } from "./ctx-db.js";

/**
 * Reserved `functionPath` prefix for admin introspection RPCs. These travel
 * over the same `/_cirrus/rpc` → shard `/rpc` path as ordinary functions, but
 * `ShardDO` intercepts them before user dispatch and serves them from the
 * helpers below. The `__cirrus_` namespace is reserved (it also backs the FTS
 * capability probe), so a real generated `&lt;file>:&lt;function>` can never collide.
 */
const ADMIN_FUNCTION_PREFIX = "__cirrus_admin__:";

/**
 * Fully-qualified reserved paths the data browser invokes. The
 * `__cirrus_admin__:` prefix is spelled out inline rather than interpolated so
 * the values stay emittable under `--isolatedDeclarations`.
 */
const ADMIN_FUNCTIONS = {
    applyCdc: "__cirrus_admin__:applyCdc",
    cdcSync: "__cirrus_admin__:cdcSync",
    exportShard: "__cirrus_admin__:exportShard",
    getFunctionStats: "__cirrus_admin__:getFunctionStats",
    listTableIndexes: "__cirrus_admin__:listTableIndexes",
    getLogs: "__cirrus_admin__:getLogs",
    getMetrics: "__cirrus_admin__:getMetrics",
    importShard: "__cirrus_admin__:importShard",
    listTables: "__cirrus_admin__:listTables",
    migrationStatus: "__cirrus_admin__:migrationStatus",
    rankBefore: "__cirrus_admin__:rankBefore",
    readTablePage: "__cirrus_admin__:readTablePage",
    runMigration: "__cirrus_admin__:runMigration",
    writeRow: "__cirrus_admin__:writeRow",
} as const;

/** A user table plus its current row count. */
interface TableInfo {
    name: string;
    rowCount: number;
}

/**
 * Per-function execution counters served by `__cirrus_admin__:getFunctionStats`,
 * one entry per `&lt;file>:&lt;function>` path dispatched since this DO instance woke.
 * Like `getMetrics`'s counters these are in-memory and reset on
 * hibernation/restart — a "since this instance woke" readout, not a durable
 * time series. Durations are wall-clock milliseconds of the handler call itself
 * (before the subscription write-flush), so `totalDurationMs / calls` is the
 * mean and `maxDurationMs` the slowest single call.
 */
interface FunctionCallStat {
    /** Total dispatches, successful or failed. */
    calls: number;
    /** Subset of `calls` that threw. */
    errors: number;
    /** Epoch-ms of the most recent dispatch. */
    lastCalledAt: number;
    /** Epoch-ms of the most recent failure, or `null` if none has thrown. */
    lastErrorAt: null | number;
    /** Message of the most recent failure, or `null` if none has thrown. */
    lastErrorMessage: null | string;
    /** Slowest single dispatch, in milliseconds. */
    maxDurationMs: number;
    /** The `&lt;file>:&lt;function>` identifier, e.g. `messages:list`. */
    path: string;
    /** Summed handler wall-clock across every dispatch; divide by `calls` for the mean. */
    totalDurationMs: number;
}

/**
 * One declared index on a table, flattened across cirrus's index kinds for the
 * schema viewer. `fields` is the indexed columns (a secondary index's columns,
 * a rank index's sort fields, a search index's text + filter fields, or a vector
 * index's source field). `unique` is set only for unique secondary indexes.
 * Sourced from the schema (the codegen subclass overrides the base hook), since
 * the physical SQLite indexes are `json_extract` expressions with no field names.
 */
interface TableIndexInfo {
    fields: string[];
    name: string;
    type: "index" | "rank" | "search" | "vector";
    unique?: boolean;
}

/** Payload of a `__cirrus_admin__:listTableIndexes` call: every declared index on the table. */
interface TableIndexesResult {
    indexes: TableIndexInfo[];
}

/** Payload of a `__cirrus_admin__:getFunctionStats` call. */
interface FunctionStatsResult {
    /** One entry per dispatched function path, newest-called first. */
    functions: FunctionCallStat[];
    /** Epoch-ms this instance began collecting (shared with `getMetrics`). */
    sinceMs: number;
}

/** A window of rows from one table, plus the column list and total size. */
interface TablePage {
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

interface ReadTablePageOptions {
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

/** JSON-parse to a plain object, or `undefined` when the text isn't a JSON object. */
const safeParseObject = (text: string): Record<string, unknown> | undefined => {
    try {
        const value = JSON.parse(text) as unknown;

        return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
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
const expandDocumentRows = (columns: string[], rows: Record<string, unknown>[]): { columns: string[]; rows: Record<string, unknown>[] } => {
    if (!columns.includes(DOC_COLUMN)) {
        return { columns, rows };
    }

    const parsed: Record<string, unknown>[] = [];

    for (const row of rows) {
        const raw = row[DOC_COLUMN];
        const documentData = typeof raw === "string" ? safeParseObject(raw) : undefined;

        if (documentData === undefined) {
            // A row whose doc isn't a JSON object — bail on expansion entirely
            // rather than emit a ragged, half-expanded page.
            return { columns, rows };
        }

        const meta = Object.fromEntries(Object.entries(row).filter(([column]) => column !== DOC_COLUMN));

        parsed.push({ ...meta, ...documentData });
    }

    const metaColumns = columns.filter((name) => name !== DOC_COLUMN);
    const documentKeys: string[] = [];
    const seen = new Set<string>(metaColumns);

    for (const documentData of parsed) {
        for (const key of Object.keys(documentData)) {
            if (!seen.has(key)) {
                seen.add(key);
                documentKeys.push(key);
            }
        }
    }

    return { columns: [...metaColumns, ...documentKeys], rows: parsed };
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
    name.startsWith("sqlite_") || name.startsWith("_cf_") || name.startsWith("__miniflare") || name.startsWith("__cirrus") || name.includes("__fts_");

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
const listTables = (sql: SqlExec): TableInfo[] => {
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
const readTablePage = (sql: SqlExec, options: ReadTablePageOptions): TablePage => {
    const { table } = options;

    if (isInternalTable(table) || !tableExists(sql, table)) {
        throw Object.assign(new Error(`unknown table: ${table}`), { code: "UNKNOWN_TABLE", name: "CirrusError", status: 404 });
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
    const withReferences = (page: { columns: string[]; rows: Record<string, unknown>[]; total: number }): TablePage => {
        if (options.refs === undefined) {
            return page;
        }

        const references: Record<string, string> = {};

        for (const column of page.columns) {
            const target = options.refs[column];

            if (target !== undefined) {
                references[column] = target;
            }
        }

        return Object.keys(references).length > 0 ? { ...page, refs: references } : page;
    };

    // No filter: a plain windowed read against the full row count. Rows are
    // expanded from `__doc__` so the user fields show as columns (no-op for the
    // synthetic column-per-field tables used in tests).
    if (needle === "" || columns.length === 0) {
        const total = countRows(sql, quoted);
        const rawRows = sql.exec(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, limit, offset).toArray();
        const expanded = expandDocumentRows(columns, rawRows);

        return withReferences({ ...expanded, total });
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
    const expanded = expandDocumentRows(columns, rawRows);

    return withReferences({ ...expanded, total });
};

export { ADMIN_FUNCTION_PREFIX, ADMIN_FUNCTIONS, listTables, readTablePage };
export type { FunctionCallStat, FunctionStatsResult, ReadTablePageOptions, TableIndexesResult, TableIndexInfo, TableInfo, TablePage };
