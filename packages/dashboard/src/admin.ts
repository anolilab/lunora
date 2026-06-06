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
    exportShard: "__cirrus_admin__:exportShard",
    getFunctionStats: "__cirrus_admin__:getFunctionStats",
    listTableIndexes: "__cirrus_admin__:listTableIndexes",
    getLogs: "__cirrus_admin__:getLogs",
    getMetrics: "__cirrus_admin__:getMetrics",
    importShard: "__cirrus_admin__:importShard",
    listTables: "__cirrus_admin__:listTables",
    migrationStatus: "__cirrus_admin__:migrationStatus",
    readTablePage: "__cirrus_admin__:readTablePage",
    runMigration: "__cirrus_admin__:runMigration",
    writeRow: "__cirrus_admin__:writeRow",
} as const;

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
 * Per-function execution counters returned by `__cirrus_admin__:getFunctionStats`
 * for one shard. Mirrors `@cirrus/do`'s `FunctionCallStat`. Counters are
 * per-DO-instance and reset on hibernation/restart — a "since this instance
 * woke" readout. Durations are handler wall-clock milliseconds.
 */
export interface FunctionCallStat {
    calls: number;
    errors: number;
    lastCalledAt: number;
    lastErrorAt: null | number;
    lastErrorMessage: null | string;
    maxDurationMs: number;
    path: string;
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
