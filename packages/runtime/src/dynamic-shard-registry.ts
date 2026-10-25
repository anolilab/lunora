/**
 * Dynamic shard registry — DO-backed implementation of {@link ShardRegistry}.
 *
 * The companion to `ShardRegistryDO` from `@lunora/do`. Plug into
 * `createQueryCoordinator({registry})` and the coordinator will discover
 * the live shard key set per table from a Durable Object instead of from
 * a hand-supplied static map.
 *
 * # Wiring
 *
 * 1. The worker that hosts the registry binds `ShardRegistryDO` as `SHARD_REGISTRY`
 * (or any name). A worker that calls a registry another worker hosts binds that
 * worker's `ShardRegistryEntrypoint` as a service binding instead, and needs no secret.
 * 2. Construct the client once per worker request:
 *
 * ```ts
 * // Hosting the registry: the namespace, signed with `LUNORA_RELAY_SECRET`.
 * const registry = createDynamicShardRegistry({ env, namespace: env.SHARD_REGISTRY });
 * // Calling another worker's registry: its service binding, with no secret.
 * const remote = createDynamicShardRegistry({ namespace: env.SERVICE_REGISTRY });
 * const coordinator = createQueryCoordinator({ registry });
 * ```
 *
 * 3. Register shard keys when they first see a write. The recommended hook
 * is the worker's `onWrite` callback fired through `ctx.waitUntil` so
 * the user-facing write doesn't pay the registry round-trip:
 *
 * ```ts
 * ctx.waitUntil(registry.register("messages", shardKey));
 * ```
 *
 * # Cache
 *
 * `listShardKeys` caches the per-table answer for `cacheTtlMs` (default 30s)
 * in process memory, and concurrent misses on one table share a single
 * registry request. The TTL is the eventual-consistency bound: a newly
 * registered shard key takes up to `cacheTtlMs` to participate in a
 * fan-out. Calling `register`/`unregister` busts the local cache eagerly,
 * but only on the worker that made the call — other worker isolates will
 * see the change after their cache TTL elapses (which is fine, because
 * Cloudflare distributes worker instances and there is no in-process
 * coordination across them).
 */

import { RELAY_SIGNATURE_HEADER, siblingSecretOf, signSiblingBody } from "@lunora/shard-engine";

import { shardRegistryFrame } from "../../../shared/shard-registry-frame";
import { LunoraError } from "./errors";
import type { ShardRegistry } from "./query-coordinator";
import type { DurableObjectJurisdiction, ResolvedShard, ShardNamespaceLike } from "./resolve-shard";
import { applyJurisdiction, resolveShard } from "./resolve-shard";

/**
 * Conventional DO instance name. Kept in sync with `SHARD_REGISTRY_DO_NAME`
 * in `@lunora/do` (not imported to avoid the runtime → do dependency edge —
 * `@lunora/runtime` MUST stay free of a hard `@lunora/do` dep).
 */
const SHARD_REGISTRY_DO_NAME: string = "__lunora_shard_registry__";

/**
 * Default per-table cache TTL in milliseconds. 30s is a balance between
 * read amplification (a wide fan-out costs N registry round-trips at
 * minimum every 30s) and registration latency (newly registered shards
 * take up to 30s to participate in fan-outs).
 */
const DEFAULT_REGISTRY_CACHE_TTL_MS: number = 30_000;

/**
 * Local URL-namespace the DO sees. The DO routes by `url.pathname`; the
 * host portion is fictitious because the stub fetch doesn't actually
 * traverse the public internet.
 */
const REGISTRY_BASE_URL = "https://shard-registry.internal";

/**
 * The registry as the worker that hosts it exposes it over RPC: the methods of the
 * host's `ShardRegistryEntrypoint`, reached through a service binding. The binding is
 * the capability, so a caller holding it needs no secret.
 */
interface ShardRegistryRpc {
    listShardKeys: (table: string) => Promise<string[]>;
    register: (table: string, shardKey: string) => Promise<void>;
    snapshot: () => Promise<Record<string, string[]>>;
    unregister: (table: string, shardKey: string) => Promise<void>;
}

interface DynamicShardRegistryOptions {
    /**
     * Override the in-process per-table cache TTL. Set to `0` to disable
     * caching (every `listShardKeys` call hits the registry — useful only for
     * tests).
     */
    cacheTtlMs?: number;

    /**
     * The worker's `env`, read for `LUNORA_RELAY_SECRET` when `namespace` is a Durable
     * Object namespace. Every request to the registry is signed with it and the registry
     * refuses any that is not. Not needed for a service binding, which needs no secret.
     */
    env?: unknown;

    /**
     * DO instance name. Defaults to {@link SHARD_REGISTRY_DO_NAME}. Override
     * only if you run multiple isolated registries in one environment. Applies to a
     * Durable Object namespace only.
     */
    instanceName?: string;

    /**
     * Pin the registry DO to a Cloudflare data-residency jurisdiction. Pass the
     * same value as the worker's `jurisdiction` so the registry co-locates with
     * the shards it tracks. Omit for the un-pinned global namespace. Applies to a
     * Durable Object namespace only.
     */
    jurisdiction?: DurableObjectJurisdiction;

    /**
     * The registry: `env.SHARD_REGISTRY` as a Durable Object namespace when this worker
     * hosts the registry, or as a service binding to the host's `ShardRegistryEntrypoint`
     * when another worker hosts it.
     */
    namespace: ShardNamespaceLike | ShardRegistryRpc;
}

/**
 * Extension of {@link ShardRegistry} with the mutator surface a worker
 * needs to register / unregister shard keys.
 */
interface DynamicShardRegistry extends ShardRegistry {
    /** Drop the local cache. Pass a table to invalidate one entry; omit for everything. */
    invalidate: (table?: string) => void;
    /** Register a shard key as live for `table`. Idempotent. */
    register: (table: string, shardKey: string) => Promise<void>;

    /**
     * Read the full `table → shardKeys` map. Useful for admin / debug UIs;
     * not on the fan-out hot path.
     */
    snapshot: () => Promise<Record<string, ReadonlyArray<string>>>;
    /** Remove a shard key from `table`'s live set. Idempotent. */
    unregister: (table: string, shardKey: string) => Promise<void>;
}

interface CacheEntry {
    expiresAt: number;
    shardKeys: ReadonlyArray<string>;
}

/** The registry's reads and writes, whichever way this worker reaches it. */
interface RegistryTransport {
    list: (table: string) => Promise<ReadonlyArray<string>>;
    register: (table: string, shardKey: string) => Promise<void>;
    snapshot: () => Promise<Record<string, ReadonlyArray<string>>>;
    unregister: (table: string, shardKey: string) => Promise<void>;
}

/**
 * Whether a binding is a Durable Object namespace rather than a service binding's RPC stub.
 * Checked here instead of imported from `@lunora/do`, which `@lunora/runtime` must not depend on.
 */
const isDurableObjectNamespace = (binding: ShardNamespaceLike | ShardRegistryRpc): binding is ShardNamespaceLike =>
    "idFromName" in binding && typeof binding.idFromName === "function";

const decodeJson = async <T>(response: Response): Promise<T> =>
    // Response.json() throws on non-JSON; the registry always returns JSON so this
    // only surfaces if the registry route is misbehaving — let it bubble.
    await response.json();

/** The transport for a Durable Object namespace: the registry's routes, each signed with `LUNORA_RELAY_SECRET`. */
const signedRegistry = (options: DynamicShardRegistryOptions & { namespace: ShardNamespaceLike }): RegistryTransport => {
    const instanceName = options.instanceName ?? SHARD_REGISTRY_DO_NAME;
    // Pin the registry DO to the configured jurisdiction (unchanged when unset).
    const namespace = applyJurisdiction(options.namespace, options.jurisdiction);

    // Resolved per call, never cached: a registry is built once per isolate
    // (the generated worker memoizes its options), and workerd refuses I/O on
    // a stub created during a different request — so a cached stub serves the
    // first request and throws on every one after it.
    const stub = (): ResolvedShard => resolveShard(namespace, instanceName);

    const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Response> => {
        const secret = siblingSecretOf(options.env);

        if (secret === undefined) {
            throw new LunoraError("the shard registry requires LUNORA_RELAY_SECRET; set it on the worker and every Durable Object", {
                code: "RELAY_MISCONFIGURED",
            });
        }

        const url = `${REGISTRY_BASE_URL}${path}`;
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const headers: Record<string, string> = { [RELAY_SIGNATURE_HEADER]: await signSiblingBody(secret, shardRegistryFrame(method, url, payload ?? "")) };

        if (payload !== undefined) {
            headers["content-type"] = "application/json";
        }

        return stub().fetch(new Request(url, { body: payload, headers, method }));
    };

    const post = async (path: string, body: unknown): Promise<Response> => send("POST", path, body);

    const get = async (path: string): Promise<Response> => send("GET", path);

    return {
        async list(table) {
            const response = await get(`/list?table=${encodeURIComponent(table)}`);

            if (!response.ok) {
                throw new LunoraError(`shard registry /list returned ${String(response.status)}`);
            }

            const { shardKeys } = await decodeJson<{ shardKeys: ReadonlyArray<string> }>(response);

            return shardKeys;
        },

        async register(table, shardKey) {
            const response = await post("/register", { shardKey, table });

            if (!response.ok) {
                throw new LunoraError(`shard registry /register returned ${String(response.status)}`);
            }
        },

        async snapshot() {
            const response = await get("/snapshot");

            if (!response.ok) {
                throw new LunoraError(`shard registry /snapshot returned ${String(response.status)}`);
            }

            const { tables } = await decodeJson<{ tables: Record<string, ReadonlyArray<string>> }>(response);

            return tables;
        },

        async unregister(table, shardKey) {
            const response = await post("/unregister", { shardKey, table });

            if (!response.ok) {
                throw new LunoraError(`shard registry /unregister returned ${String(response.status)}`);
            }
        },
    };
};

/** The transport for a service binding: the host's RPC surface, which carries the capability itself. */
const rpcRegistry = (rpc: ShardRegistryRpc): RegistryTransport => {
    return {
        list: async (table) => rpc.listShardKeys(table),
        register: async (table, shardKey) => rpc.register(table, shardKey),
        snapshot: async () => rpc.snapshot(),
        unregister: async (table, shardKey) => rpc.unregister(table, shardKey),
    };
};

const createDynamicShardRegistry = (options: DynamicShardRegistryOptions): DynamicShardRegistry => {
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_REGISTRY_CACHE_TTL_MS;
    const cache = new Map<string, CacheEntry>();
    // The `/list` in flight per table, so concurrent misses share one request. Cleared with `cache`, so a
    // caller that just registered never joins a list that started before the registration.
    const pending = new Map<string, Promise<ReadonlyArray<string>>>();
    const transport = isDurableObjectNamespace(options.namespace)
        ? signedRegistry({ ...options, namespace: options.namespace })
        : rpcRegistry(options.namespace);

    return {
        invalidate(table) {
            if (table === undefined) {
                cache.clear();
                pending.clear();
            } else {
                cache.delete(table);
                pending.delete(table);
            }
        },

        async listShardKeys(table) {
            // Date.now() in Workers is quantised to ms; that's fine for a
            // multi-second TTL, no need for performance.now().
            const now = Date.now();
            const cached = cache.get(table);

            if (cached && cached.expiresAt > now) {
                return cached.shardKeys;
            }

            const inFlight = pending.get(table);

            if (inFlight) {
                return inFlight;
            }

            const request = transport.list(table);

            // With caching off, every call is meant to reach the registry, so nothing is shared.
            if (cacheTtlMs > 0) {
                pending.set(table, request);
            }

            try {
                const shardKeys = await request;

                // A register that landed while this list was in flight has already dropped it, so its reply is stale.
                if (cacheTtlMs > 0 && pending.get(table) === request) {
                    cache.set(table, { expiresAt: now + cacheTtlMs, shardKeys });
                }

                return shardKeys;
            } finally {
                // Cleared on settle, success or failure, so the next call after a failed list retries.
                if (pending.get(table) === request) {
                    pending.delete(table);
                }
            }
        },

        async register(table, shardKey) {
            await transport.register(table, shardKey);

            // Bust the local cache so the next listShardKeys reflects the
            // change immediately on this worker. Other isolates will see it
            // after their cache TTL elapses.
            cache.delete(table);
            pending.delete(table);
        },

        async snapshot() {
            return transport.snapshot();
        },

        async unregister(table, shardKey) {
            await transport.unregister(table, shardKey);

            cache.delete(table);
            pending.delete(table);
        },
    };
};

export { createDynamicShardRegistry, DEFAULT_REGISTRY_CACHE_TTL_MS, SHARD_REGISTRY_DO_NAME };
export type { DynamicShardRegistry, DynamicShardRegistryOptions, ShardRegistryRpc };
