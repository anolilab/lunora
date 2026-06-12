/**
 * Wire constants and row shapes for the studio's admin introspection RPCs.
 *
 * These mirror the contract that `@cirrus/do`'s `introspect`, `data-migration`
 * and `admin-export-import` modules serve (the `__cirrus_admin__:*` reserved
 * `functionPath`s intercepted in `ShardDO.handleAdminRpc`). They are duplicated
 * here deliberately: the studio ships browser React components and must not
 * pull the Durable Object runtime into the bundle, so the only thing it shares
 * with the server is these plain strings and structural types.
 *
 * The one exception is `CapturedMail`: its canonical owner is `@cirrus/mail`
 * (not `@cirrus/do`), and the studio→mail dependency direction is allowed, so we
 * import + re-export that type below instead of hand-mirroring it.
 */

// Canonical captured-mail wire type, owned by `@cirrus/mail`. Type-only: erased
// at build time, so no mail *runtime* enters the studio's browser bundle.
import type { CapturedMail } from "@cirrus/mail";

export const ADMIN_FUNCTION_PREFIX = "__cirrus_admin__:";

/**
 * Fully-qualified reserved paths the studio invokes via the client. The
 * `__cirrus_admin__:` prefix is spelled out inline rather than interpolated so
 * the values stay emittable under `--isolatedDeclarations`. Every path is
 * intercepted by `ShardDO` before user dispatch and gated by the server's
 * `CIRRUS_ADMIN_TOKEN`.
 */
export const ADMIN_FUNCTIONS = {
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
    readTablePage: "__cirrus_admin__:readTablePage",
    rlsPolicies: "__cirrus_admin__:rlsPolicies",
    runAs: "__cirrus_admin__:runAs",
    runMigration: "__cirrus_admin__:runMigration",
    runSql: "__cirrus_admin__:runSql",
    sendTestMail: "__cirrus_admin__:sendTestMail",
    storageOrphans: "__cirrus_admin__:storageOrphans",
    storageReferences: "__cirrus_admin__:storageReferences",
    storageRules: "__cirrus_admin__:storageRules",
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

/**
 * One captured outbound email as served by `__cirrus_admin__:getCapturedMail`.
 * Persisted by `@cirrus/mail`'s dev capture transport into the root-shard
 * mailbox and rendered by the studio Mail inbox. `html`/`text` are the rendered
 * bodies; `to`/`cc`/`bcc` are the original recipient lists; `capturedAt` is
 * epoch-ms.
 *
 * Re-exported verbatim from `@cirrus/mail`, the canonical owner of the
 * captured-mail wire type (also imported at the top of this file for local use
 * in {@link CapturedMailResult}). This is NOT one of the hand-mirrored
 * `@cirrus/do` shapes below — it shares the real source of truth, so a field
 * added in `@cirrus/mail` flows here automatically.
 */
export type { CapturedMail } from "@cirrus/mail";

/** Result of `__cirrus_admin__:getCapturedMail` — the dev mail-catcher inbox, newest first. */
export interface CapturedMailResult {
    entries: CapturedMail[];
}

/**
 * Result of `__cirrus_admin__:sendTestMail` — the studio's "send a test message"
 * button. The server renders a fixed sample email through the capture transport
 * (nothing is delivered) and returns the new mailbox row's primary key, so the
 * caller can refresh the inbox and surface it.
 */
export interface SendTestMailResult {
    id: string;
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
 * One minute-bucketed per-function sample on a {@link MetricsSnapshot}, mirroring
 * `@cirrus/do`'s `FunctionMetricBucket & { path }`. `bucketMs` is the epoch-ms
 * floor of the 60s window; `calls`/`errors` are the per-window counts. The SLO
 * panel sums these across functions per bucket to draw the durable request /
 * error sparklines (PLAN3 §2.3) — unlike the Metrics panel's live in-memory series.
 */
export interface MetricsHistoryBucket {
    bucketMs: number;
    calls: number;
    errors: number;
    path: string;
}

/**
 * One declared index's recorded read count over the durable window, returned in
 * the `getMetrics` payload's `indexHits` array. The DO stamps a per-`(table,
 * index)` counter in the durable `__cirrus_metrics_index` table on every index
 * use (`onIndexUse`); this is its surfaced shape. It is identical to
 * `@cirrus/advisor`'s `AdvisorIndexHit`, so the studio passes it straight into
 * the runtime dead-index lint after summing across shards.
 */
export interface MetricsIndexHit {
    index: string;
    reads: number;
    table: string;
}

/**
 * The full `__cirrus_admin__:getMetrics` payload. The wire response carries the
 * per-function lifetime stats (`functions`), the durable time buckets
 * (`history`), and the per-`(table, index)` hit counts (`indexHits`) alongside
 * the {@link ShardMetrics} snapshot; all are optional so a pre-feature worker
 * (or a consumer that only needs the snapshot) still type-checks.
 */
export interface MetricsSnapshot extends ShardMetrics {
    functions?: FunctionCallStat[];
    history?: MetricsHistoryBucket[];
    /** Per-declared-index recorded reads; absent on a worker predating the dead-index feed. */
    indexHits?: MetricsIndexHit[];
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
 * One minute-bucketed auth sample returned by `__cirrus_admin__:getAuthMetrics`,
 * mirroring `@cirrus/do`'s `AuthMetricsBucket`. Backs the SLO panel's
 * auth-failure sparkline; `bucketMs` is the epoch-ms floor of the 60s window.
 */
export interface AuthMetricsBucket {
    attempts: number;
    bucketMs: number;
    failures: number;
}

/**
 * App-level auth-attempt metrics returned by `__cirrus_admin__:getAuthMetrics`
 * for the root shard, mirroring `@cirrus/do`'s `AuthMetrics`. Backs the SLO
 * panel's auth-failure rate (PLAN3 §2.3): `failureRate` is the precomputed
 * `attempts === 0 ? 0 : failures / attempts`, `history` the minute-bucketed
 * series (oldest first) for the sparkline, and `sinceMs` the first-attempt
 * marker. Auth runs as a top-level `/api/auth/*` route, so these are recorded by
 * the worker (not by cirrus-function metrics) and are durable across restart.
 */
export interface AuthMetrics {
    attempts: number;
    failureRate: number;
    failures: number;
    history: AuthMetricsBucket[];
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

/** Severity of a static schema advisory (the advisor's `Level`, lowercased to match the studio's tab levels). */
export type AdvisoryLevel = "ERROR" | "INFO" | "WARN";

/**
 * One static schema advisory, mirroring `@cirrus/advisor`'s `Finding` (served by
 * `__cirrus_admin__:getAdvisories`). These are codegen-time lints baked into the
 * deployed worker — they refresh on every codegen run (dev: on save; prod: on deploy).
 */
export interface AdvisoryFinding {
    cacheKey: string;
    categories: string[];
    description: string;
    detail: string;
    facing: "EXTERNAL" | "INTERNAL";
    level: AdvisoryLevel;
    metadata: Record<string, unknown>;
    name: string;
    remediation: string;
    title: string;
}

/** Payload of a `__cirrus_admin__:getAdvisories` call, mirroring `@cirrus/do`'s `AdvisoriesResult`. */
export interface AdvisoriesResult {
    advisories: AdvisoryFinding[];
}

/** The operation an RLS policy gates, mirroring `@cirrus/do`'s `RlsPolicyMetadata["on"]`. `read` covers get/query/findMany. */
export type RlsOperation = "delete" | "insert" | "read" | "update";

/**
 * One row-level-security policy entry, mirroring `@cirrus/do`'s
 * `RlsPolicyMetadata`. Read-only metadata for the RLS inspector: the policy's
 * `table` + `on` operation and the procedure whose `.use(rls(...))` chain
 * declared it. Never the `when` predicate — that's an opaque closure whose logic
 * lives in code, so the inspector reports only that a policy exists.
 */
export interface RlsPolicyMetadata {
    /** Source file (relative to `cirrus/`, without extension) the policy is declared in. */
    file: string;
    /** Operation gated by the policy. */
    on: RlsOperation;
    /** Export name of the procedure whose builder chain declared the policy. */
    procedure: string;
    /** Logical table the policy applies to. */
    table: string;
}

/** One RLS role declaration, mirroring `@cirrus/do`'s `RlsRoleMetadata`. */
export interface RlsRoleMetadata {
    /** Optional human-readable description from `defineRole(name, { description })`. */
    description?: string;
    /** Role label attached to the request identity (e.g. `"admin"`). */
    name: string;
    /** Permission names this role grants. */
    permissions: string[];
}

/** Payload of a `__cirrus_admin__:rlsPolicies` call, mirroring `@cirrus/do`'s `RlsPoliciesResult`. */
export interface RlsPoliciesResult {
    policies: RlsPolicyMetadata[];
    roles: RlsRoleMetadata[];
}

/** The operation a storage access rule gates, mirroring `@cirrus/do`'s `StorageRuleMetadata["on"]`. */
export type StorageOperation = "delete" | "list" | "read" | "write";

/**
 * One storage access-rule entry, mirroring `@cirrus/do`'s `StorageRuleMetadata`.
 * Read-only metadata for the access-rules view: the rule's `bucket` + `on`
 * operation + optional key `prefix` and the procedure whose
 * `.use(storageRules(...))` chain declared it. Never the `when` predicate.
 */
export interface StorageRuleMetadata {
    /** Logical bucket the rule applies to. */
    bucket: string;
    /** Source file (relative to `cirrus/`, without extension) the rule is declared in. */
    file: string;
    /** Operation gated by the rule. */
    on: StorageOperation;
    /** Optional key-prefix scope; absent ⇒ the whole bucket. */
    prefix?: string;
    /** Export name of the procedure whose builder chain declared the rule. */
    procedure: string;
}

/** Payload of a `__cirrus_admin__:storageRules` call, mirroring `@cirrus/do`'s `StorageRulesResult`. */
export interface StorageRulesResult {
    rules: StorageRuleMetadata[];
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
 * One live subscription tracked on a shard's WebSocket, returned by
 * `__cirrus_admin__:listSubscriptions` and mirroring `@cirrus/do`'s
 * `SubscriptionInfo`. `functionPath` is the `&lt;file>:&lt;function>` query re-run on
 * a matching write (absent on legacy delta-only subscriptions), `table` the
 * table the raw-delta fan-out matches, and `args` the query args.
 */
export interface SubscriptionInfo {
    args?: Record<string, unknown>;
    functionPath?: string;
    table?: string;
}

/**
 * One connected WebSocket and the subscriptions it tracks, mirroring
 * `@cirrus/do`'s `SubscriptionConnection`. `id` is the socket's index within a
 * single read (a label, not a durable identifier); `admin` is `true` when the
 * socket upgraded with the admin token.
 */
export interface SubscriptionConnection {
    admin: boolean;
    id: number;
    subscriptions: SubscriptionInfo[];
}

/**
 * Payload of a `__cirrus_admin__:listSubscriptions` call, mirroring `@cirrus/do`'s
 * `SubscriptionsResult`: a read-only snapshot of every connected socket and its
 * subscriptions, plus aggregate counts. Derived live from the shard's sockets —
 * nothing durable.
 */
export interface SubscriptionsResult {
    connections: SubscriptionConnection[];
    totalConnections: number;
    totalSubscriptions: number;
}

/** Outcome of one dispatch in the request log, mirroring `@cirrus/do`'s `RequestOutcome`. */
export type RequestOutcome = "error" | "ok";

/**
 * One structured `/rpc` dispatch returned by `__cirrus_admin__:getRequestLog`,
 * mirroring `@cirrus/do`'s `RequestLogEntry`. Unlike the in-memory `getLogs`
 * error buffer, the request log is durable and records EVERY dispatch with the
 * app-level context Cloudflare cannot attribute: the `&lt;file>:&lt;function>` path,
 * the shard key, the acting `userId`/identity, the (server-side redacted) args,
 * the outcome + error message, the handler duration, the tables read/written,
 * and whether the result came from the reactive cache. `seq` is a monotonic
 * per-shard cursor the panel pages through.
 */
export interface RequestLogEntry {
    /** Whether the result was served from the reactive cache; absent when the cache is off or the path isn't cached. */
    cacheHit?: boolean;
    /** Handler wall-clock duration in milliseconds. */
    durationMs: number;
    /** Error message when `outcome === "error"`; absent on success. */
    errorMessage?: string;
    /** The `&lt;file>:&lt;function>` identifier dispatched. */
    functionPath: string;
    /** Identity claims forwarded by the runtime; absent for anonymous requests. */
    identity?: Record<string, unknown>;
    /** `ok` for a returned result, `error` for a thrown handler. */
    outcome: RequestOutcome;
    /** Call args with leaf values redacted server-side (keys/shape preserved); absent when no args were sent. */
    redactedArgs?: unknown;
    /** Monotonic per-shard cursor — strictly increasing, never reused. */
    seq: number;
    /** Shard key (the DO id name); absent for the unnamed `__root__` DO. */
    shardKey?: string;
    /** Subscriptions re-run by this dispatch's write (`0` when none / not measured at the dispatch site). */
    subscriptionsReRun: number;
    /** Tables the handler read; empty when the reactive cache is off or nothing was read. */
    tablesRead: string[];
    /** Tables the handler wrote; empty for a read-only dispatch. */
    tablesWritten: string[];
    /** Epoch-ms the dispatch completed. */
    ts: number;
    /** Acting userId forwarded by the runtime; absent when anonymous. */
    userId?: string;
}

/** Payload of a `__cirrus_admin__:getRequestLog` call: the recorded entries, newest first. */
export interface RequestLogResult {
    entries: RequestLogEntry[];
}

/**
 * Correlated filters accepted by `__cirrus_admin__:getRequestLog`, mirroring
 * `@cirrus/do`'s `ReadRequestLogOptions`. All AND-combined and bound server-side.
 */
export interface RequestLogQuery {
    functionPathPrefix?: string;
    limit?: number;
    outcome?: RequestOutcome;
    shardKey?: string;
    sinceSeq?: number;
    tableTouched?: string;
    userId?: string;
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
 * string value, so the studio only ever renders the masked text.
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
 * Ordering/visual weight of a {@link SecurityFinding}, mirroring `@cirrus/do`'s
 * `SecurityFindingLevel`. Shares the studio's insight-severity vocabulary so the
 * Security and Performance advisors render with one badge palette.
 */
export type SecurityFindingLevel = "error" | "info" | "warning";

/**
 * Which deployment-level security heuristic fired, mirroring `@cirrus/do`'s
 * `SecurityFindingKind`. The studio maps each kind to a localized title,
 * explanation, and remediation hint; the wire payload carries only the kind,
 * level, and optional `detail`.
 */
export type SecurityFindingKind = "admin-token-weak" | "dev-args-unredacted" | "ws-gate-open";

/**
 * One detected security issue from `__cirrus_admin__:getSecurityAudit`, mirroring
 * `@cirrus/do`'s `SecurityFinding`. `detail` carries kind-specific context the
 * studio interpolates into the localized copy (e.g. `{ length, min }` for a weak
 * admin token); absent when the kind needs none.
 */
export interface SecurityFinding {
    detail?: Record<string, unknown>;
    kind: SecurityFindingKind;
    level: SecurityFindingLevel;
}

/** Payload of a `__cirrus_admin__:getSecurityAudit` call, mirroring `@cirrus/do`'s `SecurityAuditResult`: every finding, worst-first. */
export interface SecurityAuditResult {
    findings: SecurityFinding[];
}

/**
 * Payload of a `__cirrus_admin__:runSql` call, mirroring `@cirrus/do`'s
 * `SqlConsoleResult`: a read-only query's `columns` (from the first row), the
 * (capped) `rows`, the true `rowCount`, and whether the rows were `truncated`.
 */
export interface SqlConsoleResult {
    columns: string[];
    rowCount: number;
    rows: Record<string, unknown>[];
    truncated: boolean;
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

/**
 * One row that references a stored R2 object through a `v.storage()` column,
 * mirroring `@cirrus/do`'s `StorageReference`. `id` is the owning row's primary
 * key, `table`/`column` locate the reference — enough for the file browser to
 * deep-link from a file to the record that owns it.
 */
export interface StorageReference {
    column: string;
    id: string;
    table: string;
}

/**
 * Payload of a `__cirrus_admin__:storageReferences` call, mirroring `@cirrus/do`'s
 * `StorageReferenceResult` — the file browser's records↔files join (PLAN3 §1.3).
 * `storageColumns` is the schema's declared `v.storage()` columns (`{ table:
 * [field, …] }`), so the UI can tell "this app models no storage refs" apart from
 * "this object is orphaned"; `references` maps each requested object key to the
 * rows that reference it. A key mapped to an empty array is an **orphan** on the
 * queried shard — no row points at it.
 */
export interface StorageReferenceResult {
    references: Record<string, StorageReference[]>;
    storageColumns: Record<string, string[]>;
}

/**
 * One record field whose `v.storage()` value points at an object key that does
 * NOT exist in the bucket — a **dangling reference**, mirroring `@cirrus/do`'s
 * `DanglingReference`. `table`/`id`/`column` locate the owning record's field;
 * `key` is the missing object it references. The inverse of an orphan: the file
 * is gone, the record still points at it.
 */
export interface DanglingReference {
    column: string;
    id: string;
    key: string;
    table: string;
}

/**
 * Payload of a `__cirrus_admin__:storageOrphans` call, mirroring `@cirrus/do`'s
 * `DanglingReferenceResult` — the inverse of the records↔files join. Given the
 * bucket's live object keys, `references` lists every record `v.storage()` field
 * pointing at a key the bucket no longer has. `scanned` is how many storage-field
 * values were examined; `truncated` is `true` when a scan/result cap clipped the
 * set (the studio surfaces "showing the first N"). CF's R2 browser can never make
 * this join.
 */
export interface DanglingReferenceResult {
    references: DanglingReference[];
    scanned: number;
    truncated: boolean;
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

/* -------------------------------------------------------------------------- */
/* Cross-shard traffic feed (hot_shard advisor lint)                          */
/* -------------------------------------------------------------------------- */

/**
 * One shard's request total from the worker's `POST /_cirrus/admin/shard-traffic`
 * endpoint, mirroring `@cirrus/runtime`'s `ShardTrafficEntry`. `requests` is the
 * shard's lifetime dispatch count (`0` for a shard that failed/timed out);
 * `shardKey` is the DO id name (`""` for the root shard). The cross-shard feed
 * the `hot_shard` runtime advisor consumes to compute skew.
 */
export interface ShardTrafficEntry {
    requests: number;
    shardKey: string;
}

/**
 * Payload of a `POST /_cirrus/admin/shard-traffic` call, mirroring the runtime
 * coordinator's shard-traffic fan-out result: one `{ shardKey, requests }` entry
 * per live shard plus the ok / failed counts. Fanned out on demand (not on the
 * metrics hot path) so the panel can feed `hot_shard` the whole shard set's
 * request volumes.
 */
export interface ShardTrafficResult {
    failed: number;
    ok: number;
    shards: ShardTrafficEntry[];
}
