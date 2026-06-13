import { describe, expect, it } from "vitest";

import type { PaymentAdapter } from "../src/adapter";
import { createPayment } from "../src/create-payment";
import { money } from "../src/money";
import { MemoryPaymentStore } from "../src/store";
import type { Subscription, WebhookAction } from "../src/types";

const subscription = (referenceId: string, state: Subscription["state"]): Subscription => {
    return {
        cancelAtPeriodEnd: false,
        createdAt: 0,
        id: "sub_1",
        priceId: "price_1",
        provider: "stripe",
        quantity: 1,
        referenceId,
        state,
        updatedAt: 0,
    };
};

const fakeAdapter = (overrides: Partial<PaymentAdapter> = {}): PaymentAdapter => {
    return {
        cancelPayment: async () => {
            throw new Error("not used");
        },
        cancelSubscription: async (id) => {
            return { ...subscription("user_1", "canceled"), id };
        },
        capabilities: { merchantOfRecord: false, portal: true, usageMetering: true },
        capturePayment: async () => {
            throw new Error("not used");
        },
        createCheckout: async (input) => {
            return { id: "cs_1", provider: "stripe", url: `https://pay.test/${input.idempotencyKey ?? "none"}` };
        },
        createPortalSession: async () => {
            return { url: "https://portal.test" };
        },
        getOrCreateCustomer: async (ref) => {
            return { createdAt: 0, id: "cus_1", provider: "stripe", referenceId: ref.referenceId };
        },
        getPaymentStatus: async () => {
            throw new Error("not used");
        },
        getSubscriptionStatus: async () => subscription("user_1", "active"),
        identifier: "stripe",
        parseWebhook: async ({ payload }) => JSON.parse(payload) as WebhookAction,
        refundPayment: async () => {
            throw new Error("not used");
        },
        resumeSubscription: async (id) => {
            return { ...subscription("user_1", "active"), id };
        },
        updateSubscription: async (id) => {
            return { ...subscription("user_1", "active"), id };
        },
        ...overrides,
    };
};

describe("createPayment", () => {
    it("derives an outbound idempotency key for checkout", async () => {
        const payment = createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() });

        const result = await payment.createCheckout({
            cancelUrl: "https://x/cancel",
            mode: "subscription",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result.url).toBe("https://pay.test/checkout:stripe:user_1:price_1:subscription");
    });

    it("enforces authorization on the referenceId", async () => {
        const payment = createPayment({
            adapter: fakeAdapter(),
            authorize: (referenceId) => referenceId === "user_1",
            store: new MemoryPaymentStore(),
        });

        await expect(
            payment.createCheckout({
                cancelUrl: "https://x/cancel",
                mode: "payment",
                priceId: "price_1",
                referenceId: "user_2",
                successUrl: "https://x/ok",
            }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects cancelling another caller's subscription (IDOR)", async () => {
        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_2", "active"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: (referenceId) => referenceId === "user_1", store });

        await expect(payment.cancelSubscription("sub_1")).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("cancels an owned subscription and syncs the store", async () => {
        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("user_1", "active"));

        const payment = createPayment({ adapter: fakeAdapter(), authorize: (referenceId) => referenceId === "user_1", store });
        const updated = await payment.cancelSubscription("sub_1");

        expect(updated.state).toBe("canceled");

        const stored = await store.getSubscription("stripe", "sub_1");

        expect(stored?.state).toBe("canceled");
    });

    it("acknowledges a verified webhook with 200 and applies it", async () => {
        const store = new MemoryPaymentStore();
        const action: WebhookAction = {
            amount: money(1000, "USD"),
            eventId: "evt_1",
            provider: "stripe",
            referenceId: "user_1",
            sessionId: "pi_1",
            type: "payment.captured",
        };
        // The real body is opaque provider JSON; the adapter normalizes it into the action.
        const payment = createPayment({ adapter: fakeAdapter({ parseWebhook: async () => action }), store });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ applied: true, reason: "ok" });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
        expect(session?.capturedAmount.minorUnits).toBe(1000n);
    });

    it("returns the error status when webhook verification fails", async () => {
        const adapter = fakeAdapter({
            parseWebhook: async () => {
                const { CirrusPaymentError } = await import("../src/errors");

                throw new CirrusPaymentError("WEBHOOK_SIGNATURE_INVALID", "bad signature");
            },
        });
        const payment = createPayment({ adapter, store: new MemoryPaymentStore() });

        const response = await payment.handleWebhook(new Request("https://app.test/payment/webhook", { body: "{}", method: "POST" }));

        expect(response.status).toBe(400);
    });
});
