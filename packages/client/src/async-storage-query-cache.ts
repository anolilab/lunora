import type { AsyncStorageLike } from "./async-storage-persistence";
import type { CachedQuery, QueryCacheAdapter } from "./types";

/** A stored read-cache row: the {@link CachedQuery} plus its primary key. */
type StoredQuery = CachedQuery & { key: string };

interface AsyncStorageQueryCacheOptions {
    /** Storage key the cache is serialized under; defaults to `"lunora:query-cache"`. */
    key?: string;
    /** LRU row cap; defaults to 500. The oldest rows by `ts` are pruned on `put` once exceeded. */
    maxEntries?: number;
    /** The async key/value store the cache is read from and written to (e.g. React Native `AsyncStorage`). */
    storage: AsyncStorageLike;
}

const DEFAULT_KEY = "lunora:query-cache";

/** Same LRU row cap as the in-memory and IndexedDB adapters. */
const DEFAULT_MAX_ENTRIES = 500;

/**
 * Builds a {@link QueryCacheAdapter} over an async key/value store — the React
 * Native / Expo counterpart to `createIndexedDbQueryCache`. The whole cache is
 * serialized to JSON under a single key (`key`), so values round-trip through
 * `JSON.stringify` — the same durability format (and the same JSON-safe-values
 * trade-off) the AsyncStorage persistence adapter already made.
 *
 * AsyncStorage has no transactions, so every read-modify-write is funnelled
 * through a single promise chain — concurrent `put`/`remove` calls run one at
 * a time and can't clobber each other's writes.
 *
 * Single-blob storage rewrites the whole cache per `put` (bounded by
 * `maxEntries`); if that ever shows up in profiles, per-key storage entries
 * are the upgrade path.
 */
const createAsyncStorageQueryCache = (options: AsyncStorageQueryCacheOptions): QueryCacheAdapter => {
    const { storage } = options;
    const key = options.key ?? DEFAULT_KEY;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

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

    const readAll = async (): Promise<Map<string, StoredQuery>> => {
        const raw = await storage.getItem(key);

        if (raw === null) {
            return new Map();
        }

        try {
            const parsed: unknown = JSON.parse(raw);

            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                ? new Map(Object.entries(parsed as Record<string, StoredQuery>))
                : new Map();
        } catch {
            // Corrupt payload (partial write, hand-edited store) — start clean
            // rather than wedging every load. The lost cache is re-fetchable.
            return new Map();
        }
    };

    const writeAll = (entries: Map<string, StoredQuery>): Promise<void> => storage.setItem(key, JSON.stringify(Object.fromEntries(entries)));

    /** Drop oldest rows by `ts` until the cache is back under the cap. */
    const evict = (entries: Map<string, StoredQuery>): void => {
        if (entries.size <= maxEntries) {
            return;
        }

        // Oldest-first by `ts`; insertion order is a good-enough tiebreak for
        // equal timestamps — same policy as the sibling adapters.
        const ordered = [...entries.values()].toSorted((a, b) => a.ts - b.ts);

        for (const stale of ordered) {
            if (entries.size <= maxEntries) {
                break;
            }

            entries.delete(stale.key);
        }
    };

    return {
        clear: () => serialize(() => storage.removeItem(key)),
        load: () =>
            serialize(async () => {
                const entries = await readAll();

                return [...entries.values()];
            }),
        put: (entryKey, entry) =>
            serialize(async () => {
                const entries = await readAll();

                entries.set(entryKey, { ...entry, key: entryKey });
                evict(entries);

                await writeAll(entries);
            }),
        remove: (entryKey) =>
            serialize(async () => {
                const entries = await readAll();

                if (entries.delete(entryKey)) {
                    await writeAll(entries);
                }
            }),
    };
};

export { createAsyncStorageQueryCache };
export type { AsyncStorageQueryCacheOptions };
