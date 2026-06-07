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
    clearTable: "__cirrus_admin__:clearTable",
    deleteRows: "__cirrus_admin__:deleteRows",
    exportShard: "__cirrus_admin__:exportShard",
    getAuditLog: "__cirrus_admin__:getAuditLog",
    getFunctionStats: "__cirrus_admin__:getFunctionStats",
    listTableIndexes: "__cirrus_admin__:listTableIndexes",
    getLogs: "__cirrus_admin__:getLogs",
    getMetrics: "__cirrus_admin__:getMetrics",
    getPitrBookmark: "__cirrus_admin__:getPitrBookmark",
    getSettings: "__cirrus_admin__:getSettings",
    importShard: "__cirrus_admin__:importShard",
    listTables: "__cirrus_admin__:listTables",
    migrationStatus: "__cirrus_admin__:migrationStatus",
    pitrRestore: "__cirrus_admin__:pitrRestore",
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
 * One recorded admin operation served by `__cirrus_admin__:getAuditLog`, sourced
 * from the reserved `__cirrus_audit__` table (see `audit-log.ts`). Unlike the
 * in-memory `getMetrics`/`getFunctionStats` counters, the audit log is durable —
 * it survives hibernation/restart and is bounded only by a retention cap. `seq`
 * is a monotonic per-shard cursor the dashboard pages through; `op` is the short
 * op name (`writeRow`, `runMigration`, `importShard`, `applyCdc`); `table`/`id`
 * are present when the op targets one; `detail` carries op-specific context
 * (notably the acting `userId`).
 */
interface AuditEntry {
    /** JSON extra context (acting user, op-specific counts, …); absent when none was recorded. */
    detail?: Record<string, unknown>;
    /** Primary key of the affected row, when the op targets one. */
    id?: string;
    /** Short op identifier, e.g. `writeRow`. */
    op: string;
    /** Monotonic per-shard cursor — strictly increasing, never reused. */
    seq: number;
    /** Affected table, when the op targets one. */
    table?: string;
    /** Epoch-ms the op was recorded. */
    ts: number;
}

/** Payload of a `__cirrus_admin__:getAuditLog` call: the recorded entries, newest first. */
interface AuditLogResult {
    entries: AuditEntry[];
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

/**
 * How a deployment binding/var classifies, served by `__cirrus_admin__:getSettings`.
 *
 * - `var` — a plain-text Worker var (a non-secret-looking string from `[vars]`).
 * - `secret` — a string whose name/contents look sensitive (token/key/password/…); its value is always masked, never returned raw.
 * - `binding` — a non-string binding object (R2/KV/Durable Object/D1/queue/service/…); only the name and kind surface.
 */
type SettingKind = "binding" | "secret" | "var";

/**
 * One entry in the read-only deployment-settings view. `value` is a masked
 * preview for `var`/`secret` strings (never the raw secret) and `null` for
 * `binding` entries, where only the name and a coarse `bindingType` are known.
 * The Worker `env` is the single source of truth; everything is best-effort and
 * derived from what `env` actually exposes at runtime.
 */
interface SettingEntry {
    /**
     * For `binding` entries, a coarse runtime class derived from the object's
     * shape (`r2`, `kv`, `durable-object`, `d1`, `queue`, `service`, `object`),
     * so the UI can label it. Absent for `var`/`secret` string entries.
     */
    bindingType?: string;
    kind: SettingKind;
    name: string;
    /** Masked preview for string vars/secrets; `null` for non-string bindings. */
    value: null | string;
}

/**
 * Best-effort deploy metadata read from well-known vars in `env`, when present.
 * Every field is optional — Cirrus reads what the runtime happens to expose
 * (e.g. a `CF_PAGES_URL`/`WORKER_URL` var, a `CF_VERSION_METADATA` binding) and
 * omits what it can't reach rather than guessing. Infra config is edited in
 * wrangler/Cloudflare, never here.
 */
interface DeployInfo {
    /** Deployment id from the `CF_VERSION_METADATA` binding, when bound. */
    deploymentId?: string;
    /** Cloudflare environment name, from a `CF_ENV`/`ENVIRONMENT`/`WORKER_ENV` var. */
    environment?: string;
    /** Deployment tag from the `CF_VERSION_METADATA` binding, when bound. */
    versionTag?: string;
    /** Public URL of the deployment, from a `CF_PAGES_URL`/`WORKER_URL` var. */
    workerUrl?: string;
}

/** Payload of a `__cirrus_admin__:getSettings` call: the masked deployment config. */
interface SettingsResult {
    /** Best-effort deploy metadata; fields absent when not reachable from `env`. */
    deploy: DeployInfo;
    /** Every binding/var in `env`, sorted by name, with string values masked. */
    settings: SettingEntry[];
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

/** Comparison a {@link FilterClause} applies. `contains` is a case-sensitive substring (LIKE); the rest are direct SQL comparisons. */
type FilterOperator = "contains" | "eq" | "gt" | "gte" | "lt" | "lte" | "ne";

/**
 * One structured column filter — `column`, `operator`, `value` — AND-combined
 * with the substring `search` and every other clause. `column` is a displayed
 * column: a physical/meta column (compared directly) or a `__doc__` JSON field
 * (compared via `json_extract`, with the path bound as a parameter). The `value`
 * is always a bound parameter, so no clause can inject SQL.
 */
interface FilterClause {
    column: string;
    operator: FilterOperator;
    value?: unknown;
}

interface ReadTablePageOptions {
    /**
     * Structured column filters, AND-combined with each other and with `search`.
     * Each clause's value (and any `__doc__` path) is a bound parameter; the
     * column is matched against the table's displayed columns. `total` reflects
     * the filtered count so pagination stays honest.
     */
    filters?: FilterClause[];
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

/**
 * Options for {@link selectMatchingIds} — the id-collection half of the
 * writer-routed bulk delete. Mirrors {@link ReadTablePageOptions}'s predicate
 * args (`filters` + `search`) so "delete matching" removes exactly the rows the
 * data browser previews; `limit` caps the ids returned per batch (clamped to
 * `[1, 500]`) so the delete can never run unbounded.
 */
interface SelectMatchingIdsOptions {
    filters?: FilterClause[];
    limit?: number;
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

/** SQL operator per direct {@link FilterOperator} (everything but `contains`, which uses LIKE). */
const FILTER_SQL_OPERATOR: Record<Exclude<FilterOperator, "contains">, string> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=", ne: "<>" };

/** Coerce a filter value to its LIKE-pattern text, treating non-primitives as empty (they can't meaningfully substring-match). */
const filterValueText = (value: unknown): string => {
    if (typeof value === "string") {
        return value;
    }

    return typeof value === "number" || typeof value === "boolean" ? String(value) : "";
};

/**
 * Compile one {@link FilterClause} into a parameterised SQL conjunct, or
 * `undefined` to skip it (an unknown column on a non-doc table). The compared
 * expression is the physical column when `column` is one of the table's physical
 * columns, otherwise a `json_extract` of the `__doc__` blob with the JSON path
 * bound as a parameter. The value is always bound, so a clause can never inject SQL.
 */
const buildFilterClause = (clause: FilterClause, physicalColumns: string[]): { params: unknown[]; sql: string } | undefined => {
    const isPhysical = physicalColumns.includes(clause.column);
    const isDocumentStored = physicalColumns.includes(DOC_COLUMN);

    if (!isPhysical && !isDocumentStored) {
        return undefined;
    }

    // Physical/meta column → quoted identifier; doc field → json_extract with the
    // path bound (`$."field"`), never interpolated.
    const columnExpression = isPhysical ? quoteIdentifier(clause.column) : `json_extract(${quoteIdentifier(DOC_COLUMN)}, ?)`;
    const pathParameters: unknown[] = isPhysical ? [] : [`$."${clause.column.replaceAll('"', '""')}"`];

    if (clause.operator === "contains") {
        return {
            params: [...pathParameters, `%${escapeLike(filterValueText(clause.value))}%`],
            sql: String.raw`CAST(${columnExpression} AS TEXT) LIKE ? ESCAPE '\'`,
        };
    }

    return { params: [...pathParameters, clause.value], sql: `${columnExpression} ${FILTER_SQL_OPERATOR[clause.operator]} ?` };
};

/**
 * Compile the active substring `search` + structured `filters` into a single
 * AND-combined SQL predicate (or `undefined` when none apply). Shared by
 * {@link readTablePage} and {@link selectMatchingIds} so the "delete matching"
 * server op deletes EXACTLY the rows the data browser is previewing. Column
 * names come from PRAGMA (validated) and every value/path is a bound parameter,
 * so the assembled `where` can never inject SQL.
 *
 * The search conjunct is a case-insensitive LIKE OR'd across every PHYSICAL
 * column — for doc-stored tables `__doc__` holds every field value, so this
 * still covers all user fields.
 */
const buildTablePredicate = (
    columns: string[],
    needle: string,
    filters: FilterClause[] | undefined,
): undefined | { parameters: unknown[]; where: string } => {
    const conjuncts: string[] = [];
    const parameters: unknown[] = [];

    if (needle !== "" && columns.length > 0) {
        const pattern = `%${escapeLike(needle)}%`;

        conjuncts.push(`(${columns.map((name) => String.raw`CAST(${quoteIdentifier(name)} AS TEXT) LIKE ? ESCAPE '\'`).join(" OR ")})`);
        parameters.push(...columns.map(() => pattern));
    }

    for (const clause of filters ?? []) {
        const built = buildFilterClause(clause, columns);

        if (built !== undefined) {
            conjuncts.push(`(${built.sql})`);
            parameters.push(...built.params);
        }
    }

    return conjuncts.length === 0 ? undefined : { parameters, where: conjuncts.join(" AND ") };
};

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

    const predicate = buildTablePredicate(columns, needle, options.filters);

    // No predicates: a plain windowed read against the full row count.
    if (predicate === undefined) {
        const total = countRows(sql, quoted);
        const rawRows = sql.exec(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, limit, offset).toArray();

        return withReferences({ ...expandDocumentRows(columns, rawRows), total });
    }

    const { parameters, where } = predicate;
    const total = Number(sql.exec<{ c: number | bigint }>(`SELECT COUNT(*) AS c FROM ${quoted} WHERE ${where}`, ...parameters).one().c);
    const rawRows = sql.exec(`SELECT * FROM ${quoted} WHERE ${where} LIMIT ? OFFSET ?`, ...parameters, limit, offset).toArray();

    return withReferences({ ...expandDocumentRows(columns, rawRows), total });
};

/**
 * Select up to `limit + 1` primary keys of the rows in `table` matching the
 * active `search` + `filters` — the id set the writer-routed bulk-delete then
 * removes one row at a time (so FTS / aggregate / rank shadow tables stay in
 * sync). The same allowlist + bound-parameter discipline as {@link readTablePage}
 * applies; the table name is validated against `sqlite_master` before any
 * interpolation, so this can't be coerced into scanning bookkeeping tables.
 *
 * Returns the matched ids capped at `limit`, plus `hasMore` — `true` when a
 * `limit + 1`-th row existed — so the caller can loop bounded server calls
 * rather than deleting an unbounded set in one transaction. With no `search`
 * and no `filters` this matches the whole table (the `clearTable` path).
 */
const selectMatchingIds = (sql: SqlExec, options: SelectMatchingIdsOptions): { hasMore: boolean; ids: string[] } => {
    const { table } = options;

    if (isInternalTable(table) || !tableExists(sql, table)) {
        throw Object.assign(new Error(`unknown table: ${table}`), { code: "UNKNOWN_TABLE", name: "CirrusError", status: 404 });
    }

    const limit = clamp(Math.trunc(options.limit ?? MAX_PAGE_SIZE), 1, MAX_PAGE_SIZE);
    const quoted = quoteIdentifier(table);

    const columns = sql
        .exec<{ name: string }>(`PRAGMA table_info(${quoted})`)
        .toArray()
        .map((column) => column.name);

    const needle = options.search?.trim() ?? "";
    const predicate = buildTablePredicate(columns, needle, options.filters);

    // Over-fetch by one: a returned `limit + 1`-th row means more matches remain
    // beyond this batch, surfaced as `hasMore` (the extra id is dropped).
    const fetched =
        predicate === undefined
            ? sql.exec<{ id: string }>(`SELECT id FROM ${quoted} LIMIT ?`, limit + 1).toArray()
            : sql.exec<{ id: string }>(`SELECT id FROM ${quoted} WHERE ${predicate.where} LIMIT ?`, ...predicate.parameters, limit + 1).toArray();

    const hasMore = fetched.length > limit;
    const ids = (hasMore ? fetched.slice(0, limit) : fetched).map((row) => row.id);

    return { hasMore, ids };
};

export { ADMIN_FUNCTION_PREFIX, ADMIN_FUNCTIONS, listTables, readTablePage, selectMatchingIds };
export type {
    AuditEntry,
    AuditLogResult,
    DeployInfo,
    FilterClause,
    FilterOperator,
    FunctionCallStat,
    FunctionStatsResult,
    ReadTablePageOptions,
    SelectMatchingIdsOptions,
    SettingEntry,
    SettingKind,
    SettingsResult,
    TableIndexesResult,
    TableIndexInfo,
    TableInfo,
    TablePage,
};
