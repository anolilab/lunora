import { describe, expect, it } from "vitest";

import { DUNNING_GRACE_MS, evaluateDunning } from "../src/billing/dunning";

/** Dunning state machine (GAPS.md C2). */

const NOW = 1_000_000_000;

describe(evaluateDunning, () => {
    it("is ok with no subscriptions (free tier is never dunned)", () => {
        expect(evaluateDunning({ now: NOW, subscriptionStates: [] })).toStrictEqual({ phase: "ok" });
    });

    it("is ok while any good subscription covers the org", () => {
        expect(evaluateDunning({ now: NOW, subscriptionStates: ["past_due", "active"] })).toStrictEqual({ phase: "ok" });
        expect(evaluateDunning({ now: NOW, subscriptionStates: ["trialing"] })).toStrictEqual({ phase: "ok" });
    });

    it("enters grace on the first observed failure, anchored at now", () => {
        expect(evaluateDunning({ now: NOW, subscriptionStates: ["past_due"] })).toStrictEqual({ paymentFailedAt: NOW, phase: "grace" });
    });

    it("keeps the original failure anchor across runs", () => {
        const failedAt = NOW - 1000;

        expect(evaluateDunning({ now: NOW, paymentFailedAt: failedAt, subscriptionStates: ["unpaid"] })).toStrictEqual({
            paymentFailedAt: failedAt,
            phase: "grace",
        });
    });

    it("suspends once the grace window is exhausted", () => {
        const failedAt = NOW - DUNNING_GRACE_MS;

        expect(evaluateDunning({ now: NOW, paymentFailedAt: failedAt, subscriptionStates: ["past_due"] })).toStrictEqual({
            paymentFailedAt: failedAt,
            phase: "suspend",
        });
    });

    it("recovers (ok) when the failing subscription becomes active again", () => {
        expect(evaluateDunning({ now: NOW, paymentFailedAt: NOW - DUNNING_GRACE_MS * 2, subscriptionStates: ["active"] })).toStrictEqual({ phase: "ok" });
    });

    it("ignores canceled subscriptions (no failure, no coverage)", () => {
        expect(evaluateDunning({ now: NOW, subscriptionStates: ["canceled"] })).toStrictEqual({ phase: "ok" });
    });
});
