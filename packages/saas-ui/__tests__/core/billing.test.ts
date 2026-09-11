import { describe, expect, it } from "vitest";

import type { Plan } from "../../src/core/billing";
import { currentPlan, formatMoney, isEntitled, isEntitling, pricingRows, seatUsage, subscriptionNotice } from "../../src/core/billing";
import type { SubscriptionLike } from "../../src/core/types";

const PLANS: ReadonlyArray<Plan> = [
    { blurb: "Get going", currency: "USD", features: ["projects"], id: "free", name: "Free", priceMinor: 0, seats: 1 },
    {
        blurb: "For a team",
        currency: "USD",
        features: ["projects", "admin", "export"],
        id: "pro",
        name: "Pro",
        priceId: "price_pro",
        priceMinor: 2900,
        seats: 10,
    },
    {
        blurb: "No limits",
        currency: "USD",
        features: ["projects", "admin", "export", "sso"],
        id: "scale",
        name: "Scale",
        priceId: "price_scale",
        priceMinor: 9900,
    },
];

const subscription = (overrides: Partial<SubscriptionLike> = {}): SubscriptionLike => {
    return {
        cancelAtPeriodEnd: false,
        priceId: "price_pro",
        quantity: 5,
        state: "active",
        ...overrides,
    };
};

describe("entitlement", () => {
    it("keeps a past-due tenant entitled — a dunning window is not a churn event", () => {
        expect(isEntitling(subscription({ state: "past_due" }))).toBe(true);
        expect(currentPlan(PLANS, subscription({ state: "past_due" }))?.id).toBe("pro");
    });

    it("entitles a trial, because a trial that does not entitle is a demo", () => {
        expect(isEntitling(subscription({ state: "trialing" }))).toBe(true);
    });

    it("drops a canceled or paused tenant back to the free plan", () => {
        expect(currentPlan(PLANS, subscription({ state: "canceled" }))?.id).toBe("free");
        expect(currentPlan(PLANS, subscription({ state: "paused" }))?.id).toBe("free");
    });

    it("treats no subscription and the free tier as the same state", () => {
        expect(currentPlan(PLANS, undefined)?.id).toBe("free");
        expect(isEntitling(undefined)).toBe(false);
    });

    it("falls back to free when the price id is not in the catalog", () => {
        expect(currentPlan(PLANS, subscription({ priceId: "price_deleted" }))?.id).toBe("free");
    });

    it("gates on the plan's named features", () => {
        expect(isEntitled(PLANS, subscription(), "export")).toBe(true);
        expect(isEntitled(PLANS, subscription(), "sso")).toBe(false);
        expect(isEntitled(PLANS, undefined, "admin")).toBe(false);
    });
});

describe("seatUsage", () => {
    it("counts members, not the billed quantity — a webhook lags an invite", () => {
        // Five seats billed, eight people actually in the organisation.
        expect(seatUsage(PLANS[1], 8)).toStrictEqual({ limit: 10, over: false, ratio: 0.8, used: 8 });
    });

    it("flags an over-subscribed organisation", () => {
        expect(seatUsage(PLANS[1], 11).over).toBe(true);
    });

    it("has no bar to draw on an unmetered plan", () => {
        expect(seatUsage(PLANS[2], 400)).toStrictEqual({ over: false, ratio: 0, used: 400 });
    });

    it("survives a zero-seat plan without dividing by it", () => {
        expect(seatUsage({ ...PLANS[0]!, seats: 0 }, 3).ratio).toBe(1);
    });
});

describe("pricingRows", () => {
    it("marks the current plan and offers only the others", () => {
        expect(pricingRows(PLANS, subscription()).map((row) => [row.plan.id, row.current, row.purchasable])).toStrictEqual([
            ["free", false, false],
            ["pro", true, false],
            ["scale", false, true],
        ]);
    });

    it("renders a zero price as Free rather than as a currency", () => {
        expect(pricingRows(PLANS, undefined)[0]!.price).toBe("Free");
        expect(pricingRows(PLANS, undefined)[1]!.price).toContain("29");
    });
});

describe("subscriptionNotice", () => {
    it("leads with the cancellation, whatever the state underneath", () => {
        expect(subscriptionNotice(subscription({ cancelAtPeriodEnd: true, state: "active" }))).toBe("Cancels at the end of the current period.");
    });

    it("says what a failed payment means, not just that it failed", () => {
        expect(subscriptionNotice(subscription({ state: "past_due" }))).toBe("Payment failed — update your card to avoid interruption.");
    });

    it("stays quiet on a healthy subscription", () => {
        expect(subscriptionNotice(subscription())).toBeUndefined();
        expect(subscriptionNotice(undefined)).toBeUndefined();
    });
});

describe("formatMoney", () => {
    it("formats minor units as currency", () => {
        expect(formatMoney(2900, "USD", "en-US")).toBe("$29.00");
    });
});
