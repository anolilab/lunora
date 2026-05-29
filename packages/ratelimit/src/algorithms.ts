import type { RateLimitConfig, RateLimitStatus, RateLimitValue } from "./types.js";

/** Inputs to {@link evaluate}. */
export interface EvaluateOptions {
    /** When `false`, compute status without consuming (a `check`). */
    consume: boolean;
    /** Units requested. */
    count: number;
    /** Current time in epoch milliseconds. */
    now: number;
    /** Permit a deficit by reserving future capacity (token bucket / within-window). */
    reserve: boolean;
}

/** Result of evaluating a limit against its prior state. */
export interface EvaluateResult {
    status: RateLimitStatus;
    /** Next value to persist, or `null` when the call must not mutate state. */
    value: RateLimitValue | null;
}

const capacityOf = (config: RateLimitConfig): number => config.capacity ?? config.rate;

/**
 * Token bucket: tokens refill continuously at `rate / period` per millisecond
 * up to `capacity`. A fresh key starts full.
 */
const tokenBucket = (config: RateLimitConfig, prior: RateLimitValue | undefined, options: EvaluateOptions): EvaluateResult => {
    const capacity = capacityOf(config);
    const ratePerMs = config.rate / config.period;
    const base = prior ?? { ts: options.now, value: capacity };
    const elapsed = Math.max(0, options.now - base.ts);
    const available = Math.min(capacity, base.value + elapsed * ratePerMs);

    if (available >= options.count) {
        const value = { ts: options.now, value: available - options.count };

        return { status: { ok: true, retryAfter: 0 }, value: options.consume ? value : null };
    }

    const deficit = options.count - available;
    const retryAfter = Math.ceil(deficit / ratePerMs);

    // Reserve lets the caller proceed now and pay later, but never beyond what
    // the bucket could ever hold.
    if (options.consume && options.reserve && options.count <= capacity) {
        return { status: { ok: true, retryAfter }, value: { ts: options.now, value: available - options.count } };
    }

    return { status: { ok: false, reason: "rate", retryAfter }, value: null };
};

/**
 * Fixed window: `rate` tokens are granted at the start of each window aligned
 * to `start + n * period`. With an explicit `capacity > rate`, unused tokens
 * roll into the next window up to `capacity`.
 */
const fixedWindow = (config: RateLimitConfig, prior: RateLimitValue | undefined, options: EvaluateOptions): EvaluateResult => {
    const capacity = capacityOf(config);
    const start = config.start ?? 0;
    const windowStart = start + Math.floor((options.now - start) / config.period) * config.period;

    let base: RateLimitValue;

    if (!prior || prior.ts < windowStart) {
        const carry = prior && config.capacity !== undefined ? Math.max(0, prior.value) : 0;

        base = { ts: windowStart, value: Math.min(capacity, carry + config.rate) };
    } else {
        base = prior;
    }

    if (base.value >= options.count) {
        const value = { ts: base.ts, value: base.value - options.count };

        return { status: { ok: true, retryAfter: 0 }, value: options.consume ? value : null };
    }

    const retryAfter = base.ts + config.period - options.now;

    if (options.consume && options.reserve && options.count <= capacity) {
        return { status: { ok: true, retryAfter }, value: { ts: base.ts, value: base.value - options.count } };
    }

    return { status: { ok: false, reason: "rate", retryAfter }, value: null };
};

/**
 * Sliding window (counter approximation): the estimated rate blends the current
 * window's count with the previous window's, weighted by how far the previous
 * window has scrolled out of view. Smooths the burst that a fixed window allows
 * at its boundary, without the storage cost of a per-request log.
 */
const slidingWindow = (config: RateLimitConfig, prior: RateLimitValue | undefined, options: EvaluateOptions): EvaluateResult => {
    const limit = config.rate;
    const { period } = config;
    const start = config.start ?? 0;
    const windowStart = start + Math.floor((options.now - start) / period) * period;
    const elapsed = options.now - windowStart;
    const weight = (period - elapsed) / period;

    let previousCount = 0;
    let currentCount = 0;

    if (prior?.ts === windowStart) {
        previousCount = prior.prev ?? 0;
        currentCount = prior.value;
    } else if (prior?.ts === windowStart - period) {
        previousCount = prior.value;
    }
    // A gap of two or more windows leaves both counts at zero.

    const estimated = previousCount * weight + currentCount;
    const admit = estimated + options.count <= limit;

    // Time for the decaying previous-window contribution to make room for `count`,
    // crossing into the next window when the current window alone is already full.
    const retryAfter = (): number => {
        const headroomNow = limit - currentCount - options.count;

        if (previousCount > 0 && headroomNow >= 0) {
            return Math.ceil(period - elapsed - (headroomNow * period) / previousCount);
        }

        const headroomNext = limit - options.count;
        const intoNext = currentCount > 0 ? Math.max(0, period - (headroomNext * period) / currentCount) : 0;

        return Math.ceil(period - elapsed + intoNext);
    };

    if (admit || (options.consume && options.reserve && options.count <= limit)) {
        const value: RateLimitValue = { prev: previousCount, ts: windowStart, value: currentCount + options.count };

        return { status: { ok: true, retryAfter: admit ? 0 : retryAfter() }, value: options.consume ? value : null };
    }

    return { status: { ok: false, reason: "rate", retryAfter: retryAfter() }, value: null };
};

/**
 * Evaluate a request against a limit's prior state. Pure: it never reads a
 * clock or persists — the caller supplies `now` and writes back `value` when
 * it is non-`null`.
 */
export const evaluate = (config: RateLimitConfig, prior: RateLimitValue | undefined, options: EvaluateOptions): EvaluateResult => {
    if (config.kind === "token bucket") {
        return tokenBucket(config, prior, options);
    }

    if (config.kind === "sliding window") {
        return slidingWindow(config, prior, options);
    }

    return fixedWindow(config, prior, options);
};
