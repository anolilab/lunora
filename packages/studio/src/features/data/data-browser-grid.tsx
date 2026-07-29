import type { Cell, ColumnDef, Header, OnChangeFn, Row, RowSelectionState, SortingState, Table, VisibilityState } from "@tanstack/react-table";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { Checkbox } from "../../components/ui/checkbox";
import { useT } from "../../i18n/i18n-context";
import type { TablePage } from "../../lib/admin";
import { fireAndForget, formatCell } from "../../lib/internal";
import type { MaskView } from "../../lib/mask-preview";
import { maskCell } from "../../lib/mask-preview";
import { cn } from "../../lib/utils";
import flooredRectObserver from "../../lib/virtual-rect";
import { columnWindow, pinnedOffsets } from "./column-window";
import { CellValue, GridContainer } from "./data-grid";
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

/** Left offset of the first data column once the select column is frozen ahead of it. */
const PINNED_DATA_LEFT = "2.5rem";

/**
 * Fixed-width leading cell holding the row-select checkbox. Frozen (`sticky`) at
 * the left edge so it — and the primary-key column beside it — stay visible while
 * a wide table scrolls horizontally, matching Supabase/Outerbase.
 */
const SELECT_CELL_STYLE: CSSProperties = {
    alignItems: "center",
    display: "flex",
    flex: "0 0 2.5rem",
    justifyContent: "center",
    left: 0,
    padding: "0.375rem 0",
    position: "sticky",
    zIndex: 2,
};

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

/**
 * Style for a pinned data column: the {@link sizedCellStyle} base made `sticky`
 * at a cumulative left offset, so several pinned columns stack correctly instead
 * of overlapping.
 *
 * `offsetPx` is the summed width of the pinned columns BEFORE this one. The
 * earlier single-column version hard-coded `left: PINNED_DATA_LEFT`, which was
 * correct only while exactly one column could be pinned — every column past the
 * first would have stacked on top of it.
 */
const pinnedDataCellStyle = (width: number, offsetPx: number): CSSProperties => {
    return { ...sizedCellStyle(width), left: `calc(${PINNED_DATA_LEFT} + ${offsetPx.toString()}px)`, position: "sticky", zIndex: 2 };
};

/** Borderless per-row action button (Details / Edit / Delete). */
const ROW_BTN =
    "rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

/**
 * The search term to highlight inside one cell, or `undefined` for none.
 *
 * A MASKED cell is never highlighted: the highlight reveals WHERE in the
 * redacted value the match landed, which leaks exactly the position the mask
 * exists to hide.
 */
const cellHighlight = (highlight: string | undefined, mask: MaskView, column: string): string | undefined =>
    mask.enabled && mask.columns.has(column) ? undefined : highlight;

/** Namespace prefix keeping reverse-relation column ids from ever colliding with a real column. */
const BACK_RELATION_PREFIX = "__back__:";

/** Column id for a reverse-relation column. */
const backRelationColumnId = (relation: { column: string; table: string }): string => `${BACK_RELATION_PREFIX}${relation.table}.${relation.column}`;

/**
 * One reverse-relation cell: how many rows of the child table point at this row.
 *
 * An absent entry means zero — the server omits childless parents rather than
 * shipping a row per one, so the payload does not grow with the page. A dash
 * rather than "0" while counts are still loading, so an empty relation reads
 * differently from an unanswered one.
 */
const BackRelationCell = ({ counts, rowId: id }: { counts: Readonly<Record<string, number>> | undefined; rowId: string }): ReactElement => {
    if (counts === undefined) {
        return <span className="text-muted-foreground/50">—</span>;
    }

    return <span className="tabular-nums">{counts[id] ?? 0}</span>;
};

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
 * A stable React key for a row. Lunora tables always carry a primary key, so
 * prefer it; the positional fallback only applies to the rare idless page and is
 * hidden behind this helper so it isn't an inline array-index key.
 */
const rowKey = (row: TableRow, index: number): string => rowId(row) ?? `row-${index.toString()}`;

/**
 * The hover preview's fetch state: not yet opened, in flight, or resolved (the
 * referenced row, or `null` for no-match / cross-tier). One value drives both the
 * "have we fetched" decision (anything past `idle`) and what the card renders.
 */
type PreviewState = "idle" | "loading" | { row: Record<string, unknown> | null };

/** Up to this many of the referenced row's fields show in the hover card before it truncates. */
const PREVIEW_FIELD_LIMIT = 8;

/**
 * The hover-preview card for a foreign-key cell: the referenced row's first few
 * fields, fetched lazily on first hover and cached. Fixed-positioned at the cell
 * so the surrounding scroll containers can't clip it.
 */
const RefPreviewCard = ({ anchor, state }: { anchor: { left: number; top: number }; state: Exclude<PreviewState, "idle"> }): ReactElement => {
    const t = useT();
    const style = { left: anchor.left, position: "fixed", top: anchor.top, zIndex: 50 } as CSSProperties;

    let body: ReactElement;

    if (state === "loading") {
        body = <p className="px-3 py-2 text-xs text-muted-foreground">{t("Loading…")}</p>;
    } else if (state.row === null) {
        body = <p className="px-3 py-2 text-xs text-muted-foreground">{t("No matching row.")}</p>;
    } else {
        const entries = Object.entries(state.row).slice(0, PREVIEW_FIELD_LIMIT);

        body = (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2">
                {entries.map(([key, value]) => (
                    <div className="contents" key={key}>
                        <dt className="truncate font-mono text-[11px] text-muted-foreground">{key}</dt>
                        <dd className="truncate font-mono text-[11px] text-foreground" title={formatCell(value)}>
                            {formatCell(value)}
                        </dd>
                    </div>
                ))}
            </dl>
        );
    }

    return (
        <div
            className="pointer-events-none w-72 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground"
            data-testid="db-ref-preview"
            role="tooltip"
            style={style}
        >
            {body}
        </div>
    );
};

/**
 * Renders a foreign-key cell as a link to the target table, with a lazy hover
 * preview of the referenced row. Clicking still navigates; hovering (or focusing)
 * fetches the target row once and shows its fields in a fixed-positioned card.
 */
const RefCell = ({
    column,
    id,
    onNavigate,
    onPreview,
    target,
}: {
    column: string;
    id: string;
    onNavigate: (target: string, id: string) => void;
    onPreview: (target: string, id: string) => Promise<Record<string, unknown> | null>;
    target: string;
}): ReactElement => {
    const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
    // `idle` doubles as "not yet fetched"; the first open kicks the lazy fetch
    // and every later open reuses the cached result. This cell is keyed on
    // `target:id` by its parent, so a reused instance for a different ref starts
    // fresh at `idle` rather than showing a stale preview.
    const [preview, setPreview] = useState<PreviewState>("idle");

    const onClick = (): void => {
        onNavigate(target, id);
    };

    const onOpen = (event: React.FocusEvent<HTMLButtonElement> | React.MouseEvent<HTMLButtonElement>): void => {
        const rect = event.currentTarget.getBoundingClientRect();

        setAnchor({ left: rect.left, top: rect.bottom + 4 });

        // Already fetched (or fetching): just re-show the cached card.
        if (preview !== "idle") {
            return;
        }

        setPreview("loading");

        // Fetch the referenced row once; the result is cached across re-hovers.
        const load = async (): Promise<void> => {
            try {
                setPreview({ row: await onPreview(target, id) });
            } catch {
                setPreview({ row: null });
            }
        };

        fireAndForget(load());
    };
    const onCloseHover = (): void => {
        setAnchor(null);
    };

    return (
        <>
            <button
                data-testid={`db-ref-${column}`}
                onBlur={onCloseHover}
                onClick={onClick}
                onFocus={onOpen}
                onMouseEnter={onOpen}
                onMouseLeave={onCloseHover}
                title={`Open ${target} ${id}`}
                type="button"
            >
                {id} ↗
            </button>
            {anchor !== null && preview !== "idle" && <RefPreviewCard anchor={anchor} state={preview} />}
        </>
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
 * which columns accept it, the cell currently open for editing, and the staged-edit
 * buffer. The separate {@link GridReferences} carries the foreign-key context so a ref
 * cell reads only what it needs rather than the whole edit bag. Both are built by
 * `DataBrowser` and passed down to {@link EditableCell}.
 */
interface GridEdit {
    cancelEdit: () => void;
    editable: boolean;
    editableColumn: (column: string) => boolean;
    editingCell: null | { column: string; rowId: string };
    onExpandCell: (column: string, value: unknown) => void;
    stage: StagedEditsModel["stage"];
    stagedValue: StagedEditsModel["stagedValue"];
    startEdit: (rowId: string, column: string) => void;
}

/**
 * Foreign-key context for a grid cell: the column → referenced-table map (so a
 * ref column renders as a link), plus how to navigate to and how to preview the
 * referenced row. Kept separate from {@link GridEdit} so the ref cell reads only
 * the FK wiring, not the inline-edit state.
 */
interface GridReferences {
    /** Column name → referenced table, for the columns that are foreign keys. */
    columns: Record<string, string> | undefined;
    onNavigate: (target: string, id: string) => void;
    onPreview: (target: string, id: string) => Promise<Record<string, unknown> | null>;
}

/** Borderless expand affordance shown on cell hover — opens the full value + copy. */
const EXPAND_BTN =
    "absolute end-1 top-1/2 hidden -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none group-hover/cell:flex hover:text-foreground focus-visible:flex";

/**
 * The hover "expand" button injected into a cell: opens the cell-detail dialog
 * with the cell's full value (the parent owns the dialog via `onExpandCell`).
 * Extracted so it binds its own `useCallback` closing over the column + value
 * rather than a fresh inline arrow per cell.
 */
const CellExpandButton = ({
    column,
    onExpand,
    value,
}: {
    column: string;
    onExpand: (column: string, value: unknown) => void;
    value: unknown;
}): ReactElement => {
    const onClick = (): void => {
        onExpand(column, value);
    };

    return (
        <button aria-label="Expand cell" className={EXPAND_BTN} data-testid={`db-expand-${column}`} onClick={onClick} type="button">
            <svg
                aria-hidden="true"
                className="size-3"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.8}
                viewBox="0 0 24 24"
            >
                <path d="M9 21H5a2 2 0 0 1-2-2v-4m18 0v4a2 2 0 0 1-2 2h-4M3 9V5a2 2 0 0 1 2-2h4m6 0h4a2 2 0 0 1 2 2v4" />
            </svg>
        </button>
    );
};

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

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === "Enter") {
            event.preventDefault();
            onCommit(event.currentTarget.value);
        } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
        }
    };

    const onBlur = (event: React.FocusEvent<HTMLInputElement>): void => {
        onCommit(event.currentTarget.value);
    };

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
const EditableCell = ({
    cell,
    edit,
    highlight,
    mask,
    refs,
}: {
    cell: Cell<TableRow, unknown>;
    edit: GridEdit;
    /** Active row-search term, highlighted inside matching cells. */
    highlight?: string;
    mask: MaskView;
    refs: GridReferences;
}): ReactElement => {
    const column = cell.column.id;
    const rawValue = cell.getValue();
    const id = rowId(cell.row.original);
    const target = refs.columns?.[column];

    // Mask preview takes precedence over every other branch: when the toggle is on
    // and this column is mask-covered, render only the masked value — no
    // foreign-key link, no inline editor, no expand-to-raw affordance. This is a
    // render-only preview of what a `.use(mask(...))` caller would see; the stored
    // row is untouched and the operator can toggle the preview off to edit.
    if (mask.enabled && mask.columns.has(column)) {
        return (
            <span className="text-muted-foreground italic" data-testid={`db-masked-${column}`} title="Masked (preview)">
                <CellValue value={maskCell(rawValue, column, mask)} />
            </span>
        );
    }

    if (target !== undefined && (typeof rawValue === "string" || typeof rawValue === "number") && String(rawValue) !== "") {
        // Keyed on target:id so a reused cell instance (an idless row at the same
        // index across pages) starts its preview state fresh rather than stale.
        return (
            <RefCell
                column={column}
                id={String(rawValue)}
                key={`${target}:${String(rawValue)}`}
                onNavigate={refs.onNavigate}
                onPreview={refs.onPreview}
                target={target}
            />
        );
    }

    // An idless row can't be addressed for a patch, so its cells are read-only.
    // Returning early also narrows `id` to a string for the editable path below.
    if (id === null) {
        return (
            <>
                <CellValue value={rawValue} />
                <CellExpandButton column={column} onExpand={edit.onExpandCell} value={rawValue} />
            </>
        );
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
        cellClass = "rounded bg-warning/15 px-1";
    } else if (canEdit) {
        cellClass = "cursor-text";
    }

    const onDoubleClick = canEdit
        ? (): void => {
              edit.startEdit(id, column);
          }
        : undefined;

    return (
        <>
            <span className={cellClass} data-testid={`db-cell-${id}-${column}`} onDoubleClick={onDoubleClick}>
                <CellValue highlight={cellHighlight(highlight, mask, column)} value={display} />
            </span>
            <CellExpandButton column={column} onExpand={edit.onExpandCell} value={display} />
        </>
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
    masked = false,
    onTogglePin,
    pinnedOffset,
    table,
}: {
    draggedRef: React.RefObject<null | string>;
    header: Header<TableRow, unknown>;
    /** Show a "masked" chip: this column is covered by a `.use(mask(...))` policy (static annotation, independent of the toggle). */
    masked?: boolean;
    /** Freeze this header at the left edge (the primary-key column) during horizontal scroll. */
    onTogglePin: (columnId: string) => void;
    /** Summed width of the pinned columns before this one, or `undefined` when unpinned. */
    pinnedOffset?: number;
    table: Table<TableRow>;
}): ReactElement => {
    const onDragStart = (): void => {
        // eslint-disable-next-line no-param-reassign -- a ref's `.current` is mutable by design; it carries the drag source across handlers
        draggedRef.current = header.column.id;
    };

    const onDragOver = (event: React.DragEvent<HTMLTableCellElement>): void => {
        event.preventDefault();
    };

    const onDrop = (): void => {
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
    };

    return (
        <th
            className={cn("group/head text-start text-xs font-medium text-muted-foreground", pinnedOffset !== undefined && "border-e border-border bg-muted")}
            draggable
            onDragOver={onDragOver}
            onDragStart={onDragStart}
            onDrop={onDrop}
            style={pinnedOffset === undefined ? sizedCellStyle(header.getSize()) : pinnedDataCellStyle(header.getSize(), pinnedOffset)}
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
            {masked && (
                <span
                    className="ms-1 inline-flex items-center rounded-sm bg-warning/15 px-1 text-[0.625rem] font-medium uppercase text-warning"
                    data-testid={`db-mask-chip-${header.column.id}`}
                    title="This column is masked by a mask() policy"
                >
                    masked
                </span>
            )}
            {/* Pin toggle. Freezing more than one column is the point: an operator
                scanning a wide table usually wants the key AND the one human-readable
                column (name, email) to stay put, not just the key. */}
            <button
                aria-label={pinnedOffset === undefined ? `Pin ${header.column.id}` : `Unpin ${header.column.id}`}
                aria-pressed={pinnedOffset !== undefined}
                className={cn(
                    "ms-1 rounded-sm px-1 text-[0.625rem] outline-none transition-opacity hover:bg-accent focus-visible:bg-accent",
                    pinnedOffset === undefined ? "opacity-0 group-hover/head:opacity-100 focus-visible:opacity-100" : "opacity-100 text-foreground",
                )}
                data-testid={`db-pin-${header.column.id}`}
                onClick={() => {
                    onTogglePin(header.column.id);
                }}
                type="button"
            >
                📌
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
 * The leading select-all checkbox in the header. Toggles every row on the loaded
 * page; shows an indeterminate state when only some rows are selected.
 */
const SelectAllHeaderCell = ({ table }: { table: Table<TableRow> }): ReactElement => {
    const t = useT();

    const onCheckedChange = (checked: boolean): void => {
        table.toggleAllRowsSelected(checked);
    };

    return (
        <th className="bg-muted" style={SELECT_CELL_STYLE}>
            <Checkbox
                aria-label={t("Select all rows")}
                checked={table.getIsAllRowsSelected()}
                data-testid="db-select-all"
                indeterminate={table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected()}
                onCheckedChange={onCheckedChange}
            />
        </th>
    );
};

/**
 * The leading per-row select checkbox. Disabled for an idless row (it can't be
 * addressed for a bulk delete). Binds its own toggle so the row map stays free of
 * inline closures.
 */
const RowSelectCell = ({ row }: { row: Row<TableRow> }): ReactElement => {
    const t = useT();
    const id = rowId(row.original);

    const onCheckedChange = (checked: boolean): void => {
        row.toggleSelected(checked);
    };

    return (
        <td className="bg-background" style={SELECT_CELL_STYLE}>
            <Checkbox
                aria-label={t("Select row")}
                checked={row.getIsSelected()}
                data-testid={`db-select-${rowKey(row.original, row.index)}`}
                disabled={id === null}
                onCheckedChange={onCheckedChange}
            />
        </td>
    );
};

/**
 * The virtualized table: a leading select column, a sortable, resizable,
 * reorderable header derived from react-table's flat headers, plus the windowed
 * rows positioned absolutely inside a full-height tbody. All model state (`table`,
 * `tableRows`, `virtualRows`, `tbodyStyle`, `scrollRef`) is owned by the parent;
 * edit/delete are surfaced as callbacks so this stays a pure render of the page's
 * rows.
 */
const DataBrowserTableView = ({
    edit,
    editable,
    mask,
    onDelete,
    onEdit,
    onInspect,
    highlight,
    backRelationCounts,
    attachScroll,
    onTogglePin,
    pinnedColumns,
    refs,
    scrollLeft,
    scrollToIndex,
    table,
    tableRows,
    tbodyStyle,
    viewportWidth,
    virtualRows,
}: {
    /** Callback ref for the scroll container. */
    attachScroll: (node: HTMLDivElement | null) => void;
    /** Reverse-relation counts, keyed `table.column` → parent id → count. */
    backRelationCounts: Readonly<Record<string, Readonly<Record<string, number>>>>;
    edit: GridEdit;
    editable: boolean;
    /** Active row-search term, highlighted inside matching cells. */
    highlight?: string;
    /** Mask preview state: the active table's masked columns + whether the toggle is on. Drives the header chips and per-cell redaction. */
    mask: MaskView;
    onDelete: (id: null | string) => void;
    onEdit: (id: null | string, original: TableRow) => void;
    onInspect: (original: TableRow) => void;
    onTogglePin: (columnId: string) => void;
    /** Column ids frozen at the left edge, in no particular order — the render derives offsets from visible order. */
    pinnedColumns: ReadonlySet<string>;
    refs: GridReferences;
    /** Horizontal scroll offset + measured viewport width, driving the column window. */
    scrollLeft: number;
    scrollToIndex: (index: number) => void;
    table: Table<TableRow>;
    tableRows: Row<TableRow>[];
    tbodyStyle: CSSProperties;
    viewportWidth: number;
    virtualRows: { index: number; size: number; start: number }[];
}): ReactElement => {
    // Carries the column id being dragged between a header's dragstart and the
    // drop target's drop, for reordering.
    const draggedColumn = useRef<null | string>(null);

    // The keyboard-focused cell (row index + visible-column index). Arrow keys
    // move it; Enter opens the inline editor for an editable cell.
    const [active, setActive] = useState<null | { col: number; row: number }>(null);
    const columnCount = table.getVisibleLeafColumns().length;

    const onGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
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
    };

    // Keep the focused row in view as it moves past the virtual window's edge.
    useEffect(() => {
        /* eslint-disable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-pass-live-state-to-parent -- scroll-sync effect: drives the virtualizer's imperative scrollToIndex from the committed `active` cell so the focused row is rendered before we scroll to it, and so programmatic `active` changes (not just keydown) stay in view */
        if (active !== null) {
            scrollToIndex(active.row);
        }
        /* eslint-enable react-you-might-not-need-an-effect/no-event-handler, react-you-might-not-need-an-effect/no-pass-live-state-to-parent */
    }, [active, scrollToIndex]);

    const visibleColumns = table.getVisibleLeafColumns().map((column) => {
        return { getSize: () => column.getSize(), id: column.id };
    });
    const columnSlice = columnWindow(visibleColumns, pinnedColumns, scrollLeft, viewportWidth);

    // Derived from the VISIBLE column order each render, so reordering or hiding a
    // pinned column re-flows the rest instead of leaving a gap.
    const pinOffsets = pinnedOffsets(
        table.getVisibleLeafColumns().map((column) => {
            return { getSize: () => column.getSize(), id: column.id };
        }),
        pinnedColumns,
    );

    const renderRow = (virtualRow: { index: number; size: number; start: number }): ReactElement => {
        const tableRow = tableRows[virtualRow.index] as Row<TableRow>;
        const { original } = tableRow;
        const id = rowId(original);
        const key = rowKey(original, virtualRow.index);
        // Per-row absolute offset from the virtualizer; necessarily a fresh object
        // each render since `start`/`size` change as the window scrolls.

        const rowStyle: CSSProperties = {
            ...ROW_BASE_STYLE,
            height: `${virtualRow.size.toString()}px`,
            transform: `translateY(${virtualRow.start.toString()}px)`,
        };

        return (
            <tr className="border-b border-border text-xs transition-colors hover:bg-muted/50" data-testid="db-row" key={tableRow.id} style={rowStyle}>
                <RowSelectCell row={tableRow} />
                {columnSlice.leadPx > 0 && <td aria-hidden="true" style={{ flex: `0 0 ${columnSlice.leadPx.toString()}px` }} />}
                {tableRow.getVisibleCells().map((cell, colIndex) => {
                    if (!columnSlice.ids.has(cell.column.id)) {
                        return null;
                    }

                    const offset = pinOffsets.get(cell.column.id);
                    const ring = active !== null && active.row === virtualRow.index && active.col === colIndex ? " ring-1 ring-ring ring-inset" : "";

                    return (
                        <td
                            className={cn(
                                "group/cell truncate font-mono text-muted-foreground",
                                offset !== undefined && "border-e border-border bg-background",
                                ring,
                            )}
                            key={cell.id}
                            style={offset === undefined ? sizedCellStyle(cell.column.getSize()) : pinnedDataCellStyle(cell.column.getSize(), offset)}
                        >
                            {cell.column.id.startsWith(BACK_RELATION_PREFIX) ? (
                                <BackRelationCell counts={backRelationCounts[cell.column.id.slice(BACK_RELATION_PREFIX.length)]} rowId={key} />
                            ) : (
                                <EditableCell cell={cell} edit={edit} highlight={highlight} mask={mask} refs={refs} />
                            )}
                        </td>
                    );
                })}
                {columnSlice.tailPx > 0 && <td aria-hidden="true" style={{ flex: `0 0 ${columnSlice.tailPx.toString()}px` }} />}
                <td className="flex items-center gap-1" style={ACTION_CELL_STYLE}>
                    <button
                        className={ROW_BTN}
                        data-testid={`db-inspect-${key}`}
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
        <GridContainer layout="fill">
            <div data-testid="db-scroll" onKeyDown={onGridKeyDown} ref={attachScroll} role="grid" style={SCROLL_STYLE} tabIndex={0}>
                <table className="w-full text-xs" data-testid="db-rows" style={ROWS_STYLE}>
                    <thead className="bg-muted/50">
                        <tr className="border-b border-border" style={HEAD_ROW_STYLE}>
                            <SelectAllHeaderCell table={table} />
                            {columnSlice.leadPx > 0 && <th aria-hidden="true" style={{ flex: `0 0 ${columnSlice.leadPx.toString()}px` }} />}
                            {table
                                .getFlatHeaders()
                                .map((header) =>
                                    columnSlice.ids.has(header.column.id) ? (
                                        <GridHeaderCell
                                            draggedRef={draggedColumn}
                                            header={header}
                                            key={header.id}
                                            masked={mask.columns.has(header.column.id)}
                                            onTogglePin={onTogglePin}
                                            pinnedOffset={pinOffsets.get(header.column.id)}
                                            table={table}
                                        />
                                    ) : null,
                                )}
                            {columnSlice.tailPx > 0 && <th aria-hidden="true" style={{ flex: `0 0 ${columnSlice.tailPx.toString()}px` }} />}
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
    /** Callback ref for the scroll container — installs the measurement when the node mounts. */
    attachScroll: (node: HTMLDivElement | null) => void;
    /** Horizontal scroll offset, driving the column window. */
    scrollLeft: number;
    scrollToIndex: (index: number) => void;
    table: Table<TableRow>;
    tableRows: Row<TableRow>[];
    tbodyStyle: CSSProperties;
    viewportWidth: number;
    virtualRows: { index: number; size: number; start: number }[];
}

/**
 * The headless table model + virtualizer for the loaded page. Column defs derive
 * from `page.columns`; the page-local `sorting` runs over the loaded rows, and
 * the rendered rows are virtualized so a large page never inflates the DOM.
 * Column order (drag-to-reorder) and sizing (drag-to-resize) are managed
 * internally by TanStack; the `sorting` state stays owned by the caller.
 */
const useDataBrowserTable = (
    page: TablePage | null,
    sorting: SortingState,
    onSortingChange: OnChangeFn<SortingState>,
    backRelations: ReadonlyArray<{ column: string; table: string }> = [],
): DataBrowserTableModel => {
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
        const defs: ColumnDef<TableRow>[] = columns.map((column) => {
            return {
                accessorFn: (row: TableRow) => row[column],
                header: references?.[column] === undefined ? column : `${column} →`,
                id: column,
            };
        });

        // Reverse relations render as extra, read-only columns after the real
        // ones. `← table` mirrors the `column →` marker a forward FK already
        // carries, so the direction of an edge is readable at a glance.
        for (const relation of backRelations) {
            defs.push({
                accessorFn: () => undefined,
                enableSorting: false,
                header: `← ${relation.table}`,
                id: backRelationColumnId(relation),
            });
        }

        return defs;
    }, [backRelations, columns, references]);

    // `data` MUST keep a stable reference across renders: react-table resets its
    // internal state (column sizing, row selection, …) whenever `data` changes
    // identity, which re-renders. With no table selected `page` is null, so a bare
    // `rows ?? []` would hand a fresh `[]` every render — react-table then resets +
    // re-renders forever, hard-hanging the data tab. Memoizing pins the empty array
    // (and the loaded page's rows) to one reference until the rows actually change.
    const data = useMemo<TableRow[]>(() => rows ?? [], [rows]);

    // Row selection (for bulk delete / export-of-selected) and column visibility
    // are page-local view state owned by the table model. Selection is keyed by
    // the row's primary key (see `getRowId`), so a stale id left over after
    // paginating simply matches no visible row — `getSelectedRowModel()` only ever
    // returns rows present on the loaded page. Column visibility is keyed by column
    // name, so it persists across pages and harmlessly ignores names from a table
    // that's since been switched away from.
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});

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
        enableRowSelection: (row) => rowId(row.original) !== null,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row, index) => rowId(row) ?? `row-${index.toString()}`,
        getSortedRowModel: getSortedRowModel(),
        // Sorting is server-side: the page arrives already ordered, so the table
        // must not re-sort it. The header still toggles `sorting`, which the data
        // browser forwards to `readTablePage` as `orderBy`.
        manualSorting: true,
        onColumnVisibilityChange: setColumnVisibility,
        onRowSelectionChange: setRowSelection,
        onSortingChange,
        state: { columnVisibility, rowSelection, sorting },
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
    // Seed the rect on first paint via `initialRect`; the shared observer floors a
    // zero-height viewport (jsdom) to SCROLL_HEIGHT so rows still mount in tests.
    // overscan keeps a few off-screen rows.
    const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
        count: tableRows.length,
        estimateSize: () => ROW_HEIGHT,
        getScrollElement: () => scrollRef.current,
        initialRect: { height: SCROLL_HEIGHT, width: 0 },
        observeElementRect: (instance, callback) => flooredRectObserver(instance, callback, SCROLL_HEIGHT),
        overscan: 8,
    });

    const scrollToIndex = useCallback(
        (index: number): void => {
            virtualizer.scrollToIndex(index);
        },
        [virtualizer],
    );

    // Horizontal scroll + viewport width, for the column window.
    //
    // Attached by a CALLBACK REF, not an effect. The scroll container lives in
    // `DataBrowserTableView`, which only mounts once a page has rows — so an
    // effect in this hook (which lives in the always-mounted `DataBrowser`) ran
    // while `scrollRef.current` was still null, returned early, and with `[]`
    // deps never ran again. The window then measured a 0px viewport forever and
    // fell back to rendering every column, silently disabling the whole feature.
    // A callback ref fires exactly when the node appears and again when it goes.
    //
    // It RETURNS its cleanup (React 19's callback-ref contract) rather than
    // parking a teardown in a second ref: React calls the returned function when
    // the node detaches, so the listener and observer cannot outlive the node
    // they were attached to, and there is no hand-rolled teardown bookkeeping to
    // get wrong.
    const [horizontal, setHorizontal] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

    const attachScroll = useCallback((node: HTMLDivElement | null): (() => void) | undefined => {
        scrollRef.current = node;

        if (node === null) {
            return undefined;
        }

        const sync = (): void => {
            setHorizontal((current) =>
                current.left === node.scrollLeft && current.width === node.clientWidth ? current : { left: node.scrollLeft, width: node.clientWidth },
            );
        };

        node.addEventListener("scroll", sync, { passive: true });

        const observer = new ResizeObserver(sync);

        observer.observe(node);

        return () => {
            node.removeEventListener("scroll", sync);
            observer.disconnect();
            scrollRef.current = null;
        };
    }, []);

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    // The tbody spans the full virtual height so the scrollbar reflects all rows
    // while only the windowed rows are absolutely positioned inside it. The
    // height is intrinsically dynamic (it tracks the virtualizer), so the style
    // object is rebuilt each render — react-virtual's canonical pattern.

    const tbodyStyle: CSSProperties = { display: "block", height: `${totalSize.toString()}px`, position: "relative" };

    return { attachScroll, scrollLeft: horizontal.left, scrollToIndex, table, tableRows, tbodyStyle, viewportWidth: horizontal.width, virtualRows };
};

export { DataBrowserTableView, rowId, useDataBrowserTable };
export type { DataBrowserTableModel, GridEdit, GridReferences, TableRow };
