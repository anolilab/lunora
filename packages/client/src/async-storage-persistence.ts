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
 * The whole FIFO mutation log is serialized to JSON under a single key (`key`),
 * so enqueue order is preserved and `load()` returns freshly-parsed records that
 * callers can't alias.
 *
 * AsyncStorage has no transactions, so every read-modify-write is funnelled
 * through a single promise chain — concurrent `append`/`remove` calls run one at
 * a time and can't clobber each other's writes.
 */
const createAsyncStoragePersistence = (options: AsyncStoragePersistenceOptions): PersistenceAdapter => {
    const { storage } = options;
    const key = options.key ?? DEFAULT_KEY;

    // Serialize all access so a read-modify-write isn't interleaved with another.
    let chain: Promise<unknown> = Promise.resolve();
    const serialize = <T>(run: () => Promise<T>): Promise<T> => {
        const next = chain.then(run, run);

        chain = next.then(
            () => undefined,
            () => undefined,
        );

        return next;
    };

    const readAll = async (): Promise<PersistedMutation[]> => {
        const raw = await storage.getItem(key);

        if (raw === null) {
            return [];
        }

        try {
            const parsed = JSON.parse(raw) as PersistedMutation[];

            return Array.isArray(parsed) ? parsed : [];
        } catch {
            // Corrupt payload (partial write, hand-edited store) — start clean
            // rather than wedging every load. The lost writes are unrecoverable
            // either way.
            return [];
        }
    };

    const writeAll = (mutations: PersistedMutation[]): Promise<void> => storage.setItem(key, JSON.stringify(mutations));

    return {
        append: (mutation) =>
            serialize(async () => {
                const mutations = await readAll();

                mutations.push(mutation);

                await writeAll(mutations);
            }),
        clear: () => serialize(() => storage.removeItem(key)),
        load: () => serialize(readAll),
        remove: (id) =>
            serialize(async () => {
                const mutations = await readAll();
                const remaining = mutations.filter((mutation) => mutation.id !== id);

                if (remaining.length !== mutations.length) {
                    await writeAll(remaining);
                }
            }),
    };
};

export { createAsyncStoragePersistence };
export type { AsyncStorageLike, AsyncStoragePersistenceOptions };
