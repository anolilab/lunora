import { describe, expect, it } from "vitest";

import type { EntitlementsConfig } from "../src/entitlements";
import { entitlementsForReference, hasActivePrice, resolveEntitlements, usagePeriodStart } from "../src/entitlements";
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

describe("entitlements.periodStart", () => {
    it("windows a metered feature on the subscription whose plan grants its limit", () => {
        expect.assertions(2);

        const pro = { ...subscription("price_pro", "active"), currentPeriodStart: 1000 };
        // Grants nothing metered — its fresher period must not reset `seats`, which pro's plan caps.
        const addon = { ...subscription("price_addon", "active"), currentPeriodStart: 5000 };
        const entitlements = resolveEntitlements(config, [pro, addon]);

        expect(entitlements.periodStart("seats")).toBe(1000);
        // No plan limits `export`, so it keeps the latest active period instead of all-time.
        expect(entitlements.periodStart("export")).toBe(5000);
    });

    it("follows the most generous granting plan, whose limit is the one in force", () => {
        expect.assertions(1);

        const pro = { ...subscription("price_pro", "active"), currentPeriodStart: 5000 };
        const team = { ...subscription("price_team", "active"), currentPeriodStart: 1000 };

        expect(resolveEntitlements(config, [pro, team]).periodStart("seats")).toBe(1000);
    });

    it("pools the plans tied on the winning limit", () => {
        expect.assertions(1);

        const tied: EntitlementsConfig = {
            plans: { a: { limits: { seats: 5 }, priceIds: ["price_a"] }, b: { limits: { seats: 5 }, priceIds: ["price_b"] } },
        };
        const a = { ...subscription("price_a", "active"), currentPeriodStart: 1000 };
        const b = { ...subscription("price_b", "active"), currentPeriodStart: 3000 };

        expect(resolveEntitlements(tied, [a, b]).periodStart("seats")).toBe(3000);
    });

    it("ignores inactive subscriptions and falls back to 0", () => {
        expect.assertions(2);

        const canceled = { ...subscription("price_pro", "canceled"), currentPeriodStart: 9000 };

        expect(resolveEntitlements(config, [canceled]).periodStart("seats")).toBe(0);
        expect(resolveEntitlements(config, []).periodStart("seats")).toBe(0);
    });
});

describe("usagePeriodStart", () => {
    it("uses the latest active period across every subscription", () => {
        expect.assertions(2);

        const pro = { ...subscription("price_pro", "active"), currentPeriodStart: 1000 };
        const addon = { ...subscription("price_addon", "active"), currentPeriodStart: 5000 };
        const canceled = { ...subscription("price_team", "canceled"), currentPeriodStart: 9000 };

        expect(usagePeriodStart([pro, addon, canceled])).toBe(5000);
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

describe("multi-item subscriptions", () => {
    it("grants every price the subscription bills, not just the primary one (regression)", () => {
        expect.assertions(4);

        // One Stripe subscription billing a base plan AND an add-on. Keeping only `items.data[0]`
        // denied the add-on to the customer paying for it, and any plan keyed on it never resolved.
        const multi: Subscription = { ...subscription("price_pro", "active"), priceIds: ["price_pro", "price_team"] };
        const entitlements = resolveEntitlements(config, [multi]);

        expect(new Set(entitlements.plans)).toEqual(new Set(["pro", "team"]));
        expect(entitlements.has("sso")).toBe(true);
        expect(hasActivePrice([multi], "price_team")).toBe(true);
        // Most-generous still wins across the two plans one subscription now grants.
        expect(entitlements.limit("seats")).toBe(25);
    });

    it("falls back to the single priceId when no set was reported (no backfill needed)", () => {
        expect.assertions(2);

        // Every non-Stripe adapter, the webhook path, and any row stored before `priceIds` existed.
        const single = subscription("price_pro", "active");

        expect(resolveEntitlements(config, [single]).plans).toEqual(["pro"]);
        expect(hasActivePrice([single], "price_pro")).toBe(true);
    });

    it("ignores the extra prices of a non-entitling subscription", () => {
        expect.assertions(2);

        const canceled: Subscription = { ...subscription("price_pro", "canceled"), priceIds: ["price_pro", "price_team"] };

        expect(hasActivePrice([canceled], "price_team")).toBe(false);
        expect(resolveEntitlements(config, [canceled]).plans).toEqual([]);
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
