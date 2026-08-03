import { LunoraError } from "@lunora/errors";

import { quoteIdentifier } from "../../../shared/quote-identifier";
import type { AuditEntry } from "./audit-log";
import type { SqlExec } from "./ctx-db";
import { decodeDocJson as decodeDocumentJson } from "./do-sql";
import type { SortDirection } from "./schema-types";

/**
 * Reserved `functionPath` prefix for admin introspection RPCs. These travel
 * over the same `/_lunora/rpc` → shard `/rpc` path as ordinary functions, but
 * `ShardDO` intercepts them before user dispatch and serves them from the
 * helpers below. The `__lunora_` namespace is reserved (it also backs the FTS
 * capability probe), so a real generated `&lt;file>:&lt;function>` can never collide.
 */
const ADMIN_FUNCTION_PREFIX = "__lunora_admin__:";

/**
 * Reserved `functionPath` prefix for cross-shard relation reads. Backs reverse
 * cross-backend relations: a `.global()` (D1) parent loading a shard-local
 * child whose rows span every shard. Like {@link ADMIN_FUNCTION_PREFIX} these
 * travel the `/_lunora/rpc` → shard `/rpc` path and are intercepted before user
 * dispatch — but they are NOT admin-token-gated. Instead they run under the
 * forwarded caller identity and are reachable ONLY via the Query Coordinator's
 * fan-out (the worker refuses the prefix on a single-shard envelope), so a
 * direct client RPC can never reach them. `:read` returns the bare child-row
 * array, `:count` a bare number, so the coordinator's `concat`/`sum` merge
 * composes the per-shard results.
 */
const RELATION_FUNCTION_PREFIX = "__lunora_relation__:";

/**
 * Reserved `functionPath` prefix for live feature-flag reads. The React client's
 * `useFlag`/`useFlags` subscribe to `__lunora_flags__:eval` over the same WS
 * channel as a user query; `ShardDO` intercepts it before user dispatch and
 * serves it from the codegen-overridden flag-subscription read hook, which
 * evaluates the flag through the app's OpenFeature provider under the socket's
 * verified identity. Like the other reserved prefixes it is NOT admin-gated (a
 * flag read is public, scoped to the subscriber's own targeting context), and
 * the `__lunora_` namespace is reserved so a real `&lt;file>:&lt;function>` can't
 * collide. Re-evaluated on every write-flush so values stay live within a
 * session (provider-side flips with no intervening write surface on reconnect).
 */
const FLAGS_FUNCTION_PREFIX = "__lunora_flags__:";

/**
 * Fully-qualified reserved paths the data browser invokes. The
 * `__lunora_admin__:` prefix is spelled out inline rather than interpolated so
 * the values stay emittable under `--isolatedDeclarations`.
 */
const ADMIN_FUNCTIONS = {
    applyCdc: "__lunora_admin__:applyCdc",
    aiAvailable: "__lunora_admin__:aiAvailable",
    aiChartConfig: "__lunora_admin__:aiChartConfig",
    aiGenerateSql: "__lunora_admin__:aiGenerateSql",
    aiTableFilter: "__lunora_admin__:aiTableFilter",
    assignIssue: "__lunora_admin__:assignIssue",
    backRelationCounts: "__lunora_admin__:backRelationCounts",
    cdcSync: "__lunora_admin__:cdcSync",
    clearCapturedMail: "__lunora_admin__:clearCapturedMail",
    clearQueueMessages: "__lunora_admin__:clearQueueMessages",
    clearTable: "__lunora_admin__:clearTable",
    createWorkflowInstance: "__lunora_admin__:createWorkflowInstance",
    deleteRows: "__lunora_admin__:deleteRows",
    describeTable: "__lunora_admin__:describeTable",
    describeTables: "__lunora_admin__:describeTables",
    explainIssue: "__lunora_admin__:explainIssue",
    exportShard: "__lunora_admin__:exportShard",
    facetColumn: "__lunora_admin__:facetColumn",
    getAdvisories: "__lunora_admin__:getAdvisories",
    getAdvisorProcedures: "__lunora_admin__:getAdvisorProcedures",
    getAuditLog: "__lunora_admin__:getAuditLog",
    getAuthMetrics: "__lunora_admin__:getAuthMetrics",
    getCapturedMail: "__lunora_admin__:getCapturedMail",
    getFanoutMetrics: "__lunora_admin__:getFanoutMetrics",
    getFunctionStats: "__lunora_admin__:getFunctionStats",
    getIssues: "__lunora_admin__:getIssues",
    getMetricHistory: "__lunora_admin__:getMetricHistory",
    getMetricSeries: "__lunora_admin__:getMetricSeries",
    listSubscriptions: "__lunora_admin__:listSubscriptions",
    listTableIndexes: "__lunora_admin__:listTableIndexes",
    listTablesIndexes: "__lunora_admin__:listTablesIndexes",
    getLogs: "__lunora_admin__:getLogs",
    getMetrics: "__lunora_admin__:getMetrics",
    getPitrBookmark: "__lunora_admin__:getPitrBookmark",
    getQueryInsights: "__lunora_admin__:getQueryInsights",
    getQueueMessages: "__lunora_admin__:getQueueMessages",
    getRequestLog: "__lunora_admin__:getRequestLog",
    getSecurityAudit: "__lunora_admin__:getSecurityAudit",
    getSettings: "__lunora_admin__:getSettings",
    getTraces: "__lunora_admin__:getTraces",
    // eslint-disable-next-line no-secrets/no-secrets -- reserved admin RPC path constant, not a credential
    getWorkflowInstanceStatus: "__lunora_admin__:getWorkflowInstanceStatus",
    ignoreIssue: "__lunora_admin__:ignoreIssue",
    importShard: "__lunora_admin__:importShard",
    listFlags: "__lunora_admin__:listFlags",
    listQueues: "__lunora_admin__:listQueues",
    lintSql: "__lunora_admin__:lintSql",
    listTables: "__lunora_admin__:listTables",
    listWorkflows: "__lunora_admin__:listWorkflows",
    maskPolicies: "__lunora_admin__:maskPolicies",
    migrationStatus: "__lunora_admin__:migrationStatus",
    pitrRestore: "__lunora_admin__:pitrRestore",
    rankBefore: "__lunora_admin__:rankBefore",
    rankPage: "__lunora_admin__:rankPage",
    readTablePage: "__lunora_admin__:readTablePage",
    recordAuthEvent: "__lunora_admin__:recordAuthEvent",
    recordContainerEvent: "__lunora_admin__:recordContainerEvent",
    recordMail: "__lunora_admin__:recordMail",
    recordQueueMessage: "__lunora_admin__:recordQueueMessage",
    replayQueueMessage: "__lunora_admin__:replayQueueMessage",
    resolveIssue: "__lunora_admin__:resolveIssue",
    rlsPolicies: "__lunora_admin__:rlsPolicies",
    schemaHistory: "__lunora_admin__:schemaHistory",
    schemaVersion: "__lunora_admin__:schemaVersion",
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

/** A user table plus its current row count. */
interface TableInfo {
    name: string;
    rowCount: number;
}

/** Payload of a `__lunora_admin__:getAuditLog` call: the recorded entries, newest first. */
interface AuditLogResult {
    entries: AuditEntry[];
}

/**
 * One live subscription tracked on a shard's WebSocket, as surfaced by
 * `__lunora_admin__:listSubscriptions`. Mirrors the persisted `SubscriptionQuery`
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
 * Payload of a `__lunora_admin__:listSubscriptions` call: a read-only snapshot of
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
 * Per-function execution counters served by `__lunora_admin__:getFunctionStats`,
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

    /**
     * Subset of `calls` that failed on an optimistic-concurrency (OCC) write
     * conflict — the true write-contention signal (a CAS that lost to a
     * concurrent commit). A conflicted dispatch also counts in `errors`, so
     * `conflicts` never exceeds `errors`. `0` on a function that never contended
     * or a worker predating the feed.
     */
    conflicts: number;
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
 * One declared index on a table, flattened across lunora's index kinds for the
 * schema viewer. `fields` is the indexed columns (a secondary index's columns,
 * a rank index's sort fields, a search index's text + filter fields, or a vector
 * index's source field). `unique` is set only for unique secondary indexes.
 * Sourced from the schema (the codegen subclass overrides the base hook), since
 * the physical SQLite indexes are `json_extract` expressions with no field names.
 */
interface TableIndexInfo {
    fields: string[];
    name: string;
    type: "geo" | "index" | "rank" | "search" | "vector";
    unique?: boolean;
}

/** Payload of a `__lunora_admin__:listTableIndexes` call: every declared index on the table. */
interface TableIndexesResult {
    indexes: TableIndexInfo[];
}

/**
 * Payload of a `__lunora_admin__:listTablesIndexes` call: declared indexes per
 * requested table, keyed by table name. The batched sibling of
 * {@link TableIndexesResult}, mirroring {@link TablesColumnsResult}'s relation
 * to {@link TableColumnsResult} — one admin RPC for N tables instead of N,
 * since `tableIndexes` is a cheap, synchronous, schema-sourced lookup (no SQL
 * query per table to amortize away).
 */
interface TablesIndexesResult {
    indexesByTable: Record<string, TableIndexInfo[]>;
}

/**
 * One column of a user table, surfaced by `__lunora_admin__:describeTable` for
 * the studio's schema diagram. Schema-sourced (the codegen subclass overrides
 * `tableColumns`) rather than read from SQLite, because lunora stores rows as a
 * `__doc__` JSON blob, so `PRAGMA table_info` carries neither the declared field
 * types nor the PK/FK roles. `type` is the validator IR kind (`string`,
 * `number`, `id`, `array`, …); `ref` names the target table of a `v.id("ref")`
 * foreign key; `pk` marks the runtime-minted `_id` primary key.
 */
interface ColumnMeta {
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

/** Payload of a `__lunora_admin__:describeTable` call: every column of the table, in schema order. */
interface TableColumnsResult {
    columns: ColumnMeta[];
}

/** Payload of a `__lunora_admin__:describeTables` call: columns per requested table, keyed by table name. */
interface TablesColumnsResult {
    columnsByTable: Record<string, ColumnMeta[]>;
}

/**
 * One static schema advisory, surfaced by `__lunora_admin__:getAdvisories`.
 * Structurally mirrors `@lunora/advisor`'s `Finding` (splinter-shaped) — the
 * codegen subclass emits these from the advisor's output, and the DO serves
 * them without depending on `@lunora/advisor` itself. Kept in lockstep with that
 * `Finding` shape; the generated `LUNORA_ADVISORIES` literal is typed against it.
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

/** Payload of a `__lunora_admin__:getAdvisories` call: the static schema advisories for this deployment. */
interface AdvisoriesResult {
    advisories: AdvisoryFinding[];
}

/**
 * One declared procedure, surfaced by `__lunora_admin__:getAdvisorProcedures`.
 *
 * Structurally mirrors `@lunora/advisor`'s `AdvisorProcedureProtection`, for the
 * same reason `AdvisoryFinding` mirrors `Finding`: the DO serves it without
 * depending on the advisor package. `@lunora/codegen` asserts the two are
 * assignable when it emits the list, so a field added there and forgotten here
 * fails codegen's own typecheck rather than the user's. This is the **denominator** the health map
 * needs — findings alone say what is wrong, but only the full procedure list
 * says how much is right, so without it a score cannot be computed at all.
 */
interface AdvisorProcedure {
    /** `true` when the feeder could read the handler body statically (inline, or a same-file identifier it resolved); `false` for a genuinely cross-file handler, in which case the behavioural facts below are absent. */
    analyzableBody?: boolean;
    callsMail?: boolean;
    emitsEvent?: boolean;
    exempt?: boolean;
    exemptReason?: string;
    exportName: string;
    fanOut?: boolean;
    file: string;
    handlesErrors?: boolean;
    hasEmailArg?: boolean;
    kind: "action" | "mutation" | "query";
    reachesOutbound?: boolean;
    runsAiGeneration?: boolean;
    throwsBareError?: boolean;
    unboundedAiGeneration?: boolean;
    usesCaptcha: boolean;
    usesEmailGate: boolean;
    usesInsertManyUnsafe?: boolean;
    usesMask: boolean;
    usesRateLimit: boolean;
    usesRls: boolean;
    visibility: "internal" | "public";
    writesUserTable?: boolean;
}

/** Payload of a `__lunora_admin__:getAdvisorProcedures` call: every declared procedure. */
interface AdvisorProceduresResult {
    procedures: AdvisorProcedure[];
}

/**
 * One row-level-security policy entry, surfaced by `__lunora_admin__:rlsPolicies`
 * to the studio's read-only RLS inspector. Mirrors `@lunora/codegen`'s
 * `RlsPolicyIR`: the policy's `table` + `on` operation and the procedure whose
 * `.use(rls(...))` chain declared it. Never the `when` predicate — that's an
 * opaque closure whose logic lives in code, so only its existence is reported.
 * The codegen subclass overrides the `rlsMetadata()` hook with these.
 */
interface RlsPolicyMetadata {
    /** Source file (relative to `lunora/`, without extension) the policy is declared in. */
    file: string;
    /** Operation gated: `read` covers get/query/findMany; the rest are writes. */
    on: "delete" | "insert" | "read" | "update";
    /** Export name of the procedure whose builder chain declared the policy. */
    procedure: string;
    /** Logical table the policy applies to. */
    table: string;
}

/**
 * One RLS role declaration, surfaced by `__lunora_admin__:rlsPolicies`. Mirrors
 * `@lunora/codegen`'s `RlsRoleIR`: the role `name`, optional `description`, and
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

/** Payload of a `__lunora_admin__:rlsPolicies` call: the schema's policy + role metadata for the RLS inspector. */
interface RlsPoliciesResult {
    policies: RlsPolicyMetadata[];
    roles: RlsRoleMetadata[];
}

/**
 * One masked column entry, surfaced by `__lunora_admin__:maskPolicies` to the
 * studio's data-browser mask preview. Mirrors `@lunora/codegen`'s
 * `MaskColumnMetadataIR`: the `(table, column)` pair plus the declared masking
 * `strategy`. `"custom"` stands in for any non-string `(value, ctx) => …`
 * strategy — its closure is opaque, so the preview renders a fixed sentinel. The
 * codegen subclass overrides the `maskMetadata()` hook with these.
 */
interface MaskColumnMetadata {
    /** Column the mask policy redacts. */
    column: string;
    /** Declared strategy: `"redact"`/`"hash"` string literals, else `"custom"` for a `MaskFn`. */
    strategy: "custom" | "hash" | "redact";
    /** Logical table the masked column belongs to. */
    table: string;
}

/** Payload of a `__lunora_admin__:maskPolicies` call: the schema's masked columns for the studio's data-browser mask preview. */
interface MaskPoliciesResult {
    columns: MaskColumnMetadata[];
}

/**
 * One storage access-rule entry, surfaced by `__lunora_admin__:storageRules` to
 * the studio's read-only access-rules view. Mirrors `@lunora/codegen`'s
 * `StorageRuleIR`: the rule's `bucket` + `on` operation + optional key `prefix`
 * and the procedure whose `.use(storageRules(...))` chain declared it. Never the
 * `when` predicate — only its existence is reported. The codegen subclass
 * overrides the `storageRulesMetadata()` hook with these.
 */
interface StorageRuleMetadata {
    /** Logical bucket the rule applies to. */
    bucket: string;
    /** Source file (relative to `lunora/`, without extension) the rule is declared in. */
    file: string;
    /** Operation gated: `read`/`write`/`delete`/`list`. */
    on: "delete" | "list" | "read" | "write";
    /** Optional key-prefix scope; absent ⇒ the whole bucket. */
    prefix?: string;
    /** Export name of the procedure whose builder chain declared the rule. */
    procedure: string;
}

/** Payload of a `__lunora_admin__:storageRules` call: the schema's storage access rules for the studio's inspector. */
interface StorageRulesResult {
    rules: StorageRuleMetadata[];
}

/**
 * Payload of a `__lunora_admin__:studioFeatures` call: which optional, package-
 * backed features this deployment actually wires up, so the studio can hide nav
 * pages whose backing package isn't enabled. Every flag is statically determined
 * at codegen time by OR-ing code usage (a `lunora/` source imports the package or
 * reads its `ctx.*` helper), the relevant schema signal (storage columns/rules,
 * crons, vector indexes), and the package being a declared project dependency —
 * so a package wired only in the worker entry still shows its page. A `false`
 * flag means the studio omits that page entirely rather than rendering it and
 * surfacing an "unknown table" error. The codegen subclass overrides the
 * `studioFeatures()` hook with these; the default (un-generated) `ShardDO`
 * reports every flag `false`.
 *
 * This shape is the wire contract codegen emits and `@lunora/studio` hand-mirrors
 * (it can't import `@lunora/do`). A key-exhaustiveness drift guard in this
 * package's tests and the studio's fails the build if the two key sets diverge.
 */
interface StudioFeaturesResult {
    /** `@lunora/bindings/analytics` / `ctx.analytics` is used, or it is a declared dependency. */
    analytics: boolean;
    /** `@lunora/auth` is a declared dependency (backs the Users / Sessions / Organizations / Configuration pages). */
    auth: boolean;
    /** `@lunora/container` / `ctx.containers` is used, the app declares containers, or it is a declared dependency. */
    containers: boolean;
    /** `@lunora/flags` / `ctx.flags` is used, or it is a declared dependency. */
    flags: boolean;
    /** `@lunora/bindings/kv` / `ctx.kv` is used, or it is a declared dependency. */
    kv: boolean;
    /** `@lunora/mail` is imported by a `lunora/` source or a declared dependency. */
    mail: boolean;
    /** `@lunora/notify` / `ctx.notify` is used (a `lunora/notify.ts` config counts), or it is a declared dependency. */
    notifications: boolean;

    /**
     * `@lunora/payment` is used (import or `ctx.payments`), or the app declares the store's
     * `subscriptions`/`events` tables that the Payments panel reads. Unlike the other flags this
     * has no declared-dependency arm: the panel queries those tables directly, so a bare dependency
     * (e.g. reusing the package's pure webhook helpers) must not show a page that would then error.
     */
    payments: boolean;
    /** `@lunora/queue` / `ctx.queues` is used, the app declares queues, or it is a declared dependency. */
    queues: boolean;
    /** `@lunora/scheduler` / `ctx.scheduler` is used, the app declares crons, or it is a declared dependency. */
    scheduler: boolean;
    /** `@lunora/storage` / `ctx.storage` is used, the schema declares storage columns/rules, or it is a declared dependency. */
    storage: boolean;
    /** The schema declares vector indexes, `@lunora/bindings/vectors` / `ctx.vectors` is used, or it is a declared dependency. */
    vectors: boolean;
    /** `@lunora/workflow` / `ctx.workflows` is used, the app declares workflows, or it is a declared dependency. */
    workflows: boolean;
}

/**
 * One feature flag evaluated under a supplied targeting context, surfaced by
 * `__lunora_admin__:listFlags` for the studio's read-only Flags page. The `key`
 * and `type` are statically discovered by `@lunora/codegen` from the app's
 * `ctx.flags.&lt;type>("key", …)` reads; `value`/`reason`/`variant`/`errorCode`
 * come from the live OpenFeature evaluation (the codegen subclass overrides the
 * base `evaluateFlags` hook). `value` is the resolved flag value as JSON.
 */
interface FlagEvaluation {
    /** OpenFeature `errorCode` when the evaluation failed (the value falls back to the default). */
    errorCode?: string;
    /** The discovered flag key (the first argument of a `ctx.flags.&lt;type>(...)` read). */
    key: string;
    /** OpenFeature `reason` for the resolution (`TARGETING_MATCH`, `DEFAULT`, `ERROR`, …). */
    reason?: string;
    /** The flag's value type, derived from which `ctx.flags.&lt;type>` method read it. */
    type: "boolean" | "number" | "object" | "string";
    /** The resolved value (JSON), or the type default when unconfigured / on error. */
    value: unknown;
    /** OpenFeature `variant` identifier when the provider reports one. */
    variant?: string;
}

/**
 * Payload of a `__lunora_admin__:listFlags` call: every statically-discovered
 * flag evaluated under the supplied targeting context. `configured` is `false`
 * when the app wires no `@lunora/flags` provider (the base hook), so the studio
 * can distinguish "no flags configured" from "configured but zero flags read".
 */
interface FlagsResult {
    /** `true` when an `@lunora/flags` provider is wired (the codegen override ran). */
    configured: boolean;
    /** Each discovered flag evaluated under the request's targeting context. */
    flags: FlagEvaluation[];
}

/**
 * One declared Cloudflare Workflow, surfaced by `__lunora_admin__:listWorkflows`
 * for the studio's Workflows page. Statically discovered by `@lunora/codegen`
 * from `lunora/workflows.ts` (the codegen subclass overrides the base hook);
 * workflows are not Durable Objects and carry no runtime state in the shard, so
 * this is pure declaration metadata. `name` is the deployed `workflows[].name`,
 * `binding` the generated `WORKFLOW_*` env binding, `className` the generated
 * `WorkflowEntrypoint` subclass, and `exportName` the `lunora/workflows.ts`
 * export the handle is addressed by (`ctx.workflows.get("exportName")`).
 */
interface WorkflowMetadata {
    binding: string;
    className: string;
    exportName: string;
    name: string;
}

/** Payload of a `__lunora_admin__:listWorkflows` call: every declared workflow, sorted by export name. */
interface WorkflowsResult {
    workflows: WorkflowMetadata[];
}

/**
 * One declared Cloudflare Queue, surfaced by `__lunora_admin__:listQueues` for
 * the studio's Queues page. Statically discovered by `@lunora/codegen` from
 * `lunora/queues.ts` (the codegen subclass overrides the base hook); queues are
 * not Durable Objects and carry no runtime state in the shard, so this is pure
 * declaration metadata. `binding` is the generated `QUEUE_*` producer binding,
 * `name` the deployed `queues.producers[].queue`, `exportName` the
 * `lunora/queues.ts` export (`ctx.queues.&lt;exportName>`), `mode` whether the
 * queue is consumed by a worker (`push`) or polled externally (`pull`), and
 * `deadLetterQueue` the optional DLQ a push consumer dead-letters to.
 */
interface QueueMetadata {
    binding: string;
    deadLetterQueue?: string;
    exportName: string;
    mode: "pull" | "push";
    name: string;
}

/** Payload of a `__lunora_admin__:listQueues` call: every declared queue, sorted by export name. */
interface QueuesResult {
    queues: QueueMetadata[];
}

/* eslint-disable no-secrets/no-secrets -- reserved admin RPC names (`createWorkflowInstance`/`getWorkflowInstanceStatus`) are framework constants, not credentials */

/**
 * Lifecycle state of a workflow instance, mirrored from `@lunora/workflow`'s
 * `WorkflowInstanceStatus` so `@lunora/do` carries no dependency on the workflow
 * package. Returned by `getWorkflowInstanceStatus` and `createWorkflowInstance`.
 */
type WorkflowInstanceState = "complete" | "errored" | "paused" | "queued" | "running" | "terminated" | "unknown" | "waiting" | "waitingForPause";

/** Payload of a `__lunora_admin__:createWorkflowInstance` call: the freshly created instance id and its initial status. */
interface CreateWorkflowInstanceResult {
    id: string;
    status: WorkflowInstanceState;
}

/** Payload of a `__lunora_admin__:getWorkflowInstanceStatus` call: the instance's current status plus output/error when present. */
interface WorkflowInstanceStatusResult {
    error?: { message: string; name: string };
    id: string;
    output?: unknown;
    status: WorkflowInstanceState;
}
/* eslint-enable no-secrets/no-secrets */

/** Payload of a `__lunora_admin__:getFunctionStats` call. */
interface FunctionStatsResult {
    /** One entry per dispatched function path, newest-called first. */
    functions: FunctionCallStat[];
    /** Epoch-ms this instance began collecting (shared with `getMetrics`). */
    sinceMs: number;
}

/**
 * How a deployment binding/var classifies, served by `__lunora_admin__:getSettings`.
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
 * Every field is optional — Lunora reads what the runtime happens to expose
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

/** Payload of a `__lunora_admin__:getSettings` call: the masked deployment config. */
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

    /**
     * Total rows matching the predicate. Absent when the read passed
     * `skipCount: true` (the caller sources the count from a separate,
     * predicate-keyed read instead of recomputing it per page).
     */
    total?: number;
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

    /**
     * Skip the `SELECT COUNT(*)` and return the page with `total` absent. The
     * data browser splits the row count into a separate predicate-keyed read (one
     * that excludes `offset`), so paging never re-counts; the page read passes
     * this to avoid recomputing the same total per offset. Unset → the COUNT runs
     * (today's behavior) and `total` is populated.
     */
    skipCount?: boolean;
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

/**
 * Options for {@link facetColumn} — the read-only "what values does this column
 * actually have?" summary. `column` is the displayed column to group by (a
 * physical/meta column or a `__doc__` field), validated against the table's known
 * columns and never interpolated. `filters` + `search` mirror
 * {@link ReadTablePageOptions}'s predicate args so the facet reflects the **active
 * view** (the same rows the data browser is previewing). `limit` caps the number
 * of distinct values returned (clamped); one extra is over-fetched to detect
 * truncation.
 */
interface FacetColumnOptions {
    column: string;
    filters?: FilterClause[];
    limit?: number;
    search?: string;
    table: string;
}

/** One distinct value of a faceted column with its row count over the active view. */
interface FacetValue {
    count: number;
    value: unknown;
}

/**
 * Payload of a {@link facetColumn} call: the top-N distinct `values` (each with a
 * `count`) ordered by frequency, plus `truncated` — `true` when more distinct
 * values existed beyond the cap (so the UI can say so rather than imply the list
 * is exhaustive).
 */
interface FacetColumnResult {
    truncated: boolean;
    values: FacetValue[];
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** Default cap on the number of distinct values a single facet returns. */
const DEFAULT_FACET_LIMIT = 30;

/** Hard cap on facet values, so a wide column can't return an unbounded group set. */
const MAX_FACET_LIMIT = 200;

/** The physical columns of a canonical Lunora shard table (user fields live in `__doc__`). */
const DOC_COLUMN = "__doc__";

/**
 * Parse a stored `__doc__` blob to a plain object, or `undefined` when the text
 * isn't a JSON object.
 *
 * Routes through `decodeDocJson` (`./do-sql`) — the decode half of the pair the writer
 * encodes with — so a `v.bigint()` / `v.bytes()` column reaches display as its
 * value rather than as the raw tagged form (`["$lunora.wire$","bigint","1000"]`).
 * `decodeWire` is a no-op on a tree with no sentinel, so a plain-JSON document
 * (the overwhelming majority) parses exactly as it did under bare `JSON.parse`.
 *
 * The non-throwing contract is preserved deliberately: `decodeDocJson` can throw
 * on a malformed tag (an over-long bigint, >64 nesting), and display code must
 * degrade to "unexpandable" rather than fail the whole page — so the decode sits
 * inside the same `try` as the parse.
 * @returns the parsed object, or `undefined` when parsing/decoding fails or the result is not a plain object
 */
const safeParseObject = (text: string): Record<string, unknown> | undefined => {
    try {
        const value = decodeDocumentJson(text) as unknown;

        return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Expand the JSON-blob storage into per-field columns for display. A canonical
 * Lunora shard table physically has `id`, `_creationTime` and a `__doc__` JSON
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
 * (`sqlite_*`), Cloudflare's Durable Object KV mirror (`_cf_*`), the Lunora FTS
 * capability probe and any FTS5 shadow tables (whose names carry the reserved
 * `__fts_` infix, e.g. `messages__fts_body` and its internal `*_data` / `*_idx`
 * siblings).
 */
const isInternalTable = (name: string): boolean =>
    name.startsWith("sqlite_") || name.startsWith("_cf_") || name.startsWith("__miniflare") || name.startsWith("__lunora") || name.includes("__fts_");

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
 * @returns the SQL expression and its bound params, or `undefined` for an unknown column on a non-doc table
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
 * @returns the SQL conjunct and bound params, or `undefined` for an unknown column on a non-doc table
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

/** `YYYY`, `YYYY-MM`, or `YYYY-MM-DD` — the prefixes worth treating as a range. */
const DATE_PREFIX = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/u;

/**
 * Epoch-millisecond half-open range `[from, to)` for a date-prefix term, or
 * `undefined` when the term is not one.
 *
 * Half-open on purpose: a closed upper bound would either miss the last
 * millisecond of the period or double-count the boundary between two periods.
 * Values are compared as epoch millis, which is how `_creationTime` and
 * `v.timestamp()` fields are stored.
 */
const datePrefixRange = (needle: string): undefined | { from: number; to: number } => {
    const match = DATE_PREFIX.exec(needle.trim());

    if (match === null) {
        return undefined;
    }

    const year = Number(match[1]);
    const month = match[2] === undefined ? undefined : Number(match[2]);
    const day = match[3] === undefined ? undefined : Number(match[3]);

    if (month !== undefined && (month < 1 || month > 12)) {
        return undefined;
    }

    if (day !== undefined && (day < 1 || day > 31)) {
        return undefined;
    }

    // `Date.UTC` remaps years 0-99 onto 1900+year, so `0026` would silently
    // become 1926. Reject them rather than answering with the wrong century.
    if (year < 100) {
        return undefined;
    }

    const from = Date.UTC(year, (month ?? 1) - 1, day ?? 1);

    // `Date.UTC` rolls an impossible day forward (2026-02-31 → 2026-03-03),
    // which would match real March rows for a date the operator cannot have
    // meant. Reject when the constructed date is not the one asked for.
    if (day !== undefined && new Date(from).getUTCDate() !== day) {
        return undefined;
    }
    let to: number;

    if (day !== undefined) {
        to = Date.UTC(year, month === undefined ? 0 : month - 1, day + 1);
    } else if (month === undefined) {
        to = Date.UTC(year + 1, 0, 1);
    } else {
        to = Date.UTC(year, month, 1);
    }

    return { from, to };
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
 * still covers all user fields — plus, when the term parses as a date or a
 * date-time prefix, a typed RANGE predicate (see {@link datePrefixRange}).
 * Without the range half, searching `2026-07` only matches rows whose stored
 * text happens to contain that substring, which for an epoch-millis or ISO
 * timestamp is an accident rather than a month filter.
 */
const buildTablePredicate = (columns: string[], needle: string, filters: FilterClause[] | undefined): undefined | { parameters: unknown[]; where: string } => {
    const conjuncts: string[] = [];
    const parameters: unknown[] = [];

    if (needle !== "" && columns.length > 0) {
        const pattern = `%${escapeLike(needle)}%`;
        const disjuncts = columns.map((name) => String.raw`CAST(${quoteIdentifier(name)} AS TEXT) LIKE ? ESCAPE '\'`);

        parameters.push(...columns.map(() => pattern));

        // A date-shaped term additionally matches timestamp columns by RANGE, so
        // `2026-07` finds July's rows rather than only those whose rendered text
        // literally contains "2026-07".
        const range = datePrefixRange(needle);

        if (range !== undefined) {
            for (const name of columns) {
                disjuncts.push(`(${quoteIdentifier(name)} >= ? AND ${quoteIdentifier(name)} < ?)`);
                parameters.push(range.from, range.to);
            }
        }

        conjuncts.push(`(${disjuncts.join(" OR ")})`);
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
 * @returns the ORDER BY SQL fragment and bound params, or `undefined` when no sort is requested or the column is unknown
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
        throw new LunoraError("UNKNOWN_TABLE", `unknown table: ${table}`, { status: 404 });
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
    const withReferences = (page: { columns: string[]; rows: Record<string, unknown>[]; total?: number }): TablePage => {
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

    // `skipCount` omits the COUNT entirely (the caller sources `total` from a
    // separate, predicate-keyed read so paging never re-counts). Otherwise the
    // COUNT reflects the filtered set so pagination stays honest.
    let total: number | undefined;

    if (!options.skipCount) {
        total =
            predicate === undefined
                ? countRows(sql, quoted)
                : Number(sql.exec<{ c: number | bigint }>(`SELECT COUNT(*) AS c FROM ${quoted}${whereSql}`, ...whereParams).one().c);
    }

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
        throw new LunoraError("UNKNOWN_TABLE", `unknown table: ${table}`, { status: 404 });
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

/**
 * The set of displayed columns the data browser would show for `table`, used to
 * validate a faceted column without trusting the caller. Physical/meta columns
 * come from PRAGMA; for a doc-stored table (`__doc__` present) the user fields are
 * the union of the JSON object keys across a bounded sample of rows — the same
 * keys {@link expandDocumentRows} lifts to top-level columns. So a typo'd column
 * (e.g. a doc field that no row has) is rejected up front rather than silently
 * faceting a column of all-NULLs.
 */
const knownDisplayColumns = (sql: SqlExec, quotedTable: string, physicalColumns: string[]): Set<string> => {
    const known = new Set(physicalColumns.filter((name) => name !== DOC_COLUMN));

    if (!physicalColumns.includes(DOC_COLUMN)) {
        return known;
    }

    const sample = sql.exec<{ doc: unknown }>(`SELECT ${quoteIdentifier(DOC_COLUMN)} AS doc FROM ${quotedTable} LIMIT ?`, MAX_PAGE_SIZE).toArray();

    for (const { doc } of sample) {
        const documentData = typeof doc === "string" ? safeParseObject(doc) : undefined;

        if (documentData !== undefined) {
            for (const key of Object.keys(documentData)) {
                known.add(key);
            }
        }
    }

    return known;
};

/**
 * Summarise the distinct values of one displayed column over the **active view** —
 * Datasette-style faceting. Read-only: a `SELECT &lt;col> AS value, COUNT(*) AS count
 * … GROUP BY &lt;col> ORDER BY count DESC LIMIT N+1` with every value and JSON path
 * bound, never interpolated. `column` is validated against the table's known
 * displayed columns (rejected with a typed 404 if unknown) and resolved through the
 * SAME {@link resolveColumnExpression} allowlist as filters/order-by, so a
 * physical column groups by its quoted identifier and a `__doc__` field by a bound
 * `json_extract` path. `filters` + `search` compile through the SAME
 * {@link buildTablePredicate} as {@link readTablePage}, so the facet reflects
 * exactly the rows the browser is previewing. The extra over-fetched row is dropped
 * and surfaced as `truncated`, so a capped facet never silently implies it is
 * exhaustive. The table name is validated against `sqlite_master` first, so this
 * can't be coerced into scanning bookkeeping tables.
 */
const facetColumn = (sql: SqlExec, options: FacetColumnOptions): FacetColumnResult => {
    const { column, table } = options;

    if (isInternalTable(table) || !tableExists(sql, table)) {
        throw new LunoraError("UNKNOWN_TABLE", `unknown table: ${table}`, { status: 404 });
    }

    const quoted = quoteIdentifier(table);
    const physicalColumns = sql
        .exec<{ name: string }>(`PRAGMA table_info(${quoted})`)
        .toArray()
        .map((info) => info.name);

    if (!knownDisplayColumns(sql, quoted, physicalColumns).has(column)) {
        throw new LunoraError("UNKNOWN_COLUMN", `unknown column: ${column}`, { status: 404 });
    }

    const resolved = resolveColumnExpression(column, physicalColumns);

    if (resolved === undefined) {
        // Defensive: a known column always resolves; if it somehow doesn't, fail
        // closed rather than build SQL without a bound expression.
        throw new LunoraError("UNKNOWN_COLUMN", `unknown column: ${column}`, { status: 404 });
    }

    const limit = clamp(Math.trunc(options.limit ?? DEFAULT_FACET_LIMIT), 1, MAX_FACET_LIMIT);
    const needle = options.search?.trim() ?? "";
    const predicate = buildTablePredicate(physicalColumns, needle, options.filters);

    const whereSql = predicate === undefined ? "" : ` WHERE ${predicate.where}`;
    const whereParams = predicate?.parameters ?? [];

    // The grouped expression's bound path params appear twice (SELECT + GROUP BY),
    // so they bracket the WHERE params on each side in SQL order. Over-fetch one
    // row past the cap to detect (and report) truncation.
    const rows = sql
        .exec<{
            count: bigint | number;
            value: unknown;
        }>(
            `SELECT ${resolved.expression} AS value, COUNT(*) AS count FROM ${quoted}${whereSql} GROUP BY ${resolved.expression} ORDER BY count DESC LIMIT ?`,
            ...resolved.params,
            ...whereParams,
            ...resolved.params,
            limit + 1,
        )
        .toArray();

    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;

    return {
        truncated,
        values: kept.map((row) => {
            return { count: Number(row.count), value: row.value };
        }),
    };
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

/**
 * One topic or shape with the number of sockets currently subscribed to it, as
 * surfaced by `__lunora_admin__:getFanoutMetrics`. `subscribers` is the fan-out
 * **width** one poke/broadcast incurs for this topic — the O(subscribers) cost
 * the auto-elastic relay tier (plan 075) targets — so a single hot topic is
 * visible here long before it becomes a bottleneck.
 */
interface FanoutTopicStat {
    /** `"shape"` = a reactive-query shape (poked from SQLite); `"whisper"` = an ephemeral whisper topic. */
    kind: "shape" | "whisper";
    /** Connected sockets currently subscribed — the fan-out width one flush/broadcast incurs for this topic. */
    subscribers: number;
    /** The shape name (the `defineShape` export) or the whisper topic string. */
    topic: string;
}

/**
 * Running fan-out counters for one delivery path (the reactive shape poke or the
 * whisper broadcast) since this DO instance woke. In-memory and reset on
 * hibernation/restart — the same "since this instance woke" granularity as
 * `getMetrics`/`getFunctionStats`.
 *
 * `socketsIterated` is the O(subscribers) loop cost the relay tier targets;
 * `socketsDelivered` is how many of those iterated sockets actually received a
 * frame (the rest were visited but had no matching shape, or were the whisper
 * sender). `totalMs`/`maxMs` are **coarse** wall-clock for the asynchronous
 * shape-poke path only: a Durable Object's clock advances only across I/O, so
 * treat them as directional, not exact. They stay `0` for the synchronous
 * whisper path, which performs no awaited I/O to time.
 */
interface FanoutPathCounters {
    /** Coarse slowest single pass, in ms (shape-poke path only; `0` for whisper). */
    maxMs: number;
    /** Fan-out passes that ran (shape-poke flushes / whisper broadcasts). */
    passes: number;
    /** Widest single pass — the most sockets iterated in one flush/broadcast. */
    peakSocketsIterated: number;

    /**
     * Sockets a frame was sent to, summed across every pass. The shape-poke path
     * counts only confirmed sends (`sendPoke` returned `true`); the whisper path
     * counts matched receivers (the best-effort `trySendFrame` may silently no-op
     * on a socket that closed between the snapshot and the send), so it can very
     * marginally over-count in that near-impossible race.
     */
    socketsDelivered: number;
    /** Sockets visited, summed across every pass — the O(subscribers) iteration cost. */
    socketsIterated: number;
    /** Coarse summed wall-clock across every pass, in ms (shape-poke path only; `0` for whisper). */
    totalMs: number;
}

/**
 * Payload of a `__lunora_admin__:getFanoutMetrics` call: the current per-topic
 * subscriber counts plus the running fan-out counters for each delivery path.
 * The point-in-time `topics`/`peakSubscribers`/`totalConnections` are derived
 * live from `getWebSockets()` + each socket's attachment; the `shapePoke`/
 * `whisper` counters are the in-memory running tallies (reset on hibernation).
 * Feeds the Studio fan-out observability panel — the "you can see it scale"
 * half of plan 075 Phase 1, before any topology change exists.
 */
interface FanoutMetricsResult {
    /** Cost ceiling — the hard cap on relays per shard (`LUNORA_MAX_RELAYS`); the relay tier never spawns more, even for a viral shard. */
    maxRelays: number;
    /** Highest current subscriber count across all topics/shapes — the widest single fan-out right now. */
    peakSubscribers: number;
    /** `true` once this shard crossed the promotion threshold and is spreading new connections across relays (plan 075 Phase 2). */
    promoted: boolean;
    /** How many relays new connections are currently spread across (`0` when owner-served). */
    relayCount: number;
    /** Running reactive-shape-poke fan-out counters since this instance woke. */
    shapePoke: FanoutPathCounters;
    /** Epoch-ms this instance began collecting (shared with `getMetrics`/`getFunctionStats`). */
    sinceMs: number;
    /** Hottest topics/shapes by current subscriber count, busiest first (capped at {@link DEFAULT_FANOUT_TOPIC_LIMIT}). */
    topics: FanoutTopicStat[];
    /** Live socket count on this shard. */
    totalConnections: number;
    /** Running whisper-broadcast fan-out counters since this instance woke. */
    whisper: FanoutPathCounters;
}

/**
 * One socket's attachment as seen by {@link summarizeFanoutTopics} — the subset
 * of `./types`' `SocketAttachment` the fan-out summary reads (live `shapes` keyed
 * by subscription id, and the joined whisper `topics`). Narrowed so the summary
 * stays a pure, harness-testable function with no dependency on the DO runtime.
 */
interface FanoutAttachmentLike {
    shapes?: Record<string, { name?: string }>;
    whispers?: string[];
}

/** Default cap on the number of hot topics {@link summarizeFanoutTopics} returns, so a deployment with thousands of distinct shapes can't return an unbounded list. */
const DEFAULT_FANOUT_TOPIC_LIMIT = 20;

/** A freshly-zeroed {@link FanoutPathCounters}, for a DO instance waking up. */
const createFanoutCounters = (): FanoutPathCounters => {
    return { maxMs: 0, passes: 0, peakSocketsIterated: 0, socketsDelivered: 0, socketsIterated: 0, totalMs: 0 };
};

/**
 * Fold one fan-out pass into a running {@link FanoutPathCounters}, returning the
 * updated counters: bump the pass count, add the iterated/delivered socket
 * totals, and lift the peak-width and slowest-pass high-water marks. Pure (a new
 * object, no mutation) so it stays trivially testable; the caller swaps the
 * stored counters for the result. `ms` is `0` for the synchronous whisper path
 * (nothing awaited to time).
 */
const recordFanoutPass = (counters: FanoutPathCounters, iterated: number, delivered: number, ms: number): FanoutPathCounters => {
    return {
        maxMs: Math.max(counters.maxMs, ms),
        passes: counters.passes + 1,
        peakSocketsIterated: Math.max(counters.peakSocketsIterated, iterated),
        socketsDelivered: counters.socketsDelivered + delivered,
        socketsIterated: counters.socketsIterated + iterated,
        totalMs: counters.totalMs + ms,
    };
};

/**
 * Fold a per-socket list of attachments into the point-in-time half of a
 * {@link FanoutMetricsResult}: current subscriber count per shape (grouped by
 * `defineShape` name) and per whisper topic, the busiest `limit` of them, the
 * peak width across all of them, and the live socket count. Pure — the DO method
 * feeds it `getWebSockets().map(readAttachment)` and merges in the running
 * counters.
 */
const summarizeFanoutTopics = (
    attachments: FanoutAttachmentLike[],
    limit: number = DEFAULT_FANOUT_TOPIC_LIMIT,
): { peakSubscribers: number; topics: FanoutTopicStat[]; totalConnections: number } => {
    const shapeCounts = new Map<string, number>();
    const whisperCounts = new Map<string, number>();

    for (const attachment of attachments) {
        for (const shape of Object.values(attachment.shapes ?? {})) {
            const key = shape.name ?? "(unknown shape)";

            shapeCounts.set(key, (shapeCounts.get(key) ?? 0) + 1);
        }

        for (const topic of attachment.whispers ?? []) {
            whisperCounts.set(topic, (whisperCounts.get(topic) ?? 0) + 1);
        }
    }

    const topics: FanoutTopicStat[] = [
        ...[...shapeCounts].map(([topic, subscribers]): FanoutTopicStat => {
            return { kind: "shape", subscribers, topic };
        }),
        ...[...whisperCounts].map(([topic, subscribers]): FanoutTopicStat => {
            return { kind: "whisper", subscribers, topic };
        }),
    ];

    // Busiest first; ties broken by name so the order is stable across reads.
    topics.sort((a, b) => b.subscribers - a.subscribers || a.topic.localeCompare(b.topic));

    // The peak is the head of the busiest-first list — and it is the FULL list,
    // so the global max survives the `slice(0, limit)` truncation below.
    const peakSubscribers = topics[0]?.subscribers ?? 0;

    return { peakSubscribers, topics: topics.slice(0, limit), totalConnections: attachments.length };
};

export {
    ADMIN_FUNCTION_PREFIX,
    ADMIN_FUNCTIONS,
    createFanoutCounters,
    datePrefixRange,
    DEFAULT_FANOUT_TOPIC_LIMIT,
    facetColumn,
    findStorageReferences,
    FLAGS_FUNCTION_PREFIX,
    listTables,
    MAX_PAGE_SIZE,
    readTablePage,
    recordFanoutPass,
    RELATION_FUNCTION_PREFIX,
    selectMatchingIds,
    summarizeFanoutTopics,
    summarizeSubscriptions,
};
export type {
    AdvisoriesResult,
    AdvisorProcedure,
    AdvisorProceduresResult,
    AdvisoryFinding,
    AuditLogResult,
    ColumnMeta,
    CreateWorkflowInstanceResult,
    DeployInfo,
    FacetColumnOptions,
    FacetColumnResult,
    FacetValue,
    FanoutMetricsResult,
    FanoutPathCounters,
    FanoutTopicStat,
    FilterClause,
    FilterOperator,
    FlagEvaluation,
    FlagsResult,
    FunctionCallStat,
    FunctionScanAttribution,
    FunctionStatsResult,
    MaskColumnMetadata,
    MaskPoliciesResult,
    OrderByClause,
    QueueMetadata,
    QueuesResult,
    ReadTablePageOptions,
    RlsPoliciesResult,
    RlsPolicyMetadata,
    RlsRoleMetadata,
    SelectMatchingIdsOptions,
    SettingEntry,
    SettingKind,
    SettingsResult,
    StorageReference,
    StorageReferenceResult,
    StorageRuleMetadata,
    StorageRulesResult,
    StudioFeaturesResult,
    SubscriptionConnection,
    SubscriptionInfo,
    SubscriptionsResult,
    TableColumnsResult,
    TableIndexesResult,
    TableIndexInfo,
    TableInfo,
    TablePage,
    TablesColumnsResult,
    TablesIndexesResult,
    WorkflowInstanceState,
    WorkflowInstanceStatusResult,
    WorkflowMetadata,
    WorkflowsResult,
};
