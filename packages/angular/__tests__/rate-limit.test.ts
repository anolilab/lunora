import { afterEach, describe, expect, it, vi } from "vitest";

import { rateLimit } from "../src/rate-limit";
import { createFakeDestroyRef } from "./fake-client";

describe(rateLimit, () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("starts available and blocks once the bucket is drained", () => {
        const clock = { now: 0 };
        const destroy = createFakeDestroyRef();

        const result = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { destroyRef: destroy.asDestroyRef, now: () => clock.now });

        expect(result.ok()).toBe(true);

        result.consume();
        result.consume();

        expect(result.disabled()).toBe(true);
        expect(result.retryAfter()).toBeGreaterThan(0);
    });

    it("check does not consume", () => {
        const clock = { now: 0 };
        const destroy = createFakeDestroyRef();

        const result = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { destroyRef: destroy.asDestroyRef, now: () => clock.now });

        const allowed = result.check();

        expect(allowed).toBe(true);
        expect(result.consume().ok).toBe(true);
        expect(result.consume().ok).toBe(true);
    });

    it("reset restores availability", () => {
        const clock = { now: 0 };
        const destroy = createFakeDestroyRef();

        const result = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { destroyRef: destroy.asDestroyRef, now: () => clock.now });

        result.consume();
        result.consume();

        expect(result.disabled()).toBe(true);

        result.reset();

        expect(result.ok()).toBe(true);
    });

    it("re-enables on its own as tokens refill", () => {
        vi.useFakeTimers();
        const clock = { now: 0 };
        const destroy = createFakeDestroyRef();

        const result = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { destroyRef: destroy.asDestroyRef, now: () => clock.now, tickMs: 250 });

        result.consume();
        result.consume();

        expect(result.disabled()).toBe(true);

        clock.now = 500;
        vi.advanceTimersByTime(250);

        expect(result.ok()).toBe(true);
    });

    it("clears the interval on destroy — no tick fires after teardown", () => {
        vi.useFakeTimers();
        const clock = { now: 0 };
        const destroy = createFakeDestroyRef();

        const result = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { destroyRef: destroy.asDestroyRef, now: () => clock.now, tickMs: 250 });

        result.consume();
        result.consume();

        expect(result.disabled()).toBe(true);

        destroy.destroy();

        clock.now = 500;
        vi.advanceTimersByTime(250);

        expect(result.disabled()).toBe(true);
    });
});
