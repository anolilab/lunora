import { describe, expect, it } from "vitest";

import paymentTables from "../src/schema";

/**
 * Drift guard for the discriminator columns `@lunora/codegen` hardcodes.
 *
 * `packages/codegen/src/discover-feature-usage.ts` cannot resolve the
 * cross-package `...paymentTables` spread, so it hardcodes the signature columns
 * that identify a real payment store — `providerSubscriptionId` + `state` on
 * `subscriptions`, `providerEventId` + `processedAt` on `events` — to gate the
 * Studio payments page (and to keep an unrelated newsletter `subscriptions` or a
 * domain `events` table from spuriously enabling it). Nothing binds that hardcode
 * to this schema, so a rename here would silently un-gate the page.
 *
 * These assertions make such a rename fail LOUDLY: keep them and the codegen
 * constants (`PAYMENT_SUBSCRIPTION_COLUMNS` / `PAYMENT_EVENTS_COLUMNS`) in lockstep.
 */
describe("payment store signature columns (codegen drift guard)", () => {
    it("keeps the subscriptions discriminators codegen gates on", () => {
        expect.assertions(2);

        const { subscriptions } = paymentTables;

        // Mirror of PAYMENT_SUBSCRIPTION_COLUMNS in discover-feature-usage.ts.
        expect(subscriptions?.shape).toHaveProperty("providerSubscriptionId");
        expect(subscriptions?.shape).toHaveProperty("state");
    });

    it("keeps the events (webhook-log) discriminators codegen gates on", () => {
        expect.assertions(2);

        const { events } = paymentTables;

        // Mirror of PAYMENT_EVENTS_COLUMNS in discover-feature-usage.ts.
        expect(events?.shape).toHaveProperty("providerEventId");
        expect(events?.shape).toHaveProperty("processedAt");
    });
});
