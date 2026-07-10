import { describe, expect, it } from "vitest";

import type { PaymentAdapter } from "../src/adapter";
import { money } from "../src/money";
import { reconcile } from "../src/reconcile";
import { MemoryPaymentStore } from "../src/store";
import type { Subscription } from "../src/types";

const subscription = (state: Subscription["state"]): Subscription => {
    return {
        cancelAtPeriodEnd: false,
        createdAt: 100,
        id: "sub_1",
        priceId: "price_1",
        provider: "stripe",
        quantity: 1,
        referenceId: "user_1",
        state,
        updatedAt: 100,
    };
};

// Adapter whose "provider truth" is fixed: an active subscription and a captured payment.
const truthAdapter = (): PaymentAdapter =>
    ({
        getPaymentStatus: async (sessionId: string) => {
            return {
                amount: money(1000, "USD"),
                capturedAmount: money(1000, "USD"),
                createdAt: 5,
                id: sessionId,
                provider: "stripe",
                referenceId: "user_1",
                refundedAmount: money(0, "USD"),
                state: "captured",
                updatedAt: 5,
            };
        },
        getSubscriptionStatus: async () => subscription("active"),
        identifier: "stripe",
    }) as unknown as PaymentAdapter;

describe("reconcile", () => {
    it("repairs a subscription the store missed (drift from a dropped webhook)", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        // Store stuck on a stale state a missed cancellation→reactivation left behind.
        await store.upsertSubscription(subscription("past_due"));

        const result = await reconcile({ adapter: truthAdapter(), store, subscriptionIds: ["sub_1"] });

        expect(result).toEqual({
            checkedPayments: 0,
            checkedSubscriptions: 1,
            failedPayments: 0,
            failedSubscriptions: 0,
            updatedPayments: 0,
            updatedSubscriptions: 1,
        });

        const repaired = await store.getSubscription("stripe", "sub_1");

        expect(repaired?.state).toBe("active");
        // createdAt of the existing row is preserved.
        expect(repaired?.createdAt).toBe(100);
    });

    it("is a no-op when the store already matches the provider", async () => {
        expect.assertions(1);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("active"));

        const result = await reconcile({ adapter: truthAdapter(), store, subscriptionIds: ["sub_1"] });

        expect(result.updatedSubscriptions).toBe(0);
    });

    it("inserts and repairs payment sessions", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        const result = await reconcile({ adapter: truthAdapter(), paymentSessionIds: ["pi_1"], store });

        expect(result).toEqual({
            checkedPayments: 1,
            checkedSubscriptions: 0,
            failedPayments: 0,
            failedSubscriptions: 0,
            updatedPayments: 1,
            updatedSubscriptions: 0,
        });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(session?.state).toBe("captured");
        expect(session?.capturedAmount.minorUnits).toBe(1000n);
    });

    it("does not erase a refund when the provider status can't see it (reconcile must not re-entitle)", async () => {
        expect.assertions(3);

        const store = new MemoryPaymentStore();

        // A `charge.refunded` webhook already marked this session refunded in the store.
        await store.upsertPaymentSession({
            amount: money(1000, "USD"),
            capturedAmount: money(1000, "USD"),
            createdAt: 100,
            id: "pi_1",
            provider: "stripe",
            referenceId: "user_1",
            refundedAmount: money(1000, "USD"),
            state: "refunded",
            updatedAt: 100,
        });

        // The provider snapshot reports captured / refunded 0 (a Stripe PaymentIntent stays `succeeded`
        // after a refund). Reconcile must preserve the refund rather than overwrite it back to captured.
        const result = await reconcile({ adapter: truthAdapter(), paymentSessionIds: ["pi_1"], store });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(result.updatedPayments).toBe(0);
        expect(session?.state).toBe("refunded");
        expect(session?.refundedAmount.minorUnits).toBe(1000n);
    });

    it("does not blank a stored referenceId when the provider snapshot omits it", async () => {
        expect.assertions(2);

        const store = new MemoryPaymentStore();

        // Provider truth for this session carries an empty reference (e.g. a Polar order snapshot).
        const blankReferenceAdapter = {
            getPaymentStatus: async (sessionId: string) => {
                return {
                    amount: money(1000, "USD"),
                    capturedAmount: money(1000, "USD"),
                    createdAt: 5,
                    id: sessionId,
                    provider: "stripe",
                    referenceId: "",
                    refundedAmount: money(0, "USD"),
                    state: "captured" as const,
                    updatedAt: 5,
                };
            },
            identifier: "stripe",
        } as unknown as PaymentAdapter;

        await store.upsertPaymentSession({
            amount: money(1000, "USD"),
            capturedAmount: money(1000, "USD"),
            createdAt: 100,
            id: "pi_1",
            provider: "stripe",
            referenceId: "user_1",
            refundedAmount: money(0, "USD"),
            state: "captured",
            updatedAt: 100,
        });

        const result = await reconcile({ adapter: blankReferenceAdapter, paymentSessionIds: ["pi_1"], store });

        const session = await store.getPaymentSession("stripe", "pi_1");

        expect(result.updatedPayments).toBe(0);
        expect(session?.referenceId).toBe("user_1");
    });

    it("isolates a failing id so the rest of the batch still self-heals", async () => {
        expect.assertions(4);

        const store = new MemoryPaymentStore();

        await store.upsertSubscription(subscription("past_due"));

        // First id throws (e.g. a deleted/404'd subscription); the second must still reconcile.
        const flakyAdapter = {
            getSubscriptionStatus: async (id: string) => {
                if (id === "sub_boom") {
                    throw new Error("provider 404");
                }

                return subscription("active");
            },
            identifier: "stripe",
        } as unknown as PaymentAdapter;

        const events: { type: string }[] = [];

        const result = await reconcile({
            adapter: flakyAdapter,
            observability: (event) => events.push(event),
            store,
            subscriptionIds: ["sub_boom", "sub_1"],
        });

        expect(result).toEqual({
            checkedPayments: 0,
            checkedSubscriptions: 2,
            failedPayments: 0,
            failedSubscriptions: 1,
            updatedPayments: 0,
            updatedSubscriptions: 1,
        });

        // The healthy id was still repaired despite the sibling failure.
        const repairedSub = await store.getSubscription("stripe", "sub_1");

        expect(repairedSub?.state).toBe("active");
        // The failure is surfaced and `reconcile.completed` always fires.
        expect(events.map((event) => event.type)).toContain("reconcile.error");
        expect(events.at(-1)?.type).toBe("reconcile.completed");
    });
});
