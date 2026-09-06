/** One rendered row of a unified diff: a line, and what happened to it. */
interface DiffLine {
    readonly kind: "added" | "context" | "removed";
    readonly text: string;
}

/**
 * A line-level unified diff, for showing an AI rewrite before it is accepted.
 *
 * Hand-rolled rather than pulled from a package because the whole algorithm is
 * one LCS table and the input is a single SQL statement — the engine caps what
 * it rewrites at 2,000 characters, so the quadratic table is a few hundred cells
 * for a realistic statement and never grows without bound.
 *
 * The table is walked FORWARD from the origin (it is filled backwards, so
 * `table[i][j]` is the LCS of the two suffixes). That ordering is what keeps a
 * run of removals grouped ahead of the matching run of additions rather than
 * interleaved line by line, which is the difference between a diff that reads
 * like a change and one that reads like noise.
 *
 * ponytail: no intra-line diff — a reworded line shows as one removal plus one
 * addition. Add word-level marking if statements start arriving on one long line.
 */
const lineDiff = (before: string, after: string): DiffLine[] => {
    const from = before.split("\n");
    const to = after.split("\n");
    const width = to.length + 1;
    // Flat, not nested: one allocation, and the row stride is explicit at every
    // read rather than hidden behind a second index.
    const table = new Int32Array((from.length + 1) * width);
    /** LCS length of `from[i…]` against `to[j…]`. Out of range reads 0, which is the empty suffix. */
    const lcs = (i: number, index: number): number => table[i * width + index] ?? 0;

    for (let i = from.length - 1; i >= 0; i -= 1) {
        for (let index = to.length - 1; index >= 0; index -= 1) {
            table[i * width + index] = from[i] === to[index] ? lcs(i + 1, index + 1) + 1 : Math.max(lcs(i + 1, index), lcs(i, index + 1));
        }
    }

    const lines: DiffLine[] = [];
    let i = 0;
    let index = 0;

    while (i < from.length && index < to.length) {
        if (from[i] === to[index]) {
            lines.push({ kind: "context", text: from[i] ?? "" });
            i += 1;
            index += 1;
        } else if (lcs(i + 1, index) >= lcs(i, index + 1)) {
            lines.push({ kind: "removed", text: from[i] ?? "" });
            i += 1;
        } else {
            lines.push({ kind: "added", text: to[index] ?? "" });
            index += 1;
        }
    }

    for (; i < from.length; i += 1) {
        lines.push({ kind: "removed", text: from[i] ?? "" });
    }

    for (; index < to.length; index += 1) {
        lines.push({ kind: "added", text: to[index] ?? "" });
    }

    return lines;
};

export { lineDiff };
export type { DiffLine };
