/** Rate-limit algorithm. */
export type RateLimitKind = "fixed window" | "sliding window" | "token bucket";

/** Why a request was denied. */
export type RateLimitReason = "deny" | "rate";

/** Definition of a single named rate limit. */
export interface RateLimitConfig {
    /**
     * Maximum tokens that can accumulate (the rollover ceiling). Defaults to
     * `rate`: for a token bucket that caps a burst at one period's worth of
     * tokens, and for a fixed window it disables cross-window rollover. Ignored
     * by sliding windows, which always cap at `rate` per `period`.
     */
    capacity?: number;
    kind: RateLimitKind;
    /** Window/refill period in milliseconds. */
    period: number;
    /** Tokens granted per `period`. */
    rate: number;

    /**
     * Phase offset in epoch milliseconds for windowed algorithms — windows
     * align to `start + n * period`. Ignored by token buckets. Defaults to `0`.
     */
    start?: number;
}

/** A map of limit name to its config, used to construct a `RateLimiter`. */
export type RateLimitConfigMap<Names extends string = string> = Record<Names, RateLimitConfig>;

/** Persisted accounting state for one `(name, key)` pair. */
export interface RateLimitValue {
    /**
     * Sliding window only: request count from the previous window, used to
     * weight the current estimate. Unset for token-bucket / fixed-window.
     */
    prev?: number;

    /**
     * Token-bucket: timestamp of the last refill. Fixed/sliding window: start of
     * the window the value belongs to.
     */
    ts: number;

    /**
     * Tokens available (token bucket), tokens remaining in the window (fixed
     * window), or requests made in the current window (sliding window).
     * Fractional for token buckets; negative when reserved ahead.
     */
    value: number;
}

/** Outcome of a `RateLimiter.limit` / `RateLimiter.check` call. */
export interface RateLimitStatus {
    /** Whether the request is permitted. */
    ok: boolean;
    /** Why the request was denied. Absent when `ok`. */
    reason?: RateLimitReason;
    /** Milliseconds until the request would succeed. `0` when `ok` without reservation. */
    retryAfter: number;
}

/** Per-call options for `RateLimiter.limit`. */
export interface RateLimitArgs {
    /** Units to consume. Defaults to `1`. */
    count?: number;
    /** Sub-key isolating the limit (per user/team/IP). Omit for a global limit. */
    key?: string;

    /**
     * Permit the request even when capacity is insufficient, reserving future
     * capacity (the stored value goes negative). `retryAfter` then reports when
     * the debt clears. Rejected only when `count` exceeds the bucket capacity.
     */
    reserve?: boolean;
    /** Throw `RateLimitError` instead of returning a failing status. */
    throws?: boolean;
}

/**
 * Pluggable persistence. Reads and writes are keyed by an opaque storage key
 * the limiter derives from the limit name and `key`. Implementations may be
 * synchronous (in-memory) or asynchronous (SQLite/KV); the limiter awaits
 * either.
 */
export interface RateLimitStore {
    delete: (storageKey: string) => Promise<void> | void;
    get: (storageKey: string) => Promise<RateLimitValue | undefined> | RateLimitValue | undefined;
    set: (storageKey: string, value: RateLimitValue) => Promise<void> | void;

    /**
     * Optional conditional write: persist `value` only while the stored value is
     * still `prior` (what `get` returned for this consume, `undefined` for no
     * row), and resolve `false` when it no longer is. When present the limiter
     * writes through it instead of `set`, and a `false` makes it read and decide
     * again rather than admit off a stale read.
     *
     * A store whose `get` and write cannot be interleaved by another consume
     * (memory, SQL: synchronous) needs none. One whose calls can be
     * (`createDbStore`: every call is awaited I/O) must have it.
     */
    setIf?: (storageKey: string, value: RateLimitValue, prior: RateLimitValue | undefined) => Promise<boolean>;

    /**
     * Optional eviction hint, called by the limiter after each successful write.
     * Examine up to `limit` entries from the store's oldest end and remove those
     * whose `ts` is at or before `olderThanTs`, except entries with a negative
     * `value`: a reserved debt is kept, whatever its age. `limit` caps entries
     * examined, not entries removed. Omit it when the store's rows must persist.
     *
     * `owns` says whether a storage key belongs to the limiter asking for the
     * sweep. A store shared with another limiter must leave the other limiter's
     * keys alone: its horizon is not this one's. Absent means every key is owned.
     */
    sweep?: (olderThanTs: number, limit: number, owns?: (storageKey: string) => boolean) => void;
}
