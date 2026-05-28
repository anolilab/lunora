import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";

import { createIndexedDbPersistence, createInMemoryPersistence } from "../src/persistence.js";
import type { PersistedMutation, PersistenceAdapter } from "../src/types.js";

const mutation = (id: string, overrides: Partial<PersistedMutation> = {}): PersistedMutation => ({
    args: { id },
    functionPath: "posts:create",
    id,
    ...overrides,
});

/**
 * Both adapters must satisfy the same contract, so the behavioural suite is
 * written once and run against each factory. The IndexedDB factory gets a fresh
 * `fake-indexeddb` instance per test so databases never leak between cases.
 */
const contract = (name: string, makeAdapter: () => PersistenceAdapter): void => {
    describe(name, () => {
        test("load() returns appended mutations in FIFO (enqueue) order", async () => {
            const adapter = makeAdapter();

            await adapter.append(mutation("a"));
            await adapter.append(mutation("b"));
            await adapter.append(mutation("c"));

            const loaded = await adapter.load();

            expect(loaded.map((m) => m.id)).toEqual(["a", "b", "c"]);
        });

        test("load() preserves the full mutation shape", async () => {
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

        test("remove() drops a single mutation by id and leaves the rest in order", async () => {
            const adapter = makeAdapter();

            await adapter.append(mutation("a"));
            await adapter.append(mutation("b"));
            await adapter.append(mutation("c"));

            await adapter.remove("b");

            const loaded = await adapter.load();

            expect(loaded.map((m) => m.id)).toEqual(["a", "c"]);
        });

        test("remove() of an unknown id is a no-op", async () => {
            const adapter = makeAdapter();

            await adapter.append(mutation("a"));
            await adapter.remove("nope");

            const loaded = await adapter.load();

            expect(loaded.map((m) => m.id)).toEqual(["a"]);
        });

        test("clear() drops every persisted mutation", async () => {
            const adapter = makeAdapter();

            await adapter.append(mutation("a"));
            await adapter.append(mutation("b"));

            await adapter.clear();

            await expect(adapter.load()).resolves.toEqual([]);
        });

        test("load() on an empty store resolves to an empty array", async () => {
            const adapter = makeAdapter();

            await expect(adapter.load()).resolves.toEqual([]);
        });
    });
};

contract("createInMemoryPersistence", () => createInMemoryPersistence());
contract("createIndexedDbPersistence (fake-indexeddb)", () => createIndexedDbPersistence({ indexedDB: new IDBFactory() }));

describe("createInMemoryPersistence — isolation", () => {
    test("does not retain references to caller-supplied args", async () => {
        const adapter = createInMemoryPersistence();
        const args: Record<string, unknown> = { title: "before" };

        await adapter.append(mutation("a", { args }));
        args.title = "after";

        const [loaded] = await adapter.load();

        expect(loaded?.args.title).toBe("before");
    });
});

describe("createIndexedDbPersistence — durability across handles", () => {
    test("a fresh adapter over the same factory restores previously appended mutations", async () => {
        const indexedDB = new IDBFactory();
        const first = createIndexedDbPersistence({ indexedDB });

        await first.append(mutation("a"));
        await first.append(mutation("b"));

        // A new adapter (e.g. after a page reload) over the same backing store.
        const second = createIndexedDbPersistence({ indexedDB });
        const loaded = await second.load();

        expect(loaded.map((m) => m.id)).toEqual(["a", "b"]);
    });

    test("throws eagerly when no IndexedDB factory is available", () => {
        expect(() => createIndexedDbPersistence({ indexedDB: undefined as unknown as IDBFactory })).toThrow(/no IndexedDB available/);
    });
});
