/**
 * Marks an error raised after a write's base row had already committed.
 *
 * An insert or replace writes the row first, then its companion rows (aggregate, rank, change log, search) and
 * its triggers. A failure in that tail leaves the row stored, yet reaches the caller as the same kind of error a
 * failed base write throws; a unique violation from a trigger's own write reads exactly like the row's `_id`
 * already being taken. The mark lets a caller that replays rows (the admin import) tell the two apart without
 * changing the error's class, code or message.
 *
 * Keyed by the error object, so the table and id say which row committed: an error that a nested write marked and
 * that then escapes the outer row's pre-commit trigger describes the nested row, not the outer one.
 */

interface CommittedRow {
    id: string;
    table: string;
}

const committed = new WeakMap<object, CommittedRow>();

/** Run `work`, the tail of a write whose base row for (`table`, `id`) already committed, marking whatever it throws. */
const afterBaseRowCommitted = async <T>(table: string, id: string, work: () => Promise<T>): Promise<T> => {
    try {
        return await work();
    } catch (error: unknown) {
        // A thrown primitive or bare object is wrapped so the mark has an `Error` to sit on; the original rides along as `cause`.
        const marked = error instanceof Error ? error : new Error(String(error), { cause: error });

        committed.set(marked, { id, table });

        throw marked;
    }
};

/** Whether `error` came out of the post-commit tail of a write to this `id` in `table`. */
const isPostCommitError = (error: unknown, table: string, id: string): boolean => {
    const row = typeof error === "object" && error !== null ? committed.get(error) : undefined;

    return row?.table === table && row.id === id;
};

export { afterBaseRowCommitted, isPostCommitError };
