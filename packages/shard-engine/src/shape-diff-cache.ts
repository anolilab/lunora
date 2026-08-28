/**
 * The per-flush memo the shape poke path diffs through.
 *
 * A flush pokes every socket holding a shape, and the two reads that costs —
 * "which keys changed in this range" and "which of those keys does this
 * predicate admit" — are both shared far more widely than the loop that issues
 * them suggests. The changed-key scan depends only on `(table, sinceSeq, upTo)`,
 * so every shape over the same range asks the identical question; the membership
 * probe depends only on `(effectiveWhere, that same range)`, so every socket
 * whose `resolveShape` produced the same predicate does too. Neither depends on
 * the socket, and a shape with a hundred subscribers used to run a hundred copies
 * of the second one.
 *
 * That the probe needs no identity is a property of WHERE it reads: this shard's
 * own SQLite, through the predicate and nothing else. It does not carry over to
 * a `.global()` read, which goes through an application-supplied writer built
 * per caller — see {@link globalShapeReadKey}.
 *
 * The cache is created fresh per flush and thrown away at the end of it. That is
 * deliberate and load-bearing: the changed-key set moves with every write, so a
 * cache that outlived the flush would serve a stale key set and silently drop
 * rows from the next poke. Reuse across a flush, never across writes.
 */

import { stableWireKey } from "../../../shared/wire-key";
import type { CdcChangeKey } from "./ctx-db-cdc";
import type { ResolvedShape } from "./types";

/**
 * Join composite key parts unambiguously by length-prefixing each one.
 *
 * A separator character would do only if it could not appear in any part, and
 * the parts here are table names and encoded predicates — caller-supplied
 * strings with no reserved alphabet. Length prefixes need no such assumption:
 * `["a", "bc"]` and `["ab", "c"]` cannot collide, so two different probes can
 * never share a cache entry and serve each other's rows.
 */
const joinKeyParts = (parts: ReadonlyArray<string>): string => parts.map((part) => `${String(part.length)}:${part}`).join("");

/** A shape's resolved predicate as a stable string. Throws (rather than colliding) on a value the encoder cannot faithfully carry. */
const predicateKey = (resolved: ResolvedShape): string =>
    // eslint-disable-next-line unicorn/no-null -- an absent predicate is a distinct, legitimate key ("unfiltered"); `null` encodes, `undefined` would collide with a nested absent field.
    stableWireKey(resolved.effectiveWhere ?? null);

/** The identity of one changed-key scan: the table and the exact op-log range it covers. */
const shapeRangeKey = (table: string, sinceSeq: number, upTo: number): string => joinKeyParts([table, String(sinceSeq), String(upTo)]);

/**
 * The identity of one membership probe: its resolved predicate, and the
 * changed-key scan whose ids it is asked about — named by that scan's own
 * {@link shapeRangeKey} rather than by listing them.
 *
 * The two are equivalent as keys. A probe's id set is not free input: it is
 * exactly `readCdcChangeKeys(table, sinceSeq, upTo)` mapped to ids, so the range
 * key already determines it, and the table is already inside the range key. What
 * the equivalent-but-shorter form avoids is size — a client catching up over a
 * long range brings a six-figure id set, and spelling it into the key builds a
 * multi-megabyte string per (shape, socket) and then RETAINS it as a `Map` key
 * for the rest of the flush. On the per-identity predicates where this cache
 * shares nothing (the case it explicitly tolerates), that is unbounded growth in
 * a 128 MB isolate, and strictly worse than the transient set the un-memoized
 * path used to allocate.
 *
 * `columns` is deliberately absent — the column allow-list is applied when the
 * poke is built, not when the rows are read, so two shapes that differ only in
 * projection still share one probe.
 *
 * Returns `undefined` when the predicate cannot be stably encoded (`stableWireKey`
 * refuses a value with no faithful JSON key — a class instance, a function). The
 * probe then runs un-memoized: the correct answer at the un-shared cost, which is
 * what every caller paid before this cache existed. Silently keying such a
 * predicate to a colliding string would be the one genuinely dangerous outcome,
 * so it is the one thing this never does.
 */
const shapeProbeKey = (resolved: ResolvedShape, rangeKey: string): string | undefined => {
    try {
        return joinKeyParts([predicateKey(resolved), rangeKey]);
    } catch {
        return undefined;
    }
};

/**
 * Flush-scoped memo for the shape diff's two reads, plus the counters that make
 * the collapse observable.
 *
 * Both reads go through one {@link ShapeDiffCache.getOrLoad} core rather than
 * each call site re-writing lookup/miss/load/store/count. That is not tidiness:
 * the hand-written variants disagreed about the counters, so the changed-key
 * half — half of what this cache exists for — was shared but never counted, and
 * the Studio panel reported a sharing rate over only the membership half.
 */
class ShapeDiffCache {
    /** Changed row keys by {@link shapeRangeKey}. */
    private readonly keyScans = new Map<string, CdcChangeKey[]>();

    /** Membership + documents by {@link shapeProbeKey}. */
    private readonly memberProbes = new Map<string, Map<string, Record<string, unknown>>>();

    private run = 0;

    private served = 0;

    /** Reads actually issued to the store this flush. */
    public get probesRun(): number {
        return this.run;
    }

    /** Reads answered from the memo — the duplicates the per-socket loop would otherwise have issued. */
    public get probesServed(): number {
        return this.served;
    }

    /**
     * The changed-key scan for `rangeKey`, loading it once per flush.
     *
     * Read-only because every subscriber of the shape in one flush is handed the
     * SAME array: sorting or splicing it in place would silently change what the
     * others see.
     */
    public changedKeys(rangeKey: string, load: () => CdcChangeKey[]): ReadonlyArray<CdcChangeKey> {
        return this.getOrLoad(this.keyScans, rangeKey, load);
    }

    /** The membership probe for `resolved` over the scan named by `rangeKey`, loading it once per flush. Shared across the flush's subscribers, so read-only — see {@link ShapeDiffCache.changedKeys}. */
    public members(resolved: ResolvedShape, rangeKey: string, load: () => Map<string, Record<string, unknown>>): ReadonlyMap<string, Record<string, unknown>> {
        return this.getOrLoad(this.memberProbes, shapeProbeKey(resolved, rangeKey), load);
    }

    /**
     * Serve `key` from `store`, or load and record it. An `undefined` key means
     * "this read cannot be keyed" — it loads, counts as run, and stores nothing,
     * so an unkeyable predicate costs its own read and never anyone else's
     * answer.
     */
    private getOrLoad<T>(store: Map<string, T>, key: string | undefined, load: () => T): T {
        if (key !== undefined) {
            const cached = store.get(key);

            if (cached !== undefined) {
                this.served += 1;

                return cached;
            }
        }

        this.run += 1;

        const value = load();

        if (key !== undefined) {
            store.set(key, value);
        }

        return value;
    }
}

/** A fresh, empty per-flush cache. */
const createShapeDiffCache = (): ShapeDiffCache => new ShapeDiffCache();

/**
 * The identity of one `.global()` membership read: the resolved predicate AND
 * the caller it is read for.
 *
 * The identity half is what separates this from {@link shapeProbeKey}, and it is
 * load-bearing rather than defensive. A shard-local probe reads this shard's own
 * SQLite through the predicate and nothing else, so equal predicates provably
 * mean equal rows. A `.global()` read goes through a writer the application
 * builds per request from `{ identity, userId }`, which may scope rows by the
 * caller before this code sees them — so equal predicates do NOT imply equal
 * rows there, and a cache keyed on the predicate alone could serve one user's
 * rows to another.
 *
 * Returns `undefined` when either half cannot be stably encoded, which degrades
 * to an unshared read rather than a shared wrong one.
 */
const globalShapeReadKey = (resolved: ResolvedShape, identity: { identity?: Record<string, unknown>; userId?: string }): string | undefined => {
    try {
        return joinKeyParts([resolved.table, predicateKey(resolved), stableWireKey({ identity: identity.identity, userId: identity.userId })]);
    } catch {
        return undefined;
    }
};

export { createShapeDiffCache, globalShapeReadKey, ShapeDiffCache, shapeRangeKey };
