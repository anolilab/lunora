import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { AsyncStorageLike } from "./async-storage-persistence";

/** What {@link SingleBlobStore.read} returns for a blob that exists but cannot be decoded. */
const CORRUPT_BLOB: unique symbol = Symbol("lunora.corrupt-blob");

/**
 * The serialized read-modify-write chain both AsyncStorage-backed adapters run
 * on: `read`/`write` are raw (no locking) and belong INSIDE a `serialize` block,
 * which is what keeps one read-modify-write from interleaving with another.
 */
interface SingleBlobStore {
    /** Drop the whole blob. Serializes itself — don't wrap it again. */
    clear: () => Promise<void>;
    /** Decoded payload, `undefined` when absent, or {@link CORRUPT_BLOB} when present but undecodable. The caller narrows the shape. */
    read: () => Promise<unknown>;
    /** Run `run` once every previously-queued op has settled (resolved or rejected). */
    serialize: <T>(run: () => Promise<T>) => Promise<T>;
    /** Overwrite the whole blob; rejects, leaving it untouched, when `value` can't be wire-encoded. */
    write: (value: unknown) => Promise<void>;
}

/**
 * A whole collection serialized under one key of an async key/value store —
 * the storage shape React Native's `AsyncStorage` forces on us (no
 * transactions, no secondary indexes, no partial reads). Backs both
 * `createAsyncStoragePersistence` and `createAsyncStorageQueryCache`.
 *
 * Values pass through the transport's {@link encodeWire}/{@link decodeWire}
 * codec, NOT raw `JSON.stringify`: both adapters hold values (caller args, decoded
 * server results) whose `bigint` would make raw JSON throw and whose `Date`,
 * `Map`, `Set`, bytes, or `NaN` it would silently mangle — the IndexedDB
 * siblings round-trip all of them via structured clone. Plain JSON written by an
 * older version decodes unchanged.
 *
 * Every op is funnelled through a single promise chain so concurrent callers
 * run one at a time and can't clobber each other's writes. A corrupt payload
 * (partial write, hand-edited store, malformed wire tag) reads as
 * {@link CORRUPT_BLOB} rather than throwing, so no load wedges; each adapter
 * decides whether that means "start clean" or "don't overwrite".
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
                return decodeWire(JSON.parse(raw));
            } catch {
                return CORRUPT_BLOB;
            }
        },
        serialize,
        write: async (value) => {
            await storage.setItem(key, JSON.stringify(encodeWire(value)));
        },
    };
};

export { CORRUPT_BLOB, singleBlobStore };
export type { SingleBlobStore };
