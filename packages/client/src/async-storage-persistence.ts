import { encodeArgsOrThrow } from "../../../shared/wire-codec";
import { CORRUPT_BLOB, singleBlobStore } from "./single-blob-store";
import type { PersistedMutation, PersistenceAdapter } from "./types";

/**
 * The slice of React Native's `AsyncStorage` (or any async key/value store —
 * Expo `SecureStore`, a wrapped `localForage`, an in-memory map in tests) this
 * adapter needs. Matches `@react-native-async-storage/async-storage`'s core
 * surface, so you can pass the module straight in.
 */
interface AsyncStorageLike {
    getItem: (key: string) => Promise<string | null>;
    removeItem: (key: string) => Promise<void>;
    setItem: (key: string, value: string) => Promise<void>;
}

interface AsyncStoragePersistenceOptions {
    /** Storage key the FIFO mutation log is serialized under; defaults to `"lunora:offline-mutations"`. */
    key?: string;
    /** The async key/value store the log is read from and written to (e.g. React Native `AsyncStorage`). */
    storage: AsyncStorageLike;
}

const DEFAULT_KEY = "lunora:offline-mutations";

/**
 * Builds a {@link PersistenceAdapter} over an async key/value store — the React
 * Native / Expo counterpart to the IndexedDB adapter (`createIndexedDbPersistence`).
 * The whole FIFO mutation log is stored under a single key (`key`), so enqueue
 * order is preserved and `load()` returns freshly-parsed records that callers
 * can't alias.
 *
 * Records round-trip through {@link singleBlobStore}'s wire codec. Args it
 * cannot carry (a `RegExp`, a class instance) reject at `append`/`replace` — the
 * flush path rejects them terminally anyway. A blob that exists but can't be
 * decoded loads as empty, and every write rejects rather than overwrite it and
 * lose the queued writes it may still hold; `clear()` discards it.
 *
 * AsyncStorage has no transactions, so every read-modify-write runs through
 * {@link singleBlobStore}'s serialized chain — concurrent `append`/`remove`
 * calls run one at a time and can't clobber each other's writes.
 */
const createAsyncStoragePersistence = (options: AsyncStoragePersistenceOptions): PersistenceAdapter => {
    const key = options.key ?? DEFAULT_KEY;
    const blob = singleBlobStore(options.storage, key);

    const toMutations = (parsed: unknown): PersistedMutation[] => (Array.isArray(parsed) ? (parsed as PersistedMutation[]) : []);

    /** Read for a read-modify-write: refuses to build on an undecodable blob it would then clobber. */
    const readForWrite = async (): Promise<PersistedMutation[]> => {
        const parsed = await blob.read();

        if (parsed === CORRUPT_BLOB) {
            throw new Error(
                `createAsyncStoragePersistence: the stored outbox under '${key}' can't be decoded — refusing to overwrite it; call clear() to discard it`,
            );
        }

        return toMutations(parsed);
    };

    return {
        append: (mutation) =>
            blob.serialize(async () => {
                encodeArgsOrThrow("createAsyncStoragePersistence", mutation.functionPath, mutation.args);

                const mutations = await readForWrite();

                mutations.push(mutation);

                await blob.write(mutations);
            }),
        clear: blob.clear,
        load: () => blob.serialize(async () => toMutations(await blob.read())),
        remove: (id) =>
            blob.serialize(async () => {
                const mutations = await readForWrite();
                const remaining = mutations.filter((mutation) => mutation.id !== id);

                if (remaining.length !== mutations.length) {
                    await blob.write(remaining);
                }
            }),
        // In-place swap inside the serialized chain: one read, one write, so the
        // record never leaves the blob and keeps its index in FIFO order.
        replace: (mutation) =>
            blob.serialize(async () => {
                encodeArgsOrThrow("createAsyncStoragePersistence", mutation.functionPath, mutation.args);

                const mutations = await readForWrite();
                const at = mutations.findIndex((candidate) => candidate.id === mutation.id);

                if (at !== -1) {
                    mutations[at] = mutation;

                    await blob.write(mutations);
                }
            }),
    };
};

export { createAsyncStoragePersistence };
export type { AsyncStorageLike, AsyncStoragePersistenceOptions };
