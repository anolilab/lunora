import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { createIndexedDbPersistence } from "../src/persistence";
import { createIndexedDbQueryCache, queryCacheKey } from "../src/query-cache";
import type { PersistedMutation } from "../src/types";

const mutation = (id: string): PersistedMutation => {
    return { args: { id }, functionPath: "posts:create", id };
};

/**
 * Regression: the offline outbox and the read cache must open DISTINCT IndexedDB
 * databases. They used to share the `lunora` database at mismatched schema
 * versions (outbox v1, query-cache v2); IndexedDB's version is a property of the
 * database, not the store, so once both were enabled by default the lower-version
 * open threw `VersionError: The requested version (1) is less than the existing
 * version (2)`. In a browser that surfaced as a Vite runtime-error overlay that
 * blocked every interaction (all e2e specs timed out clicking through it).
 *
 * These cases would have thrown against the old shared-database code and pass now
 * that each adapter owns its own database.
 */
describe("offline outbox + query cache coexistence (shared IDBFactory)", () => {
    it("both adapters open on one factory without a VersionError, regardless of open order", async () => {
        expect.assertions(2);

        const indexedDB = new IDBFactory();

        // Open the query cache FIRST so its database reaches its own version before
        // the outbox opens — the exact ordering that tripped `VersionError` when the
        // two shared the `lunora` database.
        const queryCache = createIndexedDbQueryCache({ indexedDB });

        await queryCache.put(queryCacheKey("messages:list", "{}"), { identity: "u1", ts: 1, value: { count: 1 } });

        const outbox = createIndexedDbPersistence({ indexedDB });

        await outbox.append(mutation("a"));

        await expect(outbox.load()).resolves.toHaveLength(1);
        await expect(queryCache.load()).resolves.toHaveLength(1);
    });

    it("survives a reload boundary — fresh adapters on the same factory re-open cleanly", async () => {
        expect.assertions(2);

        const indexedDB = new IDBFactory();

        // Session 1: both databases created.
        await createIndexedDbQueryCache({ indexedDB }).put(queryCacheKey("messages:list", "{}"), { identity: "u1", ts: 1, value: { count: 1 } });
        await createIndexedDbPersistence({ indexedDB }).append(mutation("a"));

        // Session 2 (reload): brand-new adapter instances re-open the existing
        // databases. The outbox re-opening its DB must not collide with whatever
        // version the query cache left behind.
        const outbox = createIndexedDbPersistence({ indexedDB });
        const queryCache = createIndexedDbQueryCache({ indexedDB });

        await expect(outbox.load()).resolves.toHaveLength(1);
        await expect(queryCache.load()).resolves.toHaveLength(1);
    });

    it("keeps the outbox and read cache in separate databases", async () => {
        expect.assertions(3);

        const indexedDB = new IDBFactory();

        await createIndexedDbPersistence({ indexedDB }).append(mutation("a"));
        await createIndexedDbQueryCache({ indexedDB }).put(queryCacheKey("messages:list", "{}"), { identity: "u1", ts: 1, value: { count: 1 } });

        const databases = await indexedDB.databases();
        const names = databases.map((database) => database.name);

        expect(names).toContain("lunora");
        expect(names).toContain("lunora-query-cache");
        expect(names).toHaveLength(2);
    });
});
