/**
 * Internal IndexedDB plumbing shared by the two durable adapters in this package
 * — the offline-mutation outbox (`./persistence`) and the read cache
 * (`./query-cache`). The two keep SEPARATE databases (their schemas evolve
 * independently — see the `VersionError` note in `./query-cache`); only the
 * request/transaction plumbing is shared here so the non-trivial
 * complete/error/abort handling can't drift between the two copies.
 */

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
 * A scoped `withStore` helper: opens a transaction over one object store, runs
 * `run` against it, and resolves once the transaction commits (rejecting on
 * error/abort). Generic over the value `run` produces.
 */
type WithStore = <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T> | T) => Promise<T>;

/**
 * Build a lazily-opening database accessor. The `open` promise is created on
 * first call and cached, so repeated ops reuse one connection. `upgrade` runs on
 * `upgradeneeded` with the database handle to create stores/indexes.
 */
const createDatabaseOpener = (
    factory: IDBFactory,
    databaseName: string,
    version: number,
    upgrade: (database: IDBDatabase) => void,
): (() => Promise<IDBDatabase>) => {
    let databasePromise: Promise<IDBDatabase> | undefined;

    return () => {
        if (databasePromise) {
            return databasePromise;
        }

        databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open(databaseName, version);

            request.addEventListener("upgradeneeded", () => {
                upgrade(request.result);
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
};

/**
 * Build a {@link WithStore} bound to one object store, over a database accessor
 * from {@link createDatabaseOpener}. Awaits the transaction's `complete` event so
 * a durable write is confirmed before the promise resolves; rejects on
 * `error`/`abort`.
 */
const createWithStore = (open: () => Promise<IDBDatabase>, storeName: string): WithStore => async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<T> | T): Promise<T> => {
        const database = await open();
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

export { createDatabaseOpener, createWithStore, promisifyRequest };
