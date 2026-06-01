import { useCirrus } from "@cirrus/react";
import { type ColumnDef, flexRender, getCoreRowModel, getSortedRowModel, type Row, type SortingState, useReactTable } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ADMIN_FUNCTIONS, type TableInfo, type TablePage, type WriteRowResult } from "./admin.js";
import { ConfirmButton } from "./confirm-button.js";
import { adminRef, callOptions } from "./internal.js";
import { LiveToggle } from "./live-toggle.js";
import { recordShard } from "./shard-history.js";
import { ShardInput } from "./shard-input.js";
import { useDebounced } from "./use-debounced.js";
import { useLiveAdmin } from "./use-live-admin.js";
import { useLiveToggle } from "./use-live-toggle.js";

export interface DataBrowserProps {
    /**
     * Allow editing: surfaces insert/edit/delete actions that issue
     * `__cirrus_admin__:writeRow` ops through the schema-aware writer. Off by
     * default — the browser is read-only unless the host opts in.
     */
    readonly editable?: boolean;
    /** Shard key the browser targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
    /** Rows requested per page. Clamped server-side to `[1, 500]`. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

/** Height of the virtualized scroll viewport, in px. */
const SCROLL_HEIGHT = 400;
/** Estimated height of a single row, in px — used to size the virtual list. */
const ROW_HEIGHT = 36;

/** Static styles, hoisted so they aren't reallocated (and re-flagged) per render. */
const SCROLL_STYLE: CSSProperties = { height: `${SCROLL_HEIGHT}px`, overflow: "auto", position: "relative" };
const ROWS_STYLE: CSSProperties = { width: "100%" };
const ROW_BASE_STYLE: CSSProperties = { left: 0, position: "absolute", top: 0, width: "100%" };

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);
const WRITE_ROW = adminRef(ADMIN_FUNCTIONS.writeRow);

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
 * The editable document for a row. Shard rows keep their fields in a `__doc__`
 * JSON column; when present we parse it, otherwise we fall back to the row's own
 * non-meta columns. Used to prefill the edit form.
 */
const rowDoc = (row: TableRow): Record<string, unknown> => {
    const raw = row["__doc__"];

    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw) as unknown;

            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // fall through to the column-strip path
        }
    }

    const doc: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        if (key !== "id" && key !== "__id__" && key !== "_id" && key !== "_creationTime" && key !== "__doc__") {
            doc[key] = value;
        }
    }

    return doc;
};

/**
 * A stable React key for a row. Cirrus tables always carry a primary key, so
 * prefer it; the positional fallback only applies to the rare idless page and is
 * hidden behind this helper so it isn't an inline array-index key.
 */
const rowKey = (row: TableRow, index: number): string => {
    return rowId(row) ?? `row-${index}`;
};

/** Render a single cell value as text without throwing on objects or null. */
const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    return String(value);
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
 * Read-only data browser for a single shard's SQLite database. Lists the user
 * tables (via the `__cirrus_admin__:listTables` RPC), then pages through the
 * rows of whichever table is selected (`__cirrus_admin__:readTablePage`).
 *
 * Both calls travel over the ordinary {@link useCirrus} client transport; the
 * admin RPCs are intercepted inside the Durable Object and are gated by the
 * server's `CIRRUS_ADMIN_TOKEN`. The host is responsible for configuring the
 * client's auth token — this component issues no credentials of its own.
 *
 * The table view is built on a headless `@tanstack/react-table` model: column
 * defs derive from `page.columns`, sorting and (global) filtering run
 * page-locally over the loaded rows, and the rendered rows are virtualized with
 * `@tanstack/react-virtual` so a large page never inflates the DOM. None of this
 * touches the server — pagination still flows through `readTablePage`.
 */
export function DataBrowser({ editable = false, initialShardKey, pageSize = DEFAULT_PAGE_SIZE }: DataBrowserProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [tables, setTables] = useState<TableInfo[] | null>(null);
    const [tablesError, setTablesError] = useState<null | string>(null);

    const [selectedTable, setSelectedTable] = useState<null | string>(null);
    const [offset, setOffset] = useState<number>(0);
    const [page, setPage] = useState<TablePage | null>(null);
    const [pageError, setPageError] = useState<null | string>(null);
    const [viewMode, setViewMode] = useState<"json" | "table">("table");

    // Page-local sort: operates ONLY on the rows of the currently loaded page.
    // Reset whenever a new table is selected so stale state can't leak across
    // selections.
    const [sorting, setSorting] = useState<SortingState>([]);

    // Search box value. Debounced into a server-side `search` (filters across the
    // WHOLE table, not just the loaded page), which re-fetches from offset 0.
    const [filter, setFilter] = useState<string>("");
    const search = useDebounced(filter.trim(), 300);

    // Edit state: the row being edited (its id, or `""` for a new insert) and
    // the JSON-doc draft. `null` when no editor is open. `writeError` surfaces a
    // rejected write without disturbing the page-read error.
    const [editing, setEditing] = useState<null | { docText: string; id: null | string }>(null);
    const [writeError, setWriteError] = useState<null | string>(null);

    const { live, liveError, setLiveError, toggle } = useLiveToggle();

    // The page descriptor the live channel tracks. Set only when a page actually
    // loads (in fetchPage), so the live subscription follows what's displayed —
    // not the shard-key input as it's typed, nor a table selection whose offset
    // reset hasn't landed yet. Keyed independently of `shardKey`/`offset` state.
    const [loaded, setLoaded] = useState<null | { offset: number; search: string; shard: string; table: string }>(null);

    const fetchTables = useCallback(
        async (shard: string): Promise<void> => {
            setTablesError(null);

            try {
                const result = (await client.query(LIST_TABLES, {}, callOptions(shard))) as TableInfo[];

                recordShard(shard);
                setTables(result);
            } catch (error) {
                setTables(null);
                setTablesError((error as Error).message);
            }
        },
        [client],
    );

    const fetchPage = useCallback(
        async (shard: string, table: string, nextOffset: number, search: string): Promise<void> => {
            setPageError(null);

            try {
                const result = (await client.query(READ_TABLE_PAGE, { limit: pageSize, offset: nextOffset, search, table }, callOptions(shard))) as TablePage;

                setPage(result);
                setOffset(nextOffset);
                setLoaded({ offset: nextOffset, search, shard, table });
            } catch (error) {
                setPage(null);
                setPageError((error as Error).message);
            }
        },
        [client, pageSize],
    );

    // Initial load only. Subsequent reloads are driven by the "Load tables"
    // button so typing a shard key doesn't fire a request per keystroke.
    useEffect(() => {
        void fetchTables(initialShardKey ?? "");
    }, [fetchTables, initialShardKey]);

    // Live channel: while toggled on, the server re-pushes the loaded window
    // whenever its table is written (dependency-scoped to that table). Keyed on
    // the `loaded` descriptor so it tracks exactly the displayed shard/table/page
    // — never a half-typed shard key or a table switch whose offset reset is
    // still pending — and only runs once a page has actually loaded.
    useLiveAdmin<TablePage>(
        ADMIN_FUNCTIONS.readTablePage,
        { limit: pageSize, offset: loaded?.offset ?? 0, search: loaded?.search ?? "", table: loaded?.table ?? "" },
        loaded?.shard ?? "",
        (result) => {
            setPageError(null);
            setLiveError(null);
            setPage(result);
        },
        live && loaded !== null,
        setLiveError,
    );

    // Live channel for the table list itself, so a migration that creates a
    // table (or changes a row count) reflects without a manual "Load tables".
    // `listTables` is shard-scoped; key it on the loaded shard so it follows the
    // same shard as the page rather than the shard-input box as it's typed.
    useLiveAdmin<TableInfo[]>(
        ADMIN_FUNCTIONS.listTables,
        {},
        loaded?.shard ?? "",
        (result) => {
            setTablesError(null);
            setLiveError(null);
            setTables(result);
        },
        live && loaded !== null,
        setLiveError,
    );

    const selectTable = useCallback(
        (table: string): void => {
            // A fresh table means the previous sort/search no longer apply.
            setSorting([]);
            setFilter("");
            setSelectedTable(table);
            void fetchPage(shardKey, table, 0, "");
        },
        [fetchPage, shardKey],
    );

    // Follow a foreign-key cell: switch to the target table and search for the
    // referenced id (the row's primary key shows in the `id` column), so an
    // operator can traverse relations by clicking instead of copy-pasting ids.
    const navigateToRef = useCallback(
        (targetTable: string, id: string): void => {
            setSorting([]);
            setSelectedTable(targetTable);
            setFilter(id);
            // Seed the page immediately with the search applied; the debounced
            // effect would otherwise fire a second time with the same value.
            void fetchPage(shardKey, targetTable, 0, id);
        },
        [fetchPage, shardKey],
    );

    const goToPage = useCallback(
        (nextOffset: number): void => {
            if (selectedTable === null) {
                return;
            }

            void fetchPage(shardKey, selectedTable, Math.max(0, nextOffset), search);
        },
        [fetchPage, search, selectedTable, shardKey],
    );

    // Re-run the server-side search (from offset 0) when the debounced query
    // changes for the loaded table. Skipped until a table is selected, and when
    // the debounced value already matches what's loaded (e.g. right after a
    // table switch cleared it) so it doesn't double-fetch.
    useEffect(() => {
        if (selectedTable === null || loaded === null || loaded.search === search) {
            return;
        }

        void fetchPage(shardKey, selectedTable, 0, search);
    }, [search, selectedTable, shardKey, loaded, fetchPage]);

    // Issue a writeRow op then reload the current page so the change shows. A
    // delete passes no doc; insert (id === "") / patch carry the JSON draft.
    const writeRow = useCallback(
        async (op: "delete" | "insert" | "patch", id: null | string, docText?: string): Promise<void> => {
            if (selectedTable === null) {
                return;
            }

            setWriteError(null);

            let doc: Record<string, unknown> | undefined;

            if (op !== "delete") {
                try {
                    doc = docText === undefined || docText.trim() === "" ? {} : (JSON.parse(docText) as Record<string, unknown>);
                } catch (error) {
                    setWriteError(`Invalid JSON: ${(error as Error).message}`);

                    return;
                }
            }

            try {
                (await client.query(WRITE_ROW, { doc, id: id ?? undefined, op, table: selectedTable }, callOptions(shardKey))) as WriteRowResult;
                setEditing(null);
                await fetchPage(shardKey, selectedTable, offset, search);
            } catch (error) {
                setWriteError((error as Error).message);
            }
        },
        [client, fetchPage, offset, search, selectedTable, shardKey],
    );

    const columns = page?.columns;
    const rows = page?.rows;
    const refs = page?.refs;

    // Column defs are derived from the loaded page. Each accessor reads the
    // column by name off the ORIGINAL row object; the cell renderer reuses
    // `formatCell` so the markup matches the JSON view's text. Foreign-key
    // columns (in `refs`) render their value as a link to the target table.
    const columnDefs = useMemo<ColumnDef<TableRow>[]>(() => {
        if (columns === undefined) {
            return [];
        }

        return columns.map((column) => {
            const target = refs?.[column];

            return {
                accessorFn: (row: TableRow) => row[column],
                cell: (info) => {
                    const value = info.getValue();

                    if (target !== undefined && (typeof value === "string" || typeof value === "number") && String(value) !== "") {
                        const id = String(value);

                        return (
                            <button
                                data-testid={`db-ref-${column}`}
                                onClick={() => {
                                    navigateToRef(target, id);
                                }}
                                title={`Open ${target} ${id}`}
                                type="button"
                            >
                                {id} ↗
                            </button>
                        );
                    }

                    return formatCell(value);
                },
                header: refs?.[column] === undefined ? column : `${column} →`,
                id: column,
            };
        });
    }, [columns, refs, navigateToRef]);

    const data = useMemo<TableRow[]>(() => rows ?? [], [rows]);

    // Search is server-side now (see the debounced `search` effect); the table
    // model only owns page-local sorting over the already-filtered page.
    const table = useReactTable<TableRow>({
        columns: columnDefs,
        data,
        getCoreRowModel: getCoreRowModel(),
        getSortedRowModel: getSortedRowModel(),
        onSortingChange: setSorting,
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
                callback({ height: SCROLL_HEIGHT, width: element?.clientWidth ?? 0 });
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

    const virtualRows = virtualizer.getVirtualItems();
    const totalSize = virtualizer.getTotalSize();
    // The tbody spans the full virtual height so the scrollbar reflects all rows
    // while only the windowed rows are absolutely positioned inside it. The
    // height is intrinsically dynamic (it tracks the virtualizer), so the style
    // object is rebuilt each render — react-virtual's canonical pattern.
    // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- dynamic virtualizer height
    const tbodyStyle: CSSProperties = { display: "block", height: `${totalSize}px`, position: "relative" };

    const total = page?.total ?? 0;
    const hasPrevious = offset > 0;
    const hasNext = page !== null && offset + page.rows.length < total;
    const rangeStart = page === null || page.rows.length === 0 ? 0 : offset + 1;
    const rangeEnd = page === null ? 0 : offset + page.rows.length;

    const renderRow = (virtualRow: { index: number; size: number; start: number }): ReactElement => {
        const tableRow = tableRows[virtualRow.index] as Row<TableRow>;
        const { original } = tableRow;
        const id = rowId(original);
        const key = rowKey(original, virtualRow.index);
        // Per-row absolute offset from the virtualizer; necessarily a fresh object
        // each render since `start`/`size` change as the window scrolls.
        // eslint-disable-next-line react-perf/jsx-no-new-object-as-prop -- dynamic virtualizer offset
        const rowStyle: CSSProperties = { ...ROW_BASE_STYLE, height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)` };

        return (
            <tr data-testid="db-row" key={tableRow.id} style={rowStyle}>
                {tableRow.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                ))}
                {editable && (
                    <td>
                        <button
                            data-testid={`db-edit-${key}`}
                            disabled={id === null}
                            onClick={() => {
                                setWriteError(null);
                                setEditing({ docText: JSON.stringify(rowDoc(original), null, 2), id });
                            }}
                            type="button"
                        >
                            Edit
                        </button>
                        <ConfirmButton
                            confirmLabel="Delete?"
                            disabled={id === null}
                            onConfirm={() => {
                                void writeRow("delete", id);
                            }}
                            testId={`db-delete-${key}`}
                        >
                            Delete
                        </ConfirmButton>
                    </td>
                )}
            </tr>
        );
    };

    return (
        <div data-testid="cirrus-data-browser">
            <div>
                <ShardInput onChange={setShardKey} testId="db-shard-input" value={shardKey} />
                <button
                    data-testid="db-load-tables"
                    onClick={() => {
                        void fetchTables(shardKey);
                    }}
                    type="button"
                >
                    Load tables
                </button>
            </div>

            {tablesError !== null && (
                <p data-testid="db-tables-error" role="alert">
                    {tablesError}
                </p>
            )}

            {tables !== null && (
                <ul data-testid="db-table-list">
                    {tables.map((tableInfo) => (
                        <li key={tableInfo.name}>
                            <button
                                aria-pressed={selectedTable === tableInfo.name}
                                data-testid={`db-table-${tableInfo.name}`}
                                onClick={() => {
                                    selectTable(tableInfo.name);
                                }}
                                type="button"
                            >
                                {tableInfo.name} ({tableInfo.rowCount})
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {pageError !== null && (
                <p data-testid="db-page-error" role="alert">
                    {pageError}
                </p>
            )}

            {page !== null && (
                <div data-testid="db-page">
                    <div data-testid="db-view-toggle">
                        <button
                            aria-pressed={viewMode === "table"}
                            data-testid="db-view-table"
                            onClick={() => {
                                setViewMode("table");
                            }}
                            type="button"
                        >
                            Table
                        </button>
                        <button
                            aria-pressed={viewMode === "json"}
                            data-testid="db-view-json"
                            onClick={() => {
                                setViewMode("json");
                            }}
                            type="button"
                        >
                            JSON
                        </button>
                        <button
                            data-testid="db-refresh"
                            onClick={() => {
                                goToPage(offset);
                            }}
                            type="button"
                        >
                            Refresh
                        </button>
                        <LiveToggle live={live} liveError={liveError} onToggle={toggle} prefix="db" />
                        <input
                            aria-label="Search rows"
                            data-testid="db-filter"
                            onChange={(event) => {
                                setFilter(event.target.value);
                            }}
                            placeholder="search table…"
                            value={filter}
                        />
                        {editable && (
                            <button
                                data-testid="db-add-row"
                                onClick={() => {
                                    setWriteError(null);
                                    setEditing({ docText: "{}", id: "" });
                                }}
                                type="button"
                            >
                                Add row
                            </button>
                        )}
                    </div>

                    {editable && editing !== null && (
                        <div data-testid="db-editor">
                            <textarea
                                aria-label="Row document JSON"
                                data-testid="db-editor-doc"
                                onChange={(event) => {
                                    setEditing({ docText: event.target.value, id: editing.id });
                                }}
                                value={editing.docText}
                            />
                            <button
                                data-testid="db-editor-save"
                                onClick={() => {
                                    void writeRow(editing.id === "" ? "insert" : "patch", editing.id === "" ? null : editing.id, editing.docText);
                                }}
                                type="button"
                            >
                                Save
                            </button>
                            <button
                                data-testid="db-editor-cancel"
                                onClick={() => {
                                    setEditing(null);
                                    setWriteError(null);
                                }}
                                type="button"
                            >
                                Cancel
                            </button>
                        </div>
                    )}

                    {writeError !== null && (
                        <p data-testid="db-write-error" role="alert">
                            {writeError}
                        </p>
                    )}

                    {viewMode === "table" && (
                        <div data-testid="db-scroll" ref={scrollRef} style={SCROLL_STYLE}>
                            <table data-testid="db-rows" style={ROWS_STYLE}>
                                <thead>
                                    <tr>
                                        {table.getFlatHeaders().map((header) => (
                                            <th key={header.id}>
                                                <button
                                                    data-testid={`db-sort-${header.column.id}`}
                                                    onClick={header.column.getToggleSortingHandler()}
                                                    type="button"
                                                >
                                                    {flexRender(header.column.columnDef.header, header.getContext())}
                                                    {sortIndicator(header.column.getIsSorted())}
                                                </button>
                                            </th>
                                        ))}
                                        {editable && <th aria-label="Row actions" />}
                                    </tr>
                                </thead>
                                <tbody style={tbodyStyle}>{virtualRows.map((virtualRow) => renderRow(virtualRow))}</tbody>
                            </table>
                        </div>
                    )}

                    {viewMode === "json" && <pre data-testid="db-json">{JSON.stringify(page.rows, null, 2)}</pre>}

                    <div>
                        <button
                            data-testid="db-prev"
                            disabled={!hasPrevious}
                            onClick={() => {
                                goToPage(offset - pageSize);
                            }}
                            type="button"
                        >
                            Previous
                        </button>
                        <span data-testid="db-page-info">{`${rangeStart}-${rangeEnd} of ${total}`}</span>
                        <button
                            data-testid="db-next"
                            disabled={!hasNext}
                            onClick={() => {
                                goToPage(offset + pageSize);
                            }}
                            type="button"
                        >
                            Next
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
