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

import { LunoraError } from "@lunora/errors";
import type { PlatformCapabilities, R2BucketLike, SchedulerHost, ShardDirectory, ShardHost, ShardKvStore, SocketHost } from "@lunora/platform";
import { NODE_CAPABILITIES } from "@lunora/platform";

import type { NodeGlobalStore } from "./node-global-store";
import { createNodeGlobalStore } from "./node-global-store";
import { createNodeShardKvStore } from "./node-kv-store";
import type { NodeQueueHost, NodeQueueHostOptions } from "./node-queue-host";
import { createNodeQueueHost } from "./node-queue-host";
import { createNodeR2Bucket } from "./node-r2-bucket";
import type { NodeSchedulerHostOptions } from "./node-scheduler-host";
import { createNodeSchedulerHost } from "./node-scheduler-host";
import type { NodeShardHostOptions } from "./node-shard-host";
import { createNodeShardHost } from "./node-shard-host";
import type { NodeShardRegistryOptions } from "./node-shard-registry";
import { createNodeShardRegistry } from "./node-shard-registry";
import { createNodeSocketHost } from "./node-socket-host";
import type { NodeWorkflowHost } from "./node-workflow-host";
import { createNodeWorkflowHost } from "./node-workflow-host";
import { createNodeWorkflowStore } from "./node-workflow-store";

/** Every contract this package provides, composed for one Node process. */
export interface NodePlatform<
    Queues extends Record<string, { isLunoraQueue: true }> = Record<string, never>,
    Workflows extends Record<string, { isLunoraWorkflow: true }> = Record<string, never>,
> {
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
     *
     * **`close()` is a terminal state, not merely a cleanup step.** After it
     * runs: `scheduler.schedule()` throws instead of arming a fresh timer
     * nothing would ever clear; `scheduler.list()` returns `[]` and
     * `scheduler.cancel()` answers `false` (the job map is empty, so this
     * happens naturally, without a throw — keeping teardown-order races
     * benign); `shard.alarms.set()`/`delete()` throw before mutating any
     * in-memory state (checked against the connection's own open/closed state,
     * the single source of truth); `shard.alarms.get()` keeps answering
     * whatever it last held; `sockets.accept()`/`setTag()`/`removeTag()` throw
     * the same way, checked against the same connection state, before touching
     * any runtime socket map or durable row. A no-op instead of a throw would
     * be indistinguishable from a working call — exactly the silent-vanishing
     * this lifecycle exists to end.
     */
    close: () => void;
    /** In-process shard directory (see `createNodeShardRegistry` for what it can and cannot do). */
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

    /**
     * The `.global()` backend, or `undefined` when the caller named no database
     * file for it. Same reasoning as `objectStorage`: `globalTables` is rated
     * `emulated`, so codegen emits the whole `.global()` surface for this target
     * with no diagnostic, and a store nobody bound fails at the first global read
     * or write. There is no default path, because a global store silently rooted
     * at `:memory:` loses every row when the process exits.
     */
    globalTables?: NodeGlobalStore;

    /** Durable key-value storage backed by the same `better-sqlite3` database as `shard`. */
    kv: ShardKvStore;

    /**
     * The local-filesystem bucket, or `undefined` when the caller named no
     * bucket directory. Same reasoning as `queues`: `objectStorage` is rated
     * `emulated`, so codegen emits `ctx.storage` for this target, and a bucket
     * nobody bound fails at the first `put` with nothing upstream to warn.
     */
    objectStorage?: R2BucketLike;

    /**
     * The declared queues, or `undefined` when the caller declared none.
     *
     * Present only when `queues` is passed: with no declarations there is
     * nothing to bind, and handing back an empty host would suggest `ctx.queues`
     * works when no queue exists to send to.
     */
    queues?: NodeQueueHost<Queues>;
    /** Delayed jobs and crons, persisted to the same database and re-armed on construction. */
    scheduler: SchedulerHost;

    /** Single-writer execution, local SQL, transactions, durable alarms. */
    shard: ShardHost;
    /** Socket registry with mutable tags and SQLite-persisted attachments. */
    sockets: SocketHost;

    /**
     * The declared workflows, or `undefined` when the caller declared none.
     * Runs are persisted to the same `better-sqlite3` database as the shard, so
     * they survive a restart without a second store to configure.
     */
    workflows?: NodeWorkflowHost<Workflows>;
}

/**
 * Options for {@link createNodePlatform} — the shard host's (`path`,
 * `shardKey`, `onAlarm`), the scheduler's (`onDispatch`), and the shard
 * registry's (`directory`, `onAlarm`, `onFetch`). Both delivery hooks are
 * optional and both are what make the durable halves useful: a re-armed alarm
 * or job with nowhere to land is bookkeeping. `directory` makes the shards the
 * directory resolves for fan-out file-backed too, and `onAlarm` gives their
 * durable alarms somewhere to land.
 *
 * `queues`, `workflows`, `objectStorageDirectory` and `globalTablesPath` are the
 * four declarations: each binds its half of an `emulated` capability, and each is
 * absent from the returned platform when its declaration is omitted.
 */
export type NodePlatformOptions<
    Queues extends Record<string, { isLunoraQueue: true }> = Record<string, never>,
    Workflows extends Record<string, { isLunoraWorkflow: true }> = Record<string, never>,
> = {
    /**
     * Database file the `.global()` tables live in — its own file, never a
     * shard's, because a table every shard reads must not be inside any one of
     * them. Omit when the app declares no `.global()` table; there is no
     * default, for the same reason the bucket has none.
     */
    globalTablesPath?: string;

    /**
     * Directory the object-storage bucket keeps its objects in, one file per
     * key. Omit when the app declares no buckets — there is no default,
     * because a bucket silently rooted at the process's working directory is
     * worse than an absent one.
     */
    objectStorageDirectory?: string;

    /**
     * Deliver one assembled queue batch — wire this to `dispatchQueueBatch`.
     * Required alongside `queues`; without it the messages would be stored
     * and never consumed.
     */
    onQueueBatch?: NodeQueueHostOptions<Queues>["onBatch"];
    /** The app's `defineQueue` results, keyed by export name. Omit when the app declares no queues. */
    queues?: Queues;
    /** The app's `defineWorkflow` results, keyed by export name. Omit when the app declares no workflows. */
    workflows?: Workflows;
} & NodeSchedulerHostOptions &
    NodeShardHostOptions &
    NodeShardRegistryOptions;

/** Compose every contract this package provides over one `better-sqlite3` database. */
export const createNodePlatform = <
    Queues extends Record<string, { isLunoraQueue: true }> = Record<string, never>,
    Workflows extends Record<string, { isLunoraWorkflow: true }> = Record<string, never>,
>(
    options: NodePlatformOptions<Queues, Workflows> = {},
): NodePlatform<Queues, Workflows> => {
    const { database, dispose: disposeShard, drain, host: shard } = createNodeShardHost(options);
    const kv = createNodeShardKvStore(database);
    const registry = createNodeShardRegistry(options);
    const { directory } = registry;
    const { socket: sockets } = createNodeSocketHost(database);
    const { dispose: disposeScheduler, scheduler } = createNodeSchedulerHost(database, options);

    // Queues, workflows, object storage and global tables are all composed here
    // rather than left for a caller to assemble: `NODE_CAPABILITIES` rates all
    // four `emulated`, and codegen emits the whole `ctx.queues` / `ctx.workflows` /
    // `ctx.storage` / `.global()` surface for anything not rated `unsupported`. A
    // host that declares the capability and binds nothing is the one combination
    // that fails at runtime with no diagnostic anywhere before it — which is
    // exactly what `.global()` did while this root composed only the other three.
    const queues =
        options.queues === undefined
            ? undefined
            : createNodeQueueHost(database, {
                  onBatch:
                      options.onQueueBatch ??
                      (() => {
                          throw new LunoraError(
                              "VALIDATION_ERROR",
                              "@lunora/platform-node: createNodePlatform was given `queues` without `onQueueBatch`, so a delivered batch has nowhere to go — pass dispatchQueueBatch from @lunora/queue",
                          );
                      }),
                  queues: options.queues,
              });

    const objectStorage = options.objectStorageDirectory === undefined ? undefined : createNodeR2Bucket({ directory: options.objectStorageDirectory });

    // Its own connection and its own file: a `.global()` table is shared by every
    // shard, so keeping it inside a shard's database would make that shard's
    // lifecycle (and its single-writer gate) the global store's too.
    const globalTables = options.globalTablesPath === undefined ? undefined : createNodeGlobalStore({ path: options.globalTablesPath });

    // The shard's own connection carries the run rows, so a caller that wants
    // durable workflows does not have to configure a second store — and cannot
    // accidentally get the in-process one, which `createNodeWorkflowHost`
    // refuses to default to for exactly that reason.
    const workflows =
        options.workflows === undefined ? undefined : createNodeWorkflowHost({ store: createNodeWorkflowStore(database), workflows: options.workflows });

    const close = (): void => {
        // Scheduler timers first: `disposeShard` closes the connection, and a
        // job timer that fired in between would find it closed. Both are
        // guarded, but ordering makes the guard the backstop rather than the
        // mechanism.
        disposeScheduler();
        disposeShard();
        registry.close();
        globalTables?.dispose();
    };

    return {
        capabilities: NODE_CAPABILITIES,
        close,
        directory,
        drain,
        globalTables,
        kv,
        objectStorage,
        queues,
        scheduler,
        shard,
        sockets,
        workflows,
        [Symbol.dispose]: close,
    };
};
