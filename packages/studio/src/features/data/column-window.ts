/**
 * Pure column-geometry helpers for the data grid — the horizontal window and the
 * sticky offsets of the pinned columns.
 *
 * They live in their own module, away from `data-browser-grid.tsx`, because that
 * file exports React components: a module that mixes components with plain
 * values loses Fast Refresh (React Doctor's `only-export-components`), and these
 * are the two things the grid's tests exercise directly.
 */

/** A windowed slice of the columns: what to render, and the spacer widths standing in for the rest. */
interface ColumnWindow {
    /** Column ids to render, in order — the on-screen run plus every pinned column. */
    readonly ids: ReadonlySet<string>;
    /** Width (px) of the skipped columns before the window. */
    readonly leadPx: number;
    /** Width (px) of the skipped columns after the window. */
    readonly tailPx: number;
}

/**
 * Choose which columns to actually mount for a horizontal scroll position.
 *
 * A 200-column table previously mounted every cell of every visible row — the
 * row virtualizer bounded the vertical axis only, so the horizontal one grew
 * without limit. This windows it: columns whose span intersects
 * `[scrollLeft - overscan, scrollLeft + viewport + overscan)` render, the rest
 * collapse into two spacer cells that preserve total width (so the scrollbar and
 * column alignment are unchanged).
 *
 * Pinned columns are ALWAYS in the window regardless of scroll — they are
 * `position: sticky` and would otherwise vanish the moment they scrolled out of
 * their own span. Their width is excluded from the spacers for the same reason.
 *
 * A zero viewport (jsdom, first paint before measurement) yields every column,
 * so tests and the first frame are never blank.
 */
const columnWindow = (
    columns: ReadonlyArray<{ getSize: () => number; id: string }>,
    pinnedIds: ReadonlySet<string>,
    scrollLeft: number,
    viewportPx: number,
    overscanPx = 300,
): ColumnWindow => {
    if (viewportPx <= 0) {
        return { ids: new Set(columns.map((column) => column.id)), leadPx: 0, tailPx: 0 };
    }

    const from = scrollLeft - overscanPx;
    const to = scrollLeft + viewportPx + overscanPx;
    const ids = new Set<string>();
    let cursor = 0;
    let leadPx = 0;
    let tailPx = 0;

    for (const column of columns) {
        const width = column.getSize();
        const pinned = pinnedIds.has(column.id);
        const visible = cursor + width > from && cursor < to;

        if (pinned || visible) {
            ids.add(column.id);
        } else if (cursor < from) {
            leadPx += width;
        } else {
            tailPx += width;
        }

        cursor += width;
    }

    return { ids, leadPx, tailPx };
};

/**
 * Left offset (in px) for each pinned column, keyed by column id — the summed
 * width of the pinned columns before it. Computed from the VISIBLE order so
 * hiding a pinned column shifts the rest rather than leaving a gap.
 */
const pinnedOffsets = (columns: ReadonlyArray<{ getSize: () => number; id: string }>, pinnedIds: ReadonlySet<string>): Map<string, number> => {
    const offsets = new Map<string, number>();
    let running = 0;

    for (const column of columns) {
        if (pinnedIds.has(column.id)) {
            offsets.set(column.id, running);
            running += column.getSize();
        }
    }

    return offsets;
};

export { columnWindow, pinnedOffsets };
export type { ColumnWindow };
