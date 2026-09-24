import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePersistenceAdapter } from "../src/persistence";
import { resolveQueryCacheAdapter } from "../src/query-cache";
import type { PersistenceAdapter, QueryCacheAdapter } from "../src/types";

/**
 * Install a fake `indexedDB` global for the duration of a probe and restore the
 * previous value afterwards, so the auto-probe branch can be exercised in the
 * Node test environment (which has no `indexedDB`).
 */
const withGlobalIndexedDb = <T>(run: () => T): T => {
    const previous = (globalThis as { indexedDB?: IDBFactory }).indexedDB;

    (globalThis as { indexedDB?: IDBFactory }).indexedDB = new IDBFactory();

    try {
        return run();
    } finally {
        (globalThis as { indexedDB?: IDBFactory }).indexedDB = previous;
    }
};

describe("resolvePersistenceAdapter", () => {
    const explicit: PersistenceAdapter = {
        append: () => Promise.resolve(),
        clear: () => Promise.resolve(),
        load: () => Promise.resolve([]),
        remove: () => Promise.resolve(),
        replace: () => Promise.resolve(),
    };

    afterEach(() => {
        // Guard against a leaked global if an assertion threw inside the probe.
        delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    });

    it("returns an explicit adapter unchanged", () => {
        expect.assertions(1);

        expect(resolvePersistenceAdapter(explicit)).toBe(explicit);
    });

    it("opts out on `false`", () => {
        expect.assertions(1);

        expect(resolvePersistenceAdapter(false)).toBeUndefined();
    });

    it("stays in memory when no IndexedDB is available", () => {
        expect.assertions(1);

        // Node test env: no `indexedDB` global.
        expect(resolvePersistenceAdapter(undefined)).toBeUndefined();
    });

    it("auto-probes a durable IndexedDB store by default when available", () => {
        expect.assertions(2);

        withGlobalIndexedDb(() => {
            const resolved = resolvePersistenceAdapter(undefined);

            expect(resolved).toBeDefined();
            expect(typeof resolved?.append).toBe("function");
        });
    });

    it("suppresses the auto-default when an outbox owns the write path", () => {
        expect.assertions(1);

        withGlobalIndexedDb(() => {
            expect(resolvePersistenceAdapter(undefined, false)).toBeUndefined();
        });
    });

    it("still honours an explicit adapter even when the auto-default is suppressed", () => {
        expect.assertions(1);

        withGlobalIndexedDb(() => {
            expect(resolvePersistenceAdapter(explicit, false)).toBe(explicit);
        });
    });
});

describe("resolveQueryCacheAdapter", () => {
    const explicit: QueryCacheAdapter = {
        clear: () => Promise.resolve(),
        load: () => Promise.resolve([]),
        put: () => Promise.resolve(),
        remove: () => Promise.resolve(),
    };

    afterEach(() => {
        // Guard against a leaked global if an assertion threw inside the probe.
        delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    });

    it("returns an explicit adapter unchanged", () => {
        expect.assertions(1);

        expect(resolveQueryCacheAdapter(explicit)).toBe(explicit);
    });

    it("opts out on `false`", () => {
        expect.assertions(1);

        expect(resolveQueryCacheAdapter(false)).toBeUndefined();
    });

    it("stays in memory when no IndexedDB is available", () => {
        expect.assertions(1);

        expect(resolveQueryCacheAdapter(undefined)).toBeUndefined();
    });

    it("auto-probes a durable IndexedDB store by default when available", () => {
        expect.assertions(2);

        withGlobalIndexedDb(() => {
            const resolved = resolveQueryCacheAdapter(undefined);

            expect(resolved).toBeDefined();
            expect(typeof resolved?.put).toBe("function");
        });
    });
});
