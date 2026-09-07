import { createHmac } from "node:crypto";

import DodoPayments from "dodopayments";
import { describe, expect, it } from "vitest";

import type { DodoPaymentsClientLike } from "../../src/providers/dodopayments";
import { createDodoPaymentsAdapter } from "../../src/providers/dodopayments";

const SECRET = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"; // gitleaks:allow -- test fixture signing key, not a real secret

const sign = (id: string, timestamp: string, body: string): string =>
    `v1,${createHmac("sha256", Buffer.from(SECRET, "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;

const headersFor = (id: string, timestamp: string, signature: string) => {
    return {
        get: (name: string): null | string => ({ "webhook-id": id, "webhook-signature": signature, "webhook-timestamp": timestamp })[name] ?? null,
    };
};

interface RecordedCall {
    args: unknown[];
    name: string;
}

const makeClient = (calls: RecordedCall[] = []): DodoPaymentsClientLike => {
    return {
        checkoutSessions: {
            create: async (body: Record<string, unknown>) => {
                calls.push({ args: [body], name: "checkout" });

                return { checkout_url: "https://dodo.test/checkout", session_id: "cks_1" };
            },
        },
        customers: {
            create: async (body: Record<string, unknown>, options?: { idempotencyKey?: string }) => {
                calls.push({ args: [body, options], name: "customer" });

                return { customer_id: "cus_1", email: "a@b.test" };
            },
            customerPortal: {
                create: async (customerId: string, body?: Record<string, unknown>) => {
                    calls.push({ args: [customerId, body], name: "portal" });

                    return { link: "https://dodo.test/portal" };
                },
            },
        },
        payments: {
            retrieve: async (id: string) => {
                return { currency: "USD", payment_id: id, status: "succeeded", total_amount: 2500 };
            },
        },
        refunds: {
            create: async (body: Record<string, unknown>) => {
                calls.push({ args: [body], name: "refund" });

                return { amount: 2500, currency: "USD", payment_id: "pay_1", refund_id: "ref_1", status: "succeeded" };
            },
        },
        subscriptions: {
            changePlan: async (id: string, body: Record<string, unknown>) => {
                calls.push({ args: [id, body], name: "changePlan" });

                return { changed: true };
            },
            retrieve: async (id: string) => {
                return { cancel_at_next_billing_date: false, product_id: "pro", quantity: 1, status: "active", subscription_id: id };
            },
            update: async (id: string, body: Record<string, unknown>) => {
                calls.push({ args: [id, body], name: "update" });
                const cancelling = body.status === "cancelled";

                return {
                    cancel_at_next_billing_date: body.cancel_at_next_billing_date === true,
                    product_id: "pro",
                    quantity: 1,
                    status: cancelling ? "cancelled" : "active",
                    subscription_id: id,
                };
            },
        },
        usageEvents: {
            ingest: async (body: Record<string, unknown>) => {
                calls.push({ args: [body], name: "ingest" });

                return { ingested_count: 1 };
            },
        },
    };
};

describe("dodopayments adapter", () => {
    it("is a merchant-of-record: rejects manual capture but supports refunds", async () => {
        expect.assertions(3);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });

        expect(adapter.capabilities.merchantOfRecord).toBe(true);
        expect(() => adapter.capturePayment({ sessionId: "x" })).toThrow(/does not support/);
        // Refunds ARE supported by Dodo (unlike manual capture).
        // `refundId` is Dodo's `refund_id` — the same id `refund.succeeded` carries.
        await expect(adapter.refundPayment({ sessionId: "pay_1" })).resolves.toMatchObject({ pending: false, refundId: "ref_1", state: "refunded" });
    });

    it("flags a refund Dodo has only accepted, not settled", async () => {
        expect.assertions(2);

        const client = {
            ...makeClient(),
            refunds: {
                create: async () => {
                    return { amount: 2500, currency: "USD", payment_id: "pay_1", refund_id: "ref_1", status: "pending" };
                },
            },
        };

        const adapter = createDodoPaymentsAdapter({ client, webhookSecret: SECRET });
        const result = await adapter.refundPayment({ sessionId: "pay_1" });

        // `pending`/`review` settle later via `refund.succeeded` — or not at all, via `refund.failed`,
        // which carries no transition. The facade holds its ledger back on this flag.
        expect(result.pending).toBe(true);
        expect(result.state).toBe("captured");
    });

    it("creates a checkout carrying the pinned reference metadata and product cart", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createDodoPaymentsAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const result = await adapter.createCheckout({
            cancelUrl: "https://x/cancel",
            customerId: "cus_1",
            metadata: { referenceId: "attacker_wins" },
            mode: "subscription",
            priceId: "pro",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result).toEqual({ id: "cks_1", provider: "dodopayments", url: "https://dodo.test/checkout" });

        const body = calls.find((call) => call.name === "checkout")?.args[0] as Record<string, unknown>;

        expect(body.product_cart).toEqual([{ product_id: "pro", quantity: 1 }]);
        expect(body.customer).toEqual({ customer_id: "cus_1" });
        // The framework-controlled referenceId is pinned last — caller metadata cannot override it.
        expect((body.metadata as { referenceId?: string }).referenceId).toBe("user_1");
    });

    it("cancels immediately by default and at period end when asked", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createDodoPaymentsAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const immediate = await adapter.cancelSubscription("sub_1");

        expect(immediate.state).toBe("canceled");
        expect((calls.at(-1)?.args[1] as Record<string, unknown>).status).toBe("cancelled");

        const atPeriodEnd = await adapter.cancelSubscription("sub_1", { atPeriodEnd: true });

        expect(atPeriodEnd).toMatchObject({ cancelAtPeriodEnd: true, state: "active" });
        expect((calls.at(-1)?.args[1] as Record<string, unknown>).cancel_at_next_billing_date).toBe(true);
    });

    it("changes plan through the change-plan endpoint, then re-reads the subscription", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createDodoPaymentsAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const subscription = await adapter.updateSubscription("sub_1", { priceId: "enterprise", quantity: 3 });

        const changePlan = calls.find((call) => call.name === "changePlan")?.args[1] as Record<string, unknown>;

        expect(changePlan).toMatchObject({ product_id: "enterprise", proration_billing_mode: "prorated_immediately", quantity: 3 });
        expect(subscription.state).toBe("active");
        expect(subscription.provider).toBe("dodopayments");
    });

    it("preserves the current seat count on a plan-only change (regression)", async () => {
        expect.assertions(1);

        const calls: RecordedCall[] = [];
        const base = makeClient(calls);
        // A 5-seat subscription; the caller changes ONLY the plan (no quantity).
        const client = {
            ...base,
            subscriptions: {
                ...(base.subscriptions as Record<string, unknown>),
                retrieve: async (id: string) => {
                    return { cancel_at_next_billing_date: false, product_id: "pro", quantity: 5, status: "active", subscription_id: id };
                },
            },
        };
        const adapter = createDodoPaymentsAdapter({ client, webhookSecret: SECRET });

        await adapter.updateSubscription("sub_1", { priceId: "enterprise" });

        // changePlan requires a quantity — it must carry the current 5, not silently reset to 1.
        expect((calls.find((call) => call.name === "changePlan")?.args[1] as Record<string, unknown>).quantity).toBe(5);
    });

    it("supports a quantity-only update by carrying the current plan into change-plan (regression)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const base = makeClient(calls);
        const client = {
            ...base,
            subscriptions: {
                ...(base.subscriptions as Record<string, unknown>),
                retrieve: async (id: string) => {
                    return { cancel_at_next_billing_date: false, product_id: "pro", quantity: 2, status: "active", subscription_id: id };
                },
            },
        };
        const adapter = createDodoPaymentsAdapter({ client, webhookSecret: SECRET });

        // Only quantity changes — the plan must be filled from the current subscription, not dropped.
        await adapter.updateSubscription("sub_1", { quantity: 9 });

        const changePlan = calls.find((call) => call.name === "changePlan")?.args[1] as Record<string, unknown>;

        expect(changePlan.product_id).toBe("pro");
        expect(changePlan.quantity).toBe(9);
    });

    it("keys customer creation on an idempotency key derived from the reference (regression)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createDodoPaymentsAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        await adapter.getOrCreateCustomer({ email: "a@b.test", referenceId: "user_1" });

        const options = calls.find((call) => call.name === "customer")?.args[1] as { idempotencyKey?: string } | undefined;

        expect(typeof options?.idempotencyKey).toBe("string");
        expect(options?.idempotencyKey).not.toHaveLength(0);
    });

    it("pins that the SDK drops that key rather than sending it (the fake above cannot see this)", async () => {
        expect.assertions(2);

        let sent: Headers | undefined;
        // The real client, not the structural fake: `buildHeaders` only emits an idempotency header
        // when `this.idempotencyHeader` is truthy, and that field is declared `protected` and never
        // assigned anywhere in the package — so the key we pass type-checks and goes nowhere. Flip
        // this test to assert the header when a future SDK release starts setting it, and update the
        // `@lunora/payment` idempotency docblock with it.
        const client = new DodoPayments({
            bearerToken: "test-key",
            environment: "test_mode",
            fetch: async (_input, init) => {
                sent = new Headers(init?.headers);

                return Response.json({ customer_id: "cus_1", email: "a@b.test" });
            },
            maxRetries: 0,
        });

        await client.customers.create({ email: "a@b.test", name: "user_1" }, { idempotencyKey: "customer:dodopayments:user_1" });

        expect(sent).toBeDefined();
        expect([...(sent as Headers).keys()].filter((name) => name.includes("idempotency"))).toStrictEqual([]);
    });

    it("ingests usage as a Dodo usage-event keyed on the customer id", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createDodoPaymentsAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        await adapter.reportUsage?.({ customerId: "cus_1", featureId: "api_calls", idempotencyKey: "usage_1", quantity: 3, referenceId: "user_1" });

        const { events } = calls.find((call) => call.name === "ingest")?.args[0] as { events: Record<string, unknown>[] };

        expect(events[0]?.event_name).toBe("api_calls");
        expect(events[0]?.customer_id).toBe("cus_1");
        expect(events[0]?.event_id).toBe("usage_1");
    });

    it("normalizes a verified payment.succeeded webhook (Standard Webhooks scheme)", async () => {
        expect.assertions(5);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });

        const payload = JSON.stringify({
            data: {
                currency: "USD",
                customer: { customer_id: "cus_1" },
                metadata: { referenceId: "user_1" },
                payment_id: "pay_1",
                subscription_id: "sub_1",
                total_amount: 2500,
            },
            type: "payment.succeeded",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_1", timestamp, sign("msg_1", timestamp, payload)), payload });

        expect(action.type).toBe("payment.captured");
        expect(action.sessionId).toBe("pay_1");
        expect(action.subscriptionId).toBe("sub_1");
        expect(action.referenceId).toBe("user_1");
        expect(action.amount?.minorUnits).toBe(2500n);
    });

    it("maps subscription.cancelled/expired to a cancellation and renewed to active", async () => {
        expect.assertions(3);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));

        const cancelledBody = JSON.stringify({ data: { status: "cancelled", subscription_id: "sub_1" }, type: "subscription.cancelled" });
        const cancelled = await adapter.parseWebhook({ headers: headersFor("m1", timestamp, sign("m1", timestamp, cancelledBody)), payload: cancelledBody });

        expect(cancelled.type).toBe("subscription.canceled");
        expect(cancelled.subscriptionId).toBe("sub_1");

        const renewedBody = JSON.stringify({ data: { status: "active", subscription_id: "sub_1" }, type: "subscription.renewed" });
        const renewed = await adapter.parseWebhook({ headers: headersFor("m2", timestamp, sign("m2", timestamp, renewedBody)), payload: renewedBody });

        expect(renewed.type).toBe("subscription.active");
    });

    it("maps an `on_hold` subscription to a non-entitling state, not an active grant (regression)", async () => {
        expect.assertions(1);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const payload = JSON.stringify({ data: { status: "on_hold", subscription_id: "sub_1" }, type: "subscription.on_hold" });
        const action = await adapter.parseWebhook({ headers: headersFor("m3", timestamp, sign("m3", timestamp, payload)), payload });

        // `on_hold` (dunning) must NOT map to the entitling `subscription.active`.
        expect(action.type).toBe("subscription.past_due");
    });

    it("maps a paused subscription to subscription.paused, not the generic update (regression)", async () => {
        expect.assertions(1);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const payload = JSON.stringify({ data: { status: "paused", subscription_id: "sub_1" }, type: "subscription.paused" });
        const action = await adapter.parseWebhook({ headers: headersFor("m6", timestamp, sign("m6", timestamp, payload)), payload });

        // A `paused` status must route to `subscription.paused` (the status→state table once lacked the
        // entry, so the event silently fell through to `subscription.updated`).
        expect(action.type).toBe("subscription.paused");
    });

    it("routes the subscription.paused event to paused whatever status it carries (regression)", async () => {
        expect.assertions(1);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));
        // Dodo's `SubscriptionStatus` is pending|active|on_hold|cancelled|failed|expired — there is no
        // `paused` member, so a `subscription.paused` payload cannot carry one. Read from the status
        // alone, a deliberate pause fell through to `subscription.past_due` and raised the dunning alert.
        const payload = JSON.stringify({ data: { status: "on_hold", subscription_id: "sub_1" }, type: "subscription.paused" });
        const action = await adapter.parseWebhook({ headers: headersFor("m8", timestamp, sign("m8", timestamp, payload)), payload });

        expect(action.type).toBe("subscription.paused");
    });

    it("rounds a fractional webhook amount instead of throwing on the BigInt conversion (regression)", async () => {
        expect.assertions(2);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const payload = JSON.stringify({ data: { currency: "USD", payment_id: "pay_1", total_amount: 2500.5 }, type: "payment.succeeded" });
        const action = await adapter.parseWebhook({ headers: headersFor("m7", timestamp, sign("m7", timestamp, payload)), payload });

        expect(action.type).toBe("payment.captured");
        expect(action.amount?.minorUnits).toBe(2501n);
    });

    it("normalizes a refund.succeeded webhook to a refund", async () => {
        expect.assertions(3);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const payload = JSON.stringify({ data: { amount: 1000, currency: "USD", payment_id: "pay_1", refund_id: "ref_1" }, type: "refund.succeeded" });
        const action = await adapter.parseWebhook({ headers: headersFor("m4", timestamp, sign("m4", timestamp, payload)), payload });

        expect(action.type).toBe("payment.refunded");
        expect(action.amount?.minorUnits).toBe(1000n);
        // Per-refund identity, so the sync layer can tell this event from a same-amount sibling.
        expect(action.refundId).toBe("ref_1");
    });

    it("treats a lost chargeback as a funds reversal, not an unhandled event (regression)", async () => {
        expect.assertions(3);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));
        // The real wire shape: `GetDispute.amount` is a STRING ("represented as a string to
        // accommodate precision"), not the number the old fixture used. A `readNumber` here yields
        // `undefined` → a zero-money reversal on a real chargeback.
        const payload = JSON.stringify({ data: { amount: "2500", currency: "USD", payment_id: "pay_1" }, type: "dispute.lost" });
        const action = await adapter.parseWebhook({ headers: headersFor("m8", timestamp, sign("m8", timestamp, payload)), payload });

        expect(action.type).toBe("payment.refunded");
        expect(action.amount?.minorUnits).toBe(2500n);
        expect(action.sessionId).toBe("pay_1");
    });

    it("refuses to scale a non-integer dispute amount rather than guess its unit", async () => {
        expect.assertions(3);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const payload = JSON.stringify({ data: { amount: "25.00", currency: "USD", payment_id: "pay_1" }, type: "dispute.lost" });
        const action = await adapter.parseWebhook({ headers: headersFor("m9", timestamp, sign("m9", timestamp, payload)), payload });

        // Reading "25.00" as 25 minor units understates the reversal 100x; reading it as 2500
        // overstates it 100x if Dodo ever sends integer minor units in that shape. Carry no amount:
        // `sync.ts` then records a FULL reversal with the money untouched, which is loud and
        // fail-closed, instead of writing a confidently wrong figure to the ledger.
        expect(action.type).toBe("payment.refunded");
        expect(action.amount).toBeUndefined();
        expect(action.sessionId).toBe("pay_1");
    });

    it("rejects a bad signature", async () => {
        expect.assertions(1);

        const adapter = createDodoPaymentsAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));

        await expect(adapter.parseWebhook({ headers: headersFor("m5", timestamp, "v1,not-a-valid-signature"), payload: "{}" })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });
});
