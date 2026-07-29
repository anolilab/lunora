import type { SqlDiagnostic } from "./sql-diagnostics";

/**
 * Editor-geometry values shared by the SQL textarea and its diagnostics overlay:
 * the text class the two must agree on character-for-character, and the span
 * splitter that turns diagnostics into underline runs.
 *
 * Their own module, away from `sql-diagnostics-ui.tsx`, because that file exports
 * React components: a module mixing components with plain values loses Fast
 * Refresh (React Doctor's `only-export-components`).
 */

/**
 * Typography the underline overlay MUST share with the editor textarea for the
 * squiggles to land under the right characters. Kept as one constant next to the
 * textarea's own class list (`sql-editor-panel.tsx`) so the two can't drift
 * silently — if you change padding, font, or leading in one, change both.
 */
const EDITOR_TEXT_CLASS = "p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-words";

/** Split points for one diagnostic's span, clamped into the draft. */
interface Span {
    readonly end: number;
    readonly severity: SqlDiagnostic["severity"];
    readonly start: number;
}

/**
 * Turn diagnostics into non-overlapping, ordered spans. Overlaps are resolved by
 * dropping the later span rather than nesting decorations — two wavy underlines
 * on the same characters read as one smear, and the problems row below carries
 * both messages anyway.
 *
 * The rejection test is against the last span actually KEPT, not the previous
 * element of the sorted input. Comparing against the neighbour lets a span slip
 * through that overlaps an earlier, wider one — e.g. A=[0,10], B=[5,6], C=[6,8]:
 * B is dropped, C passes because it clears B, and C still sits inside A. The
 * render loop would then emit `slice(6,8)` after the cursor had already advanced
 * to 10, duplicating characters and shifting every squiggle after that point out
 * of alignment with the textarea.
 */
const toSpans = (diagnostics: ReadonlyArray<SqlDiagnostic>, length: number): Span[] => {
    const spans: Span[] = [];

    for (const diagnostic of diagnostics) {
        if (diagnostic.offset === undefined || diagnostic.length === undefined || diagnostic.length <= 0) {
            continue;
        }

        const start = Math.max(0, Math.min(diagnostic.offset, length));
        const end = Math.max(start, Math.min(diagnostic.offset + diagnostic.length, length));

        if (start !== end) {
            spans.push({ end, severity: diagnostic.severity, start });
        }
    }

    spans.sort((a, b) => a.start - b.start);

    const kept: Span[] = [];

    for (const span of spans) {
        if (span.start >= (kept.at(-1)?.end ?? 0)) {
            kept.push(span);
        }
    }

    return kept;
};

export { EDITOR_TEXT_CLASS, toSpans };
export type { Span };
