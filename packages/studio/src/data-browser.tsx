import { useCirrus } from "@cirrus/react";
import type { SortingState } from "@tanstack/react-table";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BulkDeleteResult, TableInfo, TablePage, WriteRowResult } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { EmptyState } from "./components/ui/empty-state";
import { ConfirmButton } from "./confirm-button";
import type { DataBrowserTableModel, GridEdit, TableRow } from "./data-browser-grid";
import { DataBrowserTableView, rowId, useDataBrowserTable } from "./data-browser-grid";
import type { EditableFilter } from "./data-filters";
import { DataFilters, toFilterClauses } from "./data-filters";
import { GridPagination, TableListSidebar } from "./data-grid";
import { CellDetailDialog, GridActionsBar } from "./grid-features";
import { adminRef, callOptions, fireAndForget } from "./internal";
import { LiveToggle } from "./live-toggle";
import { RowDetailDrawer } from "./row-detail";
import { recordShard } from "./shard-history";
import { ShardInput } from "./shard-input";
import type { StagedChange, StagedEditsModel } from "./staged-edits";
import { StagedDiffPanel, useStagedEdits } from "./staged-edits";
import { StorageTierBadge } from "./storage-tier";
import useDebounced from "./use-debounced";
import useLiveAdmin from "./use-live-admin";
import { useLiveToggle } from "./use-live-toggle";

interface DataBrowserProps {
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

/** Hoisted empty table list — a stable reference for the "no tables yet" sidebar (avoids a fresh `[]` literal in JSX). */
const NO_TABLES: ReadonlyArray<TableInfo> = [];

/**
 * Hard ceiling on the number of bounded server `deleteRows`/`clearTable` calls
 * one bulk action loops through, so "delete matching" / "clear table" can never
 * run unbounded. Each call deletes up to the server's per-call cap (500 rows)
 * and reports `hasMore`; the client loops the single round-trip — never per-row.
 */
const MAX_BULK_DELETE_BATCHES = 200;

/** Shared Supabase-style control-button class for the toolbar actions. */
const CONTROL_BTN =
    "inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-accent-foreground";

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);
const WRITE_ROW = adminRef(ADMIN_FUNCTIONS.writeRow);
const DELETE_ROWS = adminRef(ADMIN_FUNCTIONS.deleteRows);
const CLEAR_TABLE = adminRef(ADMIN_FUNCTIONS.clearTable);

/**
 * Columns that are never inline-editable: the primary-key aliases, the creation
 * timestamp, and the raw `__doc__` blob. Everything else is a user doc field and
 * can be edited in place (the edit stages a patch of just that field).
 */
const META_COLUMNS = new Set<string>(["__doc__", "__id__", "_creationTime", "_id", "id"]);

/**
 * The editable document for a row. Shard rows keep their fields in a `__doc__`
 * JSON column; when present we parse it, otherwise we fall back to the row's own
 * non-meta columns. Used to prefill the edit form.
 */
const rowDocument = (row: TableRow): Record<string, unknown> => {
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

    const fields: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        if (!META_COLUMNS.has(key)) {
            fields[key] = value;
        }
    }

    return fields;
};

/**
 * The table-list sidebar header: the storage-tier badge and the shard-key picker,
 * stacked for the narrow full-height rail. The table list auto-loads for the
 * (debounced) shard key — no manual "Load tables" button — with the sidebar's
 * refresh icon for an on-demand re-fetch. Presentational: the parent owns the
 * shard-key state.
 */
const DataBrowserSidebarHeader = ({ onShardChange, shardKey }: { onShardChange: (value: string) => void; shardKey: string }): ReactElement => (
    <div className="flex shrink-0 flex-col items-start gap-2 border-b border-border p-3">
        <StorageTierBadge tier="shard" />
        <ShardInput onChange={onShardChange} testId="db-shard-input" value={shardKey} />
    </div>
);

/**
 * The page's view toggle / refresh / live / search / add-row controls. All state
 * lives in the parent; this component is purely the control bar markup.
 */
const DataBrowserViewControls = ({
    columns,
    editable,
    filter,
    filters,
    live,
    liveError,
    onAddRow,
    onBulkDelete,
    onClearTable,
    onFilterChange,
    onFiltersChange,
    onRefresh,
    onShowJson,
    onShowTable,
    onToggleLive,
    total,
    viewMode,
}: {
    columns: string[];
    editable: boolean;
    filter: string;
    filters: EditableFilter[];
    live: boolean;
    liveError: string | undefined;
    onAddRow: () => void;
    onBulkDelete: () => void;
    onClearTable: () => void;
    onFilterChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onFiltersChange: (filters: EditableFilter[]) => void;
    onRefresh: () => void;
    onShowJson: () => void;
    onShowTable: () => void;
    onToggleLive: () => void;
    total: number;
    viewMode: "json" | "table";
}): ReactElement => (
    <div className="flex flex-col gap-2" data-testid="db-view-toggle">
        <div className="flex flex-wrap items-center gap-1.5">
            <button aria-pressed={viewMode === "table"} className={CONTROL_BTN} data-testid="db-view-table" onClick={onShowTable} type="button">
                Table
            </button>
            <button aria-pressed={viewMode === "json"} className={CONTROL_BTN} data-testid="db-view-json" onClick={onShowJson} type="button">
                JSON
            </button>
            <button className={CONTROL_BTN} data-testid="db-refresh" onClick={onRefresh} type="button">
                Refresh
            </button>
            <LiveToggle live={live} liveError={liveError} onToggle={onToggleLive} prefix="db" />
            {editable && (
                <button className={CONTROL_BTN} data-testid="db-add-row" onClick={onAddRow} type="button">
                    Add row
                </button>
            )}
            {editable && total > 0 && (filter !== "" || filters.length > 0) && (
                <ConfirmButton confirmLabel={`Delete ${total.toString()} matching?`} onConfirm={onBulkDelete} testId="db-bulk-delete">
                    {`Delete ${total.toString()} matching`}
                </ConfirmButton>
            )}
            {editable && total > 0 && filter === "" && filters.length === 0 && (
                <ConfirmButton confirmLabel={`Clear all ${total.toString()} rows?`} onConfirm={onClearTable} testId="db-clear-table">
                    {`Clear table (${total.toString()})`}
                </ConfirmButton>
            )}
        </div>
        <DataFilters columns={columns} filters={filters} onFiltersChange={onFiltersChange} onSearchChange={onFilterChange} search={filter} />
    </div>
);

/**
 * The JSON-doc row editor (textarea + Save/Cancel). The parent owns the draft
 * text and the save/cancel handlers.
 */
const DataBrowserRowEditor = ({
    docText,
    onCancel,
    onDocumentChange,
    onSave,
}: {
    docText: string;
    onCancel: () => void;
    onDocumentChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onSave: () => void;
}): ReactElement => (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3" data-testid="db-editor">
        <textarea
            aria-label="Row document JSON"
            className="min-h-28 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:border-ring"
            data-testid="db-editor-doc"
            onChange={onDocumentChange}
            value={docText}
        />
        <div className="flex items-center gap-1.5">
            <button className={CONTROL_BTN} data-testid="db-editor-save" onClick={onSave} type="button">
                Save
            </button>
            <button className={CONTROL_BTN} data-testid="db-editor-cancel" onClick={onCancel} type="button">
                Cancel
            </button>
        </div>
    </div>
);

/** Everything {@link useDataBrowser} exposes to the {@link DataBrowser} render. */
interface DataBrowserModel {
    addRow: () => void;
    bulkDelete: () => void;
    cancelCellEdit: () => void;
    cancelEdit: () => void;
    clearTable: () => void;
    columns: string[];
    committing: boolean;
    discardStaged: () => void;
    editableColumn: (column: string) => boolean;
    editing: null | { docText: string; id: null | string };
    editingCell: null | { column: string; rowId: string };
    filter: string;
    filters: EditableFilter[];
    goNext: () => void;
    goPrevious: () => void;
    hasNext: boolean;
    hasPrevious: boolean;
    live: boolean;
    liveError: string | undefined;
    loadTables: () => void;
    navigateToRef: (target: string, id: string) => void;
    onBulkDeleteSelected: (ids: ReadonlyArray<string>) => void;
    onCommitStaged: () => void;
    onEditorDocumentChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
    onFilterChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onFiltersChange: (filters: EditableFilter[]) => void;
    onRowDelete: (id: null | string) => void;
    onRowEdit: (id: null | string, original: TableRow) => void;
    page: TablePage | null;
    pageError: null | string;
    rangeEnd: number;
    rangeStart: number;
    refreshPage: () => void;
    saveEdit: () => void;
    selectedTable: null | string;
    selectTable: (table: string) => void;
    setShardKey: (value: string) => void;
    shardKey: string;
    showJson: () => void;
    showTable: () => void;
    stage: StagedEditsModel["stage"];
    stagedChanges: StagedChange[];
    stagedValue: StagedEditsModel["stagedValue"];
    startCellEdit: (rowId: string, column: string) => void;
    table: DataBrowserTableModel;
    tables: TableInfo[] | null;
    tablesError: null | string;
    toggleLive: () => void;
    total: number;
    viewMode: "json" | "table";
    writeError: null | string;
}

/**
 * All non-render state and handlers for the data browser: the admin RPC reads
 * (`listTables` / `readTablePage`), the live subscriptions, the schema-aware
 * writes, page-local sorting/search, and the derived pagination range. Composes
 * {@link useDataBrowserTable} for the headless table model. Extracted verbatim
 * from the component so behavior, fetch sequencing, and effect dependencies are
 * unchanged — the component below is now just markup wiring.
 */
const useDataBrowser = ({ initialShardKey, pageSize }: { initialShardKey: string | undefined; pageSize: number }): DataBrowserModel => {
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

    // The shard key the table list is fetched for, debounced so typing a key
    // auto-loads its tables once the input settles rather than firing per
    // keystroke — replacing the old manual "Load tables" button.
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    // Structured column filters. Held in a ref too so `fetchPage` reads the
    // current value without threading them through its five call sites; an effect
    // re-fetches from offset 0 when they change (mirroring the debounced search).
    const [filters, setFilters] = useState<EditableFilter[]>([]);
    const filtersRef = useRef<EditableFilter[]>(filters);

    filtersRef.current = filters;

    // Edit state: the row being edited (its id, or `""` for a new insert) and
    // the JSON-doc draft. `null` when no editor is open. `writeError` surfaces a
    // rejected write without disturbing the page-read error.
    const [editing, setEditing] = useState<null | { docText: string; id: null | string }>(null);
    const [writeError, setWriteError] = useState<null | string>(null);

    // Inline-edit state: the staged-edit buffer, the cell currently open for
    // editing, and whether a batch commit is in flight. Edits accumulate in
    // `stagedEdits` (Outerbase-style) until committed or discarded.
    const stagedEdits = useStagedEdits();
    const [editingCell, setEditingCell] = useState<null | { column: string; rowId: string }>(null);
    const [committing, setCommitting] = useState<boolean>(false);

    const { live, liveError, setLiveError, toggle } = useLiveToggle();

    // The page descriptor the live channel tracks. Set only when a page actually
    // loads (in fetchPage), so the live subscription follows what's displayed —
    // not the shard-key input as it's typed, nor a table selection whose offset
    // reset hasn't landed yet. Keyed independently of `shardKey`/`offset` state.
    const [loaded, setLoaded] = useState<null | { filters: EditableFilter[]; offset: number; search: string; shard: string; table: string }>(null);

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
        async (shard: string, table: string, nextOffset: number, searchQuery: string): Promise<void> => {
            setPageError(null);

            const activeFilters = filtersRef.current;

            try {
                const result = (await client.query(
                    READ_TABLE_PAGE,
                    { filters: toFilterClauses(activeFilters), limit: pageSize, offset: nextOffset, search: searchQuery, table },
                    callOptions(shard),
                )) as TablePage;

                setPage(result);
                setOffset(nextOffset);
                setLoaded({ filters: activeFilters, offset: nextOffset, search: searchQuery, shard, table });
            } catch (error) {
                setPage(null);
                setPageError((error as Error).message);
            }
        },
        [client, pageSize],
    );

    // Auto-load the table list for the (debounced) shard key. Fires once on mount
    // for the initial shard and again whenever the typed shard key settles, so the
    // tables appear without a manual trigger; the debounce keeps a half-typed key
    // from firing a request per keystroke. A manual refresh icon (see `loadTables`)
    // re-fetches on demand.
    useEffect(() => {
        fireAndForget(fetchTables(debouncedShard));
    }, [fetchTables, debouncedShard]);

    // Live channel: while toggled on, the server re-pushes the loaded window
    // whenever its table is written (dependency-scoped to that table). Keyed on
    // the `loaded` descriptor so it tracks exactly the displayed shard/table/page
    // — never a half-typed shard key or a table switch whose offset reset is
    // still pending — and only runs once a page has actually loaded.
    useLiveAdmin(
        ADMIN_FUNCTIONS.readTablePage,
        {
            filters: toFilterClauses(loaded?.filters ?? []),
            limit: pageSize,
            offset: loaded?.offset ?? 0,
            search: loaded?.search ?? "",
            table: loaded?.table ?? "",
        },
        loaded?.shard ?? "",
        (result) => {
            setPageError(null);
            setLiveError(undefined);
            setPage(result as TablePage);
        },
        live && loaded !== null,
        setLiveError,
    );

    // Live channel for the table list itself, so a migration that creates a
    // table (or changes a row count) reflects without a manual "Load tables".
    // `listTables` is shard-scoped; key it on the loaded shard so it follows the
    // same shard as the page rather than the shard-input box as it's typed.
    useLiveAdmin(
        ADMIN_FUNCTIONS.listTables,
        {},
        loaded?.shard ?? "",
        (result) => {
            setTablesError(null);
            setLiveError(undefined);
            setTables(result as TableInfo[]);
        },
        live && loaded !== null,
        setLiveError,
    );

    const selectTable = useCallback(
        (table: string): void => {
            // A fresh table means the previous sort/search/filters/staged edits no longer apply.
            setSorting([]);
            setFilter("");
            setFilters([]);
            filtersRef.current = [];
            stagedEdits.clear();
            setEditingCell(null);
            setSelectedTable(table);
            fireAndForget(fetchPage(shardKey, table, 0, ""));
        },
        [fetchPage, shardKey, stagedEdits],
    );

    // Follow a foreign-key cell: switch to the target table and search for the
    // referenced id (the row's primary key shows in the `id` column), so an
    // operator can traverse relations by clicking instead of copy-pasting ids.
    const navigateToRef = useCallback(
        (targetTable: string, id: string): void => {
            setSorting([]);
            setFilters([]);
            filtersRef.current = [];
            setSelectedTable(targetTable);
            setFilter(id);
            // Seed the page immediately with the search applied; the debounced
            // effect would otherwise fire a second time with the same value.
            fireAndForget(fetchPage(shardKey, targetTable, 0, id));
        },
        [fetchPage, shardKey],
    );

    const goToPage = useCallback(
        (nextOffset: number): void => {
            if (selectedTable === null) {
                return;
            }

            fireAndForget(fetchPage(shardKey, selectedTable, Math.max(0, nextOffset), search));
        },
        [fetchPage, search, selectedTable, shardKey],
    );

    // ── Inline cell editing → staged buffer → preview-diff → commit ──────────
    const editableColumn = useCallback((column: string): boolean => !META_COLUMNS.has(column), []);

    const startCellEdit = useCallback((targetRow: string, column: string): void => {
        setEditingCell({ column, rowId: targetRow });
    }, []);

    const cancelCellEdit = useCallback((): void => {
        setEditingCell(null);
    }, []);

    // Commit every staged cell edit as a per-row patch (the writer merges the
    // changed fields into the existing doc), then reload the page and clear the
    // buffer. Sequential so a failure pins the offending row.
    const commitStaged = useCallback(async (): Promise<void> => {
        if (selectedTable === null) {
            return;
        }

        setWriteError(null);
        setCommitting(true);

        try {
            for (const [id, columns] of Object.entries(stagedEdits.staged)) {
                // eslint-disable-next-line no-await-in-loop -- one patch per edited row; sequential so a failure pins the offending row
                (await client.query(WRITE_ROW, { doc: columns, id, op: "patch", table: selectedTable }, callOptions(shardKey))) as WriteRowResult;
            }

            stagedEdits.clear();
            setEditingCell(null);
            await fetchPage(shardKey, selectedTable, offset, search);
        } catch (error) {
            setWriteError((error as Error).message);
        } finally {
            setCommitting(false);
        }
    }, [client, fetchPage, offset, search, selectedTable, shardKey, stagedEdits]);

    const discardStaged = useCallback((): void => {
        stagedEdits.clear();
        setEditingCell(null);
    }, [stagedEdits]);

    // Resolve the staged buffer against the loaded page for the old→new diff.
    const stagedChanges = useMemo<StagedChange[]>(() => {
        const rowsById = new Map<string, TableRow>();

        for (const row of page?.rows ?? []) {
            const id = rowId(row);

            if (id !== null) {
                rowsById.set(id, row);
            }
        }

        const changes: StagedChange[] = [];

        for (const [id, columns] of Object.entries(stagedEdits.staged)) {
            for (const [column, newValue] of Object.entries(columns)) {
                changes.push({ column, newValue, oldValue: rowsById.get(id)?.[column], rowId: id });
            }
        }

        return changes;
    }, [page, stagedEdits.staged]);

    // Re-run the server-side search (from offset 0) when the debounced query
    // changes for the loaded table. Skipped until a table is selected, and when
    // the debounced value already matches what's loaded (e.g. right after a
    // table switch cleared it) so it doesn't double-fetch.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- `search` is a debounced value that updates asynchronously (not on a discrete event), so reacting to its change in an effect is the correct pattern.
        if (selectedTable === null || loaded === null || loaded.search === search) {
            return;
        }

        fireAndForget(fetchPage(shardKey, selectedTable, 0, search));
    }, [search, selectedTable, shardKey, loaded, fetchPage]);

    // Re-run from offset 0 when the structured filters change for the loaded
    // table — same shape as the debounced-search effect above. `fetchPage` reads
    // the live `filtersRef`, so the new clauses apply immediately.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- reacting to a changed filter set (a value, not a discrete event) is the correct pattern, mirroring the debounced-search effect above.
        if (selectedTable === null || loaded === null || loaded.filters === filters) {
            return;
        }

        fireAndForget(fetchPage(shardKey, selectedTable, 0, search));
    }, [filters, selectedTable, shardKey, loaded, search, fetchPage]);

    // Issue a writeRow op then reload the current page so the change shows. A
    // delete passes no doc; insert (id === "") / patch carry the JSON draft.
    const writeRow = useCallback(
        async (op: "delete" | "insert" | "patch", id: null | string, documentText?: string): Promise<void> => {
            if (selectedTable === null) {
                return;
            }

            setWriteError(null);

            let parsedDocument: Record<string, unknown> | undefined;

            if (op !== "delete") {
                try {
                    parsedDocument = documentText === undefined || documentText.trim() === "" ? {} : (JSON.parse(documentText) as Record<string, unknown>);
                } catch (error) {
                    setWriteError(`Invalid JSON: ${(error as Error).message}`);

                    return;
                }
            }

            try {
                (await client.query(
                    WRITE_ROW,
                    { doc: parsedDocument, id: id ?? undefined, op, table: selectedTable },
                    callOptions(shardKey),
                )) as WriteRowResult;
                setEditing(null);
                await fetchPage(shardKey, selectedTable, offset, search);
            } catch (error) {
                setWriteError((error as Error).message);
            }
        },
        [client, fetchPage, offset, search, selectedTable, shardKey],
    );

    // Drain a server bulk-delete op (`deleteRows` with a predicate, or
    // `clearTable` with none) by looping a single bounded round-trip while it
    // reports `hasMore` — replacing the old N+1 read-then-delete-per-id loop. The
    // server collects the matching ids and removes each THROUGH the schema-aware
    // writer (so FTS / aggregate / rank shadow tables stay in sync), capped per
    // call; the loop is bounded by `MAX_BULK_DELETE_BATCHES` so it can never run
    // unbounded. Sequential by design: each call's deletes shrink the set the
    // next read sees, so the round-trips can't be parallelised.
    const drainBulk = useCallback(
        async (ref: typeof DELETE_ROWS, args: Record<string, unknown>): Promise<void> => {
            if (selectedTable === null) {
                return;
            }

            setWriteError(null);

            try {
                for (let batch = 0; batch < MAX_BULK_DELETE_BATCHES; batch += 1) {
                    // eslint-disable-next-line no-await-in-loop -- batches are inherently sequential (each call reflects the prior batch's deletes)
                    const result = (await client.query(ref, args, callOptions(shardKey))) as BulkDeleteResult;

                    if (!result.hasMore) {
                        break;
                    }
                }

                await fetchPage(shardKey, selectedTable, 0, search);
            } catch (error) {
                setWriteError((error as Error).message);
            }
        },
        [client, fetchPage, search, selectedTable, shardKey],
    );

    // Headless table model + virtualizer for the loaded page. The page-local
    // `sorting` state stays here (table switches reset it via `setSorting`); the
    // hook owns only the derived react-table/virtualizer wiring.
    const table = useDataBrowserTable(page, sorting, setSorting);

    const total = page?.total ?? 0;
    const hasPrevious = offset > 0;
    const hasNext = page !== null && offset + page.rows.length < total;
    const rangeStart = page === null || page.rows.length === 0 ? 0 : offset + 1;
    const rangeEnd = page === null ? 0 : offset + page.rows.length;

    const loadTables = useCallback((): void => {
        fireAndForget(fetchTables(shardKey));
    }, [fetchTables, shardKey]);

    const showTable = useCallback((): void => {
        setViewMode("table");
    }, []);

    const showJson = useCallback((): void => {
        setViewMode("json");
    }, []);

    const refreshPage = useCallback((): void => {
        goToPage(offset);
    }, [goToPage, offset]);

    const bulkDelete = useCallback((): void => {
        fireAndForget(drainBulk(DELETE_ROWS, { filters: toFilterClauses(filtersRef.current), search, table: selectedTable }));
    }, [drainBulk, search, selectedTable]);

    const emptyTable = useCallback((): void => {
        fireAndForget(drainBulk(CLEAR_TABLE, { table: selectedTable }));
    }, [drainBulk, selectedTable]);

    const onFilterChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
        setFilter(event.target.value);
    }, []);

    const addRow = useCallback((): void => {
        setWriteError(null);
        setEditing({ docText: "{}", id: "" });
    }, []);

    const onEditorDocumentChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        setEditing((current) => (current === null ? current : { docText: event.target.value, id: current.id }));
    }, []);

    const saveEdit = useCallback((): void => {
        if (editing === null) {
            return;
        }

        fireAndForget(writeRow(editing.id === "" ? "insert" : "patch", editing.id === "" ? null : editing.id, editing.docText));
    }, [editing, writeRow]);

    const cancelEdit = useCallback((): void => {
        setEditing(null);
        setWriteError(null);
    }, []);

    const goPrevious = useCallback((): void => {
        goToPage(offset - pageSize);
    }, [goToPage, offset, pageSize]);

    const goNext = useCallback((): void => {
        goToPage(offset + pageSize);
    }, [goToPage, offset, pageSize]);

    const onRowEdit = useCallback((id: null | string, original: TableRow): void => {
        setWriteError(null);
        setEditing({ docText: JSON.stringify(rowDocument(original), null, 2), id });
    }, []);

    const onRowDelete = useCallback(
        (id: null | string): void => {
            fireAndForget(writeRow("delete", id));
        },
        [writeRow],
    );

    // Delete an explicit set of selected row ids (the checkbox selection), each
    // through the schema-aware writer so FTS / aggregate / rank shadow tables stay
    // in sync, then reload the page. Sequential so a failure pins the offending
    // row; the selection is page-bounded (≤ pageSize), so this never fans out
    // unboundedly the way a predicate delete could.
    const deleteSelected = useCallback(
        async (ids: ReadonlyArray<string>): Promise<void> => {
            if (selectedTable === null || ids.length === 0) {
                return;
            }

            setWriteError(null);

            try {
                for (const id of ids) {
                    // eslint-disable-next-line no-await-in-loop -- one delete per selected row; sequential so a failure pins the offending row
                    (await client.query(WRITE_ROW, { id, op: "delete", table: selectedTable }, callOptions(shardKey))) as WriteRowResult;
                }

                await fetchPage(shardKey, selectedTable, offset, search);
            } catch (error) {
                setWriteError((error as Error).message);
            }
        },
        [client, fetchPage, offset, search, selectedTable, shardKey],
    );

    const onBulkDeleteSelected = useCallback(
        (ids: ReadonlyArray<string>): void => {
            fireAndForget(deleteSelected(ids));
        },
        [deleteSelected],
    );

    const onCommitStaged = useCallback((): void => {
        fireAndForget(commitStaged());
    }, [commitStaged]);

    return {
        addRow,
        bulkDelete,
        cancelCellEdit,
        cancelEdit,
        clearTable: emptyTable,
        columns: page?.columns ?? [],
        committing,
        discardStaged,
        editableColumn,
        editing,
        editingCell,
        filter,
        filters,
        goNext,
        goPrevious,
        hasNext,
        hasPrevious,
        live,
        liveError,
        loadTables,
        navigateToRef,
        onBulkDeleteSelected,
        onCommitStaged,
        onEditorDocumentChange,
        onFilterChange,
        onFiltersChange: setFilters,
        onRowDelete,
        onRowEdit,
        page,
        pageError,
        rangeEnd,
        rangeStart,
        refreshPage,
        saveEdit,
        selectedTable,
        selectTable,
        setShardKey,
        shardKey,
        showJson,
        showTable,
        stage: stagedEdits.stage,
        stagedChanges,
        stagedValue: stagedEdits.stagedValue,
        startCellEdit,
        table,
        tables,
        tablesError,
        toggleLive: toggle,
        total,
        viewMode,
        writeError,
    };
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
 * touches the server — pagination still flows through `readTablePage`. All of
 * that state lives in {@link useDataBrowser}; this component is just the markup.
 */
export const DataBrowser = ({ editable = false, initialShardKey, pageSize = DEFAULT_PAGE_SIZE }: DataBrowserProps): ReactElement => {
    const {
        addRow,
        bulkDelete,
        cancelCellEdit,
        cancelEdit,
        clearTable,
        columns,
        committing,
        discardStaged,
        editableColumn,
        editing,
        editingCell,
        filter,
        filters,
        goNext,
        goPrevious,
        hasNext,
        hasPrevious,
        live,
        liveError,
        loadTables,
        navigateToRef,
        onBulkDeleteSelected,
        onCommitStaged,
        onEditorDocumentChange,
        onFilterChange,
        onFiltersChange,
        onRowDelete,
        onRowEdit,
        page,
        pageError,
        rangeEnd,
        rangeStart,
        refreshPage,
        saveEdit,
        selectedTable,
        selectTable,
        setShardKey,
        shardKey,
        showJson,
        showTable,
        stage,
        stagedChanges,
        stagedValue,
        startCellEdit,
        table,
        tables,
        tablesError,
        toggleLive,
        total,
        viewMode,
        writeError,
    } = useDataBrowser({ initialShardKey, pageSize });

    // The row whose full document the detail drawer is showing, if any. Pure
    // view state — kept out of the data hook since it touches no fetch logic.
    const [inspecting, setInspecting] = useState<TableRow | null>(null);
    const closeInspect = useCallback((): void => {
        setInspecting(null);
    }, []);

    // The cell whose full value the expand dialog is showing, if any. Opened from
    // the per-cell expand affordance; pure view state like `inspecting`.
    const [expandedCell, setExpandedCell] = useState<null | { column: string; value: unknown }>(null);
    const onExpandCell = useCallback((column: string, value: unknown): void => {
        setExpandedCell({ column, value });
    }, []);
    const closeExpandedCell = useCallback((): void => {
        setExpandedCell(null);
    }, []);

    // The inline-edit context passed down to every grid cell.
    const edit = useMemo<GridEdit>(() => {
        return {
            cancelEdit: cancelCellEdit,
            editable,
            editableColumn,
            editingCell,
            onExpandCell,
            onNavigateRef: navigateToRef,
            refs: page?.refs,
            stage,
            stagedValue,
            startEdit: startCellEdit,
        };
    }, [cancelCellEdit, editable, editableColumn, editingCell, onExpandCell, navigateToRef, page?.refs, stage, stagedValue, startCellEdit]);

    return (
        <div className="flex h-full min-w-0" data-testid="cirrus-data-browser">
            <TableListSidebar
                header={<DataBrowserSidebarHeader onShardChange={setShardKey} shardKey={shardKey} />}
                onReload={loadTables}
                onSelect={selectTable}
                prefix="db"
                selected={selectedTable}
                tables={tables ?? NO_TABLES}
            />

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {tablesError !== null && (
                    <p className="shrink-0 border-b border-border px-4 py-2 text-sm text-destructive" data-testid="db-tables-error" role="alert">
                        {tablesError}
                    </p>
                )}

                {page === null && pageError === null && (
                    <div className="flex flex-1 items-center justify-center p-6">
                        <p className="text-sm text-muted-foreground">Select a table to browse its rows.</p>
                    </div>
                )}

                {pageError !== null && (
                    <p className="shrink-0 border-b border-border px-4 py-2 text-sm text-destructive" data-testid="db-page-error" role="alert">
                        {pageError}
                    </p>
                )}

                {page !== null && (
                    <div className="flex min-h-0 flex-1 flex-col" data-testid="db-page">
                        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
                            <DataBrowserViewControls
                                columns={columns}
                                editable={editable}
                                filter={filter}
                                filters={filters}
                                live={live}
                                liveError={liveError}
                                onAddRow={addRow}
                                onBulkDelete={bulkDelete}
                                onClearTable={clearTable}
                                onFilterChange={onFilterChange}
                                onFiltersChange={onFiltersChange}
                                onRefresh={refreshPage}
                                onShowJson={showJson}
                                onShowTable={showTable}
                                onToggleLive={toggleLive}
                                total={total}
                                viewMode={viewMode}
                            />

                            {viewMode === "table" && page.rows.length > 0 && (
                                <GridActionsBar
                                    columns={page.columns}
                                    editable={editable}
                                    name={selectedTable ?? "export"}
                                    onBulkDelete={onBulkDeleteSelected}
                                    rows={page.rows}
                                    table={table.table}
                                />
                            )}

                            {editable && editing !== null && (
                                <DataBrowserRowEditor
                                    docText={editing.docText}
                                    onCancel={cancelEdit}
                                    onDocumentChange={onEditorDocumentChange}
                                    onSave={saveEdit}
                                />
                            )}

                            {editable && stagedChanges.length > 0 && (
                                <StagedDiffPanel changes={stagedChanges} committing={committing} onCommit={onCommitStaged} onDiscard={discardStaged} />
                            )}

                            {writeError !== null && (
                                <p className="text-sm text-destructive" data-testid="db-write-error" role="alert">
                                    {writeError}
                                </p>
                            )}
                        </div>

                        {viewMode === "table" && page.rows.length === 0 && (
                            <div className="flex flex-1 items-center justify-center p-6">
                                <EmptyState
                                    description="Rows you insert into this table will show up here."
                                    icon={
                                        <svg
                                            aria-hidden="true"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            strokeWidth={1.6}
                                            viewBox="0 0 24 24"
                                        >
                                            <path d="M4 5h16v14H4V5Zm0 5h16M10 10v9M4 14.5h16" />
                                        </svg>
                                    }
                                    testId="db-empty-rows"
                                    title="This table is empty."
                                />
                            </div>
                        )}

                        {viewMode === "table" && page.rows.length > 0 && (
                            <DataBrowserTableView
                                edit={edit}
                                editable={editable}
                                onDelete={onRowDelete}
                                onEdit={onRowEdit}
                                onInspect={setInspecting}
                                scrollRef={table.scrollRef}
                                scrollToIndex={table.scrollToIndex}
                                table={table.table}
                                tableRows={table.tableRows}
                                tbodyStyle={table.tbodyStyle}
                                virtualRows={table.virtualRows}
                            />
                        )}

                        {viewMode === "json" && (
                            <pre className="min-h-0 flex-1 overflow-auto border-t border-border bg-muted/30 p-3 text-xs" data-testid="db-json">
                                {JSON.stringify(page.rows, null, 2)}
                            </pre>
                        )}

                        <div className="flex shrink-0 items-center border-t border-border px-4 py-2">
                            <GridPagination
                                hasNext={hasNext}
                                hasPrevious={hasPrevious}
                                onNext={goNext}
                                onPrevious={goPrevious}
                                prefix="db"
                                rangeEnd={rangeEnd}
                                rangeStart={rangeStart}
                                total={total}
                            />
                        </div>
                    </div>
                )}
            </div>

            {inspecting !== null && page !== null && (
                <RowDetailDrawer columns={page.columns} onClose={closeInspect} onNavigate={navigateToRef} refs={page.refs} row={inspecting} />
            )}

            {expandedCell !== null && <CellDetailDialog column={expandedCell.column} onClose={closeExpandedCell} value={expandedCell.value} />}
        </div>
    );
};

export type { DataBrowserProps };
