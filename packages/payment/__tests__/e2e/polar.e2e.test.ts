/**
 * Polar, end to end: the real `@polar-sh/sdk` against a local fake of Polar's API, through the facade.
 * The provider is never reached; what is fake is only the provider's side of the socket.
 */
import { createHmac } from "node:crypto";

import { Polar } from "@polar-sh/sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPayment } from "../../src/create-payment";
import { createPolarAdapter } from "../../src/providers/polar";
import { MemoryPaymentStore } from "../../src/store";
import type { FakeProvider } from "./provider-server";
import { startFakeProvider, webhookRequest } from "./provider-server";

const WEBHOOK_SECRET = "whsec_test";
const REFERENCE = "user_1";
const AT = "2026-11-01T00:00:00.000Z";

let provider: FakeProvider;

/** The fields Polar's SDK validates on every response (`models/components/*.js`), snake_case as on the wire. */
const customerEntity = {
    avatar_url: null,
    billing_address: null,
    billing_name: null,
    created_at: AT,
    deleted_at: null,
    email: "buyer@example.com",
    email_verified: false,
    external_id: REFERENCE,
    id: "cus_1",
    metadata: { referenceId: REFERENCE },
    modified_at: null,
    name: null,
    organization_id: "org_1",
    tax_id: null,
    type: "individual",
};

const productEntity = {
    attached_custom_fields: [],
    benefits: [],
    created_at: AT,
    description: null,
    id: "prod_pro",
    is_archived: false,
    is_recurring: true,
    medias: [],
    metadata: {},
    meter_interval: null,
    meter_interval_count: null,
    modified_at: null,
    name: "Pro",
    organization_id: "org_1",
    prices: [],
    recurring_interval: "month",
    recurring_interval_count: 1,
    trial_interval: null,
    trial_interval_count: null,
    visibility: "public",
};

/** A subscription as Polar serves it, and as its webhooks carry it in `data`. */
const subscriptionEntity = (status: string) => {
    return {
        amount: 1000,
        cancel_at_period_end: false,
        canceled_at: status === "canceled" ? AT : null,
        checkout_id: null,
        created_at: AT,
        currency: "usd",
        current_meter_period_end: null,
        current_meter_period_start: null,
        current_period_end: "2026-12-01T00:00:00.000Z",
        current_period_start: AT,
        customer: customerEntity,
        customer_cancellation_comment: null,
        customer_cancellation_reason: null,
        customer_id: "cus_1",
        discount: null,
        discount_id: null,
        ended_at: status === "canceled" ? AT : null,
        ends_at: null,
        id: "sub_1",
        metadata: { referenceId: REFERENCE },
        meters: [],
        modified_at: null,
        pause_at_period_end: false,
        paused_at: null,
        pending_update: null,
        prices: [],
        product: productEntity,
        product_id: "prod_pro",
        recurring_interval: "month",
        recurring_interval_count: 1,
        resumes_at: null,
        started_at: AT,
        status,
        trial_end: null,
        trial_start: null,
    };
};

const checkoutEntity = {
    active_trial_interval: null,
    active_trial_interval_count: null,
    allow_discount_codes: true,
    allow_trial: null,
    amount: 1000,
    attached_custom_fields: null,
    billing_address_fields: { city: "optional", country: "optional", line1: "optional", line2: "optional", postal_code: "optional", state: "optional" },
    client_secret: "polar_c_secret",
    created_at: AT,
    currency: "usd",
    customer_billing_address: null,
    customer_billing_name: null,
    customer_email: null,
    customer_id: "cus_1",
    customer_ip_address: null,
    customer_metadata: {},
    customer_name: null,
    customer_tax_id: null,
    discount: null,
    discount_amount: 0,
    discount_id: null,
    embed_origin: null,
    expires_at: "2026-11-02T00:00:00.000Z",
    external_customer_id: REFERENCE,
    id: "ch_1",
    is_business_customer: false,
    is_discount_applicable: false,
    is_free_product_price: false,
    is_payment_form_required: true,
    is_payment_required: true,
    is_payment_setup_required: false,
    metadata: { referenceId: REFERENCE },
    modified_at: null,
    net_amount: 1000,
    organization_id: "org_1",
    payment_processor: "stripe",
    payment_processor_metadata: {},
    prices: null,
    product: null,
    product_id: null,
    product_price: null,
    product_price_id: null,
    products: [],
    require_billing_address: false,
    return_url: null,
    status: "open",
    subscription_id: null,
    success_url: "https://app.example.com/billing",
    tax_amount: null,
    tax_behavior: null,
    total_amount: 1000,
    trial_end: null,
    trial_interval: null,
    trial_interval_count: null,
    url: "https://polar.test/checkout/ch_1",
};

const facade = (store: MemoryPaymentStore) => {
    const client = new Polar({ accessToken: "polar_oat_test", serverURL: provider.url });

    return createPayment({
        adapter: createPolarAdapter({ client: () => client, webhookSecret: WEBHOOK_SECRET }),
        authorize: (referenceId) => referenceId === REFERENCE,
        store,
    });
};

/**
 * A subscription event, signed the way Polar signs its webhooks: Standard Webhooks, with the HMAC
 * keyed by the secret's UTF-8 bytes (`keyEncoding: "utf8"` in the adapter).
 */
const signedSubscriptionEvent = (type: string, status: string, webhookId: string) => {
    const body = JSON.stringify({ data: subscriptionEntity(status), timestamp: AT, type });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.from(WEBHOOK_SECRET, "utf8")).update(`${webhookId}.${timestamp}.${body}`).digest("base64");

    return { body, headers: { "webhook-id": webhookId, "webhook-signature": `v1,${signature}`, "webhook-timestamp": timestamp } };
};

const deliver = (event: { body: string; headers: Record<string, string> }) => webhookRequest(event.body, event.headers);

describe("polar e2e", () => {
    beforeAll(async () => {
        provider = await startFakeProvider();
    });

    beforeEach(() => {
        provider.clear();
        // Polar answers its create endpoints with 201; the SDK refuses any other success status there.
        provider.route("POST", "/v1/customers/", () => {
            return { body: customerEntity, status: 201 };
        });
        provider.route("POST", "/v1/checkouts/", () => {
            return { body: checkoutEntity, status: 201 };
        });
        provider.route("GET", "/v1/subscriptions/sub_1", () => {
            return { body: subscriptionEntity("canceled") };
        });
        // An immediate cancel is a revoke: DELETE /v1/subscriptions/{id}.
        provider.route("DELETE", "/v1/subscriptions/sub_1", () => {
            return { body: subscriptionEntity("canceled") };
        });
    });

    afterAll(async () => {
        await provider.close();
    });

    it("creates a checkout over HTTP, bound to the minted customer, and returns the hosted URL", async () => {
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

        expect(result.url).toBe("https://polar.test/checkout/ch_1");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["POST /v1/customers/", "POST /v1/checkouts/"]);
        expect(JSON.parse(provider.requests[0]?.body ?? "{}")).toMatchObject({ email: "buyer@example.com", external_id: REFERENCE, type: "individual" });
        expect(JSON.parse(provider.requests[1]?.body ?? "{}")).toMatchObject({
            customer_id: "cus_1",
            external_customer_id: REFERENCE,
            metadata: { referenceId: REFERENCE },
            products: ["prod_pro"],
            success_url: "https://app.example.com/billing",
        });
        await expect(store.getCustomerByReference("polar", REFERENCE)).resolves.toMatchObject({ id: "cus_1" });
    });

    it("applies a signed subscription.active webhook and stores the subscription for its reference", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = facade(store);

        const response = await payment.handleWebhook(deliver(signedSubscriptionEvent("subscription.active", "active", "msg_1")));

        expect(response.status).toBe(200);
        await expect(store.getSubscription("polar", "sub_1")).resolves.toMatchObject({ priceId: "prod_pro", referenceId: REFERENCE, state: "active" });
        // A webhook is applied from its body alone: nothing is fetched from the provider.
        expect(provider.requests).toStrictEqual([]);
    });

    it("refuses a webhook whose signature does not match, and stores nothing", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const event = signedSubscriptionEvent("subscription.active", "active", "msg_2");

        const response = await payment.handleWebhook(
            deliver({ ...event, headers: { ...event.headers, "webhook-signature": `v1,${Buffer.alloc(32).toString("base64")}` } }),
        );

        expect(response.status).toBe(400);
        await expect(store.getSubscription("polar", "sub_1")).resolves.toBeUndefined();
    });

    it("reads the provider's live status over HTTP, not the stored row", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = facade(store);

        await payment.handleWebhook(deliver(signedSubscriptionEvent("subscription.active", "active", "msg_3")));
        provider.clear();

        const live = await payment.getSubscriptionStatus("sub_1");

        expect(live.state).toBe("canceled");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["GET /v1/subscriptions/sub_1"]);
        await expect(store.getSubscription("polar", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("cancels immediately over HTTP with a revoke and records the provider's answer", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = facade(store);

        await payment.handleWebhook(deliver(signedSubscriptionEvent("subscription.active", "active", "msg_4")));
        provider.clear();

        const cancelled = await payment.cancelSubscription("sub_1");

        expect(cancelled.state).toBe("canceled");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["DELETE /v1/subscriptions/sub_1"]);
        await expect(store.getSubscription("polar", "sub_1")).resolves.toMatchObject({ state: "canceled" });
    });
});
