import { describe, expect, it } from "vitest";

import stateToEventType from "../src/providers/subscription-event";

/**
 * Provider-agnostic state → webhook action routing. A state outside the
 * `SubscriptionState` union (a future/third-party adapter value the map does
 * not know yet) must degrade to the generic `subscription.updated`, never to
 * `undefined` — an `undefined` action would break the webhook sync routing.
 */
describe("stateToEventType", () => {
    it("maps each known state to its action", () => {
        expect.assertions(5);

        expect(stateToEventType("active")).toBe("subscription.active");
        expect(stateToEventType("trialing")).toBe("subscription.active");
        expect(stateToEventType("canceled")).toBe("subscription.canceled");
        expect(stateToEventType("past_due")).toBe("subscription.past_due");
        expect(stateToEventType("paused")).toBe("subscription.paused");
    });

    it("falls back to subscription.updated for an undefined state", () => {
        expect.assertions(1);

        expect(stateToEventType(undefined)).toBe("subscription.updated");
    });

    it("falls back to subscription.updated for an out-of-union state instead of returning undefined", () => {
        expect.assertions(1);

        expect(stateToEventType("pausing" as never)).toBe("subscription.updated");
    });
});
