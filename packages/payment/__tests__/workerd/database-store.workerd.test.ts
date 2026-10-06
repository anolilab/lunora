/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * `createDatabasePaymentStore` over a REAL shard-engine `ctx.db` on Durable Object
 * SQLite — the storage it ships to. The node suite runs the store against an
 * in-memory double, which cannot say whether the unique indexes behind webhook
 * dedupe and usage idempotency hold, whether bigint money survives the column
 * codec, or whether keyset paging walks workerd's SQLite correctly.
 *
 * The `ctx.db` is built exactly as the generated ShardDO builds it
 * (`runShardMigrations` + `createShardCtxDb` over `state.storage.sql`, with the
 * same hand-off to `lunoraDatabaseToPaymentDatabase`), over the canonical
 * `paymentTables` the app mirrors inline.
 */
import { defineSchema } from "@lunora/server";
import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb, runShardMigrations } from "@lunora/shard-engine";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { lunoraDatabaseToPaymentDatabase } from "../../src/context";
import { createDatabasePaymentStore } from "../../src/database-store";
import { money } from "../../src/money";
import paymentTables from "../../src/schema";
import type { PaymentStore } from "../../src/store";
import applyWebhookAction from "../../src/sync";
import type { PaymentSession, Subscription, UsageEvent } from "../../src/types";

const schema = defineSchema(paymentTables) as unknown as SchemaLike;

/** What workerd's SQLite raises when a unique index refuses a row. */
const UNIQUE_VIOLATION = /unique constraint/iu;

/** Run `body` inside a fresh Durable Object, with the payment store over its own SQLite. */
const withStore = async (body: (store: PaymentStore, db: DatabaseWriterLike) => Promise<void>): Promise<void> => {
    const stub = env.PAYMENT_DO.get(env.PAYMENT_DO.newUniqueId());

    await runInDurableObject(stub, async (_instance, state) => {
        const sql = state.storage.sql as unknown as Parameters<typeof runShardMigrations>[0];

        runShardMigrations(sql, schema);

        const db = createShardCtxDb({ broadcast: () => undefined, schema, sql });

        await body(createDatabasePaymentStore(lunoraDatabaseToPaymentDatabase(db)), db);
    });
};

const session = (overrides: Partial<PaymentSession> = {}): PaymentSession => {
    return {
        amount: money(1000, "EUR"),
        capturedAmount: money(0, "EUR"),
        createdAt: 1,
        id: "cs_1",
        provider: "stripe",
        referenceId: "org_1",
        refundedAmount: money(0, "EUR"),
        state: "initiated",
        updatedAt: 1,
        ...overrides,
    };
};

const subscription = (overrides: Partial<Subscription> = {}): Subscription => {
    return {
        cancelAtPeriodEnd: false,
        createdAt: 1,
        id: "sub_1",
        priceId: "price_base",
        provider: "stripe",
        quantity: 1,
        referenceId: "org_1",
        state: "active",
        updatedAt: 1,
        ...overrides,
    };
};

const usage = (overrides: Partial<UsageEvent> & Pick<UsageEvent, "idempotencyKey">): UsageEvent => {
    return {
        createdAt: 1,
        featureId: "api_calls",
        provider: "stripe",
        quantity: 1,
        referenceId: "org_1",
        reportedToProvider: false,
        ...overrides,
    };
};

describe("database payment store on workerd", () => {
    it("upserts a customer in place and enforces the unique provider customer id", async () => {
        expect.assertions(3);

        await withStore(async (store) => {
            await store.upsertCustomer({ createdAt: 1, email: "a@example.com", id: "cus_1", provider: "stripe", referenceId: "org_1" });
            // Re-mint for the same reference: patched in place, not a second row.
            await store.upsertCustomer({ createdAt: 2, id: "cus_2", provider: "stripe", referenceId: "org_1" });

            await expect(store.getCustomerByReference("stripe", "org_1")).resolves.toEqual({
                createdAt: 2,
                email: "a@example.com",
                id: "cus_2",
                provider: "stripe",
                referenceId: "org_1",
            });
            await expect(store.getCustomerByReference("polar", "org_1")).resolves.toBeUndefined();
            // A second reference claiming the same provider customer id hits `by_provider_customer`.
            await expect(store.upsertCustomer({ createdAt: 3, id: "cus_2", provider: "stripe", referenceId: "org_2" })).rejects.toThrow(UNIQUE_VIOLATION);
        });
    });

    it("round-trips a payment session, bigint money and the subscription link included", async () => {
        expect.assertions(4);

        // Past Number.MAX_SAFE_INTEGER: a codec that went through a double would round it.
        const huge = 9_007_199_254_740_993n;

        await withStore(async (store) => {
            await store.upsertPaymentSession(session({ amount: money(huge, "EUR"), subscriptionId: "sub_1" }));
            await store.upsertPaymentSession(
                session({
                    amount: money(huge, "EUR"),
                    capturedAmount: money(huge, "EUR"),
                    refundedAmount: money(5n, "EUR"),
                    state: "captured",
                    subscriptionId: "sub_1",
                }),
            );

            const stored = await store.getPaymentSession("stripe", "cs_1");

            expect(stored).toEqual(
                session({
                    amount: money(huge, "EUR"),
                    capturedAmount: money(huge, "EUR"),
                    refundedAmount: money(5n, "EUR"),
                    state: "captured",
                    subscriptionId: "sub_1",
                }),
            );
            expect(typeof stored?.amount.minorUnits).toBe("bigint");

            // A session without a subscription reads the column back as absent.
            await store.upsertPaymentSession(session({ id: "cs_2" }));

            await expect(store.getPaymentSession("stripe", "cs_2")).resolves.toEqual(session({ id: "cs_2" }));
            await expect(store.getPaymentSession("stripe", "cs_missing")).resolves.toBeUndefined();
        });
    });

    it("finds a subscription's payment session by subscription id, only one that names an owner", async () => {
        expect.assertions(3);

        await withStore(async (store) => {
            await store.upsertPaymentSession(session({ id: "cs_orphan", referenceId: " ", subscriptionId: "sub_1" }));

            await expect(store.getPaymentSessionBySubscription("stripe", "sub_1")).resolves.toBeUndefined();

            await store.upsertPaymentSession(session({ id: "cs_owned", referenceId: "org_1", subscriptionId: "sub_1" }));
            await store.upsertPaymentSession(session({ id: "cs_other", provider: "polar", referenceId: "org_9", subscriptionId: "sub_1" }));

            await expect(store.getPaymentSessionBySubscription("stripe", "sub_1")).resolves.toMatchObject({ id: "cs_owned", referenceId: "org_1" });
            await expect(store.getPaymentSessionBySubscription("stripe", "sub_2")).resolves.toBeUndefined();
        });
    });

    it("round-trips a subscription with its price set and last event time, and lists by reference", async () => {
        expect.assertions(4);

        await withStore(async (store) => {
            await store.upsertSubscription(
                subscription({ currentPeriodEnd: 200, currentPeriodStart: 100, lastEventAt: 50, priceIds: ["price_base", "price_addon"] }),
            );

            await expect(store.getSubscription("stripe", "sub_1")).resolves.toEqual(
                subscription({ currentPeriodEnd: 200, currentPeriodStart: 100, lastEventAt: 50, priceIds: ["price_base", "price_addon"] }),
            );

            // A plan change replaces the set and moves the event clock.
            await store.upsertSubscription(subscription({ lastEventAt: 60, priceIds: ["price_pro"], state: "past_due", updatedAt: 2 }));

            await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ lastEventAt: 60, priceIds: ["price_pro"], state: "past_due" });

            // No set reported: the column stays absent and reads back `undefined`.
            await store.upsertSubscription(subscription({ id: "sub_2" }));
            await store.upsertSubscription(subscription({ id: "sub_3", referenceId: "org_2" }));

            await expect(store.getSubscription("stripe", "sub_2")).resolves.toEqual(subscription({ id: "sub_2" }));

            const listed = await store.listSubscriptionsByReference("org_1");

            expect(listed.map((row) => row.id).toSorted((a, b) => a.localeCompare(b))).toEqual(["sub_1", "sub_2"]);
        });
    });

    it("claims a webhook event once, and releases it for a retry", async () => {
        expect.assertions(5);

        await withStore(async (store, db) => {
            await expect(store.markEventProcessed("stripe", "evt_1", "payment.captured")).resolves.toBe(true);
            await expect(store.markEventProcessed("stripe", "evt_1", "payment.captured")).resolves.toBe(false);
            // Same id, other provider: a separate claim.
            await expect(store.markEventProcessed("polar", "evt_1", "payment.captured")).resolves.toBe(true);

            await store.releaseEvent("stripe", "evt_1");

            await expect(store.markEventProcessed("stripe", "evt_1", "payment.captured")).resolves.toBe(true);

            // The find-then-insert above is not the guard; the unique index is. A raw duplicate
            // insert — what a racing claim would issue — must be refused by workerd's SQLite.
            await expect(db.insert("events", { processedAt: 1, provider: "stripe", providerEventId: "evt_1", type: "payment.captured" })).rejects.toThrow(
                UNIQUE_VIOLATION,
            );
        });
    });

    it("lets only one of two interleaved claims of the same event win", async () => {
        expect.assertions(3);

        await withStore(async (store) => {
            const results = await Promise.allSettled([
                store.markEventProcessed("stripe", "evt_race", "payment.captured"),
                store.markEventProcessed("stripe", "evt_race", "payment.captured"),
            ]);
            const won = results.filter((result) => result.status === "fulfilled" && result.value);
            const lost = results.find((result) => result.status === "rejected");

            // Both read "unclaimed" before either inserts; the unique index refuses the second.
            expect(won).toHaveLength(1);
            expect(lost?.reason).toEqual(expect.objectContaining({ message: expect.stringMatching(UNIQUE_VIOLATION) }));
            await expect(store.markEventProcessed("stripe", "evt_race", "payment.captured")).resolves.toBe(false);
        });
    });

    it("records usage exactly once per provider and key, and sums it over a window", async () => {
        expect.assertions(6);

        await withStore(async (store, db) => {
            await expect(store.recordUsage(usage({ createdAt: 100, idempotencyKey: "k1", quantity: 5 }))).resolves.toBe(true);
            await expect(store.recordUsage(usage({ createdAt: 100, idempotencyKey: "k1", quantity: 5 }))).resolves.toBe(false);
            await expect(store.recordUsage(usage({ createdAt: 100, idempotencyKey: "k1", provider: "polar", quantity: 5 }))).resolves.toBe(true);
            await expect(
                db.insert("usageEvents", {
                    createdAt: 1,
                    featureId: "api_calls",
                    idempotencyKey: "k1",
                    provider: "stripe",
                    quantity: 1,
                    referenceId: "org_1",
                    reportedToProvider: false,
                }),
            ).rejects.toThrow(UNIQUE_VIOLATION);

            await store.recordUsage(usage({ createdAt: 200, idempotencyKey: "k2", quantity: 3 }));
            await store.recordUsage(usage({ createdAt: 300, idempotencyKey: "k3", quantity: 4 }));
            await store.recordUsage(usage({ createdAt: 250, featureId: "seats", idempotencyKey: "k4", mode: "set", quantity: 10 }));
            await store.recordUsage(usage({ createdAt: 260, featureId: "seats", idempotencyKey: "k5", quantity: 2 }));

            // `since` 150 drops k1 (and polar's k1 is in the same pair, at 100): 3 + 4.
            await expect(store.sumUsage("org_1", "api_calls", 150)).resolves.toBe(7);
            await expect(store.sumUsageByFeature("org_1", ["api_calls", "seats", "storage"], 150)).resolves.toEqual(
                new Map([
                    ["api_calls", 7],
                    ["seats", 12],
                    ["storage", 0],
                ]),
            );
        });
    });

    it("pages past non-forwardable rows to list unreported usage, oldest first", async () => {
        expect.assertions(3);

        await withStore(async (store) => {
            // Older `set` rows never become reported; with limit 2 the first two pages hold
            // nothing but them, so only a keyset walk reaches the additive rows behind.
            for (const [index, key] of ["s1", "s2", "s3", "s4"].entries()) {
                // eslint-disable-next-line no-await-in-loop -- seeding in order
                await store.recordUsage(usage({ createdAt: 10 + index, idempotencyKey: key, mode: "set", quantity: 9 }));
            }

            await store.recordUsage(usage({ createdAt: 30, idempotencyKey: "a3", quantity: 1 }));
            await store.recordUsage(usage({ createdAt: 20, idempotencyKey: "a1", quantity: 1 }));
            await store.recordUsage(usage({ createdAt: 20, idempotencyKey: "a2", quantity: 1 }));
            await store.recordUsage(usage({ createdAt: 21, idempotencyKey: "zero", quantity: 0 }));

            const first = await store.listUnreportedUsage("stripe", 2);

            expect(first.map((event) => event.idempotencyKey)).toEqual(["a1", "a2"]);

            await store.markUsageReported("stripe", "a1");
            await store.markUsageReported("stripe", "a2");

            const rest = await store.listUnreportedUsage("stripe", 2);

            expect(rest.map((event) => event.idempotencyKey)).toEqual(["a3"]);
            await expect(store.listUnreportedUsage("polar", 2)).resolves.toEqual([]);
        });
    });

    it("adopts an ownerless subscription from its checkout and drops a stale redelivery", async () => {
        expect.assertions(6);

        await withStore(async (store) => {
            const subscriptionEvent = { priceId: "price_base", provider: "stripe", subscriptionId: "sub_1" } as const;

            await expect(applyWebhookAction(store, { ...subscriptionEvent, eventId: "e1", occurredAt: 2000, type: "subscription.active" })).resolves.toEqual({
                applied: true,
                reason: "ok",
            });
            await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ lastEventAt: 2000, referenceId: "" });

            await applyWebhookAction(store, {
                amount: money(1000, "USD"),
                eventId: "e2",
                provider: "stripe",
                referenceId: "org_1",
                sessionId: "cs_1",
                subscriptionId: "sub_1",
                type: "payment.captured",
            });

            await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ referenceId: "org_1", state: "active" });
            await expect(store.getPaymentSession("stripe", "cs_1")).resolves.toMatchObject({
                referenceId: "org_1",
                state: "captured",
                subscriptionId: "sub_1",
            });

            await expect(applyWebhookAction(store, { ...subscriptionEvent, eventId: "e3", occurredAt: 1000, type: "subscription.past_due" })).resolves.toEqual({
                applied: false,
                reason: "stale",
            });
            await expect(store.getSubscription("stripe", "sub_1")).resolves.toMatchObject({ lastEventAt: 2000, state: "active" });
        });
    });
});
