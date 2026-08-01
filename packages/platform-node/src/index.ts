/**
 * `@lunora/platform-node` — a Node implementation of the `@lunora/platform`
 * host contracts (`ShardHost`, `SocketHost`, `ShardDirectory`, `ShardKvStore`,
 * `SchedulerHost`) over `better-sqlite3` and an in-process socket/directory/
 * scheduler registry.
 *
 * **Spike (plan 234).** Promoted from `@lunora/platform`'s `node:sqlite`
 * reference host (`src/conformance/reference-host.ts`) and hardened toward
 * real persistence semantics — see each adapter module's docstring for what
 * changed and why, and `plans/234-node-host-findings.md` for every contract
 * gap this construction surfaced. Not wired into `lunora dev`; no deploy
 * driver; several capabilities are honestly rated `emulated`/`unsupported` in
 * `NODE_CAPABILITIES` (`@lunora/platform`).
 */

export { createNodeShardKvStore } from "./node-kv-store";
export type { NodePlatform, NodePlatformOptions } from "./node-platform";
export { createNodePlatform } from "./node-platform";
export type { NodeSchedulerHost } from "./node-scheduler-host";
export { createNodeSchedulerHost } from "./node-scheduler-host";
export { createNodeShardDirectory } from "./node-shard-directory";
export type { NodeShardHostOptions } from "./node-shard-host";
export { createNodeShardHost } from "./node-shard-host";
export type { NodeSocketHost } from "./node-socket-host";
export { createNodeSocketHost } from "./node-socket-host";
