import { randomId } from "../../../shared/uuid";
import { fnv1a64Hex } from "./apply-diff";

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

    /**
     * Optional stable identity for this diff, distinct from `timestamp`
     * (multiple diffs can legitimately share a millisecond, so `timestamp`
     * alone is not a unique diff identity). `createTableDiff` auto-generates
     * one when omitted.
     *
     * **Nothing in the apply path reads it.** `deriveInsertId` (`apply-diff.ts`)
     * keys an id-less insert off the ROW'S OWN content — hashing the diff id
     * into it is what made `subscribeToMirror`'s per-frame re-emission mint a
     * fresh row every second, so that derivation is gone. This field is
     * carried for consumers that want to recognise a diff they have seen.
     */
    readonly id?: string;
    /** Logical table name (matches the schema table name). */
    readonly table: string;
    /** Monotonic server timestamp (ms since epoch) when this diff was emitted. */
    readonly timestamp: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Create a {@link TableDiff} with a snapshot of the current time and a
 * fresh stable `id` (unless one is explicitly provided).
 * @experimental
 */
const createTableDiff = (table: string, changes: ReadonlyArray<RowChange>, timestamp?: number, id?: string): TableDiff => {
    return {
        table,
        changes,
        timestamp: timestamp ?? Date.now(),
        // Guarded generator (`shared/uuid.ts`): a bare `crypto.randomUUID()`
        // throws on non-secure origins like a `http://192.168.x.x` LAN
        // dev/preview server — the common local-first testing setup — because
        // `crypto.randomUUID` is undefined there. The id only needs per-process
        // uniqueness for `deriveInsertId`.
        id: id ?? randomId(),
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

    // Derive the merged diff's identity deterministically from its ordered
    // children's identities (each child's `id`, or its `timestamp` as a
    // fallback): merging the SAME sequence of diffs always mints the SAME merged
    // id. The converse is NOT promised — `id` is optional and two children can
    // share a `timestamp`, so distinct sequences can hash the same input, and a
    // 64-bit digest collides regardless. Nothing in this repo reads it — the
    // apply path keys id-less inserts off row content — so this is a property of
    // the public `id` field for consumers that dedupe on it, not an input to
    // anything downstream.
    //
    // The joined child identities are hashed to a constant-size 16-hex digest
    // rather than embedded verbatim, so merging an already-merged diff cannot
    // compound the prefix (`merge:merge:…`) into an O(N) string.
    const mergedId = `merge:${fnv1a64Hex(diffs.map((d) => d.id ?? String(d.timestamp)).join("|"))}`;

    return createTableDiff(
        first.table,
        diffs.flatMap((d) => d.changes),
        last.timestamp,
        mergedId,
    );
};

export { classifyChanges, createTableDiff, diffSize, isDiffEmpty, mergeDiffs };
export type { RowChange, TableDiff };
