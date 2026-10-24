import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { evaluate } from "../src/algorithms";
import type { RateLimitConfig, RateLimitValue } from "../src/types";

/**
 * Model-based checks over random request histories. Each generated history is a
 * list of `(advance, count)` steps; time only moves forward, and state is carried
 * from one `evaluate` to the next exactly as the store would persist it. A denied
 * call persists nothing, so the carried state only changes on an admitted call.
 */

const PERIOD = 1000;
const RATE = 5;

const stepArbitrary = fc.record({
    advance: fc.integer({ max: 1500, min: 0 }),
    count: fc.integer({ max: RATE, min: 1 }),
});

const historyArbitrary = fc.array(stepArbitrary, { maxLength: 80 });

/** Run the history, returning what the property needs to judge each decision. */
const replay = (config: RateLimitConfig, steps: ReadonlyArray<{ advance: number; count: number }>, visit: (decision: Decision) => boolean): boolean => {
    let state: RateLimitValue | undefined;
    let now = 0;

    for (const step of steps) {
        now += step.advance;

        const prior = state;
        const result = evaluate(config, prior, { consume: true, count: step.count, now, reserve: false });

        if (!visit({ count: step.count, now, ok: result.status.ok, prior, retryAfter: result.status.retryAfter, value: result.value })) {
            return false;
        }

        state = result.value ?? state;
    }

    return true;
};

interface Decision {
    count: number;
    now: number;
    ok: boolean;
    prior: RateLimitValue | undefined;
    retryAfter: number;
    value: RateLimitValue | undefined;
}

describe("evaluate properties", () => {
    it("admits no more than rate per fixed window", () => {
        expect.assertions(1);

        const config: RateLimitConfig = { kind: "fixed window", period: PERIOD, rate: RATE };

        const property = fc.property(historyArbitrary, (steps) => {
            const admittedByWindow = new Map<number, number>();

            const held = replay(config, steps, (decision) => {
                if (decision.ok) {
                    const window = Math.floor(decision.now / PERIOD);

                    admittedByWindow.set(window, (admittedByWindow.get(window) ?? 0) + decision.count);
                }

                return true;
            });

            return held && [...admittedByWindow.values()].every((total) => total <= RATE);
        });

        expect(fc.check(property)).toMatchObject({ failed: false });
    });

    it("never admits more than capacity plus the refill accrued since the bucket started", () => {
        expect.assertions(1);

        const config: RateLimitConfig = { kind: "token bucket", period: PERIOD, rate: RATE };

        const property = fc.property(historyArbitrary, (steps) => {
            let startedAt: number | undefined;
            let admitted = 0;

            return replay(config, steps, (decision) => {
                startedAt ??= decision.now;

                if (decision.ok) {
                    admitted += decision.count;
                }

                const refilled = ((decision.now - startedAt) * RATE) / PERIOD;

                return admitted <= RATE + refilled + 1e-9;
            });
        });

        expect(fc.check(property)).toMatchObject({ failed: false });
    });

    it("gives a retry-after that actually admits the denied request, and persists nothing on denial", () => {
        expect.assertions(1);

        const configs: RateLimitConfig[] = [
            { kind: "fixed window", period: PERIOD, rate: RATE },
            { kind: "token bucket", period: PERIOD, rate: RATE },
        ];

        const property = fc.property(fc.constantFrom(...configs), historyArbitrary, (config, steps) =>
            replay(config, steps, (decision) => {
                if (decision.ok) {
                    return true;
                }

                if (decision.value !== undefined || !Number.isFinite(decision.retryAfter) || decision.retryAfter <= 0) {
                    return false;
                }

                const retried = evaluate(config, decision.prior, {
                    consume: true,
                    count: decision.count,
                    now: decision.now + decision.retryAfter,
                    reserve: false,
                });

                return retried.status.ok;
            }),
        );

        expect(fc.check(property)).toMatchObject({ failed: false });
    });
});
