/**
 * `memoizePromise` — the keyed "initialise this once, and let a failure retry"
 * cache shared by every lazily-built async singleton in the codebase: the
 * per-tool x402 charge middleware (`@lunora/mcp`), the per-procedure one
 * (`@lunora/x402`), and the per-secret HMAC key cache (`shared/hmac-url.ts`).
 *
 * Each had hand-rolled the same three moves — look the key up, start the work
 * and store the PROMISE (not the value, so concurrent callers coalesce onto one
 * run), drop the entry if it rejects. Storing the promise is the load-bearing
 * half: a burst of first calls in a cold isolate then pays one initialisation
 * instead of one each.
 *
 * ## Why a rejection must not stay cached
 *
 * These caches hold work that reaches the network — fetching a facilitator's
 * supported schemes, importing a key. A transient outage that lands in the map
 * as a rejected promise is served to every later caller for the isolate's whole
 * life, turning one bad second into minutes of hard failure. So a rejection
 * evicts.
 *
 * ## Why the eviction is conditional
 *
 * The obvious `.catch(() => { map.delete(key) })` deletes whatever is under
 * `key` at rejection time, which need not be the entry it started. A slow first
 * attempt that fails after a second caller has already evicted it and installed
 * a fresh, healthy promise would delete that one — the retry loses its cache and
 * the next caller starts a third run. Comparing identity before deleting makes
 * an entry only ever able to evict itself.
 *
 * The FIFO bound is `evictOldestEntry`'s, not a second implementation. That
 * helper's contract — "every caller inserts exactly one entry immediately after
 * calling" — is structurally true here, where it used to be a promise each
 * caller kept on its own.
 *
 * Like the other `shared/` helpers this is deliberately **not** a package:
 * consumers import it by relative path and the bundler inlines it — no runtime
 * dependency edge. Keep it genuinely zero-dependency. A consumer that sets
 * `rootDir` in its `tsconfig.json` must drop it (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 */
import { evictOldestEntry } from "./evict-oldest";

/**
 * The promise stored under `key`, starting (and storing) one via `start` on the
 * first call.
 *
 * Concurrent callers for the same key receive the same promise. A rejection
 * removes the entry — but only while the entry is still the one this call
 * installed — so the next caller retries instead of being handed the old
 * failure.
 *
 * `maxEntries` bounds the map: the oldest entry is evicted immediately before a
 * new one is stored, never on a hit (a hit adds no entry). Omit it for a cache
 * whose keys are a closed set — a declared tool name, a `functionPath` — where
 * there is nothing to bound.
 * @param map The cache. Insertion-ordered, so the bound evicts FIFO.
 * @param key The cache key.
 * @param start Starts the work. Called only on a miss.
 * @param maxEntries Optional FIFO bound on the map's size.
 * @returns The cached or freshly started promise.
 */
const memoizePromise = <K, V>(map: Map<K, Promise<V>>, key: K, start: () => Promise<V>, maxEntries?: number): Promise<V> => {
    const cached = map.get(key);

    if (cached !== undefined) {
        return cached;
    }

    if (maxEntries !== undefined) {
        evictOldestEntry(map, maxEntries);
    }

    const pending = start().catch((error: unknown) => {
        // Identity-checked: only evict the entry THIS call installed. See the
        // module docblock — an unconditional delete can drop a healthy retry
        // that replaced this one while it was still in flight.
        if (map.get(key) === pending) {
            map.delete(key);
        }

        throw error;
    });

    map.set(key, pending);

    return pending;
};

export { memoizePromise };
