import { act, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UseRateLimitResult } from "../src/use-rate-limit.js";
import { useRateLimit } from "../src/use-rate-limit.js";

const clock = { now: 0 };
let handle: UseRateLimitResult;

const Probe = ({ tickMs }: { tickMs?: number }): ReactElement => {
    const result = useRateLimit({ kind: "token bucket", period: 1000, rate: 2 }, { now: () => clock.now, tickMs });

    // Capture the handle out of render (an effect) so the test can read it
    // without reassigning a module-level binding during render.
    useEffect(() => {
        handle = result;
    }, [result]);

    return <span>{result.ok ? "ok" : "blocked"}</span>;
};

describe("useRateLimit", () => {
    afterEach(() => {
        clock.now = 0;
        vi.useRealTimers();
    });

    it("starts available and blocks once the bucket is drained", () => {
        expect.assertions(3);

        render(<Probe />);

        expect(handle.ok).toBe(true);

        act(() => {
            handle.consume();
            handle.consume();
        });

        expect(handle.disabled).toBe(true);
        expect(handle.retryAfter).toBeGreaterThan(0);
    });

    it("check does not consume", () => {
        expect.assertions(3);

        render(<Probe />);

        let allowed = false;

        act(() => {
            allowed = handle.check();
        });

        expect(allowed).toBe(true);
        // Both units are still available because check never spent one.
        expect(handle.consume().ok).toBe(true);
        expect(handle.consume().ok).toBe(true);
    });

    it("reset restores availability", () => {
        expect.assertions(2);

        render(<Probe />);

        act(() => {
            handle.consume();
            handle.consume();
        });

        expect(handle.disabled).toBe(true);

        act(() => {
            handle.reset();
        });

        expect(handle.ok).toBe(true);
    });

    it("re-enables on its own as tokens refill", () => {
        expect.assertions(2);

        vi.useFakeTimers();
        render(<Probe tickMs={250} />);

        act(() => {
            handle.consume();
            handle.consume();
        });

        expect(handle.disabled).toBe(true);

        // 2 tokens / 1000ms means one token returns after 500ms; the tick
        // interval re-renders and the prediction flips back to available.
        clock.now = 500;
        act(() => {
            vi.advanceTimersByTime(250);
        });

        expect(handle.ok).toBe(true);
    });
});
