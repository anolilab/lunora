import { describe, expect, it } from "vitest";

import type { PaymentDatabase, PaymentRow } from "../src/database-store";
import { createDatabasePaymentStore } from "../src/database-store";
import { money } from "../src/money";
import { MemoryPaymentStore } from "../src/store";
import type { Customer, PaymentSession, Subscription } from "../src/types";

/** A `PaymentDatabase` double that also reports how many rows it handed out. */
type ProbedDatabase = PaymentDatabase & { readonly rowsRead: () => number };

const compareValues = (a: unknown, b: unknown): number => {
    if (typeof a === "number" && typeof b === "number") {
        return a - b;
    }

    return String(a).localeCompare(String(b));
};

// In-memory PaymentDatabase that mirrors the equality-filter semantics ctx.db
// provides, plus its order/limit/keyset-cursor push-down. `rowsRead` counts every
// row the store actually pulled into memory, which is what bounds a sweep.
const makeDb = (): ProbedDatabase => {
    const tables = new Map<string, Map<string, PaymentRow>>();
    let sequence = 0;
    let rowsRead = 0;

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
        findMany: async (table, where, page) => {
            const matched = [...tableOf(table).values()].filter((row) => matches(row, where));

            for (const entry of (page?.orderBy ?? []).toReversed()) {
                for (const [field, direction] of Object.entries(entry)) {
                    matched.sort((a, b) => (direction === "asc" ? compareValues(a[field], b[field]) : compareValues(b[field], a[field])));
                }
            }

            // Keyset resume: the cursor is the last row's id, and the total order
            // above is stable, so "everything after that id" is the next page.
            const start = page?.cursor === undefined ? 0 : matched.findIndex((row) => row._id === page.cursor) + 1;
            const window = page?.limit === undefined ? matched.slice(start) : matched.slice(start, start + page.limit);
            const last = window.at(-1);
            const done = page?.limit === undefined || start + window.length >= matched.length;

            rowsRead += window.length;

            return { cursor: done || !last ? undefined : last._id, rows: window };
        },
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
        rowsRead: () => rowsRead,
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

    it("keys customer upserts by (provider, referenceId) in both stores (parity regression)", async () => {
        expect.assertions(5);

        const db = makeDb();
        const store = createDatabasePaymentStore(db);
        const memory = new MemoryPaymentStore();

        // A re-mint — same (provider, referenceId), new provider customer id — must update the row
        // in place, not fork a second row the read path can never find. Same sequence in both stores.
        await store.upsertCustomer(customer);
        await store.upsertCustomer({ ...customer, id: "cus_2" });
        await memory.upsertCustomer(customer);
        await memory.upsertCustomer({ ...customer, id: "cus_2" });

        await expect(db.findMany("customers", { provider: "stripe", referenceId: "user_1" }).then((page) => page.rows)).resolves.toHaveLength(1);
        await expect(store.getCustomerByReference("stripe", "user_1")).resolves.toMatchObject({ id: "cus_2" });
        // Parity: the memory store lands on the same surviving row.
        await expect(memory.getCustomerByReference("stripe", "user_1")).resolves.toMatchObject({ id: "cus_2" });

        // A second provider's customer for the same reference stays a separate row.
        await store.upsertCustomer({ ...customer, id: "pcus_1", provider: "polar" });

        await expect(db.findMany("customers", { referenceId: "user_1" }).then((page) => page.rows)).resolves.toHaveLength(2);
        await expect(store.getCustomerByReference("polar", "user_1")).resolves.toMatchObject({ id: "pcus_1" });
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

        await expect(store.markEventProcessed("stripe", "evt_1", "payment.captured")).resolves.toBe(true);
        await expect(store.markEventProcessed("stripe", "evt_1", "payment.captured")).resolves.toBe(false);
        await expect(store.markEventProcessed("stripe", "evt_2", "payment.captured")).resolves.toBe(true);
    });

    it("records the event type on the claim so `events` is a readable audit log", async () => {
        expect.assertions(2);

        // The `events` table is documented as the audit log the studio renders. Every claim
        // used to be written with `type: ""`, so it carried ids and timestamps and nothing
        // that said what had happened.
        const database = makeDb();
        const store = createDatabasePaymentStore(database);

        await store.markEventProcessed("stripe", "evt_1", "subscription.active");
        await store.markEventProcessed("stripe", "evt_2", "payment.refunded");

        await expect(database.findFirst("events", { provider: "stripe", providerEventId: "evt_1" })).resolves.toMatchObject({ type: "subscription.active" });
        await expect(database.findFirst("events", { provider: "stripe", providerEventId: "evt_2" })).resolves.toMatchObject({ type: "payment.refunded" });
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

    it("sumUsageByFeature matches per-feature sumUsage in one read (parity)", async () => {
        expect.assertions(4);

        const store = createDatabasePaymentStore(makeDb());
        const event = (idempotencyKey: string, featureId: string, createdAt: number, quantity: number, mode?: "set") => {
            return {
                createdAt,
                featureId,
                idempotencyKey,
                ...(mode === undefined ? {} : { mode }),
                provider: "stripe" as const,
                quantity,
                referenceId: "user_1",
                reportedToProvider: false,
            };
        };

        // Three features, mixed periods, including a `set` marker mid-period.
        await store.recordUsage(event("a1", "api_calls", 10, 30));
        await store.recordUsage(event("a2", "api_calls", 20, 5, "set"));
        await store.recordUsage(event("a3", "api_calls", 30, 7));
        await store.recordUsage(event("b1", "seats", 5, 2)); // before the period start
        await store.recordUsage(event("b2", "seats", 15, 3));

        const since = 10;
        const batched = await store.sumUsageByFeature("user_1", ["api_calls", "seats", "storage"], since);

        // Parity with three individual sumUsage calls, including the set-marker fold.
        expect(batched.get("api_calls")).toBe(await store.sumUsage("user_1", "api_calls", since));
        expect(batched.get("seats")).toBe(await store.sumUsage("user_1", "seats", since));
        // A feature with zero events is present in the map as 0, not absent.
        expect(batched.get("storage")).toBe(0);
        expect(batched.get("api_calls")).toBe(12);
    });

    it("listUnreportedUsage bounds the READ, not just the result", async () => {
        expect.assertions(3);

        // Regression: `limit` used to be applied AFTER materialising every
        // unreported row. A provider down for a day meant each reconcile sweep
        // pulled the whole backlog into a 128 MiB isolate to take 100 rows.
        const db = makeDb();
        const store = createDatabasePaymentStore(db);
        const backlog = 500;

        for (let index = 0; index < backlog; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- seeding a deterministic ledger; order matters
            await store.recordUsage({
                createdAt: index,
                featureId: "tokens",
                idempotencyKey: `evt_${String(index).padStart(4, "0")}`,
                provider: "stripe",
                quantity: 1,
                referenceId: "user_1",
                reportedToProvider: false,
            });
        }

        const pending = await store.listUnreportedUsage("stripe", 10);

        expect(pending.map((event) => event.idempotencyKey)).toStrictEqual([
            "evt_0000",
            "evt_0001",
            "evt_0002",
            "evt_0003",
            "evt_0004",
            "evt_0005",
            "evt_0006",
            "evt_0007",
            "evt_0008",
            "evt_0009",
        ]);

        // The whole point: rows FETCHED must scale with `limit`, not with the
        // backlog. Before the fix this was `backlog`.
        expect(db.rowsRead()).toBeLessThanOrEqual(20);
        expect(db.rowsRead()).toBeLessThan(backlog);
    });

    it("listUnreportedUsage pages past non-candidate rows until it has `limit` of them", async () => {
        expect.assertions(2);

        // The additive/positive predicate is still applied in memory (the port's
        // `where` is equality-only), so a chunk can come back entirely filtered
        // out. The scan has to follow the cursor rather than stop short.
        const db = makeDb();
        const store = createDatabasePaymentStore(db);

        for (let index = 0; index < 60; index += 1) {
            // Only every 10th row is a retry candidate; the rest are `set`
            // markers, which are never re-sent.
            // eslint-disable-next-line no-await-in-loop -- seeding a deterministic ledger; order matters
            await store.recordUsage({
                createdAt: index,
                featureId: "tokens",
                idempotencyKey: `evt_${String(index).padStart(4, "0")}`,
                ...(index % 10 === 0 ? {} : { mode: "set" as const }),
                provider: "stripe",
                quantity: 1,
                referenceId: "user_1",
                reportedToProvider: false,
            });
        }

        const pending = await store.listUnreportedUsage("stripe", 3);

        expect(pending.map((event) => event.idempotencyKey)).toStrictEqual(["evt_0000", "evt_0010", "evt_0020"]);
        // Still bounded — chunks of 3, not the whole 60-row match set at once.
        expect(db.rowsRead()).toBeLessThan(60);
    });

    it("releaseEvent rolls back a claim so the id can be re-processed", async () => {
        expect.assertions(3);

        const store = createDatabasePaymentStore(makeDb());

        await expect(store.markEventProcessed("stripe", "evt_1", "payment.captured")).resolves.toBe(true);

        await store.releaseEvent("stripe", "evt_1");

        // After release the claim is gone, so a retry wins the claim again.
        await expect(store.markEventProcessed("stripe", "evt_1", "payment.captured")).resolves.toBe(true);
        // Releasing an unknown id is a harmless no-op.
        await expect(store.releaseEvent("stripe", "never_claimed")).resolves.toBeUndefined();
    });
});
