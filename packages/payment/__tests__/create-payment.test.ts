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

describe("createPayment — attach / check / track", () => {
    const entitlements = { plans: { pro: { features: ["export"], limits: { api_calls: 100 }, priceIds: ["price_1"] } } };

    const activeSubscription = (referenceId: string): Subscription => {
        return { ...subscription(referenceId, "active"), currentPeriodStart: 1000 };
    };

    it("attach defaults mode to subscription", async () => {
        const payment = createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() });

        const result = await payment.attach({ cancelUrl: "https://x/cancel", priceId: "price_1", referenceId: "user_1", successUrl: "https://x/ok" });

        expect(result.url).toBe("https://pay.test/checkout:stripe:user_1:price_1:subscription");
    });

    it("attach honors an explicit one-time payment mode", async () => {
        const payment = createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() });

        const result = await payment.attach({
            cancelUrl: "https://x/cancel",
            mode: "payment",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result.url).toBe("https://pay.test/checkout:stripe:user_1:price_1:payment");
    });

    it("check throws when entitlements are not configured", async () => {
        const payment = createPayment({ adapter: fakeAdapter(), store: new MemoryPaymentStore() });

        await expect(payment.check({ featureId: "export", referenceId: "user_1" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });

    it("check grants an unlimited boolean feature from an active plan", async () => {
        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store });

        await expect(payment.check({ featureId: "export", referenceId: "user_1" })).resolves.toEqual({ allowed: true, unlimited: true });
    });

    it("check denies a feature no active plan grants", async () => {
        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store: new MemoryPaymentStore() });

        await expect(payment.check({ featureId: "export", referenceId: "user_1" })).resolves.toEqual({ allowed: false, unlimited: false });
    });

    it("check subtracts tracked usage from a metered limit", async () => {
        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store });

        await payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 30, referenceId: "user_1" });

        await expect(payment.check({ featureId: "api_calls", quantity: 10, referenceId: "user_1" })).resolves.toEqual({
            allowed: true,
            balance: 70,
            limit: 100,
            unlimited: false,
            used: 30,
        });
        await expect(payment.check({ featureId: "api_calls", quantity: 71, referenceId: "user_1" })).resolves.toMatchObject({ allowed: false, balance: 70 });
    });

    it("track records usage exactly once per idempotency key", async () => {
        const store = new MemoryPaymentStore();
        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: async () => undefined }), store });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: true,
            reportedToProvider: true,
        });
        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: false,
            reportedToProvider: false,
        });
        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(5);
    });

    it("track records locally even when the provider report fails, and observes it", async () => {
        const store = new MemoryPaymentStore();
        const events: string[] = [];
        const payment = createPayment({
            adapter: fakeAdapter({
                reportUsage: async () => {
                    throw new Error("provider down");
                },
            }),
            observability: (event) => events.push(event.type),
            store,
        });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: true,
            reportedToProvider: false,
        });
        expect(events).toContain("usage.report_failed");
        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(5);
    });

    it("track skips provider reporting when the adapter has no reportUsage", async () => {
        const store = new MemoryPaymentStore();
        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), store });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: true,
            reportedToProvider: false,
        });
    });

    it("track mode:set reconciles the period total via a delta", async () => {
        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter({ reportUsage: undefined }), entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 30, referenceId: "user_1" });
        await payment.track({ featureId: "api_calls", mode: "set", quantity: 50, referenceId: "user_1" });

        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ balance: 50, used: 50 });

        // A downward "set" stays local (provider meters are additive) but still corrects the ledger.
        await payment.track({ featureId: "api_calls", mode: "set", quantity: 10, referenceId: "user_1" });

        await expect(payment.check({ featureId: "api_calls", referenceId: "user_1" })).resolves.toMatchObject({ balance: 90, used: 10 });
    });

    it("track on a provider without usage metering (Creem-style) records locally only", async () => {
        const store = new MemoryPaymentStore();
        const reported: number[] = [];
        const payment = createPayment({
            adapter: fakeAdapter({
                capabilities: { merchantOfRecord: true, portal: true, usageMetering: false },
                reportUsage: async (input) => {
                    reported.push(input.quantity);
                },
            }),
            store,
        });

        await expect(payment.track({ featureId: "api_calls", idempotencyKey: "u1", quantity: 5, referenceId: "user_1" })).resolves.toEqual({
            recorded: true,
            reportedToProvider: false,
        });
        expect(reported).toHaveLength(0);
        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(5);
    });

    it("check by priceId answers product access", async () => {
        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), store });

        await expect(payment.check({ priceId: "price_1", referenceId: "user_1" })).resolves.toEqual({ allowed: true, unlimited: false });
        await expect(payment.check({ priceId: "price_absent", referenceId: "user_1" })).resolves.toEqual({ allowed: false, unlimited: false });
    });

    it("check throws when given neither a featureId nor a priceId", async () => {
        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store: new MemoryPaymentStore() });

        await expect(payment.check({ referenceId: "user_1" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    });

    it("listBalances resolves every configured feature in one call", async () => {
        const store = new MemoryPaymentStore();

        await store.upsertSubscription(activeSubscription("user_1"));

        const payment = createPayment({ adapter: fakeAdapter(), entitlements, store });

        await payment.track({ featureId: "api_calls", quantity: 30, referenceId: "user_1" });

        await expect(payment.listBalances("user_1")).resolves.toEqual([
            { allowed: true, balance: 70, featureId: "api_calls", limit: 100, unlimited: false, used: 30 },
            { allowed: true, featureId: "export", unlimited: true },
        ]);
    });
});
