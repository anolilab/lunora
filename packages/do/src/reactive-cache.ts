/**
 * Per-shard reactive query cache.
 *
 * Convex's "queries are reactive by default" guarantee comes from a server-side
 * memoization layer: each query result is keyed by `(functionPath, argsHash)`
 * and stamped with the row-level dependencies it read, so a subsequent call
 * with the same inputs returns the cached value instantly until a mutation
 * touches a row in its dep set. Lunora's per-shard model is a natural fit —
 * each Durable Object is its own consistency boundary, so the cache lives in
 * DO memory and invalidates on local writes with zero coordination.
 *
 * Lifetime + storage model:
 *
 * - In-memory `Map&lt;key, CacheEntry>`. Insertion-order is the LRU order; we
 * delete and re-set an entry on every read so the freshest one sits at
 * the tail of the map. No timers — eviction runs purely on the
 * set/delete paths.
 *
 * - Per-shard, so a fresh DO always cold-starts on the first call. That's
 * deliberate: the cost of recomputing a query on a fresh shard is one
 * handler run; the cost of any persistence layer would dwarf the
 * savings. (Durable Object hibernation drops in-memory state anyway.)
 *
 * - Two indexes: the main `entries` map (key -> entry) and `tableIndex`
 * (`table:id` -> Set&lt;key>) so `ReactiveCache.invalidate` is O(deps)
 * instead of O(entries).
 *
 * Eviction:
 *
 * - `maxEntries` (default 1000) bounds the total slot count.
 * - `maxBytes` (default 4 MB) bounds the cumulative `bytes` field across
 * entries. We approximate `bytes` as `JSON.stringify(result).length` —
 * accurate enough for sizing decisions, cheap enough to run on every
 * insert.
 *
 * When either limit is breached we evict from the head of the map (oldest
 * `lastUsed`) until both limits hold again. A `subscribers.size > 0` entry
 * is NEVER evicted — pulling an actively-watched key would force a re-run
 * storm on the next mutation. If every remaining entry has subscribers we
 * stop evicting (the cache will run over its target until a subscriber
 * detaches; better than thrashing).
 *
 * The class is intentionally framework-agnostic — it does not know about
 * `SqlExec`, `ShardDO`, or the WS layer. Tests cover it standalone, and the
 * ctx-db hooks wire it to real reads/writes via the existing onRead/onWrite
 * surface (see `ctx-db.ts`).
 */

import { stableWireKey } from "../../../shared/wire-key";
import { depKey, SCAN_DEP } from "./dependency-tracker";

/** A single memoized result, the deps it read, and any active subscribers. */
interface CacheEntry {
    /** Approximate serialized size of `result`, charged against `maxBytes`. */
    bytes: number;
    /** Dep keys (`table:id` / `table:*scan`) that invalidate this entry. */
    deps: Set<string>;
    /** Monotonic touch timestamp for LRU ordering. */
    lastUsed: number;
    /** Whatever the handler resolved to. */
    result: unknown;
    /** Subscriber ids interested in re-runs when this entry invalidates. */
    subscribers: Set<string>;
}

interface ReactiveCacheOptions {
    /**
     * Maximum cumulative `bytes` charge across entries. Default `4 * 1024 * 1024`
     * (4 MiB). Use `Number.POSITIVE_INFINITY` to disable the byte cap.
     */
    maxBytes?: number;

    /**
     * Maximum number of cached entries. Default `1000`. Use
     * `Number.POSITIVE_INFINITY` to disable the entry cap.
     */
    maxEntries?: number;

    /**
     * Injectable wall clock for deterministic LRU testing. Defaults to a
     * monotonic counter (not `Date.now`) so two `run()` calls in the same
     * tick always order strictly — `Date.now` returns the same millisecond
     * for them and produces eviction ties that break the LRU assertion.
     */
    now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 1000;

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Conservative size estimate for a cached result. We don't need byte-accurate
 * accounting — the cap is a rough back-pressure mechanism, not a hard limit
 * the runtime enforces. `JSON.stringify` already runs on most results inside
 * the WS push path, so the overhead is amortized.
 */
const estimateBytes = (value: unknown): number => {
    if (value === undefined || value === null) {
        return 0;
    }

    try {
        return JSON.stringify(value).length;
    } catch {
        // Circular structure or unsupported value — assume worst case so it
        // gets evicted promptly. The handler should never have produced a
        // value the WS layer can't serialize anyway.
        return DEFAULT_MAX_BYTES;
    }
};

class ReactiveCache {
    /** key -> entry. Map insertion order doubles as LRU order. */
    private readonly entries = new Map<string, CacheEntry>();

    /** `table:id` (or `table:*scan`) -> set of cache keys that depend on it. */
    private readonly tableIndex = new Map<string, Set<string>>();

    /** Cumulative byte charge across `entries`. Tracked incrementally. */
    private totalBytes = 0;

    /** Lifetime cache-hit count, surfaced via `stats()`. */
    private hits = 0;

    /** Lifetime cache-miss count (callback ran), surfaced via `stats()`. */
    private misses = 0;

    /** Lifetime count of entries dropped by the LRU evictor. */
    private evictions = 0;

    private readonly maxEntries: number;

    private readonly maxBytes: number;

    private readonly now: () => number;

    /**
     * Monotonic counter — used as the default clock so `lastUsed` strictly
     * orders calls even when they land in the same wall-clock millisecond.
     */
    private monotonic = 0;

    public constructor(options: ReactiveCacheOptions = {}) {
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.now =
            options.now ??
            (() => {
                this.monotonic += 1;

                return this.monotonic;
            });
    }

    /**
     * Return the cached result for `key` if present (and re-stamp it as
     * most-recently-used); otherwise run the callback, store the result with
     * `deps` as its invalidation footprint, and return it. The caller is
     * responsible for collecting `deps` via a `DependencyTracker` during
     * the callback and handing the same set in here — the cache stores the
     * reference verbatim, so the caller MUST stop mutating it after this
     * call returns.
     *
     * The callback is awaited inside the cache so concurrent callers for the
     * same key still race the underlying handler — a real Convex-style
     * "in-flight dedup" would add a `Map&lt;key, Promise>`; we keep this simpler
     * and accept that the first uncached hit may run the handler twice when
     * two callers arrive on the same tick. The single-DO concurrency model
     * makes that race vanishingly rare in practice.
     */
    public async run<R>(key: string, deps: Set<string>, run: () => Promise<R>): Promise<R> {
        const existing = this.entries.get(key);

        if (existing) {
            this.hits += 1;
            existing.lastUsed = this.now();
            // Re-insert to move to the tail of the LRU order.
            this.entries.delete(key);
            this.entries.set(key, existing);

            return existing.result as R;
        }

        this.misses += 1;
        const result = await run();
        const bytes = estimateBytes(result);
        const entry: CacheEntry = {
            bytes,
            deps,
            lastUsed: this.now(),
            result,
            subscribers: new Set<string>(),
        };

        this.entries.set(key, entry);
        this.totalBytes += bytes;

        for (const dep of deps) {
            let bucket = this.tableIndex.get(dep);

            if (!bucket) {
                bucket = new Set<string>();
                this.tableIndex.set(dep, bucket);
            }

            bucket.add(key);
        }

        this.evict();

        return result;
    }

    /**
     * Invalidate every entry that recorded a read of `(table, id)` OR a full
     * scan of `table` (the `*scan` marker). Returns the keys removed so the
     * caller can re-run their subscribers — see `ShardDO#flushChangedTables`
     * for the wired-up consumer.
     */
    public invalidate(table: string, id: string): string[] {
        const removed: string[] = [];

        this.collectAndDrop(depKey(table, id), removed);
        this.collectAndDrop(depKey(table, SCAN_DEP), removed);

        return removed;
    }

    /**
     * Nuke every entry that depends on `table` in any form (rows + `*scan`).
     * Wired in by the writer for operations that can't pinpoint a row id
     * (e.g. bulk truncate). For the common single-row write path, prefer
     * {@link invalidate} so per-id entries on other rows survive.
     */
    public invalidateTable(table: string): string[] {
        const removed: string[] = [];
        const prefix = `${table}:`;

        for (const dep of this.tableIndex.keys()) {
            if (dep.startsWith(prefix)) {
                this.collectAndDrop(dep, removed);
            }
        }

        return removed;
    }

    /**
     * Register `subscriberId` as interested in re-runs of `key`. Subscribers
     * pin the entry against eviction — see {@link evict}. A subscriber on a
     * key that isn't cached yet is a no-op (the first `run()` will land the
     * entry, but the subscription registration is lost). Callers SHOULD
     * subscribe AFTER the first `run()` returns to avoid that gap.
     */
    public subscribe(key: string, subscriberId: string): void {
        const entry = this.entries.get(key);

        if (!entry) {
            return;
        }

        entry.subscribers.add(subscriberId);
    }

    /** Detach a subscriber from `key`. Idempotent on missing entries. */
    public unsubscribe(key: string, subscriberId: string): void {
        const entry = this.entries.get(key);

        if (!entry) {
            return;
        }

        entry.subscribers.delete(subscriberId);
    }

    /** Read-only view of the cache's current resource usage. */
    public size(): { bytes: number; entries: number } {
        return { bytes: this.totalBytes, entries: this.entries.size };
    }

    /** Drop every cached entry. Used by tests for isolation. */
    public clear(): void {
        this.entries.clear();
        this.tableIndex.clear();
        this.totalBytes = 0;
    }

    /**
     * Look up the entry's subscribers without exposing the internal map.
     * Returned as a snapshot so the caller can iterate without worrying about
     * concurrent unsubscribes mid-loop.
     */
    public subscribers(key: string): string[] {
        const entry = this.entries.get(key);

        if (!entry) {
            return [];
        }

        return [...entry.subscribers];
    }

    /**
     * Snapshot of lifetime cache counters plus the current live size. Drives the
     * studio's metrics panel; cheap, allocation-light, and side-effect-free.
     */
    public stats(): { bytes: number; entries: number; evictions: number; hits: number; misses: number } {
        return {
            bytes: this.totalBytes,
            entries: this.entries.size,
            evictions: this.evictions,
            hits: this.hits,
            misses: this.misses,
        };
    }

    /** Pull `dep`'s bucket from the index and remove every entry in it. */
    private collectAndDrop(dep: string, removed: string[]): void {
        const bucket = this.tableIndex.get(dep);

        if (!bucket) {
            return;
        }

        for (const key of bucket) {
            const entry = this.entries.get(key);

            if (!entry) {
                continue;
            }

            this.dropEntry(key, entry);
            removed.push(key);
        }
    }

    /** Remove an entry from every index and decrement the byte charge. */
    private dropEntry(key: string, entry: CacheEntry): void {
        this.entries.delete(key);
        this.totalBytes -= entry.bytes;

        for (const dep of entry.deps) {
            const bucket = this.tableIndex.get(dep);

            if (!bucket) {
                continue;
            }

            bucket.delete(key);

            if (bucket.size === 0) {
                this.tableIndex.delete(dep);
            }
        }
    }

    /**
     * Run LRU eviction until both caps hold. Subscribed entries are pinned —
     * if every survivor has subscribers we exit with the caps still breached
     * (better than ejecting an actively-watched query and forcing a re-run
     * storm on its next refresh).
     */
    private evict(): void {
        if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) {
            return;
        }

        for (const [key, entry] of this.entries) {
            if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) {
                return;
            }

            if (entry.subscribers.size > 0) {
                continue;
            }

            this.dropEntry(key, entry);
            this.evictions += 1;
        }
    }
}

/**
 * Compose a cache key from a function path, a stably-encoded args object, and
 * the caller's identity discriminator. Exported so the wiring layer and tests
 * build identical keys without each side reinventing the format.
 *
 * The identity discriminator is REQUIRED: the reactive cache is per-DO and, on
 * the default single-`__root__`-DO topology, every user shares it. A query
 * whose result depends on `ctx.auth.userId` / `getIdentity()` (e.g. an
 * RLS-filtered list, or `getMyProfile()` with no args) would otherwise memoize
 * the first caller's result under an identity-independent key and serve it to
 * everyone. Anonymous/subscription callers pass `null` (their own bucket).
 *
 * The discriminator is an opaque `null | string`, NOT just a userId: the wiring
 * layer (`ShardDO#runCachedQuery`) folds the FULL resolved identity — userId
 * plus the `getIdentity()` claims (active-org / role / tenant) — into a single
 * `stableStringify`'d string before it reaches here. That matters because RLS
 * can key on a claim OTHER than userId: a multi-tenant caller whose userId is
 * stable but whose active-org claim varies request-to-request must NOT share a
 * cache entry across those requests. Encoding the whole identity, not the
 * userId alone, is what keeps those contexts isolated.
 */
const reactiveCacheKey = (functionPath: string, args: Record<string, unknown>, identity: null | string): string =>
    `${identity ?? " anon"} ${functionPath}:${stableWireKey(args)}`;

export { ReactiveCache, reactiveCacheKey };
export type { CacheEntry, ReactiveCacheOptions };

export { stableStringify } from "../../../shared/stable-key";
export { stableWireKey } from "../../../shared/wire-key";
