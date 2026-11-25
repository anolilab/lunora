/**
 * Dodo Payments, end to end: the real `dodopayments` SDK against a local fake of Dodo's API, through the facade.
 * The provider is never reached; what is fake is only the provider's side of the socket.
 */
import { createHmac } from "node:crypto";

import DodoPayments from "dodopayments";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPayment } from "../../src/create-payment";
import { createDodoPaymentsAdapter } from "../../src/providers/dodopayments";
import { MemoryPaymentStore } from "../../src/store";
import type { FakeProvider } from "./provider-server";
import { startFakeProvider, webhookRequest } from "./provider-server";

/** Standard Webhooks secrets are `whsec_<base64>`; the adapter base64-decodes the remainder into the HMAC key. */
const SIGNING_KEY = Buffer.from("dodo-e2e-signing-key");
const WEBHOOK_SECRET = `whsec_${SIGNING_KEY.toString("base64")}`;
const REFERENCE = "user_1";

let provider: FakeProvider;

describe("dodo Payments e2e", () => {
    beforeAll(async () => {
        provider = await startFakeProvider();
    });

    afterAll(async () => {
        await provider.close();
    });

    /** The required fields of the SDK's `Subscription` model (`resources/subscriptions.d.ts`). */
    const subscriptionEntity = (status: string) => {
        return {
            addons: [],
            billing: { city: "Berlin", country: "DE", state: "BE", street: "Street 1", zipcode: "10115" },
            brand_id: "brand_1",
            cancel_at_next_billing_date: false,
            created_at: "2026-11-01T00:00:00.000Z",
            credit_entitlement_cart: [],
            currency: "USD",
            customer: { customer_id: "cus_1", email: "buyer@example.com", name: REFERENCE },
            has_payment_method: true,
            metadata: { referenceId: REFERENCE },
            meter_credit_entitlement_cart: [],
            meters: [],
            next_billing_date: "2026-12-01T00:00:00.000Z",
            on_demand: false,
            payment_frequency_count: 1,
            payment_frequency_interval: "Month",
            previous_billing_date: "2026-11-01T00:00:00.000Z",
            product_id: "prod_pro",
            quantity: 1,
            recurring_pre_tax_amount: 1000,
            status,
            subscription_id: "sub_1",
            subscription_period_count: 1,
            subscription_period_interval: "Year",
            tax_inclusive: false,
            trial_period_days: 0,
        };
    };

    const facade = (store: MemoryPaymentStore) => {
        // No retries: an unexpected answer from the fake should fail the test, not be re-sent.
        const client = new DodoPayments({ baseURL: provider.url, bearerToken: "dodo_test", maxRetries: 0 });

        return createPayment({
            adapter: createDodoPaymentsAdapter({ client: () => client, webhookSecret: WEBHOOK_SECRET }),
            authorize: (referenceId) => referenceId === REFERENCE,
            store,
        });
    };

    /** Standard Webhooks: `v1,` + base64 HMAC-SHA256 over `<id>.<timestamp>.<body>`, keyed by the decoded secret. */
    const standardWebhookSignature = (id: string, timestamp: string, body: string): string =>
        `v1,${createHmac("sha256", SIGNING_KEY).update(`${id}.${timestamp}.${body}`).digest("base64")}`;

    /** A subscription event as Dodo delivers it, with the three Standard Webhooks headers. */
    const signedSubscriptionEvent = (type: string, status: string, id: string) => {
        const body = JSON.stringify({ business_id: "biz_1", data: subscriptionEntity(status), timestamp: new Date().toISOString(), type });
        const timestamp = String(Math.floor(Date.now() / 1000));

        return {
            body,
            headers: { "webhook-id": id, "webhook-signature": standardWebhookSignature(id, timestamp, body), "webhook-timestamp": timestamp },
        };
    };

    /** The required fields of the SDK's `Customer` and `CheckoutSessionResponse` models. */
    const customerEntity = {
        business_id: "biz_1",
        created_at: "2026-11-01T00:00:00.000Z",
        customer_id: "cus_1",
        email: "buyer@example.com",
        name: REFERENCE,
    };
    const checkoutEntity = { checkout_url: "https://checkout.dodo.test/cks_1", session_id: "cks_1" };

    beforeEach(() => {
        provider.clear();
        provider.route("POST", "/customers", () => {
            return { body: customerEntity };
        });
        provider.route("POST", "/checkouts", () => {
            return { body: checkoutEntity };
        });
        provider.route("GET", "/subscriptions/sub_1", () => {
            return { body: subscriptionEntity("cancelled") };
        });
        // Dodo cancels through the general update endpoint: PATCH /subscriptions/{id} with `status: "cancelled"`.
        provider.route("PATCH", "/subscriptions/sub_1", () => {
            return { body: subscriptionEntity("cancelled") };
        });
    });

    it("creates a checkout over HTTP, for the buyer's customer, and returns the hosted URL", async () => {
        expect.assertions(5);

        const store = new MemoryPaymentStore();
        const payment = facade(store);

        const result = await payment.createCheckout({
            email: "buyer@example.com",
            mode: "subscription",
            priceId: "prod_pro",
            referenceId: REFERENCE,
            successUrl: "https://app.example.com/billing",
        });

        expect(result.url).toBe("https://checkout.dodo.test/cks_1");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["POST /customers", "POST /checkouts"]);
        expect(JSON.parse(provider.requests[0]?.body ?? "{}")).toMatchObject({ email: "buyer@example.com" });
        expect(JSON.parse(provider.requests[1]?.body ?? "{}")).toMatchObject({
            customer: { customer_id: "cus_1" },
            metadata: { referenceId: REFERENCE },
            product_cart: [{ product_id: "prod_pro", quantity: 1 }],
            return_url: "https://app.example.com/billing",
        });
        await expect(store.getCustomerByReference("dodopayments", REFERENCE)).resolves.toMatchObject({ id: "cus_1" });
    });

    it("applies a signed subscription.active webhook and stores the subscription for its reference", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, headers } = signedSubscriptionEvent("subscription.active", "active", "msg_1");

        const response = await payment.handleWebhook(webhookRequest(body, headers));

        expect(response.status).toBe(200);
        await expect(store.getSubscription("dodopayments", "sub_1")).resolves.toMatchObject({ priceId: "prod_pro", referenceId: REFERENCE, state: "active" });
        // Webhooks are pushed; applying one sends nothing to the provider.
        expect(provider.requests).toHaveLength(0);
    });

    it("refuses a webhook whose signature does not match, and stores nothing", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, headers } = signedSubscriptionEvent("subscription.active", "active", "msg_2");
        // Correctly keyed, but over a different body: the delivered body was altered after signing.
        const forged = standardWebhookSignature("msg_2", headers["webhook-timestamp"], body.replace('"active"', '"past_due"'));

        const response = await payment.handleWebhook(webhookRequest(body, { ...headers, "webhook-signature": forged }));

        expect(response.status).toBe(400);
        await expect(store.getSubscription("dodopayments", "sub_1")).resolves.toBeUndefined();
    });

    it("reads the provider's live status over HTTP, not the stored row", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, headers } = signedSubscriptionEvent("subscription.active", "active", "msg_3");

        await payment.handleWebhook(webhookRequest(body, headers));
        provider.clear();

        const live = await payment.getSubscriptionStatus("sub_1");

        expect(live.state).toBe("canceled");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["GET /subscriptions/sub_1"]);
        await expect(store.getSubscription("dodopayments", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("cancels immediately over HTTP and records the provider's answer", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, headers } = signedSubscriptionEvent("subscription.active", "active", "msg_4");

        await payment.handleWebhook(webhookRequest(body, headers));
        provider.clear();

        const cancelled = await payment.cancelSubscription("sub_1");

        expect(cancelled.state).toBe("canceled");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["PATCH /subscriptions/sub_1"]);
        expect(JSON.parse(provider.requests[0]?.body ?? "{}")).toStrictEqual({ status: "cancelled" });
        await expect(store.getSubscription("dodopayments", "sub_1")).resolves.toMatchObject({ referenceId: REFERENCE, state: "canceled" });
    });
});
