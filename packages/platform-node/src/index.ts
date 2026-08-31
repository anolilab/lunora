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
 * **Emulated here**, and rated accordingly in `NODE_CAPABILITIES`
 * (`@lunora/platform`): queues over a durable table (`./node-queue-host`), R2
 * buckets over the local filesystem (`./node-r2-bucket`), workflows over the
 * `@visulima/workflow` engine (`./node-workflow-host`), and cross-shard fan-out
 * via `@lunora/runtime`'s query coordinator over the in-process shard registry.
 * `createNodePlatform` binds all three declarations (`queues`, `workflows`,
 * `objectStorageDirectory`) — a capability rated `emulated` with nothing bound
 * is the one combination that fails at runtime with no diagnostic before it.
 *
 * **Still missing:** a dev server. There is no `lunora dev --target node`, and
 * nothing here owns a timer, so queue delivery is driven by an explicit
 * `poll()`. Also absent are the Cloudflare product bindings with no local
 * equivalent — Vectorize, Workers AI, Browser Rendering, Containers, Analytics
 * Engine, Pipelines, Secrets Store, Hyperdrive.
 *
 * `@lunora/config` ships a `node` **deploy** driver, so `--target node` resolves
 * for `provision` — which reports, once, which declared features this target
 * cannot serve, and writes nothing: there is no hosted control plane to deploy
 * to and no `wrangler`-equivalent to shell out to. A deploy driver is not a dev
 * server, which is why both statements above hold at once. See
 * `plans/234-node-host-findings.md`.
 */

export type { NodeGlobalContextDatabaseOptions, NodeGlobalStore, NodeGlobalStoreOptions } from "./node-global-store";
export { createNodeGlobalStore, createNodeSqlExec } from "./node-global-store";
export { createNodeShardKvStore } from "./node-kv-store";
export type { NodePlatform, NodePlatformOptions } from "./node-platform";
export { createNodePlatform } from "./node-platform";
export type { NodeQueueHost, NodeQueueHostOptions } from "./node-queue-host";
export { createNodeQueueHost } from "./node-queue-host";
export type { NodeR2BucketOptions } from "./node-r2-bucket";
export { createNodeR2Bucket } from "./node-r2-bucket";
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
export type { NodeWorkflowHost, NodeWorkflowHostOptions } from "./node-workflow-host";
export { createNodeWorkflowHost } from "./node-workflow-host";
export { createNodeWorkflowStore } from "./node-workflow-store";
