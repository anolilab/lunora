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

    // NOTE (plan 282, SSR guard for `startIntervalIfThrottled()`'s creation-time
    // call): the plan's audit assumed a handle could start "already throttled"
    // at creation and modeled a dedicated SSR test on that premise. It cannot:
    // `evaluate()` throws ("requested count N exceeds the limiter capacity C")
    // whenever the read-only status check's implicit `count: 1` would exceed
    // the config's own capacity, and a fresh (unconsumed) bucket is *always*
    // fully available for any non-throwing config — every algorithm variant
    // documents this ("a fresh key starts full"). So a freshly constructed
    // handle can never be `disabled` before its first `consume()`, in the
    // browser or during SSR; the guarded creation-time call is unreachable
    // today. The guard is kept anyway (harmless, and matches the "no eager
    // side effects during SSR" convention used by every other primitive in
    // this family) but there is no reachable pre/post-fix behavioural
    // difference to assert here — recorded for the plan's Open Questions
    // rather than asserted as a test.
    it("consume() still arms the auto-tick interval during SSR once it drains the bucket (unguarded by design)", () => {
        vi.useFakeTimers();

        // No browser `window` (this file's default vitest env has none). Per
        // the design decision (plan 282 §4): `consume()`'s own call to
        // `startIntervalIfThrottled()` stays unguarded — a caller invoking
        // `consume()` is actively using the handle, so the auto-recover ticker
        // is still expected to arm even server-side.
        const clock = { now: 0 };
        const handle = rateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now });

        expect(vi.getTimerCount()).toBe(0);

        handle.consume();
        handle.consume();

        expect(get(handle.disabled)).toBe(true);
        expect(vi.getTimerCount()).toBe(1);

        handle.teardown();
    });
});
