/**
 * Wire constants and row shapes for the dashboard's admin introspection RPCs.
 *
 * These mirror the contract that `@cirrus/do`'s `introspect`, `data-migration`
 * and `admin-export-import` modules serve (the `__cirrus_admin__:*` reserved
 * `functionPath`s intercepted in `ShardDO.handleAdminRpc`). They are duplicated
 * here deliberately: the dashboard ships browser React components and must not
 * pull the Durable Object runtime into the bundle, so the only thing it shares
 * with the server is these plain strings and structural types.
 */
export const ADMIN_FUNCTION_PREFIX = "__cirrus_admin__:";

/**
 * Fully-qualified reserved paths the dashboard invokes via the client. The
 * `__cirrus_admin__:` prefix is spelled out inline rather than interpolated so
 * the values stay emittable under `--isolatedDeclarations`. Every path is
 * intercepted by `ShardDO` before user dispatch and gated by the server's
 * `CIRRUS_ADMIN_TOKEN`.
 */
export const ADMIN_FUNCTIONS = {
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
    readTablePage: "__cirrus_admin__:readTablePage",
    runMigration: "__cirrus_admin__:runMigration",
    writeRow: "__cirrus_admin__:writeRow",
} as const;

/** Comparison a {@link FilterClause} applies, mirroring `@cirrus/do`'s `FilterOperator`. `contains` is a substring (LIKE). */
export type FilterOperator = "contains" | "eq" | "gt" | "gte" | "lt" | "lte" | "ne";

/**
 * One structured column filter passed to `readTablePage`, mirroring `@cirrus/do`'s
 * `FilterClause`. AND-combined with the substring search and the other clauses.
 * `value` is sent as-is and bound server-side, so it never injects SQL.
 */
export interface FilterClause {
    column: string;
    operator: FilterOperator;
    value?: unknown;
}

/** Which single-row mutation a {@link WriteRowArgs} performs. */
export type WriteRowOp = "delete" | "insert" | "patch" | "replace";

/** Arguments for the `__cirrus_admin__:writeRow` admin op. */
export interface WriteRowArgs {
    /** The row's fields. Required for insert/patch/replace; omitted for delete. */
    doc?: Record<string, unknown>;
    /** Primary key of the target row. Required for patch/replace/delete. */
    id?: string;
    op: WriteRowOp;
    table: string;
}

/** Result of a {@link WriteRowArgs} op — the affected row's primary key. */
export interface WriteRowResult {
    id: null | string;
    op: WriteRowOp;
}

/**
 * Arguments for the `__cirrus_admin__:deleteRows` admin op — the writer-routed
 * bulk delete behind "delete matching". `filters`/`search` mirror
 * {@link TablePage}'s predicate args so the deleted set equals the previewed
 * one; `limit` caps the rows removed per call (clamped server-side). The server
 * removes each matched row through the schema-aware writer (keeping FTS /
 * aggregate / rank shadow tables in sync), bounded per call.
 */
export interface DeleteRowsArgs {
    filters?: FilterClause[];
    limit?: number;
    search?: string;
    table: string;
}

/**
 * Arguments for the `__cirrus_admin__:clearTable` admin op — "empty this table".
 * The same writer-routed bounded delete as {@link DeleteRowsArgs} with no
 * predicate (it matches every row).
 */
export interface ClearTableArgs {
    limit?: number;
    table: string;
}

/**
 * Result of a {@link DeleteRowsArgs} / {@link ClearTableArgs} op. `deleted` is
 * the rows removed in this call; `hasMore` is `true` when matching rows remain
 * beyond the server's per-call cap, so the caller loops a single bounded
 * round-trip rather than deleting an unbounded set at once.
 */
export interface BulkDeleteResult {
    deleted: number;
    hasMore: boolean;
}

/** Reactive-cache hit/miss/eviction stats, present when a cache is configured. */
export interface CacheStats {
    bytes: number;
    entries: number;
    evictions: number;
    hits: number;
    misses: number;
}

/** Health snapshot returned by `__cirrus_admin__:getMetrics` for one shard. */
export interface ShardMetrics {
    cache: CacheStats | null;
    databaseSize: null | number;
    errors: number;
    requests: number;
    shard: string;
    sinceMs: number;
    uptimeMs: number;
}

/**
 * One full-scan attribution entry on a {@link FunctionCallStat}, mirroring
 * `@cirrus/do`'s `FunctionScanAttribution`: how many times the function
 * full-scanned `table`. The causal evidence behind the "missing index" insight.
 */
export interface FunctionScanAttribution {
    scans: number;
    table: string;
}

/**
 * Per-function execution counters returned by `__cirrus_admin__:getFunctionStats`
 * for one shard. Mirrors `@cirrus/do`'s `FunctionCallStat`. Counters are
 * per-DO-instance and reset on hibernation/restart — a "since this instance
 * woke" readout. Durations are handler wall-clock milliseconds.
 *
 * `scans` / `scannedTables` carry the causal full-scan attribution (PLAN3 1.2).
 * They're additive — a worker predating the feature reports `scans: 0` and
 * `scannedTables: []`, so the fields are optional on the wire and the consumer
 * defaults them.
 */
export interface FunctionCallStat {
    calls: number;
    errors: number;
    lastCalledAt: number;
    lastErrorAt: null | number;
    lastErrorMessage: null | string;
    maxDurationMs: number;
    path: string;
    /** Per-table full-scan attribution, busiest scan first; absent on a pre-1.2 worker. */
    scannedTables?: FunctionScanAttribution[];
    /** Total full-table scans across every dispatch; absent on a pre-1.2 worker. */
    scans?: number;
    totalDurationMs: number;
}

/** Payload of a `__cirrus_admin__:getFunctionStats` call, mirroring `@cirrus/do`'s `FunctionStatsResult`. */
export interface FunctionStatsResult {
    functions: FunctionCallStat[];
    sinceMs: number;
}

/**
 * One declared index on a table, mirroring `@cirrus/do`'s `TableIndexInfo`.
 * `type` is the index kind; `fields` the indexed columns (sort fields for rank,
 * text + filter fields for search, source field for vector); `unique` is set
 * only for unique secondary indexes.
 */
export interface TableIndexInfo {
    fields: string[];
    name: string;
    type: "index" | "rank" | "search" | "vector";
    unique?: boolean;
}

/** Payload of a `__cirrus_admin__:listTableIndexes` call, mirroring `@cirrus/do`'s `TableIndexesResult`. */
export interface TableIndexesResult {
    indexes: TableIndexInfo[];
}

/** Severity of a buffered log entry, mirroring `@cirrus/do`'s `LogLevel`. */
export type LogLevel = "debug" | "error" | "info" | "warn";

/**
 * One buffered log line returned by `__cirrus_admin__:getLogs`. `functionPath`
 * is the RPC that produced it (when known); `timestamp` is epoch-ms. Mirrors
 * `@cirrus/do`'s `LogEntry`.
 */
export interface LogEntry {
    functionPath?: string;
    level: LogLevel;
    message: string;
    timestamp: number;
}

/** Payload of a `__cirrus_admin__:getLogs` call: the buffered entries, newest first. */
export interface LogsResult {
    entries: LogEntry[];
}

/**
 * One recorded admin operation returned by `__cirrus_admin__:getAuditLog`,
 * mirroring `@cirrus/do`'s `AuditEntry`. Unlike the in-memory logs, the audit
 * log is durable and survives hibernation/restart. `seq` is a monotonic
 * per-shard cursor; `op` the short op name (`writeRow`, `runMigration`,
 * `importShard`, `applyCdc`); `table`/`id` are present when the op targets one;
 * `detail` carries op-specific context (notably the acting `userId`).
 */
export interface AuditEntry {
    detail?: Record<string, unknown>;
    id?: string;
    op: string;
    seq: number;
    table?: string;
    ts: number;
}

/** Payload of a `__cirrus_admin__:getAuditLog` call: the recorded entries, newest first. */
export interface AuditLogResult {
    entries: AuditEntry[];
}

/**
 * How a deployment binding/var classifies, mirroring `@cirrus/do`'s `SettingKind`.
 * `var` is a plain Worker var, `secret` a sensitive string (always masked), and
 * `binding` a non-string binding object (R2/KV/DO/D1/queue/service).
 */
export type SettingKind = "binding" | "secret" | "var";

/**
 * One row of the read-only deployment-settings view, mirroring `@cirrus/do`'s
 * `SettingEntry`. `value` is a masked preview for `var`/`secret` strings (never
 * the raw secret) and `null` for `binding` entries. The server masks every
 * string value, so the dashboard only ever renders the masked text.
 */
export interface SettingEntry {
    /** Coarse runtime class for `binding` entries (`r2`, `kv`, `durable-object`, …). */
    bindingType?: string;
    kind: SettingKind;
    name: string;
    value: null | string;
}

/**
 * Best-effort deploy metadata, mirroring `@cirrus/do`'s `DeployInfo`. Every
 * field is optional: the server reads only what the Worker `env` exposes and
 * omits the rest.
 */
export interface DeployInfo {
    deploymentId?: string;
    environment?: string;
    versionTag?: string;
    workerUrl?: string;
}

/** Payload of a `__cirrus_admin__:getSettings` call, mirroring `@cirrus/do`'s `SettingsResult`. */
export interface SettingsResult {
    deploy: DeployInfo;
    settings: SettingEntry[];
}

/**
 * Payload of a `__cirrus_admin__:getPitrBookmark` call, mirroring `@cirrus/do`'s
 * `PitrBookmarkResult`. `current` names the shard's present point in history;
 * `forTime` is the bookmark nearest a queried time, present only when one was
 * asked for. Bookmarks are opaque, lexically-comparable strings.
 */
export interface PitrBookmarkResult {
    current: string;
    forTime?: string;
}

/**
 * Arguments for the `__cirrus_admin__:pitrRestore` RPC, mirroring `@cirrus/do`'s
 * `PitrRestoreArgs`. Provide a `bookmark` (wins) or a `time` (epoch-ms or ISO,
 * within 30 days); `restart` also `ctx.abort()`s so recovery applies now.
 */
export interface PitrRestoreArgs {
    bookmark?: string;
    restart?: boolean;
    time?: number | string;
}

/**
 * Result of a `__cirrus_admin__:pitrRestore` call, mirroring `@cirrus/do`'s
 * `PitrRestoreResult`. `undoBookmark` names the instant before recovery — keep
 * it to reverse the restore; `restarted` is whether the shard was aborted now.
 */
export interface PitrRestoreResult {
    restarted: boolean;
    restoredTo: string;
    undoBookmark: string;
}

/** A user table plus its current row count. */
export interface TableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one table, plus the column list and total size. */
export interface TablePage {
    columns: string[];
    /** Foreign-key columns (column → target table) for `v.id("target")` fields, so the UI can link those cells. */
    refs?: Record<string, string>;
    rows: Record<string, unknown>[];
    total: number;
}

/** Direction a data migration is run in. Mirrors `@cirrus/do`. */
export type MigrationDirection = "down" | "up";

/** Lifecycle of a data-migration run. Mirrors `@cirrus/do`. */
export type MigrationStatus = "completed" | "failed" | "in_progress";

/**
 * One persisted migration run-state row, as returned by the
 * `__cirrus_admin__:migrationStatus` RPC (`{ migrations: MigrationStatusRow[] }`).
 */
export interface MigrationStatusRow {
    changed: number;
    cursor: null | string;
    direction: MigrationDirection;
    error: null | string;
    id: string;
    processed: number;
    startedAt: null | number;
    status: MigrationStatus;
    updatedAt: null | number;
}

/** Result of a single `__cirrus_admin__:runMigration` invocation against one shard. */
export interface MigrationRunResult {
    changed: number;
    cursor: null | string;
    direction: MigrationDirection;
    dryRun: boolean;
    id: string;
    processed: number;
    status: MigrationStatus;
}

/** Arguments accepted by the `__cirrus_admin__:runMigration` RPC. */
export interface RunMigrationArgs {
    batchSize?: number;
    direction?: MigrationDirection;
    dryRun?: boolean;
    id: string;
    maxBatches?: number;
}

/** One NDJSON line: a row from `table`, shaped per its schema. */
export interface ExportRow {
    doc: Record<string, unknown>;
    table: string;
}

/** A row that could not be inserted during an import. */
export interface ImportError {
    code: string;
    line: number;
    message: string;
    table: string;
}

/** Result of a single `__cirrus_admin__:importShard` invocation against one shard. */
export interface ImportShardResult {
    conflicts: number;
    errors: ImportError[];
    inserted: Record<string, number>;
}
