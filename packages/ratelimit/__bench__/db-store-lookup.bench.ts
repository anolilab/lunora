import type { Id } from "@lunora/values";
import { bench, describe } from "vitest";

import type { RateLimitDb, RateLimitDbIndexRange, RateLimitDbQuery, RateLimitStore } from "../src/index";
import { createDbStore } from "../src/index";

/**
 * The DB-backed store's consuming hot path is get() → set() under the DO input
 * gate: the limiter reads the prior value, runs the algorithm, then writes back.
 *
 * The **legacy** adapter ran an index lookup (`withIndex(...).first()`) inside
 * both* get() and set() — two scans per consuming call for one read-modify-
 * write. The **current** adapter caches the row id resolved by get()'s lookup so
 * set() patches directly, collapsing it to a single scan.
 *
 * To make the saved lookup measurable rather than lost in fixture noise, the
 * fake db's `first()` is a real linear scan over the table; the table is seeded
 * with many sibling rows so each scan costs something proportional to table
 * size — the same shape the index walk has when many `(name, key)` pairs share
 * a store. The win is "1 scan vs 2 scans per consuming write".
 */

const TABLE_ROWS = 512;

const createFakeDatabase = (): RateLimitDb => {
    const rows = new Map<string, Record<string, unknown>>();
    let counter = 0;

    const query = (): RateLimitDbQuery => {
        const constraints: [string, unknown][] = [];
        const matches = (document: Record<string, unknown>): boolean => constraints.every(([field, value]) => document[field] === value);
        const handle: RateLimitDbQuery = {
            first: async () =>
                // Linear scan — stands in for the cost of walking the index range.
                [...rows.values()].find((document) => matches(document)) ?? null,
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

    return {
        delete: async <T extends string>(id: Id<T>): Promise<void> => {
            rows.delete(id);
        },
        insert: async <T extends string>(table: T, document: Record<string, unknown>): Promise<Id<T>> => {
            counter += 1;
            const id = `${table}-${String(counter)}` as Id<T>;

            rows.set(id, { _id: id, ...document });

            return id;
        },
        patch: async <T extends string>(id: Id<T>, fields: Record<string, unknown>): Promise<void> => {
            const existing = rows.get(id);

            if (existing) {
                rows.set(id, { ...existing, ...fields });
            }
        },
        query,
    };
};

/**
 * The legacy adapter, reconstructed: an index lookup in *every* operation,
 * including set(). Behaviorally identical to the current store; the only
 * difference is the redundant find() inside set().
 */
const createLegacyDatabaseStore = (db: RateLimitDb): RateLimitStore => {
    const table = "rateLimits";
    const find = async (storageKey: string): Promise<Record<string, unknown> | null> =>
        db
            .query(table)
            .withIndex("by_key", (q) => q.eq("key", storageKey))
            .first();

    return {
        delete: async (storageKey) => {
            const row = await find(storageKey);

            if (row) {
                await db.delete(row._id as Id<string>);
            }
        },
        get: async (storageKey) => {
            const row = await find(storageKey);

            if (!row) {
                return undefined;
            }

            const value = { ts: row.ts as number, value: row.value as number };

            return value;
        },
        set: async (storageKey, value) => {
            const row = await find(storageKey);
            const document: Record<string, unknown> = { key: storageKey, ts: value.ts, value: value.value };

            await (row ? db.patch(row._id as Id<string>, document) : db.insert(table, document));
        },
    };
};

// Seed both stores with TABLE_ROWS sibling rows so each index scan has real cost.
const seed = async (store: RateLimitStore): Promise<void> => {
    for (let index = 0; index < TABLE_ROWS; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- ordered seeding
        await store.set(`seed:${String(index)}`, { ts: 0, value: index });
    }

    await store.set("hot", { ts: 0, value: 1 });
};

const legacyStore = createLegacyDatabaseStore(createFakeDatabase());
const currentStore = createDbStore({ db: createFakeDatabase() });

await seed(legacyStore);
await seed(currentStore);

// One read-modify-write against the hot key: get() then set(), the shape every
// consuming limit() drives.
const readModifyWrite = async (store: RateLimitStore, ts: number): Promise<void> => {
    const prior = await store.get("hot");

    await store.set("hot", { ts, value: (prior?.value ?? 0) + 1 });
};

let clock = 0;

describe("db store: get()+set() index lookups per consuming call", () => {
    bench("legacy: find in get + find in set (2 scans)", async () => {
        clock += 1;
        await readModifyWrite(legacyStore, clock);
    });

    bench("current: cached id, find in get only (1 scan)", async () => {
        clock += 1;
        await readModifyWrite(currentStore, clock);
    });
});
