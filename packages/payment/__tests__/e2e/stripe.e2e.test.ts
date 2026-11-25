/**
 * Stripe, end to end: the real `stripe` SDK against a local fake of Stripe's API, through the facade.
 * The provider is never reached; what is fake is only the provider's side of the socket. Webhooks are
 * signed the way Stripe signs them and verified by the SDK's own `constructEventAsync`.
 */
import { Stripe } from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPayment } from "../../src/create-payment";
import { createStripeAdapter } from "../../src/providers/stripe";
import { MemoryPaymentStore } from "../../src/store";
import type { FakeProvider } from "./provider-server";
import { hmacSha256Hex, startFakeProvider, webhookRequest } from "./provider-server";

const WEBHOOK_SECRET = "whsec_test";
const REFERENCE = "user_1";
const PERIOD_START = 1_793_491_200;
const PERIOD_END = 1_796_083_200;

let provider: FakeProvider;

describe("stripe e2e", () => {
    beforeAll(async () => {
        provider = await startFakeProvider();
    });

    afterAll(async () => {
        await provider.close();
    });

    /**
     * A `Stripe.Subscription` as the API returns it: `items` is an `ApiList` whose items carry the price
     * and, since API 2025-03-31.basil, the current period. `has_more: false` marks the item set complete.
     */
    const subscription = (status: string) => {
        return {
            billing_cycle_anchor: PERIOD_START,
            cancel_at: null,
            cancel_at_period_end: false,
            canceled_at: status === "canceled" ? PERIOD_START : null,
            collection_method: "charge_automatically",
            created: PERIOD_START,
            currency: "usd",
            customer: "cus_1",
            id: "sub_1",
            items: {
                data: [
                    {
                        created: PERIOD_START,
                        current_period_end: PERIOD_END,
                        current_period_start: PERIOD_START,
                        id: "si_1",
                        metadata: {},
                        object: "subscription_item",
                        price: { active: true, currency: "usd", id: "price_pro", object: "price", product: "prod_pro", type: "recurring", unit_amount: 2000 },
                        quantity: 1,
                        subscription: "sub_1",
                    },
                ],
                has_more: false,
                object: "list",
                url: "/v1/subscription_items?subscription=sub_1",
            },
            livemode: false,
            metadata: { referenceId: REFERENCE },
            object: "subscription",
            start_date: PERIOD_START,
            status,
        };
    };

    const facade = (store: MemoryPaymentStore) => {
        const { hostname, port, protocol } = new URL(provider.url);
        const client = new Stripe("sk_test_fake", {
            host: hostname,
            // Retries would re-send a request the fake already recorded; the assertions count requests.
            maxNetworkRetries: 0,
            port,
            protocol: protocol === "https:" ? "https" : "http",
            telemetry: false,
        });

        return createPayment({
            adapter: createStripeAdapter({ client: () => client, webhookSecret: WEBHOOK_SECRET }),
            authorize: (referenceId) => referenceId === REFERENCE,
            store,
        });
    };

    /** A Stripe event, signed as `stripe-signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<payload>">`. */
    const signedSubscriptionEvent = (type: string, status: string, id: string) => {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify({
            api_version: "2025-03-31.basil",
            created: Number(timestamp),
            data: { object: subscription(status) },
            id,
            livemode: false,
            object: "event",
            pending_webhooks: 1,
            request: { id: null, idempotency_key: null },
            type,
        });

        return { body, signature: `t=${timestamp},v1=${hmacSha256Hex(WEBHOOK_SECRET, `${timestamp}.${body}`)}` };
    };

    const customer = {
        created: PERIOD_START,
        email: "buyer@example.com",
        id: "cus_1",
        livemode: false,
        metadata: { referenceId: REFERENCE },
        object: "customer",
    };
    const checkoutSession = {
        client_reference_id: REFERENCE,
        created: PERIOD_START,
        customer: "cus_1",
        expires_at: PERIOD_END,
        id: "cs_1",
        livemode: false,
        metadata: { referenceId: REFERENCE },
        mode: "subscription",
        object: "checkout.session",
        payment_status: "unpaid",
        status: "open",
        url: "https://checkout.stripe.test/c/pay/cs_1",
    };

    const requestLines = (): string[] => provider.requests.map((request) => `${request.method} ${request.path}`);

    beforeEach(() => {
        provider.clear();
        provider.route("POST", "/v1/customers", () => {
            return { body: customer };
        });
        provider.route("POST", "/v1/checkout/sessions", () => {
            return { body: checkoutSession };
        });
        // With an idempotency key (the facade always derives one) the adapter re-reads the session to
        // tell a fresh one from a replay of a finished one.
        provider.route("GET", "/v1/checkout/sessions/cs_1", () => {
            return { body: checkoutSession };
        });
        provider.route("GET", "/v1/subscriptions/sub_1", () => {
            return { body: subscription("canceled") };
        });
        // An immediate cancel is `DELETE /v1/subscriptions/:id` in the SDK.
        provider.route("DELETE", "/v1/subscriptions/sub_1", () => {
            return { body: subscription("canceled") };
        });
    });

    it("creates a checkout over HTTP, with the buyer's email, and returns the hosted URL", async () => {
        expect.assertions(5);

        const store = new MemoryPaymentStore();
        const payment = facade(store);

        const result = await payment.createCheckout({
            email: "buyer@example.com",
            mode: "subscription",
            priceId: "price_pro",
            referenceId: REFERENCE,
            successUrl: "https://app.example.com/billing",
        });

        expect(result.url).toBe("https://checkout.stripe.test/c/pay/cs_1");
        expect(requestLines()).toStrictEqual(["POST /v1/customers", "POST /v1/checkout/sessions", "GET /v1/checkout/sessions/cs_1"]);
        expect(new URLSearchParams(provider.requests[0]?.body).get("email")).toBe("buyer@example.com");
        expect(Object.fromEntries(new URLSearchParams(provider.requests[1]?.body))).toMatchObject({
            client_reference_id: REFERENCE,
            customer: "cus_1",
            "line_items[0][price]": "price_pro",
            "subscription_data[metadata][referenceId]": REFERENCE,
        });
        await expect(store.getCustomerByReference("stripe", REFERENCE)).resolves.toMatchObject({ id: "cus_1" });
    });

    it("applies a signed customer.subscription.created webhook and stores the subscription for its reference", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, signature } = signedSubscriptionEvent("customer.subscription.created", "active", "evt_1");

        const response = await payment.handleWebhook(webhookRequest(body, { "stripe-signature": signature }));

        expect(response.status).toBe(200);
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ priceId: "price_pro", referenceId: REFERENCE, state: "active" });
        // Verification is local: nothing goes to the provider.
        expect(provider.requests).toHaveLength(0);
    });

    it("refuses a webhook whose signature does not match, and stores nothing", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body } = signedSubscriptionEvent("customer.subscription.created", "active", "evt_2");
        const timestamp = String(Math.floor(Date.now() / 1000));

        const response = await payment.handleWebhook(webhookRequest(body, { "stripe-signature": `t=${timestamp},v1=${"00".repeat(32)}` }));

        expect(response.status).toBe(400);
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toBeUndefined();
    });

    it("reads the provider's live status over HTTP, not the stored row", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, signature } = signedSubscriptionEvent("customer.subscription.created", "active", "evt_3");

        await payment.handleWebhook(webhookRequest(body, { "stripe-signature": signature }));
        provider.clear();

        const live = await payment.getSubscriptionStatus("sub_1");

        expect(live.state).toBe("canceled");
        expect(requestLines()).toStrictEqual(["GET /v1/subscriptions/sub_1"]);
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("cancels immediately over HTTP and records the provider's answer", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, signature } = signedSubscriptionEvent("customer.subscription.created", "active", "evt_4");

        await payment.handleWebhook(webhookRequest(body, { "stripe-signature": signature }));
        provider.clear();

        const cancelled = await payment.cancelSubscription("sub_1");

        expect(cancelled.state).toBe("canceled");
        expect(requestLines()).toStrictEqual(["DELETE /v1/subscriptions/sub_1"]);
        // The facade's derived key reaches Stripe, so a retried cancel replays instead of repeating.
        expect(provider.requests[0]?.headers["idempotency-key"]).toStrictEqual(expect.any(String));
        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ state: "canceled" });
    });
});
