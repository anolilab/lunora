import { describe, expect, it } from "vitest";

import { BOX_CREDITS_PER_MONTH, overageCreditsOwed, planOverageDebit } from "../src/billing/overage";
import { LUNORA_CLOUD_PLANS } from "../src/billing/plans";
import { billedBoxesByOrg, buildOverageReconcileData } from "../src/billing/reconcile";
import fakeControlPlaneDb from "./_helpers/fake-control-plane-db";

const PERIOD = Date.UTC(2026, 9, 1);

describe("boxes on the plan catalog (plan 458 G16)", () => {
    it("gives free no boxes, pro three and enterprise fifty", () => {
        expect(LUNORA_CLOUD_PLANS.plans["free"]?.limits?.["boxes"]).toBe(0);
        expect(LUNORA_CLOUD_PLANS.plans["pro"]?.limits?.["boxes"]).toBe(3);
        expect(LUNORA_CLOUD_PLANS.plans["enterprise"]?.limits?.["boxes"]).toBe(50);
    });
});

describe("the monthly box charge", () => {
    it("adds a whole month per billed box to what an org owes", () => {
        expect(overageCreditsOwed("pro", {}, 2)).toBe(2 * BOX_CREDITS_PER_MONTH);
        expect(overageCreditsOwed("pro", { requests: 11_000_000 }, 1)).toBe(100 + BOX_CREDITS_PER_MONTH);
        expect(overageCreditsOwed("pro", {})).toBe(0);
    });

    it("debits the box charge through the same idempotent watermark", () => {
        expect(planOverageDebit({ alreadyDebitedCredits: 0, boxes: 1, organizationId: "org_1", periodStart: PERIOD, plan: "pro", usage: {} })).toStrictEqual({
            debitCredits: BOX_CREDITS_PER_MONTH,
            owedCredits: BOX_CREDITS_PER_MONTH,
            reference: `overage:org_1:${String(PERIOD)}:${String(BOX_CREDITS_PER_MONTH)}`,
        });
        expect(
            planOverageDebit({ alreadyDebitedCredits: BOX_CREDITS_PER_MONTH, boxes: 1, organizationId: "org_1", periodStart: PERIOD, plan: "pro", usage: {} }),
        ).toBeNull();
    });

    it("bills every box enrolled and not revoked before the period began — a box revoked this month still counts", () => {
        const counts = billedBoxesByOrg(
            [
                { enrolledAt: PERIOD - 1000, organizationId: "org_1" },
                { enrolledAt: PERIOD + 1000, organizationId: "org_1", revokedAt: PERIOD + 2000 },
                { enrolledAt: PERIOD - 5000, organizationId: "org_1", revokedAt: PERIOD - 1 },
                { enrolledAt: null, organizationId: "org_1" },
                { enrolledAt: PERIOD, organizationId: "org_2", revokedAt: null },
            ],
            PERIOD,
        );

        expect(Object.fromEntries(counts)).toStrictEqual({ org_1: 2, org_2: 1 });
    });

    it("feeds each org's billed boxes into the reconciliation", async () => {
        const data = await buildOverageReconcileData(
            fakeControlPlaneDb({
                boxes: [{ enrolledAt: PERIOD - 1, organizationId: "org_1" }],
                organizations: [
                    { _id: "org_1", plan: "pro" },
                    { _id: "org_2", plan: "free" },
                ],
                overageDebits: [],
                platformUsage: [],
            }),
            PERIOD,
        );

        expect(data.inputs.map((input) => [input.organizationId, input.boxes])).toStrictEqual([
            ["org_1", 1],
            ["org_2", 0],
        ]);
    });
});
