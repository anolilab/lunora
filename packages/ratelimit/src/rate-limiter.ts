import { availableAt, evaluate } from "./algorithms.js";
import { RateLimitError } from "./error.js";
import { createMemoryStore } from "./store.js";
import type { RateLimitArgs, RateLimitConfig, RateLimitConfigMap, RateLimitStatus, RateLimitStore } from "./types.js";

interface RateLimiterOptions<Names extends string> {
    config: RateLimitConfigMap<Names>;
    /** Keys that are always denied, regardless of limit state. */
    denyList?: Iterable<string>;

    /**
     * Optional key normalizer applied to every incoming `args.key` (the
     * deny-list check, the storage key, and downstream shard selection all see
     * the normalized form). Use for case-folding, trimming, or canonicalizing
     * IPs/emails so equivalent inputs share a single bucket. The deny-list
     * itself is consulted as-is; normalize the deny-list entries up front to
     * match.
     */
    normalize?: (key: string) => string;
    /** Clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;

    /**
     * @deprecated Shard selection is now a deterministic hash of `args.key`,
     * so this option is unused. Retained for type compatibility.
     */
    random?: () => number;
    /** Persistence. Defaults to a per-instance in-memory store. */
    store?: RateLimitStore;
}

// Both halves are percent-encoded so the separator stays unambiguous: a limit
// named `a:b` (global) can't collide with limit `a` keyed by `b`. A sharded
// limit appends `#<shard>`; `#` can't appear in either encoded half, so the
// shard suffix is unambiguous too.
const storageKeyFor = (name: string, key: string | undefined): string =>
    (key === undefined ? encodeURIComponent(name) : `${encodeURIComponent(name)}:${encodeURIComponent(key)}`);

/**
 * Deterministic shard selector. A FNV-1a-style rolling hash over the storage
 * key — same input always lands on the same shard so a single hot key can't
 * thrash across buckets the way `Math.random()` did. Per-key throughput is
 * therefore `rate/shards`; aggregate throughput across distinct keys spreads
 * uniformly. Use `shards: 1` (or unset) for a single bucket.
 */
const hashToShard = (storageKey: string, shards: number): number => {
    let hash = 0;

    for (let index = 0; index < storageKey.length; index += 1) {
        // eslint-disable-next-line unicorn/prefer-math-trunc, no-bitwise -- 32-bit integer wraparound (`| 0`) is the correct hashing primitive here; Math.trunc would not wrap and the bitwise op is intentional.
        hash = (hash * 31 + storageKey.charCodeAt(index)) | 0;
    }

    return Math.abs(hash) % shards;
};

// A sharded config splits its rate and capacity evenly across N sub-buckets,
// each enforced independently. `shards <= 1` (or unset) leaves the config as-is.
const perShardConfig = (config: RateLimitConfig, shards: number): RateLimitConfig =>
    (shards > 1 ? { ...config, capacity: (config.capacity ?? config.rate) / shards, rate: config.rate / shards } : config);

/** Every storage key a `(name, key)` pair occupies — one per shard, or just one when unsharded. */
const shardKeysFor = (name: string, key: string | undefined, shards: number): string[] => {
    const base = storageKeyFor(name, key);

    return shards > 1 ? Array.from({ length: shards }, (_, shard) => `${base}#${String(shard)}`) : [base];
};

/**
 * Enforces named rate limits over a pluggable store. Construct one per app with
 * a config map; call {@link RateLimiter.limit} to consume and
 * {@link RateLimiter.check} to peek. Framework-agnostic — the `@cirrus/ratelimit`
 * middleware wraps it for procedures.
 */
class RateLimiter<Names extends string = string> {
    private readonly config: RateLimitConfigMap<Names>;

    private readonly denyList: Set<string>;

    private readonly normalize: (key: string) => string;

    private readonly now: () => number;

    private readonly store: RateLimitStore;

    public constructor(options: RateLimiterOptions<Names>) {
        this.config = options.config;
        this.denyList = new Set(options.denyList);
        this.normalize = options.normalize ?? ((key: string): string => key);
        this.now = options.now ?? Date.now;
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
     * the last persisted figure. For a sharded limit it reads only the single
     * shard `limit()`/`run()` would route this key to — the sibling shards are
     * never touched by this key, so summing them would over-report.
     */
    public async getValue(name: Names, args: { key?: string } = {}): Promise<{ config: RateLimitConfig; ts: number; value: number }> {
        const config = this.resolve(name);
        const shards = config.shards ?? 1;
        const now = this.now();
        const normalizedKey = args.key === undefined ? undefined : this.normalize(args.key);

        if (shards > 1) {
            // Mirror the exact routing run() uses so getValue reflects the one
            // bucket this key actually consumes from.
            const base = storageKeyFor(name, normalizedKey);
            const storageKey = `${base}#${String(hashToShard(base, shards))}`;
            const current = availableAt(perShardConfig(config, shards), await this.store.get(storageKey) ?? undefined, now);

            return { config, ts: current.ts, value: current.value };
        }

        const current = availableAt(config, await this.store.get(storageKeyFor(name, normalizedKey)), now);

        return { config, ts: current.ts, value: current.value };
    }

    /** Consume capacity. Returns the outcome, or throws when `args.throws` is set. */
    public async limit(name: Names, args: RateLimitArgs = {}): Promise<RateLimitStatus> {
        return this.run(name, args, true);
    }

    /** Clear accounting for a `(name, key)` pair (e.g. on successful login). */
    public async reset(name: Names, args: { key?: string } = {}): Promise<void> {
        const shards = this.resolve(name).shards ?? 1;
        const normalizedKey = args.key === undefined ? undefined : this.normalize(args.key);

        await Promise.all(shardKeysFor(name, normalizedKey, shards).map((storageKey) => Promise.resolve(this.store.delete(storageKey))));
    }

    private resolve(name: Names): RateLimitConfig {
        const config = this.config[name];

        if (!config) {
            throw new Error(`rate limit "${name}" is not configured`);
        }

        return config;
    }

    private async run(name: Names, args: RateLimitArgs, consume: boolean): Promise<RateLimitStatus> {
        const config = this.resolve(name);
        const normalizedKey = args.key === undefined ? undefined : this.normalize(args.key);

        // The deny list short-circuits before any token accounting. Both the
        // normalizer's output and the raw input are checked so callers can
        // populate the deny-list either before or after normalization without
        // surprises (the normalized form is canonical for storage).
        if (normalizedKey !== undefined && (this.denyList.has(normalizedKey) || this.denyList.has(args.key as string))) {
            const status: RateLimitStatus = { ok: false, reason: "deny", retryAfter: Number.POSITIVE_INFINITY };

            if (args.throws) {
                throw new RateLimitError(status);
            }

            return status;
        }

        const count = args.count ?? 1;

        // A zero/negative/NaN/fractional count would distort or refill the
        // bucket, so reject anything that isn't a positive integer before it
        // reaches the accounting layer.
        if (!Number.isInteger(count) || count <= 0) {
            throw new Error(`rate limit "${name}": count must be a positive integer`);
        }

        const shards = config.shards ?? 1;
        const base = storageKeyFor(name, normalizedKey);
        // Deterministic hash routes a given (name, key) to a fixed shard. Per
        // sibling shards are independent — per-key rate is `rate/shards`,
        // aggregate across distinct keys spreads to ~`rate`. Random shard
        // selection (the old behavior) allowed a single key to drain every
        // shard before any of them rate-limited, which defeated the cap.
        const storageKey = shards > 1 ? `${base}#${String(hashToShard(base, shards))}` : base;
        const prior = await this.store.get(storageKey);
        const { status, value } = evaluate(perShardConfig(config, shards), prior, {
            consume,
            count,
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

export type { RateLimiterOptions };
export { RateLimiter };
