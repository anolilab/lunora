import { LunoraError } from "@lunora/errors";

import { availableAt, evaluate } from "./algorithms";
import RateLimitError from "./error";
import { createMemoryStore } from "./store";
import type { RateLimitArgs, RateLimitConfig, RateLimitConfigMap, RateLimitStatus, RateLimitStore } from "./types";

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
    /** Persistence. Defaults to a per-instance in-memory store. */
    store?: RateLimitStore;
}

// Both halves are percent-encoded so the separator stays unambiguous: a limit
// named `a:b` (global) can't collide with limit `a` keyed by `b`.
const storageKeyFor = (name: string, key: string | undefined): string =>
    key === undefined ? encodeURIComponent(name) : `${encodeURIComponent(name)}:${encodeURIComponent(key)}`;

// Fires once per `new RateLimiter(...)` call that receives no explicit
// `store` — never per check/limit call, which would be noise on the hot
// path. `createMemoryStore()` is the right default *inside a Durable
// Object* (the default single-DO topology, where every call for this
// limiter lands on the same instance); we cannot reliably detect that
// context from here (Workers exposes no synchronous "am I in a DO"
// signal), so this warns unconditionally rather than risk a silently
// weaker-than-configured limit. Mirrors the reasoning `@lunora/auth`
// applies to better-auth's own per-isolate rate-limit storage default.
const NO_STORE_WARNING =
    "@lunora/ratelimit: new RateLimiter() was built with no explicit `store`, so it falls back to `createMemoryStore()` — an in-process Map. " +
    "That Map is durable and correctly shared only for calls that land on the same Durable Object instance; it is NOT shared across " +
    "`.shardBy(...)` shards or `.global()` replicas, and it resets when the DO instance is evicted/restarted. For a limit that must hold " +
    "across any of those, pass a durable `store` (`createDbStore` or `createSqlStore`) instead. Pass `store: createMemoryStore()` " +
    "explicitly once you've confirmed the in-memory default is correct here, to silence this warning.";

/**
 * Enforces named rate limits over a pluggable store. Construct one per app with
 * a config map; call {@link RateLimiter.limit} to consume and
 * {@link RateLimiter.check} to peek. Framework-agnostic — the `@lunora/ratelimit`
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
        this.normalize = options.normalize ?? ((key: string): string => key);
        // Store every entry in BOTH forms so an entry can be written either way.
        // Storing it verbatim only, and matching the raw request key against
        // that, catches nothing but a byte-exact repeat of the stored string:
        // `denyList: ["Abuse@Example.com"]` under a trim+lowercase normalizer
        // misses a request keyed `abuse@example.com`, which consumes from the
        // SAME bucket the stored form routes to — so a banned caller sheds the
        // ban by lower-casing their own email.
        this.denyList = new Set([...(options.denyList ?? [])].flatMap((entry) => [entry, this.normalize(entry)]));
        this.now = options.now ?? Date.now;

        if (options.store === undefined) {
            // eslint-disable-next-line no-console -- intentional: no injected logger, mirrors @lunora/auth's construction-time warning
            console.warn(NO_STORE_WARNING);
        }

        this.store = options.store ?? createMemoryStore();

        for (const [name, config] of Object.entries<RateLimitConfig>(this.config)) {
            // A zero/negative/non-finite period divides by zero in the token
            // bucket (ratePerMs = rate / period → Infinity) and produces NaN
            // window starts in the windowed algorithms — silently corrupting
            // every subsequent admit/reject decision. Fail fast at construction.
            if (!Number.isFinite(config.period) || config.period <= 0) {
                throw new LunoraError("INTERNAL", `rate limit "${name}": period must be a positive number`);
            }

            if (!Number.isFinite(config.rate) || config.rate <= 0) {
                throw new LunoraError("INTERNAL", `rate limit "${name}": rate must be a positive number`);
            }

            if (config.capacity !== undefined && (!Number.isFinite(config.capacity) || config.capacity < 0)) {
                throw new LunoraError("INTERNAL", `rate limit "${name}": capacity must be a non-negative number`);
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
     * the last persisted figure.
     */
    public async getValue(name: Names, args: { key?: string } = {}): Promise<{ config: RateLimitConfig; ts: number; value: number }> {
        const config = this.resolve(name);
        const now = this.now();
        const storageKey = storageKeyFor(name, this.normalizeKey(args.key));
        const current = availableAt(config, await this.store.get(storageKey), now);

        return { config, ts: current.ts, value: current.value };
    }

    /** Consume capacity. Returns the outcome, or throws when `args.throws` is set. */
    public async limit(name: Names, args: RateLimitArgs = {}): Promise<RateLimitStatus> {
        return this.run(name, args, true);
    }

    /** Clear accounting for a `(name, key)` pair (e.g. on successful login). */
    public async reset(name: Names, args: { key?: string } = {}): Promise<void> {
        this.resolve(name);

        await Promise.resolve(this.store.delete(storageKeyFor(name, this.normalizeKey(args.key))));
    }

    private normalizeKey(key: string | undefined): string | undefined {
        return key === undefined ? undefined : this.normalize(key);
    }

    private resolve(name: Names): RateLimitConfig {
        const config = this.config[name];

        // Defensive runtime guard: the Names type says this key exists, but JS
        // callers can pass an unconfigured name.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the keyed type
        if (!config) {
            throw new LunoraError("INTERNAL", `rate limit "${name}" is not configured`);
        }

        return config;
    }

    private async run(name: Names, args: RateLimitArgs, consume: boolean): Promise<RateLimitStatus> {
        const config = this.resolve(name);
        const normalizedKey = this.normalizeKey(args.key);

        // The deny list short-circuits before any token accounting. Both the
        // normalizer's output and the raw input are checked, against a list that
        // holds every entry in both forms too (see the constructor) — so a
        // caller can populate the deny-list either before or after
        // normalization, and either form of a key is caught.
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
            throw new LunoraError("INTERNAL", `rate limit "${name}": count must be a positive integer`);
        }

        const storageKey = storageKeyFor(name, normalizedKey);
        const prior = await this.store.get(storageKey);
        const { status, value } = evaluate(config, prior, {
            consume,
            count,
            now: this.now(),
            reserve: args.reserve ?? false,
        });

        if (value !== undefined) {
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
