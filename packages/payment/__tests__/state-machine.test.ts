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
