import { useCirrus } from "@cirrus/react";
import type { SortingState } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BulkDeleteResult, TableInfo, TablePage, WriteRowResult } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import type { DataBrowserTableModel, TableRow } from "./data-browser-grid";
import { rowId, useDataBrowserTable } from "./data-browser-grid";
import type { EditableFilter } from "./data-filters";
import { toFilterClauses } from "./data-filters";
import { adminRef, callOptions, fireAndForget } from "./internal";
import { recordShard } from "./shard-history";
import type { StagedChange, StagedEditsModel } from "./staged-edits";
import { useStagedEdits } from "./staged-edits";
import useDebounced from "./use-debounced";
import useLiveAdmin from "./use-live-admin";
import { useLiveToggle } from "./use-live-toggle";

/**
 * Convert TanStack's sorting state into the `readTablePage` `orderBy` arg. The
 * grid sorts by a single column, so only the first sort entry is used; an empty
 * state (no active sort) maps to `undefined` → the server's natural order.
 */
const toOrderBy = (sorting: SortingState): undefined | { column: string; direction: "asc" | "desc" } => {
    const first = sorting[0];

    return first === undefined ? undefined : { column: first.id, direction: first.desc ? "desc" : "asc" };
};

/**
 * Hard ceiling on the number of bounded server `deleteRows`/`clearTable` calls
 * one bulk action loops through, so "delete matching" / "clear table" can never
 * run unbounded. Each call deletes up to the server's per-call cap (500 rows)
 * and reports `hasMore`; the client loops the single round-trip — never per-row.
 */
const MAX_BULK_DELETE_BATCHES = 200;

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

/** Everything {@link useDataBrowser} exposes to the `DataBrowser` render. */
interface DataBrowserModel {
    addRow: () => void;
    bulkDelete: () => void;
    cancelCellEdit: () => void;
    cancelEdit: () => void;
    changePageSize: (size: number) => void;
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
    jumpToPage: (page: number) => void;
    live: boolean;
    liveError: string | undefined;
    loadTables: () => void;
    navigateToRef: (target: string, id: string) => void;
    onBulkDeleteSelected: (ids: ReadonlyArray<string>) => void;
    onCommitStaged: () => void;
    onFilterChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onFiltersChange: (filters: EditableFilter[]) => void;
    onRowDelete: (id: null | string) => void;
    onRowEdit: (id: null | string, original: TableRow) => void;
    page: TablePage | null;
    pageError: null | string;
    pageSize: number;
    rangeEnd: number;
    rangeStart: number;
    refreshPage: () => void;
    saveEdit: () => void;
    selectedTable: null | string;
    selectTable: (table: string) => void;
    setEditorDocumentText: (text: string) => void;
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
 * unchanged — the component is now just markup wiring.
 */
const useDataBrowser = ({ initialShardKey, pageSize: initialPageSize }: { initialShardKey: string | undefined; pageSize: number }): DataBrowserModel => {
    const client = useCirrus();

    // Rows-per-page is user-adjustable (the pagination footer's selector); the
    // prop seeds the initial value. Changing it re-fetches the first page.
    const [pageSize, setPageSize] = useState<number>(initialPageSize);

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

    // Sorting is server-side: `fetchPage` reads the current sort off this ref (so
    // it need not thread through every call site) and an effect re-fetches from
    // offset 0 when it changes, mirroring the filters handling.
    const sortingRef = useRef<SortingState>(sorting);

    sortingRef.current = sorting;

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
    const [loaded, setLoaded] = useState<null | {
        filters: EditableFilter[];
        offset: number;
        pageSize: number;
        search: string;
        shard: string;
        sort: SortingState;
        table: string;
    }>(null);

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
            const activeSort = sortingRef.current;

            try {
                const result = (await client.query(
                    READ_TABLE_PAGE,
                    {
                        filters: toFilterClauses(activeFilters),
                        limit: pageSize,
                        offset: nextOffset,
                        orderBy: toOrderBy(activeSort),
                        search: searchQuery,
                        table,
                    },
                    callOptions(shard),
                )) as TablePage;

                setPage(result);
                setOffset(nextOffset);
                setLoaded({ filters: activeFilters, offset: nextOffset, pageSize, search: searchQuery, shard, sort: activeSort, table });
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
            orderBy: toOrderBy(loaded?.sort ?? []),
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

    // Re-run from offset 0 when the sort changes for the loaded table — sorting is
    // server-side, so a header click re-fetches the whole table in the new order
    // rather than reordering only the loaded page. Same shape as the filters effect.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- reacting to a changed sort (a value, not a discrete event) is the correct pattern, mirroring the filters effect above.
        if (selectedTable === null || loaded === null || loaded.sort === sorting) {
            return;
        }

        fireAndForget(fetchPage(shardKey, selectedTable, 0, search));
    }, [sorting, selectedTable, shardKey, loaded, search, fetchPage]);

    // Re-run from offset 0 when the rows-per-page changes for the loaded table —
    // the window size changed, so the current offset may no longer be valid. Same
    // guarded shape as the sort/filter effects (`loaded.pageSize` tracks the size
    // the page was fetched at, so a table switch doesn't double-fetch).
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- reacting to a changed page size (a value, not a discrete event) is the correct pattern, mirroring the sort/filter effects above.
        if (selectedTable === null || loaded === null || loaded.pageSize === pageSize) {
            return;
        }

        fireAndForget(fetchPage(shardKey, selectedTable, 0, search));
    }, [pageSize, selectedTable, shardKey, loaded, search, fetchPage]);

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

        // Seed the insert form with the table's editable columns (blank values) so
        // the form has fields to fill — instead of an empty `{}` the user must type
        // into. Meta columns (id / _creationTime / __doc__) are server-managed.
        const seed: Record<string, unknown> = {};

        for (const column of page?.columns ?? []) {
            if (!META_COLUMNS.has(column)) {
                seed[column] = "";
            }
        }

        setEditing({ docText: JSON.stringify(seed, null, 2), id: "" });
    }, [page?.columns]);

    const setEditorDocumentText = useCallback((text: string): void => {
        setEditing((current) => (current === null ? current : { docText: text, id: current.id }));
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

    // Jump to a 1-based page: translate to an offset at the current page size. The
    // footer clamps the input, but floor at 0 defensively.
    const jumpToPage = useCallback(
        (targetPage: number): void => {
            goToPage(Math.max(0, (targetPage - 1) * pageSize));
        },
        [goToPage, pageSize],
    );

    // Change rows-per-page; the guarded effect above re-fetches the first page at
    // the new size.
    const changePageSize = useCallback((size: number): void => {
        setPageSize(size);
        setOffset(0);
    }, []);

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
        changePageSize,
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
        jumpToPage,
        live,
        liveError,
        loadTables,
        navigateToRef,
        onBulkDeleteSelected,
        onCommitStaged,
        onFilterChange,
        onFiltersChange: setFilters,
        onRowDelete,
        onRowEdit,
        page,
        pageError,
        pageSize,
        rangeEnd,
        rangeStart,
        refreshPage,
        saveEdit,
        selectedTable,
        selectTable,
        setEditorDocumentText,
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

export type { DataBrowserModel };
export { useDataBrowser };
