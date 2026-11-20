import { describe, expect, it } from "vitest";

import { enforceDunning } from "../lunora/billing";
import { DUNNING_GRACE_MS, evaluateDunning } from "../src/billing/dunning";
import { makeCtx } from "./_helpers/fake-ctx";

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

/**
 * The recovery path clears its markers through a store that refuses an
 * explicitly-undefined patch (the ctx double does too): an `undefined` there
 * threw, so a recovered organization stayed suspended.
 */
describe("billing.enforceDunning recovery", () => {
    it("clears the failure marker and lifts its own suspension once payment recovers", async () => {
        const { ctx, ops } = makeCtx(
            {
                organizations: [{ _id: "org_1", paymentFailedAt: NOW - DUNNING_GRACE_MS * 2, suspendedAt: NOW - 1, suspendedReason: "dunning" }],
                payment_subscriptions: [{ _id: "sub_1", referenceId: "org_1", state: "active" }],
            },
            { now: NOW },
        );

        await expect(enforceDunning.handler(ctx, {})).resolves.toStrictEqual({ graced: 0, recovered: 1, suspended: 0 });
        expect(ops).toStrictEqual([{ id: "org_1", kind: "patch", patch: { paymentFailedAt: null, suspendedAt: null, suspendedReason: null } }]);
    });

    it("keeps a suspension that is not its own when payment recovers", async () => {
        const { ctx, ops } = makeCtx(
            {
                organizations: [{ _id: "org_1", paymentFailedAt: NOW - 1, suspendedAt: NOW - 1, suspendedReason: "spend_cap" }],
                payment_subscriptions: [{ _id: "sub_1", referenceId: "org_1", state: "active" }],
            },
            { now: NOW },
        );

        await enforceDunning.handler(ctx, {});

        expect(ops).toStrictEqual([{ id: "org_1", kind: "patch", patch: { paymentFailedAt: null } }]);
    });
});
