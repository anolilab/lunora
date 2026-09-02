import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { money } from "../../src/money";
import type { PolarClientLike } from "../../src/providers/polar";
import { createPolarAdapter } from "../../src/providers/polar";

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

const makeClient = (created: Record<string, unknown>[] = [], calls: RecordedCall[] = []): PolarClientLike => {
    return {
        checkouts: {
            create: async (parameters: Record<string, unknown>) => {
                created.push(parameters);

                return { id: "co_1", url: "https://polar.test/co_1" };
            },
        },
        customerSessions: {
            create: async () => {
                return { customerPortalUrl: "https://polar.test/portal" };
            },
        },
        events: {
            ingest: async (parameters: Record<string, unknown>) => {
                created.push(parameters);

                return { inserted: 1 };
            },
        },
        customers: {
            create: async () => {
                return { email: "a@b.test", id: "pcus_1" };
            },
        },
        orders: {
            get: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "order.get" });

                return { currency: "usd", id: "ord_1", status: "paid", totalAmount: 2500 };
            },
        },
        refunds: {
            create: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "refund" });

                return { id: "ref_1" };
            },
        },
        subscriptions: {
            get: async () => {
                return { id: "sub_1", metadata: { referenceId: "user_1" }, status: "active" };
            },
            revoke: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "sub.revoke" });

                return { id: "sub_1", metadata: { referenceId: "user_1" }, status: "canceled" };
            },
            update: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "sub.update" });

                const update = (parameters as { subscriptionUpdate?: { cancelAtPeriodEnd?: boolean; productId?: string } }).subscriptionUpdate ?? {};

                // Echo the update back onto the response (Date fields, as the real SDK returns) so tests
                // can assert the mapped Subscription reflects it, not just the raw request payload.
                return {
                    cancelAtPeriodEnd: update.cancelAtPeriodEnd ?? false,
                    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
                    currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
                    id: "sub_1",
                    metadata: { referenceId: "user_1" },
                    productId: update.productId ?? "prod_pro",
                    status: "active",
                };
            },
        },
    };
};

describe("polar adapter", () => {
    it("is a merchant-of-record and rejects manual capture", () => {
        expect.assertions(2);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });

        expect(adapter.capabilities.merchantOfRecord).toBe(true);
        expect(() => adapter.capturePayment({ sessionId: "x" })).toThrow(/does not support/);
    });

    it("creates a checkout carrying the reference metadata", async () => {
        expect.assertions(3);

        const created: Record<string, unknown>[] = [];
        const adapter = createPolarAdapter({ client: makeClient(created), webhookSecret: SECRET });

        const result = await adapter.createCheckout({
            cancelUrl: "https://x/cancel",
            mode: "subscription",
            priceId: "prod_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result).toEqual({ id: "co_1", provider: "polar", url: "https://polar.test/co_1" });
        expect((created[0]?.metadata as { referenceId?: string }).referenceId).toBe("user_1");
        expect(created[0]?.products).toEqual(["prod_1"]);
    });

    it("binds the checkout to the reference's customer instead of orphaning it", async () => {
        expect.assertions(4);

        const created: Record<string, unknown>[] = [];
        const adapter = createPolarAdapter({ client: makeClient(created), webhookSecret: SECRET });

        // The facade passes the stored/minted customer id; the adapter must attach it (else Polar mints a
        // second orphan customer at completion, leaving the stored customer with no subscription).
        await adapter.createCheckout({
            cancelUrl: "https://x/cancel",
            customerId: "pcus_1",
            email: "a@b.test",
            mode: "subscription",
            priceId: "prod_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(created[0]?.customerId).toBe("pcus_1");
        expect(created[0]?.externalCustomerId).toBe("user_1");
        // The cancel URL is wired onto Polar's return (back-button) URL rather than dropped.
        expect(created[0]?.returnUrl).toBe("https://x/cancel");
        // With a customer already bound, email is not re-sent as a pre-fill.
        expect(created[0]?.customerEmail).toBeUndefined();
    });

    it("recovers the referenceId from order metadata in getPaymentStatus (reconcile must not orphan the row)", async () => {
        expect.assertions(1);

        const client = makeClient();
        // Polar copies checkout metadata onto the order; the status read must surface it, not blank it.
        (client as { orders: { get: unknown } }).orders = {
            get: async () => {
                return { currency: "usd", id: "ord_1", metadata: { referenceId: "user_1" }, status: "paid", totalAmount: 2500 };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        const session = await adapter.getPaymentStatus("ord_1");

        expect(session.referenceId).toBe("user_1");
    });

    it("normalizes a verified order.paid webhook (Standard Webhooks scheme)", async () => {
        expect.assertions(6);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });

        const payload = JSON.stringify({
            data: { currency: "usd", customer_id: "pcus_1", id: "ord_1", metadata: { referenceId: "user_1" }, subscription_id: "sub_1", total_amount: 2500 },
            type: "order.paid",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_1", timestamp, sign("msg_1", timestamp, payload)), payload });

        expect(action.type).toBe("payment.captured");
        expect(action.sessionId).toBe("ord_1");
        expect(action.subscriptionId).toBe("sub_1");
        expect(action.referenceId).toBe("user_1");
        expect(action.amount?.minorUnits).toBe(2500n);
        expect(action.eventId).toBe("msg_1");
    });

    it("maps subscription.revoked to a cancellation", async () => {
        expect.assertions(2);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });

        const payload = JSON.stringify({ data: { id: "sub_1", metadata: { referenceId: "user_1" }, status: "canceled" }, type: "subscription.revoked" });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_2", timestamp, sign("msg_2", timestamp, payload)), payload });

        expect(action.type).toBe("subscription.canceled");
        expect(action.subscriptionId).toBe("sub_1");
    });

    it("maps an `incomplete` subscription to a non-entitling state, not an active grant (regression)", async () => {
        expect.assertions(1);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });

        const payload = JSON.stringify({ data: { id: "sub_1", metadata: { referenceId: "user_1" }, status: "incomplete" }, type: "subscription.created" });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_incomplete", timestamp, sign("msg_incomplete", timestamp, payload)), payload });

        // `incomplete` (first payment not completed) must NOT map to the entitling
        // `subscription.active` — it maps to non-entitling `subscription.past_due`.
        expect(action.type).toBe("subscription.past_due");
    });

    it("does not capture a still-pending order.created (regression)", async () => {
        expect.assertions(1);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });

        const payload = JSON.stringify({
            data: { currency: "usd", id: "ord_2", metadata: { referenceId: "user_1" }, status: "pending", total_amount: 2500 },
            type: "order.created",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_pending", timestamp, sign("msg_pending", timestamp, payload)), payload });

        // A pending order.created must not be applied as a capture — order.paid is the settle signal.
        expect(action.type).toBe("unhandled");
    });

    it("re-activates a subscription on subscription.uncanceled (regression)", async () => {
        expect.assertions(2);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });

        const payload = JSON.stringify({
            data: { cancel_at_period_end: false, id: "sub_1", metadata: { referenceId: "user_1" }, status: "active" },
            type: "subscription.uncanceled",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_uncancel", timestamp, sign("msg_uncancel", timestamp, payload)), payload });

        // Un-canceling via the Polar portal must re-emit an active subscription, not fall to `unhandled`.
        expect(action.type).toBe("subscription.active");
        expect(action.cancelAtPeriodEnd).toBe(false);
    });

    it("ingests usage as an event keyed on the external customer id", async () => {
        expect.assertions(4);

        const created: Record<string, unknown>[] = [];
        const adapter = createPolarAdapter({ client: makeClient(created), webhookSecret: SECRET });

        await adapter.reportUsage?.({ featureId: "api_calls", idempotencyKey: "usage_1", quantity: 3, referenceId: "user_1" });

        const events = created[0]?.events as { externalCustomerId?: string; externalId?: string; metadata?: Record<string, unknown>; name?: string }[];

        expect(events[0]?.name).toBe("api_calls");
        expect(events[0]?.externalCustomerId).toBe("user_1");
        expect(events[0]?.metadata).toMatchObject({ value: 3 });
        // Polar dedupes ingestion on `externalId`, so the engine's idempotency key has to travel on
        // it — otherwise a retried usage forward meters (and bills) the same units twice.
        expect(events[0]?.externalId).toBe("usage_1");
    });

    it("rejects a bad signature", async () => {
        expect.assertions(1);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));

        await expect(adapter.parseWebhook({ headers: headersFor("msg_3", timestamp, "v1,not-a-valid-signature"), payload: "{}" })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });

    it("cancels immediately (no atPeriodEnd) via subscriptions.revoke", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        const subscription = await adapter.cancelSubscription("sub_1");

        const call = calls.find((entry) => entry.name === "sub.revoke");

        expect((call?.args[0] as { id?: string }).id).toBe("sub_1");
        expect(subscription.state).toBe("canceled");
    });

    it("cancels at period end via subscriptions.update, threading cancelAtPeriodEnd", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        const subscription = await adapter.cancelSubscription("sub_1", { atPeriodEnd: true });

        const call = calls.find((entry) => entry.name === "sub.update");
        const update = (call?.args[0] as { id?: string; subscriptionUpdate?: { cancelAtPeriodEnd?: boolean } }) ?? {};

        expect(update.id).toBe("sub_1");
        expect(update.subscriptionUpdate?.cancelAtPeriodEnd).toBe(true);
        // The mapped Subscription reflects the toggle and the Date-typed period fields the SDK returns.
        expect(subscription.cancelAtPeriodEnd).toBe(true);
        expect(subscription.currentPeriodEnd).toBe(new Date("2026-09-01T00:00:00Z").getTime());
    });

    it("resumes a subscription by toggling cancelAtPeriodEnd back to false", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        const subscription = await adapter.resumeSubscription("sub_1");

        const call = calls.find((entry) => entry.name === "sub.update");

        // The inverse toggle of cancelSubscription's atPeriodEnd path.
        expect((call?.args[0] as { subscriptionUpdate?: { cancelAtPeriodEnd?: boolean } }).subscriptionUpdate?.cancelAtPeriodEnd).toBe(false);
        expect(subscription.cancelAtPeriodEnd).toBe(false);
    });

    it("updates the plan by sending productId on the subscription update", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        const subscription = await adapter.updateSubscription("sub_1", { priceId: "prod_enterprise" });

        const call = calls.find((entry) => entry.name === "sub.update");

        expect((call?.args[0] as { subscriptionUpdate?: { productId?: string } }).subscriptionUpdate?.productId).toBe("prod_enterprise");
        expect(subscription.priceId).toBe("prod_enterprise");
    });

    it("sends an empty subscriptionUpdate when the patch carries no priceId (quantity is not forwarded, degenerate case)", async () => {
        expect.assertions(1);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        // Polar's updateSubscription only ever reads patch.priceId — a quantity-only patch (no priceId)
        // is pinned as today's actual behaviour: an empty subscriptionUpdate, not a thrown error.
        await adapter.updateSubscription("sub_1", { quantity: 5 });

        const call = calls.find((entry) => entry.name === "sub.update");

        expect((call?.args[0] as { subscriptionUpdate?: Record<string, unknown> }).subscriptionUpdate).toEqual({});
    });

    it("refunds the full order total (no amount given), reading it from orders.get", async () => {
        expect.assertions(5);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        const session = await adapter.refundPayment({ sessionId: "ord_1" });

        expect(calls.some((entry) => entry.name === "order.get")).toBe(true);

        const call = calls.find((entry) => entry.name === "refund");

        // The base orders.get stub reports totalAmount: 2500.
        expect((call?.args[0] as { amount?: number; orderId?: string }).amount).toBe(2500);
        expect((call?.args[0] as { amount?: number; orderId?: string }).orderId).toBe("ord_1");
        // Polar has no partial-refund state on this path — pin the actual (always "refunded") result.
        expect(session.state).toBe("refunded");
        // Polar's `Refund.id` — the same id `refund.created` carries, so the facade's marker matches.
        expect(session.refundId).toBe("ref_1");
    });

    it("refunds an explicit amount without querying orders.get, still landing on state=refunded", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        const session = await adapter.refundPayment({ amount: money(500n, "usd"), sessionId: "ord_1" });

        // An explicit amount skips the order lookup entirely (see refundPayment's `input.amount ?
        // undefined : ...`).
        expect(calls.some((entry) => entry.name === "order.get")).toBe(false);

        const call = calls.find((entry) => entry.name === "refund");

        expect((call?.args[0] as { amount?: number }).amount).toBe(500);
        // Unlike Stripe, Polar's refundPayment never distinguishes "partially_refunded" from
        // "refunded" — a strictly smaller amount is still pinned as "refunded" here.
        expect(session.state).toBe("refunded");
    });

    it("fails closed on an unknown status in the webhook path (regression)", async () => {
        expect.assertions(1);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            data: { id: "sub_1", metadata: { referenceId: "user_1" }, status: "some_future_status" },
            type: "subscription.updated",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("evt_unknown", timestamp, sign("evt_unknown", timestamp, payload)), payload });

        // Not `subscription.updated` — that patch would preserve an existing entitling state.
        expect(action.type).toBe("subscription.past_due");
    });

    it("normalizes a refund.created webhook, keeping the refund id apart from the order id", async () => {
        expect.assertions(3);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({ data: { amount: 300, currency: "usd", id: "ref_1", order_id: "ord_1" }, type: "refund.created" });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("evt_ref", timestamp, sign("evt_ref", timestamp, payload)), payload });

        // The event object IS the refund: `order_id` is the session it refunds, `id` is the refund
        // itself. Confusing the two would key the sync layer's marker lookup on the wrong value.
        expect(action.sessionId).toBe("ord_1");
        expect(action.refundId).toBe("ref_1");
        expect(action.amount?.minorUnits).toBe(300n);
    });

    it("rejects a fractional webhook amount as a payment error, not a raw RangeError (regression)", async () => {
        expect.assertions(1);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({ data: { amount: 25.5, currency: "usd", id: "ref_1", order_id: "ord_1" }, type: "refund.created" });
        const timestamp = String(Math.floor(Date.now() / 1000));

        // `BigInt(25.5)` would throw a bare RangeError straight through the adapter boundary.
        await expect(adapter.parseWebhook({ headers: headersFor("evt_frac", timestamp, sign("evt_frac", timestamp, payload)), payload })).rejects.toMatchObject(
            { code: "VALIDATION_ERROR" },
        );
    });

    it("fails closed on an unknown subscription status (regression)", async () => {
        expect.assertions(1);

        const client = {
            ...makeClient(),
            subscriptions: {
                get: async () => {
                    return { id: "sub_1", metadata: { referenceId: "user_1" }, status: "some_future_status" };
                },
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        const subscription = await adapter.getSubscriptionStatus("sub_1");

        // An unrecognized status must map to non-entitling `past_due`, never `active`.
        expect(subscription.state).toBe("past_due");
    });
});
