import { decodeWire, encodeArgsOrThrow, encodeWire } from "../../../shared/wire-codec";
import { singleBlobStore } from "./single-blob-store";
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
 * Records pass through the transport's {@link encodeWire}/{@link decodeWire}
 * codec, NOT raw `JSON.stringify`. The outbox holds caller args, which the
 * transport already carries as tagged wire values: raw JSON would throw on a
 * `bigint` (losing the write on reload) and silently mangle a `Date`, `Map`,
 * `Set`, bytes, or `NaN` — the IndexedDB sibling round-trips all of them via
 * structured clone. A value the codec cannot carry (a `RegExp`, a class
 * instance) rejects at `append` instead of persisting mangled; the client's
 * flush path (`encodableOrSettleTerminal`) rejects the same values terminally
 * anyway, so nothing that could ever replay stops being durable. A blob written
 * as plain JSON by an older version decodes unchanged; a malformed one reads as
 * empty rather than wedging every `load()`.
 *
 * AsyncStorage has no transactions, so every read-modify-write runs through
 * {@link singleBlobStore}'s serialized chain — concurrent `append`/`remove`
 * calls run one at a time and can't clobber each other's writes.
 */
const createAsyncStoragePersistence = (options: AsyncStoragePersistenceOptions): PersistenceAdapter => {
    const blob = singleBlobStore(options.storage, options.key ?? DEFAULT_KEY);

    const readAll = async (): Promise<PersistedMutation[]> => {
        let parsed: unknown;

        try {
            parsed = decodeWire(await blob.read());
        } catch {
            // A malformed wire tag is as unrecoverable as unparseable JSON — start clean.
            return [];
        }

        return Array.isArray(parsed) ? (parsed as PersistedMutation[]) : [];
    };

    /** Encode before writing, so a codec failure leaves the stored blob untouched. */
    const writeWith = (mutations: PersistedMutation[], incoming: PersistedMutation): Promise<void> =>
        blob.write(encodeArgsOrThrow("createAsyncStoragePersistence", incoming.functionPath, mutations));

    return {
        append: (mutation) =>
            blob.serialize(async () => {
                const mutations = await readAll();

                mutations.push(mutation);

                await writeWith(mutations, mutation);
            }),
        clear: blob.clear,
        load: () => blob.serialize(readAll),
        remove: (id) =>
            blob.serialize(async () => {
                const mutations = await readAll();
                const remaining = mutations.filter((mutation) => mutation.id !== id);

                if (remaining.length !== mutations.length) {
                    await blob.write(encodeWire(remaining));
                }
            }),
        // In-place swap inside the serialized chain: one read, one write, so the
        // record never leaves the blob and keeps its index in FIFO order.
        replace: (mutation) =>
            blob.serialize(async () => {
                const mutations = await readAll();
                const at = mutations.findIndex((candidate) => candidate.id === mutation.id);

                if (at !== -1) {
                    mutations[at] = mutation;

                    await writeWith(mutations, mutation);
                }
            }),
    };
};

export { createAsyncStoragePersistence };
export type { AsyncStorageLike, AsyncStoragePersistenceOptions };
