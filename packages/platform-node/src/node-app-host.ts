/**
 * A worker module served on this host: the module a `wrangler.jsonc` `main`
 * points at, its default export the request handler and each Durable Object
 * class a named export, composed over one shard registry per binding.
 *
 * This is the composition the package's tests write by hand (`createWorker`
 * over `createNodeShardNamespace(registry.directory)`, one `ShardDO` kept per
 * shard), lifted to take the app's own entry instead. `lunora dev --target
 * node` serves through it; an operator's own process can too.
 *
 * Only Durable Object bindings and plain vars reach `env`. Queues, `.global()`
 * tables, buckets and workflows are composed by `createNodePlatform`, which
 * takes the app's declarations rather than its wrangler config, so they are
 * left for the caller to add through `env`.
 */

import { join } from "node:path";

import { LunoraError } from "@lunora/errors";

import { createNodeShardNamespace } from "./node-shard-namespace";
import type { NodeShard, NodeShardRegistry } from "./node-shard-registry";
import { createNodeShardRegistry } from "./node-shard-registry";
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
     * Directory the shard databases live in, one subdirectory per binding. Omit for in-memory shards, which lose every row when the
     * host closes.
     */
    dataDirectory?: string;
    /** The wrangler config's `durable_objects.bindings`. Each `className` must be a named export of `worker`. */
    durableObjects: ReadonlyArray<NodeAppDurableObjectBinding>;
    /** Plain values for `env`: vars, dev vars, and any binding the caller composes itself. A Durable Object binding of the same name wins. */
    env?: Record<string, unknown>;
    /** The imported worker module. */
    worker: Record<string, unknown>;
}

/** A worker module composed over this host. */
interface NodeAppHost {
    /**
     * Wait for every `waitUntil` promise to settle, then close every shard registry. A shard database is released only after its
     * sockets have drained. Safe to call more than once.
     */
    close: () => Promise<void>;
    /** The worker's `fetch`, bound to the composed `env`. Hand it to `createNodeHttpServer`. */
    fetch: (request: Request) => Promise<Response>;
}

const isWorkerHandler = (value: unknown): value is WorkerHandler =>
    typeof value === "object" && value !== null && typeof (value as { fetch?: unknown }).fetch === "function";

/** Compose `worker` over one in-process shard registry per Durable Object binding. */
const createNodeAppHost = (options: NodeAppHostOptions): NodeAppHost => {
    const handler = options.worker["default"];

    if (!isWorkerHandler(handler)) {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: the worker module has no default export with a `fetch` handler");
    }

    const env: Record<string, unknown> = { ...options.env };
    const registries: NodeShardRegistry[] = [];
    const pending = new Set<Promise<unknown>>();

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

        const registry = createNodeShardRegistry({
            directory: options.dataDirectory === undefined ? undefined : join(options.dataDirectory, binding.name),
            onAlarm: async (shard) => {
                await instanceFor(shard).alarm?.();
            },
            onFetch: async (request, shard) => instanceFor(shard).fetch(request),
        });

        registries.push(registry);
        env[binding.name] = createNodeShardNamespace(registry.directory);
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

            for (const registry of registries.splice(0)) {
                registry.close();
            }
        },
        fetch: async (request) => handler.fetch(request, env, context),
    };
};

export type { NodeAppDurableObjectBinding, NodeAppHost, NodeAppHostOptions };
export { createNodeAppHost };
