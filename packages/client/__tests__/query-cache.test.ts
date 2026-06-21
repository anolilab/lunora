import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { createIndexedDbQueryCache as createIndexedDatabaseQueryCache, createInMemoryQueryCache, queryCacheKey } from "../src/query-cache";
import type { CachedQuery, QueryCacheAdapter } from "../src/types";

const entry = (overrides: Partial<CachedQuery> = {}): CachedQuery => {
    return {
        identity: "user-1",
        ts: 1,
        value: { count: 1 },
        ...overrides,
    };
};

/**
 * Both adapters satisfy the same {@link QueryCacheAdapter} contract, so the
 * behavioural suite is written once and run against each factory. The IndexedDB
 * factory gets a fresh `fake-indexeddb` instance per test so databases never
 * leak between cases.
 */
const adapters: [string, () => QueryCacheAdapter][] = [
    ["createInMemoryQueryCache", () => createInMemoryQueryCache()],
    ["createIndexedDbQueryCache (fake-indexeddb)", () => createIndexedDatabaseQueryCache({ indexedDB: new IDBFactory() })],
];

describe.each(adapters)("%s", (_name, makeAdapter) => {
    it("load() returns every put entry with its key", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.put("posts:list::{}::", entry({ value: { count: 1 } }));
        await adapter.put('posts:get::{"id":1}::', entry({ value: { count: 2 } }));

        const loaded = await adapter.load();

        expect(loaded.map((row) => row.key).toSorted((a, b) => a.localeCompare(b))).toEqual(['posts:get::{"id":1}::', "posts:list::{}::"]);
    });

    it("put() preserves the full cached-query shape", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.put("posts:list::{}::", entry({ identity: "user-9", serverCursor: 42, ts: 7, value: { rows: [1, 2] } }));

        const [loaded] = await adapter.load();

        expect(loaded).toEqual({
            identity: "user-9",
            key: "posts:list::{}::",
            serverCursor: 42,
            ts: 7,
            value: { rows: [1, 2] },
        });
    });

    it("put() upserts an existing key in place", async () => {
        expect.assertions(2);

        const adapter = makeAdapter();

        await adapter.put("posts:list::{}::", entry({ value: { count: 1 } }));
        await adapter.put("posts:list::{}::", entry({ value: { count: 99 } }));

        const loaded = await adapter.load();

        expect(loaded).toHaveLength(1);
        expect(loaded[0]?.value).toEqual({ count: 99 });
    });

    it("remove() drops a single entry by key and leaves the rest", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.put("a::{}::", entry());
        await adapter.put("b::{}::", entry());

        await adapter.remove("a::{}::");

        const loaded = await adapter.load();

        expect(loaded.map((row) => row.key)).toEqual(["b::{}::"]);
    });

    it("remove() of an unknown key is a no-op", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.put("a::{}::", entry());
        await adapter.remove("nope");

        const loaded = await adapter.load();

        expect(loaded.map((row) => row.key)).toEqual(["a::{}::"]);
    });

    it("clear() drops every cached query", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.put("a::{}::", entry());
        await adapter.put("b::{}::", entry());

        await adapter.clear();

        await expect(adapter.load()).resolves.toEqual([]);
    });

    it("load() on an empty store resolves to an empty array", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await expect(adapter.load()).resolves.toEqual([]);
    });
});

describe("createInMemoryQueryCache — isolation", () => {
    it("does not retain references to caller-supplied values", async () => {
        expect.assertions(1);

        const adapter = createInMemoryQueryCache();
        const value: Record<string, unknown> = { title: "before" };

        await adapter.put("a::{}::", entry({ value }));
        value.title = "after";

        const [loaded] = await adapter.load();

        expect((loaded?.value as { title: string }).title).toBe("before");
    });

    it("enforces the LRU cap, dropping the oldest entry by ts", async () => {
        expect.assertions(1);

        const adapter = createInMemoryQueryCache({ maxEntries: 2 });

        await adapter.put("old::{}::", entry({ ts: 1 }));
        await adapter.put("mid::{}::", entry({ ts: 2 }));
        await adapter.put("new::{}::", entry({ ts: 3 }));

        const loaded = await adapter.load();

        expect(loaded.map((row) => row.key).toSorted((a, b) => a.localeCompare(b))).toEqual(["mid::{}::", "new::{}::"]);
    });
});

describe("createIndexedDbQueryCache — durability across handles", () => {
    it("a fresh adapter over the same factory restores previously cached queries", async () => {
        expect.assertions(1);

        const indexedDB = new IDBFactory();
        const first = createIndexedDatabaseQueryCache({ indexedDB });

        await first.put("a::{}::", entry({ value: { count: 1 } }));
        await first.put("b::{}::", entry({ value: { count: 2 } }));

        // A new adapter (e.g. after a page reload) over the same backing store.
        const second = createIndexedDatabaseQueryCache({ indexedDB });
        const loaded = await second.load();

        expect(loaded.map((row) => row.key).toSorted((a, b) => a.localeCompare(b))).toEqual(["a::{}::", "b::{}::"]);
    });

    it("evicts oldest-by-ts rows once the cap is exceeded", async () => {
        expect.assertions(1);

        const adapter = createIndexedDatabaseQueryCache({ indexedDB: new IDBFactory(), maxEntries: 2 });

        await adapter.put("old::{}::", entry({ ts: 1 }));
        await adapter.put("mid::{}::", entry({ ts: 2 }));
        await adapter.put("new::{}::", entry({ ts: 3 }));

        const loaded = await adapter.load();

        expect(loaded.map((row) => row.key).toSorted((a, b) => a.localeCompare(b))).toEqual(["mid::{}::", "new::{}::"]);
    });

    it("throws eagerly when no IndexedDB factory is available", () => {
        expect.assertions(1);

        expect(() => createIndexedDatabaseQueryCache({ indexedDB: undefined as unknown as IDBFactory })).toThrow(/no IndexedDB available/);
    });
});

describe("queryCacheKey", () => {
    it("composes functionPath, argsKey and shardKey", () => {
        expect.assertions(2);

        expect(queryCacheKey("posts:list", "{}", "room-1")).toBe("posts:list::{}::room-1");
        expect(queryCacheKey("posts:list", "{}")).toBe("posts:list::{}::");
    });
});
