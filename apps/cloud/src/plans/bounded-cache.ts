/**
 * Most entries a dispatcher's per-isolate lookup cache holds. The keys come from
 * request hostnames, which anyone can mint, so an unbounded cache lets a stream of
 * made-up hosts grow the isolate until it runs out of memory.
 */
export const LOOKUP_CACHE_MAX_ENTRIES = 10_000;

/**
 * A `Map` capped at `max` entries that drops the least recently used one first.
 * A `Map` iterates in insertion order, so re-inserting on every read and write
 * keeps the coldest key at the front.
 */
export class BoundedCache<V> {
    readonly #entries = new Map<string, V>();

    readonly #max: number;

    public constructor(max: number = LOOKUP_CACHE_MAX_ENTRIES) {
        this.#max = max;
    }

    public get size(): number {
        return this.#entries.size;
    }

    public get(key: string): V | undefined {
        const value = this.#entries.get(key);

        if (value !== undefined) {
            this.#entries.delete(key);
            this.#entries.set(key, value);
        }

        return value;
    }

    public set(key: string, value: V): void {
        this.#entries.delete(key);
        this.#entries.set(key, value);

        if (this.#entries.size > this.#max) {
            const oldest = this.#entries.keys().next();

            if (oldest.done !== true) {
                this.#entries.delete(oldest.value);
            }
        }
    }
}
