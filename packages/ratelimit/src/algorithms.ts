import { LunoraError } from "@lunora/errors";

import type { RateLimitConfig, RateLimitStatus, RateLimitValue } from "./types";

/** Inputs to {@link evaluate}. */
interface EvaluateOptions {
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
interface EvaluateResult {
    status: RateLimitStatus;
    /** Next value to persist, or `undefined` when the call must not mutate state. */
    value: RateLimitValue | undefined;
}

const capacityOf = (config: RateLimitConfig): number => config.capacity ?? config.rate;

/**
 * The ceiling a limit will actually enforce on a single `count`, per algorithm:
 * token buckets and fixed windows admit up to `capacity` (defaulting to `rate`),
 * while a sliding window ignores `capacity` entirely and caps at `rate`. Anything
 * above the ceiling is rejected by {@link throwCountExceedsCapacity}, so a caller
 * that clamps a charge must clamp to THIS number — clamping to `capacity` on a
 * sliding window produces a count the limiter then throws on.
 */
const enforcedCapacity = (config: RateLimitConfig): number => (config.kind === "sliding window" ? config.rate : capacityOf(config));

/**
 * A single request larger than the limiter can ever hold can never be admitted,
 * so a finite `retryAfter` would be a lie the caller would chase forever — every
 * algorithm surfaces this caller misuse with the same error.
 */
const throwCountExceedsCapacity = (count: number, capacity: number): never => {
    throw new LunoraError("INTERNAL", `@lunora/ratelimit: requested count ${String(count)} exceeds the limiter capacity ${String(capacity)}`);
};

/**
 * Project a token bucket's stored state forward to `now`: how many tokens have
 * refilled (capped at `capacity`), with the derived `capacity`/`ratePerMs` the
 * caller reuses. Shared by {@link evaluate} and {@link availableAt} so the
 * refill math lives in one place.
 */
const projectTokenBucket = (
    config: RateLimitConfig,
    prior: RateLimitValue | undefined,
    now: number,
): { available: number; capacity: number; ratePerMs: number } => {
    const capacity = capacityOf(config);
    const ratePerMs = config.rate / config.period;
    const base = prior ?? { ts: now, value: capacity };
    const elapsed = Math.max(0, now - base.ts);

    return { available: Math.min(capacity, base.value + elapsed * ratePerMs), capacity, ratePerMs };
};

/**
 * Project a fixed window's stored state forward to `now`: the `{ ts, value }` of
 * the (possibly rolled-over) current window before any consumption. A negative
 * prior `value` is a reserved debt and is carried across the window boundary so
 * the debt is genuinely repaid out of the elapsed windows' grants (matching the
 * token bucket), rather than silently forgiven. Positive leftovers roll over
 * only when an explicit `capacity` is set. Shared by {@link evaluate} and
 * {@link availableAt}.
 */
const projectFixedWindow = (config: RateLimitConfig, prior: RateLimitValue | undefined, now: number): { ts: number; value: number } => {
    const start = config.start ?? 0;
    const windowStart = start + Math.floor((now - start) / config.period) * config.period;

    if (!prior || prior.ts < windowStart) {
        let carry = 0;
        let periods = 1;

        // Carry the prior balance forward when it is reserved debt (a negative
        // balance that must survive the boundary and be repaid, never forgiven)
        // or a positive leftover under an explicit capacity (the default
        // `capacity === rate` disables cross-window rollover).
        if (prior && (prior.value < 0 || config.capacity !== undefined)) {
            carry = prior.value;
            // One grant per ELAPSED window, the way the token bucket refills per
            // elapsed millisecond — the cap below still bounds the result.
            //
            // Granting a single period's rate however long the key sat idle
            // strands any debt >= `rate` permanently: the rejection path
            // persists nothing (`value: undefined`), so every later call
            // re-projects that same stored debt against that same lone grant and
            // lands back at zero. Two oversized reserves in one window would
            // then deny a tenant forever while promising "retry next window"
            // every window.
            periods = Math.max(1, Math.ceil((windowStart - prior.ts) / config.period));
        }

        return { ts: windowStart, value: Math.min(capacityOf(config), carry + periods * config.rate) };
    }

    return { ts: prior.ts, value: prior.value };
};

/**
 * Project a sliding window's stored state forward to `now`: the current window
 * start, the previous/current window counts, and the decay `weight`/`elapsed`.
 * Shared by {@link evaluate} and {@link availableAt}.
 */
const projectSlidingWindow = (
    config: RateLimitConfig,
    prior: RateLimitValue | undefined,
    now: number,
): { currentCount: number; elapsed: number; previousCount: number; weight: number; windowStart: number } => {
    const start = config.start ?? 0;
    const windowStart = start + Math.floor((now - start) / config.period) * config.period;
    const elapsed = now - windowStart;
    const weight = (config.period - elapsed) / config.period;

    let previousCount = 0;
    let currentCount = 0;

    if (prior?.ts === windowStart) {
        previousCount = prior.prev ?? 0;
        currentCount = prior.value;
    } else if (prior?.ts === windowStart - config.period) {
        previousCount = prior.value;
    }
    // A gap of two or more windows leaves both counts at zero.

    return { currentCount, elapsed, previousCount, weight, windowStart };
};

/**
 * Token bucket: tokens refill continuously at `rate / period` per millisecond
 * up to `capacity`. A fresh key starts full.
 */
const tokenBucket = (config: RateLimitConfig, prior: RateLimitValue | undefined, options: EvaluateOptions): EvaluateResult => {
    const { available, capacity, ratePerMs } = projectTokenBucket(config, prior, options.now);

    if (available >= options.count) {
        const value = { ts: options.now, value: available - options.count };

        return { status: { ok: true, retryAfter: 0 }, value: options.consume ? value : undefined };
    }

    const deficit = options.count - available;
    const retryAfter = Math.ceil(deficit / ratePerMs);

    // Reserve lets the caller proceed now and pay later, but never beyond what
    // the bucket could ever hold.
    if (options.consume && options.reserve && options.count <= capacity) {
        return { status: { ok: true, retryAfter }, value: { ts: options.now, value: available - options.count } };
    }

    if (options.count > capacity) {
        throwCountExceedsCapacity(options.count, capacity);
    }

    return { status: { ok: false, reason: "rate", retryAfter }, value: undefined };
};

/**
 * Fixed window: `rate` tokens are granted at the start of each window aligned
 * to `start + n * period`. With an explicit `capacity > rate`, unused tokens
 * roll into the next window up to `capacity`. Reserved debt (a negative balance)
 * is carried across the boundary and repaid out of the elapsed windows' grants,
 * so a debt larger than one window's `rate` still clears.
 */
const fixedWindow = (config: RateLimitConfig, prior: RateLimitValue | undefined, options: EvaluateOptions): EvaluateResult => {
    const capacity = capacityOf(config);
    const base = projectFixedWindow(config, prior, options.now);

    if (base.value >= options.count) {
        const value = { ts: base.ts, value: base.value - options.count };

        return { status: { ok: true, retryAfter: 0 }, value: options.consume ? value : undefined };
    }

    const retryAfter = base.ts + config.period - options.now;

    if (options.consume && options.reserve && options.count <= capacity) {
        return { status: { ok: true, retryAfter }, value: { ts: base.ts, value: base.value - options.count } };
    }

    if (options.count > capacity) {
        throwCountExceedsCapacity(options.count, capacity);
    }

    return { status: { ok: false, reason: "rate", retryAfter }, value: undefined };
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
    const { currentCount, elapsed, previousCount, weight, windowStart } = projectSlidingWindow(config, prior, options.now);

    const estimated = previousCount * weight + currentCount;
    const admit = estimated + options.count <= limit;

    // Time for the decaying previous-window contribution to make room for `count`,
    // crossing into the next window when the current window alone is already full.
    //
    // `current` is the count that will be in the current window ONCE THIS CALL IS
    // ACCOUNTED FOR, and must be passed as such: a reserve persists
    // `currentCount + count`, so deriving its clear time from the pre-reserve
    // `currentCount` under-reports it — the caller wakes at a time the reserve it
    // just took still denies, and burns a rejected attempt. A rejection persists
    // nothing, so there `current` is `currentCount`.
    const retryAfter = (current: number): number => {
        const headroomNow = limit - current - options.count;

        if (previousCount > 0 && headroomNow >= 0) {
            return Math.ceil(period - elapsed - (headroomNow * period) / previousCount);
        }

        const headroomNext = limit - options.count;
        const intoNext = current > 0 ? Math.max(0, period - (headroomNext * period) / current) : 0;

        return Math.ceil(period - elapsed + intoNext);
    };

    if (admit || (options.consume && options.reserve && options.count <= limit)) {
        const value: RateLimitValue = { prev: previousCount, ts: windowStart, value: currentCount + options.count };

        return { status: { ok: true, retryAfter: admit ? 0 : retryAfter(value.value) }, value: options.consume ? value : undefined };
    }

    if (options.count > limit) {
        throwCountExceedsCapacity(options.count, limit);
    }

    return { status: { ok: false, reason: "rate", retryAfter: retryAfter(currentCount) }, value: undefined };
};

/**
 * Project a limit's stored state forward to `now` without consuming: how many
 * units could be admitted right now. Token bucket → the refilled token count;
 * fixed window → tokens left in the current (possibly rolled-over) window;
 * sliding window → `rate` minus the weighted estimate, floored at zero. Pure,
 * like {@link evaluate}, and shares its per-algorithm projection helpers so the
 * two never diverge. Backs `RateLimiter.getValue` so it reports a live figure
 * rather than the last value that happened to be persisted.
 */
const availableAt = (config: RateLimitConfig, prior: RateLimitValue | undefined, now: number): { ts: number; value: number } => {
    if (config.kind === "token bucket") {
        return { ts: now, value: projectTokenBucket(config, prior, now).available };
    }

    if (config.kind === "sliding window") {
        const { currentCount, previousCount, weight, windowStart } = projectSlidingWindow(config, prior, now);

        return { ts: windowStart, value: Math.max(0, config.rate - (previousCount * weight + currentCount)) };
    }

    return projectFixedWindow(config, prior, now);
};

/**
 * Evaluate a request against a limit's prior state. Pure: it never reads a
 * clock or persists — the caller supplies `now` and writes back `value` when
 * it is not `undefined`.
 */
const evaluate = (config: RateLimitConfig, prior: RateLimitValue | undefined, options: EvaluateOptions): EvaluateResult => {
    if (config.kind === "token bucket") {
        return tokenBucket(config, prior, options);
    }

    if (config.kind === "sliding window") {
        return slidingWindow(config, prior, options);
    }

    return fixedWindow(config, prior, options);
};

export type { EvaluateOptions, EvaluateResult };
export { availableAt, enforcedCapacity, evaluate };
