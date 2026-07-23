/**
 * `@lunora/shard-engine` — host-neutral reactive engine for Lunora.
 *
 * The engine consumes the provider-neutral contracts from `@lunora/platform`
 * (`ShardHost`, `SocketHost`, `ShardDirectory`, `SchedulerHost`) and implements
 * per-shard state, OCC, CDC, reactive subscriptions, and the poke protocol.
 */

export type { DependencyTracker } from "./dependency-tracker";
export { createDependencyTracker, depKey, SCAN_DEP, tableFromDepKey } from "./dependency-tracker";
export type { ConflictKind } from "./transaction";
export type { TransactionSqlLike } from "./transaction";
export { ConflictError } from "./transaction";
