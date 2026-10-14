/**
 * Search-hit segmentation for a rendered cell.
 *
 * Its own module, away from `data-grid.tsx`, because that file exports React
 * components: a module mixing components with plain values loses Fast Refresh
 * (React Doctor's `only-export-components`). Pure, so it is unit-testable
 * without a DOM.
 */

/** One run of a cell's rendered text, flagged as a search hit or not. */
interface HighlightSegment {
    readonly match: boolean;
    /** Start index of this run in the original text — a stable React key. */
    readonly offset: number;
    readonly text: string;
}

/**
 * Split `text` into alternating non-match / match runs against a
 * case-insensitive `needle`.
 *
 * Turns "these rows matched" into "these rows matched HERE", which on a wide
 * table is the difference between a result set you can scan and one you have to
 * read. Pure and exported so the segmentation is unit-testable without a DOM.
 */
const highlightSegments = (text: string, needle: string): HighlightSegment[] => {
    if (needle === "") {
        return [{ match: false, offset: 0, text }];
    }

    const segments: HighlightSegment[] = [];
    const haystack = text.toLowerCase();
    const lowered = needle.toLowerCase();
    let cursor = 0;

    for (let at = haystack.indexOf(lowered); at !== -1; at = haystack.indexOf(lowered, cursor)) {
        if (at > cursor) {
            segments.push({ match: false, offset: cursor, text: text.slice(cursor, at) });
        }

        segments.push({ match: true, offset: at, text: text.slice(at, at + needle.length) });
        cursor = at + needle.length;
    }

    if (cursor < text.length) {
        segments.push({ match: false, offset: cursor, text: text.slice(cursor) });
    }

    return segments;
};

export { highlightSegments };
export type { HighlightSegment };
