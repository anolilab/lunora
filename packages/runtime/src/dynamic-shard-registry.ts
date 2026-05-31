/**
 * Dynamic shard registry — DO-backed implementation of {@link ShardRegistry}.
 *
 * The companion to `ShardRegistryDO` from `@cirrus/do`. Plug into
 * `createQueryCoordinator({registry})` and the coordinator will discover
 * the live shard key set per table from a Durable Object instead of from
 * a hand-supplied static map.
 *
 * # Wiring
 *
 * 1. Bind the `ShardRegistryDO` class in `wrangler.jsonc` as `SHARD_REGISTRY`
 *    (or any name; the namespace binding is passed in).
 * 2. Construct the client once per worker request:
 *
 *    ```ts
 *    const registry = createDynamicShardRegistry({ namespace: env.SHARD_REGISTRY });
 *    const coordinator = createQueryCoordinator({ registry });
 *    ```
 *
 * 3. Register shard keys when they first see a write. The recommended hook
 *    is the worker's `onWrite` callback fired through `ctx.waitUntil` so
 *    the user-facing write doesn't pay the registry round-trip:
 *
 *    ```ts
 *    ctx.waitUntil(registry.register("messages", shardKey));
 *    ```
 *
 * # Cache
 *
 * `listShardKeys` caches the per-table answer for `cacheTtlMs` (default 30s)
 * in process memory. The TTL is the eventual-consistency bound: a newly
 * registered shard key takes up to `cacheTtlMs` to participate in a
 * fan-out. Calling `register`/`unregister` busts the local cache eagerly,
 * but only on the worker that made the call — other worker isolates will
 * see the change after their cache TTL elapses (which is fine, because
 * Cloudflare distributes worker instances and there is no in-process
 * coordination across them).
 */

import type { ShardRegistry } from "./query-coordinator.js";
import type { ShardNamespaceLike } from "./resolve-shard.js";

/**
 * Conventional DO instance name. Kept in sync with `SHARD_REGISTRY_DO_NAME`
 * in `@cirrus/do` (not imported to avoid the runtime → do dependency edge —
 * `@cirrus/runtime` MUST stay free of a hard `@cirrus/do` dep).
 */
export const SHARD_REGISTRY_DO_NAME: string = "__cirrus_shard_registry__";

/**
 * Default per-table cache TTL in milliseconds. 30s is a balance between
 * read amplification (a wide fan-out costs N registry round-trips at
 * minimum every 30s) and registration latency (newly registered shards
 * take up to 30s to participate in fan-outs).
 */
export const DEFAULT_REGISTRY_CACHE_TTL_MS: number = 30_000;

/**
 * Local URL-namespace the DO sees. The DO routes by `url.pathname`; the
 * host portion is fictitious because the stub fetch doesn't actually
 * traverse the public internet.
 */
const REGISTRY_BASE_URL = "https://shard-registry.internal";

export interface DynamicShardRegistryOptions {
    /**
     * Override the in-process per-table cache TTL. Set to `0` to disable
     * caching (every `listShardKeys` call hits the DO — useful only for
     * tests).
     */
    cacheTtlMs?: number;
    /**
     * DO instance name. Defaults to {@link SHARD_REGISTRY_DO_NAME}. Override
     * only if you run multiple isolated registries in one environment.
     */
    instanceName?: string;
    /** DO namespace binding (`env.SHARD_REGISTRY`). */
    namespace: ShardNamespaceLike;
}

/**
 * Extension of {@link ShardRegistry} with the mutator surface a worker
 * needs to register / unregister shard keys.
 */
export interface DynamicShardRegistry extends ShardRegistry {
    /** Drop the local cache. Pass a table to invalidate one entry; omit for everything. */
    invalidate: (table?: string) => void;
    /** Register a shard key as live for `table`. Idempotent. */
    register: (table: string, shardKey: string) => Promise<void>;
    /**
     * Read the full `table → shardKeys` map. Useful for admin / debug UIs;
     * not on the fan-out hot path.
     */
    snapshot: () => Promise<Record<string, readonly string[]>>;
    /** Remove a shard key from `table`'s live set. Idempotent. */
    unregister: (table: string, shardKey: string) => Promise<void>;
}

interface CacheEntry {
    expiresAt: number;
    shardKeys: readonly string[];
}

const decodeJson = async <T>(response: Response): Promise<T> => {
    // Response.json() throws on non-JSON; the DO always returns JSON so this
    // only surfaces if the DO route is misbehaving — let it bubble.
    return (await response.json()) as T;
};

export const createDynamicShardRegistry = (options: DynamicShardRegistryOptions): DynamicShardRegistry => {
    const instanceName = options.instanceName ?? SHARD_REGISTRY_DO_NAME;
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_REGISTRY_CACHE_TTL_MS;
    const cache = new Map<string, CacheEntry>();

    const stub = () => options.namespace.get(options.namespace.idFromName(instanceName));

    const post = async (path: string, body: unknown): Promise<Response> =>
        stub().fetch(
            new Request(`${REGISTRY_BASE_URL}${path}`, {
                body: JSON.stringify(body),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

    const get = async (path: string): Promise<Response> => stub().fetch(new Request(`${REGISTRY_BASE_URL}${path}`, { method: "GET" }));

    return {
        invalidate(table) {
            if (table === undefined) {
                cache.clear();
            } else {
                cache.delete(table);
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

            const response = await get(`/list?table=${encodeURIComponent(table)}`);

            if (!response.ok) {
                throw new Error(`shard registry /list returned ${response.status}`);
            }

            const { shardKeys } = await decodeJson<{ shardKeys: readonly string[] }>(response);

            if (cacheTtlMs > 0) {
                cache.set(table, { expiresAt: now + cacheTtlMs, shardKeys });
            }

            return shardKeys;
        },

        async register(table, shardKey) {
            const response = await post("/register", { shardKey, table });

            if (!response.ok) {
                throw new Error(`shard registry /register returned ${response.status}`);
            }

            // Bust the local cache so the next listShardKeys reflects the
            // change immediately on this worker. Other isolates will see it
            // after their cache TTL elapses.
            cache.delete(table);
        },

        async snapshot() {
            const response = await get("/snapshot");

            if (!response.ok) {
                throw new Error(`shard registry /snapshot returned ${response.status}`);
            }

            const { tables } = await decodeJson<{ tables: Record<string, readonly string[]> }>(response);

            return tables;
        },

        async unregister(table, shardKey) {
            const response = await post("/unregister", { shardKey, table });

            if (!response.ok) {
                throw new Error(`shard registry /unregister returned ${response.status}`);
            }

            cache.delete(table);
        },
    };
};
