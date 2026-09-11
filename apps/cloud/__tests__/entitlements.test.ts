import { describe, expect, it } from "vitest";

import type { QueryCtx } from "../lunora/_generated/server";
import { assertWithinQuota, orgLimit, toSubscription } from "../lunora/entitlements";

type Sub = { currentPeriodStart?: number; priceId: string; state: string };

/** Fake ctx whose `subscriptions.findMany` returns the given rows. */
const makeCtx = (subscriptions: Sub[]): QueryCtx =>
    ({
        db: { subscriptions: { findMany: () => Promise.resolve({ page: subscriptions }) } },
    }) as unknown as QueryCtx;

const org = "org_1" as Parameters<typeof orgLimit>[1];

describe(orgLimit, () => {
    it("falls back to the free baseline with no active subscription", async () => {
        await expect(orgLimit(makeCtx([]), org, "projects")).resolves.toBe(1);
    });

    it("reflects an active subscription's plan limits", async () => {
        const ctx = makeCtx([{ priceId: "price_pro_monthly", state: "active" }]);

        await expect(orgLimit(ctx, org, "projects")).resolves.toBe(20);
    });
});

describe(assertWithinQuota, () => {
    it("rejects at the limit and allows below it", async () => {
        const ctx = makeCtx([]); // free → projects limit 1

        await expect(assertWithinQuota(ctx, org, "projects", 0)).resolves.toBeUndefined();
        await expect(assertWithinQuota(ctx, org, "projects", 1)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("raises the ceiling once subscribed", async () => {
        const ctx = makeCtx([{ priceId: "price_pro_monthly", state: "active" }]);

        await expect(assertWithinQuota(ctx, org, "projects", 5)).resolves.toBeUndefined();
    });
});

describe(toSubscription, () => {
    /**
     * `Subscription.id` is the provider's id. `@lunora/payment` keys its upsert and
     * its lookup on `(provider, providerSubscriptionId)`, so mapping Lunora's `_id`
     * here would write a Lunora id into that column on any round trip. Nothing reads
     * `id` on the entitlement path today, which is why the wrong mapping is invisible
     * without this assertion.
     */
    it("takes `id` from the provider's subscription id, not the row id", () => {
        const row = {
            _creationTime: 1,
            _id: "sub_lunora_row_id",
            cancelAtPeriodEnd: false,
            createdAt: 1,
            priceId: "price_pro_monthly",
            provider: "creem",
            providerSubscriptionId: "sub_creem_abc123",
            quantity: 1,
            referenceId: "org_1",
            state: "active",
            updatedAt: 1,
        } as unknown as Parameters<typeof toSubscription>[0];

        expect(toSubscription(row).id).toBe("sub_creem_abc123");
    });

    it("passes the fields entitlement resolution reads straight through", () => {
        const row = {
            _id: "sub_lunora_row_id",
            priceId: "price_pro_monthly",
            provider: "creem",
            providerSubscriptionId: "sub_creem_abc123",
            state: "active",
        } as unknown as Parameters<typeof toSubscription>[0];
        const subscription = toSubscription(row);

        expect(subscription.priceId).toBe("price_pro_monthly");
        expect(subscription.state).toBe("active");
        expect(subscription.provider).toBe("creem");
    });
});
