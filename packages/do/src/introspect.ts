import type { SqlExec } from "./ctx-db";

/**
 * Reserved `functionPath` prefix for admin introspection RPCs. These travel
 * over the same `/_cirrus/rpc` → shard `/rpc` path as ordinary functions, but
 * `ShardDO` intercepts them before user dispatch and serves them from the
 * helpers below. The `__cirrus_` namespace is reserved (it also backs the FTS
 * capability probe), so a real generated `&lt;file>:&lt;function>` can never collide.
 */
const ADMIN_FUNCTION_PREFIX = "__cirrus_admin__:";

/**
 * Reserved `functionPath` prefix for cross-shard relation reads. Backs reverse
 * cross-backend relations: a `.global()` (D1) parent loading a shard-local
 * child whose rows span every shard. Like {@link ADMIN_FUNCTION_PREFIX} these
 * travel the `/_cirrus/rpc` → shard `/rpc` path and are intercepted before user
 * dispatch — but they are NOT admin-token-gated. Instead they run under the
 * forwarded caller identity and are reachable ONLY via the Query Coordinator's
 * fan-out (the worker refuses the prefix on a single-shard envelope), so a
 * direct client RPC can never reach them. `:read` returns the bare child-row
 * array, `:count` a bare number, so the coordinator's `concat`/`sum` merge
 * composes the per-shard results.
 */
const RELATION_FUNCTION_PREFIX = "__cirrus_relation__:";

/**
 * Fully-qualified reserved paths the data browser invokes. The
 * `__cirrus_admin__:` prefix is spelled out inline rather than interpolated so
 * the values stay emittable under `--isolatedDeclarations`.
 */
const ADMIN_FUNCTIONS = {
    applyCdc: "__cirrus_admin__:applyCdc",
    cdcSync: "__cirrus_admin__:cdcSync",
    clearCapturedMail: "__cirrus_admin__:clearCapturedMail",
    clearTable: "__cirrus_admin__:clearTable",
    deleteRows: "__cirrus_admin__:deleteRows",
    exportShard: "__cirrus_admin__:exportShard",
    getAdvisories: "__cirrus_admin__:getAdvisories",
    getAuditLog: "__cirrus_admin__:getAuditLog",
    getAuthMetrics: "__cirrus_admin__:getAuthMetrics",
    getCapturedMail: "__cirrus_admin__:getCapturedMail",
    getFunctionStats: "__cirrus_admin__:getFunctionStats",
    listSubscriptions: "__cirrus_admin__:listSubscriptions",
    listTableIndexes: "__cirrus_admin__:listTableIndexes",
    getLogs: "__cirrus_admin__:getLogs",
    getMetrics: "__cirrus_admin__:getMetrics",
    getPitrBookmark: "__cirrus_admin__:getPitrBookmark",
    getRequestLog: "__cirrus_admin__:getRequestLog",
    getSecurityAudit: "__cirrus_admin__:getSecurityAudit",
    getSettings: "__cirrus_admin__:getSettings",
    importShard: "__cirrus_admin__:importShard",
    listTables: "__cirrus_admin__:listTables",
    migrationStatus: "__cirrus_admin__:migrationStatus",
    pitrRestore: "__cirrus_admin__:pitrRestore",
    rankBefore: "__cirrus_admin__:rankBefore",
    rankPage: "__cirrus_admin__:rankPage",
    readTablePage: "__cirrus_admin__:readTablePage",
    recordAuthEvent: "__cirrus_admin__:recordAuthEvent",
    recordMail: "__cirrus_admin__:recordMail",
    rlsPolicies: "__cirrus_admin__:rlsPolicies",
    runAs: "__cirrus_admin__:runAs",
    runMigration: "__cirrus_admin__:runMigration",
    runSql: "__cirrus_admin__:runSql",
    sendTestMail: "__cirrus_admin__:sendTestMail",
    storageReferences: "__cirrus_admin__:storageReferences",
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
 * is a monotonic per-shard cursor the studio pages through; `op` is the short
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
 * One live subscription tracked on a shard's WebSocket, as surfaced by
 * `__cirrus_admin__:listSubscriptions`. Mirrors the persisted `SubscriptionQuery`
 * attachment shape: `functionPath` is the `&lt;file>:&lt;function>` query re-run on a
 * matching write (absent on legacy delta-only subscriptions), `table` is the
 * table the raw-delta fan-out matches against, and `args` are the query args.
 */
interface SubscriptionInfo {
    args?: Record<string, unknown>;
    functionPath?: string;
    table?: string;
}

/**
 * One connected WebSocket on the shard and the subscriptions it tracks. `id` is
 * the socket's index in `getWebSockets()` order (a stable label within a single
 * read, not a durable identifier), `admin` is `true` when the socket upgraded
 * with the admin token, and `subscriptions` enumerates its live subscriptions.
 */
interface SubscriptionConnection {
    admin: boolean;
    id: number;
    subscriptions: SubscriptionInfo[];
}

/**
 * Payload of a `__cirrus_admin__:listSubscriptions` call: a read-only snapshot of
 * every connected socket and its subscriptions, plus aggregate counts. Derived
 * live from `getWebSockets()` + each socket's attachment — nothing durable.
 */
interface SubscriptionsResult {
    connections: SubscriptionConnection[];
    totalConnections: number;
    totalSubscriptions: number;
}

/**
 * One full-scan attribution entry on a {@link FunctionCallStat}: how many times
 * the function full-scanned `table` (a read with no index / point lookup). This
 * is the causal evidence behind the Insights "missing index" / "full scan"
 * signal — it pins a slow function to the specific table it scanned, so the
 * studio can say "`feed:list` is slow BECAUSE it full-scanned `posts`" and
 * deep-link to add the index.
 */
interface FunctionScanAttribution {
    /** Total full-scans of `table` attributed to this function. */
    scans: number;
    /** The full-scanned table name. */
    table: string;
}

/**
 * Per-function execution counters served by `__cirrus_admin__:getFunctionStats`,
 * one entry per `&lt;file>:&lt;function>` path dispatched since this DO instance woke.
 * Like `getMetrics`'s counters these are in-memory and reset on
 * hibernation/restart — a "since this instance woke" readout, not a durable
 * time series. Durations are wall-clock milliseconds of the handler call itself
 * (before the subscription write-flush), so `totalDurationMs / calls` is the
 * mean and `maxDurationMs` the slowest single call.
 *
 * `scans` and `scannedTables` carry the causal full-scan attribution (added by
 * PLAN3 1.2). They're additive: older consumers ignore them, and a worker that
 * predates the feature simply reports `scans: 0` / `scannedTables: []`.
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

    /**
     * Per-table full-scan attribution, busiest scan first — the causal evidence
     * for the "missing index" insight. Empty when the function never
     * full-scanned a table (the indexed case) or on a worker predating 1.2.
     */
    scannedTables: FunctionScanAttribution[];
    /** Total full-table scans across every dispatch (sum of `scannedTables[].scans`). */
    scans: number;
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

/**
 * One static schema advisory, surfaced by `__cirrus_admin__:getAdvisories`.
 * Structurally mirrors `@cirrus/advisor`'s `Finding` (splinter-shaped) — the
 * codegen subclass emits these from the advisor's output, and the DO serves
 * them without depending on `@cirrus/advisor` itself. Kept in lockstep with that
 * `Finding` shape; the generated `CIRRUS_ADVISORIES` literal is typed against it.
 */
interface AdvisoryFinding {
    /** Stable id for dedup/dismissal across runs. */
    cacheKey: string;
    /** Concern buckets, e.g. `["PERFORMANCE"]`. */
    categories: string[];
    /** General description of the rule. */
    description: string;
    /** The specific violation message for this occurrence. */
    detail: string;
    /** Who the finding concerns. */
    facing: "EXTERNAL" | "INTERNAL";
    /** Severity. */
    level: "ERROR" | "INFO" | "WARN";
    /** Structured context (table, field, index, …). */
    metadata: Record<string, unknown>;
    /** The lint id that produced it, e.g. `unindexed_foreign_key`. */
    name: string;
    /** How to fix it. */
    remediation: string;
    /** Short headline. */
    title: string;
}

/** Payload of a `__cirrus_admin__:getAdvisories` call: the static schema advisories for this deployment. */
interface AdvisoriesResult {
    advisories: AdvisoryFinding[];
}

/**
 * One row-level-security policy entry, surfaced by `__cirrus_admin__:rlsPolicies`
 * to the studio's read-only RLS inspector. Mirrors `@cirrus/codegen`'s
 * `RlsPolicyIR`: the policy's `table` + `on` operation and the procedure whose
 * `.use(rls(...))` chain declared it. Never the `when` predicate — that's an
 * opaque closure whose logic lives in code, so only its existence is reported.
 * The codegen subclass overrides the `rlsMetadata()` hook with these.
 */
interface RlsPolicyMetadata {
    /** Source file (relative to `cirrus/`, without extension) the policy is declared in. */
    file: string;
    /** Operation gated: `read` covers get/query/findMany; the rest are writes. */
    on: "delete" | "insert" | "read" | "update";
    /** Export name of the procedure whose builder chain declared the policy. */
    procedure: string;
    /** Logical table the policy applies to. */
    table: string;
}

/**
 * One RLS role declaration, surfaced by `__cirrus_admin__:rlsPolicies`. Mirrors
 * `@cirrus/codegen`'s `RlsRoleIR`: the role `name`, optional `description`, and
 * the permission names it grants.
 */
interface RlsRoleMetadata {
    /** Optional human-readable description from `defineRole(name, { description })`. */
    description?: string;
    /** Role label attached to the request identity (e.g. `"admin"`). */
    name: string;
    /** Permission names this role grants. */
    permissions: string[];
}

/** Payload of a `__cirrus_admin__:rlsPolicies` call: the schema's policy + role metadata for the RLS inspector. */
interface RlsPoliciesResult {
    policies: RlsPolicyMetadata[];
    roles: RlsRoleMetadata[];
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

/** Sort direction for an {@link OrderByClause}. */
type SortDirection = "asc" | "desc";

/**
 * A server-side sort over one displayed column. `column` resolves the same way a
 * {@link FilterClause}'s does — a physical/meta column orders by its identifier, a
 * `__doc__` field orders by a bound `json_extract` path — so the whole table is
 * ordered before the page is windowed, not just the loaded rows. `direction` is a
 * fixed ASC/DESC keyword, so nothing here can inject SQL.
 */
interface OrderByClause {
    column: string;
    direction: SortDirection;
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
     * Server-side sort over one displayed column. Applied to the whole filtered
     * table before windowing, so paging through a sorted view stays correct.
     * Omitted → natural (insertion) order.
     */
    orderBy?: OrderByClause;

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
 * Resolve a displayed column to its SQL expression plus any bound path params —
 * the single home for the injection-safe allowlist + bound-path discipline shared
 * by {@link buildFilterClause} and {@link buildOrderBy}. A physical/meta column
 * compiles to its quoted identifier (no params); a `__doc__` field to
 * `json_extract(__doc__, ?)` with the JSON path (`$."field"`) **bound**, never
 * interpolated. Returns `undefined` for an unknown column on a non-doc table.
 */
const resolveColumnExpression = (column: string, physicalColumns: string[]): undefined | { expression: string; params: unknown[] } => {
    const isPhysical = physicalColumns.includes(column);
    const isDocumentStored = physicalColumns.includes(DOC_COLUMN);

    if (!isPhysical && !isDocumentStored) {
        return undefined;
    }

    return isPhysical
        ? { expression: quoteIdentifier(column), params: [] }
        : { expression: `json_extract(${quoteIdentifier(DOC_COLUMN)}, ?)`, params: [`$."${column.replaceAll('"', '""')}"`] };
};

/**
 * Compile one {@link FilterClause} into a parameterised SQL conjunct, or
 * `undefined` to skip it (an unknown column on a non-doc table). The compared
 * expression + bound path params come from {@link resolveColumnExpression}; the
 * value is always bound too, so a clause can never inject SQL.
 */
const buildFilterClause = (clause: FilterClause, physicalColumns: string[]): { params: unknown[]; sql: string } | undefined => {
    const resolved = resolveColumnExpression(clause.column, physicalColumns);

    if (resolved === undefined) {
        return undefined;
    }

    const { expression, params: pathParameters } = resolved;

    if (clause.operator === "contains") {
        return {
            params: [...pathParameters, `%${escapeLike(filterValueText(clause.value))}%`],
            sql: String.raw`CAST(${expression} AS TEXT) LIKE ? ESCAPE '\'`,
        };
    }

    return { params: [...pathParameters, clause.value], sql: `${expression} ${FILTER_SQL_OPERATOR[clause.operator]} ?` };
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
const buildTablePredicate = (columns: string[], needle: string, filters: FilterClause[] | undefined): undefined | { parameters: unknown[]; where: string } => {
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
 * Build the `ORDER BY` fragment for a server-side sort. Resolves the displayed
 * column exactly as {@link buildFilterClause} does — a physical/meta column orders
 * by its quoted identifier, a `__doc__` field by a bound `json_extract` path
 * (never interpolated) — and appends a fixed ASC/DESC keyword. An unknown column
 * yields `undefined` (the read falls back to natural order). SQL-injection-safe by
 * the same allowlist + bound-path discipline as the filter builder.
 */
const buildOrderBy = (orderBy: OrderByClause | undefined, physicalColumns: string[]): undefined | { params: unknown[]; sql: string } => {
    if (orderBy === undefined) {
        return undefined;
    }

    const resolved = resolveColumnExpression(orderBy.column, physicalColumns);

    if (resolved === undefined) {
        return undefined;
    }

    const keyword = orderBy.direction === "desc" ? "DESC" : "ASC";

    return { params: resolved.params, sql: `${resolved.expression} ${keyword}` };
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
    const order = buildOrderBy(options.orderBy, columns);

    // Assemble WHERE / ORDER BY fragments and their bound params in SQL order
    // (where params, then order-by path params, then limit/offset). The COUNT is
    // order-independent, so it omits the ORDER BY clause and its params.
    const whereSql = predicate === undefined ? "" : ` WHERE ${predicate.where}`;
    const orderSql = order === undefined ? "" : ` ORDER BY ${order.sql}`;
    const whereParams = predicate?.parameters ?? [];
    const orderParams = order?.params ?? [];

    const total =
        predicate === undefined
            ? countRows(sql, quoted)
            : Number(sql.exec<{ c: number | bigint }>(`SELECT COUNT(*) AS c FROM ${quoted}${whereSql}`, ...whereParams).one().c);
    const rawRows = sql.exec(`SELECT * FROM ${quoted}${whereSql}${orderSql} LIMIT ? OFFSET ?`, ...whereParams, ...orderParams, limit, offset).toArray();

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

/** One row that references a stored R2 object through a `v.storage()` column. */
interface StorageReference {
    /** The `v.storage()` column the key was found in. */
    column: string;
    /** Primary key (`id`) of the owning row. */
    id: string;
    /** The table the owning row lives in. */
    table: string;
}

/**
 * Result of {@link findStorageReferences}: the schema's declared storage columns
 * (so a UI can tell "the app models no storage refs" apart from "this object is
 * orphaned"), plus, for each requested key, the rows that reference it. A key
 * mapped to an empty array is an **orphan** on this shard — no row points at it.
 */
interface StorageReferenceResult {
    references: Record<string, StorageReference[]>;
    storageColumns: Record<string, string[]>;
}

/**
 * Build the reverse index from R2 object key → the rows that reference it, for the
 * file browser's records↔files join (PLAN3 §1.3). `storageColumns` is the
 * schema-derived `{ table: [field, …] }` map the codegen subclass supplies (empty
 * for the base, schema-free DO); `keys` are the object keys the caller is
 * displaying (a single page of the bucket). Every requested key is seeded to an
 * empty array, so a key that stays empty is an orphan (no owning row on this
 * shard). Scans only the declared storage columns — never the whole shard — and
 * resolves each column to its physical/`__doc__` expression with the same
 * injection-safe, bound-parameter discipline as {@link readTablePage}.
 */
const findStorageReferences = (sql: SqlExec, storageColumns: Record<string, string[]>, keys: string[]): StorageReferenceResult => {
    const references: Record<string, StorageReference[]> = {};

    // Seed every requested key so the caller can distinguish orphan (empty) from
    // not-requested (absent), and cap the IN-list so a huge page can't bloat the
    // query — keys beyond the cap simply aren't resolved this call.
    const scanned = keys.slice(0, MAX_PAGE_SIZE);

    for (const key of scanned) {
        references[key] = [];
    }

    if (scanned.length === 0) {
        return { references, storageColumns };
    }

    const placeholders = scanned.map(() => "?").join(", ");

    for (const [table, columns] of Object.entries(storageColumns)) {
        if (isInternalTable(table) || !tableExists(sql, table)) {
            continue;
        }

        const quoted = quoteIdentifier(table);
        const physicalColumns = sql
            .exec<{ name: string }>(`PRAGMA table_info(${quoted})`)
            .toArray()
            .map((column) => column.name);

        for (const column of columns) {
            const resolved = resolveColumnExpression(column, physicalColumns);

            if (resolved === undefined) {
                continue;
            }

            // The column expression appears twice (SELECT … AS ref, then WHERE …
            // IN), so its bound path params are supplied twice, ahead of the key
            // list — matching the SQL textual order.
            const rows = sql
                .exec<{
                    id: string;
                    ref: string;
                }>(
                    `SELECT id, ${resolved.expression} AS ref FROM ${quoted} WHERE ${resolved.expression} IN (${placeholders})`,
                    ...resolved.params,
                    ...resolved.params,
                    ...scanned,
                )
                .toArray();

            for (const row of rows) {
                references[row.ref]?.push({ column, id: row.id, table });
            }
        }
    }

    return { references, storageColumns };
};

/**
 * One socket's attachment as seen by {@link summarizeSubscriptions} — the same
 * shape `ShardDO.readAttachment` returns (`./types`' `SocketAttachment`),
 * narrowed here to just the fields the summary needs so this stays a pure,
 * harness-testable function with no dependency on the DO runtime.
 */
interface SocketAttachmentLike {
    admin?: boolean;
    subs?: Record<string, SubscriptionInfo>;
}

/**
 * Fold a per-socket list of attachments into the {@link SubscriptionsResult} the
 * data browser renders: one {@link SubscriptionConnection} per socket (index =
 * `id`, `admin` from the attachment, `subscriptions` = the attachment's `subs`
 * values), plus the socket count and the summed subscription count. Pure — the
 * DO method just feeds it `getWebSockets().map(readAttachment)`.
 */
const summarizeSubscriptions = (attachments: SocketAttachmentLike[]): SubscriptionsResult => {
    const connections: SubscriptionConnection[] = attachments.map((attachment, id) => {
        const subscriptions = Object.values(attachment.subs ?? {}).map((sub): SubscriptionInfo => {
            return { args: sub.args, functionPath: sub.functionPath, table: sub.table };
        });

        return { admin: attachment.admin === true, id, subscriptions };
    });

    const totalSubscriptions = connections.reduce((sum, connection) => sum + connection.subscriptions.length, 0);

    return { connections, totalConnections: connections.length, totalSubscriptions };
};

export { ADMIN_FUNCTION_PREFIX, ADMIN_FUNCTIONS, findStorageReferences, listTables, MAX_PAGE_SIZE, readTablePage, RELATION_FUNCTION_PREFIX, selectMatchingIds, summarizeSubscriptions };
export type {
    AdvisoriesResult,
    AdvisoryFinding,
    AuditEntry,
    AuditLogResult,
    DeployInfo,
    FilterClause,
    FilterOperator,
    FunctionCallStat,
    FunctionScanAttribution,
    FunctionStatsResult,
    OrderByClause,
    ReadTablePageOptions,
    RlsPoliciesResult,
    RlsPolicyMetadata,
    RlsRoleMetadata,
    SelectMatchingIdsOptions,
    SettingEntry,
    SettingKind,
    SettingsResult,
    SortDirection,
    StorageReference,
    StorageReferenceResult,
    SubscriptionConnection,
    SubscriptionInfo,
    SubscriptionsResult,
    TableIndexesResult,
    TableIndexInfo,
    TableInfo,
    TablePage,
};
