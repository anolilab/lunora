import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPayment } from "../../src/create-payment";
import type { AutumnClientLike } from "../../src/providers/autumn";
import { createAutumnAdapter } from "../../src/providers/autumn";
import { MemoryPaymentStore } from "../../src/store";

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

const makeClient = (
    calls: RecordedCall[] = [],
    overrides: Partial<{ check: Record<string, unknown>; customerGet: Record<string, unknown> }> = {},
): AutumnClientLike => {
    const customerGet = async (parameters: Record<string, unknown>) => {
        calls.push({ args: [parameters], name: "get" });

        return (
            overrides.customerGet ?? {
                balances: {
                    api_calls: { feature_id: "api_calls", granted: 1000, remaining: 940, unlimited: false, usage: 60 },
                    export: { feature_id: "export", unlimited: true },
                },
                id: "user_1",
                products: [{ current_period_end: 1_900_000_000_000, current_period_start: 1_800_000_000_000, id: "pro", status: "active" }],
            }
        );
    };

    return {
        billing: {
            attach: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "attach" });

                return { customerId: "user_1", paymentUrl: "https://autumn.test/checkout" };
            },
            openCustomerPortal: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "portal" });

                return { customerId: "user_1", url: "https://autumn.test/portal" };
            },
            update: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "update" });

                return { success: true };
            },
        },
        check: async (parameters: Record<string, unknown>) => {
            calls.push({ args: [parameters], name: "check" });

            return overrides.check ?? { allowed: true, balance: { granted: 1000, remaining: 940, unlimited: false, usage: 60 }, customer_id: "user_1" };
        },
        customers: {
            get: customerGet,
            getOrCreate: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "create" });

                return { email: "a@b.test", id: "user_1" };
            },
        },
        track: async (parameters: Record<string, unknown>) => {
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

    it("creates a checkout via billing.attach keyed on the customer + plan", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const result = await adapter.createCheckout({
            cancelUrl: "https://x/cancel",
            mode: "subscription",
            priceId: "pro",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result).toEqual({ id: "user_1::pro", provider: "autumn", url: "https://autumn.test/checkout" });

        const attach = calls.find((call) => call.name === "attach")?.args[0] as Record<string, unknown>;

        expect(attach.planId).toBe("pro");
        // Autumn keys everything on the customer id (our reference id) — no caller metadata to smuggle.
        expect(attach.customerId).toBe("user_1");
    });

    it("reports usage through track keyed on the reference", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        await adapter.reportUsage?.({ featureId: "api_calls", idempotencyKey: "usage_1", quantity: 3, referenceId: "user_1" });

        const track = calls.find((call) => call.name === "track")?.args[0] as Record<string, unknown>;

        // Autumn's track has no request-body idempotency key — exactly-once is the local ledger's job.
        expect(track.featureId).toBe("api_calls");
        expect(track.customerId).toBe("user_1");
        expect(track.value).toBe(3);
    });

    it("cancels immediately by default and at period end via billing.update cancelAction", async () => {
        expect.assertions(4);

        const calls: RecordedCall[] = [];
        const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const immediate = await adapter.cancelSubscription("user_1::pro");
        const immediateCancel = calls.findLast((call) => call.name === "update")?.args[0] as Record<string, unknown>;

        expect(immediate.state).toBe("canceled");
        expect(immediateCancel.cancelAction).toBe("cancel_immediately");

        // At-period-end re-reads Autumn's real status (still "active" here) and only flips the schedule flag.
        const atPeriodEnd = await adapter.cancelSubscription("user_1::pro", { atPeriodEnd: true });
        const scheduledCancel = calls.findLast((call) => call.name === "update")?.args[0] as Record<string, unknown>;

        expect(atPeriodEnd).toMatchObject({ cancelAtPeriodEnd: true, state: "active" });
        expect(scheduledCancel.cancelAction).toBe("cancel_end_of_cycle");
    });

    it("cancel-at-period-end does NOT re-entitle a non-active subscription (regression)", async () => {
        expect.assertions(2);

        // The subscription is past_due (Autumn dunning). Cancelling at period end must preserve that
        // non-entitling state — never fabricate `active` and silently re-grant access.
        const client = makeClient([], { customerGet: { id: "user_1", products: [{ id: "pro", status: "past_due" }] } });
        const adapter = createAutumnAdapter({ client, webhookSecret: SECRET });

        const subscription = await adapter.cancelSubscription("user_1::pro", { atPeriodEnd: true });

        expect(subscription.state).toBe("past_due");
        expect(subscription.cancelAtPeriodEnd).toBe(true);
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

    it("reads subscription status from the newer `subscriptions`/`plan_id` customer shape (regression)", async () => {
        expect.assertions(2);

        const client = makeClient([], {
            customerGet: { id: "user_1", subscriptions: [{ plan_id: "pro", status: "active" }] },
        });
        const adapter = createAutumnAdapter({ client, webhookSecret: SECRET });

        const subscription = await adapter.getSubscriptionStatus("user_1::pro");

        // Current Autumn keys plans under `subscriptions[].plan_id`; an active subscriber must resolve
        // (not fail closed to canceled because only `products`/`product_id` was scanned).
        expect(subscription.state).toBe("active");
        expect(subscription.priceId).toBe("pro");
    });

    it("fails closed: a separate past_due boolean overrides an active status (regression)", async () => {
        expect.assertions(1);

        const client = makeClient([], {
            customerGet: { id: "user_1", subscriptions: [{ past_due: true, plan_id: "pro", status: "active" }] },
        });
        const adapter = createAutumnAdapter({ client, webhookSecret: SECRET });

        const subscription = await adapter.getSubscriptionStatus("user_1::pro");

        // Autumn exposes past-due as a boolean beside an `active` status — it must not stay entitling.
        expect(subscription.state).toBe("past_due");
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
        expect(calls.find((call) => call.name === "attach")?.args[0]).toMatchObject({ planId: "enterprise" });
    });

    it("resumes by uncancelling via billing.update", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const subscription = await adapter.resumeSubscription("user_1::pro");

        expect(subscription).toMatchObject({ cancelAtPeriodEnd: false, state: "active" });
        expect(calls.find((call) => call.name === "update")?.args[0]).toMatchObject({ cancelAction: "uncancel", customerId: "user_1", planId: "pro" });
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

    it("maps a verified billing.updated webhook (plan_changes shape) to a subscription transition (regression)", async () => {
        expect.assertions(3);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            data: { customer_id: "user_1", plan_changes: [{ action: "activated", subscription: { plan_id: "pro", status: "active" } }] },
            type: "billing.updated",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_bu", timestamp, sign("msg_bu", timestamp, payload)), payload });

        // billing.updated is Autumn's real primary lifecycle event — it must not fall to `unhandled`.
        expect(action.type).toBe("subscription.active");
        expect(action.priceId).toBe("pro");
        expect(action.subscriptionId).toBe("user_1::pro");
    });

    it("billing.updated honors the nested past_due flag as non-entitling (regression)", async () => {
        expect.assertions(1);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            data: { customer_id: "user_1", plan_changes: [{ subscription: { past_due: true, plan_id: "pro", status: "active" } }] },
            type: "billing.updated",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const action = await adapter.parseWebhook({ headers: headersFor("msg_bd", timestamp, sign("msg_bd", timestamp, payload)), payload });

        expect(action.type).toBe("subscription.past_due");
    });

    it("accepts Svix's svix-* headers, not just the webhook-* aliases (regression)", async () => {
        expect.assertions(1);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            data: { customer_id: "user_1", plan_changes: [{ subscription: { plan_id: "pro", status: "active" } }] },
            type: "billing.updated",
        });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const signature = sign("msg_svix", timestamp, payload);
        const headers = {
            get: (name: string): null | string => ({ "svix-id": "msg_svix", "svix-signature": signature, "svix-timestamp": timestamp })[name] ?? null,
        };
        const action = await adapter.parseWebhook({ headers, payload });

        expect(action.type).toBe("subscription.active");
    });

    it("rejects a bad signature", async () => {
        expect.assertions(1);

        const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });
        const timestamp = String(Math.floor(Date.now() / 1000));

        await expect(adapter.parseWebhook({ headers: headersFor("msg_4", timestamp, "v1,not-a-valid-signature"), payload: "{}" })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });

    describe("entitlement delegation", () => {
        it("checkEntitlement reads Autumn's balance math for a metered feature", async () => {
            expect.assertions(4);

            const calls: RecordedCall[] = [];
            const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

            const result = await adapter.checkEntitlement?.({ featureId: "api_calls", quantity: 10, referenceId: "user_1" });

            expect(result).toEqual({ allowed: true, balance: 940, limit: 1000, unlimited: false, used: 60 });

            const check = calls.find((call) => call.name === "check")?.args[0] as Record<string, unknown>;

            expect(check.customerId).toBe("user_1");
            expect(check.featureId).toBe("api_calls");
            expect(check.requiredBalance).toBe(10);
        });

        it("checkEntitlement resolves a product (priceId) check from the customer's plans", async () => {
            expect.assertions(2);

            // Autumn's `check` is feature-only, so a product check reads the customer's plans; the default
            // customer holds an active "pro" product → allowed, with no numeric balance.
            const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });

            const result = await adapter.checkEntitlement?.({ priceId: "pro", referenceId: "user_1" });

            expect(result).toEqual({ allowed: true, unlimited: false });
            expect(result?.balance).toBeUndefined();
        });

        it("checkEntitlement reads a top-level numeric `balance` shape without losing it (regression)", async () => {
            expect.assertions(2);

            // Classic autumn-js returns `balance` as a top-level NUMBER (+ `included_usage`/`usage`),
            // not a nested object. `asRecord(number)` is `{}`, so a naive descent would drop the balance.
            const client = makeClient([], { check: { allowed: true, balance: 100, included_usage: 500, unlimited: false, usage: 400 } });
            const adapter = createAutumnAdapter({ client, webhookSecret: SECRET });

            const result = await adapter.checkEntitlement?.({ featureId: "credits", referenceId: "user_1" });

            expect(result).toEqual({ allowed: true, balance: 100, limit: 500, unlimited: false, used: 400 });
            expect(result?.balance).toBe(100);
        });

        it("checkEntitlement defaults requiredBalance to 1 when quantity is omitted (fail-closed)", async () => {
            expect.assertions(1);

            const calls: RecordedCall[] = [];
            const adapter = createAutumnAdapter({ client: makeClient(calls), webhookSecret: SECRET });

            await adapter.checkEntitlement?.({ featureId: "api_calls", referenceId: "user_1" });

            expect((calls.find((call) => call.name === "check")?.args[0] as Record<string, unknown>).requiredBalance).toBe(1);
        });

        it("getBalances maps every Autumn feature balance, including unlimited", async () => {
            expect.assertions(3);

            const adapter = createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET });

            const balances = await adapter.getBalances?.("user_1");

            expect(balances).toContainEqual({ allowed: true, balance: 940, featureId: "api_calls", limit: 1000, unlimited: false, used: 60 });

            const unlimited = balances?.find((balance) => balance.featureId === "export");

            expect(unlimited?.unlimited).toBe(true);
            expect(unlimited?.allowed).toBe(true);
        });

        it("the facade delegates check + listBalances to the adapter, bypassing the local ledger", async () => {
            expect.assertions(3);

            // No `entitlements` config — proving the facade uses Autumn's truth, not the local evaluator
            // (which would throw "requires entitlements to be configured").
            const payment = createPayment({
                adapter: createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET }),
                authorize: () => true,
                store: new MemoryPaymentStore(),
            });

            const check = await payment.check({ featureId: "api_calls", referenceId: "user_1" });

            expect(check).toMatchObject({ allowed: true, balance: 940, limit: 1000 });

            const balances = await payment.listBalances("user_1");

            expect(balances).toHaveLength(2);
            expect(balances.map((balance) => balance.featureId).toSorted((a, b) => a.localeCompare(b))).toEqual(["api_calls", "export"]);
        });

        it("the facade still validates check() args before delegating (no fail-open on misuse)", async () => {
            expect.assertions(1);

            const payment = createPayment({
                adapter: createAutumnAdapter({ client: makeClient(), webhookSecret: SECRET }),
                authorize: () => true,
                store: new MemoryPaymentStore(),
            });

            // Neither featureId nor priceId — must throw VALIDATION_ERROR, not reach Autumn unscoped.
            await expect(payment.check({ referenceId: "user_1" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        });
    });
});
