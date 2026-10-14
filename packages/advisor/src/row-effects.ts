/**
 * A row-changing write an EXPORT can reach, directly or through the functions it
 * calls, possibly in another file. Produced by the codegen feeder; the sweep lints
 * read it to tell a function that removes rows from the one that only reads them.
 * Runtime callers don't supply it, so the lints then see no progress from helpers.
 */
export interface AdvisorRowEffect {
    /** The export the write is reachable from. */
    exportName: string;
    /** The fields a `patch` writes, or `undefined` when they cannot be read. */
    fields?: string[];
    /** Source file of that export, relative to the lunora dir, without extension. */
    file: string;
    /** The write method, e.g. `delete`, `patch`, `replace`. */
    method: string;
    /** The table the write targets. Never `""`. */
    table: string;
}
