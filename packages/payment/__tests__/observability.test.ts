import { describe, expect, it } from "vitest";

import type { PaymentAdapter } from "../src/adapter";
import { money } from "../src/money";
import type { PaymentEvent } from "../src/observability";
import { reconcile } from "../src/reconcile";
import { MemoryPaymentStore } from "../src/store";
import applyWebhookAction from "../src/sync";
import type { Subscription, WebhookAction } from "../src/types";

describe("observability hook", () => {
    it("emits webhook.applied and a payment.failed alert", async () => {
        const events: PaymentEvent[] = [];
        const store = new MemoryPaymentStore();

        const action: WebhookAction = { eventId: "evt_1", provider: "stripe", referenceId: "user_1", sessionId: "pi_1", type: "payment.failed" };

        await applyWebhookAction(store, action, (event) => events.push(event));

        expect(events.map((event) => event.type)).toEqual(["webhook.applied", "payment.failed"]);
        expect(events[1]).toMatchObject({ provider: "stripe", referenceId: "user_1", sessionId: "pi_1" });
    });

    it("emits webhook.duplicate on a replayed event", async () => {
        const events: PaymentEvent[] = [];
        const store = new MemoryPaymentStore();
        const observer = (event: PaymentEvent): void => {
            events.push(event);
        };
        const capture: WebhookAction = { amount: money(1000, "USD"), eventId: "evt_1", provider: "stripe", sessionId: "pi_1", type: "payment.captured" };

        await applyWebhookAction(store, capture, observer);
        await applyWebhookAction(store, capture, observer);

        expect(events.map((event) => event.type)).toEqual(["webhook.applied", "webhook.duplicate"]);
    });

    it("never lets a throwing observer break the flow", async () => {
        const store = new MemoryPaymentStore();
        const action: WebhookAction = { amount: money(1000, "USD"), eventId: "evt_1", provider: "stripe", sessionId: "pi_1", type: "payment.captured" };

        const result = await applyWebhookAction(store, action, () => {
            throw new Error("metrics sink down");
        });

        expect(result).toEqual({ applied: true, reason: "ok" });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
    });

    it("emits reconcile.drift per repaired row and reconcile.completed once", async () => {
        const events: PaymentEvent[] = [];
        const store = new MemoryPaymentStore();

        await store.upsertSubscription({
            cancelAtPeriodEnd: false,
            createdAt: 1,
            id: "sub_1",
            priceId: "price_1",
            provider: "stripe",
            quantity: 1,
            referenceId: "user_1",
            state: "past_due",
            updatedAt: 1,
        });

        const adapter = {
            getSubscriptionStatus: async (): Promise<Subscription> => {
                return {
                    cancelAtPeriodEnd: false,
                    createdAt: 1,
                    id: "sub_1",
                    priceId: "price_1",
                    provider: "stripe",
                    quantity: 1,
                    referenceId: "user_1",
                    state: "active",
                    updatedAt: 2,
                };
            },
            identifier: "stripe",
        } as unknown as PaymentAdapter;

        await reconcile({ adapter, observability: (event) => events.push(event), store, subscriptionIds: ["sub_1"] });

        expect(events.map((event) => event.type)).toEqual(["reconcile.drift", "reconcile.completed"]);
        expect(events[1]).toMatchObject({ type: "reconcile.completed", updatedSubscriptions: 1 });
    });
});
