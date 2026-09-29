import { diffLines } from "diff";

/**
 * One rendered row of a unified diff: a line, what happened to it, and where it
 * sits. `before` is the 1-based line number in the original statement (absent on
 * an addition), `after` the same in the proposal (absent on a removal) — so the
 * pair is unique per row and gives the row an identity of its own.
 */
interface DiffLine {
    readonly after?: number;
    readonly before?: number;
    readonly kind: "added" | "context" | "removed";
    readonly text: string;
}

/** A change's `value` is its lines joined with (and usually ending in) `\n`. */
const splitLines = (value: string): string[] => (value.endsWith("\n") ? value.slice(0, -1) : value).split("\n");

/**
 * A line-level unified diff, for showing an AI rewrite before it is accepted.
 *
 * Myers' algorithm via `diff` (jsdiff), which already emits a replaced run as
 * all its removals ahead of all its additions rather than interleaving them line
 * by line — the difference between a diff that reads like a change and one that
 * reads like noise.
 *
 * `ignoreNewlineAtEof` because the model rarely preserves the operator's trailing
 * newline, and a statement whose only change is that newline should not show its
 * last line as removed and re-added.
 *
 * ponytail: no intra-line diff — a reworded line shows as one removal plus one
 * addition. Add word-level marking (`diffWords`) if statements start arriving on
 * one long line.
 */
const lineDiff = (before: string, after: string): DiffLine[] => {
    const lines: DiffLine[] = [];
    let beforeLine = 1;
    let afterLine = 1;

    for (const change of diffLines(before, after, { ignoreNewlineAtEof: true })) {
        for (const text of splitLines(change.value)) {
            if (change.added) {
                lines.push({ after: afterLine, kind: "added", text });
                afterLine += 1;
            } else if (change.removed) {
                lines.push({ before: beforeLine, kind: "removed", text });
                beforeLine += 1;
            } else {
                lines.push({ after: afterLine, before: beforeLine, kind: "context", text });
                beforeLine += 1;
                afterLine += 1;
            }
        }
    }

    return lines;
};

export { lineDiff };
export type { DiffLine };
