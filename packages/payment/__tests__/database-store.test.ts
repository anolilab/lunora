import { createHmac } from "node:crypto";

import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { createPayment } from "../src/create-payment";
import type { PaymentDatabase, PaymentRow } from "../src/database-store";
import { createDatabasePaymentStore, PAYMENT_TABLES } from "../src/database-store";
import { money } from "../src/money";
import type { CreemClientLike } from "../src/providers/creem";
import { createCreemAdapter } from "../src/providers/creem";
import paymentExtension from "../src/schema";
import type { PaymentStore } from "../src/store";
import { MemoryPaymentStore } from "../src/store";
import { applyWebhookAction } from "../src/sync";
import type { Customer, PaymentSession, Subscription } from "../src/types";
import { USAGE_NEVER_DUE } from "../src/usage-due";

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

    // Equality, plus the `{ gte }` / `{ lte }` range operators `ctx.db` accepts (the ones the store uses).
    // A column the row never wrote reads as SQL NULL, so `{ col: null }` matches it and no range does, as `ctx.db` does.
    const matches = (row: PaymentRow, where: Record<string, unknown>): boolean =>
        Object.entries(where).every(([key, value]) => {
            if (typeof value === "object" && value !== null && "gte" in value) {
                return typeof row[key] === "number" && row[key] >= (value.gte as number);
            }

            if (typeof value === "object" && value !== null && "lte" in value) {
                return typeof row[key] === "number" && row[key] <= (value.lte as number);
            }

            return (row[key] ?? null) === value;
        });

    // `ctx.db.patch` REJECTS a key whose value is explicitly `undefined` (shard-engine's
    // `assertNoExplicitUndefined`), because the merge that builds the written row would silently
    // drop it and delete the field. A double that merged `{ ...row, ...patch }` accepted such a key
    // and went green over a store that throws on every second write of an optional column.
    const assertNoExplicitUndefined = (patch: Record<string, unknown>): void => {
        for (const field of Object.keys(patch)) {
            if (patch[field] === undefined) {
                throw new Error(`Cannot patch field '${field}' to undefined \u2014 use null to clear a nullable field, or omit the key to leave it unchanged.`);
            }
        }
    };

    return {
        delete: async (_table, id) => {
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
        patch: async (table, id, patch) => {
            assertNoExplicitUndefined(patch);

            const rows = tableOf(table);
            const row = rows.get(id);

            if (row) {
                rows.set(id, { ...row, ...patch });
            }
        },
        patchIf: async (table, id, where, patch) => {
            assertNoExplicitUndefined(patch);

            const row = tableOf(table).get(id);

            if (row === undefined || !matches(row, where)) {
                return false;
            }

            tableOf(table).set(id, { ...row, ...patch });

            return true;
        },
        rowsRead: () => rowsRead,
    };
};

type PaymentTableName = keyof typeof paymentExtension.tables;

/**
 * `makeDb`, but every write is checked against the column validators `paymentExtension` declares,
 * as the real `ctx.db` checks it. The plain double stores whatever it is handed, so a codec that
 * wrote a value the column rejects (a `bigint` into `v.number()`) would pass over it.
 */
const makeValidatingDb = (): ProbedDatabase => {
    const db = makeDb();
    const tableById = new Map<string, string>();
    const shapeOf = (table: string) => paymentExtension.tables[table.replace(/^payment_/u, "") as PaymentTableName].shape;

    return {
        ...db,
        insert: async (table, document) => {
            v.object(shapeOf(table)).parse(document);

            const id = await db.insert(table, document);

            tableById.set(id, table);

            return id;
        },
        patch: async (table, id, patch) => {
            const shape = shapeOf(tableById.get(id) ?? "");

            for (const [field, value] of Object.entries(patch)) {
                shape[field]?.parse(value);
            }

            return db.patch(table, id, patch);
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

const usageEvent = (idempotencyKey: string, createdAt: number, quantity: number, mode?: "set") => {
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

        await expect(db.findMany("payment_customers", { provider: "stripe", referenceId: "user_1" }).then((page) => page.rows)).resolves.toHaveLength(1);
        await expect(store.getCustomerByReference("stripe", "user_1")).resolves.toMatchObject({ id: "cus_2" });
        // Parity: the memory store lands on the same surviving row.
        await expect(memory.getCustomerByReference("stripe", "user_1")).resolves.toMatchObject({ id: "cus_2" });

        // A second provider's customer for the same reference stays a separate row.
        await store.upsertCustomer({ ...customer, id: "pcus_1", provider: "polar" });

        await expect(db.findMany("payment_customers", { referenceId: "user_1" }).then((page) => page.rows)).resolves.toHaveLength(2);
        await expect(store.getCustomerByReference("polar", "user_1")).resolves.toMatchObject({ id: "pcus_1" });
    });

    it("round-trips a payment session, preserving bigint money", async () => {
        expect.assertions(2);

        const store = createDatabasePaymentStore(makeDb());

        await store.upsertPaymentSession(session);

        const loaded = await store.getPaymentSession("stripe", "pi_1");

        expect(loaded).toEqual({ ...session, revision: 1 });
        expect(loaded?.capturedAmount.minorUnits).toBe(1000n);
    });

    it("applies a guarded write only while the stored revision is still the one it read", async () => {
        expect.assertions(4);

        const store = createDatabasePaymentStore(makeDb());

        await store.upsertPaymentSession(session);

        await expect(store.upsertPaymentSession({ ...session, updatedAt: 2 }, { ifRevision: 1 })).resolves.toBe(true);
        // The second writer read revision 1 too; the first has already moved the row on.
        await expect(store.upsertPaymentSession({ ...session, updatedAt: 3 }, { ifRevision: 1 })).resolves.toBe(false);

        const loaded = await store.getPaymentSession("stripe", "pi_1");

        expect(loaded?.revision).toBe(2);
        expect(loaded?.updatedAt).toBe(2);
    });

    it("treats an undefined guard as 'the row must not exist yet'", async () => {
        expect.assertions(3);

        const store = createDatabasePaymentStore(makeDb());

        await expect(store.upsertPaymentSession(session, { ifRevision: 3 })).resolves.toBe(false);
        await expect(store.upsertPaymentSession(session, { ifRevision: undefined })).resolves.toBe(true);
        await expect(store.getPaymentSession("stripe", "pi_1")).resolves.toMatchObject({ revision: 1 });
    });

    it("loses a guarded insert to a row a concurrent writer inserted after the read, instead of failing", async () => {
        expect.assertions(2);

        const base = makeDb();
        const webhook = createDatabasePaymentStore(base);
        let raced = false;
        // The unique `by_provider_session` index, which the plain double does not model, plus a
        // webhook that inserts the same session between the guarded write's read and its insert.
        const racing: PaymentDatabase = {
            ...base,
            findFirst: async (table, where) => {
                const row = await base.findFirst(table, where);

                if (row === null && !raced) {
                    raced = true;
                    await webhook.upsertPaymentSession({ ...session, updatedAt: 5 });
                }

                return row;
            },
            insert: async (table, document) => {
                if ((await base.findFirst(table, { provider: document["provider"], providerSessionId: document["providerSessionId"] })) !== null) {
                    throw new Error("UNIQUE constraint failed: payment_sessions.by_provider_session");
                }

                return base.insert(table, document);
            },
        };

        await expect(createDatabasePaymentStore(racing).upsertPaymentSession(session, { ifRevision: undefined })).resolves.toBe(false);
        await expect(webhook.getPaymentSession("stripe", "pi_1")).resolves.toMatchObject({ revision: 1, updatedAt: 5 });
    });

    it("rethrows a failed guarded insert when no concurrent row explains it", async () => {
        expect.assertions(1);

        const failing: PaymentDatabase = {
            ...makeDb(),
            insert: async () => {
                throw new Error("storage unavailable");
            },
        };

        await expect(createDatabasePaymentStore(failing).upsertPaymentSession(session, { ifRevision: undefined })).rejects.toThrow("storage unavailable");
    });

    it("bumps the revision on an unguarded write, so a guard taken before it fails", async () => {
        expect.assertions(2);

        const store = createDatabasePaymentStore(makeDb());

        await store.upsertPaymentSession(session);
        await store.upsertPaymentSession({ ...session, updatedAt: 9 });

        await expect(store.upsertPaymentSession({ ...session, updatedAt: 10 }, { ifRevision: 1 })).resolves.toBe(false);
        await expect(store.getPaymentSession("stripe", "pi_1")).resolves.toMatchObject({ revision: 2 });
    });

    it("refuses a stored money column that is not a safe integer", async () => {
        expect.assertions(2);

        const db = makeDb();
        const store = createDatabasePaymentStore(db);

        await store.upsertPaymentSession(session);

        const row = await db.findFirst("payment_sessions", { provider: "stripe", providerSessionId: "pi_1" });

        await db.patch("payment_sessions", row!._id, { capturedMinor: 1.5 });

        await expect(store.getPaymentSession("stripe", "pi_1")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(store.getPaymentSession("stripe", "pi_1")).rejects.toThrow("`capturedMinor` is not a safe integer");
    });

    it("refuses a stored session with a money column missing, rather than reading it as zero", async () => {
        expect.assertions(1);

        const db = makeDb();
        const store = createDatabasePaymentStore(db);

        await store.upsertPaymentSession(session);

        const row = await db.findFirst("payment_sessions", { provider: "stripe", providerSessionId: "pi_1" });

        await db.patch("payment_sessions", row!._id, { capturedMinor: null });

        await expect(store.getPaymentSession("stripe", "pi_1")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
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

    it("re-upserts a row whose optional columns are absent (regression)", async () => {
        expect.assertions(4);

        const store = createDatabasePaymentStore(makeDb());

        // The shape every non-Stripe adapter produces: no `priceIds`, and — on the subscription
        // events Polar/Creem/Dodo/Autumn send without period bounds — no `currentPeriod*` either.
        // `upsert` is insert-then-patch, so the FIRST write went in (insert tolerates an absent
        // value) and every LATER one hit `patch`, which rejects a key set to `undefined`. A Polar
        // `subscription.canceled` following its `subscription.active` therefore threw, the row
        // stayed `active`, and `check`/`hasActivePrice` kept entitling a cancelled customer.
        const sparse = { ...subscription, currentPeriodEnd: undefined, provider: "polar" as const };

        await store.upsertSubscription(sparse);
        await store.upsertSubscription({ ...sparse, state: "canceled" });

        const stored = await store.getSubscription("polar", "sub_1");

        expect(stored?.state).toBe("canceled");
        expect(stored?.priceIds).toBeUndefined();

        // Same shape on the customer codec: `email` is optional and a reference can be re-minted.
        const anonymous: Customer = { createdAt: 1, id: "cus_2", provider: "polar", referenceId: "user_2" };

        await store.upsertCustomer(anonymous);
        await store.upsertCustomer({ ...anonymous, id: "cus_3" });

        const reminted = await store.getCustomerByReference("polar", "user_2");

        expect(reminted?.id).toBe("cus_3");
        expect(reminted?.email).toBeUndefined();
    });

    it("round-trips the time of the stale event that filled a price, and reads an absent column as undefined", async () => {
        expect.assertions(2);

        const store = createDatabasePaymentStore(makeDb());

        await store.upsertSubscription({ ...subscription, priceEventAt: 9000 });

        await expect(store.getSubscription("stripe", "sub_1").then((row) => row?.priceEventAt)).resolves.toBe(9000);

        await store.upsertSubscription({ ...subscription, id: "sub_2" });

        await expect(store.getSubscription("stripe", "sub_2").then((row) => row?.priceEventAt)).resolves.toBeUndefined();
    });

    it("keeps a price a current event set over a later-arriving stale event, as the memory store does", async () => {
        expect.assertions(1);

        const store = createDatabasePaymentStore(makeDb());
        const event = { provider: "stripe", referenceId: "user_1", subscriptionId: "sub_1" } as const;

        // A checkout-created row with no price, then a stale fill at 5000, a current plan change at 20_000, and a
        // stale event for the first plan stamped 15_000, which is newer than the fill but older than the change.
        await applyWebhookAction(store, { ...event, eventId: "e1", occurredAt: 10_000, type: "subscription.active" });
        await applyWebhookAction(store, { ...event, eventId: "e2", occurredAt: 5000, priceId: "price_a", type: "subscription.updated" });
        await applyWebhookAction(store, { ...event, eventId: "e3", occurredAt: 20_000, priceId: "price_b", type: "subscription.updated" });
        await applyWebhookAction(store, { ...event, eventId: "e4", occurredAt: 15_000, priceId: "price_a", type: "subscription.updated" });

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ priceId: "price_b" });
    });

    it("reports a lost race for an event claim as already claimed, not as a database error", async () => {
        expect.assertions(2);

        const base = makeDb();
        let raced = false;
        // A concurrent claim of the same id lands between this claim's read and its insert, and the unique index refuses ours.
        const racing: PaymentDatabase = {
            ...base,
            findFirst: async (table, where) => {
                const row = await base.findFirst(table, where);

                if (table === PAYMENT_TABLES.events && row === null && !raced) {
                    raced = true;
                    await base.insert(table, { processedAt: 1, provider: where["provider"], providerEventId: where["providerEventId"], type: "other" });
                }

                return row;
            },
            insert: async (table, document) => {
                if (
                    table === PAYMENT_TABLES.events &&
                    (await base.findFirst(table, { provider: document["provider"], providerEventId: document["providerEventId"] })) !== null
                ) {
                    throw new Error("UNIQUE constraint failed: payment_events.by_provider_event");
                }

                return base.insert(table, document);
            },
        };
        const store = createDatabasePaymentStore(racing);

        await expect(store.markEventProcessed("polar", "pending-refund:ord_1", "mine")).resolves.toBe(false);
        await expect(store.getEventClaim("polar", "pending-refund:ord_1")).resolves.toBe("other");
    });

    it("round-trips the multi-item price set, and reads an absent column as undefined (regression)", async () => {
        expect.assertions(3);

        const store = createDatabasePaymentStore(makeDb());

        await store.upsertSubscription({ ...subscription, priceIds: ["price_1", "price_addon"] });

        await expect(store.getSubscription("stripe", "sub_1").then((row) => row?.priceIds)).resolves.toEqual(["price_1", "price_addon"]);

        // A row written without the column — every non-Stripe adapter, the webhook path, and anything
        // stored before `priceIds` existed. It must read back ABSENT, not as an empty set: `undefined`
        // is what makes the entitlement read fall back to `[priceId]`, so no backfill is needed.
        await store.upsertSubscription({ ...subscription, id: "sub_2" });

        const legacy = await store.getSubscription("stripe", "sub_2");

        expect(legacy?.priceIds).toBeUndefined();
        expect(legacy?.priceId).toBe("price_1");
    });

    it("round-trips the last applied event time, and reads an absent column as undefined", async () => {
        expect.assertions(2);

        const store = createDatabasePaymentStore(makeDb());

        await store.upsertSubscription({ ...subscription, lastEventAt: 3000 });
        await store.upsertSubscription({ ...subscription, id: "sub_2" });

        await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ lastEventAt: 3000 });
        await expect(store.getSubscription("stripe", "sub_2").then((row) => row?.lastEventAt)).resolves.toBeUndefined();
    });

    it("finds a subscription's owning payment session, skipping unowned ones", async () => {
        expect.assertions(2);

        const store = createDatabasePaymentStore(makeDb());

        await store.upsertPaymentSession({ ...session, id: "renewal", referenceId: "", subscriptionId: "sub_1" });
        await store.upsertPaymentSession({ ...session, id: "checkout", subscriptionId: "sub_1" });

        await expect(store.getPaymentSessionBySubscription("stripe", "sub_1")).resolves.toMatchObject({ id: "checkout", subscriptionId: "sub_1" });
        await expect(store.getPaymentSessionBySubscription("stripe", "sub_2")).resolves.toBeUndefined();
    });

    it("dedupes events via markEventProcessed", async () => {
        expect.assertions(3);

        const store = createDatabasePaymentStore(makeDb());

        await expect(store.markEventProcessed("stripe", "evt_1", "payment.captured")).resolves.toBe(true);
        await expect(store.markEventProcessed("stripe", "evt_1", "payment.captured")).resolves.toBe(false);
        await expect(store.markEventProcessed("stripe", "evt_2", "payment.captured")).resolves.toBe(true);
    });

    it("moves a reference's counter only from the value the caller read", async () => {
        expect.assertions(6);

        const store = createDatabasePaymentStore(makeDb());

        await expect(store.getReferenceRevision("user_1")).resolves.toBe(0);
        await expect(store.bumpReferenceRevision("user_1", 0)).resolves.toBe(true);
        // A second writer that read 0 as well loses, and the counter does not move twice.
        await expect(store.bumpReferenceRevision("user_1", 0)).resolves.toBe(false);
        await expect(store.bumpReferenceRevision("user_1", 1)).resolves.toBe(true);
        await expect(store.getReferenceRevision("user_1")).resolves.toBe(2);
        await expect(store.getReferenceRevision("user_2")).resolves.toBe(0);
    });

    it("reports a lost insert race on a reference's first counter as a refused bump, not an error", async () => {
        expect.assertions(1);

        const database = makeDb();
        const racing: typeof database = {
            ...database,
            // The unique index rejects the insert because another writer's counter row landed after our read.
            insert: async (table, document) => {
                await database.insert(table, document);

                throw new Error("unique index violated");
            },
        };

        await expect(createDatabasePaymentStore(racing).bumpReferenceRevision("user_1", 0)).resolves.toBe(false);
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

        await expect(database.findFirst("payment_events", { provider: "stripe", providerEventId: "evt_1" })).resolves.toMatchObject({
            type: "subscription.active",
        });
        await expect(database.findFirst("payment_events", { provider: "stripe", providerEventId: "evt_2" })).resolves.toMatchObject({
            type: "payment.refunded",
        });
    });

    it("sumUsage folds a `set` marker the same way the in-memory store does", async () => {
        expect.assertions(3);

        const store = createDatabasePaymentStore(makeDb());

        await store.recordUsage(usageEvent("a", 10, 30));

        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(30);

        // The marker RESETS the period rather than adding to it — the `mode` column
        // has to survive the row round-trip for that to hold.
        await store.recordUsage(usageEvent("b", 20, 5, "set"));

        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(5);

        // …and a later `add` accrues on top of the reset total.
        await store.recordUsage(usageEvent("c", 30, 7));

        await expect(store.sumUsage("user_1", "api_calls", 0)).resolves.toBe(12);
    });

    it("sumUsage range-reads the current period only, and a `set` outside it neither leaks in nor is read", async () => {
        expect.assertions(5);

        const db = makeDb();
        const wheres: Record<string, unknown>[] = [];
        const store = createDatabasePaymentStore({
            ...db,
            findMany: async (table, where, page) => {
                wheres.push(where);

                return db.findMany(table, where, page);
            },
        });

        // 10 periods of 100 events, `createdAt` = period * 1000 + i; a `set` marker opens period 0.
        await store.recordUsage(usageEvent("set-old", 1, 999, "set"));

        for (let period = 0; period < 10; period += 1) {
            for (let index = 0; index < 100; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- ordered ledger writes
                await store.recordUsage(usageEvent(`e-${String(period)}-${String(index)}`, period * 1000 + index + 10, 1));
            }
        }

        const before = db.rowsRead();

        // The pre-period `set` (999) must not leak in: the period total is exactly its 100 adds.
        await expect(store.sumUsage("user_1", "api_calls", 9000)).resolves.toBe(100);

        expect(wheres.at(-1)).toMatchObject({ createdAt: { gte: 9000 }, featureId: "api_calls", referenceId: "user_1" });
        // Only the last period was pulled into memory, not the 1,001-event lifetime ledger.
        expect(db.rowsRead() - before).toBe(100);

        // A `set` inside the period resets the fold.
        await store.recordUsage(usageEvent("set-new", 9500, 7, "set"));

        await expect(store.sumUsage("user_1", "api_calls", 9000)).resolves.toBe(7);
        expect(db.rowsRead() - before).toBe(100 + 101);
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

        const pending = await store.listUnreportedUsage("stripe", 10, Number.POSITIVE_INFINITY);

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

    it("listUnreportedUsage skips a deferred row until it is due, and pages past it", async () => {
        expect.assertions(3);

        // Regression: rows whose forward keeps failing filled every oldest-first batch, so
        // a newer event was never forwarded. A deferred row must not take a batch slot.
        const store = createDatabasePaymentStore(makeDb());

        for (let index = 0; index < 4; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- seeding a deterministic ledger; order matters
            await store.recordUsage({
                createdAt: index,
                featureId: "tokens",
                idempotencyKey: `evt_${String(index)}`,
                provider: "stripe",
                quantity: 1,
                referenceId: "user_1",
                reportedToProvider: false,
            });
        }

        await store.deferUsageReport("stripe", "evt_0", 1000);
        await store.deferUsageReport("stripe", "evt_1", 1000);

        const keys = async (now: number): Promise<string[]> => {
            const pending = await store.listUnreportedUsage("stripe", 2, now);

            return pending.map((event) => event.idempotencyKey);
        };

        await expect(keys(999)).resolves.toStrictEqual(["evt_2", "evt_3"]);

        await store.markUsageReported("stripe", "evt_2");
        await store.markUsageReported("stripe", "evt_3");

        await expect(keys(999)).resolves.toStrictEqual([]);
        await expect(store.listUnreportedUsage("stripe", 1, 1000)).resolves.toMatchObject([{ idempotencyKey: "evt_0", reportRetryAt: 1000 }]);
    });

    it("listUnreportedUsage never reads non-forwardable rows", async () => {
        expect.assertions(2);

        // `set` markers never owe a forward. Recorded as never due, they sit outside the sweep's
        // range read instead of being fetched and dropped on every sweep.
        const db = makeDb();
        const store = createDatabasePaymentStore(db);

        for (let index = 0; index < 60; index += 1) {
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

        const pending = await store.listUnreportedUsage("stripe", 3, 1_000_000);

        expect(pending.map((event) => event.idempotencyKey)).toStrictEqual(["evt_0000", "evt_0010", "evt_0020"]);
        expect(db.rowsRead()).toBe(3);
    });

    it("listUnreportedUsage does not read a backlog of rows deferred past `now`", async () => {
        expect.assertions(2);

        // Regression (#1607): deferred rows were skipped in memory, so once fewer than `limit`
        // rows were due every sweep read the whole deferred backlog.
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
                ...(index < backlog - 2 ? { reportRetryAt: 10_000 } : {}),
                reportedToProvider: false,
            });
        }

        const pending = await store.listUnreportedUsage("stripe", 10, 5000);

        expect(pending.map((event) => event.idempotencyKey)).toStrictEqual(["evt_0498", "evt_0499"]);
        expect(db.rowsRead()).toBe(2);
    });

    it("listUnreportedUsage stamps rows recorded before reportRetryAt was written, then lists the due ones", async () => {
        expect.assertions(3);

        const db = makeDb();
        const store = createDatabasePaymentStore(db);
        const legacy = { featureId: "tokens", provider: "stripe", quantity: 1, referenceId: "user_1", reportedToProvider: false };

        // Inserted straight through the port, as an older store wrote them: no `reportRetryAt`.
        await db.insert(PAYMENT_TABLES.usageEvents, { ...legacy, createdAt: 1, idempotencyKey: "old_add" });
        await db.insert(PAYMENT_TABLES.usageEvents, { ...legacy, createdAt: 2, idempotencyKey: "old_set", mode: "set" });

        await expect(store.listUnreportedUsage("stripe", 10, 100)).resolves.toMatchObject([{ idempotencyKey: "old_add", reportRetryAt: 1 }]);

        const { rows } = await db.findMany(PAYMENT_TABLES.usageEvents, { idempotencyKey: "old_set" });

        expect(rows[0]?.["reportRetryAt"]).toBe(USAGE_NEVER_DUE);
        // Stamped once: nothing is left without a `reportRetryAt` for later sweeps to re-stamp.
        await expect(db.findMany(PAYMENT_TABLES.usageEvents, { reportRetryAt: null })).resolves.toMatchObject({ rows: [] });
    });

    it("listUnreportedUsage keeps a retry time a concurrent sweep set after the legacy read", async () => {
        expect.assertions(2);

        const db = makeDb();
        const store = createDatabasePaymentStore(db);
        const id = await db.insert(PAYMENT_TABLES.usageEvents, {
            createdAt: 1,
            featureId: "tokens",
            idempotencyKey: "old_add",
            provider: "stripe",
            quantity: 1,
            referenceId: "user_1",
            reportedToProvider: false,
        });
        const { findMany } = db;

        // The other sweep stamps, fails to report and defers the row while this one holds the read.
        db.findMany = async (table, where, page) => {
            const result = await findMany(table, where, page);

            if (where["reportRetryAt"] === null) {
                await db.patch(PAYMENT_TABLES.usageEvents, id, { reportRetryAt: 5000 });
            }

            return result;
        };

        await expect(store.listUnreportedUsage("stripe", 10, 100)).resolves.toStrictEqual([]);

        const { rows } = await findMany(PAYMENT_TABLES.usageEvents, { idempotencyKey: "old_add" });

        expect(rows[0]?.["reportRetryAt"]).toBe(5000);
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

    it.each([
        ["database", () => createDatabasePaymentStore(makeDb())],
        ["memory", () => new MemoryPaymentStore()],
    ] as const)("releases a claim only for its own type when asked, and reads it back (%s)", async (_store, build) => {
        expect.assertions(4);

        const store: PaymentStore = build();

        await store.markEventProcessed("polar", "hold", "marker.a");

        await expect(store.getEventClaim("polar", "hold")).resolves.toBe("marker.a");

        await store.releaseEvent("polar", "hold", "marker.b");

        await expect(store.getEventClaim("polar", "hold")).resolves.toBe("marker.a");

        await store.releaseEvent("polar", "hold", "marker.a");

        await expect(store.getEventClaim("polar", "hold")).resolves.toBeUndefined();
        await expect(store.markEventProcessed("polar", "hold", "marker.b")).resolves.toBe(true);
    });

    it("stores money as a number column the schema accepts", async () => {
        expect.assertions(2);

        const db = makeValidatingDb();
        const store = createDatabasePaymentStore(db);

        await store.upsertPaymentSession(session);
        await store.upsertPaymentSession({ ...session, refundedAmount: money(250, "USD"), state: "partially_refunded" });

        const { rows } = await db.findMany("payment_sessions", {});

        expect(rows.map((row) => [row["amountMinor"], row["capturedMinor"], row["refundedMinor"]])).toStrictEqual([[1000, 1000, 250]]);
        await expect(store.getPaymentSession("stripe", "pi_1")).resolves.toMatchObject({ refundedAmount: money(250n, "USD") });
    });

    it("stores the largest safe amount exactly and refuses one that would round", async () => {
        expect.assertions(4);

        const db = makeValidatingDb();
        const store = createDatabasePaymentStore(db);
        const ceiling = BigInt(Number.MAX_SAFE_INTEGER);

        await store.upsertPaymentSession({ ...session, amount: money(ceiling, "USD") });

        await expect(store.getPaymentSession("stripe", "pi_1")).resolves.toMatchObject({ amount: money(ceiling, "USD") });

        // 2^53 + 1 has no double: `Number()` would silently store 2^53.
        for (const field of ["amount", "capturedAmount", "refundedAmount"] as const) {
            // eslint-disable-next-line no-await-in-loop -- one write per money column, each must be refused on its own
            await expect(store.upsertPaymentSession({ ...session, [field]: money(ceiling + 2n, "USD"), id: `pi_${field}` })).rejects.toThrow(
                /outside the safe-integer range/u,
            );
        }
    });

    it("applies a signed Creem checkout.completed webhook into the payment_sessions row", async () => {
        expect.assertions(3);

        const secret = "creem-fixture-signing-key"; // gitleaks:allow -- test fixture signing key, not a real secret
        const db = makeValidatingDb();
        const store = createDatabasePaymentStore(db);
        // `parseWebhook` only verifies and normalizes; it never calls the client.
        const payment = createPayment({
            adapter: createCreemAdapter({ client: () => ({}) as CreemClientLike, webhookSecret: secret }),
            authorize: () => true,
            store,
        });
        const body = JSON.stringify({
            eventType: "checkout.completed",
            id: "evt_checkout_1",
            object: { customer: "cust_1", id: "ch_1", metadata: { referenceId: "org_1" }, order: { amount: 4900, currency: "EUR", status: "paid" } },
        });
        const signature = createHmac("sha256", Buffer.from(secret)).update(body).digest("hex");

        const response = await payment.handleWebhook(
            new Request("https://app.test/webhooks/creem", { body, headers: { "creem-signature": signature }, method: "POST" }),
        );

        expect(response.status).toBe(200);
        await expect(store.getPaymentSession("creem", "ch_1")).resolves.toMatchObject({ amount: money(4900, "EUR"), referenceId: "org_1", state: "captured" });

        const { rows } = await db.findMany("payment_sessions", { provider: "creem" });

        expect(rows[0]?.["amountMinor"]).toBe(4900);
    });
});
