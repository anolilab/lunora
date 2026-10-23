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
 * 1. Bind the `ShardRegistryDO` class in `wrangler.jsonc` as `SHARD_REGISTRY`
 * (or any name; the namespace binding is passed in).
 * 2. Construct the client once per worker request:
 *
 * ```ts
 * const registry = createDynamicShardRegistry({ namespace: env.SHARD_REGISTRY });
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

import { SHARD_REGISTRY_SECRET_HEADER } from "../../../shared/internal-secret";
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

interface DynamicShardRegistryOptions {
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

    /**
     * Pin the registry DO to a Cloudflare data-residency jurisdiction. Pass the
     * same value as the worker's `jurisdiction` so the registry co-locates with
     * the shards it tracks. Omit for the un-pinned global namespace.
     */
    jurisdiction?: DurableObjectJurisdiction;
    /** DO namespace binding (`env.SHARD_REGISTRY`). */
    namespace: ShardNamespaceLike;

    /** The registry's `SHARD_REGISTRY_DO_SECRET`, sent on every request; omit when none is provisioned. */
    secret?: string;
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

const decodeJson = async <T>(response: Response): Promise<T> =>
    // Response.json() throws on non-JSON; the DO always returns JSON so this
    // only surfaces if the DO route is misbehaving — let it bubble.
    await response.json();
const createDynamicShardRegistry = (options: DynamicShardRegistryOptions): DynamicShardRegistry => {
    const instanceName = options.instanceName ?? SHARD_REGISTRY_DO_NAME;
    const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_REGISTRY_CACHE_TTL_MS;
    const cache = new Map<string, CacheEntry>();
    // The `/list` in flight per table, so concurrent misses share one request. Cleared with `cache`, so a
    // caller that just registered never joins a list that started before the registration.
    const pending = new Map<string, Promise<ReadonlyArray<string>>>();
    // Pin the registry DO to the configured jurisdiction (unchanged when unset).
    const namespace = applyJurisdiction(options.namespace, options.jurisdiction);

    const secretHeaders: Record<string, string> = options.secret ? { [SHARD_REGISTRY_SECRET_HEADER]: options.secret } : {};

    // Resolved per call, never cached: a registry is built once per isolate
    // (the generated worker memoizes its options), and workerd refuses I/O on
    // a stub created during a different request — so a cached stub serves the
    // first request and throws on every one after it.
    const stub = (): ResolvedShard => resolveShard(namespace, instanceName);

    const post = async (path: string, body: unknown): Promise<Response> =>
        stub().fetch(
            new Request(`${REGISTRY_BASE_URL}${path}`, {
                body: JSON.stringify(body),
                headers: { "content-type": "application/json", ...secretHeaders },
                method: "POST",
            }),
        );

    const get = async (path: string): Promise<Response> => stub().fetch(new Request(`${REGISTRY_BASE_URL}${path}`, { headers: secretHeaders, method: "GET" }));

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

            const request = (async (): Promise<ReadonlyArray<string>> => {
                const response = await get(`/list?table=${encodeURIComponent(table)}`);

                if (!response.ok) {
                    throw new LunoraError(`shard registry /list returned ${String(response.status)}`);
                }

                const { shardKeys } = await decodeJson<{ shardKeys: ReadonlyArray<string> }>(response);

                return shardKeys;
            })();

            // With caching off, every call is meant to reach the DO, so nothing is shared.
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
            const response = await post("/register", { shardKey, table });

            if (!response.ok) {
                throw new LunoraError(`shard registry /register returned ${String(response.status)}`);
            }

            // Bust the local cache so the next listShardKeys reflects the
            // change immediately on this worker. Other isolates will see it
            // after their cache TTL elapses.
            cache.delete(table);
            pending.delete(table);
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

            cache.delete(table);
            pending.delete(table);
        },
    };
};

export { createDynamicShardRegistry, DEFAULT_REGISTRY_CACHE_TTL_MS, SHARD_REGISTRY_DO_NAME };
export type { DynamicShardRegistry, DynamicShardRegistryOptions };
