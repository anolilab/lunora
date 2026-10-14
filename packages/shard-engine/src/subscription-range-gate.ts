/**
 * The subscription refresh gate: does a batch of writes require re-running a
 * given live query?
 *
 * Split out of `ShardDO` because it is pure — three folds over plain data with
 * no `this` — and because the rules below are the subtlest part of range-based
 * invalidation, so they need to be testable on their own.
 *
 * Every rule here is deliberately pessimistic. Narrowing is an optimization;
 * under-invalidating serves a live subscriber stale data forever, while
 * over-invalidating costs one re-run. Whenever a position, an index, or a
 * table's read shape is unknown, these functions answer "assume touched".
 */

import type { IndexKeyEntry, KeyRange } from "./read-write-set";
import { keysTouchRanges } from "./read-write-set";

/** The read footprint a live query was memoized with. */
interface SubscriptionReadFootprint {
    /** Slices per table, for tables read ONLY through ranges. */
    ranges?: Map<string, KeyRange[]>;
    /** Every table the query read. */
    tables: Set<string>;
}

/** Written positions per table; `undefined` means "position unknown for this table". */
type ChangedKeys = Map<string, IndexKeyEntry[] | undefined>;

/**
 * Fold one request's written positions into the coalesced refresh batch.
 *
 * Pessimistic by construction: a table counts as unknown if it is unknown in
 * EITHER side, or if the incoming request recorded no position for it at all.
 * The alternative — letting a later narrowable write overwrite an earlier
 * unnarrowable one — would skip a re-run the earlier write required.
 */
const mergeChangedKeys = (pending: ChangedKeys | undefined, incoming: ChangedKeys | undefined, changed: Set<string>): ChangedKeys => {
    const merged = pending ?? new Map<string, IndexKeyEntry[] | undefined>();

    for (const table of changed) {
        const next = incoming?.get(table);
        const previous = merged.get(table);
        const previousUnknown = merged.has(table) && previous === undefined;

        if (!incoming?.has(table) || next === undefined || previousUnknown) {
            merged.set(table, undefined);

            continue;
        }

        merged.set(table, previous ? [...previous, ...next] : next);
    }

    return merged;
};

/**
 * Record the index positions a written row occupies, so the refresh gate can
 * skip subscriptions whose read slices the write fell outside of.
 *
 * The positions are computed once on the write path and ride on the delta —
 * critically, unioned across the row's BEFORE and AFTER images. Deriving them
 * here from the post-image alone would see only where a patched row LANDED,
 * never the slice it left, and a subscriber watching that slice would never be
 * woken.
 *
 * `undefined` keys mean the position is unknown (a raw-SQL path, or a writer
 * that predates the delta field). That marks the table unnarrowable for this
 * batch — every subscription on it re-runs, exactly as before ranges existed.
 */
const recordChangedKeys = (pending: ChangedKeys | undefined, table: string, indexKeys: ReadonlyArray<IndexKeyEntry> | undefined): ChangedKeys => {
    const keysByTable = pending ?? new Map<string, IndexKeyEntry[] | undefined>();

    // Already unknown for this batch — nothing can narrow it back.
    if (keysByTable.has(table) && keysByTable.get(table) === undefined) {
        return keysByTable;
    }

    if (!indexKeys || indexKeys.length === 0) {
        keysByTable.set(table, undefined);

        return keysByTable;
    }

    const existing = keysByTable.get(table);

    keysByTable.set(table, existing ? [...existing, ...indexKeys] : [...indexKeys]);

    return keysByTable;
};

/**
 * Could the positions written in this batch have changed what `memo` read?
 *
 * Answers `true` on every form of uncertainty: a table the memo did not narrow
 * to ranges, a write whose position could not be derived, or an index the write
 * produced no key for. Only a table that was read exclusively through ranges
 * AND written exclusively at known positions outside them can be skipped.
 */
const writeTouchesMemo = (memo: SubscriptionReadFootprint, changed: Set<string>, changedKeys: ChangedKeys | undefined): boolean => {
    if (!changedKeys) {
        return true;
    }

    for (const table of changed) {
        if (!memo.tables.has(table)) {
            continue;
        }

        const ranges = memo.ranges?.get(table);

        // The memo read this table in some unnarrowable way — assume touched.
        if (!ranges || ranges.length === 0) {
            return true;
        }

        // `keysTouchRanges` treats an undefined/empty key list as touched, so an
        // unknown write position keeps the subscription re-running.
        if (keysTouchRanges(ranges, changedKeys.get(table))) {
            return true;
        }
    }

    return false;
};

export { mergeChangedKeys, recordChangedKeys, writeTouchesMemo };
export type { ChangedKeys, SubscriptionReadFootprint };
