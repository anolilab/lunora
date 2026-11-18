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
import Database from "better-sqlite3";

import { AGENT_RUN_OFF_DEFAULT_SHARD_MESSAGE, isAgentRunOffDefaultShard } from "../../../shared/scheduler-dispatch";
import type { Drainable, DrainOptions, DrainResult } from "./drain-deadline";
import { drainTimeoutMs, drainTogether, settlesBefore, startDrainDeadline } from "./drain-deadline";
import { createNodeDispatchRoute, createShardInvoke } from "./node-dispatch-route";
import type { NodeGlobalStore } from "./node-global-store";
import { createNodeGlobalStore } from "./node-global-store";
import { createNodeShardKvStore } from "./node-kv-store";
import type { NodeMailHost, NodeMailHostOptions } from "./node-mail-host";
import { createNodeMailHost } from "./node-mail-host";
import type { NodeQueueHost, NodeQueueHostOptions } from "./node-queue-host";
import { createNodeQueueHost } from "./node-queue-host";
import { createNodeR2Bucket } from "./node-r2-bucket";
import type { NodeDeclaredCron, NodeSchedulerHostOptions } from "./node-scheduler-host";
import { createNodeSchedulerHost } from "./node-scheduler-host";
import type { NodeShardHostOptions } from "./node-shard-host";
import { createNodeShardHost } from "./node-shard-host";
import type { NodeShardRegistryOptions } from "./node-shard-registry";
import { createNodeShardRegistry } from "./node-shard-registry";
import { createNodeSocketHost } from "./node-socket-host";
import type { NodeWorkflowHost } from "./node-workflow-host";
import { createNodeWorkflowHost } from "./node-workflow-host";
import { createNodeWorkflowStore } from "./node-workflow-store";

/** The shard a request or job without a `shardKey` runs on; the dispatch route and the due-job delivery both default to it. */
const DEFAULT_SHARD_KEY = "__root__";

/**
 * Flatten the generated `LUNORA_CRONS` map into the declared set the scheduler
 * host arms. A workflow-targeted job is refused rather than skipped: nothing on
 * this host starts a workflow instance from a tick, and a skipped job would be a
 * declared cron that never fires. Codegen refuses it for this target
 * (`cronWorkflowTriggers`); this throw is the backstop for an embedder that
 * built without that gate.
 */
const walkDeclaredCrons = (crons: Readonly<Record<string, ReadonlyArray<NodeCronJob>>>): NodeDeclaredCron[] =>
    Object.entries(crons).flatMap(([expression, jobs]) =>
        jobs.map((job) => {
            if (job.functionPath === undefined) {
                throw new LunoraError(
                    "VALIDATION_ERROR",
                    job.workflow === undefined
                        ? `@lunora/platform-node: cron job "${job.name}" has neither a function target nor a workflow target`
                        : `@lunora/platform-node: cron job "${job.name}" starts workflow "${job.workflow}", which this host cannot do from a cron tick — schedule a function that calls ctx.workflows.get(name).create() instead`,
                );
            }

            return { args: job.args ?? {}, expression, functionPath: job.functionPath, name: job.name };
        }),
    );

/**
 * Walk the declared crons, refusing a non-empty set nothing can deliver: without `onFetch` or
 * `onDispatch` the scheduler's delivery is a no-op, so every tick would complete having run nothing.
 */
const deliverableCrons = (crons: Readonly<Record<string, ReadonlyArray<NodeCronJob>>>, canDeliver: boolean): NodeDeclaredCron[] => {
    const declared = walkDeclaredCrons(crons);

    if (declared.length > 0 && !canDeliver) {
        throw new LunoraError(
            "VALIDATION_ERROR",
            "@lunora/platform-node: `crons` declares jobs but nothing can deliver them — pass `onFetch` (to run them on the shard) or `onDispatch`",
        );
    }

    return declared;
};

/**
 * The mail host, on its own connection to its own file. Never the shard's:
 * `shard.transaction()` holds a raw `BEGIN` on that connection across awaits, so
 * a poll running meanwhile would claim, record and ack inside it, and the shard's
 * rollback would undo the ack and the sent record and mail the message again. A
 * second connection to the shard's file is not enough either: the open `BEGIN`
 * holds the file's write lock, so every mail write would wait out the busy
 * timeout on a blocked event loop. The `.global()` store is split off the same way.
 */
const composeMail = (options: NodePlatformMailOptions | undefined): { close: () => void; mail: NodeMailHost } | undefined => {
    if (options === undefined) {
        return undefined;
    }

    const { path, ...hostOptions } = options;
    const database = new Database(path);

    try {
        return {
            close: () => {
                database.close();
            },
            mail: createNodeMailHost(database, hostOptions),
        };
    } catch (error) {
        database.close();

        throw error;
    }
};

/**
 * Deliver a due job to the shard through `invoke`, carrying its due time so the shard can record
 * scheduler lag. A non-2xx marks the delivery failed, which re-arms it with backoff.
 */
export const createJobDelivery =
    (invoke: ReturnType<typeof createShardInvoke>, shardKey: string): NonNullable<NodeSchedulerHostOptions["onDispatch"]> =>
    async (functionPath, args, job) => {
        // The route refuses an agent run off the default shard; a due job reaches the shard directly, so the same check applies here.
        if (isAgentRunOffDefaultShard(functionPath, shardKey, DEFAULT_SHARD_KEY)) {
            throw new LunoraError("BAD_REQUEST", AGENT_RUN_OFF_DEFAULT_SHARD_MESSAGE);
        }

        const response = await invoke({
            args,
            functionPath,
            id: job.id,
            identity: undefined,
            scheduledFor: job.scheduledFor,
            shardKey,
            traceparent: undefined,
        });

        if (!response.ok) {
            throw new LunoraError(
                "SERVICE_UNAVAILABLE",
                `@lunora/platform-node: scheduled job ${functionPath} was refused with status ${String(response.status)}`,
            );
        }
    };

/** One entry of the generated `LUNORA_CRONS` map (`_generated/crons.ts`). */
export interface NodeCronJob {
    args?: Record<string, unknown>;
    functionPath?: string;
    name: string;
    workflow?: string;
}

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
     * Tear this platform instance down: every resource this root built, in
     * reverse construction order — the global store's own connection, every
     * armed scheduler job timer, the registry's live shards, and last the shard
     * host's pending alarm timer and its `better-sqlite3` database (and, with
     * it, `kv`'s table — both live on the same connection). Nothing in this
     * package closes these resources on its own — a `NodePlatform` a caller
     * stops using without calling `close()` leaks the open file handles (plus
     * their WAL/SHM sidecar files) and keeps the process alive on outstanding
     * timers. Safe to call more than once. A `createNodePlatform` that throws
     * unwinds the same list itself, so a failed construction leaks nothing and
     * leaves nothing to call this on.
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
     *
     * `force` is for a shutdown whose drain has finished or reached its deadline:
     * a shard whose socket close handler is still running is disposed now (and
     * logged) instead of once the handler settles. See `NodeShardRegistry.close`.
     */
    close: (options?: { force?: boolean }) => void;
    /** In-process shard directory (see `createNodeShardRegistry` for what it can and cannot do). */
    directory: ShardDirectory;

    /**
     * The scheduler dispatch route, served in-process: `Request` in, shard
     * response out, no listener. It answers the path `@lunora/dispatch` and
     * `@lunora/scheduler` POST to. Pass it to `dispatchQueueBatch` as
     * `queueFetchImpl` on `createWorker` so a queue handler's `message.run` /
     * `ctx.run` reaches the shard; the env you pass there must carry `LUNORA_ORIGIN_URL` and the same
     * `LUNORA_ADMIN_TOKEN` as `dispatch.adminToken`. Every request is refused
     * unless `dispatch` supplies a secret.
     */
    dispatch: (request: Request) => Promise<Response>;

    /**
     * Wait for every promise handed to `shard.waitUntil` to settle, for every
     * `mail.poll()` in flight, and for the registry's shards to go idle
     * (`NodeShardRegistry.drain`): in-flight `onFetch` and `onAlarm` calls,
     * including cron and scheduled-job deliveries, and each shard's own
     * `waitUntil` work.
     *
     * Separate from `close()` because the two answer different questions:
     * `close()` releases handles and stays synchronous (it backs
     * `Symbol.dispose`), while draining is inherently awaitable. A graceful
     * shutdown is `await platform.drain()` then `platform.close()`. Bounded by
     * `timeoutMs` (30 s by default); resolves with what was still running when
     * it passed.
     *
     * Draining is the start of shutdown: it first stops the scheduler's job and
     * cron timers and every alarm timer, so nothing new starts once the drain
     * has found the platform idle. Their rows are kept and re-armed after a
     * restart.
     */
    drain: (options?: DrainOptions) => Promise<DrainResult>;

    /**
     * The `.global()` backend, or `undefined` when the caller named no database
     * file for it. There is no default path, because a global store silently
     * rooted at `:memory:` loses every row when the process exits.
     *
     * **A building block, not a wiring.** Unlike its three siblings, nothing
     * downstream of this composition root reads it: a `.global()` read or write
     * reaches its backend through exactly one seam, `createShardCtxDb({ globalDb
     * })`, and the only thing that passes `globalDb` is the generated `shard.ts`,
     * from its `d1` / `hyperdriveGlobal` config thunks. `createNodePlatform`
     * constructs no shard DO, so it cannot make that hop itself. A caller that
     * wants `.global()` on this host makes it: after `migrate(schema)` has
     * provisioned the tables, give the generated `createShardDO` a `d1` thunk
     * returning `platform.globalTables.writer({ schema, … })` — `writer` builds
     * the `createSqlCtxDb` facade that seam expects, and `node-platform.test.ts`
     * round-trips a row through exactly that object.
     */
    globalTables?: NodeGlobalStore;

    /**
     * Whether nothing a {@link NodePlatform.drain} would wait for is running right now. Synchronous, so a caller draining
     * several platforms or registries together can confirm they are all idle at one instant.
     */
    idle: () => boolean;

    /** Durable key-value storage backed by the same `better-sqlite3` database as `shard`. */
    kv: ShardKvStore;

    /**
     * Queued mail delivery, or `undefined` when the caller passed no `mail`.
     * Its queue lives in the shard's database beside the app's own queues.
     */
    mail?: NodeMailHost;

    /** The local-filesystem bucket, or `undefined` when the caller named no bucket directory. */
    objectStorage?: R2BucketLike;

    /** What is running right now (host work, scheduler deliveries, each shard's work), as a timed-out drain would report it. */
    pending: () => string[];

    /**
     * The declared queues, or `undefined` when the caller declared none.
     *
     * Present only when `queues` is passed: with no declarations there is
     * nothing to bind, and handing back an empty host would suggest `ctx.queues`
     * works when no queue exists to send to.
     */
    queues?: NodeQueueHost<Queues>;

    /** Open every stored shard with a persisted alarm, so it is re-armed before traffic arrives. See `NodeShardRegistry.rearmPersistedAlarms`. */
    rearmPersistedAlarms: () => string[];
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
 * `createNodePlatform`'s `mail` option: the {@link NodeMailHostOptions} plus the
 * database file the mail host keeps its queue, sent ledger and key records in.
 *
 * Its own file, never the shard's, and there is no default: a shard transaction
 * holds the shard file across awaits, and mail written inside it would be rolled
 * back with it (see `composeMail`). The same reason `globalTablesPath` has none.
 */
export type NodePlatformMailOptions = NodeMailHostOptions & {
    /** The mail database file, for example `./.lunora/mail.sqlite3`. */
    path: string;
};

/**
 * The secrets the dispatch route authenticates with. With neither, the route
 * refuses everything.
 *
 * Queue and topic delivery authenticates with `adminToken` alone:
 * `@lunora/dispatch` always sends `Bearer <LUNORA_ADMIN_TOKEN>` and never signs,
 * so the value here must match the token the caller puts on the env it passes
 * `dispatchQueueBatch`. `schedulerSecret` only verifies a signed body, which the
 * scheduler's own delivery sends; queue delivery never does.
 */
export interface NodePlatformDispatchOptions {
    /** `LUNORA_ADMIN_TOKEN`. The bearer queue and topic delivery sends, so it must match the caller's env. */
    adminToken?: string;
    /** `LUNORA_SCHEDULER_SECRET`. When set, a signed body is verified against it. Queue delivery does not sign. */
    schedulerSecret?: string;
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
 * four declarations — each is absent from the returned platform when omitted.
 */
export type NodePlatformOptions<
    Queues extends Record<string, { isLunoraQueue: true }> = Record<string, never>,
    Workflows extends Record<string, { isLunoraWorkflow: true }> = Record<string, never>,
> = {
    /**
     * The app's declared crons — pass the generated `LUNORA_CRONS` map
     * (`_generated/crons.ts`). Each job is armed on the scheduler and delivered
     * through the same `onDispatch` a scheduled job uses, so it needs `onFetch`
     * (or your own `onDispatch`) to reach a shard; a non-empty map with neither
     * throws. Job names must be unique, every schedule must have a next
     * occurrence, and schedules are read as UTC. The map is the whole declared
     * set: a job declared by an earlier run and absent here is deleted. Omit
     * the option and this process neither fires nor deletes declared jobs, so
     * a script opening the same file leaves a running server's crons alone.
     * Crons registered through `scheduler.cron()` are re-armed either way.
     */
    crons?: Readonly<Record<string, ReadonlyArray<NodeCronJob>>>;

    /** Secrets for the dispatch route. Omit to leave the route refusing every request. */
    dispatch?: NodePlatformDispatchOptions;

    /**
     * Database file the `.global()` tables live in — its own file, never a
     * shard's, because a table every shard reads must not be inside any one of
     * them. Omit when the app declares no `.global()` table; there is no
     * default, for the same reason the bucket has none.
     */
    globalTablesPath?: string;

    /**
     * Deliver `@lunora/mail` sends: a durable `lunora-mail` queue drained
     * through the given `transport` or, without one, Resend (`RESEND_API_KEY`), exposed as
     * `platform.mail`. Its queue, sent ledger and key records live in `path`, a
     * database file of their own (see {@link NodePlatformMailOptions}). Omit when
     * the app sends no mail. Throws here, not on the first send, when `MAIL_FROM`
     * is unset or nothing can deliver.
     */
    mail?: NodePlatformMailOptions;

    /**
     * Directory the object-storage bucket keeps its objects in, one file per
     * key. Omit when the app declares no buckets — there is no default,
     * because a bucket silently rooted at the process's working directory is
     * worse than an absent one.
     */
    objectStorageDirectory?: string;

    /**
     * Deliver one assembled queue batch — wire this to the app worker's `queue`
     * export from `createWorker`, not to bare `dispatchQueueBatch`. That export
     * is the only path that hands the consumer `ctx.live`, and it takes
     * `queueFetchImpl` (this platform's `dispatch`, wrapped as a `fetch`) so
     * `ctx.run` reaches the shard here rather than `LUNORA_ORIGIN_URL`. Required
     * alongside `queues`; without it the messages would be stored and never consumed.
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
    // Every resource that has to be torn down, in the order it was built, as a
    // thunk: the three teardowns are not one shape — a bare `dispose()`, a
    // `close()` method, a `dispose()` method — and holding them here is what lets
    // both the failure path below and `close()` unwind the same list, so a fifth
    // resource cannot be added to one and forgotten in the other.
    const teardown: ((closeOptions?: { force?: boolean }) => void)[] = [];

    const {
        database,
        dispose: disposeShard,
        drain,
        host: shard,
        pendingAlarms,
        pendingBackground,
        suspendAlarms: suspendHostAlarms,
        takeFailures,
    } = createNodeShardHost(options);

    teardown.push(disposeShard);

    try {
        const kv = createNodeShardKvStore(database);
        const registry = createNodeShardRegistry(options);

        teardown.push((closeOptions) => {
            registry.close(closeOptions);
        });

        const { directory } = registry;

        // In-process: the route's `invoke` reaches the shard through the same
        // directory the fan-out coordinator uses, so no listener is involved.
        const invoke = createShardInvoke(directory, options.onFetch !== undefined);
        const dispatch = createNodeDispatchRoute({
            adminToken: options.dispatch?.adminToken,
            defaultShardKey: "__root__",
            invoke,
            schedulerSecret: options.dispatch?.schedulerSecret,
        });

        // A due job reaches the shard through the same `invoke` the route uses, carrying its due
        // time so the shard can record scheduler lag. An embedder's own `onDispatch` replaces this
        // outright, so a job is never delivered twice. Without `onFetch` there is no shard handler
        // to run it, and the host keeps its old behaviour of completing the delivery.
        const deliverJob = options.onFetch === undefined ? undefined : createJobDelivery(invoke, options.shardKey ?? "__root__");
        const {
            declareCrons,
            dispose: disposeScheduler,
            pendingDispatches,
            scheduler,
            suspend: suspendScheduler,
        } = createNodeSchedulerHost(database, { ...options, onDispatch: options.onDispatch ?? deliverJob });
        const { socket: sockets } = createNodeSocketHost(database);

        teardown.push(disposeScheduler);

        // Only a process that passes `crons` manages the declared set. One that omits
        // it neither arms nor deletes declared rows, so an admin script opening the
        // same file cannot switch off a running server's crons.
        if (options.crons !== undefined) {
            declareCrons(deliverableCrons(options.crons, options.onDispatch !== undefined || options.onFetch !== undefined));
        }

        // Queues, workflows, object storage and global tables are all composed here
        // rather than left for a caller to assemble: `NODE_CAPABILITIES` rates all
        // four `emulated`, and codegen emits the whole `ctx.queues` / `ctx.workflows` /
        // `ctx.storage` / `.global()` surface for anything not rated `unsupported`. A
        // host that declares the capability and binds nothing is the one combination
        // that fails at runtime with no diagnostic anywhere before it — which is
        // exactly what `.global()` did while this root composed only the other three.
        // Composing it is half the job: see `NodePlatform.globalTables` for the hop
        // only a caller can make, because nothing here builds a shard DO to make it.
        const queues =
            options.queues === undefined
                ? undefined
                : createNodeQueueHost(database, {
                      onBatch:
                          options.onQueueBatch ??
                          (() => {
                              throw new LunoraError(
                                  "VALIDATION_ERROR",
                                  "@lunora/platform-node: createNodePlatform was given `queues` without `onQueueBatch`, so a delivered batch has nowhere to go — pass the worker's queue export from createWorker",
                              );
                          }),
                      queues: options.queues,
                  });

        const composedMail = composeMail(options.mail);

        if (composedMail !== undefined) {
            teardown.push(composedMail.close);
        }

        const mail = composedMail?.mail;

        const objectStorage = options.objectStorageDirectory === undefined ? undefined : createNodeR2Bucket({ directory: options.objectStorageDirectory });

        // Its own connection and its own file: a `.global()` table is shared by every
        // shard, so keeping it inside a shard's database would make that shard's
        // lifecycle (and its single-writer gate) the global store's too.
        const globalTables = options.globalTablesPath === undefined ? undefined : createNodeGlobalStore({ path: options.globalTablesPath });

        if (globalTables !== undefined) {
            teardown.push(() => {
                globalTables.dispose();
            });
        }

        // The shard's own connection carries the run rows, so a caller that wants
        // durable workflows does not have to configure a second store — and cannot
        // accidentally get the in-process one, which `createNodeWorkflowHost`
        // refuses to default to for exactly that reason.
        const workflows =
            options.workflows === undefined ? undefined : createNodeWorkflowHost({ store: createNodeWorkflowStore(database), workflows: options.workflows });

        const close = (closeOptions?: { force?: boolean }): void => {
            // Reverse construction order, which puts the scheduler's timers ahead of
            // the connection they would fire against: `disposeShard` closes it, and a
            // job timer that fired in between would find it closed. Every teardown is
            // guarded on its own, so ordering makes the guard the backstop rather than
            // the mechanism. The copy keeps `close()` callable more than once.
            // Each teardown runs even when an earlier one throws, so one failing resource cannot leave the rest open; the
            // failures are thrown together once all of them have been tried.
            const failures: unknown[] = [];

            for (const undo of teardown.toReversed()) {
                try {
                    undo(closeOptions);
                } catch (error: unknown) {
                    failures.push(error);
                }
            }

            if (failures.length > 0) {
                throw new AggregateError(failures, `@lunora/platform-node: ${String(failures.length)} resource(s) failed to close`);
            }
        };

        const hostPending = (): string[] => [
            ...(pendingBackground() > 0 || pendingAlarms() > 0 ? ["waitUntil work on the platform host"] : []),
            ...pendingDispatches().labels,
        ];

        // The platform's own work as one drainable part: host waitUntil work and alarm deliveries, and scheduler deliveries (a
        // custom onDispatch, a cron tick), which write to the database the drain protects.
        const host: Drainable = {
            drain: async (drainOptions) => {
                const deadline = startDrainDeadline(drainOptions);

                try {
                    const [hostSettled, dispatchesSettled] = await Promise.all([
                        settlesBefore(drain(), deadline),
                        settlesBefore(Promise.allSettled(pendingDispatches().waits), deadline),
                    ]);

                    if (hostSettled && dispatchesSettled) {
                        return { failed: takeFailures(), pending: [], timedOut: false };
                    }

                    const pending = hostPending();

                    // eslint-disable-next-line no-console -- the drain gives up on this work, so the log is the only record of it
                    console.error("[@lunora/platform-node] platform drain deadline passed with work still running: %s", pending.join(", "));

                    return { failed: takeFailures(), pending, timedOut: true };
                } finally {
                    deadline.cancel();
                }
            },
            idle: () => pendingBackground() === 0 && pendingAlarms() === 0 && pendingDispatches().waits.length === 0,
            pending: hostPending,
        };

        return {
            capabilities: NODE_CAPABILITIES,
            close,
            directory,
            dispatch: (request) => dispatch(request),
            idle: () => host.idle() && registry.idle(),
            pending: () => [...host.pending(), ...registry.pending()],
            // The registry's shards are where the app's requests, alarms and cron deliveries run, so a drain that skipped them
            // would let `close()` dispose a database a handler is still writing. Host work can start shard work after the
            // registry drained (a due job's delivery), which drainTogether's passes, failures and pending re-read account for.
            //
            // Timers are stopped first, before the first pass: a job, cron tick or alarm that fired after the drain found
            // everything idle would run into the forced close. Their rows stay, so each fires after a restart.
            drain: async (drainOptions?: DrainOptions): Promise<DrainResult> => {
                // Checked before anything is stopped: a refused timeout must leave jobs, crons and alarms running.
                drainTimeoutMs(drainOptions);
                suspendScheduler();
                suspendHostAlarms();
                registry.suspendAlarms();

                // Mail first: a poll in flight settles its rows through the database `close()` shuts.
                await mail?.drain();

                return drainTogether([host, registry], drainOptions);
            },
            globalTables,
            kv,
            mail,
            objectStorage,
            rearmPersistedAlarms: () => registry.rearmPersistedAlarms(),
            queues,
            scheduler,
            shard,
            sockets,
            workflows,
            [Symbol.dispose]: () => {
                close();
            },
        };
    } catch (error) {
        // Roll back what was already built. Nothing else can reach these — the
        // throw escapes before any platform object exists to call `close()` on,
        // so the shard's sqlite handle (and its WAL sidecars), the registry's
        // live shards and the scheduler's armed timers would leak for the life
        // of the process. A teardown that throws on the way out is swallowed:
        // the construction error is the one the caller needs to see.
        for (const undo of teardown.toReversed()) {
            try {
                undo();
            } catch {
                // Nothing useful to do with it, and rethrowing would hide `error`.
            }
        }

        throw error;
    }
};
