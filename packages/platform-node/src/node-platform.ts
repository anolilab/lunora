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
    /** `using platform = createNodePlatform(...)` support — delegates to `close()`. */
    [Symbol.dispose]: () => void;

    /** What this target supports — see `NODE_CAPABILITIES` in `@lunora/platform`. */
    capabilities: PlatformCapabilities;

    /**
     * Tear this platform instance down: clears the shard host's pending alarm
     * timer and closes its `better-sqlite3` database (and, with it, `kv`'s
     * table — both live on the same connection), then clears every armed
     * scheduler job timer. Nothing in this package closes these resources on
     * its own — a `NodePlatform` a caller stops using without calling `close()`
     * leaks the open file handle (plus its WAL/SHM sidecar files) and keeps
     * the process alive on outstanding timers. Safe to call more than once.
     */
    close: () => void;
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
    const { database, dispose: disposeShard, host: shard } = createNodeShardHost(options);
    const kv = createNodeShardKvStore(database);
    const directory = createNodeShardDirectory();
    const { socket: sockets } = createNodeSocketHost();
    const { dispose: disposeScheduler, scheduler } = createNodeSchedulerHost();

    const close = (): void => {
        disposeShard();
        disposeScheduler();
    };

    return { capabilities: NODE_CAPABILITIES, close, directory, kv, scheduler, shard, sockets, [Symbol.dispose]: close };
};
