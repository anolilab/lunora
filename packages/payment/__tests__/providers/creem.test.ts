import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { CreemClientLike } from "../../src/providers/creem";
import { createCreemAdapter } from "../../src/providers/creem";

const SECRET = "creem-fixture-signing-key"; // gitleaks:allow -- test fixture signing key, not a real secret

/** Creem signs the raw body with HMAC-SHA256 (hex) and sends it in the `creem-signature` header. */
const sign = (body: string): string => createHmac("sha256", Buffer.from(SECRET)).update(body).digest("hex");

const headersFor = (signature: string) => {
    return { get: (name: string): null | string => (name === "creem-signature" ? signature : null) };
};

interface RecordedCall {
    args: unknown[];
    name: string;
}

const makeClient = (calls: RecordedCall[] = []): CreemClientLike => {
    return {
        checkouts: {
            create: async (request) => {
                calls.push({ args: [request], name: "checkout" });

                return { checkout_url: "https://creem.test/checkout", id: "ch_1", status: "pending" };
            },
            retrieve: async (id) => {
                return { id, order: { amount: 2500, currency: "EUR", status: "paid" }, status: "completed" };
            },
        },
        customers: {
            create: async (request) => {
                calls.push({ args: [request], name: "customer" });

                return { email: "a@b.test", id: "cust_1" };
            },
            generateBillingLinks: async (request) => {
                calls.push({ args: [request], name: "billing" });

                return { customer_portal_link: "https://creem.test/portal" };
            },
        },
        subscriptions: {
            cancel: async (id) => {
                calls.push({ args: [id], name: "cancel" });

                return { canceled_at: "2026-07-05T00:00:00Z", id, product: "prod_pro", status: "scheduled_cancel" };
            },
            get: async (id) => {
                return { id, product: { id: "prod_pro" }, status: "active" };
            },
            resume: async (id) => {
                calls.push({ args: [id], name: "resume" });

                return { id, product: "prod_pro", status: "active" };
            },
            upgrade: async (id, request) => {
                calls.push({ args: [id, request], name: "upgrade" });

                return { id, product: "prod_enterprise", status: "active" };
            },
        },
    };
};

describe("creem adapter", () => {
    it("is a merchant-of-record with a portal; rejects manual capture and programmatic refunds", () => {
        expect.assertions(4);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });

        expect(adapter.capabilities.merchantOfRecord).toBe(true);
        expect(adapter.capabilities.portal).toBe(true);
        expect(() => adapter.capturePayment({ sessionId: "x" })).toThrow(/does not support/);
        expect(() => adapter.refundPayment({ sessionId: "x" })).toThrow(/does not support/);
    });

    it("creates a checkout from the product id, pinning the reference metadata", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createCreemAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const result = await adapter.createCheckout({
            cancelUrl: "https://x/cancel",
            customerId: "cust_1",
            metadata: { referenceId: "attacker_wins" },
            mode: "subscription",
            priceId: "prod_pro",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result).toEqual({ id: "ch_1", provider: "creem", url: "https://creem.test/checkout" });

        const body = calls.find((call) => call.name === "checkout")?.args[0] as Record<string, unknown>;

        expect(body.productId).toBe("prod_pro");
        expect(body.customer).toEqual({ id: "cust_1" });
        // The framework-controlled referenceId is pinned last — caller metadata cannot override it.
        expect((body.metadata as { referenceId?: string }).referenceId).toBe("user_1");
    });

    it("opens a hosted billing portal via generateBillingLinks", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createCreemAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const portal = await adapter.createPortalSession({ customerId: "cust_1", returnUrl: "https://x/back" });

        expect(portal).toEqual({ url: "https://creem.test/portal" });
        expect(calls.find((call) => call.name === "billing")?.args[0]).toEqual({ customerId: "cust_1" });
    });

    it("cancels at period end and reflects the scheduled-cancel state", async () => {
        expect.assertions(2);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });

        const subscription = await adapter.cancelSubscription("sub_1");

        // scheduled_cancel is still entitling (active until period end) but flagged cancelAtPeriodEnd.
        expect(subscription.state).toBe("active");
        expect(subscription.cancelAtPeriodEnd).toBe(true);
    });

    it("upgrades the plan on update, then reflects the new product", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createCreemAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const subscription = await adapter.updateSubscription("sub_1", { priceId: "prod_enterprise" });

        expect(subscription.priceId).toBe("prod_enterprise");
        expect(subscription.state).toBe("active");
        expect((calls.find((call) => call.name === "upgrade")?.args[1] as Record<string, unknown>).productId).toBe("prod_enterprise");
    });

    it("reads a paid checkout as a captured payment", async () => {
        expect.assertions(3);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });

        const session = await adapter.getPaymentStatus("ch_1");

        expect(session.state).toBe("captured");
        expect(session.amount.minorUnits).toBe(2500n);
        expect(session.capturedAmount.minorUnits).toBe(2500n);
    });

    it("normalizes a verified checkout.completed webhook", async () => {
        expect.assertions(4);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            eventType: "checkout.completed",
            id: "evt_1",
            object: {
                customer: "cust_1",
                id: "ch_1",
                metadata: { referenceId: "user_1" },
                order: { amount: 2500, currency: "EUR", status: "paid" },
                subscription: "sub_1",
            },
        });
        const action = await adapter.parseWebhook({ headers: headersFor(sign(payload)), payload });

        expect(action.type).toBe("payment.captured");
        expect(action.referenceId).toBe("user_1");
        expect(action.subscriptionId).toBe("sub_1");
        expect(action.amount?.minorUnits).toBe(2500n);
    });

    it("maps subscription events, failing closed on unpaid (regression)", async () => {
        expect.assertions(3);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });

        const activeBody = JSON.stringify({ eventType: "subscription.active", id: "e1", object: { id: "sub_1", product: "prod_pro", status: "active" } });
        const active = await adapter.parseWebhook({ headers: headersFor(sign(activeBody)), payload: activeBody });

        expect(active.type).toBe("subscription.active");

        // `unpaid` (renewal not settled) must NOT map to the entitling active state.
        const unpaidBody = JSON.stringify({ eventType: "subscription.unpaid", id: "e2", object: { id: "sub_1", product: "prod_pro", status: "unpaid" } });
        const unpaid = await adapter.parseWebhook({ headers: headersFor(sign(unpaidBody)), payload: unpaidBody });

        expect(unpaid.type).toBe("subscription.past_due");

        const canceledBody = JSON.stringify({ eventType: "subscription.canceled", id: "e3", object: { id: "sub_1", product: "prod_pro", status: "canceled" } });
        const canceled = await adapter.parseWebhook({ headers: headersFor(sign(canceledBody)), payload: canceledBody });

        expect(canceled.type).toBe("subscription.canceled");
    });

    it("rounds a fractional webhook amount instead of throwing on the BigInt conversion (regression)", async () => {
        expect.assertions(2);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            eventType: "checkout.completed",
            id: "evt_2",
            object: { id: "ch_1", metadata: { referenceId: "user_1" }, order: { amount: 2500.5, currency: "EUR", status: "paid" } },
        });
        const action = await adapter.parseWebhook({ headers: headersFor(sign(payload)), payload });

        // A fractional amount must not throw a RangeError out of parseWebhook (which would 400 the
        // webhook and wedge Creem into retrying) — it is rounded to integer minor units.
        expect(action.type).toBe("payment.captured");
        expect(action.amount?.minorUnits).toBe(2501n);
    });

    it("reuses the existing customer when create fails on a duplicate email (regression)", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const client: CreemClientLike = {
            ...makeClient(),
            customers: {
                create: async () => {
                    calls.push({ args: [], name: "create" });

                    // Creem returns 400 "A resource with this identifier already exists" for a dup email.
                    throw new Error("A resource with this identifier already exists");
                },
                generateBillingLinks: async () => {
                    return {};
                },
                retrieve: async (request) => {
                    calls.push({ args: [request], name: "retrieve" });

                    return { email: "a@b.test", id: "cust_existing" };
                },
            },
        };
        const adapter = createCreemAdapter({ client, webhookSecret: SECRET });

        const customer = await adapter.getOrCreateCustomer({ email: "a@b.test", referenceId: "user_1" });

        expect(customer.id).toBe("cust_existing");
        expect(calls.some((call) => call.name === "create")).toBe(true);
        expect((calls.find((call) => call.name === "retrieve")?.args[0] as Record<string, unknown>).email).toBe("a@b.test");
    });

    it("rejects a bad signature", async () => {
        expect.assertions(1);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });

        await expect(adapter.parseWebhook({ headers: headersFor("deadbeef"), payload: "{}" })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });
});
