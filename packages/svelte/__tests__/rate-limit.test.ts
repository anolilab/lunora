import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rateLimit } from "../src/rate-limit";

describe("rateLimit (Svelte)", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("starts available and blocks once the bucket is drained", () => {
        const clock = { now: 0 };
        const handle = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now });

        expect(get(handle.ok)).toBe(true);

        handle.consume();
        handle.consume();

        expect(get(handle.disabled)).toBe(true);
        expect(get(handle.retryAfter)).toBeGreaterThan(0);

        handle.teardown();
    });

    it("check does not consume", () => {
        const clock = { now: 0 };
        const handle = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now });

        const allowed = handle.check();

        expect(allowed).toBe(true);
        // Both units are still available because check never spent one.
        expect(handle.consume().ok).toBe(true);
        expect(handle.consume().ok).toBe(true);

        handle.teardown();
    });

    it("reset restores availability", () => {
        const clock = { now: 0 };
        const handle = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now });

        handle.consume();
        handle.consume();

        expect(get(handle.disabled)).toBe(true);

        handle.reset();

        expect(get(handle.ok)).toBe(true);

        handle.teardown();
    });

    it("re-enables on its own as tokens refill", async () => {
        vi.useFakeTimers();
        const clock = { now: 0 };
        const handle = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now, tickMs: 250 });

        handle.consume();
        handle.consume();

        expect(get(handle.disabled)).toBe(true);

        // 2 tokens / 1000ms means one token returns after 500ms; the tick
        // interval bumps epoch and the derived store flips back to available.
        clock.now = 500;
        await vi.advanceTimersByTimeAsync(250);

        expect(get(handle.ok)).toBe(true);

        handle.teardown();
    });
});
