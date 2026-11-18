/**
 * A worker module served on this host: the module a `wrangler.jsonc` `main`
 * points at, its default export the request handler and each Durable Object
 * class a named export, composed over one `createNodePlatform` per binding.
 *
 * This is the composition the package's tests write by hand (`createWorker`
 * over `createNodeShardNamespace(registry.directory)`, one `ShardDO` kept per
 * shard), lifted to take the app's own entry instead. `lunora dev --target
 * node` serves through it; an operator's own process can too.
 *
 * Only Durable Object bindings and the caller's `env` reach the worker. The
 * declared crons (`LUNORA_CRONS`) are armed on the shard binding's platform and
 * delivered to its shards. Queues, `.global()` tables, buckets and workflows
 * take the app's declarations rather than its wrangler config, so they are
 * left for the caller to add through `env`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { LunoraError } from "@lunora/errors";

import type { Drainable, DrainOptions, DrainResult } from "./drain-deadline";
import { drainTimeoutMs, drainTogether, settlesBefore, startDrainDeadline } from "./drain-deadline";
import type { NodeCronJob, NodePlatform } from "./node-platform";
import { createNodePlatform } from "./node-platform";
import { createNodeShardNamespace } from "./node-shard-namespace";
import type { NodeShard } from "./node-shard-registry";
import { bindShardSockets, createNodeShardState } from "./node-shard-state";

/** One `durable_objects.bindings[]` entry: the `env` key and the exported class behind it. */
interface NodeAppDurableObjectBinding {
    className: string;
    name: string;
}

/** What a Durable Object instance must answer on this host. The socket and alarm hooks are optional, as on Cloudflare. */
interface DurableObjectInstance {
    alarm?: () => Promise<void> | void;
    fetch: (request: Request) => Promise<Response> | Response;
    webSocketClose?: (socket: unknown, code: number, reason: string, wasClean: boolean) => Promise<void> | void;
    webSocketMessage?: (socket: unknown, data: ArrayBuffer | string) => Promise<void> | void;
}

type DurableObjectClass = new (state: never, env: Record<string, unknown>) => DurableObjectInstance;

/** The request handler a worker module's default export carries. */
interface WorkerHandler {
    fetch: (
        request: Request,
        env: Record<string, unknown>,
        context: { passThroughOnException: () => void; waitUntil: (promise: Promise<unknown>) => void },
    ) => Promise<Response> | Response;
}

/** Options for {@link createNodeAppHost}. */
interface NodeAppHostOptions {
    /**
     * The app's declared crons — the generated `LUNORA_CRONS` map. Armed on the {@link NodeAppHostOptions.shardBinding} platform and
     * delivered to its default shard, as `createNodePlatform`'s `crons` are. The map is the whole declared set, so a host built
     * without a job an earlier one declared deletes it.
     */
    crons?: Readonly<Record<string, ReadonlyArray<NodeCronJob>>>;

    /**
     * Directory the shard databases live in, one subdirectory per binding. Omit for in-memory shards, which lose every row when the
     * host closes.
     */
    dataDirectory?: string;
    /** The wrangler config's `durable_objects.bindings`. Each `className` must be a named export of `worker`. */
    durableObjects: ReadonlyArray<NodeAppDurableObjectBinding>;
    /** Plain values for `env`: vars, dev vars, and any binding the caller composes itself. A Durable Object binding of the same name wins. */
    env?: Record<string, unknown>;

    /** The Durable Object binding whose shards run functions, which is where crons fire. Defaults to `SHARD`. */
    shardBinding?: string;
    /** The imported worker module. */
    worker: Record<string, unknown>;
}

/** A worker module composed over this host. */
interface NodeAppHost {
    /**
     * Drain, then close: wait under one deadline (`timeoutMs`, 30 s by default) for the worker's `waitUntil` work and for every
     * platform to go idle (in-flight shard requests, alarms, cron deliveries and each shard's own `waitUntil` work), then close
     * every platform, cron timers included. The close runs whether or not the drain finished in time, so a reload never opens the
     * databases while this host still holds them. Resolves with what the drain cut off or saw fail. Safe to call more than once.
     */
    close: (options?: DrainOptions) => Promise<DrainResult>;
    /** The worker's `fetch`, bound to the composed `env`. Hand it to `createNodeHttpServer`. */
    fetch: (request: Request) => Promise<Response>;

    /**
     * Open every stored shard with a persisted alarm, so its alarm fires without waiting for a request to reach it. Call once
     * the host serves; a shard opens its database here, so a caller replacing an older host calls it after closing that one.
     */
    rearmPersistedAlarms: () => string[];
}

/** The worker's `waitUntil` work as one drainable part: failures are logged as they happen, since nothing else awaits them. */
const createWaitUntilTracker = (): Drainable & { waitUntil: (promise: Promise<unknown>) => void } => {
    const pending = new Set<Promise<void>>();
    let failures = 0;
    const takeFailures = (): string[] => {
        const failed = failures === 0 ? [] : [`${String(failures)} worker waitUntil task(s) failed`];

        failures = 0;

        return failed;
    };
    const labels = (): string[] => (pending.size === 0 ? [] : [`${String(pending.size)} worker waitUntil task(s)`]);

    return {
        drain: async (options) => {
            const deadline = startDrainDeadline(options);

            try {
                // Repeated: work handed to waitUntil can hand more work to it.
                while (pending.size > 0) {
                    // eslint-disable-next-line no-await-in-loop -- each pass waits for what the last one let start
                    if (!(await settlesBefore(Promise.all(pending), deadline))) {
                        return { failed: takeFailures(), pending: labels(), timedOut: true };
                    }
                }

                return { failed: takeFailures(), pending: [], timedOut: false };
            } finally {
                deadline.cancel();
            }
        },
        idle: () => pending.size === 0,
        pending: labels,
        waitUntil: (promise) => {
            const tracked = Promise.resolve(promise)
                .then(
                    () => undefined,
                    (error: unknown) => {
                        failures += 1;
                        // eslint-disable-next-line no-console -- nothing awaits waitUntil work, so the log is the only record of its failure
                        console.error("[@lunora/platform-node] work handed to waitUntil failed:", error);
                    },
                )
                .finally(() => pending.delete(tracked));

            pending.add(tracked);
        },
    };
};

/** Close every platform, each even when an earlier one throws, and throw the failures together. */
const closePlatforms = (platforms: ReadonlyArray<NodePlatform>): void => {
    const failures: unknown[] = [];

    for (const platform of platforms) {
        try {
            // Forced: the drain has finished or reached its deadline, so a socket close handler still running never settles,
            // and its database must not stay open under the host that replaces this one.
            platform.close({ force: true });
        } catch (error: unknown) {
            failures.push(error);
        }
    }

    if (failures.length > 0) {
        throw new AggregateError(failures, `@lunora/platform-node: ${String(failures.length)} platform(s) failed to close`);
    }
};

const isWorkerHandler = (value: unknown): value is WorkerHandler =>
    typeof value === "object" && value !== null && typeof (value as { fetch?: unknown }).fetch === "function";

/**
 * One instance per shard for the life of the host, as the runtime keeps one per object: an instance built per request loses its
 * in-memory subscribers between a subscribe and the write that should reach them.
 */
const createInstanceFactory = (DurableObject: DurableObjectClass, env: Record<string, unknown>): ((shard: NodeShard) => DurableObjectInstance) => {
    const instances = new WeakMap<NodeShard, DurableObjectInstance>();

    return (shard) => {
        const existing = instances.get(shard);

        if (existing !== undefined) {
            return existing;
        }

        const instance = new DurableObject(createNodeShardState(shard) as never, env);

        instances.set(shard, instance);

        // Either hook alone is a valid Durable Object, as on Cloudflare; the missing one is a no-op.
        if (instance.webSocketClose !== undefined || instance.webSocketMessage !== undefined) {
            bindShardSockets(
                {
                    webSocketClose: async (socket, code, reason, wasClean) => instance.webSocketClose?.(socket, code, reason, wasClean),
                    webSocketMessage: async (socket, data) => instance.webSocketMessage?.(socket, data),
                },
                shard.inbound,
            );
        }

        return instance;
    };
};

/** The platform behind one Durable Object binding: its class, one instance per shard, and the crons when it is the shard binding. */
const createBindingPlatform = (
    binding: NodeAppDurableObjectBinding,
    options: NodeAppHostOptions,
    env: Record<string, unknown>,
    shardBinding: string,
): NodePlatform => {
    const DurableObject = options.worker[binding.className];

    if (typeof DurableObject !== "function") {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/platform-node: Durable Object binding ${binding.name} names class ${binding.className}, which the worker module does not export`,
        );
    }

    const instanceFor = createInstanceFactory(DurableObject as DurableObjectClass, env);

    // The shard databases sit in the binding's directory; the platform's own database (scheduler and cron rows) sits beside it,
    // never inside, where the registry would read it back as a shard.
    return createNodePlatform({
        crons: binding.name === shardBinding ? options.crons : undefined,
        directory: options.dataDirectory === undefined ? undefined : join(options.dataDirectory, binding.name),
        // The registry passes the shard whose alarm came due. The platform's own database has no app alarm, so a call without one
        // is not an app event.
        onAlarm: async (shard?: NodeShard) => {
            if (shard !== undefined) {
                await instanceFor(shard).alarm?.();
            }
        },
        onFetch: async (request, shard) => instanceFor(shard).fetch(request),
        path: options.dataDirectory === undefined ? undefined : join(options.dataDirectory, `${binding.name}.platform.sqlite3`),
    });
};

/** Compose `worker` over one in-process platform per Durable Object binding. */
const createNodeAppHost = (options: NodeAppHostOptions): NodeAppHost => {
    const handler = options.worker["default"];

    if (!isWorkerHandler(handler)) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: the worker module has no default export with a `fetch` handler");
    }

    const env: Record<string, unknown> = { ...options.env };
    const platforms: NodePlatform[] = [];
    const tracker = createWaitUntilTracker();
    const shardBinding = options.shardBinding ?? "SHARD";
    const declaresCrons = Object.values(options.crons ?? {}).some((jobs) => jobs.length > 0);

    if (declaresCrons && !options.durableObjects.some((binding) => binding.name === shardBinding)) {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/platform-node: the app declares crons, but no Durable Object binding is named ${shardBinding} to run them on`,
        );
    }

    // Each binding's platform database is a file directly in it, opened before anything else would create the directory.
    if (options.dataDirectory !== undefined) {
        mkdirSync(options.dataDirectory, { recursive: true });
    }

    // A binding that cannot be composed (a missing class, a cron this host refuses) throws with earlier platforms already open and
    // their cron timers armed; nothing returned could close them, so they are closed here.
    try {
        for (const binding of options.durableObjects) {
            const platform = createBindingPlatform(binding, options, env, shardBinding);

            platforms.push(platform);
            env[binding.name] = createNodeShardNamespace(platform.directory);
        }
    } catch (error: unknown) {
        try {
            closePlatforms(platforms.splice(0));
        } catch (closeError: unknown) {
            // The composition error is the one to report; a close failing behind it is logged so it is not lost.
            // eslint-disable-next-line no-console -- the caller only receives the composition error
            console.error("[@lunora/platform-node] closing the platforms of a host that failed to compose failed:", closeError);
        }

        throw error;
    }

    const context = { passThroughOnException: () => undefined, waitUntil: tracker.waitUntil };
    let closing: Promise<DrainResult> | undefined;

    return {
        close: async (closeOptions) => {
            // Checked before anything changes, so a bad value throws with the host still open.
            drainTimeoutMs(closeOptions);

            closing ??= (async () => {
                try {
                    return await drainTogether([tracker, ...platforms], closeOptions);
                } finally {
                    closePlatforms(platforms.splice(0));
                }
            })();

            return closing;
        },
        fetch: async (request) => handler.fetch(request, env, context),
        rearmPersistedAlarms: () => platforms.flatMap((platform) => platform.rearmPersistedAlarms()),
    };
};

export type { NodeAppDurableObjectBinding, NodeAppHost, NodeAppHostOptions };
export { createNodeAppHost };
