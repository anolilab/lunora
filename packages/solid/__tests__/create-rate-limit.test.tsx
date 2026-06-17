import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRateLimit } from "../src/create-rate-limit";

describe("createRateLimit (Solid)", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("starts available and blocks once the bucket is drained", () => {
        const clock = { now: 0 };

        createRoot((dispose) => {
            const result = createRateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now });

            expect(result.ok()).toBe(true);

            result.consume();
            result.consume();

            expect(result.disabled()).toBe(true);
            expect(result.retryAfter()).toBeGreaterThan(0);

            dispose();
        });
    });

    it("check does not consume", () => {
        const clock = { now: 0 };

        createRoot((dispose) => {
            const result = createRateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now });

            const allowed = result.check();

            expect(allowed).toBe(true);
            // Both units are still available because check never spent one.
            expect(result.consume().ok).toBe(true);
            expect(result.consume().ok).toBe(true);

            dispose();
        });
    });

    it("reset restores availability", () => {
        const clock = { now: 0 };

        createRoot((dispose) => {
            const result = createRateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now });

            result.consume();
            result.consume();

            expect(result.disabled()).toBe(true);

            result.reset();

            expect(result.ok()).toBe(true);

            dispose();
        });
    });

    it("re-enables on its own as tokens refill", async () => {
        vi.useFakeTimers();
        const clock = { now: 0 };

        await createRoot(async (dispose) => {
            const result = createRateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now, tickMs: 250 });

            result.consume();
            result.consume();

            expect(result.disabled()).toBe(true);

            // 2 tokens / 1000ms means one token returns after 500ms; the tick
            // interval bumps epoch and the memo flips back to available.
            clock.now = 500;
            await vi.advanceTimersByTimeAsync(250);

            expect(result.ok()).toBe(true);

            dispose();
        });
    });
});
