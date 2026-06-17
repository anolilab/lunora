import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick } from "vue";

import { useRateLimit } from "../src/use-rate-limit";

const flushAsync = async (): Promise<void> => {
    await nextTick();
    await vi.waitFor(() => undefined);
};

describe("useRateLimit (Vue)", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("starts available and blocks once the bucket is drained", async () => {
        const clock = { now: 0 };
        const scope = effectScope();

        const result = scope.run(() => useRateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now }))!;

        await flushAsync();

        expect(result.ok.value).toBe(true);

        result.consume();
        result.consume();
        await flushAsync();

        expect(result.disabled.value).toBe(true);
        expect(result.retryAfter.value).toBeGreaterThan(0);

        scope.stop();
    });

    it("check does not consume", async () => {
        const clock = { now: 0 };
        const scope = effectScope();

        const result = scope.run(() => useRateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now }))!;

        await flushAsync();

        const allowed = result.check();

        expect(allowed).toBe(true);
        // Both units are still available because check never spent one.
        expect(result.consume().ok).toBe(true);
        expect(result.consume().ok).toBe(true);

        scope.stop();
    });

    it("reset restores availability", async () => {
        const clock = { now: 0 };
        const scope = effectScope();

        const result = scope.run(() => useRateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now }))!;

        result.consume();
        result.consume();
        await flushAsync();

        expect(result.disabled.value).toBe(true);

        result.reset();
        await flushAsync();

        expect(result.ok.value).toBe(true);

        scope.stop();
    });

    it("re-enables on its own as tokens refill", async () => {
        vi.useFakeTimers();
        const clock = { now: 0 };
        const scope = effectScope();

        const result = scope.run(() => useRateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now, tickMs: 250 }))!;

        result.consume();
        result.consume();
        await flushAsync();

        expect(result.disabled.value).toBe(true);

        // 2 tokens / 1000ms means one token returns after 500ms; the tick
        // interval bumps epoch and the computed ref flips back to available.
        clock.now = 500;
        vi.advanceTimersByTime(250);
        await flushAsync();

        expect(result.ok.value).toBe(true);

        scope.stop();
    });
});
