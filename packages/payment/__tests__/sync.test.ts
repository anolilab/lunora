import { describe, expect, it } from "vitest";

import { money } from "../src/money";
import { MemoryPaymentStore } from "../src/store";
import applyWebhookAction from "../src/sync";
import type { WebhookAction } from "../src/types";

const captureEvent = (eventId: string): WebhookAction => {
    return {
        amount: money(1000, "USD"),
        eventId,
        provider: "stripe",
        referenceId: "user_1",
        sessionId: "pi_1",
        type: "payment.captured",
    };
};

describe("applyWebhookAction", () => {
    it("captures a payment and dedupes by event id", async () => {
        const store = new MemoryPaymentStore();

        await expect(applyWebhookAction(store, captureEvent("evt_1"))).resolves.toEqual({ applied: true, reason: "ok" });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
        expect(session?.capturedAmount.minorUnits).toBe(1000n);

        await expect(applyWebhookAction(store, captureEvent("evt_1"))).resolves.toEqual({ applied: false, reason: "duplicate" });
    });

    it("drops an illegal transition as a no-op", async () => {
        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, captureEvent("evt_1"));

        const failed = await applyWebhookAction(store, {
            eventId: "evt_2",
            provider: "stripe",
            referenceId: "user_1",
            sessionId: "pi_1",
            type: "payment.failed",
        });

        expect(failed).toEqual({ applied: false, reason: "illegal_transition" });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
    });

    it("records a partial then a full refund", async () => {
        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, captureEvent("evt_1"));

        const partial = await applyWebhookAction(store, {
            amount: money(400, "USD"),
            eventId: "evt_2",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        expect(partial.applied).toBe(true);

        let session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("partially_refunded");
        expect(session?.refundedAmount.minorUnits).toBe(400n);

        const full = await applyWebhookAction(store, {
            amount: money(600, "USD"),
            eventId: "evt_3",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        expect(full.applied).toBe(true);

        session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("refunded");
        expect(session?.refundedAmount.minorUnits).toBe(1000n);
    });

    it("creates then cancels a subscription", async () => {
        const store = new MemoryPaymentStore();

        const created = await applyWebhookAction(store, {
            eventId: "e1",
            priceId: "price_1",
            provider: "stripe",
            quantity: 1,
            referenceId: "user_1",
            subscriptionId: "sub_1",
            type: "subscription.active",
        });

        expect(created.applied).toBe(true);

        const active = await store.getSubscription("stripe", "sub_1");

        expect(active?.state).toBe("active");

        const canceled = await applyWebhookAction(store, {
            eventId: "e2",
            provider: "stripe",
            subscriptionId: "sub_1",
            type: "subscription.canceled",
        });

        expect(canceled.applied).toBe(true);

        const afterCancel = await store.getSubscription("stripe", "sub_1");

        expect(afterCancel?.state).toBe("canceled");
        await expect(store.listSubscriptionsByReference("user_1")).resolves.toHaveLength(1);
    });

    it("ignores unhandled actions without consuming the event id", async () => {
        const store = new MemoryPaymentStore();

        await expect(applyWebhookAction(store, { eventId: "e1", provider: "stripe", type: "unhandled" })).resolves.toEqual({
            applied: false,
            reason: "unhandled",
        });
    });
});
