import { describe, expect, it } from "vitest";

import type { PaymentAdapter } from "../src/adapter";
import type { CirrusDatabaseLike } from "../src/context";
import { paymentsFromContext } from "../src/context";
import type { Subscription } from "../src/types";

const makeDb = (): CirrusDatabaseLike => {
    const rows = new Map<string, Record<string, unknown>>();
    let sequence = 0;
    const matches = (row: Record<string, unknown>, where?: Record<string, unknown>): boolean =>
        Object.entries(where ?? {}).every(([key, value]) => row[key] === value);

    return {
        findFirst: async (_table, args) => [...rows.values()].find((row) => matches(row, args?.where)) ?? null,
        findMany: async (_table, args) => {
            return { page: [...rows.values()].filter((row) => matches(row, args?.where)) };
        },
        insert: async (_table, document) => {
            sequence += 1;
            const id = `id_${String(sequence)}`;

            rows.set(id, { ...document, _id: id });

            return id;
        },
        patch: async (id, patch) => {
            rows.set(id, { ...rows.get(id), ...patch, _id: id });
        },
    };
};

const subscription = (referenceId: string): Subscription => {
    return {
        cancelAtPeriodEnd: false,
        createdAt: 0,
        id: "sub_1",
        priceId: "price_1",
        provider: "stripe",
        quantity: 1,
        referenceId,
        state: "canceled",
        updatedAt: 0,
    };
};

const fakeAdapter: PaymentAdapter = {
    cancelPayment: async () => {
        throw new Error("not used");
    },
    cancelSubscription: async () => subscription("user_1"),
    capabilities: { merchantOfRecord: false, portal: true, usageMetering: true },
    capturePayment: async () => {
        throw new Error("not used");
    },
    createCheckout: async (input) => {
        return { id: "cs_1", provider: "stripe", url: `https://pay.test/${input.idempotencyKey ?? ""}` };
    },
    createPortalSession: async () => {
        return { url: "https://portal.test" };
    },
    getOrCreateCustomer: async (ref) => {
        return { createdAt: 0, id: "cus_1", provider: "stripe", referenceId: ref.referenceId };
    },
    identifier: "stripe",
    parseWebhook: async () => {
        return { eventId: "e", provider: "stripe", type: "unhandled" };
    },
    refundPayment: async () => {
        throw new Error("not used");
    },
    resumeSubscription: async () => subscription("user_1"),
    updateSubscription: async () => subscription("user_1"),
};

describe("paymentsFromContext", () => {
    it("builds a facade whose store rides ctx.db", async () => {
        const payment = paymentsFromContext({ auth: { userId: "user_1" }, db: makeDb() }, { adapter: fakeAdapter });

        const result = await payment.createCheckout({
            cancelUrl: "https://x/cancel",
            mode: "subscription",
            priceId: "price_1",
            referenceId: "user_1",
            successUrl: "https://x/ok",
        });

        expect(result.id).toBe("cs_1");
    });

    it("defaults authorization to the caller's own userId", async () => {
        const payment = paymentsFromContext({ auth: { userId: "user_1" }, db: makeDb() }, { adapter: fakeAdapter });

        await expect(
            payment.createCheckout({ cancelUrl: "https://x/c", mode: "payment", priceId: "price_1", referenceId: "user_2", successUrl: "https://x/o" }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("denies everything when the caller is unauthenticated", async () => {
        const payment = paymentsFromContext({ db: makeDb() }, { adapter: fakeAdapter });

        await expect(
            payment.createCheckout({ cancelUrl: "https://x/c", mode: "payment", priceId: "price_1", referenceId: "user_1", successUrl: "https://x/o" }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});
