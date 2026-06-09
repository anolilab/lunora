import type { Cell, ColumnDef, Header, OnChangeFn, Row, SortingState, Table } from "@tanstack/react-table";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TablePage } from "./admin";
import { ConfirmButton } from "./confirm-button";
import { CellValue, GridContainer } from "./data-grid";
import { formatCell } from "./internal";
import type { StagedEditsModel } from "./staged-edits";
import { coerceCellValue } from "./staged-edits";

/**
 * Fallback viewport height (px) for the virtual list. The grid now fills its flex
 * parent, so the real viewport height is read from the scroll element at runtime;
 * this value seeds the first paint and is the height jsdom reports (it measures
 * every element as 0×0, so the virtualizer would otherwise render no rows).
 */
const SCROLL_HEIGHT = 400;
/** Estimated height of a single row, in px — used to size the virtual list. */
const ROW_HEIGHT = 36;

/**
 * Static styles, hoisted so they aren't reallocated (and re-flagged) per render.
 * The scroll viewport flexes to fill the full-height grid container and owns both
 * axes of scrolling (rows vertically, wide tables horizontally).
 */
const SCROLL_STYLE: CSSProperties = { flex: "1 1 0%", minHeight: 0, overflow: "auto", position: "relative" };
const ROWS_STYLE: CSSProperties = { width: "100%" };
// Virtualized rows are taken out of table flow (absolute + translateY), so the
// row lays its cells out with flexbox rather than table-cell sizing — otherwise
// the `<td>`s collapse onto each other. The header row shares the same flex
// model so columns stay aligned.
const ROW_BASE_STYLE: CSSProperties = { alignItems: "center", display: "flex", left: 0, position: "absolute", top: 0, width: "100%" };
const HEAD_ROW_STYLE: CSSProperties = { display: "flex", width: "100%" };
const ACTION_CELL_STYLE: CSSProperties = { flex: "0 0 8.5rem", padding: "0.375rem 0.75rem" };

/** A grid cell/header sized to its column's current width (drag-to-resize), out of flex flow. */
const sizedCellStyle = (width: number): CSSProperties => {
    return {
        flex: "0 0 auto",
        overflow: "hidden",
        padding: "0.375rem 0.75rem",
        position: "relative",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        width: `${width.toString()}px`,
    };
};

/** Borderless per-row action button (Details / Edit / Delete). */
const ROW_BTN =
    "rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

/** A loaded row keyed by column name. */
type TableRow = Record<string, unknown>;

/**
 * The primary key of a row. Shard tables store it in the `id` column; the
 * `__id__` / `_id` fallbacks cover the column aliases other layers expose.
 * Returns `null` when no id-like column is present (an uneditable row).
 */
const rowId = (row: TableRow): null | string => {
    for (const key of ["id", "__id__", "_id"]) {
        const value = row[key];

        if (typeof value === "string" || typeof value === "number") {
            return String(value);
        }
    }

    return null;
};

/**
 * A stable React key for a row. Cirrus tables always carry a primary key, so
 * prefer it; the positional fallback only applies to the rare idless page and is
 * hidden behind this helper so it isn't an inline array-index key.
 */
const rowKey = (row: TableRow, index: number): string => rowId(row) ?? `row-${index.toString()}`;

/**
 * Renders a foreign-key cell as a link to the target table. Extracted to module
 * scope so the column-def `cell` renderer stays a flat callback instead of
 * nesting another arrow for the click handler.
 */
const RefCell = ({
    column,
    id,
    onNavigate,
    target,
}: {
    column: string;
    id: string;
    onNavigate: (target: string, id: string) => void;
    target: string;
}): ReactElement => {
    const onClick = useCallback((): void => {
        onNavigate(target, id);
    }, [onNavigate, target, id]);

    return (
        <button data-testid={`db-ref-${column}`} onClick={onClick} title={`Open ${target} ${id}`} type="button">
            {id} ↗
        </button>
    );
};

/** The header glyph for a column given react-table's sort state: ` ▲`, ` ▼`, or empty. */
const sortIndicator = (sorted: "asc" | "desc" | false): string => {
    if (sorted === "asc") {
        return " ▲";
    }

    if (sorted === "desc") {
        return " ▼";
    }

    return "";
};

/**
 * Inline-edit wiring threaded into every grid cell: whether editing is enabled,
 * which columns accept it, the cell currently open for editing, the staged-edit
 * buffer, and the foreign-key context (so ref cells still render as links). Built
 * by `DataBrowser` and passed down to {@link EditableCell}.
 */
interface GridEdit {
    cancelEdit: () => void;
    editable: boolean;
    editableColumn: (column: string) => boolean;
    editingCell: null | { column: string; rowId: string };
    onNavigateRef: (target: string, id: string) => void;
    refs: Record<string, string> | undefined;
    stage: StagedEditsModel["stage"];
    stagedValue: StagedEditsModel["stagedValue"];
    startEdit: (rowId: string, column: string) => void;
}

/**
 * The text input shown while a cell is being edited. Commits on Enter or blur
 * (staging the typed value) and cancels on Escape; focuses itself on mount via a
 * ref (the a11y-friendly stand-in for `autoFocus`).
 */
const CellEditor = ({
    column,
    initial,
    onCancel,
    onCommit,
    recordId,
}: {
    column: string;
    initial: unknown;
    onCancel: () => void;
    onCommit: (raw: string) => void;
    recordId: string;
}): ReactElement => {
    const ref = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        ref.current?.select();
    }, []);

    const onKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>): void => {
            if (event.key === "Enter") {
                event.preventDefault();
                onCommit(event.currentTarget.value);
            } else if (event.key === "Escape") {
                event.preventDefault();
                onCancel();
            }
        },
        [onCommit, onCancel],
    );

    const onBlur = useCallback(
        (event: React.FocusEvent<HTMLInputElement>): void => {
            onCommit(event.currentTarget.value);
        },
        [onCommit],
    );

    return (
        <input
            className="w-full rounded border border-ring bg-background px-1 py-0.5 font-mono text-xs outline-none"
            data-testid={`db-cell-input-${recordId}-${column}`}
            defaultValue={formatCell(initial)}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            ref={ref}
        />
    );
};

/**
 * One grid body cell. Foreign-key columns render as a navigable {@link RefCell};
 * an idless row's cells are read-only text; otherwise the cell shows its value
 * (the staged value, highlighted, when one is pending) and — when the browser is
 * editable and the column isn't a meta column — double-click opens an inline
 * {@link CellEditor} that stages the change.
 */
const EditableCell = ({ cell, edit }: { cell: Cell<TableRow, unknown>; edit: GridEdit }): ReactElement => {
    const column = cell.column.id;
    const rawValue = cell.getValue();
    const id = rowId(cell.row.original);
    const target = edit.refs?.[column];

    if (target !== undefined && (typeof rawValue === "string" || typeof rawValue === "number") && String(rawValue) !== "") {
        return <RefCell column={column} id={String(rawValue)} onNavigate={edit.onNavigateRef} target={target} />;
    }

    // An idless row can't be addressed for a patch, so its cells are read-only.
    // Returning early also narrows `id` to a string for the editable path below.
    if (id === null) {
        return <CellValue value={rawValue} />;
    }

    const staged = edit.stagedValue(id, column);
    const display = staged === undefined ? rawValue : staged.value;
    const canEdit = edit.editable && edit.editableColumn(column);
    const isEditing = edit.editingCell !== null && edit.editingCell.rowId === id && edit.editingCell.column === column;

    if (isEditing) {
        return (
            <CellEditor
                column={column}
                initial={display}
                onCancel={edit.cancelEdit}
                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-cell commit closes over the row id + raw value; admin dev-tool render path
                onCommit={(raw) => {
                    edit.stage(id, column, coerceCellValue(raw, rawValue));
                    edit.cancelEdit();
                }}
                recordId={id}
            />
        );
    }

    let cellClass: string | undefined;

    if (staged !== undefined) {
        cellClass = "rounded bg-amber-500/15 px-1";
    } else if (canEdit) {
        cellClass = "cursor-text";
    }

    const onDoubleClick = canEdit
        ? (): void => {
              edit.startEdit(id, column);
          }
        : undefined;

    return (
        <span className={cellClass} data-testid={`db-cell-${id}-${column}`} onDoubleClick={onDoubleClick}>
            <CellValue value={display} />
        </span>
    );
};

/**
 * One grid column header: the sort toggle, a drag handle for reordering (native
 * HTML5 drag → `table.setColumnOrder`), and a right-edge resize grip wired to
 * TanStack's resize handler. `draggedRef` carries the column id being dragged
 * between the source's `dragstart` and the target's `drop`.
 */
const GridHeaderCell = ({
    draggedRef,
    header,
    table,
}: {
    draggedRef: React.RefObject<null | string>;
    header: Header<TableRow, unknown>;
    table: Table<TableRow>;
}): ReactElement => {
    const onDragStart = useCallback((): void => {
        // eslint-disable-next-line no-param-reassign -- a ref's `.current` is mutable by design; it carries the drag source across handlers
        draggedRef.current = header.column.id;
    }, [draggedRef, header.column.id]);

    const onDragOver = useCallback((event: React.DragEvent<HTMLTableCellElement>): void => {
        event.preventDefault();
    }, []);

    const onDrop = useCallback((): void => {
        const from = draggedRef.current;
        const to = header.column.id;

        // eslint-disable-next-line no-param-reassign -- clearing the drag ref after the drop; refs are mutable by design
        draggedRef.current = null;

        if (from === null || from === to) {
            return;
        }

        // TanStack's columnOrder starts empty (default order); seed from the live
        // leaf columns so "drop before target" places `from` correctly on the first drag.
        const current = table.getState().columnOrder;
        const base = current.length > 0 ? current : table.getAllLeafColumns().map((column) => column.id);
        const order = base.filter((id) => id !== from);
        const insertAt = order.indexOf(to);

        order.splice(insertAt === -1 ? order.length : insertAt, 0, from);
        table.setColumnOrder(order);
    }, [draggedRef, header.column.id, table]);

    return (
        <th
            className="text-start text-xs font-medium text-muted-foreground"
            draggable
            onDragOver={onDragOver}
            onDragStart={onDragStart}
            onDrop={onDrop}
            style={sizedCellStyle(header.getSize())}
        >
            <button
                className="inline-flex max-w-full cursor-grab items-center gap-1 truncate outline-none hover:text-foreground"
                data-testid={`db-sort-${header.column.id}`}
                onClick={header.column.getToggleSortingHandler()}
                type="button"
            >
                {flexRender(header.column.columnDef.header, header.getContext())}
                {sortIndicator(header.column.getIsSorted())}
            </button>
            <span
                aria-hidden="true"
                className="absolute inset-y-0 end-0 w-1 cursor-col-resize touch-none select-none hover:bg-ring/60 data-[resizing=true]:bg-ring"
                data-resizing={header.column.getIsResizing()}
                data-testid={`db-resize-${header.column.id}`}
                onMouseDown={header.getResizeHandler()}
                onTouchStart={header.getResizeHandler()}
            />
        </th>
    );
};

/**
 * The virtualized table: a sortable, resizable, reorderable header derived from
 * react-table's flat headers, plus the windowed rows positioned absolutely inside
 * a full-height tbody. All model state (`table`, `tableRows`, `virtualRows`,
 * `tbodyStyle`, `scrollRef`) is owned by the parent; edit/delete are surfaced as
 * callbacks so this stays a pure render of the page's rows.
 */
const DataBrowserTableView = ({
    edit,
    editable,
    onDelete,
    onEdit,
    onInspect,
    scrollRef,
    scrollToIndex,
    table,
    tableRows,
    tbodyStyle,
    virtualRows,
}: {
    edit: GridEdit;
    editable: boolean;
    onDelete: (id: null | string) => void;
    onEdit: (id: null | string, original: TableRow) => void;
    onInspect: (original: TableRow) => void;
    scrollRef: React.RefObject<HTMLDivElement | null>;
    scrollToIndex: (index: number) => void;
    table: Table<TableRow>;
    tableRows: Row<TableRow>[];
    tbodyStyle: CSSProperties;
    virtualRows: { index: number; size: number; start: number }[];
}): ReactElement => {
    // Carries the column id being dragged between a header's dragstart and the
    // drop target's drop, for reordering.
    const draggedColumn = useRef<null | string>(null);

    // The keyboard-focused cell (row index + visible-column index). Arrow keys
    // move it; Enter opens the inline editor for an editable cell.
    const [active, setActive] = useState<null | { col: number; row: number }>(null);
    const columnCount = table.getVisibleLeafColumns().length;

    const onGridKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>): void => {
            if (!["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Enter"].includes(event.key)) {
                return;
            }

            event.preventDefault();
            const current = active ?? { col: 0, row: 0 };

            if (event.key === "Enter") {
                const row = tableRows[current.row];
                const column = table.getVisibleLeafColumns()[current.col];

                if (row !== undefined && column !== undefined) {
                    const id = rowId(row.original);

                    if (id !== null && edit.editableColumn(column.id)) {
                        edit.startEdit(id, column.id);
                    }
                }

                setActive(current);

                return;
            }

            let { col, row } = current;

            switch (event.key) {
                case "ArrowDown": {
                    row = Math.min(row + 1, tableRows.length - 1);

                    break;
                }
                case "ArrowRight": {
                    col = Math.min(col + 1, columnCount - 1);

                    break;
                }
                case "ArrowUp": {
                    row = Math.max(row - 1, 0);

                    break;
                }
                default: {
                    // ArrowLeft
                    col = Math.max(col - 1, 0);

                    break;
                }
            }

            setActive({ col, row });
        },
        [active, columnCount, edit, table, tableRows],
    );

    // Keep the focused row in view as it moves past the virtual window's edge.
    useEffect(() => {
        if (active !== null) {
            scrollToIndex(active.row);
        }
    }, [active, scrollToIndex]);

    const renderRow = (virtualRow: { index: number; size: number; start: number }): ReactElement => {
        const tableRow = tableRows[virtualRow.index] as Row<TableRow>;
        const { original } = tableRow;
        const id = rowId(original);
        const key = rowKey(original, virtualRow.index);
        // Per-row absolute offset from the virtualizer; necessarily a fresh object
        // each render since `start`/`size` change as the window scrolls.
        // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- dynamic virtualizer offset
        const rowStyle: CSSProperties = {
            ...ROW_BASE_STYLE,
            height: `${virtualRow.size.toString()}px`,
            transform: `translateY(${virtualRow.start.toString()}px)`,
        };

        return (
            <tr className="border-b border-border text-xs transition-colors hover:bg-muted/50" data-testid="db-row" key={tableRow.id} style={rowStyle}>
                {tableRow.getVisibleCells().map((cell, colIndex) => (
                    <td
                        className={`truncate font-mono text-muted-foreground${active !== null && active.row === virtualRow.index && active.col === colIndex ? " ring-1 ring-ring ring-inset" : ""}`}
                        key={cell.id}
                        style={sizedCellStyle(cell.column.getSize())}
                    >
                        <EditableCell cell={cell} edit={edit} />
                    </td>
                ))}
                <td className="flex items-center gap-1" style={ACTION_CELL_STYLE}>
                    <button
                        className={ROW_BTN}
                        data-testid={`db-inspect-${key}`}
                        // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler closes over the original row; admin dev-tool render path
                        onClick={() => {
                            onInspect(original);
                        }}
                        type="button"
                    >
                        Details
                    </button>
                    {editable && (
                        <>
                            <button
                                className={ROW_BTN}
                                data-testid={`db-edit-${key}`}
                                disabled={id === null}
                                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler closes over the original row; admin dev-tool render path
                                onClick={() => {
                                    onEdit(id, original);
                                }}
                                type="button"
                            >
                                Edit
                            </button>
                            <ConfirmButton
                                confirmLabel="Delete?"
                                disabled={id === null}
                                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler closes over the row id; admin dev-tool render path
                                onConfirm={() => {
                                    onDelete(id);
                                }}
                                testId={`db-delete-${key}`}
                            >
                                Delete
                            </ConfirmButton>
                        </>
                    )}
                </td>
            </tr>
        );
    };

    return (
        <GridContainer fill>
            <div data-testid="db-scroll" onKeyDown={onGridKeyDown} ref={scrollRef} role="grid" style={SCROLL_STYLE} tabIndex={0}>
                <table className="w-full text-xs" data-testid="db-rows" style={ROWS_STYLE}>
                    <thead className="bg-muted/50">
                        <tr className="border-b border-border" style={HEAD_ROW_STYLE}>
                            {table.getFlatHeaders().map((header) => (
                                <GridHeaderCell draggedRef={draggedColumn} header={header} key={header.id} table={table} />
                            ))}
                            <th aria-label="Row actions" style={ACTION_CELL_STYLE} />
                        </tr>
                    </thead>
                    <tbody style={tbodyStyle}>{virtualRows.map((virtualRow) => renderRow(virtualRow))}</tbody>
                </table>
            </div>
        </GridContainer>
    );
};

/** What {@link useDataBrowserTable} hands back to the component. */
interface DataBrowserTableModel {
    scrollRef: React.RefObject<HTMLDivElement | null>;
    scrollToIndex: (index: number) => void;
    table: Table<TableRow>;
    tableRows: Row<TableRow>[];
    tbodyStyle: CSSProperties;
    virtualRows: { index: number; size: number; start: number }[];
}

/**
 * The headless table model + virtualizer for the loaded page. Column defs derive
 * from `page.columns`; the page-local `sorting` runs over the loaded rows, and
 * the rendered rows are virtualized so a large page never inflates the DOM.
 * Column order (drag-to-reorder) and sizing (drag-to-resize) are managed
 * internally by TanStack; the `sorting` state stays owned by the caller.
 */
const useDataBrowserTable = (page: TablePage | null, sorting: SortingState, onSortingChange: OnChangeFn<SortingState>): DataBrowserTableModel => {
    const columns = page?.columns;
    const rows = page?.rows;
    const references = page?.refs;

    // Column defs are derived from the loaded page. Each accessor reads the
    // column by name off the ORIGINAL row object; the cell renderer reuses
    // `formatCell` so the markup matches the JSON view's text. Foreign-key
    // columns (in `refs`) render their value as a link to the target table.
    const columnDefs = useMemo<ColumnDef<TableRow>[]>(() => {
        if (columns === undefined) {
            return [];
        }

        // No `cell` renderer: every body cell is rendered by EditableCell (see
        // renderRow), which owns the foreign-key/value/edit branching. The column
        // def only needs the accessor (for sorting), the header, and the id.
        return columns.map((column) => {
            return {
                accessorFn: (row: TableRow) => row[column],
                header: references?.[column] === undefined ? column : `${column} →`,
                id: column,
            };
        });
    }, [columns, references]);

    const data = useMemo<TableRow[]>(() => rows ?? [], [rows]);

    // Search is server-side (see the debounced `search` effect); the table model
    // owns page-local sorting over the already-filtered page. Column order
    // (drag-to-reorder) and sizing (drag-to-resize) are managed internally by
    // TanStack — a stale order referencing a previous table's columns is simply
    // ignored, so the columns fall back to default order on a fresh table.
    const table = useReactTable<TableRow>({
        columnResizeMode: "onChange",
        columns: columnDefs,
        data,
        defaultColumn: { minSize: 80, size: 200 },
        enableColumnResizing: true,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onSortingChange,
        state: { sorting },
    });

    // The post-sort/filter rows for this page. We keep react-table's `Row`
    // wrappers so edit/delete can resolve the ORIGINAL row via `row.original`,
    // never a sorted/filtered copy.
    const tableRows = table.getRowModel().rows;

    const scrollRef = useRef<HTMLDivElement | null>(null);

    // Virtualize the rendered rows. The viewport is a fixed `SCROLL_HEIGHT` tall,
    // so we report that height to the virtualizer directly instead of measuring
    // the DOM. This keeps the window deterministic and, crucially, works under
    // jsdom — which reports every `getBoundingClientRect` as 0×0, so the default
    // `observeElementRect` would size the viewport to 0 and render no rows.
    // We still observe width changes (height is pinned) and seed the same rect
    // on first paint via `initialRect`. overscan keeps a few off-screen rows.
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
        count: tableRows.length,
        estimateSize: () => ROW_HEIGHT,
        getScrollElement: () => scrollRef.current,
        initialRect: { height: SCROLL_HEIGHT, width: 0 },
        observeElementRect: (instance, callback) => {
            const element = instance.scrollElement;

            const report = (): void => {
                // Real viewport height when the element is laid out; SCROLL_HEIGHT
                // under jsdom (clientHeight 0) so tests still render rows.
                callback({ height: (element?.clientHeight ?? 0) || SCROLL_HEIGHT, width: element?.clientWidth ?? 0 });
            };

            report();

            if (element === null || typeof ResizeObserver === "undefined") {
                return undefined;
            }

            const observer = new ResizeObserver(report);

            observer.observe(element);

            return () => {
                observer.disconnect();
            };
        },
        overscan: 8,
    });

    const scrollToIndex = useCallback(
        (index: number): void => {
            virtualizer.scrollToIndex(index);
        },
        [virtualizer],
    );

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    // The tbody spans the full virtual height so the scrollbar reflects all rows
    // while only the windowed rows are absolutely positioned inside it. The
    // height is intrinsically dynamic (it tracks the virtualizer), so the style
    // object is rebuilt each render — react-virtual's canonical pattern.

    const tbodyStyle: CSSProperties = { display: "block", height: `${totalSize.toString()}px`, position: "relative" };

    return { scrollRef, scrollToIndex, table, tableRows, tbodyStyle, virtualRows };
};

export { DataBrowserTableView, rowId, useDataBrowserTable };
export type { DataBrowserTableModel, GridEdit, TableRow };
