import { describe, expect, it } from "vitest";

import { canTransitionPayment, nextPaymentState, nextSubscriptionState, PAYMENT_TERMINAL_STATES, SUBSCRIPTION_TERMINAL_STATES } from "../src/state-machine";

describe("payment state machine", () => {
    it("allows initiated → captured (webhook before local record)", () => {
        expect(nextPaymentState("initiated", "capture")).toBe("captured");
    });

    it("allows authorized → captured", () => {
        expect(nextPaymentState("authorized", "capture")).toBe("captured");
    });

    it("rejects capture after refund", () => {
        expect(nextPaymentState("refunded", "capture")).toBeUndefined();
    });

    it("rejects fail after capture (out-of-order webhook)", () => {
        expect(nextPaymentState("captured", "fail")).toBeUndefined();
    });

    it("treats terminal states as having no exits", () => {
        for (const state of PAYMENT_TERMINAL_STATES) {
            expect(canTransitionPayment(state, "capture")).toBe(false);
        }
    });
});

describe("subscription state machine", () => {
    it("trialing → active", () => {
        expect(nextSubscriptionState("trialing", "activate")).toBe("active");
    });

    it("active → past_due", () => {
        expect(nextSubscriptionState("active", "mark_past_due")).toBe("past_due");
    });

    it("paused → active via resume", () => {
        expect(nextSubscriptionState("paused", "resume")).toBe("active");
    });

    it("treats canceled as terminal", () => {
        expect(nextSubscriptionState("canceled", "activate")).toBeUndefined();
        expect(SUBSCRIPTION_TERMINAL_STATES.has("canceled")).toBe(true);
    });
});
