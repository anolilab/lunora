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

    it("evicts the oldest entries by ts once maxEntries is exceeded", async () => {
        expect.assertions(1);

        const adapter = createAsyncStorageQueryCache({ maxEntries: 2, storage: createFakeAsyncStorage() });

        await adapter.put("old::{}::", entry({ ts: 1 }));
        await adapter.put("mid::{}::", entry({ ts: 2 }));
        await adapter.put("new::{}::", entry({ ts: 3 }));

        const loaded = await adapter.load();

        expect(loaded.map((row) => row.key).toSorted((a, b) => a.localeCompare(b))).toEqual(["mid::{}::", "new::{}::"]);
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
