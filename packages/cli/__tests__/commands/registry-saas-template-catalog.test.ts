/**
 * The saas template's seat allowance under a plan catalog with no free plan.
 * A file of its own: the catalog module is replaced for every import here, and
 * `registry-saas-template.test.ts` needs the real one.
 */
import { describe, expect, it, vi } from "vitest";

import type { Handler, Row } from "../helpers/registry-runtime";
import { load } from "../helpers/registry-runtime";

vi.mock(import("../../../../templates/saas/lunora/plans"), async (importOriginal) => {
    const actual = await importOriginal();

    return { ...actual, PLANS: actual.PLANS.filter((plan) => plan.priceId !== undefined) };
});

describe("saas template seat allowance without a free plan", () => {
    it("refuses, rather than lifting the cap, when there is no free plan to fall back on", async () => {
        expect.hasAssertions();

        const { seatAllowance } = await load<{ seatAllowance: Handler<{ referenceId: string }, number | null> }>(
            "templates",
            "saas",
            "lunora",
            "payment",
            "index.ts",
        );
        const subscriptions: Row[] = [];

        await expect(
            seatAllowance({ args: { referenceId: "org-1" }, ctx: { payments: { listSubscriptions: async () => subscriptions } } }),
        ).rejects.toMatchObject({
            code: "INTERNAL",
            message: expect.stringContaining("no free plan"),
        });
    });
});
