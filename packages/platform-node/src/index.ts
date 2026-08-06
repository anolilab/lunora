/**
 * `@lunora/platform-node` — a Node implementation of the `@lunora/platform`
 * host contracts (`ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`,
 * `SchedulerHost`) over `better-sqlite3` and an in-process socket/directory/
 * scheduler registry.
 *
 * Promoted from `@lunora/platform`'s `node:sqlite` reference host
 * (`src/conformance/reference-host.ts`) under plan 234, then hardened until the
 * durability half of each contract actually holds: alarms and scheduler jobs
 * are persisted **and re-armed on construction**, socket attachments and tags
 * live in SQLite rather than a `Map`, and `.global()` tables run the real
 * `@lunora/sql-store` core (`./node-global-store`). Each of those is pinned by
 * a restart test — a second host over the same database file — not only by the
 * TCK's simulated recycle.
 *
 * Three suites run against this package: `@lunora/platform/conformance`'s host
 * TCK, `@lunora/shard-engine/conformance`'s engine suite, and its own
 * lifecycle/global-store tests.
 *
 * **Still missing**, and rated accordingly in `NODE_CAPABILITIES`
 * (`@lunora/platform`): a dev server — so `lunora dev --target node` does not
 * exist yet — and every Cloudflare product binding (R2, Queues, Workflows,
 * Vectorize, Workers AI, Browser Rendering, Containers, Analytics Engine,
 * Pipelines, Secrets Store, Hyperdrive). Cross-shard fan-out is emulated via
 * `@lunora/runtime`'s query coordinator over the in-process shard registry, and
 * a `@lunora/config` deploy driver makes `--target node` resolve. See
 * `plans/234-node-host-findings.md`.
 */

export type { NodeGlobalContextDatabaseOptions, NodeGlobalStore, NodeGlobalStoreOptions } from "./node-global-store";
export { createNodeGlobalStore, createNodeSqlExec } from "./node-global-store";
export { createNodeShardKvStore } from "./node-kv-store";
export type { NodePlatform, NodePlatformOptions } from "./node-platform";
export { createNodePlatform } from "./node-platform";
export type { NodeSchedulerHost, NodeSchedulerHostOptions } from "./node-scheduler-host";
export { createNodeSchedulerHost } from "./node-scheduler-host";
export type { NodeShardHostOptions } from "./node-shard-host";
export { createNodeShardHost } from "./node-shard-host";
export type { NodeShard, NodeShardRegistry, NodeShardRegistryOptions } from "./node-shard-registry";
export { createNodeShardRegistry } from "./node-shard-registry";
export type { NodeShardState } from "./node-shard-state";
export { createNodeShardState } from "./node-shard-state";
export type { NodeSocketHost } from "./node-socket-host";
export { createNodeSocketHost } from "./node-socket-host";
