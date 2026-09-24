import { describe, expect, it } from "vitest";

import { availableAt, evaluate } from "../src/algorithms";
import type { RateLimitConfig } from "../src/types";

const tokenBucket: RateLimitConfig = { kind: "token bucket", period: 1000, rate: 10 };
const fixedWindow: RateLimitConfig = { kind: "fixed window", period: 1000, rate: 5 };
const slidingWindow: RateLimitConfig = { kind: "sliding window", period: 1000, rate: 10 };

const consumeOptions = (count: number, now: number, reserve = false) => {
    return { consume: true, count, now, reserve };
};

describe("token bucket", () => {
    it("a fresh key starts full", () => {
        expect.assertions(2);

        const { status, value } = evaluate(tokenBucket, undefined, consumeOptions(1, 0));

        expect(status.ok).toBe(true);
        expect(value).toEqual({ ts: 0, value: 9 });
    });

    it("rejects once tokens are exhausted and reports retryAfter", () => {
        expect.assertions(4);

        const drained = { ts: 0, value: 0 };
        const { status, value } = evaluate(tokenBucket, drained, consumeOptions(1, 0));

        expect(status.ok).toBe(false);
        expect(status.reason).toBe("rate");
        // 10 tokens / 1000ms = 0.01 tokens/ms, so one token takes 100ms.
        expect(status.retryAfter).toBe(100);
        // A rejected, non-reserving consume must not mutate state.
        expect(value).toBeUndefined();
    });

    it("refills continuously over elapsed time", () => {
        expect.assertions(2);

        const drained = { ts: 0, value: 0 };
        const { status, value } = evaluate(tokenBucket, drained, consumeOptions(3, 500));

        // 500ms accrues 5 tokens; consuming 3 leaves 2.
        expect(status.ok).toBe(true);
        expect(value).toEqual({ ts: 500, value: 2 });
    });

    it("never accrues beyond capacity", () => {
        expect.assertions(1);

        const capped: RateLimitConfig = { capacity: 10, kind: "token bucket", period: 1000, rate: 10 };
        const { value } = evaluate(capped, { ts: 0, value: 8 }, consumeOptions(0, 10_000));

        // 10s would accrue 100 tokens, but capacity caps the bucket at 10.
        expect(value).toEqual({ ts: 10_000, value: 10 });
    });

    it("reserve permits a deficit and reports when it clears", () => {
        expect.assertions(3);

        const drained = { ts: 0, value: 0 };
        const { status, value } = evaluate(tokenBucket, drained, consumeOptions(2, 0, true));

        expect(status.ok).toBe(true);
        expect(status.retryAfter).toBe(200);
        expect(value).toEqual({ ts: 0, value: -2 });
    });

    it("throws when a non-reserve request exceeds capacity (never admittable)", () => {
        expect.assertions(1);

        // rate 10, no explicit capacity → capacity 10. A count of 11 can never
        // fit in the bucket, so it must surface caller misuse rather than a
        // finite retryAfter the caller would chase forever.
        expect(() => evaluate(tokenBucket, undefined, consumeOptions(11, 0))).toThrow("@lunora/ratelimit: requested count 11 exceeds the limiter capacity 10");
    });

    it("throws when a reserve request exceeds capacity (never admittable)", () => {
        expect.assertions(1);

        // Reserve can borrow ahead, but never beyond what the bucket can ever
        // hold — count 11 > capacity 10 is misuse, matching the windowed algos.
        expect(() => evaluate(tokenBucket, { ts: 0, value: 0 }, consumeOptions(11, 0, true))).toThrow(
            "@lunora/ratelimit: requested count 11 exceeds the limiter capacity 10",
        );
    });
});

describe("fixed window", () => {
    it("grants rate tokens at the window start", () => {
        expect.assertions(2);

        const { status, value } = evaluate(fixedWindow, undefined, consumeOptions(5, 0));

        expect(status.ok).toBe(true);
        expect(value).toEqual({ ts: 0, value: 0 });
    });

    it("rejects within the window and points retryAfter at the next window", () => {
        expect.assertions(2);

        const exhausted = { ts: 0, value: 0 };
        const { status } = evaluate(fixedWindow, exhausted, consumeOptions(1, 400));

        expect(status.ok).toBe(false);
        expect(status.retryAfter).toBe(600);
    });

    it("resets at the next window boundary", () => {
        expect.assertions(2);

        const exhausted = { ts: 0, value: 0 };
        const { status, value } = evaluate(fixedWindow, exhausted, consumeOptions(2, 1000));

        expect(status.ok).toBe(true);
        expect(value).toEqual({ ts: 1000, value: 3 });
    });

    it("does not roll over unused tokens without an explicit capacity", () => {
        expect.assertions(1);

        const leftover = { ts: 0, value: 4 };
        const { value } = evaluate(fixedWindow, leftover, consumeOptions(0, 1000));

        // capacity defaults to rate, so the new window is exactly `rate`, not 4 + 5.
        expect(value).toEqual({ ts: 1000, value: 5 });
    });

    it("rolls leftover tokens forward up to capacity", () => {
        expect.assertions(1);

        const rollover: RateLimitConfig = { capacity: 8, kind: "fixed window", period: 1000, rate: 5 };
        const leftover = { ts: 0, value: 4 };
        const { value } = evaluate(rollover, leftover, consumeOptions(0, 1000));

        // 4 carried + 5 granted = 9, clamped to capacity 8.
        expect(value).toEqual({ ts: 1000, value: 8 });
    });

    it("aligns windows to the configured start offset", () => {
        expect.assertions(1);

        const aligned: RateLimitConfig = { kind: "fixed window", period: 1000, rate: 1, start: 200 };
        const { value } = evaluate(aligned, undefined, consumeOptions(1, 1500));

        // Windows align to 200 + n*1000; 1500 falls in the window starting at 1200.
        expect(value?.ts).toBe(1200);
    });

    it("throws when a non-reserve request exceeds capacity (never admittable)", () => {
        expect.assertions(1);

        // rate 5, no explicit capacity → capacity 5. A count of 6 can never fit
        // in any window, so it must surface caller misuse rather than a bogus retryAfter.
        expect(() => evaluate(fixedWindow, undefined, consumeOptions(6, 0))).toThrow("@lunora/ratelimit: requested count 6 exceeds the limiter capacity 5");
    });

    it("admits a non-reserve request exactly at capacity", () => {
        expect.assertions(2);

        const { status, value } = evaluate(fixedWindow, undefined, consumeOptions(5, 0));

        expect(status.ok).toBe(true);
        expect(value).toEqual({ ts: 0, value: 0 });
    });

    it("reserve borrows against the current window, and the debt is repaid at the boundary", () => {
        expect.assertions(4);

        const exhausted = { ts: 0, value: 0 };
        const reserved = evaluate(fixedWindow, exhausted, consumeOptions(2, 0, true));

        // Borrowed 2 against an empty window — value goes negative, retryAfter points at the next window.
        expect(reserved.status.ok).toBe(true);
        expect(reserved.status.retryAfter).toBe(1000);
        expect(reserved.value).toEqual({ ts: 0, value: -2 });

        // The next window carries the -2 debt forward and repays it out of the
        // fresh `rate` grant (5 - 2 = 3) rather than forgiving it — the reserved
        // capacity is genuinely accounted for, matching the token bucket.
        const next = evaluate(fixedWindow, reserved.value ?? undefined, consumeOptions(0, 1000));

        expect(next.value).toEqual({ ts: 1000, value: 3 });
    });

    it("recovers from a reserved debt of a full window's rate", () => {
        expect.assertions(5);

        // rate 5, no explicit capacity. Reserving the whole rate against an
        // already-empty window leaves a debt EQUAL to one grant, so the next
        // window is spent entirely repaying it and the one after must be back
        // to full. The rejection in between persists nothing, so every later
        // call re-projects from this same stored prior — granting a single
        // period's rate however long it sat would strand the key forever.
        const reserved = evaluate(fixedWindow, { ts: 0, value: 0 }, consumeOptions(5, 0, true));

        expect(reserved.value).toEqual({ ts: 0, value: -5 });

        const nextWindow = evaluate(fixedWindow, reserved.value, consumeOptions(1, 1000));

        expect(nextWindow.status.ok).toBe(false);
        // Nothing persisted: the recovery below must come out of the projection.
        expect(nextWindow.value).toBeUndefined();

        // Two elapsed windows grant 2 * rate against a one-window debt.
        const afterNext = evaluate(fixedWindow, reserved.value, consumeOptions(1, 2000));

        expect(afterNext.status.ok).toBe(true);
        expect(afterNext.value).toEqual({ ts: 2000, value: 4 });
    });
});

describe("sliding window", () => {
    it("a fresh key admits up to the limit and tracks the count", () => {
        expect.assertions(2);

        const { status, value } = evaluate(slidingWindow, undefined, consumeOptions(1, 0));

        expect(status.ok).toBe(true);
        expect(value).toEqual({ prev: 0, ts: 0, value: 1 });
    });

    it("a full previous window suppresses a fresh burst at the boundary", () => {
        expect.assertions(2);

        // The previous window (ts 0) saw the full 10; at the next window's start the
        // weighted estimate is still 10, so unlike a fixed window it does not reset.
        const previousFull = { ts: 0, value: 10 };
        const { status } = evaluate(slidingWindow, previousFull, consumeOptions(1, 1000));

        expect(status.ok).toBe(false);
        // 9 tokens of headroom open up 100ms into the new window (weight 0.9 → est 9).
        expect(status.retryAfter).toBe(100);
    });

    it("admits once the previous window has decayed enough", () => {
        expect.assertions(2);

        const previousFull = { ts: 0, value: 10 };
        const { status, value } = evaluate(slidingWindow, previousFull, consumeOptions(1, 1100));

        expect(status.ok).toBe(true);
        expect(value).toEqual({ prev: 10, ts: 1000, value: 1 });
    });

    it("weights the previous window by how far it has scrolled out", () => {
        expect.assertions(2);

        // 8 in the previous window, 500ms into the next: estimate 8*0.5 = 4. A burst of
        // 7 would reach 11 > 10, so it is rejected until ~125ms more decays the estimate.
        const previous = { ts: 0, value: 8 };
        const { status } = evaluate(slidingWindow, previous, consumeOptions(7, 1500));

        expect(status.ok).toBe(false);
        expect(status.retryAfter).toBe(125);
    });

    it("a gap of two or more windows resets the estimate", () => {
        expect.assertions(2);

        const stale = { ts: 0, value: 10 };
        const { status, value } = evaluate(slidingWindow, stale, consumeOptions(10, 3000));

        expect(status.ok).toBe(true);
        expect(value).toEqual({ prev: 0, ts: 3000, value: 10 });
    });

    it("throws when a non-reserve request exceeds the limit (never admittable)", () => {
        expect.assertions(1);

        // limit 10; a count of 11 cannot fit in any window, so it must throw
        // rather than reject with a retryAfter that also cannot satisfy it.
        expect(() => evaluate(slidingWindow, undefined, consumeOptions(11, 0))).toThrow(
            "@lunora/ratelimit: requested count 11 exceeds the limiter capacity 10",
        );
    });

    it("admits a non-reserve request exactly at the limit", () => {
        expect.assertions(2);

        const { status, value } = evaluate(slidingWindow, undefined, consumeOptions(10, 0));

        expect(status.ok).toBe(true);
        expect(value).toEqual({ prev: 0, ts: 0, value: 10 });
    });

    it("reserve borrows past the limit and reports when the pressure clears", () => {
        expect.assertions(4);

        const currentFull = { prev: 0, ts: 0, value: 10 };
        const { status, value } = evaluate(slidingWindow, currentFull, consumeOptions(2, 0, true));

        expect(status.ok).toBe(true);
        expect(value).toEqual({ prev: 0, ts: 0, value: 12 });
        // Derived from the count the reserve PERSISTS (12), not the pre-reserve
        // 10: at 1200 the stored 12 still weighs 9.6, so the same request would
        // be denied again and the caller would burn a rejected retry.
        expect(status.retryAfter).toBe(1334);
        // The reported time is honoured rather than approximate.
        expect(evaluate(slidingWindow, value, consumeOptions(2, status.retryAfter)).status.ok).toBe(true);
    });
});

describe("availableAt", () => {
    it("a fresh token bucket reports full capacity", () => {
        expect.assertions(1);

        expect(availableAt(tokenBucket, undefined, 0)).toEqual({ ts: 0, value: 10 });
    });

    it("token bucket refills toward capacity without consuming", () => {
        expect.assertions(1);

        // 500ms accrues 5 tokens on top of the drained 0.
        expect(availableAt(tokenBucket, { ts: 0, value: 0 }, 500)).toEqual({ ts: 500, value: 5 });
    });

    it("token bucket never reports beyond capacity", () => {
        expect.assertions(1);

        expect(availableAt(tokenBucket, { ts: 0, value: 8 }, 10_000)).toEqual({ ts: 10_000, value: 10 });
    });

    it("fixed window reports remaining tokens, resetting at the boundary", () => {
        expect.assertions(4);

        // Same window: 2 of 5 left.
        expect(availableAt(fixedWindow, { ts: 0, value: 2 }, 400)).toEqual({ ts: 0, value: 2 });
        // Next window: a fresh `rate`.
        expect(availableAt(fixedWindow, { ts: 0, value: 0 }, 1000)).toEqual({ ts: 1000, value: 5 });
        // A reserved debt is repaid out of every elapsed window's grant, not
        // just one, so a debt of a full rate clears after two windows.
        expect(availableAt(fixedWindow, { ts: 0, value: -5 }, 1000)).toEqual({ ts: 1000, value: 0 });
        expect(availableAt(fixedWindow, { ts: 0, value: -5 }, 2000)).toEqual({ ts: 2000, value: 5 });
    });

    it("fixed window carries a reserved debt across the boundary, matching evaluate", () => {
        expect.assertions(1);

        // A -2 reserved debt is repaid out of the next window's grant (5 - 2 = 3),
        // so a peek must not report the full 5 that a forgiven debt would show.
        expect(availableAt(fixedWindow, { ts: 0, value: -2 }, 1000)).toEqual({ ts: 1000, value: 3 });
    });

    it("sliding window reports the remaining allowance under the weighted estimate", () => {
        expect.assertions(1);

        // Previous window saw the full 10; 100ms in, estimate is 9, leaving 1.
        expect(availableAt(slidingWindow, { ts: 0, value: 10 }, 1100)).toEqual({ ts: 1000, value: 1 });
    });

    it("sliding window floors the allowance at zero when over the limit", () => {
        expect.assertions(1);

        expect(availableAt(slidingWindow, { prev: 0, ts: 0, value: 12 }, 0)).toEqual({ ts: 0, value: 0 });
    });
});

describe("check (non-consuming)", () => {
    it("reports availability without mutating state", () => {
        expect.assertions(2);

        const { status, value } = evaluate(tokenBucket, { ts: 0, value: 3 }, { consume: false, count: 2, now: 0, reserve: false });

        expect(status.ok).toBe(true);
        expect(value).toBeUndefined();
    });

    it("a sliding-window check never persists", () => {
        expect.assertions(1);

        const { value } = evaluate(slidingWindow, { ts: 0, value: 4 }, { consume: false, count: 1, now: 0, reserve: false });

        expect(value).toBeUndefined();
    });
});
