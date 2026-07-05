import { describe, expect, it } from "vitest";

import type { AutumnFeaturesClientLike } from "../../src/providers/autumn-features";
import { createAutumnFeatures } from "../../src/providers/autumn-features";

interface RecordedCall {
    args: unknown[];
    name: string;
}

const makeClient = (calls: RecordedCall[] = []): AutumnFeaturesClientLike => {
    return {
        attach: async (parameters) => {
            calls.push({ args: [parameters], name: "attach" });

            return { checkout_url: "https://autumn.test/checkout" };
        },
        entities: {
            create: async (customerId, parameters) => {
                calls.push({ args: [customerId, parameters], name: "entities.create" });

                return { feature_id: "seats", id: "ent_1", name: "Workspace A" };
            },
            delete: async (customerId, entityId) => {
                calls.push({ args: [customerId, entityId], name: "entities.delete" });

                return { success: true };
            },
            get: async (customerId, entityId, parameters) => {
                calls.push({ args: [customerId, entityId, parameters], name: "entities.get" });

                return { feature_id: "seats", id: entityId, name: "Workspace A" };
            },
        },
        events: {
            aggregate: async (parameters) => {
                calls.push({ args: [parameters], name: "events.aggregate" });

                return {
                    list: [
                        { count: 12, period: "2026-07-01" },
                        { count: 8, period: "2026-07-02" },
                    ],
                };
            },
            list: async (parameters) => {
                calls.push({ args: [parameters], name: "events.list" });

                return { list: [{ count: 1 }, { count: 1 }] };
            },
        },
        products: {
            list: async (parameters) => {
                calls.push({ args: [parameters], name: "products.list" });

                return { list: [{ id: "pro" }, { id: "enterprise" }] };
            },
        },
        referrals: {
            createCode: async (parameters) => {
                calls.push({ args: [parameters], name: "referrals.createCode" });

                return { code: "FRIEND-123" };
            },
            redeemCode: async (parameters) => {
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
        expect(calls[0]).toMatchObject({ args: ["user_1", { feature_id: "seats", id: "ent_1", name: "Workspace A" }], name: "entities.create" });

        const fetched = await features.entities.get("user_1", "ent_1", ["invoices"]);

        expect(fetched.id).toBe("ent_1");
        expect(calls[1]?.args[2]).toEqual({ expand: ["invoices"] });

        await features.entities.delete("user_1", "ent_1");

        expect(calls.at(-1)).toEqual({ args: ["user_1", "ent_1"], name: "entities.delete" });
    });

    it("mints and redeems referral codes", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const features = createAutumnFeatures({ client: makeClient(calls) });

        const minted = await features.referrals.createCode("user_1", "launch-program");

        expect(minted.code).toBe("FRIEND-123");
        expect(calls[0]).toEqual({ args: [{ customer_id: "user_1", program_id: "launch-program" }], name: "referrals.createCode" });

        await features.referrals.redeemCode("user_2", "FRIEND-123");

        expect(calls[1]).toEqual({ args: [{ code: "FRIEND-123", customer_id: "user_2" }], name: "referrals.redeemCode" });
    });

    it("lists and aggregates usage events into points", async () => {
        expect.assertions(3);

        const calls: RecordedCall[] = [];
        const features = createAutumnFeatures({ client: makeClient(calls) });

        const listed = await features.events.list("user_1", { featureId: "api_calls" });

        expect(listed).toHaveLength(2);

        const aggregated = await features.events.aggregate("user_1", { featureId: "api_calls", range: "7d" });

        expect(aggregated[0]).toMatchObject({ count: 12, period: "2026-07-01" });
        expect(calls.at(-1)?.args[0]).toMatchObject({ customer_id: "user_1", feature_id: "api_calls", range: "7d" });
    });

    it("lists the product catalog", async () => {
        expect.assertions(2);

        const features = createAutumnFeatures({ client: makeClient() });

        const products = await features.products.list("user_1");

        expect(products).toHaveLength(2);
        expect(products.map((product) => product.id)).toEqual(["pro", "enterprise"]);
    });

    it("runs a native checkout with a free trial, prepaid options, entity scope, and reward", async () => {
        expect.assertions(2);

        const calls: RecordedCall[] = [];
        const features = createAutumnFeatures({ client: makeClient(calls) });

        const result = await features.checkout("user_1", {
            entityId: "ent_1",
            freeTrial: true,
            options: [{ featureId: "seats", quantity: 5 }],
            productId: "pro",
            reward: "FRIEND-123",
            successUrl: "https://x/ok",
        });

        expect(result.url).toBe("https://autumn.test/checkout");
        expect(calls[0]?.args[0]).toEqual({
            customer_id: "user_1",
            entity_id: "ent_1",
            free_trial: true,
            options: [{ feature_id: "seats", quantity: 5 }],
            product_id: "pro",
            reward: "FRIEND-123",
            success_url: "https://x/ok",
        });
    });
});
