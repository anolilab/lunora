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

/** Pages of a customer's subscriptions, as `customers.listSubscriptions` returns them. */
const subscriptionPages =
    (...pages: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
    async (_customerId: string, page = 1) => {
        return { items: pages[page - 1] ?? [], pagination: { nextPage: page < pages.length ? page + 1 : null } };
    };

const makeClient = (calls: RecordedCall[] = [], subscriptions = subscriptionPages([])): CreemClientLike => {
    return {
        checkouts: {
            create: async (request: Record<string, unknown>) => {
                calls.push({ args: [request], name: "checkout" });

                return { checkout_url: "https://creem.test/checkout", id: "ch_1", status: "pending" };
            },
            retrieve: async (id: string) => {
                return { id, order: { amount: 2500, currency: "EUR", status: "paid" }, status: "completed" };
            },
        },
        customers: {
            create: async (request: Record<string, unknown>) => {
                calls.push({ args: [request], name: "customer" });

                return { email: "a@b.test", id: "cust_1" };
            },
            generateBillingLinks: async (request: Record<string, unknown>) => {
                calls.push({ args: [request], name: "billing" });

                return { customer_portal_link: "https://creem.test/portal" };
            },
            listSubscriptions: subscriptions,
        },
        subscriptions: {
            cancel: async (id: string, request?: Record<string, unknown>) => {
                calls.push({ args: [id, request], name: "cancel" });

                return { canceled_at: "2026-07-05T00:00:00Z", id, product: "prod_pro", status: "scheduled_cancel" };
            },
            get: async (id: string) => {
                return { id, product: { id: "prod_pro" }, status: "active" };
            },
            resume: async (id: string) => {
                calls.push({ args: [id], name: "resume" });

                return { id, product: "prod_pro", status: "active" };
            },
            upgrade: async (id: string, request: Record<string, unknown>) => {
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

    it("starts an unbound checkout without prefilling a foreign customer's email (security regression)", async () => {
        expect.assertions(1);

        const calls: RecordedCall[] = [];
        const adapter = createCreemAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        await adapter.createCheckout({ email: "a@b.test", mode: "subscription", priceId: "prod_team", referenceId: "org_1", successUrl: "https://x/ok" });

        // Prefilling would let Creem attach org_1's purchase to the customer (and portal) of the
        // reference that already owns this email.
        expect((calls.find((call) => call.name === "checkout")?.args[0] as Record<string, unknown>).customer).toBeUndefined();
    });

    it("opens a hosted billing portal via generateBillingLinks", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createCreemAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const portal = await adapter.createPortalSession({ customerId: "cust_1", referenceId: "user_1", returnUrl: "https://x/back" });

        expect(portal).toEqual({ url: "https://creem.test/portal" });
        expect(calls.find((call) => call.name === "billing")?.args[0]).toEqual({ customerId: "cust_1" });
    });

    it("refuses the hosted portal when the customer holds another reference's subscription (security)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        // Page 2 holds org_b's subscription: the same person pays for a second org with one email.
        const subscriptions = subscriptionPages([{ id: "sub_a", metadata: { referenceId: "org_a" } }], [{ id: "sub_b", metadata: { referenceId: "org_b" } }]);
        const adapter = createCreemAdapter({ client: makeClient(calls, subscriptions), webhookSecret: SECRET });

        await expect(adapter.createPortalSession({ customerId: "cust_1", referenceId: "org_a", returnUrl: "https://x/back" })).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(calls.some((call) => call.name === "billing")).toBe(false);
    });

    it("opens the portal when every subscription is this reference's or unattributed", async () => {
        expect.assertions(1);

        const subscriptions = subscriptionPages([{ id: "sub_a", metadata: { referenceId: "org_a" } }, { id: "sub_dashboard" }]);
        const adapter = createCreemAdapter({ client: makeClient([], subscriptions), webhookSecret: SECRET });

        await expect(adapter.createPortalSession({ customerId: "cust_1", referenceId: "org_a", returnUrl: "https://x/back" })).resolves.toEqual({
            url: "https://creem.test/portal",
        });
    });

    it("cancels at period end via mode=scheduled and reflects the scheduled-cancel state", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const adapter = createCreemAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        const subscription = await adapter.cancelSubscription("sub_1", { atPeriodEnd: true });

        // atPeriodEnd must be threaded through as Creem's `mode`, not dropped.
        expect((calls.find((call) => call.name === "cancel")?.args[1] as Record<string, unknown>).mode).toBe("scheduled");
        // scheduled_cancel is still entitling (active until period end) but flagged cancelAtPeriodEnd.
        expect(subscription.state).toBe("active");
        expect(subscription.cancelAtPeriodEnd).toBe(true);
    });

    it("cancels immediately via mode=immediate by default (regression)", async () => {
        expect.assertions(1);

        const calls: RecordedCall[] = [];
        const adapter = createCreemAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        await adapter.cancelSubscription("sub_1");

        // No atPeriodEnd → immediate, matching the other adapters (not left to the store default).
        expect((calls.find((call) => call.name === "cancel")?.args[1] as Record<string, unknown>).mode).toBe("immediate");
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

    describe("seat (quantity) and plan updates", () => {
        /** A client whose subscription exposes its items the way the SDK does (`items[].productId` / `units`). */
        const makeSeatClient = (calls: RecordedCall[], items: Record<string, unknown>[]): CreemClientLike => {
            const client = makeClient(calls);

            (client as { subscriptions: unknown }).subscriptions = {
                get: async (id: string) => {
                    return { id, items, product: "prod_pro", status: "active" };
                },
                update: async (id: string, request: Record<string, unknown>) => {
                    calls.push({ args: [id, request], name: "update" });

                    return { id, items: [{ id: "item_pro", productId: "prod_pro", units: 3 }], product: "prod_pro", status: "active" };
                },
                upgrade: async (id: string, request: Record<string, unknown>) => {
                    calls.push({ args: [id, request], name: "upgrade" });

                    return { id, product: "prod_enterprise", status: "active" };
                },
            };

            return client;
        };

        it("sets the units on the subscription item for the current product, not on an add-on", async () => {
            expect.assertions(3);

            const calls: RecordedCall[] = [];
            const adapter = createCreemAdapter({
                client: makeSeatClient(calls, [
                    { id: "item_addon", productId: "prod_addon", units: 1 },
                    { id: "item_pro", productId: "prod_pro", units: 1 },
                ]),
                webhookSecret: SECRET,
            });

            const subscription = await adapter.updateSubscription("sub_1", { quantity: 3 });

            expect(calls.find((call) => call.name === "update")?.args).toStrictEqual([
                "sub_1",
                { items: [{ id: "item_pro", units: 3 }], updateBehavior: "proration-charge-immediately" },
            ]);
            expect(subscription.quantity).toBe(3);
            expect(calls.some((call) => call.name === "upgrade")).toBe(false);
        });

        it("maps the caller's proration choice onto the units update", async () => {
            expect.assertions(1);

            const calls: RecordedCall[] = [];
            const adapter = createCreemAdapter({
                client: makeSeatClient(calls, [{ id: "item_pro", productId: "prod_pro", units: 1 }]),
                webhookSecret: SECRET,
            });

            await adapter.updateSubscription("sub_1", { proration: "next-invoice", quantity: 3 });

            expect((calls.find((call) => call.name === "update")?.args[1] as Record<string, unknown>).updateBehavior).toBe("proration-charge");
        });

        it("throws instead of reporting success when no item matches the current product", async () => {
            expect.assertions(2);

            const calls: RecordedCall[] = [];
            const adapter = createCreemAdapter({
                client: makeSeatClient(calls, [{ id: "item_addon", productId: "prod_addon", units: 1 }]),
                webhookSecret: SECRET,
            });

            await expect(adapter.updateSubscription("sub_1", { quantity: 3 })).rejects.toThrow("does not support");
            expect(calls.some((call) => call.name === "update")).toBe(false);
        });

        it("refuses a plan change and a seat change in one patch, since they cannot be applied atomically", async () => {
            expect.assertions(2);

            const calls: RecordedCall[] = [];
            const adapter = createCreemAdapter({
                client: makeSeatClient(calls, [{ id: "item_pro", productId: "prod_pro", units: 1 }]),
                webhookSecret: SECRET,
            });

            await expect(adapter.updateSubscription("sub_1", { priceId: "prod_enterprise", quantity: 3 })).rejects.toThrow("does not support");
            expect(calls).toStrictEqual([]);
        });

        it("passes the caller's proration choice through on a plan upgrade", async () => {
            expect.assertions(1);

            const calls: RecordedCall[] = [];
            const adapter = createCreemAdapter({
                client: makeSeatClient(calls, [{ id: "item_pro", productId: "prod_pro", units: 1 }]),
                webhookSecret: SECRET,
            });

            await adapter.updateSubscription("sub_1", { priceId: "prod_enterprise", proration: "none" });

            expect((calls.find((call) => call.name === "upgrade")?.args[1] as Record<string, unknown>).updateBehavior).toBe("proration-none");
        });
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

    it("reads the reference from the metadata Creem copies onto the subscription, never from the customer id", async () => {
        expect.assertions(2);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });
        // Shape of Creem's documented `subscription.active` payload: the checkout's metadata rides along.
        const copied = JSON.stringify({
            eventType: "subscription.active",
            id: "evt_2",
            object: { customer: { id: "cust_1" }, id: "sub_1", metadata: { referenceId: "org_1" }, product: { id: "prod_team" }, status: "active" },
        });
        const missing = JSON.stringify({
            eventType: "subscription.active",
            id: "evt_3",
            object: { customer: { id: "cust_1" }, id: "sub_2", product: { id: "prod_team" }, status: "active" },
        });

        await expect(adapter.parseWebhook({ headers: headersFor(sign(copied)), payload: copied })).resolves.toMatchObject({ referenceId: "org_1" });
        // Left unattributed (stored orphaned until `checkout.completed` adopts it) — the customer id
        // is not an app reference and would silently grant nothing to anyone.
        await expect(adapter.parseWebhook({ headers: headersFor(sign(missing)), payload: missing })).resolves.toMatchObject({ referenceId: undefined });
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

    it("maps subscription.expired to canceled whatever status it carries, with occurredAt (regression)", async () => {
        expect.assertions(2);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });
        // Creem's `SubscriptionStatus` has no `expired` member, so the payload can still read `active`.
        const body = JSON.stringify({
            created_at: 1_767_323_045_000,
            eventType: "subscription.expired",
            id: "e9",
            object: { id: "sub_1", product: "prod_pro", status: "active" },
        });
        const action = await adapter.parseWebhook({ headers: headersFor(sign(body)), payload: body });

        expect(action.type).toBe("subscription.canceled");
        expect(action.occurredAt).toBe(1_767_323_045_000);
    });

    it("reads the SDK's Date fields and items[].units on subscription responses (regression)", async () => {
        expect.assertions(4);

        const client = makeClient();

        // The real SDK zod-parses date fields into `Date`s and carries units on `items[]`.
        (client as { subscriptions: { get: unknown } }).subscriptions = {
            get: async (id: string) => {
                return {
                    canceledAt: new Date("2026-07-05T00:00:00Z"),
                    currentPeriodEndDate: new Date("2026-08-01T00:00:00Z"),
                    currentPeriodStartDate: new Date("2026-07-01T00:00:00Z"),
                    id,
                    items: [{ id: "item_1", productId: "prod_pro", units: 5 }],
                    product: "prod_pro",
                    status: "active",
                };
            },
        };
        const subscription = await createCreemAdapter({ client, webhookSecret: SECRET }).getSubscriptionStatus("sub_1");

        expect(subscription.currentPeriodEnd).toBe(Date.parse("2026-08-01T00:00:00Z"));
        expect(subscription.currentPeriodStart).toBe(Date.parse("2026-07-01T00:00:00Z"));
        expect(subscription.cancelAtPeriodEnd).toBe(true);
        expect(subscription.quantity).toBe(5);
    });

    it("normalizes a refund.created webhook from Creem's flat refund fields (regression)", async () => {
        expect.assertions(5);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });
        // A real `RefundEntity`: `transaction` is required, `checkout` is optional but present on a
        // refund of a checkout — so the fixture carries BOTH and the key choice is unambiguous.
        const payload = JSON.stringify({
            eventType: "refund.created",
            id: "evt_refund",
            object: {
                checkout: { id: "ch_1" },
                id: "rf_1",
                metadata: { referenceId: "user_1" },
                refund_amount: 1500,
                refund_currency: "EUR",
                // Required on `RefundEntity`; only a settled refund books money.
                status: "succeeded",
                transaction: { id: "tx_1" },
            },
        });
        const action = await adapter.parseWebhook({ headers: headersFor(sign(payload)), payload });

        // The amount/currency come from `refund_amount`/`refund_currency`, and the session keys back to
        // the CHECKOUT id — that is what `checkout.completed` wrote as the row id and what
        // `getPaymentStatus` retrieves. `transaction.id` is a different object's id and would orphan.
        expect(action.type).toBe("payment.refunded");
        expect(action.amount?.minorUnits).toBe(1500n);
        expect(action.amount?.currency).toBe("EUR");
        expect(action.sessionId).toBe("ch_1");
        // The refund's own id still travels, on `refundId` — a same-amount dashboard refund must not
        // consume a marker meant for another refund.
        expect(action.refundId).toBe("rf_1");
    });

    it("does not book a refund.created that is still pending (regression)", async () => {
        expect.assertions(2);

        // `RefundEntity.status` is pending | requiresAction | succeeded | failed | canceled, and Creem
        // documents the first two as non-terminal processing states. Booking one leaves the ledger
        // claiming a refund the customer never got, which the facade's over-refund guard then makes
        // unissuable.
        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });

        for (const status of ["pending", "requiresAction"]) {
            const payload = JSON.stringify({
                eventType: "refund.created",
                id: `evt_refund_${status}`,
                object: { checkout: { id: "ch_1" }, id: "rf_1", refund_amount: 1500, refund_currency: "EUR", status, transaction: { id: "tx_1" } },
            });
            // eslint-disable-next-line no-await-in-loop -- two fixtures, read serially for a clearer failure
            const action = await adapter.parseWebhook({ headers: headersFor(sign(payload)), payload });

            expect(action.type).toBe("unhandled");
        }
    });

    it("keys a dashboard refund to the checkout row a checkout.completed created (regression)", async () => {
        expect.assertions(2);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });
        const checkoutBody = JSON.stringify({
            eventType: "checkout.completed",
            id: "evt_checkout",
            object: { id: "ch_1", order: { amount: 1500, currency: "EUR", status: "paid" } },
        });
        const captured = await adapter.parseWebhook({ headers: headersFor(sign(checkoutBody)), payload: checkoutBody });

        const refundBody = JSON.stringify({
            eventType: "refund.created",
            id: "evt_refund_2",
            object: { checkout: "ch_1", id: "rf_2", refund_amount: 1500, refund_currency: "EUR", status: "succeeded", transaction: { id: "tx_2" } },
        });
        const refunded = await adapter.parseWebhook({ headers: headersFor(sign(refundBody)), payload: refundBody });

        // Same key on both events, or the refund orphans and the row stays `captured` forever.
        // `checkout` also arrives as a bare id string on some deliveries — `idOf` handles both.
        expect(refunded.sessionId).toBe(captured.sessionId);
        expect(refunded.sessionId).toBe("ch_1");
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

    it("pins the reference into the new customer's metadata and externalId", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const adapter = createCreemAdapter({ client: makeClient(calls), webhookSecret: SECRET });

        await adapter.getOrCreateCustomer({ email: "a@b.test", referenceId: "user_1" });

        const body = calls.find((call) => call.name === "customer")?.args[0] as Record<string, unknown>;

        expect((body.metadata as { referenceId?: string }).referenceId).toBe("user_1");
        expect(body.externalId).toBe("user_1");
    });

    it("reuses the existing customer on a same-reference retry after a duplicate-email conflict (regression)", async () => {
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
                retrieve: async (customerId?: string, email?: string) => {
                    calls.push({ args: [customerId, email], name: "retrieve" });

                    // The existing customer was minted for the SAME reference (an idempotent retry).
                    return { email: "a@b.test", id: "cust_existing", metadata: { referenceId: "user_1" } };
                },
            },
        };
        const adapter = createCreemAdapter({ client, webhookSecret: SECRET });

        const customer = await adapter.getOrCreateCustomer({ email: "a@b.test", referenceId: "user_1" });

        expect(customer?.id).toBe("cust_existing");
        expect(calls.some((call) => call.name === "create")).toBe(true);
        // Creem's retrieve is positional `(customerId?, email?)` — the email lands in the second arg.
        expect(calls.find((call) => call.name === "retrieve")?.args[1]).toBe("a@b.test");
    });

    it("never binds a foreign reference's Creem customer on a shared-email conflict, reporting none instead (security regression)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const client: CreemClientLike = {
            ...makeClient(),
            customers: {
                create: async () => {
                    throw new Error("A resource with this identifier already exists");
                },
                generateBillingLinks: async () => {
                    return {};
                },
                retrieve: async (customerId?: string, email?: string) => {
                    calls.push({ args: [customerId, email], name: "retrieve" });

                    // The email already belongs to a DIFFERENT reference (e.g. a second org/user
                    // sharing an inbox). Adopting this customer would leak org_a's billing portal
                    // (subscriptions/invoices/payment methods) to org_b via createPortalSession.
                    return { email: "shared@b.test", id: "cust_org_a", metadata: { referenceId: "org_a" } };
                },
            },
        };
        const adapter = createCreemAdapter({ client, webhookSecret: SECRET });

        // One person paying under two references is normal, so this is not an error — but org_b gets
        // no customer (and so no portal onto org_a's billing); its checkout starts unbound.
        await expect(adapter.getOrCreateCustomer({ email: "shared@b.test", referenceId: "org_b" })).resolves.toBeUndefined();

        // The lookup must still happen (to check the reference), but its result is never adopted.
        expect(calls.some((call) => call.name === "retrieve")).toBe(true);
    });

    it("rethrows a non-conflict create error instead of falling into the email lookup (regression)", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const client: CreemClientLike = {
            ...makeClient(),
            customers: {
                create: async () => {
                    throw new Error("upstream request timed out");
                },
                generateBillingLinks: async () => {
                    return {};
                },
                retrieve: async (customerId?: string, email?: string) => {
                    calls.push({ args: [customerId, email], name: "retrieve" });

                    return { email: "a@b.test", id: "cust_existing" };
                },
            },
        };
        const adapter = createCreemAdapter({ client, webhookSecret: SECRET });

        await expect(adapter.getOrCreateCustomer({ email: "a@b.test", referenceId: "user_1" })).rejects.toThrow(/timed out/);

        // A network/timeout failure must propagate — never reinterpreted as "go find the customer".
        expect(calls.some((call) => call.name === "retrieve")).toBe(false);
    });

    it("rejects a bad signature", async () => {
        expect.assertions(1);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });

        await expect(adapter.parseWebhook({ headers: headersFor("deadbeef"), payload: "{}" })).rejects.toMatchObject({
            code: "WEBHOOK_SIGNATURE_INVALID",
        });
    });

    it("reads the event id from event_id when id is absent (field-casing drift)", async () => {
        expect.assertions(1);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            event_id: "evt_casing",
            eventType: "checkout.completed",
            object: { id: "ch_1", metadata: { referenceId: "user_1" }, order: { amount: 2500, currency: "EUR", status: "paid" } },
        });
        const action = await adapter.parseWebhook({ headers: headersFor(sign(payload)), payload });

        expect(action.eventId).toBe("evt_casing");
    });

    it("maps a payload with no id field at all to a blank eventId for the central guard to reject", async () => {
        expect.assertions(1);

        const adapter = createCreemAdapter({ client: makeClient(), webhookSecret: SECRET });
        const payload = JSON.stringify({
            eventType: "checkout.completed",
            object: { id: "ch_1", metadata: { referenceId: "user_1" }, order: { amount: 2500, currency: "EUR", status: "paid" } },
        });
        const action = await adapter.parseWebhook({ headers: headersFor(sign(payload)), payload });

        // parseWebhook itself does not throw — it hands back a blank eventId, which
        // applyWebhookAction's central guard (sync.ts) is responsible for rejecting before the
        // dedupe store is ever touched.
        expect(action.eventId).toBe("");
    });
});
