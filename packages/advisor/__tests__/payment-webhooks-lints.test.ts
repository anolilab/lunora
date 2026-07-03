import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import paymentWebhookWideTolerance from "../src/lints/static/payment-webhook-wide-tolerance";
import type { AdvisorPaymentWebhook } from "../src/payment-webhooks";

const schema = () => fromServerSchema(defineSchema({ users: defineTable({ name: v.string() }) }));

const rows: AdvisorPaymentWebhook[] = [
    // one-day tolerance → flagged.
    { callee: "createStripeAdapter", exportName: "stripe", file: "payment", line: 3, toleranceSeconds: 86_400 },
    // default-ish 300s tolerance → not flagged.
    { callee: "createPolarAdapter", exportName: "polar", file: "payment", line: 5, toleranceSeconds: 300 },
    // no static tolerance value → not flagged.
    { callee: "createStripeAdapter", exportName: "computed", file: "payment", line: 7 },
];

describe("payment_webhook_wide_tolerance", () => {
    it("flags only the adapter with an implausibly wide tolerance", () => {
        expect.assertions(3);

        const findings = paymentWebhookWideTolerance.run({ paymentWebhooks: rows, schema: schema() });

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            metadata: { callee: "createStripeAdapter", exportName: "stripe", file: "payment", line: 3, toleranceSeconds: 86_400 },
            name: "payment_webhook_wide_tolerance",
        });
        expect(findings[0]?.detail).toContain("86400");
    });

    it("returns [] when paymentWebhooks is undefined", () => {
        expect.assertions(1);

        expect(paymentWebhookWideTolerance.run({ schema: schema() })).toHaveLength(0);
    });

    it("does not flag a tolerance at the one-hour ceiling boundary minus a second", () => {
        expect.assertions(1);

        const nearCeiling: AdvisorPaymentWebhook[] = [{ callee: "createStripeAdapter", exportName: "s", file: "p", line: 1, toleranceSeconds: 3599 }];

        expect(paymentWebhookWideTolerance.run({ paymentWebhooks: nearCeiling, schema: schema() })).toHaveLength(0);
    });
});
