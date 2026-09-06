import type { Stripe } from "stripe";
import { describe, expect, it } from "vitest";

import { money } from "../../src/money";
import type { StripeClientLike } from "../../src/providers/stripe";
import { createStripeAdapter } from "../../src/providers/stripe";
import { MemoryPaymentStore } from "../../src/store";
import applyWebhookAction from "../../src/sync";

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
            cancel: async (id: string, parameters?: unknown, options?: { idempotencyKey?: string }) => {
                calls.push({ args: [id, parameters, options], name: "sub.cancel" });

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

    it("keys a payment-mode completed session on the payment intent id", async () => {
        expect.assertions(2);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const event = {
            data: {
                object: { amount_total: 1000, currency: "usd", customer: "cus_1", id: "cs_1", mode: "payment", payment_intent: "pi_1", payment_status: "paid" },
            },
            id: "evt_cs_paid",
            type: "checkout.session.completed",
        };
        const action = await adapter.parseWebhook({ headers: webhookHeaders, payload: JSON.stringify(event) });

        expect(action.type).toBe("payment.captured");
        expect(action.sessionId).toBe("pi_1");
    });

    it("still captures a fully discounted session, which never gets a payment intent (regression)", async () => {
        expect.assertions(3);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        // A 100%-off session settles as `no_payment_required` and Stripe creates NO PaymentIntent,
        // so deferring would drop the order entirely — it keeps the cs_… id it will always have.
        const action = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: {
                    object: {
                        amount_total: 0,
                        currency: "usd",
                        customer: "cus_1",
                        id: "cs_free",
                        metadata: { referenceId: "user_1" },
                        mode: "payment",
                        payment_status: "no_payment_required",
                    },
                },
                id: "evt_cs_free",
                type: "checkout.session.completed",
            }),
        });

        expect(action.type).toBe("payment.captured");
        expect(action.sessionId).toBe("cs_free");
        expect(action.referenceId).toBe("user_1");
    });

    it("defers a completed session without a payment_intent to payment_intent.succeeded (regression)", async () => {
        expect.assertions(4);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        // Async payment methods (SEPA, ACH) can complete the session before the intent id is
        // attached — capturing under the cs_… id would double-count once pi_… lands.
        const completed = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: { object: { amount_total: 1000, currency: "usd", customer: "cus_1", id: "cs_1", mode: "payment", payment_status: "unpaid" } },
                id: "evt_cs_async",
                type: "checkout.session.completed",
            }),
        });

        expect(completed.type).toBe("unhandled");

        const succeeded = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: { object: { amount_received: 1000, currency: "usd", customer: "cus_1", id: "pi_1", metadata: { referenceId: "user_1" } } },
                id: "evt_pi_async",
                type: "payment_intent.succeeded",
            }),
        });

        expect(succeeded.sessionId).toBe("pi_1");

        // Apply both: exactly one captured row, keyed on the pi_… id.
        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, completed);
        await applyWebhookAction(store, succeeded);

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
        await expect(store.getPaymentSession("stripe", "cs_1")).resolves.toBeUndefined();
    });

    it("records an unpaid delayed-notification session as authorized, not captured (regression)", async () => {
        expect.assertions(4);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        // SEPA/ACH/Boleto/OXXO complete the session with `payment_status: "unpaid"` while the
        // PaymentIntent is still `processing` — the money has NOT settled. Recording that as
        // `captured` is irreversible: the FSM has no edge off `captured` except a refund.
        const completed = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: {
                    object: {
                        amount_total: 250_000,
                        currency: "eur",
                        customer: "cus_1",
                        id: "cs_sepa",
                        metadata: { referenceId: "user_1" },
                        mode: "payment",
                        payment_intent: "pi_sepa",
                        payment_status: "unpaid",
                    },
                },
                id: "evt_cs_sepa",
                type: "checkout.session.completed",
            }),
        });

        expect(completed.type).toBe("payment.authorized");

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, completed);

        const session = await store.getPaymentSession("stripe", "pi_sepa");

        expect(session?.state).toBe("authorized");
        expect(session?.capturedAmount).toStrictEqual(money(0n, "eur"));
        expect(session?.amount).toStrictEqual(money(250_000n, "eur"));
    });

    it("captures a delayed-notification session on async_payment_succeeded (regression)", async () => {
        expect.assertions(3);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });
        const session = {
            amount_total: 250_000,
            currency: "eur",
            customer: "cus_1",
            id: "cs_sepa",
            metadata: { referenceId: "user_1" },
            mode: "payment",
            payment_intent: "pi_sepa",
        };

        const completed = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({ data: { object: { ...session, payment_status: "unpaid" } }, id: "evt_cs_sepa", type: "checkout.session.completed" }),
        });

        // Settlement arrives on its own event; the session is now `paid`.
        const settled = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: { object: { ...session, payment_status: "paid" } },
                id: "evt_cs_sepa_ok",
                type: "checkout.session.async_payment_succeeded",
            }),
        });

        expect(settled.type).toBe("payment.captured");

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, completed);
        await applyWebhookAction(store, settled);

        const row = await store.getPaymentSession("stripe", "pi_sepa");

        expect(row?.state).toBe("captured");
        expect(row?.capturedAmount).toStrictEqual(money(250_000n, "eur"));
    });

    it("fails a delayed-notification session on async_payment_failed (regression)", async () => {
        expect.assertions(3);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });
        const session = {
            amount_total: 250_000,
            currency: "eur",
            customer: "cus_1",
            id: "cs_sepa",
            metadata: { referenceId: "user_1" },
            mode: "payment",
            payment_intent: "pi_sepa",
            payment_status: "unpaid",
        };

        const completed = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({ data: { object: session }, id: "evt_cs_sepa", type: "checkout.session.completed" }),
        });

        // The debit is returned days later. Nothing else reverses this: the session's own
        // `payment_status` stays `unpaid`, and `charge.refunded` never fires for money that was
        // never captured.
        const failed = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({ data: { object: session }, id: "evt_cs_sepa_fail", type: "checkout.session.async_payment_failed" }),
        });

        expect(failed.type).toBe("payment.failed");

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, completed);

        const result = await applyWebhookAction(store, failed);

        expect(result).toStrictEqual({ applied: true, reason: "ok" });
        await expect(store.getPaymentSession("stripe", "pi_sepa").then((row) => row?.state)).resolves.toBe("failed");
    });

    it("does not entitle an unpaid subscription checkout on async_payment_failed (regression)", async () => {
        expect.assertions(1);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const failed = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: { object: { customer: "cus_1", id: "cs_sub", mode: "subscription", payment_status: "unpaid", subscription: "sub_1" } },
                id: "evt_cs_sub_fail",
                type: "checkout.session.async_payment_failed",
            }),
        });

        // The first invoice never settled — non-entitling, and an alertable dunning signal.
        expect(failed.type).toBe("subscription.past_due");
    });

    it("reverses a captured payment when a chargeback is lost (regression)", async () => {
        expect.assertions(4);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const captured = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: { object: { amount: 5000, amount_received: 5000, currency: "usd", customer: "cus_1", id: "pi_1", metadata: { referenceId: "user_1" } } },
                id: "evt_pi_ok",
                type: "payment_intent.succeeded",
            }),
        });

        // Stripe is not merchant-of-record: on a lost dispute the merchant loses the funds, but the
        // PaymentIntent stays `succeeded` and no refund event is emitted — so neither webhooks nor
        // `reconcile` would ever move the row off `captured` without this mapping.
        const lost = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: { object: { amount: 5000, charge: "ch_1", currency: "usd", id: "dp_1", payment_intent: "pi_1", status: "lost" } },
                id: "evt_dispute_lost",
                type: "charge.dispute.closed",
            }),
        });

        expect(lost.type).toBe("payment.refunded");
        expect(lost.sessionId).toBe("pi_1");

        const store = new MemoryPaymentStore();

        await applyWebhookAction(store, captured);
        await applyWebhookAction(store, lost);

        const row = await store.getPaymentSession("stripe", "pi_1");

        expect(row?.state).toBe("refunded");
        expect(row?.refundedAmount).toStrictEqual(money(5000n, "usd"));
    });

    it("leaves a won or still-open dispute alone", async () => {
        expect.assertions(2);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const won = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: { object: { amount: 5000, currency: "usd", id: "dp_1", payment_intent: "pi_1", status: "won" } },
                id: "evt_dispute_won",
                type: "charge.dispute.closed",
            }),
        });

        // Funds withdrawn while a dispute is open are provisional — reinstated if it is won.
        const withdrawn = await adapter.parseWebhook({
            headers: webhookHeaders,
            payload: JSON.stringify({
                data: { object: { amount: 5000, currency: "usd", id: "dp_1", payment_intent: "pi_1", status: "under_review" } },
                id: "evt_dispute_withdrawn",
                type: "charge.dispute.funds_withdrawn",
            }),
        });

        expect(won.type).toBe("unhandled");
        expect(withdrawn.type).toBe("unhandled");
    });

    it("rejects an unsigned webhook", async () => {
        expect.assertions(1);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        await expect(adapter.parseWebhook({ headers: { get: () => null }, payload: "{}" })).rejects.toMatchObject({ code: "WEBHOOK_SIGNATURE_INVALID" });
    });

    it("rejects a webhook when the configured secret is empty", async () => {
        expect.assertions(1);

        // A bound-but-empty `STRIPE_WEBHOOK_SECRET` (an unset `.dev.vars` line, a wrangler var set
        // to `""`). The Stripe SDK does not validate the secret, so without the guard this event —
        // which the fake verifier happily parses — would be accepted and granted entitlements.
        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "" });

        await expect(
            adapter.parseWebhook({
                headers: webhookHeaders,
                payload: JSON.stringify({ data: { object: {} }, id: "evt_1", type: "checkout.session.completed" }),
            }),
        ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
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

    it("cancels immediately (no atPeriodEnd) via subscriptions.cancel", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        const subscription = await adapter.cancelSubscription("sub_1", { idempotencyKey: "cancel_1" });

        const call = calls.find((entry) => entry.name === "sub.cancel");

        expect(call?.args[0]).toBe("sub_1");
        expect((call?.args[2] as { idempotencyKey?: string }).idempotencyKey).toBe("cancel_1");
        expect(subscription.state).toBe("canceled");
    });

    it("cancels at period end via subscriptions.update, threading cancel_at_period_end", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        const subscription = await adapter.cancelSubscription("sub_1", { atPeriodEnd: true, idempotencyKey: "cancel_2" });

        const call = calls.find((entry) => entry.name === "sub.update");

        expect(call?.args[0]).toBe("sub_1");
        expect((call?.args[1] as { cancel_at_period_end?: boolean }).cancel_at_period_end).toBe(true);
        expect((call?.args[2] as { idempotencyKey?: string }).idempotencyKey).toBe("cancel_2");
        // The base stub reports status "active" (Stripe keeps the subscription active until the period
        // ends) — pin the actual returned state rather than assuming "canceled".
        expect(subscription.state).toBe("active");
    });

    it("carries a stable idempotency key on resume, distinct from the cancel key", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        await adapter.resumeSubscription("sub_1");

        const call = calls.find((entry) => entry.name === "sub.update");

        // Stable for the logical operation, so a Worker retry replays instead of re-issuing. The
        // operation name must differ from `cancel_subscription` or a resume would replay the cancel.
        expect((call?.args[2] as undefined | { idempotencyKey?: string })?.idempotencyKey).toBe("resume_subscription:stripe:sub_1");
        expect((call?.args[2] as undefined | { idempotencyKey?: string })?.idempotencyKey).not.toBe("cancel_subscription:stripe:sub_1");
    });

    it("lets the caller override the resume idempotency key", async () => {
        expect.assertions(1);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        await adapter.resumeSubscription("sub_1", { idempotencyKey: "resume_2" });

        const call = calls.find((entry) => entry.name === "sub.update");

        expect((call?.args[2] as undefined | { idempotencyKey?: string })?.idempotencyKey).toBe("resume_2");
    });

    it("keys a plan/quantity update on the subscription AND the target plan (proration moves money)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        await adapter.updateSubscription("sub_1", { priceId: "price_new", quantity: 3 });

        const first = calls.find((entry) => entry.name === "sub.update");

        expect((first?.args[2] as undefined | { idempotencyKey?: string })?.idempotencyKey).toBe("update_subscription:stripe:sub_1:price_new:3");

        // A different target is a different logical operation: reusing one key across two parameter
        // sets makes Stripe reject the second call as a mismatch.
        const other: RecordedCall[] = [];

        await createStripeAdapter({ client: makeClient(other), webhookSecret: "whsec" }).updateSubscription("sub_1", { quantity: 3 });

        expect((other.find((entry) => entry.name === "sub.update")?.args[2] as undefined | { idempotencyKey?: string })?.idempotencyKey).toBe(
            "update_subscription:stripe:sub_1::3",
        );
    });

    it("lets the caller override the plan-change idempotency key", async () => {
        expect.assertions(1);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        await adapter.updateSubscription("sub_1", { idempotencyKey: "plan_2", priceId: "price_new" });

        const call = calls.find((entry) => entry.name === "sub.update");

        expect((call?.args[2] as undefined | { idempotencyKey?: string })?.idempotencyKey).toBe("plan_2");
    });

    it("resumes a subscription by toggling cancel_at_period_end back to false", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        const subscription = await adapter.resumeSubscription("sub_1");

        const call = calls.find((entry) => entry.name === "sub.update");

        expect(call?.args[0]).toBe("sub_1");
        // The inverse toggle of cancelSubscription's atPeriodEnd path.
        expect((call?.args[1] as { cancel_at_period_end?: boolean }).cancel_at_period_end).toBe(false);
        expect(subscription.state).toBe("active");
    });

    it("carries the current subscription item id into a plan/quantity update", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        await adapter.updateSubscription("sub_1", { priceId: "price_new", quantity: 3 });

        const call = calls.find((entry) => entry.name === "sub.update");
        const { items } = call?.args[1] as { items?: { id?: string; price?: string; quantity?: number }[] };

        // The retrieved subscription's item id (si_1, from the base retrieve stub) must be carried so
        // Stripe updates the EXISTING item rather than creating a second one.
        expect(items?.[0]?.id).toBe("si_1");
        expect(items?.[0]?.price).toBe("price_new");
        expect(items?.[0]?.quantity).toBe(3);
    });

    it("sends an undefined item id (does not throw) when items.data is empty (degenerate case)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        // A minimal structural client (only the two methods updateSubscription actually calls) —
        // avoids spreading the full `Stripe` class instance just to override one method.
        const client: StripeClientLike = {
            billing: undefined,
            billingPortal: undefined,
            checkout: undefined,
            customers: undefined,
            paymentIntents: undefined,
            refunds: undefined,
            subscriptions: {
                retrieve: async (id: string) => {
                    return { id, items: { data: [] }, metadata: { referenceId: "user_1" }, status: "active" };
                },
                update: async (id: string, parameters?: unknown, options?: unknown) => {
                    calls.push({ args: [id, parameters, options], name: "sub.update" });

                    return { id, items: { data: [] }, metadata: { referenceId: "user_1" }, status: "active" };
                },
            },
            webhooks: undefined,
        };
        const adapter = createStripeAdapter({ client, webhookSecret: "whsec" });

        // Pinning today's actual behaviour (see plan §8): an empty items.data does not throw — it
        // silently sends `id: undefined`, which Stripe would treat as creating a NEW subscription item
        // rather than updating one. This is not fixed here; see the executor's notes.
        await expect(adapter.updateSubscription("sub_1", { priceId: "price_new" })).resolves.toBeDefined();

        const call = calls.find((entry) => entry.name === "sub.update");
        const { items } = call?.args[1] as { items?: { id?: string }[] };

        expect(items?.[0]?.id).toBeUndefined();
    });

    it("refunds the full captured amount (no amount given) as state=refunded", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        const session = await adapter.refundPayment({ sessionId: "pi_1" });

        const call = calls.find((entry) => entry.name === "refund");

        expect((call?.args[0] as { amount?: number }).amount).toBeUndefined();
        expect(session.state).toBe("refunded");
        // capturedAmount comes from the retrieve stub (amount_received: 1000).
        expect(session.refundedAmount.minorUnits).toBe(1000n);
        // Stripe's `Refund.id` — the per-refund identity the facade keys its local marker on.
        expect(session.refundId).toBe("re_1");
    });

    it("refunds a strictly smaller amount as state=partially_refunded", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        const session = await adapter.refundPayment({ amount: money(500n, "usd"), sessionId: "pi_1" });

        const call = calls.find((entry) => entry.name === "refund");

        expect((call?.args[0] as { amount?: number }).amount).toBe(500);
        expect(session.state).toBe("partially_refunded");
        expect(session.refundedAmount.minorUnits).toBe(500n);
    });

    it("refunds an amount equal to the captured charge as state=refunded (boundary)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createStripeAdapter({ client: makeClient(calls), webhookSecret: "whsec" });

        // Equal to the retrieve stub's amount_received (1000) — compareMoney is 0, not < 0, so this
        // must land on the full-refund boundary, not the partial one.
        const session = await adapter.refundPayment({ amount: money(1000n, "usd"), sessionId: "pi_1" });

        const call = calls.find((entry) => entry.name === "refund");

        expect((call?.args[0] as { amount?: number }).amount).toBe(1000);
        expect(session.state).toBe("refunded");
    });

    it("fails closed on an unknown status in the webhook path, for created and updated alike (regression)", async () => {
        expect.assertions(2);

        const adapter = createStripeAdapter({ client: makeClient([]), webhookSecret: "whsec" });

        const unknownStatusEvent = async (type: string) =>
            adapter.parseWebhook({
                headers: webhookHeaders,
                payload: JSON.stringify({
                    data: {
                        object: {
                            customer: "cus_1",
                            id: "sub_1",
                            items: { data: [{ price: { id: "price_1" }, quantity: 1 }] },
                            metadata: { referenceId: "user_1" },
                            status: "some_future_status",
                        },
                    },
                    id: `evt_${type}`,
                    type,
                }),
            });

        // An unmapped status must not reach `stateToEventType` as `undefined`: that degrades to
        // `subscription.updated`, a metadata patch that leaves an existing `active` row entitling.
        const [created, updated] = await Promise.all([
            unknownStatusEvent("customer.subscription.created"),
            unknownStatusEvent("customer.subscription.updated"),
        ]);

        expect(created.type).toBe("subscription.past_due");
        expect(updated.type).toBe("subscription.past_due");
    });

    it("fails closed on an unknown subscription status (regression)", async () => {
        expect.assertions(1);

        const base = makeClient([]) as unknown as Record<string, unknown>;
        const client = {
            ...base,
            subscriptions: {
                ...(base.subscriptions as Record<string, unknown>),
                retrieve: async (id: string) => {
                    return {
                        id,
                        items: { data: [{ price: { id: "price_1" }, quantity: 1 }] },
                        metadata: { referenceId: "user_1" },
                        status: "some_future_status",
                    };
                },
            },
        } as unknown as Stripe;
        const adapter = createStripeAdapter({ client, webhookSecret: "whsec" });

        const subscription = await adapter.getSubscriptionStatus("sub_1");

        // An unrecognized status must map to non-entitling `past_due`, never `active`.
        expect(subscription.state).toBe("past_due");
    });
});
