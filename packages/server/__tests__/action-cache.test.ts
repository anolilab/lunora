import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionCacheContext } from "../src/action-cache";
import { ACTION_CACHE_TABLE, cacheKeyFor, defineActionCache } from "../src/action-cache";
import { LunoraError } from "../src/error";

/**
 * Minimal in-memory `db` matching the slice the action cache uses:
 * `query(table).withIndex(...).order(...).first()/take()`, `insert`, `patch`,
 * `delete`. Index arguments are emulated by full-scan + the same `eq` logic,
 * faithful for the handful of rows under test; ordered reads sort by
 * `expiresAt`, which is the only index the cache reads in order.
 */
interface Eq {
    field: string;
    value: unknown;
}

/** Emulate one index read: the table filter plus the `q.eq(...)` predicates the cache builds. */
const matchRows = (rows: Map<string, Record<string, unknown>>, table: string, eqs: Eq[]): Record<string, unknown>[] =>
    [...rows.values()].filter((row) => (row["__table"] as string) === table && eqs.every((eq) => row[eq.field] === eq.value));

/** `byExpiresAt` is the only index the cache reads in order, so emulate that order. */
const byExpiresAt = (rows: Record<string, unknown>[], direction: "asc" | "desc"): Record<string, unknown>[] =>
    rows.toSorted((a, b) =>
        direction === "asc" ? (a["expiresAt"] as number) - (b["expiresAt"] as number) : (b["expiresAt"] as number) - (a["expiresAt"] as number),
    );

const createMemoryDb = () => {
    const rows = new Map<string, Record<string, unknown>>();
    let nextId = 1;

    const makeReader = (table: string) => {
        const eqs: Eq[] = [];
        let direction: "asc" | "desc" | undefined;

        const resolved = (): Record<string, unknown>[] => {
            const matched = matchRows(rows, table, eqs);

            return direction === undefined ? matched : byExpiresAt(matched, direction);
        };

        const reader = {
            first: async () => resolved()[0] ?? null,
            order(requested: "asc" | "desc") {
                direction = requested;

                return reader;
            },
            take: async (limit: number) => resolved().slice(0, limit),
            withIndex(_name: string, range?: (q: unknown) => unknown) {
                const builder = {
                    eq(field: string, value: unknown) {
                        eqs.push({ field, value });

                        return builder;
                    },
                };

                range?.(builder);

                return reader;
            },
        };

        return reader;
    };

    return {
        delete: async (id: string) => {
            rows.delete(id);
        },
        insert: async (table: string, document: Record<string, unknown>) => {
            const id = `${table}|${String(nextId)}`;

            nextId += 1;
            rows.set(id, { ...document, __table: table, _creationTime: Date.now(), _id: id });

            return id;
        },
        patch: async (id: string, patch: Record<string, unknown>) => {
            const existing = rows.get(id);

            if (existing) {
                rows.set(id, { ...existing, ...patch });
            }
        },
        query: (table: string) => makeReader(table),
        rows,
    };
};

type MemoryDb = ReturnType<typeof createMemoryDb>;

const contextFor = (db: MemoryDb): ActionCacheContext => ({ db }) as unknown as ActionCacheContext;

const entries = (db: MemoryDb): Record<string, unknown>[] => [...db.rows.values()].filter((row) => row["__table"] === ACTION_CACHE_TABLE);

describe("cacheKeyFor", () => {
    it("is stable for the same inputs and differs across names", async () => {
        expect.assertions(2);

        await expect(cacheKeyFor("a", "{}")).resolves.toBe(await cacheKeyFor("a", "{}"));
        await expect(cacheKeyFor("a", "{}")).resolves.not.toBe(await cacheKeyFor("b", "{}"));
    });

    it("separates the name from the args so a shifted boundary cannot collide", async () => {
        expect.assertions(1);

        // Without a separator, ("ab", "c") and ("a", "bc") hash the same bytes —
        // one action could then serve another's cached answer.
        await expect(cacheKeyFor("ab", "c")).resolves.not.toBe(await cacheKeyFor("a", "bc"));
    });
});

describe("defineActionCache — wrap", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("runs the function on a miss and serves the stored value on a hit", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });
        const fn = vi.fn<() => Promise<{ score: number }>>(async () => {
            return { score: 1 };
        });

        vi.setSystemTime(1000);

        await expect(cache.wrap(contextFor(db), "embed", { text: "hi" }, fn)).resolves.toStrictEqual({ score: 1 });
        await expect(cache.wrap(contextFor(db), "embed", { text: "hi" }, fn)).resolves.toStrictEqual({ score: 1 });

        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("keys on the arguments, so a different call is a separate entry", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });
        const fn = vi.fn<() => Promise<number>>(async () => 1);

        vi.setSystemTime(1000);

        await cache.wrap(contextFor(db), "embed", { text: "a" }, fn);
        await cache.wrap(contextFor(db), "embed", { text: "b" }, fn);

        expect(fn).toHaveBeenCalledTimes(2);
        expect(entries(db)).toHaveLength(2);
    });

    it("treats an entry past its TTL as a miss and refreshes it in place", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });
        const fn = vi.fn<() => Promise<number>>(async () => 1);

        vi.setSystemTime(1000);
        await cache.wrap(contextFor(db), "embed", {}, fn);

        vi.setSystemTime(1000 + 10_001);
        await cache.wrap(contextFor(db), "embed", {}, fn);

        expect(fn).toHaveBeenCalledTimes(2);
        // Refreshed, not duplicated: the stale row is patched rather than joined
        // by a second row under the same key.
        expect(entries(db)).toHaveLength(1);
        expect(entries(db)[0]?.["expiresAt"]).toBe(1000 + 10_001 + 10_000);
    });

    it("round-trips an undefined result rather than re-running forever", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });
        const fn = vi.fn<() => Promise<undefined>>(async () => undefined);

        vi.setSystemTime(1000);

        // `JSON.stringify(undefined)` is not a string, so a bare value could not
        // be stored at all and every call would miss.
        await expect(cache.wrap(contextFor(db), "maybe", {}, fn)).resolves.toBeUndefined();

        await cache.wrap(contextFor(db), "maybe", {}, fn);

        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("returns an oversized result without storing it", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const cache = defineActionCache({ maxValueBytes: 32, ttlMs: 10_000 });
        const big = "x".repeat(200);
        const fn = vi.fn<() => Promise<string>>(async () => big);

        vi.setSystemTime(1000);

        // A cache must not fail a successful action just because its answer was
        // large — the caller still gets the value, it is simply not kept.
        await expect(cache.wrap(contextFor(db), "big", {}, fn)).resolves.toBe(big);
        expect(entries(db)).toHaveLength(0);

        await cache.wrap(contextFor(db), "big", {}, fn);

        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("drops a stale entry whose fresh answer is too large to keep", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const cache = defineActionCache({ maxValueBytes: 64, ttlMs: 10_000 });
        let payload = "small";
        const fn = vi.fn<() => Promise<string>>(async () => payload);

        vi.setSystemTime(1000);
        await cache.wrap(contextFor(db), "grow", {}, fn);

        expect(entries(db)).toHaveLength(1);

        payload = "x".repeat(500);
        vi.setSystemTime(1000 + 10_001);
        await cache.wrap(contextFor(db), "grow", {}, fn);

        // Keeping the row would serve the old value until it expired, while the
        // new one was silently uncached.
        expect(entries(db)).toHaveLength(0);
    });

    it("reaps expired rows opportunistically on a miss", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await cache.wrap(contextFor(db), "a", {}, async () => 1);
        await cache.wrap(contextFor(db), "b", {}, async () => 2);

        expect(entries(db)).toHaveLength(2);

        // Both entries are now expired; a miss on a third key pays for the sweep.
        vi.setSystemTime(1000 + 10_001);
        await cache.wrap(contextFor(db), "c", {}, async () => 3);

        expect(entries(db)).toHaveLength(1);
    });
});

describe("defineActionCache — invalidation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("invalidate drops exactly the matching entry", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await cache.wrap(contextFor(db), "embed", { text: "a" }, async () => 1);
        await cache.wrap(contextFor(db), "embed", { text: "b" }, async () => 2);

        await cache.invalidate(contextFor(db), "embed", { text: "a" });

        expect(entries(db)).toHaveLength(1);
        expect(entries(db)[0]?.["name"]).toBe("embed");
    });

    it("invalidate on an absent entry resolves without throwing", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });

        await expect(cache.invalidate(contextFor(db), "embed", { text: "nope" })).resolves.toBeUndefined();
    });

    it("invalidateAll drops every entry under one name and leaves the others", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await cache.wrap(contextFor(db), "embed", { text: "a" }, async () => 1);
        await cache.wrap(contextFor(db), "embed", { text: "b" }, async () => 2);
        await cache.wrap(contextFor(db), "other", {}, async () => 3);

        const outcome = await cache.invalidateAll(contextFor(db), "embed");

        expect(outcome).toStrictEqual({ complete: true, deleted: 2 });
        expect(entries(db)).toHaveLength(1);
        expect(entries(db)[0]?.["name"]).toBe("other");
    });
});

describe("defineActionCache — purgeExpired", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("deletes only the expired entries and reports the count", async () => {
        expect.assertions(3);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await cache.wrap(contextFor(db), "old", {}, async () => 1);

        // Far enough ahead that the first entry has expired and the second has not.
        vi.setSystemTime(1000 + 9000);
        await cache.wrap(contextFor(db), "fresh", {}, async () => 2);

        vi.setSystemTime(1000 + 10_500);
        const result = await cache.functions.purgeExpired.handler({ db }, {});

        expect(result.deleted).toBe(1);
        expect(entries(db)).toHaveLength(1);
        expect(entries(db)[0]?.["name"]).toBe("fresh");
    });
});

describe("defineActionCache — key derivation", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("keys structurally, so argument order is not a cache miss", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });
        const fn = vi.fn<() => Promise<number>>(async () => 1);

        vi.setSystemTime(1000);
        await cache.wrap(contextFor(db), "embed", { a: 1, b: 2 }, fn);
        await cache.wrap(contextFor(db), "embed", { b: 2, a: 1 }, fn);

        // Under raw JSON.stringify these are two entries and the caller pays
        // twice, with nothing to indicate why.
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("keys distinct byte payloads distinctly", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });
        const fn = vi.fn<() => Promise<number>>(async () => 1);

        vi.setSystemTime(1000);
        await cache.wrap(contextFor(db), "embed", { blob: new Uint8Array([1, 2, 3]).buffer }, fn);
        await cache.wrap(contextFor(db), "embed", { blob: new Uint8Array([9, 9, 9]).buffer }, fn);

        // `JSON.stringify` renders every ArrayBuffer as `{}` — which is not a miss,
        // it is a COLLISION: the second caller would be served the first's result.
        expect(fn).toHaveBeenCalledTimes(2);
        expect(entries(db)).toHaveLength(2);
    });

    it("round-trips a bigint result instead of throwing after the work is done", async () => {
        expect.assertions(2);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });

        vi.setSystemTime(1000);

        // Raw JSON.stringify throws on a bigint — after `compute` has already run
        // and been paid for.
        await expect(cache.wrap(contextFor(db), "count", {}, async () => 9_007_199_254_740_993n)).resolves.toBe(9_007_199_254_740_993n);
        await expect(cache.wrap(contextFor(db), "count", {}, async () => 0n)).resolves.toBe(9_007_199_254_740_993n);
    });
});

describe("defineActionCache — ttl", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("measures the TTL from after compute, not before it", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });

        vi.setSystemTime(1000);
        await cache.wrap(contextFor(db), "slow", {}, async () => {
            // A slow upstream call: the clock moves while it runs.
            vi.setSystemTime(6000);

            return 1;
        });

        // Measured from the start, the entry would already be half-expired.
        expect(entries(db)[0]?.["expiresAt"]).toBe(16_000);
    });
});

describe("defineActionCache — purgeExpired limits", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("clamps a caller-supplied limit", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 1000 });
        const reads: number[] = [];
        const inner = db.query;

        db.query = (table: string) => {
            const reader = inner(table);
            const take = reader.take.bind(reader);

            reader.take = async (limit: number) => {
                reads.push(limit);

                return take(limit);
            };

            return reader;
        };

        vi.setSystemTime(1000);
        await cache.functions.purgeExpired.handler({ db }, { limit: 1e9 });

        // `take()` has no ceiling of its own, so an unbounded limit is an
        // unbounded index scan inside a mutation.
        expect(Math.max(...reads)).toBeLessThanOrEqual(4096);
    });
});

describe("defineActionCache — concurrent writers", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns the computed value when another writer won the key", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });

        // The unique index doing its job: two callers missed at once, both ran
        // compute, and this one lost the insert race. The work already succeeded
        // and was paid for — losing the race must not turn into a failed action.
        db.insert = async () => {
            throw new LunoraError("CONFLICT", "unique index breach");
        };

        vi.setSystemTime(1000);

        await expect(cache.wrap(contextFor(db), "embed", {}, async () => "computed")).resolves.toBe("computed");
    });

    it("still propagates an unexpected database error", async () => {
        expect.assertions(1);

        const db = createMemoryDb();
        const cache = defineActionCache({ ttlMs: 10_000 });

        // Degrading silently to "uncached forever" is how a schema or permission
        // problem would stay hidden.
        db.insert = async () => {
            throw new LunoraError("FORBIDDEN", "denied by policy");
        };

        vi.setSystemTime(1000);

        await expect(cache.wrap(contextFor(db), "embed", {}, async () => "computed")).rejects.toThrow("denied by policy");
    });
});
