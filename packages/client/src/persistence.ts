import { LunoraError } from "@lunora/errors";

import { createDatabaseOpener, createWithStore, promisifyRequest } from "./idb-utility";
import type { PersistedMutation, PersistenceAdapter } from "./types";

/**
 * In-memory {@link PersistenceAdapter}. Doesn't survive a reload — it exists so
 * the persistence wiring can be exercised without IndexedDB (tests, SSR, or as
 * a deliberate "no durable store" choice that still satisfies the interface).
 * Preserves enqueue order; `clone` keeps callers from mutating stored args.
 */
const createInMemoryPersistence = (): PersistenceAdapter => {
    const entries = new Map<string, PersistedMutation>();
    const clone = (mutation: PersistedMutation): PersistedMutation => {
        return { ...mutation, args: { ...mutation.args } };
    };

    return {
        append: (mutation) => {
            entries.set(mutation.id, clone(mutation));

            return Promise.resolve();
        },
        clear: () => {
            entries.clear();

            return Promise.resolve();
        },
        load: () => Promise.resolve([...entries.values()].map((mutation) => clone(mutation))),
        remove: (id) => {
            entries.delete(id);

            return Promise.resolve();
        },
        // `Map.set` on an existing key keeps its insertion position, so the
        // record stays where it was in FIFO order.
        replace: (mutation) => {
            if (entries.has(mutation.id)) {
                entries.set(mutation.id, clone(mutation));
            }

            return Promise.resolve();
        },
    };
};

// eslint-disable-next-line unicorn/prevent-abbreviations -- public exported type name; renaming breaks @lunora/client consumers
interface IndexedDbPersistenceOptions {
    /** Database name; defaults to `"lunora-outbox"` (its own DB, separate from the read cache). */
    databaseName?: string;
    /** Injectable `IDBFactory` (e.g. `fake-indexeddb` in tests); defaults to the global `indexedDB`. */
    indexedDB?: IDBFactory;
    /** Object-store name; defaults to `"offline-mutations"`. */
    storeName?: string;
}

// The offline outbox owns the `lunora-outbox` database outright (schema v1). The
// read cache lives in its OWN `lunora-query-cache` database — do NOT co-locate the
// two stores in one DB: IndexedDB's version is per-database, so sharing one DB
// forces the two independently-toggleable adapters to keep a single version
// constant in sync (they didn't, which threw `VersionError` once both were enabled
// by default).
const DEFAULT_DATABASE = "lunora-outbox";
const DEFAULT_STORE = "offline-mutations";
/** Secondary index on the mutation id — the store's primary key is an autoincrement seq that preserves FIFO order. */
const ID_INDEX = "by_id";

/**
 * IndexedDB-backed {@link PersistenceAdapter}. Each mutation is stored under an
 * autoincrementing key (so `load()` returns them in enqueue order regardless of
 * the string ids) with a unique secondary index on `id` for `remove()`.
 *
 * The store handle is opened lazily and the open promise is cached, so repeated
 * ops reuse one connection. Throws eagerly if no `IDBFactory` is available —
 * callers in non-browser environments should use {@link createInMemoryPersistence}.
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public exported function name; renaming breaks @lunora/client consumers
const createIndexedDbPersistence = (options: IndexedDbPersistenceOptions = {}): PersistenceAdapter => {
    const factory = options.indexedDB ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);

    if (!factory) {
        throw new LunoraError("INTERNAL", "createIndexedDbPersistence: no IndexedDB available — pass `indexedDB` or use createInMemoryPersistence()");
    }

    const databaseName = options.databaseName ?? DEFAULT_DATABASE;
    const storeName = options.storeName ?? DEFAULT_STORE;

    const openDatabase = createDatabaseOpener(factory, databaseName, 1, (database) => {
        if (!database.objectStoreNames.contains(storeName)) {
            const store = database.createObjectStore(storeName, { autoIncrement: true });

            store.createIndex(ID_INDEX, "id", { unique: true });
        }
    });

    const withStore = createWithStore(openDatabase, storeName);

    return {
        append: async (mutation) => {
            await withStore("readwrite", (store) => promisifyRequest(store.add(mutation)));
        },
        clear: async () => {
            await withStore("readwrite", (store) => promisifyRequest(store.clear()));
        },
        load: async () => withStore("readonly", (store) => promisifyRequest(store.getAll() as IDBRequest<PersistedMutation[]>)),
        remove: async (id) => {
            await withStore("readwrite", async (store) => {
                const key = await promisifyRequest(store.index(ID_INDEX).getKey(id));

                if (key !== undefined) {
                    await promisifyRequest(store.delete(key));
                }
            });
        },
        // Lookup + `put` under ONE `readwrite` transaction, so the swap either
        // lands whole or not at all and the autoincrement key — which is what
        // orders `load()` — is reused rather than re-minted at the tail.
        replace: async (mutation) => {
            await withStore("readwrite", async (store) => {
                const key = await promisifyRequest(store.index(ID_INDEX).getKey(mutation.id));

                if (key !== undefined) {
                    await promisifyRequest(store.put(mutation, key));
                }
            });
        },
    };
};

/**
 * Resolve the effective offline-queue persistence from the user option,
 * defaulting to a durable IndexedDB store when the environment supports one.
 *
 * An explicit adapter is used as-is; `false` opts out (the caller keeps an
 * in-memory queue, lost on reload); `undefined` (the default) auto-probes
 * IndexedDB when the global is present (browsers) and `autoProbe` is set,
 * otherwise `undefined` — so SSR/Node/React-Native keep today's in-memory
 * behaviour and only environments that can persist do.
 *
 * `autoProbe` is `false` when the `@lunora/db` outbox is wired: that sink is the
 * single durable write path, so the built-in queue must stay in memory rather
 * than persist a second, never-flushed copy. An explicit adapter is still
 * honoured (the caller asked for it); only the implicit default is suppressed.
 *
 * The IndexedDB adapter opens its connection lazily, so constructing it here is
 * cheap and never throws (the `indexedDB` global is verified present first).
 */
const resolvePersistenceAdapter = (option: false | PersistenceAdapter | undefined, autoProbe = true): PersistenceAdapter | undefined => {
    if (option === false) {
        return undefined;
    }

    if (option) {
        return option;
    }

    if (!autoProbe || typeof indexedDB === "undefined") {
        return undefined;
    }

    return createIndexedDbPersistence();
};

export { createIndexedDbPersistence, createInMemoryPersistence, resolvePersistenceAdapter };
export type { IndexedDbPersistenceOptions };
