import type { Stripe } from "stripe";
import { describe, expect, it } from "vitest";

import { createStripeAdapter } from "../../src/providers/stripe";

interface RecordedCall {
    args: unknown[];
    name: string;
}

/** A non-empty `stripe-signature` header — the fake `constructEventAsync` only checks for presence. */
const webhookHeaders = { get: (name: string): null | string => (name === "stripe-signature" ? "t=1,v1=sig" : null) };

/**
 * A structural fake cast to the real `Stripe` type. `webhooks.constructEventAsync` stands in for the
 * SDK's signature verification: it throws when the signature header is empty, else parses the body.
 */
const makeClient = (calls: RecordedCall[]): Stripe =>
    ({
        billing: {
            meterEvents: {
                create: async (parameters: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
                    calls.push({ args: [parameters, options], name: "meterEvent" });

                    return { identifier: "mev_1" };
                },
            },
        },
        billingPortal: {
            sessions: {
                create: async (parameters: Record<string, unknown>) => {
                    calls.push({ args: [parameters], name: "portal" });

                    return { url: "https://portal.test" };
                },
            },
        },
        checkout: {
            sessions: {
                create: async (parameters: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
                    calls.push({ args: [parameters, options], name: "checkout" });

                    return { id: "cs_1", url: "https://checkout.test" };
                },
            },
        },
        customers: {
            create: async (parameters: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
                calls.push({ args: [parameters, options], name: "customer" });

                return { email: "a@b.test", id: "cus_1" };
            },
        },
        paymentIntents: {
            cancel: async (id: string) => {
                return { amount: 1000, currency: "usd", id, status: "canceled" };
            },
            capture: async (id: string, parameters?: unknown, options?: unknown) => {
                calls.push({ args: [id, parameters, options], name: "capture" });

                return { amount: 1000, amount_received: 1000, currency: "usd", id, status: "succeeded" };
            },
            retrieve: async (id: string) => {
                return { amount: 1000, amount_received: 1000, currency: "usd", id, status: "succeeded" };
            },
        },
        refunds: {
            create: async (parameters: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
                calls.push({ args: [parameters, options], name: "refund" });

                return { id: "re_1" };
            },
        },
        subscriptions: {
            cancel: async (id: string) => {
                return { id, metadata: { referenceId: "user_1" }, status: "canceled" };
            },
            retrieve: async (id: string) => {
                return { id, items: { data: [{ id: "si_1", price: { id: "price_1" }, quantity: 1 }] }, metadata: { referenceId: "user_1" }, status: "active" };
            },
            update: async (id: string, parameters?: unknown, options?: unknown) => {
                calls.push({ args: [id, parameters, options], name: "sub.update" });

                return { id, items: { data: [{ price: { id: "price_1" }, quantity: 2 }] }, metadata: { referenceId: "user_1" }, status: "active" };
            },
        },
        webhooks: {
            constructEventAsync: async (payload: string, signature: string) => {
                if (!signature) {
                    throw new Error("No signatures found matching the expected signature for payload");
                }

                return JSON.parse(payload) as unknown;
            },
        },
    }) as unknown as Stripe;

describe("stripe adapter", () => {
    it("forwards an idempotency key and reference metadata on checkout", async () => {
        expect.assertions(3);

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

    it("never lets caller metadata override the framework referenceId on checkout", async () => {
        expect.assertions(1);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        await adapter.createCheckout({
            cancelUrl: "https://x/cancel",
            metadata: { referenceId: "victim" },
            mode: "subscription",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        const checkout = calls.find((call) => call.name === "checkout");

        // The framework's referenceId wins over the caller-supplied override.
        expect((checkout?.args[0] as { metadata?: Record<string, string> }).metadata?.referenceId).toBe("user_1");
    });

    it("maps a captured intent to a payment session", async () => {
        expect.assertions(2);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const session = await adapter.capturePayment({ sessionId: "pi_1" });

        expect(session.state).toBe("captured");
        expect(session.capturedAmount.minorUnits).toBe(1000n);
    });

    it("normalizes a verified payment_intent.succeeded webhook", async () => {
        expect.assertions(4);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const event = {
            data: { object: { amount: 2000, amount_received: 2000, currency: "usd", customer: "cus_1", id: "pi_1", metadata: { referenceId: "user_1" } } },
            id: "evt_1",
            type: "payment_intent.succeeded",
        };
        const action = await adapter.parseWebhook({ headers: webhookHeaders, payload: JSON.stringify(event) });

        expect(action.type).toBe("payment.captured");
        expect(action.sessionId).toBe("pi_1");
        expect(action.referenceId).toBe("user_1");
        expect(action.amount?.minorUnits).toBe(2000n);
    });

    it("tags charge.refunded as an absolute (cumulative) refund total", async () => {
        expect.assertions(4);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const event = {
            data: { object: { amount_refunded: 700, currency: "usd", id: "ch_1", payment_intent: "pi_1" } },
            id: "evt_refund",
            type: "charge.refunded",
        };
        const action = await adapter.parseWebhook({ headers: webhookHeaders, payload: JSON.stringify(event) });

        expect(action.type).toBe("payment.refunded");
        expect(action.amountKind).toBe("absolute");
        expect(action.sessionId).toBe("pi_1");
        expect(action.amount?.minorUnits).toBe(700n);
    });

    it("maps an `incomplete` subscription to a non-entitling state, not an active grant (regression)", async () => {
        expect.assertions(1);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const event = {
            data: {
                object: {
                    customer: "cus_1",
                    id: "sub_1",
                    items: { data: [{ price: { id: "price_1" }, quantity: 1 }] },
                    metadata: { referenceId: "user_1" },
                    status: "incomplete",
                },
            },
            id: "evt_incomplete",
            type: "customer.subscription.created",
        };
        const action = await adapter.parseWebhook({ headers: webhookHeaders, payload: JSON.stringify(event) });

        // `incomplete` = first payment not completed → must NOT be the entitling
        // `subscription.active` (ACTIVE_STATES) — it is non-entitling `past_due`.
        expect(action.type).toBe("subscription.past_due");
    });

    it("reads the billing period from the subscription item, not the top level (Stripe basil) (regression)", async () => {
        expect.assertions(2);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const start = 1_750_000_000;
        const end = 1_752_592_000;
        const event = {
            data: {
                object: {
                    customer: "cus_1",
                    id: "sub_1",
                    items: { data: [{ current_period_end: end, current_period_start: start, price: { id: "price_1" }, quantity: 1 }] },
                    metadata: { referenceId: "user_1" },
                    status: "active",
                },
            },
            id: "evt_period",
            type: "customer.subscription.updated",
        };
        const action = await adapter.parseWebhook({ headers: webhookHeaders, payload: JSON.stringify(event) });

        // API 2025-03-31.basil moved current_period_* onto the item — they must still surface (in ms).
        expect(action.currentPeriodStart).toBe(start * 1000);
        expect(action.currentPeriodEnd).toBe(end * 1000);
    });

    it("does not mark an `unpaid` subscription checkout active (regression)", async () => {
        expect.assertions(1);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const event = {
            data: { object: { customer: "cus_1", id: "cs_1", mode: "subscription", payment_status: "unpaid", subscription: "sub_1" } },
            id: "evt_cs_unpaid",
            type: "checkout.session.completed",
        };
        const action = await adapter.parseWebhook({ headers: webhookHeaders, payload: JSON.stringify(event) });

        // An unpaid subscription checkout must not assert `subscription.active`.
        expect(action.type).toBe("subscription.updated");
    });

    it("rejects an unsigned webhook", async () => {
        expect.assertions(1);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        await expect(adapter.parseWebhook({ headers: { get: () => null }, payload: "{}" })).rejects.toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
    });

    it("reports usage as a meter event keyed on the customer and idempotency key", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        await adapter.reportUsage?.({ customerId: "cus_1", featureId: "api_calls", idempotencyKey: "usage_1", quantity: 5, referenceId: "user_1" });

        const meterEvent = calls.find((call) => call.name === "meterEvent");
        const parameters = meterEvent?.args[0] as { event_name?: string; identifier?: string; payload?: Record<string, unknown> };

        expect(parameters.event_name).toBe("api_calls");
        expect(parameters.identifier).toBe("usage_1");
        expect(parameters.payload).toMatchObject({ stripe_customer_id: "cus_1", value: "5" });
        expect((meterEvent?.args[1] as { idempotencyKey?: string }).idempotencyKey).toBe("usage_1");
    });
});
