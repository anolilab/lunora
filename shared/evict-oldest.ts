/**
 * `evictOldestEntry` — the FIFO bound shared by every bounded `Map` cache in the
 * codebase: the per-secret HMAC key cache (`shared/hmac-url.ts`), the runtime
 * relay-probe cache, the client poke-buffer map, and the D1 / sql-store
 * statement + table-name LRUs. Each had copy-pasted the same five-line
 * "evict the oldest entry once at capacity" block; this is the one definition.
 *
 * Relies on `Map` preserving insertion order — `keys().next().value` is the
 * oldest key. It evicts at most ONE entry (not a drain loop): every caller
 * inserts exactly one entry immediately after calling, so the size stays bounded
 * by `capacity`.
 *
 * This is only the FIFO/bound half. LRU callers (D1 statement cache, sql-store
 * table-name cache) bump a hit to the tail via delete+re-insert on their own
 * `get` path and call this only when inserting a genuinely new key — the recency
 * ordering lives in the caller, the size bound lives here. Pure FIFO/TTL callers
 * (HMAC key cache, relay-probe, poke-buffers) call it unconditionally before insert.
 *
 * Like the other `shared/` helpers this is deliberately **not** a package:
 * consumers import it by relative path and the bundler (packem/rollup) inlines
 * it — no runtime dependency edge, so no per-call indirection cost. Keep it
 * genuinely zero-dependency. A consumer that sets `rootDir` in its
 * `tsconfig.json` must drop it (a set `rootDir` raises TS6059 for this
 * out-of-package file under `tsc --noEmit`).
 */
const evictOldestEntry = <K, V>(map: Map<K, V>, capacity: number): void => {
    if (map.size < capacity) {
        return;
    }

    // Insertion-ordered Map keys → the first key is the oldest.
    const oldest = map.keys().next().value;

    if (oldest !== undefined) {
        map.delete(oldest);
    }
};

export { evictOldestEntry };
