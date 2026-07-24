/**
 * `ShardKvStore` — the provider-neutral contract for durable key-value storage
 * scoped to one shard. On Cloudflare this is backed by `state.storage`'s
 * key-value surface (`get`/`put`/`delete`/`list`); on another provider it may
 * be a DynamoDB item collection, a Redis keyspace, or a table in the shard's
 * local SQL store.
 *
 * This is the surface `ShardHost` deliberately does not cover. `ShardHost`
 * models the reactive engine's needs — single-writer serialization, local SQL,
 * transactions, alarms. A Durable Object that keeps plain records rather than
 * running the engine (`SessionDO` is the canonical one) needs ordered key
 * lookup and prefix scans instead, and forcing it through `ShardHost.sql`
 * would give it a SQL dialect it does not want. Kept a separate contract so a
 * host can implement one, the other, or both.
 *
 * The engine relies on three guarantees:
 * 1. **Durability** — a written value survives host recycling and is readable
 * on the next wake, exactly like a `SocketHost` attachment.
 * 2. **Read-your-writes** — a `get` after a `put` in the same wake observes the
 * written value.
 * 3. **Prefix enumeration** — `list({ prefix })` returns every live key under
 * the prefix and nothing outside it, so a keyspace can be swept (TTL GC) or
 * migrated without a separate index.
 *
 * This is an internal contract. User code never sees it; only DOs that keep
 * durable records and their host adapters consume it.
 */

/** Options accepted by {@link ShardKvStore.list}. */
export interface ShardKvListOptions {
    /**
     * Restrict the scan to keys beginning with this string. Omitted means every
     * key in the shard's keyspace — hosts should treat a very large keyspace as
     * the caller's responsibility to bound, exactly as `state.storage.list`
     * does.
     */
    prefix?: string;
}

/**
 * The durable key-value contract for one shard. One instance per shard key.
 */
export interface ShardKvStore {
    /**
     * Delete `key`. Resolves `true` when a value was removed, `false` when the
     * key was already absent. Idempotent: deleting a missing key is not an
     * error.
     */
    delete: (key: string) => Promise<boolean>;

    /**
     * Read the value stored under `key`, or `undefined` when absent. The type
     * parameter is a caller-side assertion about the stored shape; the host
     * does not validate it.
     */
    get: <T = unknown>(key: string) => Promise<T | undefined>;

    /**
     * Enumerate live keys, optionally restricted to a prefix. The result MUST
     * contain exactly the keys under the prefix — never a superset — so a
     * prefix sweep cannot touch unrelated keys.
     */
    list: <T = unknown>(options?: ShardKvListOptions) => Promise<Map<string, T>>;

    /**
     * Write `value` under `key`, replacing any existing value. The value must
     * be structured-clonable; hosts serialize it durably.
     */
    put: (key: string, value: unknown) => Promise<void>;
}
