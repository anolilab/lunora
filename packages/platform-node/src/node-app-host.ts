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

import type { Stats } from "node:fs";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { LunoraError } from "@lunora/errors";

import type { Drainable, DrainOptions, DrainResult } from "./drain-deadline";
import { drainTimeoutMs, drainTogether, settlesBefore, startDrainDeadline } from "./drain-deadline";
import type { NodeDurableObjectClass } from "./node-durable-object";
import { createNodeDurableObjectFactory } from "./node-durable-object";
import type { NodeCronJob, NodePlatform } from "./node-platform";
import { createNodePlatform, walkDeclaredCrons } from "./node-platform";
import { createNodeShardNamespace } from "./node-shard-namespace";
import type { NodeShard } from "./node-shard-registry";

/** One `durable_objects.bindings[]` entry: the `env` key and the exported class behind it. */
interface NodeAppDurableObjectBinding {
    className: string;
    name: string;
}

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
     * Drain, then close: wait under one deadline (`timeoutMs`, 30 s by default) for the requests `fetch` is still answering, the
     * worker's `waitUntil` work, and every
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

/**
 * Work the host waits for on close, as one drainable part. `waitUntil` work is the worker's own background work: nothing awaits
 * it, so a failure is logged and counted. A request is awaited by its caller, who sees its failure, so only its being in
 * flight counts.
 */
const createWorkTracker = (options: { label: string; reportFailures: boolean }): Drainable & { track: (promise: Promise<unknown>) => void } => {
    const pending = new Set<Promise<void>>();
    let failures = 0;
    const takeFailures = (): string[] => {
        const failed = failures === 0 ? [] : [`${String(failures)} ${options.label} failed`];

        failures = 0;

        return failed;
    };
    const labels = (): string[] => (pending.size === 0 ? [] : [`${String(pending.size)} ${options.label}`]);

    return {
        drain: async (drainOptions) => {
            const deadline = startDrainDeadline(drainOptions);

            try {
                // Repeated: tracked work can start more of it.
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
        track: (promise) => {
            const tracked = Promise.resolve(promise)
                .then(
                    () => undefined,
                    (error: unknown) => {
                        if (options.reportFailures) {
                            failures += 1;
                            // eslint-disable-next-line no-console -- nothing awaits waitUntil work, so the log is the only record of its failure
                            console.error("[@lunora/platform-node] work handed to waitUntil failed:", error);
                        }
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

/** The platform behind one Durable Object binding: its class, one instance per shard, and the crons when it is the shard binding. */
const createBindingPlatform = (
    binding: NodeAppDurableObjectBinding,
    options: NodeAppHostOptions,
    env: Record<string, unknown>,
    shardBinding: string,
): NodePlatform => {
    // Checked by `checkNodeAppHost` before any binding is built.
    const instanceFor = createNodeDurableObjectFactory(options.worker[binding.className] as NodeDurableObjectClass, env);

    // The shard databases sit in the binding's directory; the platform's own database (scheduler and cron rows) sits beside it,
    // never inside, where the registry would read it back as a shard.
    return createNodePlatform({
        // The map is the whole declared set, so an omitted one declares none and deletes what an earlier host declared. Other
        // bindings pass `undefined`, which leaves the declared rows alone.
        crons: binding.name === shardBinding ? (options.crons ?? {}) : undefined,
        directory: options.dataDirectory === undefined ? undefined : join(options.dataDirectory, binding.name),
        // The registry passes the shard whose alarm came due. The platform's own database has no app alarm, so a call without one
        // is not an app event.
        onAlarm: async (shard?: NodeShard) => {
            if (shard !== undefined) {
                const instance = await instanceFor(shard);

                await instance.alarm?.();
            }
        },
        onFetch: async (request, shard) => {
            const instance = await instanceFor(shard);

            return instance.fetch(request);
        },
        path: options.dataDirectory === undefined ? undefined : join(options.dataDirectory, `${binding.name}.platform.sqlite3`),
    });
};

/**
 * Wrangler's rule for a binding name, a JavaScript identifier. A binding's name is also a directory and a file name under
 * `dataDirectory`, so anything else (`..`, `a/b`) could open storage outside it.
 */
const BINDING_NAME = /^[A-Za-z_$][\w$]*$/u;

/** Whether `path` lies strictly inside `directory`, compared by path segment rather than by prefix. */
const isInside = (directory: string, path: string): boolean => {
    const fromDirectory = relative(directory, path);

    return fromDirectory !== "" && !fromDirectory.startsWith("..") && !isAbsolute(fromDirectory);
};

/**
 * Refuse a binding whose storage would land outside `dataDirectory`: a name that is not an identifier, or a shard directory or
 * platform database that already exists as a link out of it. Checked through `realpathSync`, since `join` does not follow links.
 */
const checkBindingStorage = (name: string, dataDirectory: string | undefined): void => {
    if (!BINDING_NAME.test(name)) {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/platform-node: Durable Object binding ${JSON.stringify(name)} is not a valid binding name (a JavaScript identifier such as SHARD), and its name becomes a directory under the data directory`,
        );
    }

    if (dataDirectory === undefined || !existsSync(dataDirectory)) {
        return;
    }

    const root = realpathSync(dataDirectory);

    for (const path of [join(dataDirectory, name), join(dataDirectory, `${name}.platform.sqlite3`)]) {
        let entry: Stats | undefined;

        try {
            entry = lstatSync(path);
        } catch {
            continue;
        }

        // A link to nothing passes `existsSync`, yet SQLite follows it and creates the database wherever it points.
        if (entry.isSymbolicLink() && !existsSync(path)) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/platform-node: Durable Object binding ${name} would store data outside ${dataDirectory}: ${path} is a link to nothing, which SQLite would follow`,
            );
        }

        if (!isInside(root, realpathSync(path))) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/platform-node: Durable Object binding ${name} would store data outside ${dataDirectory}: ${path} links out of it`,
            );
        }
    }
};

/**
 * Refuse two bindings whose storage could be one: the same name twice, or names that differ only in case, which a
 * case-insensitive volume (the default on macOS and Windows, and a data directory can move to one) maps to one shard directory
 * and one platform database, so two classes would read and write each other's state.
 */
const checkDistinctStorage = (bindings: ReadonlyArray<NodeAppDurableObjectBinding>): void => {
    const seen = new Map<string, string>();

    for (const { name } of bindings) {
        const earlier = seen.get(name.toLowerCase());

        if (earlier !== undefined) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                earlier === name
                    ? `@lunora/platform-node: Durable Object binding ${name} is declared twice, and both would share one shard directory and platform database`
                    : `@lunora/platform-node: Durable Object bindings ${earlier} and ${name} differ only in case, so on a case-insensitive volume they would share one shard directory and platform database — rename one`,
            );
        }

        seen.set(name.toLowerCase(), name);
    }
};

/** Whether `value` can be called with `new`, checked without calling it: `Reflect.construct` refuses a non-constructor target first. */
const isConstructor = (value: unknown): boolean => {
    if (typeof value !== "function") {
        return false;
    }

    try {
        Reflect.construct(String, [], value);

        return true;
    } catch {
        return false;
    }
};

/**
 * Throw what `createNodeAppHost` would refuse for `options`, without opening a database or arming a timer: the default export,
 * every binding's name and class, and the declared crons. `createNodeAppHost` runs it before building anything, so a refused composition
 * changes no stored state (cron rows included); a caller replacing a running host runs it first, so a refused candidate leaves
 * that host serving.
 */
const checkNodeAppHost = (options: NodeAppHostOptions): void => {
    if (!isWorkerHandler(options.worker["default"])) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: the worker module has no default export with a `fetch` handler");
    }

    checkDistinctStorage(options.durableObjects);

    for (const binding of options.durableObjects) {
        checkBindingStorage(binding.name, options.dataDirectory);

        // An own export only: `constructor` and the rest of `Object.prototype` are on every module record.
        const exported = Object.hasOwn(options.worker, binding.className) ? options.worker[binding.className] : undefined;

        if (exported === undefined) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/platform-node: Durable Object binding ${binding.name} names class ${binding.className}, which the worker module does not export`,
            );
        }

        if (!isConstructor(exported)) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/platform-node: Durable Object binding ${binding.name} names ${binding.className}, which the worker module exports as something \`new\` cannot construct`,
            );
        }
    }

    const shardBinding = options.shardBinding ?? "SHARD";
    const declared = walkDeclaredCrons(options.crons ?? {});

    if (declared.length > 0 && !options.durableObjects.some((binding) => binding.name === shardBinding)) {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/platform-node: the app declares crons, but no Durable Object binding is named ${shardBinding} to run them on`,
        );
    }
};

/** Compose `worker` over one in-process platform per Durable Object binding. */
const createNodeAppHost = (options: NodeAppHostOptions): NodeAppHost => {
    checkNodeAppHost(options);

    const handler = options.worker["default"] as WorkerHandler;
    const env: Record<string, unknown> = { ...options.env };
    const platforms: NodePlatform[] = [];
    const tracker = createWorkTracker({ label: "worker waitUntil task(s)", reportFailures: true });
    // A request a caller is still waiting on: the drain finishes it before the shards it may still reach are closed.
    const requests = createWorkTracker({ label: "worker request(s)", reportFailures: false });
    const shardBinding = options.shardBinding ?? "SHARD";

    // Each binding's platform database is a file directly in it, opened before anything else would create the directory.
    if (options.dataDirectory !== undefined) {
        mkdirSync(options.dataDirectory, { recursive: true });
    }

    // A binding that still fails to build (a database that cannot be opened) throws with earlier platforms already open and their
    // timers armed; nothing returned could close them, so they are closed here.
    try {
        for (const binding of options.durableObjects) {
            const platform = createBindingPlatform(binding, options, env, shardBinding);

            platforms.push(platform);
            // Defined, not assigned: assigning a binding named `__proto__` would replace `env`'s prototype instead of adding a
            // property, and a worker that copies `env` would lose it.
            Object.defineProperty(env, binding.name, {
                configurable: true,
                enumerable: true,
                value: createNodeShardNamespace(platform.directory),
                writable: true,
            });
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

    const context = { passThroughOnException: () => undefined, waitUntil: tracker.track };
    let closing: Promise<DrainResult> | undefined;

    return {
        close: async (closeOptions) => {
            // Checked before anything changes, so a bad value throws with the host still open.
            drainTimeoutMs(closeOptions);

            closing ??= (async () => {
                try {
                    return await drainTogether([requests, tracker, ...platforms], closeOptions);
                } finally {
                    closePlatforms(platforms.splice(0));
                }
            })();

            return closing;
        },
        fetch: async (request) => {
            const response = Promise.resolve(handler.fetch(request, env, context));

            requests.track(response);

            return response;
        },
        rearmPersistedAlarms: () => platforms.flatMap((platform) => platform.rearmPersistedAlarms()),
    };
};

export type { NodeAppDurableObjectBinding, NodeAppHost, NodeAppHostOptions };
export { checkNodeAppHost, createNodeAppHost };
