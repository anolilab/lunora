/**
 * Marks an error raised after a write's base row had already committed.
 *
 * An insert or replace writes the row first, then its companion rows (aggregate, rank, change log, search) and
 * its triggers. A failure in that tail leaves the row stored, yet reaches the caller as the same kind of error a
 * failed base write throws; a unique violation from a trigger's own write reads exactly like the row's `_id`
 * already being taken. The mark lets a caller that replays rows (the admin import) tell the two apart without
 * changing the error's class, code or message.
 *
 * Keyed by the error object, and it records every row it escaped after: an error that a nested write marked and
 * that then escapes the outer row's pre-commit trigger names the nested row, not the outer one, and a trigger that
 * throws one shared error object from two overlapping writes leaves both rows marked rather than the last one.
 */

// Table names are SQL identifiers and ids are generated strings; neither holds a NUL, so the pair keys exactly.
const rowKey = (table: string, id: string): string => `${table}\u0000${id}`;

const committed = new WeakMap<object, Set<string>>();

/** Run `work`, the tail of a write whose base row for (`table`, `id`) already committed, marking whatever it throws. */
const afterBaseRowCommitted = async <T>(table: string, id: string, work: () => Promise<T>): Promise<T> => {
    try {
        return await work();
    } catch (error: unknown) {
        // A thrown primitive cannot carry a mark, so it is wrapped; any object (an `Error` or a bare `{ code, message }`)
        // is marked and rethrown as is, keeping its code and message.
        const marked = typeof error === "object" && error !== null ? error : new Error(String(error), { cause: error });

        const rows = committed.get(marked) ?? new Set<string>();

        rows.add(rowKey(table, id));
        committed.set(marked, rows);

        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a trigger may throw a non-Error object; its identity is the mark, so it is rethrown unwrapped
        throw marked;
    }
};

/**
 * Whether `error` came out of the post-commit tail of a write to this `id` in `table`, consuming the mark.
 *
 * A trigger may throw one shared error object from many writes, so a mark left in place would vouch for a later
 * write of the same row that failed BEFORE its row committed. Reading it once, right after the write that raised
 * it, means a mark only ever answers for that write.
 */
const takePostCommitError = (error: unknown, table: string, id: string): boolean => {
    const rows = typeof error === "object" && error !== null ? committed.get(error) : undefined;

    return rows?.delete(rowKey(table, id)) === true;
};

export { afterBaseRowCommitted, takePostCommitError };
