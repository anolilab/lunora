/**
 * What a single query execution read, in the shape the refresh gate needs.
 *
 * Two channels feed it. `onReadRange` reports a read provably confined to one
 * contiguous index slice; `onRead` reports everything else — a row read by id,
 * or the `SCAN_DEP` sentinel for a read that could not be narrowed at all.
 *
 * The gate may only narrow a table when EVERY read of it was a range. That is
 * the correctness hinge, and it is why the two channels stay separate rather
 * than being folded into one string space:
 *
 * A `*scan` read depends on rows the slice does not name, so a write outside the
 * slice can still change the result. A by-id read is no better: the query
 * depends on that specific row, whose index position may sit outside every
 * recorded slice, so narrowing on the slices alone would skip an invalidation
 * the read needed.
 *
 * `ranges()` therefore returns a table's slices only when that table was read
 * exclusively through ranges, and omits it otherwise. An omitted table falls
 * back to whole-table matching, which is what the pre-range behaviour did.
 */

import type { KeyRange } from "./read-write-set";

interface ReadFootprint {
    /** Report a row-id or `SCAN_DEP` read — marks `table` unnarrowable. */
    onRead: (table: string, idOrScan?: string) => void;
    /** Report a read confined to `range`. */
    onReadRange: (range: KeyRange) => void;

    /**
     * Slices per table, for tables read ONLY through ranges. `undefined` when
     * nothing was narrowable, which lets callers skip the map entirely.
     */
    ranges: () => Map<string, KeyRange[]> | undefined;
    /** Every table touched, by either channel. */
    tables: Set<string>;
}

const createReadFootprint = (): ReadFootprint => {
    const tables = new Set<string>();
    const byTable = new Map<string, KeyRange[]>();
    const unnarrowable = new Set<string>();

    return {
        onRead(table) {
            tables.add(table);
            unnarrowable.add(table);
        },
        onReadRange(range) {
            tables.add(range.table);

            const existing = byTable.get(range.table);

            if (existing) {
                existing.push(range);
            } else {
                byTable.set(range.table, [range]);
            }
        },
        ranges() {
            for (const table of unnarrowable) {
                byTable.delete(table);
            }

            return byTable.size > 0 ? byTable : undefined;
        },
        tables,
    };
};

export { createReadFootprint };
export type { ReadFootprint };
