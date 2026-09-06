/**
 * `@lunora/platform` — provider-neutral host contracts for Lunora.
 *
 * This package defines the structural interfaces that separate the Lunora
 * engine from any specific host (Cloudflare Workers, AWS, Rivet, Node, etc.).
 * It contains **types and capability metadata only** — near-zero runtime code.
 *
 * The contracts fall into four groups:
 *
 * 1. **Shard host** (`ShardHost`) — single-writer execution, transactions,
 * local SQL, alarms, and background continuation per shard key.
 * 2. **Socket host** (`SocketHost`) — hibernated WebSocket subscriptions with
 * durable attachments and tagged fan-out.
 * 3. **Shard directory** (`ShardDirectory`) — deterministic placement and RPC
 * dispatch from shard keys to stubs.
 * 4. **Scheduler host** (`SchedulerHost`) — durable delayed jobs, cron, and
 * at-least-once dispatch.
 *
 * Plus canonical binding projections (`KVNamespaceLike`, `R2BucketLike`,
 * `QueueBindingLike`, `D1DatabaseLike`, `VectorizeIndexLike`, …) and the
 * `PlatformCapabilities` matrix that codegen uses to tailor emitted types per
 * target.
 *
 * This package is **zero-dependency** and safe on every runtime (browser,
 * workerd, Node). It is intended to be the leaf dependency every other
 * `@lunora/*` package can import without creating cycles.
 */

// Execution context (zero-dep, shared/ inlined)
export type { ExecutionContextLike } from "../../../shared/execution-context";
export { NOOP_EXECUTION_CONTEXT } from "../../../shared/execution-context";

// Canonical binding projections. These are the SHIPPING shapes, promoted from
// the packages that use them — not idealized restatements. A projection with no
// consumer drifts from reality (see `ShardSqlExec`), so each one is re-exported
// by its owning package rather than duplicated there.
export type {
    AnalyticsEngineDataPoint,
    AnalyticsEngineDataPointLike,
    AnalyticsEngineDatasetLike,
    D1DatabaseLike,
    D1PreparedStatementLike,
    D1SessionLike,
    HttpCacheLike,
    HttpCacheQueryOptions,
    KvGetOptions,
    KvListKey,
    KVNamespaceLike,
    KvNamespaceListResult,
    KvNamespacePutOptions,
    KvValue,
    KvValueType,
    MessageBatchLike,
    MessageLike,
    MessageSendRequestLike,
    QueueBindingLike,
    QueueContentType,
    QueueMessageLike,
    QueueRetryOptions,
    QueueSendBatchOptions,
    QueueSendOptions,
    QueueSendOptionsLike,
    QueueSendRequestLike,
    R2BucketLike,
    R2MultipartUploadLike,
    R2ObjectBodyLike,
    R2ObjectLike,
    R2RangeLike,
    R2UploadedPartLike,
    VectorizeDeleteMutation,
    VectorizeIndexDetails,
    VectorizeIndexLike,
    VectorizeMatch,
    VectorizeMatches,
    VectorizeQueryOptions,
    VectorizeUpsertMutation,
    VectorizeVector,
    VectorMatchLike,
    VectorMetric,
    VectorRecordLike,
} from "./bindings";

// Capability matrix
export type { Capability, CapabilityLevel, PlatformCapabilities } from "./capabilities";
export { CELLD_CAPABILITIES, CLOUDFLARE_CAPABILITIES, NODE_CAPABILITIES } from "./capabilities";

// Durable key-value store
export type { ShardKvListOptions, ShardKvStore } from "./kv-store";

// Scheduler host
export type { ScheduledJob, ScheduledJobStatus, ScheduleOptions, SchedulerHost } from "./scheduler-host";

// Shard directory
export type { DirectShardDirectory, ShardDirectory, ShardJurisdiction, ShardRegionHint, ShardStub, TwoStepShardDirectory } from "./shard-directory";
export { resolveShard } from "./shard-directory";
// Shard host
export type { ShardAlarms, ShardHost, ShardSqlCursor, ShardSqlExec, SqlRow } from "./shard-host";

// Socket host
export type { SocketHandle, SocketHost } from "./socket-host";
