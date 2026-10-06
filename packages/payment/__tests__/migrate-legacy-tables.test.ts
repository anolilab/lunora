import { describe, expect, it } from "vitest";

import type { LunoraDatabaseLike } from "../src/context";
import migrateLegacyPaymentTables from "../src/migrate-legacy-tables";

type Row = Record<string, unknown>;

/** A table-aware in-memory `ctx.db`: rows keep the table they were inserted into, ids are global. */
const makeDb = (seed: Record<string, Row[]>): { db: LunoraDatabaseLike; rows: (table: string) => Row[] } => {
    const tables = new Map<string, Map<string, Row>>();
    let sequence = 0;
    const table = (name: string): Map<string, Row> => {
        if (!tables.has(name)) {
            tables.set(name, new Map());
        }

        return tables.get(name) as Map<string, Row>;
    };
    const matches = (row: Row, where?: Row): boolean => Object.entries(where ?? {}).every(([key, value]) => row[key] === value);
    const insert = (name: string, document: Row): string => {
        sequence += 1;
        const id = `id_${String(sequence)}`;

        table(name).set(id, { ...document, _creationTime: sequence, _id: id });

        return id;
    };

    for (const [name, rows] of Object.entries(seed)) {
        rows.forEach((row) => insert(name, row));
    }

    return {
        db: {
            delete: async (id) => {
                tables.forEach((rows) => rows.delete(id));
            },
            findFirst: async (name, args) => [...table(name).values()].find((row) => matches(row, args?.where)) ?? null,
            findMany: async (name, args) => {
                return { continueCursor: null, page: [...table(name).values()].filter((row) => matches(row, args?.where)).slice(0, args?.limit ?? Infinity) };
            },
            insert: async (name, document) => insert(name, document),
            patch: async () => {
                throw new Error("not used");
            },
        },
        rows: (name) => [...table(name).values()],
    };
};

const legacy = (): Record<string, Row[]> => {
    return {
        customers: [{ createdAt: 1, provider: "stripe", providerCustomerId: "cus_1", referenceId: "org_1" }],
        events: [{ processedAt: 1, provider: "stripe", providerEventId: "evt_1", type: "payment.captured" }],
        paymentSessions: [{ amountMinor: 1000n, provider: "stripe", providerSessionId: "cs_1", referenceId: "org_1" }],
        subscriptions: [{ provider: "stripe", providerSubscriptionId: "sub_1", referenceId: "org_1", state: "active" }],
        usageEvents: [{ featureId: "api", idempotencyKey: "k_1", provider: "stripe", quantity: 3, referenceId: "org_1" }],
    };
};

describe(migrateLegacyPaymentTables, () => {
    it("moves every legacy row into its payment_* table, without system fields", async () => {
        expect.assertions(4);

        const { db, rows } = makeDb(legacy());

        await expect(migrateLegacyPaymentTables(db)).resolves.toStrictEqual({ moved: 5, remaining: false });

        expect(rows("payment_sessions")).toStrictEqual([
            expect.objectContaining({ amountMinor: 1000n, provider: "stripe", providerSessionId: "cs_1", referenceId: "org_1" }),
        ]);
        // The copy got a fresh id, not the legacy one.
        expect(rows("payment_sessions")[0]?.["_id"]).not.toBe("id_3");
        expect(["customers", "events", "paymentSessions", "subscriptions", "usageEvents"].flatMap((name) => rows(name))).toStrictEqual([]);
    });

    it("moves at most batchSize rows per call and reports what is left", async () => {
        expect.assertions(4);

        const { db, rows } = makeDb(legacy());

        await expect(migrateLegacyPaymentTables(db, { batchSize: 2 })).resolves.toStrictEqual({ moved: 2, remaining: true });
        await expect(migrateLegacyPaymentTables(db, { batchSize: 2 })).resolves.toStrictEqual({ moved: 2, remaining: true });
        await expect(migrateLegacyPaymentTables(db, { batchSize: 2 })).resolves.toStrictEqual({ moved: 1, remaining: false });

        expect(rows("payment_usageEvents")).toHaveLength(1);
    });

    it("reports nothing left when a batch exactly drains the legacy tables", async () => {
        expect.assertions(1);

        const { db } = makeDb(legacy());

        await expect(migrateLegacyPaymentTables(db, { batchSize: 5 })).resolves.toStrictEqual({ moved: 5, remaining: false });
    });

    it("skips a row whose natural key the target already holds, and still deletes the legacy row", async () => {
        expect.assertions(2);

        // The store already wrote this subscription to the new table after the deploy.
        const { db, rows } = makeDb({
            payment_subscriptions: [{ provider: "stripe", providerSubscriptionId: "sub_1", referenceId: "org_1", state: "past_due" }],
            subscriptions: [{ provider: "stripe", providerSubscriptionId: "sub_1", referenceId: "org_1", state: "active" }],
        });

        await migrateLegacyPaymentTables(db);

        expect(rows("payment_subscriptions")).toStrictEqual([expect.objectContaining({ state: "past_due" })]);
        expect(rows("subscriptions")).toStrictEqual([]);
    });

    it("is a no-op once the legacy tables are empty", async () => {
        expect.assertions(1);

        const { db } = makeDb({});

        await expect(migrateLegacyPaymentTables(db)).resolves.toStrictEqual({ moved: 0, remaining: false });
    });
});
