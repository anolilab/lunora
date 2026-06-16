import { describe, expect, it } from "vitest";

import type { QueryCtx } from "../lunora/_generated/server";
import { assertWithinQuota, orgLimit } from "../lunora/entitlements";

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
