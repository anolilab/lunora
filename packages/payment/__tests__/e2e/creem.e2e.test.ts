/**
 * Creem, end to end: the real `creem` SDK against a local fake of Creem's API, through the facade.
 * The provider is never reached; what is fake is only the provider's side of the socket.
 */
import { Creem } from "creem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPayment } from "../../src/create-payment";
import { createCreemAdapter } from "../../src/providers/creem";
import { MemoryPaymentStore } from "../../src/store";
import type { FakeProvider } from "./provider-server";
import { hmacSha256Hex, startFakeProvider, webhookRequest } from "./provider-server";

const WEBHOOK_SECRET = "whsec_test";
const REFERENCE = "user_1";

let provider: FakeProvider;

describe("creem e2e", () => {
    beforeAll(async () => {
        provider = await startFakeProvider();
    });

    afterAll(async () => {
        await provider.close();
    });

    /** A subscription entity as the SDK parses it: `product` and `customer` may be ids, and the dates are ISO strings. */
    const activeSubscription = (status: string) => {
        return {
            collection_method: "charge_automatically",
            created_at: "2026-11-01T00:00:00.000Z",
            customer: "cus_1",
            id: "sub_1",
            metadata: { referenceId: REFERENCE },
            mode: "test",
            object: "subscription",
            product: "prod_pro",
            status,
            units: 1,
            updated_at: "2026-11-01T00:00:00.000Z",
        };
    };

    const facade = (store: MemoryPaymentStore) => {
        const client = new Creem({ apiKey: "creem_test", serverURL: provider.url });

        return createPayment({
            adapter: createCreemAdapter({ client: () => client, webhookSecret: WEBHOOK_SECRET }),
            authorize: (referenceId) => referenceId === REFERENCE,
            store,
        });
    };

    /** A `subscription.active` event, signed the way Creem signs its webhooks. */
    const signedSubscriptionEvent = (eventType: string, status: string, id: string) => {
        const body = JSON.stringify({
            created_at: Date.now(),
            eventType,
            id,
            object: { ...activeSubscription(status), customer: "cus_1" },
        });

        return { body, signature: hmacSha256Hex(WEBHOOK_SECRET, body) };
    };

    /** The fields Creem's SDK validates on every response (`models/components/*entity.js`). */
    const customerEntity = {
        country: null,
        created_at: "2026-11-01T00:00:00.000Z",
        email: "buyer@example.com",
        id: "cus_1",
        mode: "test",
        object: "customer",
        updated_at: "2026-11-01T00:00:00.000Z",
    };
    const checkoutEntity = {
        checkout_url: "https://checkout.creem.test/ch_1",
        created_at: "2026-11-01T00:00:00.000Z",
        id: "ch_1",
        mode: "test",
        name: "Pro",
        object: "checkout",
        product: "prod_pro",
        status: "pending",
        units: 1,
    };

    beforeEach(() => {
        provider.clear();
        provider.route("POST", "/v1/customers", () => {
            return { body: customerEntity };
        });
        provider.route("POST", "/v1/checkouts", () => {
            return { body: checkoutEntity };
        });
        // The SDK reads one subscription by query: GET /v1/subscriptions?subscription_id=…
        provider.route("GET", "/v1/subscriptions", () => {
            return { body: activeSubscription("canceled") };
        });
        provider.route("POST", "/v1/subscriptions/sub_1/cancel", () => {
            return { body: activeSubscription("canceled") };
        });
    });

    it("creates a checkout over HTTP, with the buyer's email, and returns the hosted URL", async () => {
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

        expect(result.url).toBe("https://checkout.creem.test/ch_1");
        expect(JSON.parse(provider.requests[1]?.body ?? "{}")).toMatchObject({
            customer: { id: "cus_1" },
            metadata: { referenceId: REFERENCE },
            product_id: "prod_pro",
            success_url: "https://app.example.com/billing",
        });
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["POST /v1/customers", "POST /v1/checkouts"]);
        expect(JSON.parse(provider.requests[0]?.body ?? "{}")).toMatchObject({ email: "buyer@example.com" });
        await expect(store.getCustomerByReference("creem", REFERENCE)).resolves.toMatchObject({ id: "cus_1" });
    });

    it("applies a signed subscription.active webhook and stores the subscription for its reference", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, signature } = signedSubscriptionEvent("subscription.active", "active", "evt_1");

        const response = await payment.handleWebhook(webhookRequest(body, { "creem-signature": signature }));

        expect(response.status).toBe(200);
        await expect(store.getSubscription("creem", "sub_1")).resolves.toMatchObject({ referenceId: REFERENCE, state: "active" });
    });

    it("refuses a webhook whose signature does not match, and stores nothing", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body } = signedSubscriptionEvent("subscription.active", "active", "evt_2");

        const response = await payment.handleWebhook(webhookRequest(body, { "creem-signature": "00".repeat(32) }));

        expect(response.status).toBe(400);
        await expect(store.getSubscription("creem", "sub_1")).resolves.toBeUndefined();
    });

    it("reads the provider's live status over HTTP, not the stored row", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, signature } = signedSubscriptionEvent("subscription.active", "active", "evt_3");

        await payment.handleWebhook(webhookRequest(body, { "creem-signature": signature }));
        provider.clear();

        const live = await payment.getSubscriptionStatus("sub_1");

        expect(live.state).toBe("canceled");
        expect(provider.requests.map((request) => `${request.method} ${request.path}${request.search}`)).toStrictEqual([
            "GET /v1/subscriptions?subscription_id=sub_1",
        ]);
        await expect(store.getSubscription("creem", "sub_1")).resolves.toMatchObject({ state: "active" });
    });

    it("cancels immediately over HTTP and records the provider's answer", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, signature } = signedSubscriptionEvent("subscription.active", "active", "evt_4");

        await payment.handleWebhook(webhookRequest(body, { "creem-signature": signature }));
        provider.clear();

        const cancelled = await payment.cancelSubscription("sub_1");

        expect(cancelled.state).toBe("canceled");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["POST /v1/subscriptions/sub_1/cancel"]);
        await expect(store.getSubscription("creem", "sub_1")).resolves.toMatchObject({ state: "canceled" });
    });
});
