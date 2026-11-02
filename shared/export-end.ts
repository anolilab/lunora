/**
 * The terminal frame every Lunora NDJSON export ends with.
 *
 * An export is a stream of `{ table, doc }` rows, and a response or file cut on a
 * row boundary is still valid NDJSON that parses as a smaller export. The last
 * line is therefore `{"end":true,"rows":N}`, N being the number of rows before it:
 * a reader that finds no frame, a count that differs from the rows it read, or
 * anything after the frame, knows it did not see the whole export.
 *
 * Shared by relative path (no runtime dependency edge): the runtime writes it, the
 * CLI and Studio read it.
 */

/** The frame line, newline-terminated like every row. */
export const exportEndLine = (rows: number): string => `${JSON.stringify({ end: true, rows })}\n`;

/**
 * The row count a parsed line declares when it is the terminal frame; `undefined`
 * for any other line. A frame whose count is not a non-negative integer is still a
 * frame (`NaN`), so it can never equal the number of rows read.
 */
export const exportEndRows = (parsed: unknown): number | undefined => {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
    }

    const candidate = parsed as { end?: unknown; rows?: unknown; table?: unknown };

    if (candidate.end !== true || candidate.table !== undefined) {
        return undefined;
    }

    return typeof candidate.rows === "number" && Number.isSafeInteger(candidate.rows) && candidate.rows >= 0 ? candidate.rows : Number.NaN;
};

/** Counts the rows of an export as they are read and says whether it ended properly. */
export const createExportEndTracker = (): {
    /** Feed each non-blank line's parsed JSON. Returns `true` for a row, `false` for the frame. Throws on a row after the frame. */
    read: (parsed: unknown) => boolean;
    /** The reason the export is incomplete, or `undefined` when a frame arrived and its count matches. */
    problem: () => string | undefined;
} => {
    let rows = 0;
    let declared: number | undefined;

    return {
        problem: () => {
            if (declared === undefined) {
                return 'the export has no end marker: it was written before exports carried an end marker, or it was cut short. If you have checked that the file is complete, append {"end":true,"rows":N} as its last line, N being its exact row count';
            }

            return declared === rows ? undefined : `the export's end marker declares ${String(declared)} row(s) but ${String(rows)} were read`;
        },
        read: (parsed) => {
            if (declared !== undefined) {
                throw new Error("the export continues after its end marker");
            }

            const end = exportEndRows(parsed);

            if (end === undefined) {
                rows += 1;

                return true;
            }

            declared = end;

            return false;
        },
    };
};
