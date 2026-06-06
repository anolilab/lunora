/**
 * Minimal line-level diff for `cirrus add --diff` previews. Not a full LCS —
 * it trims the common prefix/suffix and marks the differing middle as removed
 * (`-`) / added (`+`), with a few lines of surrounding context. That's enough
 * to preview what an install or upgrade would change before any file is written.
 */

/** Lines of leading/trailing context to show around a change. */
const CONTEXT = 3;

const splitLines = (text: string): string[] => (text === "" ? [] : text.split("\n"));

/**
 * Render a unified-ish diff between `oldText` and `newText` as an array of
 * display lines (`  ctx`, `- removed`, `+ added`). An empty array means the two
 * texts are identical.
 */
const renderDiff = (oldText: string, newText: string): string[] => {
    const a = splitLines(oldText);
    const b = splitLines(newText);

    // Common prefix.
    let start = 0;

    while (start < a.length && start < b.length && a[start] === b[start]) {
        start += 1;
    }

    // Common suffix (not overlapping the prefix).
    let endA = a.length;
    let endB = b.length;

    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }

    if (start === endA && start === endB) {
        return [];
    }

    const out: string[] = [];

    for (let k = Math.max(0, start - CONTEXT); k < start; k += 1) {
        out.push(`  ${a[k] ?? ""}`);
    }

    for (let k = start; k < endA; k += 1) {
        out.push(`- ${a[k] ?? ""}`);
    }

    for (let k = start; k < endB; k += 1) {
        out.push(`+ ${b[k] ?? ""}`);
    }

    for (let k = endB; k < Math.min(b.length, endB + CONTEXT); k += 1) {
        out.push(`  ${b[k] ?? ""}`);
    }

    return out;
};

export default renderDiff;
