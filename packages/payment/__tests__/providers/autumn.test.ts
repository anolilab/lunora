import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AutumnClientLike } from "../../src/providers/autumn";
import { createAutumnAdapter } from "../../src/providers/autumn";

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

const makeClient = (calls: RecordedCall[] = [], overrides: Partial<{ customerGet: Record<string, unknown> }> = {}): AutumnClientLike => {
    return {
        attach: async (parameters) => {
            calls.push({ args: [parameters], name: "attach" });

            return { checkout_url: "https://autumn.test/checkout", customer_id: "user_1" };
        },
        cancel: async (parameters) => {
            calls.push({ args: [parameters], name: "cancel" });

            return { success: true };
        },
        customers: {
            billingPortal: async (customerId, parameters) => {
                calls.push({ args: [customerId, parameters], name: "billingPortal" });

                return { data: { url: "https://autumn.test/portal" } };
            },
            create: async (parameters) => {
                calls.push({ args: [parameters], name: "create" });

                return { email: "a@b.test", id: "user_1" };
            },
            get: async (customerId, parameters) => {
                calls.push({ args: [customerId, parameters], name: "get" });

                return (
                    overrides.customerGet ?? {
                        id: customerId,
                        products: [{ current_period_end: 1_900_000_000_000, current_period_start: 1_800_000_000_000, id: "pro", status: "active" }],
                    }
                );
            },
        },
        track: async (parameters) => {
            calls.push({ args: [parameters], name: "track" });

            return { id: "evt_1" };
        },
    };
};

describe("autumn adapter", () => {
    it("is not a merchant-of-record and rejects manual capture/refund", () => {
        expect.assertions(4);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });

        expect(adapter.capabilities.merchantOfRecord).toBe(false);
        expect(adapter.capabilities.usageMetering).toBe(true);
        expect(() => adapter.capturePayment({ sessionId: "x" })).toThrow(/does not support/);
        expect(() => adapter.refundPayment({ sessionId: "x" })).toThrow(/does not support/);
    });

    it("creates a checkout via attach, carrying the pinned reference metadata", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const result = await adapter.createCheckout({
            cancelUrl: "https://x/cancel",
            metadata: { referenceId: "attacker_wins" },
            mode: "subscription",
            priceId: "pro",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result).toEqual({ id: "user_1::pro", provider: "autumn", url: "https://autumn.test/checkout" });

        const attach = calls.find((call) => call.name === "attach")?.args[0] as Record<string, unknown>;

        expect(attach.product_id).toBe("pro");
        expect(attach.customer_id).toBe("user_1");
        // The framework-controlled referenceId is pinned last — caller metadata cannot override it.
        expect((attach.metadata as { referenceId?: string }).referenceId).toBe("user_1");
    });

    it("reports usage through track keyed on the reference and dedupe key", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        await adapter.reportUsage?.({ featureId: "api_calls", idempotencyKey: "usage_1", quantity: 3, referenceId: "user_1" });

        const track = calls.find((call) => call.name === "track")?.args[0] as Record<string, unknown>;

        expect(track.feature_id).toBe("api_calls");
        expect(track.customer_id).toBe("user_1");
        expect(track.value).toBe(3);
        expect(track.idempotency_key).toBe("usage_1");
    });

    it("cancels immediately by default and at period end when asked", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const immediate = await adapter.cancelSubscription("user_1::pro");

        expect(immediate.state).toBe("canceled");
        expect((calls.at(-1)?.args[0] as Record<string, unknown>).cancel_immediately).toBe(true);

        const atPeriodEnd = await adapter.cancelSubscription("user_1::pro", { atPeriodEnd: true });

        expect(atPeriodEnd).toMatchObject({ cancelAtPeriodEnd: true, state: "active" });
        expect((calls.at(-1)?.args[0] as Record<string, unknown>).cancel_immediately).toBe(false);
    });

    it("reads subscription status from the customer's product list", async () => {
        expect.assertions(4);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });

        const subscription = await adapter.getSubscriptionStatus("user_1::pro");

        expect(subscription.state).toBe("active");
        expect(subscription.priceId).toBe("pro");
        expect(subscription.referenceId).toBe("user_1");
        expect(subscription.currentPeriodEnd).toBe(1_900_000_000_000);
    });

    it("fails closed: a scheduled (not-yet-active) product is non-entitling", async () => {
        expect.assertions(1);

        const client = makeClient([], { customerGet: { id: "user_1", products: [{ id: "pro", status: "scheduled" }] } });
        const adapter = createAutumnAdapter({ client, webhookSecret: SECRET });

        const subscription = await adapter.getSubscriptionStatus("user_1::pro");

        // `scheduled` must not map to an entitling active/trialing state.
        expect(["active", "trialing"]).not.toContain(subscription.state);
    });

    it("fails closed: no matching product resolves to a canceled subscription", async () => {
        expect.assertions(1);

        const client = makeClient([], { customerGet: { id: "user_1", products: [] } });
        const adapter = createAutumnAdapter({ client, webhookSecret: SECRET });

        const subscription = await adapter.getSubscriptionStatus("user_1::pro");

        expect(subscription.state).toBe("canceled");
    });

    it("switches plans on update by attaching the new product", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const subscription = await adapter.updateSubscription("user_1::pro", { priceId: "enterprise" });

        expect(subscription.id).toBe("user_1::enterprise");
        expect(subscription.priceId).toBe("enterprise");
        expect((calls.at(-1)?.args[0] as Record<string, unknown>).product_id).toBe("enterprise");
    });

    it("resumes by re-attaching the product", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const subscription = await adapter.resumeSubscription("user_1::pro");

        expect(subscription).toMatchObject({ cancelAtPeriodEnd: false, state: "active" });
        expect(calls.find((call) => call.name === "attach")?.args[0]).toMatchObject({ customer_id: "user_1", product_id: "pro" });
    });

    it("throws on a malformed composite subscription id", async () => {
        expect.assertions(1);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });

        await expect(adapter.getSubscriptionStatus("no-separator")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    });

    it("opens a billing portal, reading the url from the nested data envelope", async () => {
        expect.assertions(1);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });

        await expect(adapter.createPortalSession({ customerId: "user_1", returnUrl: "https://x/back" })).resolves.toEqual({
            url: "https://autumn.test/portal",
        });
    });

    it("normalizes a verified product.attached webhook to an active subscription", async () => {
        expect.assertions(4);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });

        const payload = JSON.stringify({
            data: { customer_id: "user_1", product: { current_period_end: 1_900_000_000_000, id: "pro", status: "active" } },
            type: "product.attached",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_1", timestamp, sign("msg_1", timestamp, payload)), payload });

        expect(action.type).toBe("subscription.active");
        expect(action.subscriptionId).toBe("user_1::pro");
        expect(action.referenceId).toBe("user_1");
        expect(action.eventId).toBe("msg_1");
    });

    it("maps a canceled product event to a cancellation", async () => {
        expect.assertions(2);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });

        const payload = JSON.stringify({ data: { customer_id: "user_1", product: { id: "pro", status: "active" } }, type: "customer.product.canceled" });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_2", timestamp, sign("msg_2", timestamp, payload)), payload });

        expect(action.type).toBe("subscription.canceled");
        expect(action.subscriptionId).toBe("user_1::pro");
    });

    it("normalizes a settled invoice.paid webhook to a captured payment", async () => {
        expect.assertions(3);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });

        const payload = JSON.stringify({ data: { currency: "usd", customer_id: "user_1", id: "inv_1", total: 2500 }, type: "invoice.paid" });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_3", timestamp, sign("msg_3", timestamp, payload)), payload });

        expect(action.type).toBe("payment.captured");
        expect(action.amount?.minorUnits).toBe(2500n);
        expect(action.sessionId).toBe("inv_1");
    });

    it("rejects a bad signature", async () => {
        expect.assertions(1);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));

        await expect(adapter.parseWebhook({ headers: headersFor("msg_4", timestamp, "v1,not-a-valid-signature"), payload: "{}" })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });
});
