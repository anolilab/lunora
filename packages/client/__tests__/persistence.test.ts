import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { createIndexedDbPersistence, createInMemoryPersistence } from "../src/persistence.js";
import type { PersistedMutation, PersistenceAdapter } from "../src/types.js";

const mutation = (id: string, overrides: Partial<PersistedMutation> = {}): PersistedMutation => {
 return {
    args: { id },
    functionPath: "posts:create",
    id,
    ...overrides,
};
};

/**
 * Both adapters must satisfy the same contract, so the behavioural suite is
 * written once and run against each factory. The IndexedDB factory gets a fresh
 * `fake-indexeddb` instance per test so databases never leak between cases.
 */
const adapters: [string, () => PersistenceAdapter][] = [
    ["createInMemoryPersistence", () => createInMemoryPersistence()],
    ["createIndexedDbPersistence (fake-indexeddb)", () => createIndexedDbPersistence({ indexedDB: new IDBFactory() })],
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
        const first = createIndexedDbPersistence({ indexedDB });

        await first.append(mutation("a"));
        await first.append(mutation("b"));

        // A new adapter (e.g. after a page reload) over the same backing store.
        const second = createIndexedDbPersistence({ indexedDB });
        const loaded = await second.load();

        expect(loaded.map((m) => m.id)).toEqual(["a", "b"]);
    });

    it("throws eagerly when no IndexedDB factory is available", () => {
        expect.assertions(1);

        expect(() => createIndexedDbPersistence({ indexedDB: undefined as unknown as IDBFactory })).toThrow(/no IndexedDB available/);
    });
});
