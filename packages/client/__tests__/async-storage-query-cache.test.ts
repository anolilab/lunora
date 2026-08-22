import { describe, expect, it } from "vitest";

import type { AsyncStorageLike } from "../src/async-storage-persistence";
import { createAsyncStorageQueryCache } from "../src/async-storage-query-cache";
import type { CachedQuery } from "../src/types";

const entry = (overrides: Partial<CachedQuery> = {}): CachedQuery => {
    return {
        identity: null,
        ts: 1,
        value: { count: 1 },
        ...overrides,
    };
};

/** A `Map`-backed stand-in for React Native's async key/value store. */
const createFakeAsyncStorage = (): AsyncStorageLike & { raw: (key: string) => string | undefined; set: (key: string, value: string) => void } => {
    const store = new Map<string, string>();

    return {
        getItem: (key) => Promise.resolve(store.get(key) ?? null),
        raw: (key) => store.get(key),
        removeItem: (key) => {
            store.delete(key);

            return Promise.resolve();
        },
        set: (key, value) => {
            store.set(key, value);
        },
        setItem: (key, value) => {
            store.set(key, value);

            return Promise.resolve();
        },
    };
};

describe("createAsyncStorageQueryCache", () => {
    it("put()/load() round-trips the full stored-query shape", async () => {
        expect.assertions(1);

        const adapter = createAsyncStorageQueryCache({ storage: createFakeAsyncStorage() });

        await adapter.put(
            "posts:list::{}::",
            entry({ identity: "user-9", serverCursor: 42, serverEpoch: "e1", ts: 7, value: { rows: [1, 2] }, version: "v3" }),
        );

        await expect(adapter.load()).resolves.toStrictEqual([
            { identity: "user-9", key: "posts:list::{}::", serverCursor: 42, serverEpoch: "e1", ts: 7, value: { rows: [1, 2] }, version: "v3" },
        ]);
    });

    it("put() upserts an existing key and remove()/clear() drop entries", async () => {
        expect.assertions(3);

        const adapter = createAsyncStorageQueryCache({ storage: createFakeAsyncStorage() });

        await adapter.put("a::{}::", entry({ value: { count: 1 } }));
        await adapter.put("a::{}::", entry({ value: { count: 99 } }));
        await adapter.put("b::{}::", entry());

        const loaded = await adapter.load();

        expect(loaded.find((row) => row.key === "a::{}::")?.value).toEqual({ count: 99 });

        await adapter.remove("a::{}::");

        await expect(adapter.load()).resolves.toHaveLength(1);

        await adapter.clear();

        await expect(adapter.load()).resolves.toHaveLength(0);
    });

    it("round-trips rich decoded server values across a cold restart", async () => {
        expect.assertions(6);

        const storage = createFakeAsyncStorage();
        const value = {
            blob: new Uint8Array([1, 2, 3]).buffer,
            createdAt: new Date("2026-08-21T10:00:00.000Z"),
            ratio: Number.NaN,
            tags: new Set(["a", "b"]),
            total: 9_007_199_254_740_993n,
            byId: new Map([["k", 1]]),
        };

        await createAsyncStorageQueryCache({ storage }).put("posts:list::{}::", entry({ value }));

        // A fresh adapter over the same storage — the cold-restart path, where
        // nothing is left in memory to paper over a lossy encoding.
        const [restored] = await createAsyncStorageQueryCache({ storage }).load();
        const restoredValue = restored!.value as typeof value;

        expect(restoredValue.createdAt).toBeInstanceOf(Date);
        expect(restoredValue.createdAt.getTime()).toBe(value.createdAt.getTime());
        expect(restoredValue.total).toBe(9_007_199_254_740_993n);
        expect([...new Uint8Array(restoredValue.blob)]).toEqual([1, 2, 3]);
        expect(restoredValue.byId).toStrictEqual(new Map([["k", 1]]));
        expect(restoredValue.tags).toStrictEqual(new Set(["a", "b"]));
    });

    it("keeps NaN a number rather than collapsing it to null", async () => {
        expect.assertions(1);

        const storage = createFakeAsyncStorage();

        await createAsyncStorageQueryCache({ storage }).put("m::{}::", entry({ value: { ratio: Number.NaN } }));

        const [restored] = await createAsyncStorageQueryCache({ storage }).load();

        expect((restored!.value as { ratio: number }).ratio).toBeNaN();
    });

    it("a bigint value stores instead of rejecting the put", async () => {
        expect.assertions(1);

        const storage = createFakeAsyncStorage();
        const adapter = createAsyncStorageQueryCache({ storage });

        // Raw JSON.stringify THROWS on a bigint, which would reject the put and
        // leave the query silently uncached forever.
        await expect(adapter.put("m::{}::", entry({ value: { total: 1n } }))).resolves.toBeUndefined();
    });

    it("evicts the oldest entries by ts once maxEntries is exceeded", async () => {
        expect.assertions(1);

        const adapter = createAsyncStorageQueryCache({ maxEntries: 2, storage: createFakeAsyncStorage() });

        await adapter.put("old::{}::", entry({ ts: 1 }));
        await adapter.put("mid::{}::", entry({ ts: 2 }));
        await adapter.put("new::{}::", entry({ ts: 3 }));

        const loaded = await adapter.load();

        expect(loaded.map((row) => row.key).toSorted((a, b) => a.localeCompare(b))).toEqual(["mid::{}::", "new::{}::"]);
    });

    it.each([
        ["NaN", Number.NaN],
        ["negative", -1],
        ["zero", 0],
        ["fractional", 2.5],
        ["Infinity", Number.POSITIVE_INFINITY],
    ])("rejects a %s maxEntries at construction", (_label, maxEntries) => {
        expect.assertions(1);

        // Without the guard these construct fine and then either wipe the cache
        // on every put (NaN, negative) or never evict at all (Infinity).
        expect(() => createAsyncStorageQueryCache({ maxEntries, storage: createFakeAsyncStorage() })).toThrow(/maxEntries must be a positive integer/);
    });

    it("a corrupt stored payload loads as empty instead of wedging", async () => {
        expect.assertions(1);

        const storage = createFakeAsyncStorage();

        storage.set("lunora:query-cache", "{not json");

        const adapter = createAsyncStorageQueryCache({ storage });

        await expect(adapter.load()).resolves.toEqual([]);
    });

    it("concurrent puts serialize instead of clobbering each other", async () => {
        expect.assertions(1);

        const adapter = createAsyncStorageQueryCache({ storage: createFakeAsyncStorage() });

        // Fire without awaiting — every write must survive the race.
        await Promise.all([adapter.put("a::{}::", entry({ ts: 1 })), adapter.put("b::{}::", entry({ ts: 2 })), adapter.put("c::{}::", entry({ ts: 3 }))]);

        const loaded = await adapter.load();

        expect(loaded.map((row) => row.key).toSorted((a, b) => a.localeCompare(b))).toEqual(["a::{}::", "b::{}::", "c::{}::"]);
    });
});
