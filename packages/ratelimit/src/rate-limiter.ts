import { evaluate } from "./algorithms.js";
import { RateLimitError } from "./error.js";
import { createMemoryStore } from "./store.js";
import type { RateLimitArgs, RateLimitConfig, RateLimitConfigMap, RateLimitStatus, RateLimitStore } from "./types.js";

export interface RateLimiterOptions<Names extends string> {
    config: RateLimitConfigMap<Names>;
    /** Keys that are always denied, regardless of limit state. */
    denyList?: Iterable<string>;
    /** Clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;
    /** Persistence. Defaults to a per-instance in-memory store. */
    store?: RateLimitStore;
}

// Both halves are percent-encoded so the separator stays unambiguous: a limit
// named `a:b` (global) can't collide with limit `a` keyed by `b`.
const storageKeyFor = (name: string, key: string | undefined): string =>
    key === undefined ? encodeURIComponent(name) : `${encodeURIComponent(name)}:${encodeURIComponent(key)}`;

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

    private readonly store: RateLimitStore;

    constructor(options: RateLimiterOptions<Names>) {
        this.config = options.config;
        this.denyList = new Set(options.denyList);
        this.now = options.now ?? Date.now;
        this.store = options.store ?? createMemoryStore();
    }

    /** Peek at whether a request would be permitted without consuming. */
    public async check(name: Names, args: Omit<RateLimitArgs, "reserve" | "throws"> = {}): Promise<RateLimitStatus> {
        return this.run(name, args, false);
    }

    /** Read the current config and accounting value for a `(name, key)` pair. */
    public async getValue(name: Names, args: { key?: string } = {}): Promise<{ config: RateLimitConfig; ts: number; value: number }> {
        const config = this.resolve(name);
        const stored = await this.store.get(storageKeyFor(name, args.key));
        const fallback = { ts: this.now(), value: config.capacity ?? config.rate };
        const current = stored ?? fallback;

        return { config, ts: current.ts, value: current.value };
    }

    /** Consume capacity. Returns the outcome, or throws when `args.throws` is set. */
    public async limit(name: Names, args: RateLimitArgs = {}): Promise<RateLimitStatus> {
        return this.run(name, args, true);
    }

    /** Clear accounting for a `(name, key)` pair (e.g. on successful login). */
    public async reset(name: Names, args: { key?: string } = {}): Promise<void> {
        await this.store.delete(storageKeyFor(name, args.key));
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

        // The deny list short-circuits before any token accounting.
        if (args.key !== undefined && this.denyList.has(args.key)) {
            const status: RateLimitStatus = { ok: false, reason: "deny", retryAfter: Number.POSITIVE_INFINITY };

            if (args.throws) {
                throw new RateLimitError(status);
            }

            return status;
        }

        const storageKey = storageKeyFor(name, args.key);
        const prior = await this.store.get(storageKey);
        const { status, value } = evaluate(config, prior, {
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
