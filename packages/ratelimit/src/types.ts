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
     * Split a hot limit across N independent sub-buckets to avoid a single
     * contended key/Durable Object. Each shard enforces `rate / shards` (and
     * `capacity / shards`); a request is routed to a shard via a deterministic
     * hash of `(name, key)`, so the same key always lands on the same shard and
     * a single key's effective throughput is exactly `rate / shards`. Aggregate
     * throughput across many distinct keys approaches `rate` as keys spread
     * uniformly across shards. Reserve it for high-volume limits where
     * contention bites; leave unset (one bucket) otherwise. Must be a positive
     * integer — `1` is equivalent to unset.
     */
    shards?: number;
    /**
     * Phase offset in epoch milliseconds for windowed algorithms — windows
     * align to `start + n * period`. Ignored by token buckets. Defaults to `0`.
     */
    start?: number;
}

/** A map of limit name to its config, used to construct a {@link RateLimiter}. */
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

/** Outcome of a {@link RateLimiter.limit} / {@link RateLimiter.check} call. */
export interface RateLimitStatus {
    /** Whether the request is permitted. */
    ok: boolean;
    /** Why the request was denied. Absent when `ok`. */
    reason?: RateLimitReason;
    /** Milliseconds until the request would succeed. `0` when `ok` without reservation. */
    retryAfter: number;
}

/** Per-call options for {@link RateLimiter.limit}. */
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
    /** Throw {@link RateLimitError} instead of returning a failing status. */
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
}
