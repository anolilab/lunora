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
import type { NodeSchedulerHostOptions } from "./node-scheduler-host";
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

    /**
     * Wait for every promise handed to `shard.waitUntil` to settle.
     *
     * Separate from `close()` because the two answer different questions:
     * `close()` releases handles and stays synchronous (it backs
     * `Symbol.dispose`), while draining is inherently awaitable. A graceful
     * shutdown is `await platform.drain()` then `platform.close()`.
     */
    drain: () => Promise<void>;

    /** Durable key-value storage backed by the same `better-sqlite3` database as `shard`. */
    kv: ShardKvStore;
    /** Delayed jobs and crons, persisted to the same database and re-armed on construction. */
    scheduler: SchedulerHost;
    /** Single-writer execution, local SQL, transactions, durable alarms. */
    shard: ShardHost;
    /** Socket registry with mutable tags and SQLite-persisted attachments. */
    sockets: SocketHost;
}

/**
 * Options for {@link createNodePlatform} — the shard host's (`path`,
 * `shardKey`, `onAlarm`) plus the scheduler's (`onDispatch`). Both delivery
 * hooks are optional and both are what make the durable halves useful: a
 * re-armed alarm or job with nowhere to land is bookkeeping.
 */
export type NodePlatformOptions = NodeSchedulerHostOptions & NodeShardHostOptions;

/** Compose every contract this package provides over one `better-sqlite3` database. */
export const createNodePlatform = (options: NodePlatformOptions = {}): NodePlatform => {
    const { database, dispose: disposeShard, drain, host: shard } = createNodeShardHost(options);
    const kv = createNodeShardKvStore(database);
    const directory = createNodeShardDirectory();
    const { socket: sockets } = createNodeSocketHost(database);
    const { dispose: disposeScheduler, scheduler } = createNodeSchedulerHost(database, options);

    const close = (): void => {
        // Scheduler timers first: `disposeShard` closes the connection, and a
        // job timer that fired in between would find it closed. Both are
        // guarded, but ordering makes the guard the backstop rather than the
        // mechanism.
        disposeScheduler();
        disposeShard();
    };

    return { capabilities: NODE_CAPABILITIES, close, directory, drain, kv, scheduler, shard, sockets, [Symbol.dispose]: close };
};
