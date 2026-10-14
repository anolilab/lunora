import type { DatabaseWriter } from "@lunora/server";
import type { Id } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { RateLimiter } from "../src/rate-limiter";
import type { RateLimitDb as RateLimitDatabase, RateLimitDbReader as RateLimitDatabaseReader } from "../src/store";
import { createDbStore as createDatabaseStore, createReadOnlyDbStore as createReadOnlyDatabaseStore } from "../src/store";

/**
 * A faithful in-memory stand-in for the Lunora ORM writer: real row storage, a
 * primary key that refuses a duplicate `clientId` with `CONFLICT`, and a
 * `patchIf` that compares the stored row to its `where` (a `null` filter
 * matching an absent field, as SQL NULL does). Not a mock: it exercises the
 * adapter's read-then-conditional-write logic the way `ctx.db` would.
 */
const createFakeDatabase = (): RateLimitDatabase & { rows: Map<string, Record<string, unknown>> } => {
    const rows = new Map<string, Record<string, unknown>>();
    let counter = 0;

    const matches = (document: Record<string, unknown>, where: Record<string, unknown> = {}): boolean =>
        Object.entries(where).every(([field, value]) =>
            value === null ? document[field] === undefined || document[field] === null : document[field] === value,
        );

    const remove = async <T extends string>(id: Id<T>): Promise<void> => {
        rows.delete(id);
    };

    const insert = async <T extends string>(table: T, document: Record<string, unknown>, options?: { clientId?: string }): Promise<Id<T>> => {
        counter += 1;
        const id = (options?.clientId ?? `${table}-${String(counter)}`) as Id<T>;

        if (rows.has(id)) {
            throw Object.assign(new Error(`unique constraint violation on "${table}"`), { code: "CONFLICT" });
        }

        rows.set(id, { _id: id, _table: table, ...document });

        return id;
    };

    const patchIf = async <T extends string>(
        _table: T,
        id: Id<T>,
        args: { patch: Record<string, unknown>; where: Record<string, unknown> },
    ): Promise<{ applied: boolean; doc: Record<string, unknown> | null }> => {
        const existing = rows.get(id);

        if (!existing) {
            return { applied: false, doc: null };
        }

        if (!matches(existing, args.where)) {
            return { applied: false, doc: existing };
        }

        const next = { ...existing, ...args.patch };

        rows.set(id, next);

        return { applied: true, doc: next };
    };

    const findFirst = async (table: string, args?: { where?: Record<string, unknown> }): Promise<Record<string, unknown> | null> =>
        [...rows.values()].find((document) => document["_table"] === table && matches(document, args?.where)) ?? null;

    return { delete: remove, findFirst, insert, patchIf, rows };
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

    it("honors a custom table and key field", async () => {
        expect.assertions(2);

        const database = createFakeDatabase();
        const store = createDatabaseStore({ db: database, keyField: "k", table: "limits" });

        await store.set("x", { ts: 1, value: 2 });

        await expect(store.get("x")).resolves.toEqual({ ts: 1, value: 2 });
        expect([...database.rows.values()]).toStrictEqual([expect.objectContaining({ k: "x" })]);
    });

    it("refuses a write whose prior is no longer what is stored, and keeps the stored value", async () => {
        expect.assertions(3);

        const store = createDatabaseStore({ db: createFakeDatabase() });

        await store.set("k", { ts: 1, value: 2 });
        await store.get("k");

        // The first write moves the row on from { ts: 1, value: 2 }; the second still claims that prior.
        await expect(store.setIf?.("k", { ts: 1, value: 1 }, { ts: 1, value: 2 })).resolves.toBe(true);
        await expect(store.setIf?.("k", { ts: 1, value: 1 }, { ts: 1, value: 2 })).resolves.toBe(false);
        await expect(store.get("k")).resolves.toEqual({ ts: 1, value: 1 });
    });

    it("refuses a second creator of the same key instead of inserting a duplicate row", async () => {
        expect.assertions(3);

        const database = createFakeDatabase();
        const first = createDatabaseStore({ db: database });
        const second = createDatabaseStore({ db: database });

        await expect(first.setIf?.("k", { ts: 1, value: 0 }, undefined)).resolves.toBe(true);
        await expect(second.setIf?.("k", { ts: 1, value: 0 }, undefined)).resolves.toBe(false);
        expect(database.rows.size).toBe(1);
    });

    it("creates the row under a UUID derived from table and key", async () => {
        expect.assertions(2);

        const database = createFakeDatabase();

        await createDatabaseStore({ db: database }).set("k", { ts: 1, value: 0 });
        await createDatabaseStore({ db: database, table: "other" }).set("k", { ts: 1, value: 0 });

        const ids = [...database.rows.keys()];

        expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))).toBe(true);
        expect(new Set(ids).size).toBe(2);
    });

    it("admits exactly the limit when consumes for one key race, then refuses the rest", async () => {
        expect.assertions(2);

        const database = createFakeDatabase();
        const config = { login: { kind: "fixed window", period: 60_000, rate: 1 } } as const;
        // A fresh store and limiter per call, as a handler builds them.
        const statuses = await Promise.all(
            Array.from({ length: 10 }, async () =>
                new RateLimiter({ config, now: () => 0, store: createDatabaseStore({ db: database }) }).limit("login", { key: "u1" }),
            ),
        );

        expect(statuses.filter((status) => status.ok)).toHaveLength(1);
        expect(database.rows.size).toBe(1);
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

            // A reader exposes `findFirst` and nothing else — the slice of a QueryCtx's db the store reads.
            const reader: RateLimitDatabaseReader = { findFirst: database.findFirst.bind(database) };
            const reading = new RateLimiter({ config, now: () => clock.now, store: createReadOnlyDatabaseStore({ db: reader }) });

            // The exact figure the writing store would report: 3 minus the 2 taken.
            await expect(reading.getValue("send", { key: "u1" })).resolves.toMatchObject({ value: 1 });
            await expect(reading.check("send", { key: "u1" })).resolves.toMatchObject({ ok: true });
        });

        it("throws rather than silently not consuming budget on a write", async () => {
            expect.assertions(2);

            // Failing loudly beats appearing to consume budget and not doing so.
            const database = createFakeDatabase();
            const reader: RateLimitDatabaseReader = { findFirst: database.findFirst.bind(database) };
            const limiter = new RateLimiter({
                config: { send: { kind: "token bucket", period: 1000, rate: 3 } },
                store: createReadOnlyDatabaseStore({ db: reader }),
            });

            await expect(limiter.limit("send", { key: "u1" })).rejects.toThrow(/createReadOnlyDbStore/u);
            await expect(limiter.reset("send", { key: "u1" })).rejects.toThrow(/createReadOnlyDbStore/u);
        });

        it("rejects writes with an INTERNAL LunoraError, not a plain Error", async () => {
            expect.assertions(2);

            // The middleware only rethrows internal-code LunoraErrors; a plain
            // Error would be classified as a store outage and swallowed by
            // failOpen — the exact misuse this store exists to surface.
            const database = createFakeDatabase();
            const reader: RateLimitDatabaseReader = { findFirst: database.findFirst.bind(database) };
            const limiter = new RateLimiter({
                config: { send: { kind: "token bucket", period: 1000, rate: 3 } },
                store: createReadOnlyDatabaseStore({ db: reader }),
            });

            await expect(limiter.limit("send", { key: "u1" })).rejects.toMatchObject({ code: "INTERNAL", name: "LunoraError" });
            await expect(limiter.reset("send", { key: "u1" })).rejects.toMatchObject({ code: "INTERNAL", name: "LunoraError" });
        });
    });
});
