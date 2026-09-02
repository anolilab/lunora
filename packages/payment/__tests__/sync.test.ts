import { describe, expect, it } from "vitest";

import { LunoraPaymentError } from "../src/errors";
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
        expect.assertions(4);

        const store = new MemoryPaymentStore();

        await expect(applyWebhookAction(store, captureEvent("evt_1"))).resolves.toEqual({ applied: true, reason: "ok" });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
        expect(session?.capturedAmount.minorUnits).toBe(1000n);

        await expect(applyWebhookAction(store, captureEvent("evt_1"))).resolves.toEqual({ applied: false, reason: "duplicate" });
    });

    it("drops an illegal transition as a no-op", async () => {
        expect.assertions(2);

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

    it("treats Stripe-style cumulative (absolute) refunds without over-counting across partials", async () => {
        expect.assertions(5);

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, captureEvent("evt_1"));

        // Stripe `charge.refunded` carries the CUMULATIVE `amount_refunded`. First partial: 400.
        const first = await applyWebhookAction(store, {
            amount: money(400, "USD"),
            amountKind: "absolute",
            eventId: "evt_2",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        expect(first.applied).toBe(true);

        let session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.refundedAmount.minorUnits).toBe(400n);

        // Second partial refund of 300 — Stripe reports the cumulative total 700, NOT the 300 delta.
        // A delta-summing layer would land on 400+700=1100 (over-count, over-refund). Absolute lands on 700.
        const second = await applyWebhookAction(store, {
            amount: money(700, "USD"),
            amountKind: "absolute",
            eventId: "evt_3",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        expect(second.applied).toBe(true);

        session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.refundedAmount.minorUnits).toBe(700n);
        expect(session?.state).toBe("partially_refunded");
    });

    it("ignores a stale/duplicate cumulative refund that would move the total backward", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, captureEvent("evt_1"));

        await applyWebhookAction(store, {
            amount: money(700, "USD"),
            amountKind: "absolute",
            eventId: "evt_2",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        // A re-delivered earlier cumulative total (400) must not lower the running refunded total.
        const stale = await applyWebhookAction(store, {
            amount: money(400, "USD"),
            amountKind: "absolute",
            eventId: "evt_3",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        expect(stale.applied).toBe(true);

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.refundedAmount.minorUnits).toBe(700n);
    });

    it("re-processes an event after an apply failure rolled back the claim (no poison pill)", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, captureEvent("evt_1"));

        let failNextUpsert = true;
        const original = store.upsertPaymentSession.bind(store);

        store.upsertPaymentSession = (session) => {
            if (failNextUpsert) {
                failNextUpsert = false;

                return Promise.reject(new Error("store write failed"));
            }

            return original(session);
        };

        const refund: WebhookAction = {
            amount: money(400, "USD"),
            eventId: "evt_2",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        };

        // First delivery: apply throws (store failure) → claim is released and the error propagates.
        await expect(applyWebhookAction(store, refund)).rejects.toThrow("store write failed");

        const afterFailure = await store.getPaymentSession("stripe", "pi_1");

        expect(afterFailure?.refundedAmount.minorUnits).toBe(0n);

        // Provider retry of the SAME event id is NOT deduped (claim was rolled back) and now applies.
        const retry = await applyWebhookAction(store, refund);

        expect(retry).toEqual({ applied: true, reason: "ok" });

        const afterRetry = await store.getPaymentSession("stripe", "pi_1");

        expect(afterRetry?.refundedAmount.minorUnits).toBe(400n);
    });

    it("records a partial then a full refund", async () => {
        expect.assertions(6);

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

    it("rejects an over-refund without mutating state and still applies a valid partial refund", async () => {
        expect.assertions(6);

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, captureEvent("evt_1"));

        const overRefund = await applyWebhookAction(store, {
            amount: money(1500, "USD"),
            eventId: "evt_2",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        expect(overRefund).toEqual({ applied: false, reason: "invalid_refund_amount" });

        let session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
        expect(session?.refundedAmount.minorUnits).toBe(0n);

        const valid = await applyWebhookAction(store, {
            amount: money(400, "USD"),
            eventId: "evt_3",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        expect(valid.applied).toBe(true);

        session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("partially_refunded");
        expect(session?.refundedAmount.minorUnits).toBe(400n);
    });

    it("treats a refund in a mismatched currency as a clean no-op, not a thrown poison event", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, captureEvent("evt_1"));

        // A refund event whose currency disagrees with the captured currency must not throw
        // CURRENCY_MISMATCH (which would escape past the already-claimed event id and lose the
        // provider's retry) — it resolves to a clean no-op with the captured state intact.
        const mismatched = await applyWebhookAction(store, {
            amount: money(400, "EUR"),
            eventId: "evt_2",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        });

        expect(mismatched).toEqual({ applied: false, reason: "invalid_refund_amount" });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
        expect(session?.refundedAmount.minorUnits).toBe(0n);
    });

    it("creates then cancels a subscription", async () => {
        expect.assertions(5);

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

    it("releases the claim on an orphaned subscription.updated, then gives up rather than retry forever", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        const updated: WebhookAction = {
            eventId: "evt_upd",
            priceId: "price_2",
            provider: "stripe",
            subscriptionId: "sub_1",
            type: "subscription.updated",
        };

        // No row exists yet (out-of-order delivery) — the event is orphaned, not consumed.
        await expect(applyWebhookAction(store, updated)).resolves.toEqual({ applied: false, reason: "orphaned" });

        // The claim was released, so the provider's retry re-processes rather than deduping — and
        // it is re-attempted here (the ordering-repair test covers it succeeding once the row lands).
        // With the row still missing, the retry is the LAST one: a row that never appears
        // (subscription predating the integration, a store reset) stops 500ing before the provider
        // disables the endpoint.
        await expect(applyWebhookAction(store, updated)).resolves.toEqual({ applied: false, reason: "unhandled" });

        // And it stays given-up: the claim is kept, so further redeliveries are acknowledged.
        await expect(applyWebhookAction(store, updated)).resolves.toEqual({ applied: false, reason: "duplicate" });
    });

    it("applies an out-of-order subscription.updated once the create event lands (ordering repair)", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        const updated: WebhookAction = {
            eventId: "evt_upd",
            priceId: "price_2",
            provider: "stripe",
            quantity: 3,
            subscriptionId: "sub_1",
            type: "subscription.updated",
        };

        // The update arrives before the subscription exists — orphaned, claim released.
        await expect(applyWebhookAction(store, updated)).resolves.toEqual({ applied: false, reason: "orphaned" });

        // The create event lands, then the provider's retry of the update applies it.
        await applyWebhookAction(store, {
            eventId: "evt_create",
            priceId: "price_1",
            provider: "stripe",
            quantity: 1,
            referenceId: "user_1",
            subscriptionId: "sub_1",
            type: "subscription.active",
        });

        await expect(applyWebhookAction(store, updated)).resolves.toEqual({ applied: true, reason: "ok" });

        const subscription = await store.getSubscription("stripe", "sub_1");

        expect(subscription).toMatchObject({ priceId: "price_2", quantity: 3, state: "active" });
    });

    it("applies a subscription.updated normally when the row exists", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, {
            eventId: "e1",
            priceId: "price_1",
            provider: "stripe",
            quantity: 1,
            referenceId: "user_1",
            subscriptionId: "sub_1",
            type: "subscription.active",
        });

        await expect(
            applyWebhookAction(store, {
                cancelAtPeriodEnd: true,
                eventId: "e2",
                provider: "stripe",
                subscriptionId: "sub_1",
                type: "subscription.updated",
            }),
        ).resolves.toEqual({ applied: true, reason: "ok" });

        const subscription = await store.getSubscription("stripe", "sub_1");

        expect(subscription?.cancelAtPeriodEnd).toBe(true);
    });

    it("retries an out-of-order refund-before-capture instead of losing it", async () => {
        expect.assertions(5);

        const store = new MemoryPaymentStore();
        const refund: WebhookAction = {
            amount: money(400, "USD"),
            eventId: "evt_refund",
            provider: "stripe",
            referenceId: "user_1",
            sessionId: "pi_1",
            type: "payment.refunded",
        };

        // The refund webhook arrives first (Stripe does not guarantee ordering). It is out-of-order,
        // not illegal: report `orphaned` so the claim is released and the provider redelivers —
        // dropping it would burn the event id and lose the refund for good.
        await expect(applyWebhookAction(store, refund)).resolves.toEqual({ applied: false, reason: "orphaned" });

        // The capture lands.
        await expect(applyWebhookAction(store, captureEvent("evt_capture"))).resolves.toEqual({ applied: true, reason: "ok" });

        // The redelivery is NOT deduped away, and now applies.
        await expect(applyWebhookAction(store, refund)).resolves.toEqual({ applied: true, reason: "ok" });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("partially_refunded");
        expect(session?.refundedAmount.minorUnits).toBe(400n);
    });

    it("bounds the refund-before-capture retry to one redelivery", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const refund: WebhookAction = {
            amount: money(400, "USD"),
            eventId: "evt_refund",
            provider: "stripe",
            sessionId: "pi_1",
            type: "payment.refunded",
        };

        await expect(applyWebhookAction(store, refund)).resolves.toEqual({ applied: false, reason: "orphaned" });

        // The capture never arrives (a payment made before the integration existed, a store reset).
        // The second sighting keeps the claim and acknowledges, so the provider stops retrying rather
        // than hammering the endpoint until it disables it.
        await expect(applyWebhookAction(store, refund)).resolves.toEqual({ applied: false, reason: "unhandled" });
    });

    it("ignores unhandled actions without consuming the event id", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await expect(applyWebhookAction(store, { eventId: "e1", provider: "stripe", type: "unhandled" })).resolves.toEqual({
            applied: false,
            reason: "unhandled",
        });
    });

    it("rejects a blank event id before it ever reaches the dedupe store (no poison pill)", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        await expect(applyWebhookAction(store, captureEvent(""))).rejects.toMatchObject({
            code: "WEBHOOK_EVENT_ID_MISSING",
        });

        // The blank id must never have been claimed — otherwise every SUBSEQUENT event with a blank
        // id (e.g. from a provider whose id field name drifted) would be misclassified "duplicate".
        await expect(applyWebhookAction(store, captureEvent(""))).rejects.toBeInstanceOf(LunoraPaymentError);

        // A whitespace-only id is rejected the same way as an empty one.
        await expect(applyWebhookAction(store, captureEvent("   "))).rejects.toMatchObject({
            code: "WEBHOOK_EVENT_ID_MISSING",
        });
    });

    it("still applies a normal event exactly once after a blank-id event was rejected", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        await expect(applyWebhookAction(store, captureEvent(""))).rejects.toMatchObject({ code: "WEBHOOK_EVENT_ID_MISSING" });

        await expect(applyWebhookAction(store, captureEvent("evt_1"))).resolves.toEqual({ applied: true, reason: "ok" });
    });
});
