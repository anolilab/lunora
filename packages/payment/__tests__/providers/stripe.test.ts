import { describe, expect, it } from "vitest";

import type { StripeClientLike } from "../../src/providers/stripe";
import { createStripeAdapter } from "../../src/providers/stripe";
import { hmacSha256Hex } from "../../src/webhook";

interface RecordedCall {
    args: unknown[];
    name: string;
}

const makeClient = (calls: RecordedCall[]): StripeClientLike => {
    return {
        billingPortal: {
            sessions: {
                create: async (parameters) => {
                    calls.push({ args: [parameters], name: "portal" });

                    return { url: "https://portal.test" };
                },
            },
        },
        checkout: {
            sessions: {
                create: async (parameters, options) => {
                    calls.push({ args: [parameters, options], name: "checkout" });

                    return { id: "cs_1", url: "https://checkout.test" };
                },
            },
        },
        customers: {
            create: async (parameters, options) => {
                calls.push({ args: [parameters, options], name: "customer" });

                return { email: "a@b.test", id: "cus_1" };
            },
        },
        paymentIntents: {
            cancel: async (id) => {
                return { amount: 1000, currency: "usd", id, status: "canceled" };
            },
            capture: async (id, parameters, options) => {
                calls.push({ args: [id, parameters, options], name: "capture" });

                return { amount: 1000, amount_received: 1000, currency: "usd", id, status: "succeeded" };
            },
            retrieve: async (id) => {
                return { amount: 1000, amount_received: 1000, currency: "usd", id, status: "succeeded" };
            },
        },
        refunds: {
            create: async (parameters, options) => {
                calls.push({ args: [parameters, options], name: "refund" });

                return { id: "re_1" };
            },
        },
        subscriptions: {
            cancel: async (id) => {
                return { id, metadata: { referenceId: "user_1" }, status: "canceled" };
            },
            retrieve: async (id) => {
                return { id, items: { data: [{ price: { id: "price_1" }, quantity: 1 }] }, metadata: { referenceId: "user_1" }, status: "active" };
            },
            update: async (id, parameters, options) => {
                calls.push({ args: [id, parameters, options], name: "sub.update" });

                return { id, items: { data: [{ price: { id: "price_1" }, quantity: 2 }] }, metadata: { referenceId: "user_1" }, status: "active" };
            },
        },
    };
};

describe("stripe adapter", () => {
    it("forwards an idempotency key and reference metadata on checkout", async () => {
        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        const result = await adapter.createCheckout({
            cancelUrl: "https://x/cancel",
            idempotencyKey: "checkout:stripe:user_1",
            mode: "subscription",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result).toEqual({ id: "cs_1", provider: "stripe", url: "https://checkout.test" });

        const checkout = calls.find((call) => call.name === "checkout");

        expect((checkout?.args[1] as { idempotencyKey?: string }).idempotencyKey).toBe("checkout:stripe:user_1");
        expect((checkout?.args[0] as { metadata?: Record<string, string> }).metadata?.referenceId).toBe("user_1");
    });

    it("maps a captured intent to a payment session", async () => {
        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const session = await adapter.capturePayment({ sessionId: "pi_1" });

        expect(session.state).toBe("captured");
        expect(session.capturedAmount.minorUnits).toBe(1000n);
    });

    it("normalizes a verified payment_intent.succeeded webhook", async () => {
        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const event = {
            data: { object: { amount: 2000, amount_received: 2000, currency: "usd", customer: "cus_1", id: "pi_1", metadata: { referenceId: "user_1" } } },
            id: "evt_1",
            type: "payment_intent.succeeded",
        };
        const payload = JSON.stringify(event);
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = await hmacSha256Hex("whsec", `${String(timestamp)}.${payload}`);
        const signatureHeader = `t=${String(timestamp)},v1=${signature}`;
        const headers = { get: (name: string) => (name === "stripe-signature" ? signatureHeader : null) };

        const action = await adapter.parseWebhook({ headers, payload });

        expect(action.type).toBe("payment.captured");
        expect(action.sessionId).toBe("pi_1");
        expect(action.referenceId).toBe("user_1");
        expect(action.amount?.minorUnits).toBe(2000n);
    });

    it("rejects an unsigned webhook", async () => {
        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        await expect(adapter.parseWebhook({ headers: { get: () => null }, payload: "{}" })).rejects.toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
    });
});
