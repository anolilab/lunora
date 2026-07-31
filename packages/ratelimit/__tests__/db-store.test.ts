import type { DatabaseWriter } from "@lunora/server";
import type { Id } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { RateLimiter } from "../src/rate-limiter";
import type {
    RateLimitDb as RateLimitDatabase,
    RateLimitDbIndexRange as RateLimitDatabaseIndexRange,
    RateLimitDbQuery as RateLimitDatabaseQuery,
    RateLimitDbReader as RateLimitDatabaseReader,
} from "../src/store";
import { createDbStore as createDatabaseStore, createReadOnlyDbStore as createReadOnlyDatabaseStore } from "../src/store";

/**
 * A faithful in-memory stand-in for the Lunora ORM writer: real row storage and
 * a real `withIndex(...).eq(...).first()` lookup, not a mock. It exercises the
 * adapter's read-then-write logic the same way `ctx.db` would.
 */
const createFakeDatabase = (): RateLimitDatabase => {
    const rows = new Map<string, Record<string, unknown>>();
    let counter = 0;

    const remove = async <T extends string>(id: Id<T>): Promise<void> => {
        rows.delete(id);
    };

    const insert = async <T extends string>(table: T, document: Record<string, unknown>): Promise<Id<T>> => {
        counter += 1;
        const id = `${table}-${String(counter)}` as Id<T>;

        rows.set(id, { _id: id, ...document });

        return id;
    };

    const patch = async <T extends string>(id: Id<T>, fields: Record<string, unknown>): Promise<void> => {
        const existing = rows.get(id);

        if (existing) {
            rows.set(id, { ...existing, ...fields });
        }
    };

    const matches = (document: Record<string, unknown>, constraints: [string, unknown][]): boolean =>
        constraints.every(([field, value]) => document[field] === value);

    const query = (): RateLimitDatabaseQuery => {
        const constraints: [string, unknown][] = [];
        const handle: RateLimitDatabaseQuery = {
            first: async () => [...rows.values()].find((document) => matches(document, constraints)) ?? null,
            withIndex: (_indexName, range) => {
                const recorder: RateLimitDatabaseIndexRange = {
                    eq: (field, value) => {
                        constraints.push([field, value]);

                        return recorder;
                    },
                    gt: () => recorder,
                    gte: () => recorder,
                    lt: () => recorder,
                    lte: () => recorder,
                };

                range(recorder);

                return handle;
            },
        };

        return handle;
    };

    return { delete: remove, insert, patch, query };
};

describe("db store", () => {
    it("round-trips, upserts, and deletes values", async () => {
        expect.assertions(4);

        const store = createDatabaseStore({ db: createFakeDatabase() });

        await expect(store.get("k")).resolves.toBeUndefined();

        await store.set("k", { ts: 5, value: 3 });

        await expect(store.get("k")).resolves.toEqual({ ts: 5, value: 3 });

        // A second set on the same key patches the existing row rather than inserting.
        await store.set("k", { ts: 7, value: 9 });

        await expect(store.get("k")).resolves.toEqual({ ts: 7, value: 9 });

        await store.delete("k");

        await expect(store.get("k")).resolves.toBeUndefined();
    });

    it("round-trips the sliding-window previous-window count", async () => {
        expect.assertions(1);

        const store = createDatabaseStore({ db: createFakeDatabase() });

        await store.set("hits:bob", { prev: 7, ts: 1000, value: 3 });

        await expect(store.get("hits:bob")).resolves.toEqual({ prev: 7, ts: 1000, value: 3 });
    });

    it("honors a custom table, index, and key field", async () => {
        expect.assertions(1);

        const store = createDatabaseStore({ db: createFakeDatabase(), index: "by_id", keyField: "k", table: "limits" });

        await store.set("x", { ts: 1, value: 2 });

        await expect(store.get("x")).resolves.toEqual({ ts: 1, value: 2 });
    });

    it("backs a RateLimiter end to end", async () => {
        expect.assertions(2);

        const clock = { now: 0 };
        const limiter = new RateLimiter({
            config: { send: { kind: "token bucket", period: 1000, rate: 3 } },
            now: () => clock.now,
            store: createDatabaseStore({ db: createFakeDatabase() }),
        });

        await limiter.limit("send", { count: 3, key: "u1" });

        await expect(limiter.limit("send", { key: "u1" })).resolves.toMatchObject({ ok: false });

        clock.now = 1000;

        await expect(limiter.limit("send", { key: "u1" })).resolves.toMatchObject({ ok: true });
    });

    it("the real ctx.db writer is assignable to RateLimitDb", () => {
        expect.assertions(1);

        // Compile-time guarantee that `createDbStore({ db: ctx.db })` type-checks.
        const accept = (database: RateLimitDatabase): RateLimitDatabase => database;
        const writer = null as unknown as DatabaseWriter;

        expect(accept(writer)).toBe(writer);
    });

    describe("createReadOnlyDbStore", () => {
        // "How many requests does this user have left" is a pure read, but the
        // store demanded insert/patch/delete — so it could not be answered from a
        // query context, and every remaining-quota display cast instead.
        it("reads a stored value through a query-context reader", async () => {
            expect.assertions(2);

            const database = createFakeDatabase();
            const clock = { now: 0 };
            const config = { send: { kind: "token bucket", period: 1000, rate: 3 } } as const;

            const writing = new RateLimiter({ config, now: () => clock.now, store: createDatabaseStore({ db: database }) });

            await writing.limit("send", { count: 2, key: "u1" });

            // A reader exposes `query` and nothing else — the shape of a QueryCtx's db.
            const reader: RateLimitDatabaseReader = { query: database.query.bind(database) };
            const reading = new RateLimiter({ config, now: () => clock.now, store: createReadOnlyDatabaseStore({ db: reader }) });

            // The exact figure the writing store would report: 3 minus the 2 taken.
            await expect(reading.getValue("send", { key: "u1" })).resolves.toMatchObject({ value: 1 });
            await expect(reading.check("send", { key: "u1" })).resolves.toMatchObject({ ok: true });
        });

        it("throws rather than silently not consuming budget on a write", async () => {
            expect.assertions(2);

            // Failing loudly beats appearing to consume budget and not doing so.
            const database = createFakeDatabase();
            const reader: RateLimitDatabaseReader = { query: database.query.bind(database) };
            const limiter = new RateLimiter({
                config: { send: { kind: "token bucket", period: 1000, rate: 3 } },
                store: createReadOnlyDatabaseStore({ db: reader }),
            });

            await expect(limiter.limit("send", { key: "u1" })).rejects.toThrow(/createReadOnlyDbStore/u);
            await expect(limiter.reset("send", { key: "u1" })).rejects.toThrow(/createReadOnlyDbStore/u);
        });
    });
});
