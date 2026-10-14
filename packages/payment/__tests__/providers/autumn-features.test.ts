import { describe, expect, it } from "vitest";

import type { AutumnFeaturesClientLike } from "../../src/providers/autumn-features";
import { createAutumnFeatures } from "../../src/providers/autumn-features";

interface RecordedCall {
    args: unknown[];
    name: string;
}

const makeClient = (calls: RecordedCall[] = []): AutumnFeaturesClientLike => {
    return {
        billing: {
            attach: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "billing.attach" });

                return { customerId: "user_1", paymentUrl: "https://autumn.test/checkout" };
            },
        },
        entities: {
            create: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "entities.create" });

                return { featureId: "seats", id: "ent_1", name: "Workspace A" };
            },
            delete: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "entities.delete" });

                return { success: true };
            },
            get: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "entities.get" });

                return { featureId: "seats", id: parameters.entityId, name: "Workspace A" };
            },
        },
        events: {
            aggregate: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "events.aggregate" });

                return {
                    list: [
                        { count: 12, period: "2026-07-01" },
                        { count: 8, period: "2026-07-02" },
                    ],
                };
            },
            list: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "events.list" });

                return { list: [{ count: 1 }, { count: 1 }] };
            },
        },
        plans: {
            list: async () => {
                calls.push({ args: [], name: "plans.list" });

                return { list: [{ id: "pro" }, { id: "enterprise" }] };
            },
        },
        referrals: {
            createCode: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "referrals.createCode" });

                return { code: "FRIEND-123" };
            },
            redeemCode: async (parameters: Record<string, unknown>) => {
                calls.push({ args: [parameters], name: "referrals.redeemCode" });

                return { redeemed: true };
            },
        },
    };
};

describe("autumn native features", () => {
    it("creates, fetches, and deletes an entity (per-seat sub-customer)", async () => {
        expect.assertions(5);

        const calls: RecordedCall[] = [];
        const features = createAutumnFeatures({ client: makeClient(calls) });

        const created = await features.entities.create("user_1", { featureId: "seats", id: "ent_1", name: "Workspace A" });

        expect(created).toMatchObject({ featureId: "seats", id: "ent_1", name: "Workspace A" });
        // The reference is threaded as customerId, the caller id as entityId — both camelCase params.
        expect(calls[0]).toMatchObject({
            args: [{ customerId: "user_1", entityId: "ent_1", featureId: "seats", name: "Workspace A" }],
            name: "entities.create",
        });

        const fetched = await features.entities.get("user_1", "ent_1");

        expect(fetched.id).toBe("ent_1");
        expect(calls[1]?.args[0]).toEqual({ customerId: "user_1", entityId: "ent_1" });

        await features.entities.delete("user_1", "ent_1");

        expect(calls.at(-1)).toEqual({ args: [{ customerId: "user_1", entityId: "ent_1" }], name: "entities.delete" });
    });

    it("mints and redeems referral codes", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const features = createAutumnFeatures({ client: makeClient(calls) });

        const minted = await features.referrals.createCode("user_1", "launch-program");

        expect(minted.code).toBe("FRIEND-123");
        expect(calls[0]).toEqual({ args: [{ customerId: "user_1", programId: "launch-program" }], name: "referrals.createCode" });

        await features.referrals.redeemCode("user_2", "FRIEND-123");

        expect(calls[1]).toEqual({ args: [{ code: "FRIEND-123", customerId: "user_2" }], name: "referrals.redeemCode" });
    });

    it("lists and aggregates usage events into points", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const features = createAutumnFeatures({ client: makeClient(calls) });

        const listed = await features.events.list("user_1", { featureId: "api_calls" });

        expect(listed).toHaveLength(2);

        const aggregated = await features.events.aggregate("user_1", { featureId: "api_calls", range: "7d" });

        expect(aggregated[0]).toMatchObject({ count: 12, period: "2026-07-01" });
        expect(calls.at(-1)?.args[0]).toMatchObject({ customerId: "user_1", featureId: "api_calls", range: "7d" });
    });

    it("lists the plan catalog", async () => {
        expect.assertions(2);

        const features = createAutumnFeatures({ client: makeClient() });

        const plans = await features.plans.list();

        expect(plans).toHaveLength(2);
        expect(plans.map((plan) => plan.id)).toEqual(["pro", "enterprise"]);
    });

    it("runs a native checkout with prepaid options, entity scope, and a reward, opting out of the trial", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const features = createAutumnFeatures({ client: makeClient(calls) });

        const result = await features.checkout("user_1", {
            entityId: "ent_1",
            freeTrial: false,
            options: [{ featureId: "seats", quantity: 5 }],
            planId: "pro",
            reward: "FRIEND-123",
            successUrl: "https://x/ok",
        });

        expect(result.url).toBe("https://autumn.test/checkout");
        expect(calls[0]?.args[0]).toEqual({
            customerId: "user_1",
            customize: { freeTrial: null },
            discounts: [{ rewardId: "FRIEND-123" }],
            entityId: "ent_1",
            featureQuantities: [{ featureId: "seats", quantity: 5 }],
            planId: "pro",
            successUrl: "https://x/ok",
        });
    });
});
