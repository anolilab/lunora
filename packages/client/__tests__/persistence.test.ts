import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import type { AsyncStorageLike } from "../src/async-storage-persistence";
import { createAsyncStoragePersistence } from "../src/async-storage-persistence";
import { createIndexedDbPersistence as createIndexedDatabasePersistence, createInMemoryPersistence } from "../src/persistence";
import type { PersistedMutation, PersistenceAdapter } from "../src/types";

const mutation = (id: string, overrides: Partial<PersistedMutation> = {}): PersistedMutation => {
    return {
        args: { id },
        functionPath: "posts:create",
        id,
        ...overrides,
    };
};

/** A `Map`-backed stand-in for React Native's async key/value store. */
const createFakeAsyncStorage = (): AsyncStorageLike & { size: () => number } => {
    const store = new Map<string, string>();

    return {
        getItem: (key) => Promise.resolve(store.get(key) ?? null),
        removeItem: (key) => {
            store.delete(key);

            return Promise.resolve();
        },
        setItem: (key, value) => {
            store.set(key, value);

            return Promise.resolve();
        },
        size: () => store.size,
    };
};

/**
 * Both adapters must satisfy the same contract, so the behavioural suite is
 * written once and run against each factory. The IndexedDB factory gets a fresh
 * `fake-indexeddb` instance per test so databases never leak between cases.
 */
const adapters: [string, () => PersistenceAdapter][] = [
    ["createInMemoryPersistence", () => createInMemoryPersistence()],
    ["createIndexedDbPersistence (fake-indexeddb)", () => createIndexedDatabasePersistence({ indexedDB: new IDBFactory() })],
    ["createAsyncStoragePersistence (fake AsyncStorage)", () => createAsyncStoragePersistence({ storage: createFakeAsyncStorage() })],
];

describe.each(adapters)("%s", (_name, makeAdapter) => {
    it("load() returns appended mutations in FIFO (enqueue) order", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.append(mutation("a"));
        await adapter.append(mutation("b"));
        await adapter.append(mutation("c"));

        const loaded = await adapter.load();

        expect(loaded.map((m) => m.id)).toEqual(["a", "b", "c"]);
    });

    it("load() preserves the full mutation shape", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.append(mutation("a", { args: { title: "hi" }, shardKey: "room-1" }));

        const [loaded] = await adapter.load();

        expect(loaded).toEqual({
            args: { title: "hi" },
            functionPath: "posts:create",
            id: "a",
            shardKey: "room-1",
        });
    });

    it("remove() drops a single mutation by id and leaves the rest in order", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.append(mutation("a"));
        await adapter.append(mutation("b"));
        await adapter.append(mutation("c"));

        await adapter.remove("b");

        const loaded = await adapter.load();

        expect(loaded.map((m) => m.id)).toEqual(["a", "c"]);
    });

    it("remove() of an unknown id is a no-op", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.append(mutation("a"));
        await adapter.remove("nope");

        const loaded = await adapter.load();

        expect(loaded.map((m) => m.id)).toEqual(["a"]);
    });

    it("clear() drops every persisted mutation", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await adapter.append(mutation("a"));
        await adapter.append(mutation("b"));

        await adapter.clear();

        await expect(adapter.load()).resolves.toEqual([]);
    });

    it("load() on an empty store resolves to an empty array", async () => {
        expect.assertions(1);

        const adapter = makeAdapter();

        await expect(adapter.load()).resolves.toEqual([]);
    });
});

describe("createInMemoryPersistence — isolation", () => {
    it("does not retain references to caller-supplied args", async () => {
        expect.assertions(1);

        const adapter = createInMemoryPersistence();
        const args: Record<string, unknown> = { title: "before" };

        await adapter.append(mutation("a", { args }));
        args.title = "after";

        const [loaded] = await adapter.load();

        expect(loaded?.args.title).toBe("before");
    });
});

describe("createIndexedDbPersistence — durability across handles", () => {
    it("a fresh adapter over the same factory restores previously appended mutations", async () => {
        expect.assertions(1);

        const indexedDB = new IDBFactory();
        const first = createIndexedDatabasePersistence({ indexedDB });

        await first.append(mutation("a"));
        await first.append(mutation("b"));

        // A new adapter (e.g. after a page reload) over the same backing store.
        const second = createIndexedDatabasePersistence({ indexedDB });
        const loaded = await second.load();

        expect(loaded.map((m) => m.id)).toEqual(["a", "b"]);
    });

    it("throws eagerly when no IndexedDB factory is available", () => {
        expect.assertions(1);

        expect(() => createIndexedDatabasePersistence({ indexedDB: undefined as unknown as IDBFactory })).toThrow(/no IndexedDB available/);
    });
});

describe("createAsyncStoragePersistence", () => {
    it("a fresh adapter over the same storage restores previously appended mutations", async () => {
        expect.assertions(1);

        const storage = createFakeAsyncStorage();
        const first = createAsyncStoragePersistence({ storage });

        await first.append(mutation("a"));
        await first.append(mutation("b"));

        // A new adapter (e.g. after an app relaunch) over the same backing store.
        const second = createAsyncStoragePersistence({ storage });
        const loaded = await second.load();

        expect(loaded.map((m) => m.id)).toEqual(["a", "b"]);
    });

    it("does not retain references to caller-supplied args", async () => {
        expect.assertions(1);

        const adapter = createAsyncStoragePersistence({ storage: createFakeAsyncStorage() });
        const args: Record<string, unknown> = { title: "before" };

        await adapter.append(mutation("a", { args }));
        args.title = "after";

        const [loaded] = await adapter.load();

        expect(loaded?.args.title).toBe("before");
    });

    it("serializes concurrent appends so none clobber each other", async () => {
        expect.assertions(1);

        const adapter = createAsyncStoragePersistence({ storage: createFakeAsyncStorage() });

        // Fire appends without awaiting in between — the internal chain must
        // funnel the read-modify-writes so every record survives.
        await Promise.all([adapter.append(mutation("a")), adapter.append(mutation("b")), adapter.append(mutation("c"))]);

        const loaded = await adapter.load();

        expect([...loaded.map((m) => m.id)].toSorted((x, y) => x.localeCompare(y))).toEqual(["a", "b", "c"]);
    });

    it("clear() removes the backing key entirely", async () => {
        expect.assertions(2);

        const storage = createFakeAsyncStorage();
        const adapter = createAsyncStoragePersistence({ storage });

        await adapter.append(mutation("a"));

        expect(storage.size()).toBe(1);

        await adapter.clear();

        expect(storage.size()).toBe(0);
    });

    it("recovers from a corrupt payload by loading empty", async () => {
        expect.assertions(1);

        const storage = createFakeAsyncStorage();

        await storage.setItem("lunora:offline-mutations", "{not json");

        const adapter = createAsyncStoragePersistence({ storage });

        await expect(adapter.load()).resolves.toEqual([]);
    });
});
