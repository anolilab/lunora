import type { DatabaseWriter } from "@cirrus/server";
import type { Id } from "@cirrus/values";
import { describe, expect, it } from "vitest";

import { RateLimiter } from "../src/rate-limiter.js";
import type { RateLimitDb, RateLimitDbIndexRange, RateLimitDbQuery } from "../src/store.js";
import { createDbStore } from "../src/store.js";

/**
 * A faithful in-memory stand-in for the Cirrus ORM writer: real row storage and
 * a real `withIndex(...).eq(...).first()` lookup, not a mock. It exercises the
 * adapter's read-then-write logic the same way `ctx.db` would.
 */
const createFakeDb = (): RateLimitDb => {
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

    const query = (): RateLimitDbQuery => {
        const constraints: [string, unknown][] = [];
        const handle: RateLimitDbQuery = {
            first: async () => [...rows.values()].find((doc) => constraints.every(([field, value]) => doc[field] === value)) ?? null,
            withIndex: (_indexName, range) => {
                const recorder: RateLimitDbIndexRange = {
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

        const store = createDbStore({ db: createFakeDb() });

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

        const store = createDbStore({ db: createFakeDb() });

        await store.set("hits:bob", { prev: 7, ts: 1000, value: 3 });

        await expect(store.get("hits:bob")).resolves.toEqual({ prev: 7, ts: 1000, value: 3 });
    });

    it("honors a custom table, index, and key field", async () => {
        expect.assertions(1);

        const store = createDbStore({ db: createFakeDb(), index: "by_id", keyField: "k", table: "limits" });

        await store.set("x", { ts: 1, value: 2 });

        await expect(store.get("x")).resolves.toEqual({ ts: 1, value: 2 });
    });

    it("backs a RateLimiter end to end", async () => {
        expect.assertions(2);

        const clock = { now: 0 };
        const limiter = new RateLimiter({
            config: { send: { kind: "token bucket", period: 1000, rate: 3 } },
            now: () => clock.now,
            store: createDbStore({ db: createFakeDb() }),
        });

        await limiter.limit("send", { count: 3, key: "u1" });

        await expect(limiter.limit("send", { key: "u1" })).resolves.toMatchObject({ ok: false });

        clock.now = 1000;

        await expect(limiter.limit("send", { key: "u1" })).resolves.toMatchObject({ ok: true });
    });

    it("the real ctx.db writer is assignable to RateLimitDb", () => {
        expect.assertions(1);

        // Compile-time guarantee that `createDbStore({ db: ctx.db })` type-checks.
        const accept = (db: RateLimitDb): RateLimitDb => db;
        const writer = null as unknown as DatabaseWriter;

        expect(accept(writer)).toBe(writer);
    });
});
