import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

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

const makeClient = (created: Record<string, unknown>[] = []): PolarClientLike => {
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
            get: async () => {
                return { currency: "usd", id: "ord_1", status: "paid", totalAmount: 2500 };
            },
        },
        refunds: {
            create: async () => {
                return { id: "ref_1" };
            },
        },
        subscriptions: {
            get: async () => {
                return { id: "sub_1", metadata: { referenceId: "user_1" }, status: "active" };
            },
            revoke: async () => {
                return { id: "sub_1", metadata: { referenceId: "user_1" }, status: "canceled" };
            },
            update: async () => {
                return { id: "sub_1", metadata: { referenceId: "user_1" }, status: "active" };
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
        expect.assertions(3);

        const created: Record<string, unknown>[] = [];
        const adapter = createPolarAdapter({ client: makeClient(created), webhookSecret: SECRET });

        await adapter.reportUsage?.({ featureId: "api_calls", idempotencyKey: "usage_1", quantity: 3, referenceId: "user_1" });

        const events = created[0]?.events as { externalCustomerId?: string; metadata?: Record<string, unknown>; name?: string }[];

        expect(events[0]?.name).toBe("api_calls");
        expect(events[0]?.externalCustomerId).toBe("user_1");
        expect(events[0]?.metadata).toMatchObject({ value: 3 });
    });

    it("rejects a bad signature", async () => {
        expect.assertions(1);

        const adapter = createPolarAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));

        await expect(adapter.parseWebhook({ headers: headersFor("msg_3", timestamp, "v1,not-a-valid-signature"), payload: "{}" })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });
});
