/**
 * Wire constants and row shapes for the studio's admin introspection RPCs.
 *
 * These mirror the contract that `@lunora/do`'s `introspect`, `data-migration`
 * and `admin-export-import` modules serve (the `__lunora_admin__:*` reserved
 * `functionPath`s intercepted in `ShardDO.handleAdminRpc`). They are duplicated
 * here deliberately: the studio ships browser React components and must not
 * pull the Durable Object runtime into the bundle, so the only thing it shares
 * with the server is these plain strings and structural types.
 *
 * The one exception is `CapturedMail`: its canonical owner is `@lunora/mail`
 * (not `@lunora/do`), and the studio→mail dependency direction is allowed, so we
 * import + re-export that type below instead of hand-mirroring it.
 */

// Canonical captured-mail wire type, owned by `@lunora/mail`. Type-only: erased
// at build time, so no mail *runtime* enters the studio's browser bundle.
import type { CapturedMail } from "@lunora/mail";
// Canonical registered-device wire type, owned by `@lunora/notify` (the
// secret-stripped projection the `listPushSubscriptions` RPC returns). Type-only,
// so no notify *runtime* enters the browser bundle — same allowed direction as
// the `@lunora/mail` type import above.
import type { PushSubscriptionDevice } from "@lunora/notify";

export const ADMIN_FUNCTION_PREFIX = "__lunora_admin__:";

/**
 * Fully-qualified reserved paths the studio invokes via the client. The
 * `__lunora_admin__:` prefix is spelled out inline rather than interpolated so
 * the values stay emittable under `--isolatedDeclarations`. Every path is
 * intercepted by `ShardDO` before user dispatch and gated by the server's
 * `LUNORA_ADMIN_TOKEN`.
 */
export const ADMIN_FUNCTIONS = {
    assignIssue: "__lunora_admin__:assignIssue",
    clearCapturedMail: "__lunora_admin__:clearCapturedMail",
    clearQueueMessages: "__lunora_admin__:clearQueueMessages",
    clearTable: "__lunora_admin__:clearTable",
    createWorkflowInstance: "__lunora_admin__:createWorkflowInstance",
    deleteRows: "__lunora_admin__:deleteRows",
    describeTable: "__lunora_admin__:describeTable",
    describeTables: "__lunora_admin__:describeTables",
    exportShard: "__lunora_admin__:exportShard",
    facetColumn: "__lunora_admin__:facetColumn",
    getAdvisories: "__lunora_admin__:getAdvisories",
    getAuditLog: "__lunora_admin__:getAuditLog",
    getAuthMetrics: "__lunora_admin__:getAuthMetrics",
    getCapturedMail: "__lunora_admin__:getCapturedMail",
    getFanoutMetrics: "__lunora_admin__:getFanoutMetrics",
    getFunctionStats: "__lunora_admin__:getFunctionStats",
    getIssues: "__lunora_admin__:getIssues",
    listFlags: "__lunora_admin__:listFlags",
    listPushSubscriptions: "__lunora_admin__:listPushSubscriptions",
    listQueues: "__lunora_admin__:listQueues",
    listSubscriptions: "__lunora_admin__:listSubscriptions",
    listTableIndexes: "__lunora_admin__:listTableIndexes",
    listWorkflows: "__lunora_admin__:listWorkflows",
    getLogs: "__lunora_admin__:getLogs",
    getMetricSeries: "__lunora_admin__:getMetricSeries",
    getMetrics: "__lunora_admin__:getMetrics",
    getPitrBookmark: "__lunora_admin__:getPitrBookmark",
    getQueueMessages: "__lunora_admin__:getQueueMessages",
    getRequestLog: "__lunora_admin__:getRequestLog",
    getSecurityAudit: "__lunora_admin__:getSecurityAudit",
    getSettings: "__lunora_admin__:getSettings",
    getTraces: "__lunora_admin__:getTraces",
    // eslint-disable-next-line no-secrets/no-secrets -- reserved admin RPC path constant, not a credential
    getWorkflowInstanceStatus: "__lunora_admin__:getWorkflowInstanceStatus",
    ignoreIssue: "__lunora_admin__:ignoreIssue",
    importShard: "__lunora_admin__:importShard",
    listTables: "__lunora_admin__:listTables",
    maskPolicies: "__lunora_admin__:maskPolicies",
    migrationStatus: "__lunora_admin__:migrationStatus",
    pitrRestore: "__lunora_admin__:pitrRestore",
    readTablePage: "__lunora_admin__:readTablePage",
    replayQueueMessage: "__lunora_admin__:replayQueueMessage",
    resolveIssue: "__lunora_admin__:resolveIssue",
    rlsPolicies: "__lunora_admin__:rlsPolicies",
    runAs: "__lunora_admin__:runAs",
    runMigration: "__lunora_admin__:runMigration",
    runSql: "__lunora_admin__:runSql",
    sendQueueMessage: "__lunora_admin__:sendQueueMessage",
    sendTestMail: "__lunora_admin__:sendTestMail",
    setIssueSeverity: "__lunora_admin__:setIssueSeverity",
    storageOrphans: "__lunora_admin__:storageOrphans",
    storageReferences: "__lunora_admin__:storageReferences",
    storageRules: "__lunora_admin__:storageRules",
    studioFeatures: "__lunora_admin__:studioFeatures",
    writeRow: "__lunora_admin__:writeRow",
} as const;

/** Comparison a {@link FilterClause} applies, mirroring `@lunora/do`'s `FilterOperator`. `contains` is a substring (LIKE). */
export type FilterOperator = "contains" | "eq" | "gt" | "gte" | "lt" | "lte" | "ne";

/**
 * One structured column filter passed to `readTablePage`, mirroring `@lunora/do`'s
 * `FilterClause`. AND-combined with the substring search and the other clauses.
 * `value` is sent as-is and bound server-side, so it never injects SQL.
 */
export interface FilterClause {
    column: string;
    operator: FilterOperator;
    value?: unknown;
}

/** One distinct value of a faceted column with its row count, mirroring `@lunora/do`'s `FacetValue`. */
export interface FacetValue {
    count: number;
    value: unknown;
}

/**
 * Payload of a `__lunora_admin__:facetColumn` call, mirroring `@lunora/do`'s
 * `FacetColumnResult`: the top-N distinct `values` (each with a `count`) ordered by
 * frequency, plus `truncated` — `true` when more distinct values existed beyond the
 * cap, so the UI can say so rather than imply the list is exhaustive.
 */
export interface FacetResult {
    truncated: boolean;
    values: FacetValue[];
}

/** Which single-row mutation a {@link WriteRowArgs} performs. */
export type WriteRowOp = "delete" | "insert" | "patch" | "replace";

/** Arguments for the `__lunora_admin__:writeRow` admin op. */
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
 * Result of a bulk delete (`__lunora_admin__:deleteRows` /
 * `__lunora_admin__:clearTable`) op. `deleted` is the rows removed in this call;
 * `hasMore` is `true` when matching rows remain beyond the server's per-call
 * cap, so the caller loops a single bounded round-trip rather than deleting an
 * unbounded set at once.
 */
export interface BulkDeleteResult {
    deleted: number;
    hasMore: boolean;
}

/**
 * One captured outbound email as served by `__lunora_admin__:getCapturedMail`.
 * Persisted by `@lunora/mail`'s dev capture transport into the root-shard
 * mailbox and rendered by the studio Mail inbox. `html`/`text` are the rendered
 * bodies; `to`/`cc`/`bcc` are the original recipient lists; `capturedAt` is
 * epoch-ms.
 *
 * Re-exported verbatim from `@lunora/mail`, the canonical owner of the
 * captured-mail wire type (also imported at the top of this file for local use
 * in {@link CapturedMailResult}). This is NOT one of the hand-mirrored
 * `@lunora/do` shapes below — it shares the real source of truth, so a field
 * added in `@lunora/mail` flows here automatically.
 */
export type { CapturedMail } from "@lunora/mail";

/** Result of `__lunora_admin__:getCapturedMail` — the dev mail-catcher inbox, newest first. */
export interface CapturedMailResult {
    entries: CapturedMail[];
}

/**
 * One registered `@lunora/notify` device subscription, re-exported verbatim from
 * `@lunora/notify` (its canonical owner) — the secret-stripped
 * {@link PushSubscriptionDevice} the `__lunora_admin__:listPushSubscriptions` RPC
 * returns (endpoint / kind / owner / timestamps + last-send status & error). The
 * Web Push encryption `keys` and the FCM `token` are dropped server-side and are
 * NOT part of this shape. Like `CapturedMail`, it shares the real source of truth,
 * so a field added in `@lunora/notify` flows here automatically.
 */
export type { PushSubscriptionDevice } from "@lunora/notify";

/** Payload of a `__lunora_admin__:listPushSubscriptions` call — the registered devices, newest register/send touch first. */
export interface PushSubscriptionsResult {
    subscriptions: PushSubscriptionDevice[];
}

/**
 * Result of `__lunora_admin__:sendTestMail` — the studio's "send a test message"
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

/** Health snapshot returned by `__lunora_admin__:getMetrics` for one shard. */
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
 * `@lunora/do`'s `FunctionMetricBucket & { path }`. `bucketMs` is the epoch-ms
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
 * index)` counter in the durable `__lunora_metrics_index` table on every index
 * use (`onIndexUse`); this is its surfaced shape. It is identical to
 * `@lunora/advisor`'s `AdvisorIndexHit`, so the studio passes it straight into
 * the runtime dead-index lint after summing across shards.
 */
export interface MetricsIndexHit {
    index: string;
    reads: number;
    table: string;
}

/**
 * One per-statement SQL aggregate returned in the `queryStats` field of a
 * {@link MetricsSnapshot}. Mirrors `@lunora/do`'s `QueryStatEntry`.
 *
 * `normalizedSql` is the SQL text with literal values stripped and truncated
 * to at most 512 characters. `execCount` is how many times the statement was
 * executed. `totalDurationMs` is the sum of wall-clock milliseconds across
 * all executions. `rowsRead` is the total SELECT result rows observed.
 * `rowsWritten` is always 0 in the current implementation, surfaced for
 * future extension. Derived fields such as `avgDurationMs` are computed
 * client-side by the studio's `metrics-aggregate.ts` rather than emitted by
 * the DO to keep the wire shape stable across DO restarts.
 */
export interface QueryStatEntry {
    execCount: number;
    normalizedSql: string;
    rowsRead: number;
    rowsWritten: number;
    totalDurationMs: number;
}

/**
 * The full `__lunora_admin__:getMetrics` payload. The wire response carries the
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

    /**
     * Per-statement SQL aggregates for the slow-query leaderboard. Absent on a
     * worker predating the query-metrics feature. Each entry carries the
     * normalised statement text, execution count, cumulative duration, and
     * observed row counts. The studio renders this as a sortable leaderboard
     * with performance badges, gated behind the presence of this field.
     */
    queryStats?: QueryStatEntry[];
}

/**
 * One full-scan attribution entry on a {@link FunctionCallStat}, mirroring
 * `@lunora/do`'s `FunctionScanAttribution`: how many times the function
 * full-scanned `table`. The causal evidence behind the "missing index" insight.
 */
export interface FunctionScanAttribution {
    scans: number;
    table: string;
}

/**
 * Per-function execution counters returned by `__lunora_admin__:getFunctionStats`
 * for one shard. Mirrors `@lunora/do`'s `FunctionCallStat`. Counters are
 * per-DO-instance and reset on hibernation/restart — a "since this instance
 * woke" readout. Durations are handler wall-clock milliseconds.
 *
 * `scans` / `scannedTables` carry the causal full-scan attribution (PLAN3 1.2).
 * They're additive — a worker predating the feature reports `scans: 0` and
 * `scannedTables: []`, so the fields are optional on the wire and the consumer
 * defaults them. `conflicts` (OCC write-contention count, a subset of `errors`)
 * is likewise additive and optional for the same back-compat reason.
 */
export interface FunctionCallStat {
    calls: number;
    /** OCC write-conflict count — a subset of `errors`; absent on a pre-conflict-tracking worker. */
    conflicts?: number;
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

/** Payload of a `__lunora_admin__:getFunctionStats` call, mirroring `@lunora/do`'s `FunctionStatsResult`. */
export interface FunctionStatsResult {
    functions: FunctionCallStat[];
    sinceMs: number;
}

/**
 * One minute-bucketed auth sample returned by `__lunora_admin__:getAuthMetrics`,
 * mirroring `@lunora/do`'s `AuthMetricsBucket`. Backs the SLO panel's
 * auth-failure sparkline; `bucketMs` is the epoch-ms floor of the 60s window.
 */
export interface AuthMetricsBucket {
    attempts: number;
    bucketMs: number;
    failures: number;
}

/**
 * App-level auth-attempt metrics returned by `__lunora_admin__:getAuthMetrics`
 * for the root shard, mirroring `@lunora/do`'s `AuthMetrics`. Backs the SLO
 * panel's auth-failure rate (PLAN3 §2.3): `failureRate` is the precomputed
 * `attempts === 0 ? 0 : failures / attempts`, `history` the minute-bucketed
 * series (oldest first) for the sparkline, and `sinceMs` the first-attempt
 * marker. Auth runs as a top-level `/api/auth/*` route, so these are recorded by
 * the worker (not by lunora-function metrics) and are durable across restart.
 */
export interface AuthMetrics {
    attempts: number;
    failureRate: number;
    failures: number;
    history: AuthMetricsBucket[];
    sinceMs: number;
}

/**
 * One declared index on a table, mirroring `@lunora/do`'s `TableIndexInfo`.
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

/** Payload of a `__lunora_admin__:listTableIndexes` call, mirroring `@lunora/do`'s `TableIndexesResult`. */
export interface TableIndexesResult {
    indexes: TableIndexInfo[];
}

/**
 * One column of a user table, mirroring `@lunora/do`'s `ColumnMeta` — the
 * schema-sourced metadata behind the schema diagram. `type` is the validator IR
 * kind (`string`, `number`, `id`, `array`, …); `ref` names the FK target table
 * of a `v.id("ref")` column; `pk` marks the `_id` primary key.
 */
export interface ColumnMeta {
    /** `v.storage(...)` column — the value is an R2 object key. */
    isStorage?: boolean;
    name: string;
    /** Optional on insert (declared `v.optional(...)` or carrying a default). */
    optional: boolean;
    /** Primary key — the `_id` column. */
    pk?: boolean;
    /** Foreign-key target table for a `v.id("target")` column. */
    ref?: string;
    /** Display type: the validator IR kind. */
    type: string;
}

/** Payload of a `__lunora_admin__:describeTable` call, mirroring `@lunora/do`'s `TableColumnsResult`. */
export interface TableColumnsResult {
    columns: ColumnMeta[];
}

/** Payload of a `__lunora_admin__:describeTables` call, mirroring `@lunora/do`'s `TablesColumnsResult`. */
export interface TablesColumnsResult {
    columnsByTable: Record<string, ColumnMeta[]>;
}

/** Severity of a static schema advisory (the advisor's `Level`, lowercased to match the studio's tab levels). */
export type AdvisoryLevel = "ERROR" | "INFO" | "WARN";

/**
 * One static schema advisory, mirroring `@lunora/advisor`'s `Finding` (served by
 * `__lunora_admin__:getAdvisories`). These are codegen-time lints baked into the
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

/** Payload of a `__lunora_admin__:getAdvisories` call, mirroring `@lunora/do`'s `AdvisoriesResult`. */
export interface AdvisoriesResult {
    advisories: AdvisoryFinding[];
}

/** The operation an RLS policy gates, mirroring `@lunora/do`'s `RlsPolicyMetadata["on"]`. `read` covers get/query/findMany. */
export type RlsOperation = "delete" | "insert" | "read" | "update";

/**
 * One row-level-security policy entry, mirroring `@lunora/do`'s
 * `RlsPolicyMetadata`. Read-only metadata for the RLS inspector: the policy's
 * `table` + `on` operation and the procedure whose `.use(rls(...))` chain
 * declared it. Never the `when` predicate — that's an opaque closure whose logic
 * lives in code, so the inspector reports only that a policy exists.
 */
export interface RlsPolicyMetadata {
    /** Source file (relative to `lunora/`, without extension) the policy is declared in. */
    file: string;
    /** Operation gated by the policy. */
    on: RlsOperation;
    /** Export name of the procedure whose builder chain declared the policy. */
    procedure: string;
    /** Logical table the policy applies to. */
    table: string;
}

/** One RLS role declaration, mirroring `@lunora/do`'s `RlsRoleMetadata`. */
export interface RlsRoleMetadata {
    /** Optional human-readable description from `defineRole(name, { description })`. */
    description?: string;
    /** Role label attached to the request identity (e.g. `"admin"`). */
    name: string;
    /** Permission names this role grants. */
    permissions: string[];
}

/** Payload of a `__lunora_admin__:rlsPolicies` call, mirroring `@lunora/do`'s `RlsPoliciesResult`. */
export interface RlsPoliciesResult {
    policies: RlsPolicyMetadata[];
    roles: RlsRoleMetadata[];
}

/** The strategy a mask policy applies, mirroring `@lunora/do`'s `MaskColumnMetadata["strategy"]`. `custom` stands in for an opaque `(value, ctx) => …` closure. */
export type MaskStrategy = "custom" | "hash" | "redact";

/**
 * One masked column entry, mirroring `@lunora/do`'s `MaskColumnMetadata`.
 * Read-only metadata for the data-browser mask preview: the `(table, column)`
 * pair plus the declared `strategy`. The masking closure itself is never sent —
 * a `custom` strategy renders a fixed sentinel in the preview.
 */
export interface MaskColumnMetadata {
    /** Column the mask policy redacts. */
    column: string;
    /** Declared masking strategy. */
    strategy: MaskStrategy;
    /** Logical table the masked column belongs to. */
    table: string;
}

/** Payload of a `__lunora_admin__:maskPolicies` call, mirroring `@lunora/do`'s `MaskPoliciesResult`. */
export interface MaskPoliciesResult {
    columns: MaskColumnMetadata[];
}

/** The operation a storage access rule gates, mirroring `@lunora/do`'s `StorageRuleMetadata["on"]`. */
export type StorageOperation = "delete" | "list" | "read" | "write";

/**
 * One storage access-rule entry, mirroring `@lunora/do`'s `StorageRuleMetadata`.
 * Read-only metadata for the access-rules view: the rule's `bucket` + `on`
 * operation + optional key `prefix` and the procedure whose
 * `.use(storageRules(...))` chain declared it. Never the `when` predicate.
 */
export interface StorageRuleMetadata {
    /** Logical bucket the rule applies to. */
    bucket: string;
    /** Source file (relative to `lunora/`, without extension) the rule is declared in. */
    file: string;
    /** Operation gated by the rule. */
    on: StorageOperation;
    /** Optional key-prefix scope; absent ⇒ the whole bucket. */
    prefix?: string;
    /** Export name of the procedure whose builder chain declared the rule. */
    procedure: string;
}

/** Payload of a `__lunora_admin__:storageRules` call, mirroring `@lunora/do`'s `StorageRulesResult`. */
export interface StorageRulesResult {
    rules: StorageRuleMetadata[];
}

/**
 * Payload of a `__lunora_admin__:studioFeatures` call, hand-mirroring
 * `@lunora/do`'s `StudioFeaturesResult` (the studio can't import `@lunora/do`).
 * Each flag is `true` when the app wires up that optional, package-backed feature
 * (discovered at codegen time from imports / `ctx.*` reads / schema signals / the
 * package being a declared dependency). The studio hides a nav page whose flag is
 * `false` — so an app with no `@lunora/payment` never renders the Payments page
 * (and never surfaces its "unknown table: subscriptions" error). A worker
 * predating this RPC returns nothing; the studio treats that as "show everything"
 * (back-compat).
 *
 * A key-exhaustiveness drift guard in this package's tests (and `@lunora/do`'s)
 * fails the build if these keys ever diverge from the source contract.
 */
export interface StudioFeaturesResult {
    analytics: boolean;
    auth: boolean;
    containers: boolean;
    flags: boolean;
    kv: boolean;
    mail: boolean;
    payments: boolean;
    queues: boolean;
    scheduler: boolean;
    storage: boolean;
    vectors: boolean;
    workflows: boolean;
}

/**
 * One declared Cloudflare Workflow, hand-mirroring `@lunora/do`'s
 * `WorkflowMetadata` (the studio can't import `@lunora/do`). Pure declaration
 * data — workflows hold no shard runtime state — discovered at codegen time from
 * `lunora/workflows.ts`. `binding` is the wrangler `Workflow` binding name,
 * `className` the generated `WorkflowEntrypoint` subclass, `exportName` the
 * `defineWorkflow` export, and `name` the stable deployed `workflows[].name`.
 */
export interface WorkflowMetadata {
    binding: string;
    className: string;
    exportName: string;
    name: string;
}

/** Payload of a `__lunora_admin__:listWorkflows` call, hand-mirroring `@lunora/do`'s `WorkflowsResult`. */
export interface WorkflowsResult {
    workflows: WorkflowMetadata[];
}

/**
 * One declared Cloudflare Queue, hand-mirroring `@lunora/do`'s `QueueMetadata`.
 * `binding` is the generated `QUEUE_*` producer binding, `name` the deployed
 * `queues.producers[].queue`, `exportName` the `lunora/queues.ts` export
 * (`ctx.queues.&lt;exportName>`), `mode` whether the queue is consumed by a worker
 * (`push`) or polled externally (`pull`), and `deadLetterQueue` the optional DLQ.
 */
export interface QueueMetadata {
    binding: string;
    deadLetterQueue?: string;
    exportName: string;
    mode: "pull" | "push";
    name: string;
}

/** Payload of a `__lunora_admin__:listQueues` call, hand-mirroring `@lunora/do`'s `QueuesResult`. */
export interface QueuesResult {
    queues: QueueMetadata[];
}

/**
 * The terminal disposition a consumer left a message in for one delivery attempt,
 * hand-mirroring `@lunora/do`'s `QueueMessageOutcome`. `ack` succeeded; `retry`
 * asked for redelivery; `error` means the handler threw (workerd retries the batch).
 */
export type QueueMessageOutcome = "ack" | "error" | "retry";

/**
 * One consumed queue message as served by `__lunora_admin__:getQueueMessages`,
 * newest first — hand-mirroring `@lunora/do`'s `QueueMessageRow`. Cloudflare Queues
 * expose no peek API, so this is the log of what push consumers actually processed,
 * not pending depth. `id` is a synthetic per-capture row id (a message retried N
 * times yields N rows, showing the delivery progression); `messageId` is the stable
 * Cloudflare message id. `capturedAt`/`timestamp` are epoch-ms. A key-exhaustiveness
 * drift guard in this package's tests (and `@lunora/do`'s) fails the build on drift.
 */
export interface QueueMessageRow {
    attempts: number;
    body: unknown;
    capturedAt: number;
    deadLettered: boolean;
    error?: string;
    exportName?: string;
    id: string;
    messageId: string;
    outcome: QueueMessageOutcome;
    queue: string;
    timestamp: number;
}

/** Result of `__lunora_admin__:getQueueMessages` — the dev consumed-message log, newest first. */
export interface QueueMessagesResult {
    entries: QueueMessageRow[];
}

/**
 * Result of `__lunora_admin__:sendQueueMessage` — the studio's "Send test message"
 * button. `sent` is the number of messages enqueued (1 for a single `send`, or the
 * batch length for a `sendBatch`). Nothing is captured until a consumer processes it.
 */
export interface SendQueueMessageResult {
    sent: number;
}

/**
 * Result of `__lunora_admin__:replayQueueMessage` — the studio's one-click replay /
 * DLQ redrive. `sent` is always 1; `target` is the `lunora/queues.ts` export the
 * stored body was re-enqueued onto (the origin queue, or a dead-lettered message's
 * parent queue).
 */
export interface ReplayQueueMessageResult {
    sent: number;
    target: string;
}

/**
 * One feature flag evaluated under a targeting context, hand-mirroring
 * `@lunora/do`'s `FlagEvaluation` (the studio can't import `@lunora/do`). `key`
 * and `type` are statically discovered from the app's `ctx.flags.&lt;type>("key")`
 * reads; `value`/`reason`/`variant`/`errorCode` come from the live OpenFeature
 * evaluation. A key-exhaustiveness drift guard in this package's tests (and
 * `@lunora/do`'s) fails the build if these keys diverge from the source contract.
 */
export interface FlagEvaluation {
    errorCode?: string;
    key: string;
    reason?: string;
    type: "boolean" | "number" | "object" | "string";
    value: unknown;
    variant?: string;
}

/**
 * Payload of a `__lunora_admin__:listFlags` call, hand-mirroring `@lunora/do`'s
 * `FlagsResult`. `configured` is `false` when the app wires no `@lunora/flags`
 * provider, so the Flags page can distinguish "no flags configured" from
 * "configured but zero flags read".
 */
export interface FlagsResult {
    configured: boolean;
    flags: FlagEvaluation[];
}

/* eslint-disable no-secrets/no-secrets -- reserved admin RPC names are framework constants, not credentials */

/**
 * Lifecycle state of a workflow instance, hand-mirroring `@lunora/do`'s
 * `WorkflowInstanceState` (itself mirrored from `@lunora/workflow`).
 */
export type WorkflowInstanceState = "complete" | "errored" | "paused" | "queued" | "running" | "terminated" | "unknown" | "waiting" | "waitingForPause";

/** Payload of a `__lunora_admin__:createWorkflowInstance` call: the new instance id and its initial status. */
export interface CreateWorkflowInstanceResult {
    id: string;
    status: WorkflowInstanceState;
}

/** Payload of a `__lunora_admin__:getWorkflowInstanceStatus` call: the instance's current status plus output/error when present. */
export interface WorkflowInstanceStatusResult {
    error?: { message: string; name: string };
    id: string;
    output?: unknown;
    status: WorkflowInstanceState;
}
/* eslint-enable no-secrets/no-secrets */

/**
 * Severity of a buffered log entry, mirroring `@lunora/do`'s `LogLevel` — the
 * full seven-tier `ctx.log` ramp (`trace`→`fatal`). A worker predating the
 * un-folded buffer only ever sends the four console tiers, which are a subset.
 */
export type LogLevel = "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn";

/**
 * One buffered log line returned by `__lunora_admin__:getLogs`. `functionPath`
 * is the RPC that produced it (when known); `timestamp` is epoch-ms.
 * `instance`/`exitCode` are populated for container lifecycle entries
 * (`instance` = the per-instance Durable Object id, `exitCode` = the process
 * exit code parsed out of a `stop` event). Mirrors `@lunora/do`'s `LogEntry`.
 */
export interface LogEntry {
    exitCode?: number;
    /** Structured fields from a `ctx.log.&lt;level>(message, fields)` / `ctx.log.with(fields)` call, when present. */
    fields?: Record<string, unknown>;
    functionPath?: string;
    instance?: string;
    level: LogLevel;
    message: string;
    timestamp: number;
}

/** Payload of a `__lunora_admin__:getLogs` call: the buffered entries, newest first. */
export interface LogsResult {
    entries: LogEntry[];
}

/**
 * One recorded admin operation returned by `__lunora_admin__:getAuditLog`,
 * mirroring `@lunora/do`'s `AuditEntry`. Unlike the in-memory logs, the audit
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

/** Payload of a `__lunora_admin__:getAuditLog` call: the recorded entries, newest first. */
export interface AuditLogResult {
    entries: AuditEntry[];
}

/**
 * One live subscription tracked on a shard's WebSocket, returned by
 * `__lunora_admin__:listSubscriptions` and mirroring `@lunora/do`'s
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
 * `@lunora/do`'s `SubscriptionConnection`. `id` is the socket's index within a
 * single read (a label, not a durable identifier); `admin` is `true` when the
 * socket upgraded with the admin token.
 */
export interface SubscriptionConnection {
    admin: boolean;
    id: number;
    subscriptions: SubscriptionInfo[];
}

/**
 * Payload of a `__lunora_admin__:listSubscriptions` call, mirroring `@lunora/do`'s
 * `SubscriptionsResult`: a read-only snapshot of every connected socket and its
 * subscriptions, plus aggregate counts. Derived live from the shard's sockets —
 * nothing durable.
 */
export interface SubscriptionsResult {
    connections: SubscriptionConnection[];
    totalConnections: number;
    totalSubscriptions: number;
}

/**
 * One topic or shape with its current subscriber count, returned by
 * `__lunora_admin__:getFanoutMetrics` and mirroring `@lunora/do`'s
 * `FanoutTopicStat`. `subscribers` is the fan-out width one poke/broadcast incurs
 * for this topic — the signal the auto-elastic relay tier (plan 075) watches.
 */
export interface FanoutTopicStat {
    /** `"shape"` = a reactive-query shape; `"whisper"` = an ephemeral whisper topic. */
    kind: "shape" | "whisper";
    /** Connected sockets currently subscribed — the fan-out width for this topic. */
    subscribers: number;
    /** The shape name or the whisper topic string. */
    topic: string;
}

/**
 * Running fan-out counters for one delivery path since the DO instance woke,
 * mirroring `@lunora/do`'s `FanoutPathCounters`. `socketsIterated` is the
 * O(subscribers) loop cost; `socketsDelivered` is how many of those received a
 * frame. `totalMs`/`maxMs` are **coarse** (a DO clock advances only on I/O) and
 * populated only for the asynchronous shape-poke path — they stay `0` for the
 * synchronous whisper broadcast.
 */
export interface FanoutPathCounters {
    maxMs: number;
    passes: number;
    peakSocketsIterated: number;
    socketsDelivered: number;
    socketsIterated: number;
    totalMs: number;
}

/**
 * Payload of a `__lunora_admin__:getFanoutMetrics` call, mirroring `@lunora/do`'s
 * `FanoutMetricsResult`: the current per-topic subscriber counts (derived live
 * from the shard's sockets) plus the running per-path fan-out cost counters
 * (in-memory, reset on hibernation). Feeds the Studio fan-out observability panel.
 */
export interface FanoutMetricsResult {
    maxRelays: number;
    peakSubscribers: number;
    promoted: boolean;
    relayCount: number;
    shapePoke: FanoutPathCounters;
    sinceMs: number;
    topics: FanoutTopicStat[];
    totalConnections: number;
    whisper: FanoutPathCounters;
}

/** Outcome of one dispatch in the request log, mirroring `@lunora/do`'s `RequestOutcome`. */
export type RequestOutcome = "error" | "ok";

/**
 * One structured `/rpc` dispatch returned by `__lunora_admin__:getRequestLog`,
 * mirroring `@lunora/do`'s `RequestLogEntry`. Unlike the in-memory `getLogs`
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

/**
 * Correlated filters accepted by `__lunora_admin__:getRequestLog`, mirroring
 * `@lunora/do`'s `ReadRequestLogOptions`. All AND-combined and bound server-side.
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
 * Triage status of an Issue, mirroring `@lunora/do`'s `IssueStatus`. `open` is
 * the default; a developer moves it to `resolved` (fixed — but a new matching
 * error auto-reopens it server-side) or `ignored` (muted, and stays muted).
 */
export type IssueStatus = "ignored" | "open" | "resolved";

/** Developer-tagged severity of an Issue, mirroring `@lunora/do`'s `IssueSeverity`; drives the badge palette. */
export type IssueSeverity = "critical" | "high" | "low" | "medium";

/**
 * One grouped error **Issue** returned by `__lunora_admin__:getIssues`, mirroring
 * `@lunora/do`'s `ErrorIssue`. Many `error`-outcome request-log rows (Worker
 * throws and `container:&lt;name>` crashes alike) that share a fingerprint fold into
 * a single triage row. The `hash` is the same stable key a cloud Incident groups
 * on, so a local Issue and a cloud Incident are the same object.
 */
export interface ErrorIssue {
    /** Assignee (a userId or a name) from the persisted triage state; absent when unassigned. */
    assignee?: string;
    /** Number of `error` rows folded into this Issue within the scanned window. */
    count: number;
    /** The `&lt;file>:&lt;function>` (or `container:&lt;name>`) the errors came from. */
    culprit: string;
    /** Epoch-ms of the oldest folded row. */
    firstSeen: number;
    /** Stable 16-char grouping hash over `functionPath :: bucket(message)`. */
    hash: string;
    /** Epoch-ms of the newest folded row. */
    lastSeen: number;
    /** A representative raw error message — taken from the most recent folded row. */
    sampleMessage: string;
    /** Developer-tagged severity from the persisted triage state; absent when untriaged. */
    severity?: IssueSeverity;
    /** Epoch-ms the triage state was last changed; absent when never triaged. */
    stateUpdatedAt?: number;
    /** Triage status folded in from the persisted state (`open` by default); a resolved Issue that erred again auto-reopens to `open`. */
    status: IssueStatus;
    /** Human-readable title (first line of the sample message, capped). */
    title: string;
}

/** Payload of a `__lunora_admin__:getIssues` call: grouped error Issues, most-recently-active first. */
export interface IssuesResult {
    issues: ErrorIssue[];
}

/**
 * Filters accepted by `__lunora_admin__:getIssues`, mirroring `@lunora/do`'s
 * `ReadIssuesOptions`. All AND-combined and bound server-side; `outcome` is
 * forced to `error` server-side.
 */
export interface IssuesQuery {
    functionPathPrefix?: string;
    limit?: number;
    shardKey?: string;
    status?: IssueStatus;
    userId?: string;
}

/**
 * One span of a folded trace returned by `__lunora_admin__:getTraces`, mirroring
 * `@lunora/do`'s `TraceSpan` (produced by its pure `foldTraces`). Already
 * flattened for rendering: `depth` is the span's nesting level under the trace
 * root and `offsetMs` its start relative to the trace start, so a waterfall row
 * is a pure function of the record — indent by `depth`, draw the bar from
 * `offsetMs` to `offsetMs + durationMs` — with no client-side tree math.
 */
export interface TraceSpan {
    /** Structured attributes the `ctx.trace(name, fn, attributes)` caller attached; absent when none. */
    attributes?: Record<string, unknown>;
    /** Nesting level under the trace root; the root span is 0. */
    depth: number;
    /** Wall-clock duration of the span body, in milliseconds. */
    durationMs: number;
    /** Populated when the span body threw: `type` is the error's constructor name (or `LunoraError` code). */
    error?: {
        message: string;
        type: string;
    };
    /** Caller-supplied span name, e.g. `"stripe.charge"`. */
    name: string;
    /** Start of this span relative to the trace's start, in ms. Clamped at 0 server-side. */
    offsetMs: number;
    /** `true` when the span body returned without throwing. */
    ok: boolean;
    /** Span id of the enclosing span; `""` for the synthetic dispatch root. */
    parentSpanId: string;
    /** This span's own id (16-hex). */
    spanId: string;
}

/**
 * One folded `ctx.trace` waterfall returned by `__lunora_admin__:getTraces`,
 * mirroring `@lunora/do`'s `TraceSummary`. The dispatch's synthetic root span
 * plus every `ctx.trace` span recorded beneath it, already ordered by
 * `(offsetMs, depth)` — a valid pre-order traversal of the span tree, so this
 * panel renders rows in the given order and indents by `depth`.
 *
 * Sourced from the shard's bounded, in-memory span ring, so it resets on
 * hibernation/restart and can be legitimately partial (an evicted parent, or a
 * trace read mid-dispatch). It is a "recent traces on this instance" readout for
 * local development, NOT a durable trace store.
 */
export interface TraceSummary {
    /** Wall-clock span of the whole trace (root start → last span end), in ms. May be 0. */
    durationMs: number;
    /** The `&lt;file>:&lt;function>` the trace's root span was recorded under. */
    functionPath: string;
    /** `false` when the root or any descendant span errored. */
    ok: boolean;
    /** Display name of the trace — the root span's name. */
    rootName: string;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey?: string;

    /**
     * Spans ordered by `(offsetMs, depth)`, ready to render as waterfall rows.
     * Start time alone cannot order them: spans are recorded on completion, and
     * at millisecond resolution a parent and its child routinely tie.
     */
    spans: TraceSpan[];
    /** Epoch-ms the trace's anchor span started. */
    startTs: number;
    /** Trace id (32-hex) — shared with the dispatch's log lines. */
    traceId: string;
}

/** Payload of a `__lunora_admin__:getTraces` call: the folded waterfalls, newest trace first. */
export interface TracesResult {
    /**
     * Distinct traces available in the span ring — the denominator for the
     * "showing N of M" affordance. Optional: a worker predating the field omits
     * it, and the panel then shows no truncation notice.
     */
    total?: number;
    traces: TraceSummary[];
}

/** Instrument kind of a metric series, mirroring `@lunora/do`'s `MetricKind`. */
export type MetricKind = "counter" | "gauge" | "histogram";

/**
 * One aggregated `ctx.metrics.*` series returned by
 * `__lunora_admin__:getMetricSeries`, mirroring `@lunora/do`'s `MetricSeries`.
 * Every measurement sharing a `(name, kind, attributes)` identity folded into a
 * running summary — `sum` is a counter's running total and a histogram's sum,
 * `last` a gauge's current reading, `sum / count` a histogram's mean.
 *
 * Sourced from the shard's in-memory metric fold, so it resets on
 * hibernation/restart. A "recent metrics on this instance" readout for local
 * development, NOT a durable metric store — production aggregation ships to a
 * collector via the sink.
 */
export interface MetricSeries {
    /** The series' dimensions, if any — the attributes that made it distinct. */
    attributes?: Record<string, unknown>;
    /** Number of measurements folded into this series. */
    count: number;
    /** Epoch-ms of the first measurement folded in. */
    firstTs: number;
    /** Function path that recorded the series' most recent measurement. */
    functionPath: string;
    /** Instrument kind; decides which projection the panel shows. */
    kind: MetricKind;
    /** Most recent measured value — the current reading for a `gauge`. */
    last: number;
    /** Epoch-ms of the most recent measurement. */
    lastTs: number;
    /** Largest measured value seen. */
    max: number;
    /** Smallest measured value seen. */
    min: number;
    /** Instrument name, e.g. `"orders.placed"`. */
    name: string;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey?: string;
    /** Sum of measured values — a `counter`'s total, a `histogram`'s sum. */
    sum: number;
}

/** Payload of a `__lunora_admin__:getMetricSeries` call: the aggregated series, most-recently-updated first. */
export interface MetricSeriesResult {
    series: MetricSeries[];
}

/**
 * How a deployment binding/var classifies, mirroring `@lunora/do`'s `SettingKind`.
 * `var` is a plain Worker var, `secret` a sensitive string (always masked), and
 * `binding` a non-string binding object (R2/KV/DO/D1/queue/service).
 */
export type SettingKind = "binding" | "secret" | "var";

/**
 * One row of the read-only deployment-settings view, mirroring `@lunora/do`'s
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
 * Best-effort deploy metadata, mirroring `@lunora/do`'s `DeployInfo`. Every
 * field is optional: the server reads only what the Worker `env` exposes and
 * omits the rest.
 */
export interface DeployInfo {
    deploymentId?: string;
    environment?: string;
    versionTag?: string;
    workerUrl?: string;
}

/** Payload of a `__lunora_admin__:getSettings` call, mirroring `@lunora/do`'s `SettingsResult`. */
export interface SettingsResult {
    deploy: DeployInfo;
    settings: SettingEntry[];
}

/**
 * Ordering/visual weight of a {@link SecurityFinding}, mirroring `@lunora/do`'s
 * `SecurityFindingLevel`. Shares the studio's insight-severity vocabulary so the
 * Security and Performance advisors render with one badge palette.
 */
export type SecurityFindingLevel = "error" | "info" | "warning";

/**
 * Which deployment-level security heuristic fired, mirroring `@lunora/do`'s
 * `SecurityFindingKind`. The studio maps each kind to a localized title,
 * explanation, and remediation hint; the wire payload carries only the kind,
 * level, and optional `detail`.
 */
export type SecurityFindingKind =
    | "admin-token-weak"
    | "auth-secret-weak"
    | "cookies-insecure"
    | "cors-wildcard-credentials"
    | "csrf-disabled"
    | "dev-args-unredacted"
    | "security-headers-disabled"
    | "ws-gate-open";

/**
 * One detected security issue from `__lunora_admin__:getSecurityAudit`, mirroring
 * `@lunora/do`'s `SecurityFinding`. `detail` carries kind-specific context the
 * studio interpolates into the localized copy (e.g. `{ length, min }` for a weak
 * admin token); absent when the kind needs none.
 */
export interface SecurityFinding {
    detail?: Record<string, unknown>;
    kind: SecurityFindingKind;
    level: SecurityFindingLevel;
}

/** Payload of a `__lunora_admin__:getSecurityAudit` call, mirroring `@lunora/do`'s `SecurityAuditResult`: every finding, worst-first. */
export interface SecurityAuditResult {
    findings: SecurityFinding[];
}

/**
 * Payload of a `__lunora_admin__:runSql` call, mirroring `@lunora/do`'s
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
 * Payload of a `__lunora_admin__:getPitrBookmark` call, mirroring `@lunora/do`'s
 * `PitrBookmarkResult`. `current` names the shard's present point in history;
 * `forTime` is the bookmark nearest a queried time, present only when one was
 * asked for. Bookmarks are opaque, lexically-comparable strings.
 */
export interface PitrBookmarkResult {
    current: string;
    forTime?: string;
}

/**
 * Result of a `__lunora_admin__:pitrRestore` call, mirroring `@lunora/do`'s
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

    /**
     * Total rows matching the predicate. Absent when the read passed
     * `skipCount: true` — the data browser sources the count from a separate,
     * predicate-keyed read so paging never re-runs the COUNT.
     */
    total?: number;
}

/**
 * One row that references a stored R2 object through a `v.storage()` column,
 * mirroring `@lunora/do`'s `StorageReference`. `id` is the owning row's primary
 * key, `table`/`column` locate the reference — enough for the file browser to
 * deep-link from a file to the record that owns it.
 */
export interface StorageReference {
    column: string;
    id: string;
    table: string;
}

/**
 * Payload of a `__lunora_admin__:storageReferences` call, mirroring `@lunora/do`'s
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
 * NOT exist in the bucket — a **dangling reference**, mirroring `@lunora/do`'s
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
 * Payload of a `__lunora_admin__:storageOrphans` call, mirroring `@lunora/do`'s
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

/** Direction a data migration is run in. Mirrors `@lunora/do`. */
export type MigrationDirection = "down" | "up";

/** Lifecycle of a data-migration run. Mirrors `@lunora/do`. */
export type MigrationStatus = "completed" | "failed" | "in_progress";

/**
 * One persisted migration run-state row, as returned by the
 * `__lunora_admin__:migrationStatus` RPC (`{ migrations: MigrationStatusRow[] }`).
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

/** Result of a single `__lunora_admin__:runMigration` invocation against one shard. */
export interface MigrationRunResult {
    changed: number;
    cursor: null | string;
    direction: MigrationDirection;
    dryRun: boolean;
    id: string;
    processed: number;
    status: MigrationStatus;
}

/** Arguments accepted by the `__lunora_admin__:runMigration` RPC. */
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

/** Result of a single `__lunora_admin__:importShard` invocation against one shard. */
export interface ImportShardResult {
    conflicts: number;
    errors: ImportError[];
    inserted: Record<string, number>;
}

/* -------------------------------------------------------------------------- */
/* Cross-shard traffic feed (hot_shard advisor lint)                          */
/* -------------------------------------------------------------------------- */

/**
 * One shard's request total from the worker's `POST /_lunora/admin/shard-traffic`
 * endpoint, mirroring `@lunora/runtime`'s `ShardTrafficEntry`. `requests` is the
 * shard's lifetime dispatch count (`0` for a shard that failed/timed out);
 * `shardKey` is the DO id name (`""` for the root shard). The cross-shard feed
 * the `hot_shard` runtime advisor consumes to compute skew.
 */
export interface ShardTrafficEntry {
    requests: number;
    shardKey: string;
}

/**
 * Payload of a `POST /_lunora/admin/shard-traffic` call, mirroring the runtime
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
