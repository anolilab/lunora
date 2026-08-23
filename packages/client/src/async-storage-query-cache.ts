import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { AsyncStorageLike } from "./async-storage-persistence";
import { assertMaxEntries } from "./query-cache";
import { singleBlobStore } from "./single-blob-store";
import type { QueryCacheAdapter, StoredQuery } from "./types";

interface AsyncStorageQueryCacheOptions {
    /** Storage key the cache is serialized under; defaults to `"lunora:query-cache"`. */
    key?: string;
    /** LRU row cap; defaults to 50 (see {@link DEFAULT_MAX_ENTRIES}). Must be a positive integer. The oldest rows by `ts` are pruned on `put` once exceeded. */
    maxEntries?: number;
    /** The async key/value store the cache is read from and written to (e.g. React Native `AsyncStorage`). */
    storage: AsyncStorageLike;
}

const DEFAULT_KEY = "lunora:query-cache";

/**
 * LRU row cap — deliberately an order of magnitude below the in-memory and
 * IndexedDB adapters' 500. Those store one row per query; this adapter stores
 * the WHOLE cache in one AsyncStorage row, and on Android that row must fit
 * SQLite's CursorWindow (~2MB) while sharing the store's overall budget (~6MB
 * by default) with the offline outbox under `lunora:offline-mutations`. A blob
 * that outgrows the row limit fails every subsequent write, and a read cache
 * that eats the shared budget starts failing the outbox's `append` — which
 * loses queued WRITES on reload, a far worse outcome than a colder cache.
 * Raise `maxEntries` only if you know your rows are small.
 */
const DEFAULT_MAX_ENTRIES = 50;

/**
 * Builds a {@link QueryCacheAdapter} over an async key/value store — the React
 * Native / Expo counterpart to `createIndexedDbQueryCache`. The whole cache is
 * serialized under a single key (`key`).
 *
 * Values pass through the transport's {@link encodeWire}/{@link decodeWire}
 * codec, NOT raw `JSON.stringify`. What this cache holds is a decoded SERVER
 * value — whatever the query returned, including the `bigint`, `Date`, `Map`,
 * `Set`, `ArrayBuffer`/typed-array, and `NaN`/`Infinity` leaves `decodeWire`
 * just reconstructed on the way in. Raw JSON would mangle every one of them
 * (`Date` to a string, bytes to `{}`, `NaN` to `null`) or throw outright on a
 * `bigint`, and nothing would ever repair it: a `resume` frame keeps the
 * hydrated value as-is, so the damage would survive every reconnect and every
 * delta merged onto it. The IndexedDB sibling gets this for free via structured
 * clone; here it is explicit. (This is what separates the read cache from the
 * outbox, which stores JSON-safe args the caller chose.)
 *
 * AsyncStorage has no transactions, so every read-modify-write runs through
 * {@link singleBlobStore}'s serialized chain — concurrent `put`/`remove` calls
 * run one at a time and can't clobber each other's writes.
 *
 * Single-blob storage rewrites the whole cache per `put` (bounded by
 * `maxEntries` — see the cap's note on Android's row and shared-budget limits);
 * if that ever shows up in profiles, per-key storage entries are the upgrade
 * path.
 */
const createAsyncStorageQueryCache = (options: AsyncStorageQueryCacheOptions): QueryCacheAdapter => {
    const maxEntries = assertMaxEntries(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "createAsyncStorageQueryCache");
    const blob = singleBlobStore(options.storage, options.key ?? DEFAULT_KEY);

    const readAll = async (): Promise<Map<string, StoredQuery>> => {
        const parsed = decodeWire(await blob.read());

        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? new Map(Object.entries(parsed as Record<string, StoredQuery>))
            : new Map();
    };

    const writeAll = (entries: Map<string, StoredQuery>): Promise<void> => blob.write(encodeWire(Object.fromEntries(entries)));

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
        clear: blob.clear,
        load: () =>
            blob.serialize(async () => {
                const entries = await readAll();

                return [...entries.values()];
            }),
        put: (entryKey, entry) =>
            blob.serialize(async () => {
                const entries = await readAll();

                entries.set(entryKey, { ...entry, key: entryKey });
                evict(entries);

                await writeAll(entries);
            }),
        remove: (entryKey) =>
            blob.serialize(async () => {
                const entries = await readAll();

                if (entries.delete(entryKey)) {
                    await writeAll(entries);
                }
            }),
    };
};

export { createAsyncStorageQueryCache };
export type { AsyncStorageQueryCacheOptions };
