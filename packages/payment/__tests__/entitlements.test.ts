import { describe, expect, it } from "vitest";

import type { EntitlementsConfig } from "../src/entitlements";
import { entitlementsForReference, resolveEntitlements, usagePeriodStart } from "../src/entitlements";
import { MemoryPaymentStore } from "../src/store";
import type { Subscription } from "../src/types";

const config: EntitlementsConfig = {
    plans: {
        pro: { features: ["advanced", "export"], limits: { seats: 5 }, priceIds: ["price_pro"] },
        team: { features: ["advanced", "sso"], limits: { seats: 25 }, priceIds: ["price_team"] },
    },
};

const subscription = (priceId: string, state: Subscription["state"]): Subscription => {
    return {
        cancelAtPeriodEnd: false,
        createdAt: 0,
        id: `sub_${priceId}`,
        priceId,
        provider: "stripe",
        quantity: 1,
        referenceId: "user_1",
        state,
        updatedAt: 0,
    };
};

describe("usagePeriodStart", () => {
    it("returns the latest current-period start among active subscriptions", () => {
        expect.assertions(1);

        const a = { ...subscription("price_pro", "active"), currentPeriodStart: 1000 };
        const b = { ...subscription("price_team", "active"), currentPeriodStart: 5000 };

        expect(usagePeriodStart([a, b])).toBe(5000);
    });

    it("ignores inactive subscriptions and falls back to 0", () => {
        expect.assertions(2);

        const canceled = { ...subscription("price_pro", "canceled"), currentPeriodStart: 9000 };

        expect(usagePeriodStart([canceled])).toBe(0);
        expect(usagePeriodStart([])).toBe(0);
    });
});

describe("resolveEntitlements", () => {
    it("grants the plan's features and limits for an active subscription", () => {
        expect.assertions(4);

        const entitlements = resolveEntitlements(config, [subscription("price_pro", "active")]);

        expect(entitlements.plans).toEqual(["pro"]);
        expect(entitlements.has("advanced")).toBe(true);
        expect(entitlements.has("sso")).toBe(false);
        expect(entitlements.limit("seats")).toBe(5);
    });

    it("ignores canceled / past-due subscriptions", () => {
        expect.assertions(3);

        const entitlements = resolveEntitlements(config, [subscription("price_pro", "canceled"), subscription("price_team", "past_due")]);

        expect(entitlements.plans).toEqual([]);
        expect(entitlements.has("advanced")).toBe(false);
        expect(entitlements.limit("seats")).toBeUndefined();
    });

    it("unions features and takes the most-generous limit across active plans", () => {
        expect.assertions(3);

        const entitlements = resolveEntitlements(config, [subscription("price_pro", "active"), subscription("price_team", "trialing")]);

        expect(new Set(entitlements.plans)).toEqual(new Set(["pro", "team"]));
        expect(entitlements.features).toEqual(new Set(["advanced", "export", "sso"]));
        expect(entitlements.limit("seats")).toBe(25);
    });
});

describe("entitlementsForReference", () => {
    it("resolves straight from the store", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("price_pro", "active"));

        const entitlements = await entitlementsForReference(store, config, "user_1");

        expect(entitlements.has("export")).toBe(true);
        await expect(entitlementsForReference(store, config, "someone_else").then((result) => result.plans)).resolves.toEqual([]);
    });
});
