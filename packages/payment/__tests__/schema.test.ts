import { describe, expect, it } from "vitest";

import { PAYMENT_TABLES } from "../src/database-store";
import paymentExtension from "../src/schema";

const paymentTables = paymentExtension.tables;

/**
 * Drift guard for the discriminator columns `@lunora/codegen` hardcodes.
 *
 * `packages/codegen/src/discover/payment-store-tables.ts` hardcodes the signature columns
 * that identify a real payment store — `providerSubscriptionId` + `state` on
 * `subscriptions`, `providerEventId` + `processedAt` on `events` — to gate the
 * Studio payments page. Nothing binds that hardcode
 * to this schema, so a rename here would silently un-gate the page.
 *
 * These assertions make such a rename fail LOUDLY: keep them and the codegen
 * constants (`PAYMENT_SUBSCRIPTION_COLUMNS` / `PAYMENT_EVENTS_COLUMNS`) in lockstep.
 */
describe("payment store signature columns (codegen drift guard)", () => {
    it("keeps the subscriptions discriminators codegen gates on", () => {
        expect.assertions(2);

        const { subscriptions } = paymentTables;

        // Mirror of PAYMENT_SUBSCRIPTION_COLUMNS in discover/payment-store-tables.ts.
        expect(subscriptions?.shape).toHaveProperty("providerSubscriptionId");
        expect(subscriptions?.shape).toHaveProperty("state");
    });

    it("keeps the events (webhook-log) discriminators codegen gates on", () => {
        expect.assertions(2);

        const { events } = paymentTables;

        // Mirror of PAYMENT_EVENTS_COLUMNS in discover/payment-store-tables.ts.
        expect(events?.shape).toHaveProperty("providerEventId");
        expect(events?.shape).toHaveProperty("processedAt");
    });

    it("names the merged tables exactly as the store reads them", () => {
        expect.assertions(1);

        // `.extend()` prefixes each bare name with the key; PAYMENT_TABLES is what the store uses.
        expect(new Set(Object.keys(paymentTables).map((name) => `${paymentExtension.key}_${name}`))).toStrictEqual(new Set(Object.values(PAYMENT_TABLES)));
    });
});
