import { LunoraError } from "@lunora/errors";

import type { CachedQuery, QueryCacheAdapter } from "./types";

/** A stored read-cache row: the {@link CachedQuery} plus its primary key. */
type StoredQuery = CachedQuery & { key: string };

/**
 * Compose the read-cache key for a subscription. Mirrors how
 * `SubscriptionRegistry` keys live subscriptions so a hydrated value lines up
 * with the subscription that will consume it. `shardKey` defaults to `""` (the
 * root shard) exactly as the registry does.
 */
const queryCacheKey = (functionPath: string, argsKey: string, shardKey?: string): string => `${functionPath}::${argsKey}::${shardKey ?? ""}`;

/** Default LRU row cap — bounds the store so a long-lived app can't grow it unboundedly. */
const DEFAULT_MAX_ENTRIES = 500;

/**
 * In-memory {@link QueryCacheAdapter}. Doesn't survive a reload — it exists so
 * the read-cache wiring can be exercised without IndexedDB (tests, SSR, or as a
 * deliberate "no durable store" choice that still satisfies the interface).
 * Enforces the same LRU row cap as the IndexedDB adapter; `clone` keeps callers
 * from mutating stored values.
 */
const createInMemoryQueryCache = (options: { maxEntries?: number } = {}): QueryCacheAdapter => {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const entries = new Map<string, StoredQuery>();
    const clone = (entry: StoredQuery): StoredQuery => {
        return { ...entry, value: structuredClone(entry.value) };
    };

    const evict = (): void => {
        if (entries.size <= maxEntries) {
            return;
        }

        // Oldest-first by `ts`; drop until back under the cap. Insertion order
        // is a good-enough tiebreak for equal timestamps.
        const ordered = [...entries.values()].toSorted((a, b) => a.ts - b.ts);

        for (const entry of ordered) {
            if (entries.size <= maxEntries) {
                break;
            }

            entries.delete(entry.key);
        }
    };

    return {
        clear: () => {
            entries.clear();

            return Promise.resolve();
        },
        load: () => Promise.resolve([...entries.values()].map((entry) => clone(entry))),
        put: (key, entry) => {
            entries.set(key, clone({ ...entry, key }));
            evict();

            return Promise.resolve();
        },
        remove: (key) => {
            entries.delete(key);

            return Promise.resolve();
        },
    };
};

// eslint-disable-next-line unicorn/prevent-abbreviations -- public exported type name; renaming breaks @lunora/client consumers
interface IndexedDbQueryCacheOptions {
    /** Database name; defaults to `"lunora-query-cache"` (its own DB, separate from the offline outbox). */
    databaseName?: string;
    /** Injectable `IDBFactory` (e.g. `fake-indexeddb` in tests); defaults to the global `indexedDB`. */
    indexedDB?: IDBFactory;
    /** LRU row cap; defaults to 500. The oldest rows by `ts` are pruned on `put` once exceeded. */
    maxEntries?: number;
    /** Object-store name; defaults to `"query-cache"`. */
    storeName?: string;
}

const DEFAULT_DATABASE = "lunora-query-cache";
const DEFAULT_STORE = "query-cache";
/** Secondary index on `ts` so LRU eviction can walk oldest-first without loading every row. */
const TS_INDEX = "by_ts";

/**
 * Schema version for the read-cache database. The query cache owns its own
 * database ({@link DEFAULT_DATABASE}) so its schema evolves independently of the
 * offline-mutation outbox — the two adapters are toggled independently and never
 * share a version namespace. (They previously shared one `lunora` database at
 * mismatched versions — 1 for the outbox, 2 here — which threw
 * `VersionError: The requested version (1) is less than the existing version (2)`
 * once both were enabled: IndexedDB's version is a property of the database, not
 * the store, so every opener must request the same version.)
 */
const DATABASE_VERSION = 1;

/** Promisify an `IDBRequest`. */
const promisifyRequest = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        request.addEventListener("success", () => {
            resolve(request.result);
        });
        request.addEventListener("error", () => {
            reject(request.error ?? new Error("IndexedDB request failed"));
        });
    });

/**
 * IndexedDB-backed {@link QueryCacheAdapter}. Each query is stored under its
 * composite key (`functionPath::argsKey::shardKey`) with a `ts` index driving
 * LRU eviction. The store handle is opened lazily and cached, so repeated ops
 * reuse one connection.
 *
 * The store lives in its own `lunora-query-cache` database — deliberately
 * separate from the offline-mutation outbox's `lunora-outbox` database so the two
 * independently-toggleable adapters never share (and drift on) a schema version.
 * Throws eagerly if no `IDBFactory` is available — callers in non-browser
 * environments should use {@link createInMemoryQueryCache}.
 */
// eslint-disable-next-line unicorn/prevent-abbreviations -- public exported function name; renaming breaks @lunora/client consumers
const createIndexedDbQueryCache = (options: IndexedDbQueryCacheOptions = {}): QueryCacheAdapter => {
    const factory = options.indexedDB ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);

    if (!factory) {
        throw new LunoraError("INTERNAL", "createIndexedDbQueryCache: no IndexedDB available — pass `indexedDB` or use createInMemoryQueryCache()");
    }

    const databaseName = options.databaseName ?? DEFAULT_DATABASE;
    const storeName = options.storeName ?? DEFAULT_STORE;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    let databasePromise: Promise<IDBDatabase> | undefined;

    const openDatabase = (): Promise<IDBDatabase> => {
        if (databasePromise) {
            return databasePromise;
        }

        databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(databaseName, DATABASE_VERSION);

            request.addEventListener("upgradeneeded", () => {
                const database = request.result;

                if (!database.objectStoreNames.contains(storeName)) {
                    const store = database.createObjectStore(storeName, { keyPath: "key" });

                    store.createIndex(TS_INDEX, "ts", { unique: false });
                }
            });
            request.addEventListener("success", () => {
                resolve(request.result);
            });
            request.addEventListener("error", () => {
                reject(request.error ?? new Error("IndexedDB open failed"));
            });
        });

        return databasePromise;
    };

    const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T> | T): Promise<T> => {
        const database = await openDatabase();
        const transaction = database.transaction(storeName, mode);
        const result = await run(transaction.objectStore(storeName));

        await new Promise<void>((resolve, reject) => {
            transaction.addEventListener("complete", () => {
                resolve();
            });
            transaction.addEventListener("error", () => {
                reject(transaction.error ?? new Error("IndexedDB transaction failed"));
            });
            transaction.addEventListener("abort", () => {
                reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
            });
        });

        return result;
    };

    /** Drop oldest rows by `ts` until the store is back under the cap. */
    const evict = async (store: IDBObjectStore): Promise<void> => {
        const count = await promisifyRequest(store.count());
        let overflow = count - maxEntries;

        if (overflow <= 0) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            const cursorRequest = store.index(TS_INDEX).openCursor();

            cursorRequest.addEventListener("success", () => {
                const cursor = cursorRequest.result;

                if (!cursor || overflow <= 0) {
                    resolve();

                    return;
                }

                cursor.delete();
                overflow -= 1;
                cursor.continue();
            });
            cursorRequest.addEventListener("error", () => {
                reject(cursorRequest.error ?? new Error("IndexedDB eviction failed"));
            });
        });
    };

    return {
        clear: async () => {
            await withStore("readwrite", (store) => promisifyRequest(store.clear()));
        },
        load: async () => withStore("readonly", (store) => promisifyRequest(store.getAll() as IDBRequest<StoredQuery[]>)),
        put: async (key, entry) => {
            await withStore("readwrite", async (store) => {
                await promisifyRequest(store.put({ ...entry, key }));
                await evict(store);
            });
        },
        remove: async (key) => {
            await withStore("readwrite", (store) => promisifyRequest(store.delete(key)));
        },
    };
};

/**
 * Resolve the effective read-cache from the user option, defaulting to a durable
 * IndexedDB store when the environment supports one. Same tri-state semantics as
 * `resolvePersistenceAdapter` in `./persistence`:
 *
 * - an explicit adapter is used as-is;
 * - `false` opts out — reads stay in memory only;
 * - `undefined` (the default) auto-probes IndexedDB (browsers), else `undefined`.
 */
const resolveQueryCacheAdapter = (option: false | QueryCacheAdapter | undefined): QueryCacheAdapter | undefined => {
    if (option === false) {
        return undefined;
    }

    if (option) {
        return option;
    }

    if (typeof indexedDB === "undefined") {
        return undefined;
    }

    return createIndexedDbQueryCache();
};

export { createIndexedDbQueryCache, createInMemoryQueryCache, queryCacheKey, resolveQueryCacheAdapter };
export type { IndexedDbQueryCacheOptions };
