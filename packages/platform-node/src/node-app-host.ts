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
     * Wait for every `waitUntil` promise to settle, then close every platform, cron timers included. A shard database is released only
     * after its sockets have drained. Safe to call more than once.
     */
    close: () => Promise<void>;
    /** The worker's `fetch`, bound to the composed `env`. Hand it to `createNodeHttpServer`. */
    fetch: (request: Request) => Promise<Response>;
}

const isWorkerHandler = (value: unknown): value is WorkerHandler =>
    typeof value === "object" && value !== null && typeof (value as { fetch?: unknown }).fetch === "function";

/** Compose `worker` over one in-process platform per Durable Object binding. */
const createNodeAppHost = (options: NodeAppHostOptions): NodeAppHost => {
    const handler = options.worker["default"];

    if (!isWorkerHandler(handler)) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: the worker module has no default export with a `fetch` handler");
    }

    const env: Record<string, unknown> = { ...options.env };
    const platforms: NodePlatform[] = [];
    const pending = new Set<Promise<unknown>>();
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

    for (const binding of options.durableObjects) {
        const DurableObject = options.worker[binding.className];

        if (typeof DurableObject !== "function") {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/platform-node: Durable Object binding ${binding.name} names class ${binding.className}, which the worker module does not export`,
            );
        }

        // One instance per shard for the life of the host, as the runtime keeps one per object: an instance built per request loses
        // its in-memory subscribers between a subscribe and the write that should reach them.
        const instances = new WeakMap<NodeShard, DurableObjectInstance>();
        const instanceFor = (shard: NodeShard): DurableObjectInstance => {
            let instance = instances.get(shard);

            if (instance === undefined) {
                instance = new (DurableObject as DurableObjectClass)(createNodeShardState(shard) as never, env);
                instances.set(shard, instance);

                const { webSocketClose, webSocketMessage } = instance;

                if (webSocketClose !== undefined && webSocketMessage !== undefined) {
                    bindShardSockets({ webSocketClose: webSocketClose.bind(instance), webSocketMessage: webSocketMessage.bind(instance) }, shard.inbound);
                }
            }

            return instance;
        };

        // The shard databases sit in the binding's directory; the platform's own database (scheduler and cron rows) sits beside it, never
        // inside, where the registry would read it back as a shard.
        const platform = createNodePlatform({
            crons: binding.name === shardBinding ? options.crons : undefined,
            directory: options.dataDirectory === undefined ? undefined : join(options.dataDirectory, binding.name),
            // The registry passes the shard whose alarm came due. The platform's own database has no app alarm, so a call without one is
            // not an app event.
            onAlarm: async (shard?: NodeShard) => {
                if (shard !== undefined) {
                    await instanceFor(shard).alarm?.();
                }
            },
            onFetch: async (request, shard) => instanceFor(shard).fetch(request),
            path: options.dataDirectory === undefined ? undefined : join(options.dataDirectory, `${binding.name}.platform.sqlite3`),
        });

        platforms.push(platform);
        env[binding.name] = createNodeShardNamespace(platform.directory);
    }

    const context = {
        passThroughOnException: () => undefined,
        waitUntil: (promise: Promise<unknown>) => {
            const tracked = promise.catch(() => undefined).finally(() => pending.delete(tracked));

            pending.add(tracked);
        },
    };

    return {
        close: async () => {
            await Promise.all(pending);

            for (const platform of platforms.splice(0)) {
                platform.close();
            }
        },
        fetch: async (request) => handler.fetch(request, env, context),
    };
};

export type { NodeAppDurableObjectBinding, NodeAppHost, NodeAppHostOptions };
export { createNodeAppHost };
