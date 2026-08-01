/**
 * The Node composition root: assembles every `@lunora/platform` contract this
 * package implements from one `better-sqlite3` database file, mirroring
 * `@lunora/platform-cloudflare`'s `createShardPlatform`.
 *
 * Deliberately narrower than `@lunora/platform-cloudflare`'s two-root split
 * (`createShardPlatform` for one DO instance, `createWorkerPlatform` for the
 * Worker's `env` bindings): a Node process has no directory-of-namespaces
 * concept to resolve at a separate "worker" scope — there is one process, and
 * `NodePlatform` exposes its directory and scheduler alongside the shard
 * contracts directly. A future non-spike version that actually wires multiple
 * shards per process may need to split this the same way; this spike does not
 * need to guess at that shape.
 */

import type { PlatformCapabilities, SchedulerHost, ShardDirectory, ShardHost, ShardKvStore, SocketHost } from "@lunora/platform";
import { NODE_CAPABILITIES } from "@lunora/platform";

import { createNodeShardKvStore } from "./node-kv-store";
import { createNodeSchedulerHost } from "./node-scheduler-host";
import { createNodeShardDirectory } from "./node-shard-directory";
import type { NodeShardHostOptions } from "./node-shard-host";
import { createNodeShardHost } from "./node-shard-host";
import { createNodeSocketHost } from "./node-socket-host";

/** Every contract this package provides, composed for one Node process. */
export interface NodePlatform {
    /** What this target supports — see `NODE_CAPABILITIES` in `@lunora/platform`. */
    capabilities: PlatformCapabilities;
    /** In-process shard directory (see `createNodeShardDirectory`'s docstring for what it cannot do). */
    directory: ShardDirectory;
    /** Durable key-value storage backed by the same `better-sqlite3` database as `shard`. */
    kv: ShardKvStore;
    /** In-process delayed jobs — NOT durable across a process restart; see `createNodeSchedulerHost`. */
    scheduler: SchedulerHost;
    /** Single-writer execution, local SQL, transactions, alarms. */
    shard: ShardHost;
    /** In-process socket registry with mutable tags. */
    sockets: SocketHost;
}

/** Options for {@link createNodePlatform}. */
export type NodePlatformOptions = NodeShardHostOptions;

/** Compose every contract this package provides over one `better-sqlite3` database. */
export const createNodePlatform = (options: NodePlatformOptions = {}): NodePlatform => {
    const { database, host: shard } = createNodeShardHost(options);
    const kv = createNodeShardKvStore(database);
    const directory = createNodeShardDirectory();
    const { socket: sockets } = createNodeSocketHost();
    const { scheduler } = createNodeSchedulerHost();

    return { capabilities: NODE_CAPABILITIES, directory, kv, scheduler, shard, sockets };
};
