/**
 * The per-flush memo the shape poke path diffs through.
 *
 * A flush pokes every socket holding a shape, and the two reads that costs —
 * "which keys changed in this range" and "which of those keys does this
 * predicate admit" — are both shared far more widely than the loop that issues
 * them suggests. The changed-key scan depends only on `(table, sinceSeq, upTo)`,
 * so every shape over the same range asks the identical question; the membership
 * probe depends only on `(table, effectiveWhere, ids)`, so every socket whose
 * `resolveShape` produced the same predicate does too. Neither depends on the
 * socket, and a shape with a hundred subscribers used to run a hundred copies of
 * the second one.
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

/** Flush-scoped memo for the shape diff's two reads, plus the counters that make the collapse observable. */
interface ShapeDiffCache {
    /** Changed row keys by {@link shapeRangeKey}. */
    keys: Map<string, CdcChangeKey[]>;

    /** Membership + documents by {@link shapeProbeKey}. */
    members: Map<string, Map<string, Record<string, unknown>>>;

    /** Probes actually issued to the store this flush. */
    probesRun: number;

    /** Probes answered from the memo — the duplicates the per-socket loop would otherwise have issued. */
    probesServed: number;
}

/** A fresh, empty per-flush cache. */
const createShapeDiffCache = (): ShapeDiffCache => {
    return { keys: new Map(), members: new Map(), probesRun: 0, probesServed: 0 };
};

/**
 * Join composite key parts unambiguously by length-prefixing each one.
 *
 * A separator character would do only if it could not appear in any part, and
 * the parts here are table names, encoded predicates and row ids — all
 * caller-supplied strings with no reserved alphabet. Length prefixes need no
 * such assumption: `["a", "bc"]` and `["ab", "c"]` cannot collide, so two
 * different probes can never share a cache entry and serve each other's rows.
 */
const joinKeyParts = (parts: ReadonlyArray<string>): string => parts.map((part) => `${String(part.length)}:${part}`).join("");

/** A shape's resolved predicate as a stable string. Throws (rather than colliding) on a value the encoder cannot faithfully carry. */
const predicateKey = (resolved: ResolvedShape): string =>
    // eslint-disable-next-line unicorn/no-null -- an absent predicate is a distinct, legitimate key ("unfiltered"); `null` encodes, `undefined` would collide with a nested absent field.
    stableWireKey(resolved.effectiveWhere ?? null);

/** The identity of one changed-key scan: the table and the exact op-log range it covers. */
const shapeRangeKey = (table: string, sinceSeq: number, upTo: number): string => joinKeyParts([table, String(sinceSeq), String(upTo)]);

/**
 * The identity of one membership probe: its table, its resolved predicate, and
 * the exact id set it is asked about. `columns` is deliberately absent — the
 * column allow-list is applied when the poke is built, not when the rows are
 * read, so two shapes that differ only in projection still share one probe.
 *
 * Returns `undefined` when the predicate cannot be stably encoded (`stableWireKey`
 * refuses a value with no faithful JSON key — a class instance, a function). The
 * caller then runs the probe un-memoized: the correct answer at the un-shared
 * cost, which is what every caller paid before this cache existed. Silently
 * keying such a predicate to a colliding string would be the one genuinely
 * dangerous outcome, so it is the one thing this never does.
 */
const shapeProbeKey = (resolved: ResolvedShape, ids: ReadonlyArray<string>): string | undefined => {
    try {
        // The ids go through {@link joinKeyParts} too, for the same reason the
        // outer parts do: a row id is only a UUID on the default insert path —
        // the trusted-import path (`allowExplicitId`) admits any string, comma
        // included — so `ids.join(",")` would let `["a,b"]` and `["a", "b"]`
        // share one entry and serve each other's member map.
        return joinKeyParts([resolved.table, predicateKey(resolved), joinKeyParts(ids)]);
    } catch {
        return undefined;
    }
};

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

export { createShapeDiffCache, globalShapeReadKey, shapeProbeKey, shapeRangeKey };
export type { ShapeDiffCache };
