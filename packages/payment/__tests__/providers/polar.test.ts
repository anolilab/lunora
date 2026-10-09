import { createHmac } from "node:crypto";

import { validateEvent, WebhookVerificationError } from "@polar-sh/sdk/webhooks";
import { describe, expect, it } from "vitest";

import { money } from "../../src/money";
import type { PolarClientLike } from "../../src/providers/polar";
import { createPolarAdapter } from "../../src/providers/polar";

const SECRET = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"; // gitleaks:allow -- test fixture signing key, not a real secret

/**
 * Sign a delivery the way Polar does. `@polar-sh/sdk`'s `validateEvent` base64-ENCODES the secret
 * and hands it to the Standard Webhooks verifier, which base64-decodes it straight back — so the
 * HMAC key is the secret's UTF-8 bytes, not its base64 decoding. The "Polar's own SDK accepts
 * this fixture" test below pins that, so the fixture cannot drift back to the wrong key.
 */
const signWith = (secret: string, id: string, timestamp: string, body: string): string =>
    `v1,${createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;

const sign = (id: string, timestamp: string, body: string): string => signWith(SECRET, id, timestamp, body);

/** Whether Polar's SDK accepts the SIGNATURE (a toy body may still fail its schema parse afterwards). */
const polarSdkAcceptsSignature = (body: string, headers: Record<string, string>, secret: string): boolean => {
    try {
        validateEvent(body, headers, secret);
    } catch (error) {
        return !(error instanceof WebhookVerificationError);
    }

    return true;
};

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

                return {
                    currency: "usd",
                    id: "ord_1",
                    netAmount: 2500,
                    refundableAmount: 2500,
                    refundableTaxAmount: 0,
                    status: "paid",
                    taxAmount: 0,
                    totalAmount: 2500,
                };
            },
        },
        refunds: {
            create: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "refund" });

                // `status` is required on Polar's `Refund`; the adapter reads it to tell a settled
                // refund from a `pending` one it must not book yet.
                return { amount: (parameters as { amount: number }).amount, id: "ref_1", status: "succeeded", taxAmount: 0 };
            },
        },
        subscriptions: {
            get: async () => {
                return { id: "sub_1", metadata: { referenceId: "user_1" }, seats: null, status: "active" };
            },
            revoke: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "sub.revoke" });

                return { id: "sub_1", metadata: { referenceId: "user_1" }, status: "canceled" };
            },
            update: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "sub.update" });

                const update =
                    (parameters as { subscriptionUpdate?: { cancelAtPeriodEnd?: boolean; productId?: string; seats?: number } }).subscriptionUpdate ?? {};

                // Echo the update back onto the response (Date fields, as the real SDK returns) so tests
                // can assert the mapped Subscription reflects it, not just the raw request payload.
                return {
                    cancelAtPeriodEnd: update.cancelAtPeriodEnd ?? false,
                    currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
                    currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
                    id: "sub_1",
                    metadata: { referenceId: "user_1" },
                    productId: update.productId ?? "prod_pro",
                    seats: update.seats ?? null,
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

    it("accepts a delivery Polar's own SDK verifies, for both secret formats", async () => {
        expect.assertions(4);

        // A dashboard-generated secret carries the `polar_whs_` prefix and is not base64 at all.
        for (const secret of [SECRET, "polar_whs_3kL9xQ2mV7pR4tY8wZ1nB6cD5fG0hJ"]) {
            const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: secret });
            const payload = JSON.stringify({ data: { id: "sub_1", metadata: { referenceId: "user_1" }, status: "canceled" }, type: "subscription.revoked" });
            const timestamp = String(Math.floor(Date.now() / 1000));
            const signature = signWith(secret, "msg_sdk", timestamp, payload);

            expect(polarSdkAcceptsSignature(payload, { "webhook-id": "msg_sdk", "webhook-signature": signature, "webhook-timestamp": timestamp }, secret)).toBe(
                true,
            );
            // eslint-disable-next-line no-await-in-loop -- two independent cases, kept sequential for readable failures
            await expect(adapter.parseWebhook({ headers: headersFor("msg_sdk", timestamp, signature), payload })).resolves.toMatchObject({
                type: "subscription.canceled",
            });
        }
    });

    it("rejects a delivery signed with the base64-decoded secret, as Polar's SDK does", async () => {
        expect.assertions(2);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({ data: { id: "sub_1", status: "canceled" }, type: "subscription.revoked" });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const wrongKey = `v1,${createHmac("sha256", Buffer.from(SECRET, "base64")).update(`msg_b64.${timestamp}.${payload}`).digest("base64")}`;

        expect(polarSdkAcceptsSignature(payload, { "webhook-id": "msg_b64", "webhook-signature": wrongKey, "webhook-timestamp": timestamp }, SECRET)).toBe(
            false,
        );
        await expect(adapter.parseWebhook({ headers: headersFor("msg_b64", timestamp, wrongKey), payload })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
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

        expect(call?.args[0]).toStrictEqual({ id: "sub_1", subscriptionUpdate: { productId: "prod_enterprise" } });
        expect(subscription.priceId).toBe("prod_enterprise");
    });

    it("sets the seat count on a seat-based subscription and reflects it on the result", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        const subscription = await adapter.updateSubscription("sub_1", { quantity: 5 });

        const call = calls.find((entry) => entry.name === "sub.update");

        expect(call?.args[0]).toStrictEqual({ id: "sub_1", subscriptionUpdate: { seats: 5 } });
        expect(subscription.quantity).toBe(5);
        expect(subscription.priceId).toBe("prod_pro");
    });

    it("reads the seat count from a seat-based subscription webhook, and keeps a non-seat one at quantity 1", async () => {
        expect.assertions(2);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const deliver = async (id: string, seats: number | null) => {
            const payload = JSON.stringify({
                data: { id: "sub_1", metadata: { referenceId: "user_1" }, product_id: "prod_pro", seats, status: "active" },
                type: "subscription.updated",
            });
            const timestamp = String(Math.floor(Date.now() / 1000));

            return adapter.parseWebhook({ headers: headersFor(id, timestamp, sign(id, timestamp, payload)), payload });
        };

        const seatBased = await deliver("evt_seats", 4);
        const plain = await deliver("evt_plain", null);

        expect(seatBased.quantity).toBe(4);
        expect(plain.quantity).toBeUndefined();
    });

    it("reads a non-seat subscription as quantity 1", async () => {
        expect.assertions(1);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });

        const subscription = await adapter.getSubscriptionStatus("sub_1");

        expect(subscription.quantity).toBe(1);
    });

    it("refuses a seat count that is not a non-negative safe integer, before any call", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        await expect(adapter.updateSubscription("sub_1", { quantity: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(adapter.updateSubscription("sub_1", { quantity: 1.5 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        expect(calls.some((entry) => entry.name === "sub.update")).toBe(false);
    });

    it("throws when Polar answers with a different seat count than was requested, rather than reporting success", async () => {
        expect.assertions(1);

        const client = makeClient();

        (client as { subscriptions: unknown }).subscriptions = {
            get: async () => {
                return { id: "sub_1", metadata: { referenceId: "user_1" }, seats: 1, status: "active" };
            },
            update: async () => {
                return { id: "sub_1", metadata: { referenceId: "user_1" }, seats: null, status: "active" };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        await expect(adapter.updateSubscription("sub_1", { quantity: 5 })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    });

    it("reads the subscription and writes nothing for a patch that changes neither plan nor seats", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        const subscription = await adapter.updateSubscription("sub_1", { idempotencyKey: "k_1" });

        expect(calls.some((entry) => entry.name === "sub.update")).toBe(false);
        expect(subscription.id).toBe("sub_1");
    });

    it("refuses a plan change and a seat change in one patch, since they are separate Polar updates", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        await expect(adapter.updateSubscription("sub_1", { priceId: "prod_enterprise", quantity: 5 })).rejects.toThrow(/plan and the quantity/);
        expect(calls.some((entry) => entry.name === "sub.update")).toBe(false);
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

    it("refunds an explicit amount on an untaxed order as-is, still landing on state=refunded", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        const session = await adapter.refundPayment({ amount: money(500n, "usd"), sessionId: "ord_1" });

        const call = calls.find((entry) => entry.name === "refund");

        expect((call?.args[0] as { amount?: number }).amount).toBe(500);
        // Unlike Stripe, Polar's refundPayment never distinguishes "partially_refunded" from
        // "refunded" — a strictly smaller amount is still pinned as "refunded" here.
        expect(session.state).toBe("refunded");
    });

    it("refunds on the same tax-inclusive basis the capture was booked on (regression)", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const client = makeClient([], calls);

        // A taxed order: Polar refunds NET amounts and refunds the matching tax on top.
        (client as { orders: { get: unknown } }).orders = {
            get: async () => {
                return {
                    currency: "usd",
                    id: "ord_1",
                    netAmount: 10_000,
                    refundableAmount: 6000,
                    refundableTaxAmount: 1200,
                    status: "partially_refunded",
                    taxAmount: 2000,
                    totalAmount: 12_000,
                };
            },
        };
        (client as { refunds: { create: unknown } }).refunds = {
            create: async (parameters: { amount: number }) => {
                calls.push({ args: [parameters], name: "refund" });

                return { amount: parameters.amount, id: "ref_1", status: "succeeded", taxAmount: Math.round(parameters.amount * 0.2) };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        // Full: send the net refundable remainder (not the gross total), book what Polar refunded incl. tax.
        const full = await adapter.refundPayment({ sessionId: "ord_1" });

        expect((calls.at(-1)?.args[0] as { amount: number }).amount).toBe(6000);
        expect(full.refundedAmount.minorUnits).toBe(7200n);

        // Partial: a gross 1200 is net 1000 at this order's 10000:2000 ratio.
        await adapter.refundPayment({ amount: money(1200n, "usd"), sessionId: "ord_1" });

        expect((calls.at(-1)?.args[0] as { amount: number }).amount).toBe(1000);
    });

    it("books a refund webhook and the order's refunded total including tax (regression)", async () => {
        expect.assertions(2);

        const client = makeClient();

        (client as { orders: { get: unknown } }).orders = {
            get: async () => {
                return { currency: "usd", id: "ord_1", refundedAmount: 1000, refundedTaxAmount: 200, status: "partially_refunded", totalAmount: 12_000 };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });
        const payload = JSON.stringify({
            data: { amount: 1000, currency: "usd", id: "ref_1", order_id: "ord_1", status: "succeeded", tax_amount: 200 },
            timestamp: "2026-01-02T03:04:05Z",
            type: "refund.updated",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("evt_tax", timestamp, sign("evt_tax", timestamp, payload)), payload });

        expect(action.amount?.minorUnits).toBe(1200n);
        await expect(adapter.getPaymentStatus("ord_1").then((s) => s.refundedAmount.minorUnits)).resolves.toBe(1200n);
    });

    it("maps a free-form refund reason onto Polar's closed enum instead of failing validation (regression)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createPolarAdapter({ client: makeClient([], calls), webhookSecret: SECRET });

        await adapter.refundPayment({ reason: "requested_by_customer", sessionId: "ord_1" });

        expect((calls.at(-1)?.args[0] as { reason: string }).reason).toBe("other");

        await adapter.refundPayment({ reason: "duplicate", sessionId: "ord_1" });

        expect((calls.at(-1)?.args[0] as { reason: string }).reason).toBe("duplicate");
    });

    it("adopts the customer already holding our external id when create conflicts (regression)", async () => {
        expect.assertions(2);

        const lookups: unknown[] = [];
        const client = makeClient();

        (client as { customers: unknown }).customers = {
            create: async () => {
                // Polar answers a uniqueness conflict with a 422 validation error (`PolarError.statusCode`).
                throw Object.assign(new Error("customer with this external ID already exists"), { statusCode: 422 });
            },
            getExternal: async (request: { externalId: string }) => {
                lookups.push(request);

                return { email: "a@b.test", id: "pcus_existing" };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        await expect(adapter.getOrCreateCustomer({ email: "a@b.test", referenceId: "user_1" })).resolves.toMatchObject({ id: "pcus_existing" });
        // Matched on OUR external id — never on the (shareable) email.
        expect(lookups).toEqual([{ externalId: "user_1" }]);
    });

    it("rethrows the create error when no customer holds our external id", async () => {
        expect.assertions(1);

        const client = makeClient();

        (client as { customers: unknown }).customers = {
            create: async () => {
                throw Object.assign(new Error("customer with this external ID already exists"), { statusCode: 422 });
            },
            getExternal: async () => {
                throw new Error("not found");
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        await expect(adapter.getOrCreateCustomer({ email: "a@b.test", referenceId: "user_1" })).rejects.toThrow("already exists");
    });

    it("propagates a non-conflict create failure without looking the customer up (regression)", async () => {
        expect.assertions(2);

        const lookups: unknown[] = [];
        const client = makeClient();

        (client as { customers: unknown }).customers = {
            create: async () => {
                throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
            },
            getExternal: async (request: unknown) => {
                lookups.push(request);

                return { email: "a@b.test", id: "pcus_existing" };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        await expect(adapter.getOrCreateCustomer({ email: "a@b.test", referenceId: "user_1" })).rejects.toThrow("unauthorized");
        expect(lookups).toEqual([]);
    });

    it("caps a partial refund at Polar's refundable remainder and reports what Polar refunded (regression)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const client = makeClient([], calls);

        (client as { orders: { get: unknown } }).orders = {
            get: async () => {
                return {
                    currency: "usd",
                    id: "ord_1",
                    netAmount: 10_000,
                    refundableAmount: 300,
                    status: "partially_refunded",
                    taxAmount: 2000,
                    totalAmount: 12_000,
                };
            },
        };
        (client as { refunds: { create: unknown } }).refunds = {
            create: async (parameters: { amount: number }) => {
                calls.push({ args: [parameters], name: "refund" });

                return { amount: parameters.amount, id: "ref_1", status: "succeeded", taxAmount: 60 };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        // Gross 1200 is net 1000 at the order's ratio, but only 300 net is still refundable.
        const session = await adapter.refundPayment({ amount: money(1200n, "usd"), sessionId: "ord_1" });

        expect((calls.at(-1)?.args[0] as { amount: number }).amount).toBe(300);
        expect(session.refundedAmount.minorUnits).toBe(360n);
    });

    it("maps subscription.paused / resumed / past_due and carries occurredAt and periods (regression)", async () => {
        expect.assertions(5);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const deliver = async (id: string, type: string, status: string) => {
            const payload = JSON.stringify({
                data: { current_period_end: "2026-02-01T00:00:00Z", id: "sub_1", status },
                timestamp: "2026-01-02T03:04:05Z",
                type,
            });

            return adapter.parseWebhook({ headers: headersFor(id, timestamp, sign(id, timestamp, payload)), payload });
        };

        const paused = await deliver("evt_p", "subscription.paused", "paused");

        expect(paused.type).toBe("subscription.paused");
        expect(paused.occurredAt).toBe(Date.parse("2026-01-02T03:04:05Z"));
        expect(paused.currentPeriodEnd).toBe(Date.parse("2026-02-01T00:00:00Z"));
        await expect(deliver("evt_r", "subscription.resumed", "active").then((a) => a.type)).resolves.toBe("subscription.active");
        await expect(deliver("evt_d", "subscription.past_due", "past_due").then((a) => a.type)).resolves.toBe("subscription.past_due");
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
        const payload = JSON.stringify({ data: { amount: 300, currency: "usd", id: "ref_1", order_id: "ord_1", status: "succeeded" }, type: "refund.created" });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("evt_ref", timestamp, sign("evt_ref", timestamp, payload)), payload });

        // The event object IS the refund: `order_id` is the session it refunds, `id` is the refund
        // itself. Confusing the two would key the sync layer's marker lookup on the wrong value.
        expect(action.sessionId).toBe("ord_1");
        expect(action.refundId).toBe("ref_1");
        expect(action.amount?.minorUnits).toBe(300n);
    });

    it("reads the order's refunded total instead of inferring zero for a partial refund (regression)", async () => {
        expect.assertions(3);

        const client = makeClient();

        // Polar's `Order` carries `refundedAmount`. Inferring it from the status alone reported ZERO
        // refunded for every partially refunded order, and reconcile writes that: the next
        // `refundPayment({ sessionId })` then computes the remainder as the whole captured amount.
        (client as { orders: { get: unknown } }).orders = {
            get: async () => {
                return { currency: "usd", id: "ord_1", refundedAmount: 4000, status: "partially_refunded", totalAmount: 10_000 };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        const session = await adapter.getPaymentStatus("ord_1");

        expect(session.refundedAmount.minorUnits).toBe(4000n);
        expect(session.capturedAmount.minorUnits).toBe(10_000n);
        expect(session.state).toBe("partially_refunded");
    });

    it("still reports a full refund when the order omits refundedAmount (older API / partial double)", async () => {
        expect.assertions(1);

        const client = makeClient();

        (client as { orders: { get: unknown } }).orders = {
            get: async () => {
                return { currency: "usd", id: "ord_1", status: "refunded", totalAmount: 2500 };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        await expect(adapter.getPaymentStatus("ord_1").then((session) => session.refundedAmount.minorUnits)).resolves.toBe(2500n);
    });

    it("does not book a refund.created that is still pending (regression)", async () => {
        expect.assertions(1);

        // Polar sends `refund.created` "regardless of status" (its own SDK says so), and `RefundStatus`
        // is pending | succeeded | failed | canceled. Booking a pending one leaves the ledger claiming a
        // refund the customer never got — and the facade's over-refund guard then blocks issuing it.
        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            data: { amount: 300, currency: "usd", id: "ref_1", order_id: "ord_1", status: "pending" },
            type: "refund.created",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("evt_pend", timestamp, sign("evt_pend", timestamp, payload)), payload });

        expect(action.type).toBe("unhandled");
    });

    it("books the refund on the refund.updated that settles it (regression)", async () => {
        expect.assertions(3);

        // `refund.updated` is the only event carrying the pending → succeeded step, so without it a
        // refund that starts pending would never reach the ledger at all.
        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            data: { amount: 300, currency: "usd", id: "ref_1", order_id: "ord_1", status: "succeeded" },
            type: "refund.updated",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("evt_upd", timestamp, sign("evt_upd", timestamp, payload)), payload });

        expect(action.type).toBe("payment.refunded");
        expect(action.sessionId).toBe("ord_1");
        expect(action.amount?.minorUnits).toBe(300n);
    });

    it("reports an unsettled refunds.create as pending so the facade holds its ledger back (regression)", async () => {
        expect.assertions(2);

        const client = makeClient();

        (client as { refunds: { create: unknown } }).refunds = {
            create: async () => {
                return { amount: 500, id: "ref_1", status: "pending", taxAmount: 0 };
            },
        };
        const adapter = createPolarAdapter({ client, webhookSecret: SECRET });

        const session = await adapter.refundPayment({ amount: money(500n, "usd"), sessionId: "ord_1" });

        // A refund that later FAILS reverses nothing, so an optimistic write would over-state the
        // refunded total for good — and block every later legitimate refund through the facade's guard.
        expect(session.pending).toBe(true);
        expect(session.state).toBe("captured");
    });

    it("rejects a fractional webhook amount as a payment error, not a raw RangeError (regression)", async () => {
        expect.assertions(1);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            data: { amount: 25.5, currency: "usd", id: "ref_1", order_id: "ord_1", status: "succeeded" },
            type: "refund.created",
        });
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
