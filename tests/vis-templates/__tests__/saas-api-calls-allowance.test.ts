import { createPayment, MemoryPaymentStore } from "@lunora/payment";
import type { PaymentAdapter, Subscription } from "@lunora/payment";
import { describe, expect, test } from "vitest";

import { API_CALLS, entitlementsFromPlans, PLANS } from "../../../templates/saas/lunora/plans";

/*
 * The saas kit's `track` and `check` actions run against `createPayment` with the
 * catalog's entitlements. Only the store and the entitlements matter here: the
 * adapter is never reached for a metered feature, so every method throws.
 */
const notUsed = async (): Promise<never> => {
    throw new Error("not used");
};

const adapter: PaymentAdapter = {
    cancelPayment: notUsed,
    cancelSubscription: notUsed,
    capabilities: { checkoutExpiry: false, merchantOfRecord: false, portal: false, usageMetering: false },
    capturePayment: notUsed,
    createCheckout: notUsed,
    createPortalSession: notUsed,
    getOrCreateCustomer: notUsed,
    getPaymentStatus: notUsed,
    getSubscriptionStatus: notUsed,
    identifier: "stripe",
    parseWebhook: notUsed,
    refundPayment: notUsed,
    resumeSubscription: notUsed,
    updateSubscription: notUsed,
};

const REFERENCE = "org_1";

const activeSubscription = (priceId: string): Subscription => ({
    cancelAtPeriodEnd: false,
    createdAt: 0,
    id: `sub_${priceId}`,
    priceId,
    provider: "stripe",
    quantity: 1,
    referenceId: REFERENCE,
    state: "active",
    updatedAt: 0,
});

const paymentFor = async (priceId: string | undefined) => {
    const store = new MemoryPaymentStore();

    if (priceId !== undefined) {
        await store.upsertSubscription(activeSubscription(priceId));
    }

    return createPayment({ adapter, authorize: () => true, entitlements: entitlementsFromPlans(PLANS), store });
};

const pricedPlans = PLANS.filter((plan) => plan.priceId !== undefined);

describe.each(pricedPlans)("api_calls allowance on the $name plan", (plan) => {
    test("is granted up to the plan's limit and denied past it", async () => {
        const payment = await paymentFor(plan.priceId);

        await payment.track({ featureId: API_CALLS, quantity: plan.apiCalls - 1, referenceId: REFERENCE });
        expect(await payment.check({ featureId: API_CALLS, referenceId: REFERENCE })).toMatchObject({ allowed: true, balance: 1, limit: plan.apiCalls });

        await payment.track({ featureId: API_CALLS, referenceId: REFERENCE });
        expect(await payment.check({ featureId: API_CALLS, referenceId: REFERENCE })).toMatchObject({ allowed: false, balance: 0, limit: plan.apiCalls });
    });
});

test("the free plan grants no api_calls allowance", async () => {
    const payment = await paymentFor(undefined);

    expect(await payment.check({ featureId: API_CALLS, referenceId: REFERENCE })).toMatchObject({ allowed: false });
});
