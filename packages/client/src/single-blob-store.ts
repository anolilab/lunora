import type { AsyncStorageLike } from "./async-storage-persistence";

/**
 * The serialized read-modify-write chain both AsyncStorage-backed adapters run
 * on: `read`/`write` are raw (no locking) and belong INSIDE a `serialize` block,
 * which is what keeps one read-modify-write from interleaving with another.
 */
interface SingleBlobStore {
    /** Drop the whole blob. Serializes itself — don't wrap it again. */
    clear: () => Promise<void>;
    /** Parsed JSON payload, or `undefined` when absent or corrupt. The caller narrows the shape. */
    read: () => Promise<unknown>;
    /** Run `run` once every previously-queued op has settled (resolved or rejected). */
    serialize: <T>(run: () => Promise<T>) => Promise<T>;
    /** Overwrite the whole blob. */
    write: (value: unknown) => Promise<void>;
}

/**
 * A whole collection serialized to JSON under one key of an async key/value
 * store — the storage shape React Native's `AsyncStorage` forces on us (no
 * transactions, no secondary indexes, no partial reads). Backs both
 * `createAsyncStoragePersistence` and `createAsyncStorageQueryCache`.
 *
 * Every op is funnelled through a single promise chain so concurrent callers
 * run one at a time and can't clobber each other's writes. A corrupt payload
 * (partial write, hand-edited store) reads as `undefined` so callers start
 * clean rather than wedging every load — the lost data is unrecoverable or
 * re-fetchable either way.
 */
const singleBlobStore = (storage: AsyncStorageLike, key: string): SingleBlobStore => {
    let chain: Promise<unknown> = Promise.resolve();

    const serialize = <T>(run: () => Promise<T>): Promise<T> => {
        const next = chain.then(run, run);

        chain = next.then(
            () => undefined,
            () => undefined,
        );

        return next;
    };

    return {
        clear: () => serialize(() => storage.removeItem(key)),
        read: async () => {
            const raw = await storage.getItem(key);

            if (raw === null) {
                return undefined;
            }

            try {
                return JSON.parse(raw) as unknown;
            } catch {
                return undefined;
            }
        },
        serialize,
        write: (value) => storage.setItem(key, JSON.stringify(value)),
    };
};

export { singleBlobStore };
export type { SingleBlobStore };
