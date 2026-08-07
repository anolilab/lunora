import { describe, expect, it } from "vitest";

import type { PaymentDatabase, PaymentRow } from "../src/database-store";
import { createDatabasePaymentStore } from "../src/database-store";
import { money } from "../src/money";
import type { Customer, PaymentSession, Subscription } from "../src/types";

// In-memory PaymentDatabase that mirrors the equality-filter semantics ctx.db provides.
const makeDb = (): PaymentDatabase => {
    const tables = new Map<string, Map<string, PaymentRow>>();
    let sequence = 0;

    const tableOf = (table: string): Map<string, PaymentRow> => {
        const existing = tables.get(table);

        if (existing) {
            return existing;
        }

        const created = new Map<string, PaymentRow>();

        tables.set(table, created);

        return created;
    };

    const matches = (row: PaymentRow, where: Record<string, unknown>): boolean => Object.entries(where).every(([key, value]) => row[key] === value);

    return {
        delete: async (id) => {
            for (const rows of tables.values()) {
                if (rows.delete(id)) {
                    return;
                }
            }
        },
        findFirst: async (table, where) => [...tableOf(table).values()].find((row) => matches(row, where)) ?? null,
        findMany: async (table, where) => [...tableOf(table).values()].filter((row) => matches(row, where)),
        insert: async (table, document) => {
            sequence += 1;
            const id = `id_${String(sequence)}`;

            tableOf(table).set(id, { ...document, _id: id });

            return id;
        },
        patch: async (id, patch) => {
            for (const rows of tables.values()) {
                const row = rows.get(id);

                if (row) {
                    rows.set(id, { ...row, ...patch });

                    return;
                }
            }
        },
    };
};

const customer: Customer = { createdAt: 1, email: "a@b.test", id: "cus_1", provider: "stripe", referenceId: "user_1" };

const session: PaymentSession = {
    amount: money(1000, "USD"),
    capturedAmount: money(1000, "USD"),
    createdAt: 1,
    id: "pi_1",
    provider: "stripe",
    referenceId: "user_1",
    refundedAmount: money(0, "USD"),
    state: "captured",
    updatedAt: 1,
};

const subscription: Subscription = {
    cancelAtPeriodEnd: false,
    createdAt: 1,
    currentPeriodEnd: 999,
    id: "sub_1",
    priceId: "price_1",
    provider: "stripe",
    quantity: 2,
    referenceId: "user_1",
    state: "active",
    updatedAt: 1,
};

describe("createDatabasePaymentStore", () => {
    it("round-trips a customer through the row codec", async () => {
        expect.assertions(1);

        const store = createDatabasePaymentStore(makeDb());

        await store.upsertCustomer(customer);

        await expect(store.getCustomerByReference("stripe", "user_1")).resolves.toEqual(customer);
    });

    it("round-trips a payment session, preserving bigint money", async () => {
        expect.assertions(2);

        const store = createDatabasePaymentStore(makeDb());

        await store.upsertPaymentSession(session);

        const loaded = await store.getPaymentSession("stripe", "pi_1");

        expect(loaded).toEqual(session);
        expect(loaded?.capturedAmount.minorUnits).toBe(1000n);
    });

    it("upserts in place rather than duplicating", async () => {
        expect.assertions(2);

        const db = makeDb();
        const store = createDatabasePaymentStore(db);

        await store.upsertSubscription(subscription);
        await store.upsertSubscription({ ...subscription, state: "canceled" });

        const all = await store.listSubscriptionsByReference("user_1");

        expect(all).toHaveLength(1);
        expect(all[0]?.state).toBe("canceled");
    });

    it("dedupes events via markEventProcessed", async () => {
        expect.assertions(3);

        const store = createDatabasePaymentStore(makeDb());

        await expect(store.markEventProcessed("stripe", "evt_1")).resolves.toBe(true);
        await expect(store.markEventProcessed("stripe", "evt_1")).resolves.toBe(false);
        await expect(store.markEventProcessed("stripe", "evt_2")).resolves.toBe(true);
    });

    it("sumUsage folds a `set` marker the same way the in-memory store does", async () => {
        expect.assertions(3);

        const store = createDatabasePaymentStore(makeDb());
        const event = (idempotencyKey: string, createdAt: number, quantity: number, mode?: "set") => {
            return {
                createdAt,
                featureId: "api_calls",
                idempotencyKey,
                ...(mode === undefined ? {} : { mode }),
                provider: "stripe" as const,
                quantity,
                referenceId: "user_1",
                reportedToProvider: false,
            };
        };

        await store.recordUsage(event("a", 10, 30));

        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(30);

        // The marker RESETS the period rather than adding to it — the `mode` column
        // has to survive the row round-trip for that to hold.
        await store.recordUsage(event("b", 20, 5, "set"));

        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(5);

        // …and a later `add` accrues on top of the reset total.
        await store.recordUsage(event("c", 30, 7));

        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(12);
    });

    it("releaseEvent rolls back a claim so the id can be re-processed", async () => {
        expect.assertions(3);

        const store = createDatabasePaymentStore(makeDb());

        await expect(store.markEventProcessed("stripe", "evt_1")).resolves.toBe(true);

        await store.releaseEvent("stripe", "evt_1");

        // After release the claim is gone, so a retry wins the claim again.
        await expect(store.markEventProcessed("stripe", "evt_1")).resolves.toBe(true);
        // Releasing an unknown id is a harmless no-op.
        await expect(store.releaseEvent("stripe", "never_claimed")).resolves.toBeUndefined();
    });
});
