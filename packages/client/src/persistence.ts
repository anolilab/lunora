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
        return {
            args: { ...mutation.args },
            functionPath: mutation.functionPath,
            id: mutation.id,
            identity: mutation.identity,
            shardKey: mutation.shardKey,
        };
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
    };
};

// eslint-disable-next-line unicorn/prevent-abbreviations -- public exported type name; renaming breaks @lunora/client consumers
interface IndexedDbPersistenceOptions {
    /** Database name; defaults to `"lunora"`. */
    databaseName?: string;
    /** Injectable `IDBFactory` (e.g. `fake-indexeddb` in tests); defaults to the global `indexedDB`. */
    indexedDB?: IDBFactory;
    /** Object-store name; defaults to `"offline-mutations"`. */
    storeName?: string;
}

const DEFAULT_DATABASE = "lunora";
const DEFAULT_STORE = "offline-mutations";
/** Secondary index on the mutation id — the store's primary key is an autoincrement seq that preserves FIFO order. */
const ID_INDEX = "by_id";

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
        throw new Error("createIndexedDbPersistence: no IndexedDB available — pass `indexedDB` or use createInMemoryPersistence()");
    }

    const databaseName = options.databaseName ?? DEFAULT_DATABASE;
    const storeName = options.storeName ?? DEFAULT_STORE;
    let databasePromise: Promise<IDBDatabase> | undefined;

    const openDatabase = (): Promise<IDBDatabase> => {
        if (databasePromise) {
            return databasePromise;
        }

        databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(databaseName, 1);

            request.addEventListener("upgradeneeded", () => {
                const database = request.result;

                if (!database.objectStoreNames.contains(storeName)) {
                    const store = database.createObjectStore(storeName, { autoIncrement: true });

                    store.createIndex(ID_INDEX, "id", { unique: true });
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
    };
};

export { createIndexedDbPersistence, createInMemoryPersistence };
export type { IndexedDbPersistenceOptions };
