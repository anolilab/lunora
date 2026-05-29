import { availableAt, evaluate } from "./algorithms.js";
import { RateLimitError } from "./error.js";
import { createMemoryStore } from "./store.js";
import type { RateLimitArgs, RateLimitConfig, RateLimitConfigMap, RateLimitStatus, RateLimitStore } from "./types.js";

export interface RateLimiterOptions<Names extends string> {
    config: RateLimitConfigMap<Names>;
    /** Keys that are always denied, regardless of limit state. */
    denyList?: Iterable<string>;
    /** Clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;
    /** Shard selector in `[0, 1)`, injected for tests. Defaults to `Math.random`. */
    random?: () => number;
    /** Persistence. Defaults to a per-instance in-memory store. */
    store?: RateLimitStore;
}

// Both halves are percent-encoded so the separator stays unambiguous: a limit
// named `a:b` (global) can't collide with limit `a` keyed by `b`. A sharded
// limit appends `#<shard>`; `#` can't appear in either encoded half, so the
// shard suffix is unambiguous too.
const storageKeyFor = (name: string, key: string | undefined): string =>
    key === undefined ? encodeURIComponent(name) : `${encodeURIComponent(name)}:${encodeURIComponent(key)}`;

// A sharded config splits its rate and capacity evenly across N sub-buckets,
// each enforced independently. `shards <= 1` (or unset) leaves the config as-is.
const perShardConfig = (config: RateLimitConfig, shards: number): RateLimitConfig =>
    shards > 1 ? { ...config, capacity: (config.capacity ?? config.rate) / shards, rate: config.rate / shards } : config;

/**
 * Enforces named rate limits over a pluggable store. Construct one per app with
 * a config map; call {@link RateLimiter.limit} to consume and
 * {@link RateLimiter.check} to peek. Framework-agnostic — the `@cirrus/ratelimit`
 * middleware wraps it for procedures.
 */
export class RateLimiter<Names extends string = string> {
    private readonly config: RateLimitConfigMap<Names>;

    private readonly denyList: Set<string>;

    private readonly now: () => number;

    private readonly random: () => number;

    private readonly store: RateLimitStore;

    constructor(options: RateLimiterOptions<Names>) {
        this.config = options.config;
        this.denyList = new Set(options.denyList);
        this.now = options.now ?? Date.now;
        this.random = options.random ?? Math.random;
        this.store = options.store ?? createMemoryStore();

        for (const [name, config] of Object.entries<RateLimitConfig>(this.config)) {
            if (config.shards !== undefined && (!Number.isInteger(config.shards) || config.shards < 1)) {
                throw new Error(`rate limit "${name}": shards must be a positive integer`);
            }
        }
    }

    /** Peek at whether a request would be permitted without consuming. */
    public async check(name: Names, args: Omit<RateLimitArgs, "reserve" | "throws"> = {}): Promise<RateLimitStatus> {
        return this.run(name, args, false);
    }

    /**
     * Read the current config and the units admittable right now for a
     * `(name, key)` pair. The value is projected forward to the current clock
     * (token-bucket refill, fixed-window rollover, sliding-window decay), not
     * the last persisted figure. For a sharded limit it aggregates every shard.
     */
    public async getValue(name: Names, args: { key?: string } = {}): Promise<{ config: RateLimitConfig; ts: number; value: number }> {
        const config = this.resolve(name);
        const shards = config.shards ?? 1;
        const now = this.now();

        if (shards > 1) {
            const shardConfig = perShardConfig(config, shards);
            const stored = await Promise.all(this.shardKeys(name, args.key, shards).map((storageKey) => Promise.resolve(this.store.get(storageKey))));
            const value = stored.reduce((total, prior) => total + availableAt(shardConfig, prior ?? undefined, now).value, 0);

            return { config, ts: now, value };
        }

        const current = availableAt(config, await this.store.get(storageKeyFor(name, args.key)), now);

        return { config, ts: current.ts, value: current.value };
    }

    /** Consume capacity. Returns the outcome, or throws when `args.throws` is set. */
    public async limit(name: Names, args: RateLimitArgs = {}): Promise<RateLimitStatus> {
        return this.run(name, args, true);
    }

    /** Clear accounting for a `(name, key)` pair (e.g. on successful login). */
    public async reset(name: Names, args: { key?: string } = {}): Promise<void> {
        const shards = this.resolve(name).shards ?? 1;

        await Promise.all(this.shardKeys(name, args.key, shards).map((storageKey) => Promise.resolve(this.store.delete(storageKey))));
    }

    private resolve(name: Names): RateLimitConfig {
        const config = this.config[name];

        if (!config) {
            throw new Error(`rate limit "${name}" is not configured`);
        }

        return config;
    }

    /** Every storage key a `(name, key)` pair occupies — one per shard, or just one when unsharded. */
    private shardKeys(name: Names, key: string | undefined, shards: number): string[] {
        const base = storageKeyFor(name, key);

        return shards > 1 ? Array.from({ length: shards }, (_, shard) => `${base}#${shard}`) : [base];
    }

    private async run(name: Names, args: RateLimitArgs, consume: boolean): Promise<RateLimitStatus> {
        const config = this.resolve(name);

        // The deny list short-circuits before any token accounting.
        if (args.key !== undefined && this.denyList.has(args.key)) {
            const status: RateLimitStatus = { ok: false, reason: "deny", retryAfter: Number.POSITIVE_INFINITY };

            if (args.throws) {
                throw new RateLimitError(status);
            }

            return status;
        }

        const shards = config.shards ?? 1;
        const base = storageKeyFor(name, args.key);
        // A hot limit spreads writes across shards: each request lands on one
        // shard at random, so aggregate throughput approximates `rate` while no
        // single key/DO is contended. The cost is variance — an unlucky shard
        // can reject while sibling shards still hold capacity.
        const storageKey = shards > 1 ? `${base}#${Math.floor(this.random() * shards)}` : base;
        const prior = await this.store.get(storageKey);
        const { status, value } = evaluate(perShardConfig(config, shards), prior, {
            consume,
            count: args.count ?? 1,
            now: this.now(),
            reserve: args.reserve ?? false,
        });

        if (value !== null) {
            await this.store.set(storageKey, value);
        }

        if (!status.ok && args.throws) {
            throw new RateLimitError(status);
        }

        return status;
    }
}
