import { describe, expect, it } from "vitest";

import type { Plan } from "../../src/core/billing";
import {
    currentPlan,
    currentSubscription,
    formatMoney,
    isEntitled,
    isEntitling,
    pricingRows,
    seatAlert,
    seatSummary,
    seatUsage,
    subscriptionNotice,
} from "../../src/core/billing";
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
    it("does not entitle a past-due tenant, matching @lunora/payment's ACTIVE_STATES", () => {
        expect(isEntitling(subscription({ state: "past_due" }))).toBe(false);
        expect(currentPlan(PLANS, subscription({ state: "past_due" }))?.id).toBe("free");
    });

    it("matches a plan billed as an add-on in priceIds, like the server's priceIdsOf", () => {
        expect(currentPlan(PLANS, subscription({ priceId: "price_base", priceIds: ["price_base", "price_scale"] }))?.id).toBe("scale");
        expect(isEntitled(PLANS, subscription({ priceId: "price_base", priceIds: ["price_base", "price_scale"] }), "sso")).toBe(true);
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

    it("words the usage and the overage for both ports", () => {
        expect(seatSummary(seatUsage(PLANS[1], 8))).toBe("8 of 10 seats used");
        expect(seatSummary(seatUsage(PLANS[2], 400))).toBe("400 members, unmetered");
        expect(seatAlert(seatUsage(PLANS[1], 8))).toBeUndefined();
        expect(seatAlert(seatUsage(PLANS[1], 11))).toContain("over its seat allowance");
    });
});

describe("pricingRows", () => {
    it("marks the current plan and offers nothing else while a subscription is open", () => {
        expect(pricingRows(PLANS, subscription()).map((row) => [row.plan.id, row.current, row.purchasable])).toStrictEqual([
            ["free", false, false],
            ["pro", true, false],
            ["scale", false, false],
        ]);
    });

    it("does not offer a second checkout on a subscription that is failing to bill", () => {
        // `past_due` drops the plan back to Free, but the provider is still billing it.
        for (const state of ["past_due", "paused"]) {
            expect(pricingRows(PLANS, subscription({ state })).some((row) => row.purchasable)).toBe(false);
        }
    });

    it("carries a priceId on exactly the purchasable rows", () => {
        expect(pricingRows(PLANS, undefined).map((row) => (row.purchasable ? row.priceId : undefined))).toStrictEqual([undefined, "price_pro", "price_scale"]);
    });

    it("offers the paid plans again once the subscription is canceled", () => {
        expect(pricingRows(PLANS, subscription({ state: "canceled" })).map((row) => row.purchasable)).toStrictEqual([false, true, true]);
    });

    it("renders a zero price as Free rather than as a currency", () => {
        expect(pricingRows(PLANS, undefined)[0]!.price).toBe("Free");
        expect(pricingRows(PLANS, undefined)[1]!.price).toContain("29");
    });
});

describe("currentSubscription", () => {
    const canceled = subscription({ priceId: "price_scale", state: "canceled" });
    const active = subscription({ priceId: "price_pro" });

    it("picks the entitling subscription whatever order the rows come in", () => {
        expect(currentSubscription([canceled, active])).toBe(active);
        expect(currentSubscription([active, canceled])).toBe(active);
    });

    it("prefers one still billing over a canceled row", () => {
        const pastDue = subscription({ state: "past_due" });

        expect(currentSubscription([canceled, pastDue])).toBe(pastDue);
    });

    it("falls back to a canceled row so the screen can say what ended, and to nothing when there are none", () => {
        expect(currentSubscription([canceled])).toBe(canceled);
        expect(currentSubscription<SubscriptionLike>([])).toBeUndefined();
        expect(currentSubscription<SubscriptionLike>(undefined)).toBeUndefined();
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
