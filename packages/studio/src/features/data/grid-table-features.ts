import {
    columnOrderingFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    createSortedRowModel,
    rowSelectionFeature,
    rowSortingFeature,
    sortFn_alphanumeric,
    sortFn_basic,
    sortFn_datetime,
    sortFn_text,
    tableFeatures,
} from "@tanstack/react-table";

/**
 * The TanStack Table feature set the data browser grid runs on.
 *
 * v9 has no implicit feature set: a table only carries the APIs whose features
 * it registers here, and both the runtime methods and the types are derived from
 * this object. Registering less than the grid uses is a type error at the call
 * site, not a silent no-op — so this list is exactly the grid's surface:
 *
 * - `columnOrderingFeature` — drag-to-reorder (`table.setColumnOrder`).
 * - `columnResizingFeature` — drag-to-resize (`header.getResizeHandler`).
 * - `columnSizingFeature` — the widths resizing writes (`header.getSize`).
 * - `columnVisibilityFeature` — the column toggle menu.
 * - `rowSelectionFeature` — the select-all header cell and per-row checkboxes.
 * - `rowSortingFeature` — the sortable headers.
 *
 * `sortedRowModel` and `sortFns` are the row model and comparator registry that
 * `rowSortingFeature` needs; in v8 these arrived as the `getSortedRowModel()`
 * table option. Sorting here is `manualSorting`, so the model never reorders the
 * page — but the feature still requires it to resolve a column's sort state.
 *
 * The four comparators are named individually rather than taken from the
 * `sortFns` barrel, which v9 deprecates in favour of importing what you use.
 * They are exactly what `sortFn: 'auto'` can resolve to — `datetime` for
 * date-like values, `alphanumeric` for mixed text/numeric strings, `text` for
 * plain strings, `basic` as the fallback — so dropping any of them would make
 * `'auto'` silently fall through to `basic` for that column type.
 *
 * Deliberately absent: filtering, pagination, grouping, aggregation, expanding,
 * faceting and pinning. The data browser pages and filters server-side, so
 * registering them would ship dead code and widen every `Table`/`Row`/`Cell`
 * type in the grid for APIs nothing calls.
 */
export const gridTableFeatures = tableFeatures({
    columnOrderingFeature,
    columnResizingFeature,
    columnSizingFeature,
    columnVisibilityFeature,
    rowSelectionFeature,
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
    sortFns: {
        alphanumeric: sortFn_alphanumeric,
        basic: sortFn_basic,
        datetime: sortFn_datetime,
        text: sortFn_text,
    },
});

/**
 * The feature set as a type. Every v9 table type takes it as the first
 * parameter — `Table<GridTableFeatures, TableRow>`, `Row<GridTableFeatures, T>`
 * — which is what ties an annotation to the APIs actually registered above.
 */
export type GridTableFeatures = typeof gridTableFeatures;
