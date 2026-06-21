import type { RateLimitConfig } from "@lunora/ratelimit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

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

    it("reacts to a changed ref config", async () => {
        const clock = { now: 0 };
        // rate 1 / 1000ms → one token refills every 1000ms.
        const config = ref<RateLimitConfig>({ kind: "token bucket", period: 1000, rate: 1 });
        const scope = effectScope();

        const result = scope.run(() => useRateLimit(config, { now: () => clock.now }))!;

        await flushAsync();

        // Drain the single token; now throttled with a retryAfter set by the rate.
        result.consume();
        await flushAsync();

        expect(result.disabled.value).toBe(true);

        const retryAtRate1 = result.retryAfter.value;

        expect(retryAtRate1).toBeGreaterThan(0);

        // Swap the ref to a faster refill rate. With the SAME drained bucket and
        // SAME clock, only the config changed — a reactive re-derive must shrink
        // retryAfter (tokens refill 10x faster). If config weren't reactive this
        // would stay at retryAtRate1.
        config.value = { kind: "token bucket", period: 1000, rate: 10 };
        await flushAsync();

        expect(result.retryAfter.value).toBeLessThan(retryAtRate1);

        scope.stop();
    });

    it("reacts to a changed getter config", async () => {
        const clock = { now: 0 };
        let rate = 1;
        const scope = effectScope();

        const configGetter = (): RateLimitConfig => {
            return { kind: "token bucket", period: 1000, rate };
        };

        const result = scope.run(() => useRateLimit(configGetter, { now: () => clock.now }))!;

        await flushAsync();

        result.consume();
        await flushAsync();

        expect(result.disabled.value).toBe(true);

        const retryAtRate1 = result.retryAfter.value;

        expect(retryAtRate1).toBeGreaterThan(0);

        // A getter carries no reactivity of its own; a `consume()` (still
        // throttled, so it doesn't change the drained bucket meaningfully) bumps
        // epoch and re-runs the effect, which calls `toValue(config)` and picks
        // up the new getter value — shrinking retryAfter via the faster rate.
        rate = 10;
        result.consume();
        await flushAsync();

        expect(result.retryAfter.value).toBeLessThan(retryAtRate1);

        scope.stop();
    });
});
