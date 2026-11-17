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
 * **Serving an app.** `createNodeAppHost` composes a worker entry module over
 * one shard registry per Durable Object binding, and `createNodeHttpServer`
 * serves its `fetch` over `node:http`, streaming the response body. `lunora dev
 * --target node` runs exactly that pair. Nothing here owns a timer, so queue
 * delivery is driven by an explicit `poll()`. Absent are the Cloudflare product
 * bindings with no local equivalent — Vectorize, Workers AI, Browser Rendering,
 * Containers, Analytics Engine, Pipelines. `ctx.secrets` reads environment
 * variables through `createNodeSecretBindings` (`./node-secrets`), the
 * Hyperdrive binding is built from `DATABASE_URL` by `createNodeHyperdrive`
 * (`./node-hyperdrive`), and `@lunora/mail` sends are queued and delivered by
 * `createNodeMailHost` (`./node-mail-host`) through Resend or a caller-supplied
 * transport.
 *
 * `lunora deploy --target node` bundles an app into a container build context
 * whose generated entry composes this package (crons, `ctx.secrets`,
 * Hyperdrive from `DATABASE_URL`) and serves it with `createNodeHttpServer`.
 *
 * `@lunora/config` ships a `node` **deploy** driver, so `--target node` resolves
 * and codegen gates against `NODE_CAPABILITIES`. There is no hosted control
 * plane to deploy to and no `wrangler`-equivalent to shell out to, which is why
 * the deploy stops at a build context. See `plans/234-node-host-findings.md`.
 */

export type { Drainable, DrainOptions, DrainResult, DrainTimer } from "./drain-deadline";
export { DEFAULT_DRAIN_TIMEOUT_MS, drainTogether } from "./drain-deadline";
export type { NodeAppDurableObjectBinding, NodeAppHost, NodeAppHostOptions } from "./node-app-host";
export { createNodeAppHost } from "./node-app-host";
export type { NodeDispatchInvocation, NodeDispatchRouteOptions } from "./node-dispatch-route";
export { createNodeDispatchRoute, NODE_SCHEDULER_DISPATCH_PATH } from "./node-dispatch-route";
export type { NodeGlobalContextDatabaseOptions, NodeGlobalStore, NodeGlobalStoreOptions } from "./node-global-store";
export { createNodeGlobalStore, createNodeSqlExec } from "./node-global-store";
export type { NodeHttpServer, NodeHttpServerOptions } from "./node-http-server";
export { createNodeHttpServer } from "./node-http-server";
export type { NodeHyperdriveBinding } from "./node-hyperdrive";
export { createNodeHyperdrive } from "./node-hyperdrive";
export { createNodeShardKvStore } from "./node-kv-store";
export type { MailParkReason, NodeMailHost, NodeMailHostOptions } from "./node-mail-host";
export { createNodeMailHost } from "./node-mail-host";
export type { NodeCronJob, NodePlatform, NodePlatformDispatchOptions, NodePlatformMailOptions, NodePlatformOptions } from "./node-platform";
export { createNodePlatform } from "./node-platform";
export type { NodeProfileHandler, NodeProfileHandlerOptions } from "./node-profile-handler";
export { createNodeProfileHandler } from "./node-profile-handler";
export type { NodeQueueHost, NodeQueueHostOptions } from "./node-queue-host";
export { createNodeQueueHost } from "./node-queue-host";
export type { NodeR2BucketOptions } from "./node-r2-bucket";
export { createNodeR2Bucket } from "./node-r2-bucket";
export type { NodeDeclaredCron, NodeSchedulerHost, NodeSchedulerHostOptions } from "./node-scheduler-host";
export { createNodeSchedulerHost } from "./node-scheduler-host";
export type { NodeSecretBinding } from "./node-secrets";
export { createNodeSecretBindings } from "./node-secrets";
export type { NodeShardHostOptions } from "./node-shard-host";
export { createNodeShardHost } from "./node-shard-host";
export { createNodeShardNamespace } from "./node-shard-namespace";
export type { NodeShard, NodeShardRegistry, NodeShardRegistryOptions } from "./node-shard-registry";
export { createNodeShardRegistry } from "./node-shard-registry";
export type { NodeShardState, ShardSocketHooks } from "./node-shard-state";
export { bindShardSockets, createNodeShardState } from "./node-shard-state";
export type { NodeSocketHost } from "./node-socket-host";
export { createNodeSocketHost } from "./node-socket-host";
export type { NodeWorkflowHost, NodeWorkflowHostOptions } from "./node-workflow-host";
export { createNodeWorkflowHost } from "./node-workflow-host";
export { createNodeWorkflowStore } from "./node-workflow-store";
