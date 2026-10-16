import { LunoraError } from "@lunora/errors";

import { ipRateLimitKey } from "../../../shared/ip-rate-limit-key";
import { availableAt, evaluate, retentionMs } from "./algorithms";
import RateLimitError from "./error";
import { createMemoryStore } from "./store";
import type { RateLimitArgs, RateLimitConfig, RateLimitConfigMap, RateLimitStatus, RateLimitStore } from "./types";

interface RateLimiterOptions<Names extends string> {
    config: RateLimitConfigMap<Names>;
    /** Keys that are always denied, regardless of limit state. */
    denyList?: Iterable<string>;

    /**
     * Optional key normalizer applied to every incoming `args.key` (the
     * deny-list check and the storage key both see the normalized form). Use for case-folding, trimming, or canonicalizing
     * emails so equivalent inputs share a single bucket. The deny-list
     * itself is consulted as-is; normalize the deny-list entries up front to
     * match.
     *
     * After it, a key that is an IPv6 address is always collapsed to its /64
     * (`2001:db8:1:2::/64`) and an IPv4-mapped one to its IPv4 address, so a
     * `ctx.ip`-keyed limit cannot be dodged by rotating addresses within one
     * delegated prefix. A deny-list IPv6 entry therefore bans its whole /64.
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

/** Read-decide-write rounds one consume makes before failing closed; see `RateLimiter.decide`. */
const MAX_DECIDE_ATTEMPTS = 16;

/** Entries one successful write may examine for eviction; bounds the per-call sweep cost. */
const SWEEP_LIMIT = 32;

const isThenable = <T>(value: PromiseLike<T> | T): value is PromiseLike<T> => typeof (value as PromiseLike<T> | undefined)?.then === "function";

/**
 * A clock that never reads earlier than a previous reading. Decisions and
 * eviction both use it: a rollback could otherwise make a request look older than
 * an entry the sweep already dropped, reviving a spent bucket.
 */
const monotonic = (clock: () => number): (() => number) => {
    let last = Number.NEGATIVE_INFINITY;

    return () => {
        last = Math.max(last, clock());

        return last;
    };
};

// The caller's normalizer (if any), then the IPv6 /64 collapse — see `normalize`.
const withIpCollapse = (normalize: ((key: string) => string) | undefined): ((key: string) => string) =>
    normalize ? (key: string): string => ipRateLimitKey(normalize(key)) : ipRateLimitKey;

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

    private readonly retention: number;

    private readonly store: RateLimitStore;

    /** Whether a stored key is one of this limiter's names; a sweep only evicts those. */
    private readonly owns: (storageKey: string) => boolean;

    public constructor(options: RateLimiterOptions<Names>) {
        // Snapshot the config: decisions and the eviction horizon must read the same
        // values, and a caller mutating its object after construction must not move
        // the horizon out from under entries the sweep has not yet reached.
        this.config = structuredClone(options.config);
        // Keys are `encodeURIComponent(name)` plus an optional `:key`, so the part before the first `:` is the name.
        const names = new Set(Object.keys(this.config).map((name) => encodeURIComponent(name)));
        this.owns = (storageKey) => names.has(storageKey.split(":")[0] ?? "");
        this.normalize = withIpCollapse(options.normalize);
        // Store every entry in BOTH forms so an entry can be written either way.
        // Storing it verbatim only, and matching the raw request key against
        // that, catches nothing but a byte-exact repeat of the stored string:
        // `denyList: ["Abuse@Example.com"]` under a trim+lowercase normalizer
        // misses a request keyed `abuse@example.com`, which consumes from the
        // SAME bucket the stored form routes to — so a banned caller sheds the
        // ban by lower-casing their own email.
        this.denyList = new Set([...(options.denyList ?? [])].flatMap((entry) => [entry, this.normalize(entry)]));
        this.now = monotonic(options.now ?? Date.now);

        if (options.store === undefined) {
            // eslint-disable-next-line no-console -- intentional: no injected logger, mirrors @lunora/auth's construction-time warning
            console.warn(NO_STORE_WARNING);
        }

        this.store = options.store ?? createMemoryStore();
        this.retention = retentionMs(Object.values<RateLimitConfig>(this.config));

        for (const [name, config] of Object.entries<RateLimitConfig>(this.config)) {
            // `shards` is gone. Ignoring a leftover one would silently enforce a
            // different limit: an app that raised `rate` to offset the split
            // would now admit `shards` times the traffic it meant to.
            if (Object.hasOwn(config, "shards")) {
                throw new LunoraError(
                    "INTERNAL",
                    `rate limit "${name}": \`shards\` is no longer supported — remove it; the limit now enforces its full \`rate\` (lower \`rate\` if you raised it to offset the split)`,
                );
            }

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

    /**
     * Read, evaluate and write one consume. A store that reports the write lost
     * (`setIf` resolved `false`: another consume changed the value since this one
     * read it) gets a fresh read and a fresh decision, so the admission always
     * rests on the value the write replaced. Bounded: each lost round means some
     * other consume was admitted (a refusal writes nothing), and past
     * {@link MAX_DECIDE_ATTEMPTS} the call is refused with `retryAfter: 0` rather
     * than admitted.
     */
    private async decide(
        config: RateLimitConfig,
        storageKey: string,
        options: { consume: boolean; count: number; reserve: boolean },
    ): Promise<RateLimitStatus> {
        for (let attempt = 0; attempt < MAX_DECIDE_ATTEMPTS; attempt += 1) {
            // Await the read only when the store is asynchronous. An `await` on a plain
            // value still yields, and every consume started in the same tick would then
            // read the same prior before any of them wrote: a synchronous store (memory,
            // SQL) admitted all of them. Without the yield, read, decide and write run as
            // one step. An asynchronous store yields at its own I/O regardless.
            const read = this.store.get(storageKey);
            // eslint-disable-next-line no-await-in-loop -- a retry must re-read what the lost write replaced
            const prior = isThenable(read) ? await read : read;
            const now = this.now();
            const { status, value } = evaluate(config, prior, { ...options, now });

            if (value === undefined) {
                return status;
            }

            if (this.store.setIf === undefined) {
                // eslint-disable-next-line no-await-in-loop -- returns on the first pass; only `setIf` loops
                await this.store.set(storageKey, value);
                // eslint-disable-next-line no-await-in-loop -- returns on the first pass
                await this.sweep(now);

                return status;
            }

            // eslint-disable-next-line no-await-in-loop -- see above
            if (await this.store.setIf(storageKey, value, prior)) {
                // eslint-disable-next-line no-await-in-loop -- returns on the first pass
                await this.sweep(now);

                return status;
            }
        }

        // Refused, not thrown: an error would reach the middleware's failure policy,
        // and `failOpen` would then admit exactly the call contention kept out.
        return { ok: false, reason: "rate", retryAfter: 0 };
    }

    /**
     * Evict what this limiter's horizon has expired, after a write has landed. The
     * write is already done, so awaiting here does not reopen the read-decide-write
     * window. Only a promise-returning sweep (`createDbStore`) is awaited for I/O.
     */
    private async sweep(now: number): Promise<void> {
        try {
            const swept = this.store.sweep?.(now - this.retention, SWEEP_LIMIT, this.owns);

            if (isThenable(swept)) {
                await swept;
            }
        } catch (error) {
            // The write has already landed, so a failed cleanup must not fail the consume:
            // the caller would then roll back a charge that was made, or fail open.
            // eslint-disable-next-line no-console -- intentional: no injected logger; a skipped sweep only delays eviction
            console.warn("@lunora/ratelimit: the retention sweep failed; the consume still stands", error);
        }
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
        const status = await this.decide(config, storageKey, { consume, count, reserve: args.reserve ?? false });

        if (!status.ok && args.throws) {
            throw new RateLimitError(status);
        }

        return status;
    }
}

export type { RateLimiterOptions };
export { RateLimiter };
