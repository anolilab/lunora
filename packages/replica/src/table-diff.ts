/**
 * Row-level change kind within a TableDiff.
 *
 * Each change represents one row that was inserted, updated, or deleted on
 * the server since the last sync tick.
 * @experimental
 */
type RowChange =
    { data: Record<string, unknown>; type: "insert" } | { data: Record<string, unknown>; id: string; type: "update" } | { id: string; type: "delete" };

/**
 * A scoped, ordered set of row changes for a single table.
 *
 * `TableDiff` is the unit of replication between the server and the local
 * SQLite mirror. The server pushes diffs over the poke protocol; the
 * client applies them via `applyDiff`.
 * @experimental
 */
interface TableDiff {
    /** Ordered row changes — insert/update/delete, earliest first. */
    readonly changes: ReadonlyArray<RowChange>;
    /** Logical table name (matches the schema table name). */
    readonly table: string;
    /** Monotonic server timestamp (ms since epoch) when this diff was emitted. */
    readonly timestamp: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Create a {@link TableDiff} with a snapshot of the current time.
 * @experimental
 */
const createTableDiff = (table: string, changes: ReadonlyArray<RowChange>, timestamp?: number): TableDiff => {
    return {
        table,
        changes,
        timestamp: timestamp ?? Date.now(),
    };
};

/**
 * Return `true` when the diff contains no row changes.
 * @experimental
 */
const isDiffEmpty = (diff: TableDiff): boolean => diff.changes.length === 0;

/**
 * Return the number of rows touched by the diff (inserts + updates + deletes).
 * @experimental
 */
const diffSize = (diff: TableDiff): number => diff.changes.length;

/**
 * Partition a {@link TableDiff} into three categories for batch processing.
 * @experimental
 */
const classifyChanges = (diff: TableDiff): { deletes: RowChange[]; inserts: RowChange[]; updates: RowChange[] } => {
    const inserts: RowChange[] = [];
    const updates: RowChange[] = [];
    const deletes: RowChange[] = [];

    for (const change of diff.changes) {
        if (change.type === "insert") {
            inserts.push(change);
        } else if (change.type === "update") {
            updates.push(change);
        } else {
            deletes.push(change);
        }
    }

    return { inserts, updates, deletes };
};

/**
 * Merge several diffs for the same table into one (ordering preserved).
 *
 * Returns `null` when the input list is empty.
 * @experimental
 */
const mergeDiffs = (diffs: ReadonlyArray<TableDiff>): TableDiff | null => {
    if (diffs.length === 0) {
        // `null` is part of the public return contract for "nothing to merge".
        // eslint-disable-next-line unicorn/no-null
        return null;
    }

    const first = diffs[0] as TableDiff;
    const last = diffs[diffs.length - 1] as TableDiff;

    return createTableDiff(
        first.table,
        diffs.flatMap((d) => d.changes),
        last.timestamp,
    );
};

export { classifyChanges, createTableDiff, diffSize, isDiffEmpty, mergeDiffs };
export type { RowChange, TableDiff };
