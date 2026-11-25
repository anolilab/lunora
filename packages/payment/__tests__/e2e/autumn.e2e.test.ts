/**
 * Autumn, end to end: the real `autumn-js` SDK against a local fake of Autumn's API, through the facade.
 * The provider is never reached; what is fake is only the provider's side of the socket.
 */
import { createHmac } from "node:crypto";

import { Autumn } from "autumn-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPayment } from "../../src/create-payment";
import { createAutumnAdapter } from "../../src/providers/autumn";
import { MemoryPaymentStore } from "../../src/store";
import type { FakeProvider } from "./provider-server";
import { startFakeProvider, webhookRequest } from "./provider-server";

/** A Standard Webhooks secret: `whsec_` plus the base64 of the HMAC key bytes. */
const WEBHOOK_SECRET = `whsec_${Buffer.from("autumn-e2e-fixture-signing-key!!").toString("base64")}`;
const REFERENCE = "user_1";
const PLAN = "pro";
/** The adapter's composite subscription id, `customerId::planId`. */
const SUBSCRIPTION_ID = `${REFERENCE}::${PLAN}`;

let provider: FakeProvider;

describe("autumn e2e", () => {
    beforeAll(async () => {
        provider = await startFakeProvider();
    });

    afterAll(async () => {
        await provider.close();
    });

    /** A `subscriptions[]` row as the SDK validates it (`GetCustomerSubscription$inboundSchema`). Times are epoch ms. */
    const subscriptionRow = (status: string) => {
        return {
            add_on: false,
            auto_enable: false,
            canceled_at: null,
            current_period_end: 1_767_225_600_000,
            current_period_start: 1_764_547_200_000,
            expires_at: null,
            id: "sub_autumn_1",
            past_due: false,
            plan_id: PLAN,
            quantity: 1,
            started_at: 1_764_547_200_000,
            status,
            trial_ends_at: null,
        };
    };

    /** A customer as the SDK validates it on `customers.get_or_create` and `customers.get`. */
    const customerEntity = (subscriptions: ReadonlyArray<ReturnType<typeof subscriptionRow>>) => {
        return {
            balances: {},
            billing_controls: {},
            created_at: 1_764_547_200_000,
            email: "buyer@example.com",
            env: "sandbox",
            fingerprint: null,
            flags: {},
            id: REFERENCE,
            licenses: [],
            metadata: {},
            name: null,
            purchases: [],
            send_email_receipts: false,
            stripe_id: null,
            subscriptions,
        };
    };

    const facade = (store: MemoryPaymentStore) => {
        const client = new Autumn({ secretKey: "autumn_test", serverURL: provider.url });

        return createPayment({
            adapter: createAutumnAdapter({ client: () => client, webhookSecret: WEBHOOK_SECRET }),
            authorize: (referenceId) => referenceId === REFERENCE,
            store,
        });
    };

    /**
     * A `billing.updated` event signed the way the adapter verifies it (Standard Webhooks, as Svix
     * delivers): `base64(HMAC_SHA256(base64decode(secret without whsec_), "{id}.{timestamp}.{body}"))`
     * in a `v1,` entry of `svix-signature`.
     */
    const signedBillingUpdated = (deliveryId: string) => {
        const body = JSON.stringify({
            data: {
                customer_id: REFERENCE,
                plan_changes: [{ action: "activated", subscription: subscriptionRow("active") }],
            },
            type: "billing.updated",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const key = Buffer.from(WEBHOOK_SECRET.slice("whsec_".length), "base64");
        const signature = createHmac("sha256", key).update(`${deliveryId}.${timestamp}.${body}`).digest("base64");

        return { body, headers: { "svix-id": deliveryId, "svix-signature": `v1,${signature}`, "svix-timestamp": timestamp } };
    };

    beforeEach(() => {
        provider.clear();
        provider.route("POST", "/v1/customers.get_or_create", () => {
            return { body: customerEntity([subscriptionRow("active")]) };
        });
        provider.route("POST", "/v1/billing.attach", () => {
            return { body: { customer_id: REFERENCE, payment_url: "https://checkout.autumn.test/pay_1" } };
        });
        // Autumn lists only live plans (`status` is `active` or `scheduled`): a canceled plan is absent.
        provider.route("POST", "/v1/customers.get", () => {
            return { body: customerEntity([]) };
        });
        provider.route("POST", "/v1/billing.update", () => {
            return { body: { customer_id: REFERENCE, payment_url: null } };
        });
    });

    it("attaches a plan over HTTP and returns the hosted payment URL", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();
        const payment = facade(store);

        const result = await payment.createCheckout({
            email: "buyer@example.com",
            mode: "subscription",
            priceId: PLAN,
            referenceId: REFERENCE,
            successUrl: "https://app.example.com/billing",
        });

        expect(result.url).toBe("https://checkout.autumn.test/pay_1");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual([
            "POST /v1/customers.get_or_create",
            "POST /v1/billing.attach",
        ]);
        expect(JSON.parse(provider.requests[1]?.body ?? "{}")).toMatchObject({
            customer_id: REFERENCE,
            plan_id: PLAN,
            success_url: "https://app.example.com/billing",
        });
        await expect(store.getCustomerByReference("autumn", REFERENCE)).resolves.toMatchObject({ id: REFERENCE });
    });

    it("applies a signed billing.updated webhook and stores the subscription for its reference", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, headers } = signedBillingUpdated("msg_1");

        const response = await payment.handleWebhook(webhookRequest(body, headers));

        expect(response.status).toBe(200);
        await expect(store.getSubscription("autumn", SUBSCRIPTION_ID)).resolves.toMatchObject({ referenceId: REFERENCE, state: "active" });
    });

    it("refuses a webhook whose signature does not match, and stores nothing", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, headers } = signedBillingUpdated("msg_2");

        const response = await payment.handleWebhook(webhookRequest(body, { ...headers, "svix-signature": `v1,${Buffer.alloc(32).toString("base64")}` }));

        expect(response.status).toBe(400);
        await expect(store.getSubscription("autumn", SUBSCRIPTION_ID)).resolves.toBeUndefined();
    });

    it("reads the provider's live status over HTTP, not the stored row", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, headers } = signedBillingUpdated("msg_3");

        await payment.handleWebhook(webhookRequest(body, headers));
        provider.clear();

        const live = await payment.getSubscriptionStatus(SUBSCRIPTION_ID);

        expect(live.state).toBe("canceled");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["POST /v1/customers.get"]);
        expect(JSON.parse(provider.requests[0]?.body ?? "{}")).toMatchObject({ customer_id: REFERENCE });
        await expect(store.getSubscription("autumn", SUBSCRIPTION_ID)).resolves.toMatchObject({ state: "active" });
    });

    it("cancels immediately over HTTP and records the provider's answer", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();
        const payment = facade(store);
        const { body, headers } = signedBillingUpdated("msg_4");

        await payment.handleWebhook(webhookRequest(body, headers));
        provider.clear();

        const cancelled = await payment.cancelSubscription(SUBSCRIPTION_ID);

        expect(cancelled.state).toBe("canceled");
        expect(provider.requests.map((request) => `${request.method} ${request.path}`)).toStrictEqual(["POST /v1/billing.update"]);
        expect(JSON.parse(provider.requests[0]?.body ?? "{}")).toMatchObject({ cancel_action: "cancel_immediately", customer_id: REFERENCE, plan_id: PLAN });
        await expect(store.getSubscription("autumn", SUBSCRIPTION_ID)).resolves.toMatchObject({ state: "canceled" });
    });
});
