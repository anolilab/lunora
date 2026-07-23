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

// Canonical binding projections
export type {
    AnalyticsEngineDataPointLike,
    AnalyticsEngineDatasetLike,
    D1DatabaseLike,
    D1PreparedStatementLike,
    D1SessionLike,
    KVNamespaceLike,
    MessageBatchLike,
    QueueBindingLike,
    QueueMessageLike,
    QueueSendOptionsLike,
    QueueSendRequestLike,
    R2BucketLike,
    R2ObjectBodyLike,
    R2ObjectLike,
    VectorizeIndexLike,
    VectorMatchLike,
    VectorRecordLike,
} from "./bindings";

// Capability matrix
export type { Capability, CapabilityLevel, PlatformCapabilities } from "./capabilities";
export { CLOUDFLARE_CAPABILITIES } from "./capabilities";

// Scheduler host
export type { ScheduledJob, ScheduleOptions, SchedulerHost } from "./scheduler-host";

// Shard directory
export type { ShardDirectory, ShardJurisdiction, ShardStub } from "./shard-directory";
// Shard host
export type { ShardAlarms, ShardAsyncSqlExec, ShardHost, ShardSqlExec, SqlRow } from "./shard-host";

// Socket host
export type { SocketHandle, SocketHost } from "./socket-host";
