import { describe, expect, it } from "vitest";

import { canTransitionPayment, nextPaymentState, nextSubscriptionState, PAYMENT_TERMINAL_STATES, SUBSCRIPTION_TERMINAL_STATES } from "../src/state-machine";

describe("payment state machine", () => {
    it("allows initiated → captured (webhook before local record)", () => {
        expect.assertions(1);

        expect(nextPaymentState("initiated", "capture")).toBe("captured");
    });

    it("allows authorized → captured", () => {
        expect.assertions(1);

        expect(nextPaymentState("authorized", "capture")).toBe("captured");
    });

    it("rejects capture after refund", () => {
        expect.assertions(1);

        expect(nextPaymentState("refunded", "capture")).toBeUndefined();
    });

    it("rejects fail after capture (out-of-order webhook)", () => {
        expect.assertions(1);

        expect(nextPaymentState("captured", "fail")).toBeUndefined();
    });

    it("treats terminal states as having no exits", () => {
        expect.hasAssertions();

        for (const state of PAYMENT_TERMINAL_STATES) {
            expect(canTransitionPayment(state, "capture")).toBe(false);
        }
    });

    it("allows failed → captured: the same provider intent can be retried and succeed (regression)", () => {
        expect.assertions(3);

        // A declined Stripe PaymentIntent returns to `requires_payment_method`; a retry on the SAME
        // `pi_` can reach `succeeded` (or `requires_capture` on a manual-capture intent). Both are
        // forward transitions at the provider, so `failed` is not terminal.
        expect(nextPaymentState("failed", "capture")).toBe("captured");
        expect(nextPaymentState("failed", "authorize")).toBe("authorized");
        expect(PAYMENT_TERMINAL_STATES.has("failed")).toBe(false);
    });

    it("allows a repeat decline on a failed payment but never a refund", () => {
        expect.assertions(3);

        expect(nextPaymentState("failed", "fail")).toBe("failed");
        // Nothing was captured, so there is nothing to reverse.
        expect(nextPaymentState("failed", "refund")).toBeUndefined();
        expect(nextPaymentState("failed", "partial_refund")).toBeUndefined();
    });
});

describe("subscription state machine", () => {
    it("trialing → active", () => {
        expect.assertions(1);

        expect(nextSubscriptionState("trialing", "activate")).toBe("active");
    });

    it("active → past_due", () => {
        expect.assertions(1);

        expect(nextSubscriptionState("active", "mark_past_due")).toBe("past_due");
    });

    it("paused → active via resume", () => {
        expect.assertions(1);

        expect(nextSubscriptionState("paused", "resume")).toBe("active");
    });

    it("treats canceled as terminal", () => {
        expect.assertions(2);

        expect(nextSubscriptionState("canceled", "activate")).toBeUndefined();
        expect(SUBSCRIPTION_TERMINAL_STATES.has("canceled")).toBe(true);
    });
});
