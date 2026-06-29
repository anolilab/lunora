import { useLunora } from "@lunora/react";
import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAdminQuery } from "../../../hooks/use-admin-query";
import useDebounced from "../../../hooks/use-debounced";
import type { BulkDeleteResult, FacetResult, FilterClause, TableInfo, TablePage, WriteRowResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, fireAndForget } from "../../../lib/internal";
import type { DataView } from "../../../lib/saved-queries";
import { recordShard } from "../../../lib/shard-history";
import type { DataBrowserTableModel, TableRow } from "../data-browser-grid";
import { rowId, useDataBrowserTable } from "../data-browser-grid";
import type { EditableFilter } from "../data-filters";
import { toFilterClauses } from "../data-filters";
import type { StagedChange, StagedEditsModel } from "../staged-edits";
import { useStagedEdits } from "../staged-edits";
import type { FacetFetcher, FacetState } from "./use-facets";
import { useFacets } from "./use-facets";

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
 * Coerce a clicked facet value into the string an `EditableFilter` carries (the
 * filter bar's values are strings until coerced for the wire). NULL/undefined map
 * to the empty string; objects are JSON-encoded so they don't stringify to
 * `[object Object]`.
 */
const facetValueText = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- non-object primitives stringify meaningfully; objects are handled above
    return String(value);
};

/**
 * Hydrate the filter bar from URL/saved-query {@link FilterClause}s. The inverse
 * of `toFilterClauses`: the bar's value is always a string (it re-coerces numbers
 * on the wire), so every clause value is stringified back. Objects can't appear
 * on a real clause value, but are JSON-encoded defensively.
 */
const toEditableFilters = (clauses: ReadonlyArray<FilterClause>): EditableFilter[] =>
    clauses.map((clause) => {
        return { column: clause.column, operator: clause.operator, value: clause.value === undefined ? "" : facetValueText(clause.value) };
    });

/** Translate a single-sort `orderBy` into the TanStack sorting state the grid renders. */
const fromOrderBy = (orderBy: DataView["orderBy"]): SortingState => (orderBy === undefined ? [] : [{ desc: orderBy.direction === "desc", id: orderBy.column }]);

/**
 * Hard ceiling on the number of bounded server `deleteRows`/`clearTable` calls
 * one bulk action loops through, so "delete matching" / "clear table" can never
 * run unbounded. Each call deletes up to the server's per-call cap (500 rows)
 * and reports `hasMore`; the client loops the single round-trip — never per-row.
 */
const MAX_BULK_DELETE_BATCHES = 200;

/**
 * How many rows the FK hover preview fetches to find an exact primary-key match.
 * The `search` arg is a substring match across all columns, so a handful of
 * coincidental hits may precede the real row; this window is large enough to
 * contain it while staying a single cheap read.
 */
const PREVIEW_CANDIDATES = 20;

const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);
const FACET_COLUMN = adminRef(ADMIN_FUNCTIONS.facetColumn);
const WRITE_ROW = adminRef(ADMIN_FUNCTIONS.writeRow);
const DELETE_ROWS = adminRef(ADMIN_FUNCTIONS.deleteRows);
const CLEAR_TABLE = adminRef(ADMIN_FUNCTIONS.clearTable);

/** Stable empty args for the no-argument `listTables` read (avoids a fresh object each render). */
const NO_ARGS: Record<string, unknown> = {};

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
    /** The currently-displayed view (table/shard/filters/search/sort) — for "Copy link" and "Save query". */
    currentView: DataView;
    discardStaged: () => void;
    editableColumn: (column: string) => boolean;
    editing: null | { docText: string; id: null | string };
    editingCell: null | { column: string; rowId: string };
    /** Add an `eq` filter for `column = value` (a facet-value click), appending to the active filters. */
    facetFilter: (column: string, value: unknown) => void;
    /** Per-column facet state for every toggled-on column; absent → not faceting that column. */
    facets: Record<string, FacetState>;
    filter: string;
    filters: EditableFilter[];
    goNext: () => void;
    goPrevious: () => void;
    hasNext: boolean;
    hasPrevious: boolean;
    jumpToPage: (page: number) => void;
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
    previewRef: (target: string, id: string) => Promise<Record<string, unknown> | null>;
    rangeEnd: number;
    rangeStart: number;
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
    /** Toggle a column into / out of the facet sidebar (fetches its summary when turned on). */
    toggleFacet: (column: string) => void;
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
const useDataBrowser = ({
    initialFilters,
    initialOrderBy,
    initialSearch,
    initialShardKey,
    onSelectTable,
    onViewChange,
    pageSize: initialPageSize,
    tableParam,
}: {
    /** Structured filters to hydrate from a shared link / saved query. */
    initialFilters: FilterClause[] | undefined;
    /** Sort to hydrate from a shared link / saved query. */
    initialOrderBy: DataView["orderBy"];
    /** Substring search to hydrate from a shared link / saved query. */
    initialSearch: string | undefined;
    initialShardKey: string | undefined;
    /** Called whenever the selected table changes, so the host can mirror it to the URL. */
    onSelectTable: ((table: string) => void) | undefined;

    /**
     * Called whenever the loaded view (shard / search / filters / sort) changes, so
     * the host can mirror the full view state to the URL — making every view a real,
     * shareable link. Fires only for the actually-displayed view (the `loaded`
     * descriptor), never a half-typed shard key.
     */
    onViewChange: ((view: Pick<DataView, "filters" | "orderBy" | "search" | "shard">) => void) | undefined;
    pageSize: number;
    /** The table named in the URL — drives the selection so browser back/forward works. */
    tableParam: string | undefined;
}): DataBrowserModel => {
    const client = useLunora();

    // Rows-per-page is user-adjustable (the pagination footer's selector); the
    // prop seeds the initial value. Changing it re-fetches the first page.
    const [pageSize, setPageSize] = useState<number>(initialPageSize);

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");

    // Hydrate the view from a shared link / saved query on first mount. Held in a
    // ref so the table-reconcile effect's `selectTable` can seed the page with the
    // shared filters/search/sort the first time it opens the URL's table, then
    // forget them (subsequent selections start clean). Consumed once.
    const hydrationRef = useRef<DataView | null>({ filters: initialFilters, orderBy: initialOrderBy, search: initialSearch, table: tableParam });
    const [selectedTable, setSelectedTable] = useState<null | string>(null);
    const [offset, setOffset] = useState<number>(0);
    const [viewMode, setViewMode] = useState<"json" | "table">("table");

    // Page-local sort: operates ONLY on the rows of the currently loaded page.
    // Reset whenever a new table is selected so stale state can't leak across
    // selections.
    const [sorting, setSorting] = useState<SortingState>(() => fromOrderBy(initialOrderBy));

    // Search box value. Debounced into a server-side `search` (filters across the
    // WHOLE table, not just the loaded page), which re-fetches from offset 0.
    const [filter, setFilter] = useState<string>(initialSearch ?? "");
    const search = useDebounced(filter.trim(), 300);

    // The shard the reads target, debounced so typing a key settles before
    // refetching the table list + page rather than firing per keystroke. Page-bound
    // actions (preview, facet fetch, row write/delete, bulk delete) target this same
    // settled shard so a write can never hit a different shard than the one whose
    // rows are on screen during the debounce window. The live `shardKey` is only the
    // input value + the share-link descriptor.
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    // Structured column filters. Held in a ref too so a write's bulk-delete reads
    // the current value without threading it through; the page query reads the
    // state directly via `pageArgs`.
    const [filters, setFilters] = useState<EditableFilter[]>(() => toEditableFilters(initialFilters ?? []));
    const filtersRef = useRef<EditableFilter[]>(filters);

    filtersRef.current = filters;

    // Facets (Datasette-style per-column value/count summaries): the columns the
    // operator has toggled into the facet sidebar, each with its loaded summary.
    // Opt-in per column (faceting a wide column is costly); the summaries reflect
    // the ACTIVE view and refetch when the filters/search/shard/table change. The
    // shared `useFacets` hook owns the slot transitions and toggle/refetch; only the
    // per-view query (`FACET_COLUMN` over the current shard/filters/search) is ours.
    const { clearFacets, facets, refetchFacets, toggleFacet: toggleFacetColumn } = useFacets();

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

    // ── Reads via TanStack Query: a one-shot fetch plus a live WS push into the
    // cache (the same model as every other studio panel). The table list follows
    // the debounced shard; the page read's args ARE the view, so selecting a table
    // or paginating / searching / filtering / sorting transparently refetches.
    const tablesQuery = useAdminQuery<TableInfo[]>(ADMIN_FUNCTIONS.listTables, NO_ARGS, { live: true, shardKey: debouncedShard });
    const tables = tablesQuery.data ?? null;
    const tablesError = tablesQuery.error;

    const pageArgs = useMemo<Record<string, unknown>>(() => {
        return {
            filters: toFilterClauses(filters),
            limit: pageSize,
            offset,
            orderBy: toOrderBy(sorting),
            search,
            table: selectedTable ?? "",
        };
    }, [filters, pageSize, offset, sorting, search, selectedTable]);

    // `keepPreviousData` is off: the placeholder isn't identity-aware, so holding
    // the last page across a `selectedTable` / `debouncedShard` change would render
    // the prior table's/shard's rows while edits and deletes already target the new
    // one. `live` streams writes in. Disabled until a table is open.
    const pageQuery = useAdminQuery<TablePage>(ADMIN_FUNCTIONS.readTablePage, pageArgs, {
        enabled: selectedTable !== null,
        keepPreviousData: false,
        live: true,
        shardKey: debouncedShard,
    });
    const page = pageQuery.data ?? null;
    const pageError = pageQuery.error;
    const { liveError } = pageQuery;

    // Record the browsed shard into recent-shards history once its tables resolve.
    useEffect(() => {
        if (tablesQuery.data !== undefined) {
            recordShard(debouncedShard);
        }
    }, [tablesQuery.data, debouncedShard]);

    // The table last applied to the selection, mirrored in a ref so the URL-reconcile
    // effect below can tell its own optimistic selections (which set this) apart from
    // an external change (browser back/forward), and only re-select for the latter.
    const appliedTableRef = useRef<null | string>(null);

    const selectTable = useCallback(
        (table: string): void => {
            // First open of a shared/saved view: seed the bar with its filters/search/
            // sort rather than clearing. Consumed once — later table switches start
            // clean. Guarded to the URL's own table so an unrelated switch never picks
            // it up.
            const hydration = hydrationRef.current?.table === undefined || hydrationRef.current.table === table ? hydrationRef.current : null;

            hydrationRef.current = null;

            const nextSorting = fromOrderBy(hydration?.orderBy);
            const nextFilters = toEditableFilters(hydration?.filters ?? []);
            const nextSearch = hydration?.search ?? "";

            // A fresh table means the previous sort/search/filters/facets/staged edits no longer apply.
            setSorting(nextSorting);
            setFilter(nextSearch);
            setFilters(nextFilters);
            filtersRef.current = nextFilters;
            clearFacets();
            stagedEdits.clear();
            setEditingCell(null);
            setOffset(0);
            setSelectedTable(table);
            appliedTableRef.current = table;
            // The page query refetches automatically once `selectedTable`/the view
            // state changes — no imperative fetch needed.
            // Mirror the selection to the URL so it's shareable and back/forward works.
            onSelectTable?.(table);
        },
        [clearFacets, onSelectTable, stagedEdits],
    );

    // Follow a foreign-key cell: switch to the target table and search for the
    // referenced id (the row's primary key shows in the `id` column), so an
    // operator can traverse relations by clicking instead of copy-pasting ids.
    const navigateToRef = (targetTable: string, id: string): void => {
        setSorting([]);
        setFilters([]);
        filtersRef.current = [];
        clearFacets();
        setOffset(0);
        setSelectedTable(targetTable);
        appliedTableRef.current = targetTable;
        setFilter(id);
        // The page query refetches with the new table + (debounced) search applied.
        onSelectTable?.(targetTable);
    };

    // One-shot read of the row a foreign-key cell points at, for the hover preview,
    // without disturbing the current view. `search` is a substring match across all
    // columns (not an exact PK lookup), so it can surface rows that merely *contain*
    // the id in some other column — fetch a small candidate window and return the row
    // whose primary key actually equals the id, or null when none does. Best-effort:
    // a cross-tier (`.global()`) target or a failed read also resolves to null.
    const previewRef = async (targetTable: string, id: string): Promise<Record<string, unknown> | null> => {
        try {
            const result = (await client.query(
                READ_TABLE_PAGE,
                { filters: [], limit: PREVIEW_CANDIDATES, offset: 0, search: id, table: targetTable },
                callOptions(debouncedShard),
            )) as TablePage;

            return result.rows.find((row) => rowId(row) === id) ?? null;
        } catch {
            return null;
        }
    };

    // ── Facets (Datasette-style per-column value/count summaries) ───────────
    // The per-view fetcher the shared hook drives: one `FACET_COLUMN` query over the
    // given shard/filters/search. `FacetResult` is the on-the-wire summary shape.
    const facetFetcher = useCallback(
        (shard: string, table: string, activeFilters: EditableFilter[], searchQuery: string): FacetFetcher =>
            (column) =>
                client.query(
                    FACET_COLUMN,
                    { column, filters: toFilterClauses(activeFilters), search: searchQuery, table },
                    callOptions(shard),
                ) as Promise<FacetResult>,
        [client],
    );

    // Toggle a column into / out of the facet sidebar. Turning it on seeds a
    // loading slot and fetches its summary for the current view; turning it off
    // drops it entirely. With no table selected the hook seeds the slot without
    // fetching (a null fetcher).
    const toggleFacet = (column: string): void => {
        toggleFacetColumn(column, selectedTable === null ? null : facetFetcher(debouncedShard, selectedTable, filtersRef.current, search));
    };

    // Clicking a facet value adds an `eq` filter for that column/value, narrowing
    // the view to those rows. Reuses the same `EditableFilter` machinery as the
    // filter bar (its value is a string until coerced on the wire). Replaces any
    // existing clause for the same column so repeated clicks don't stack.
    const facetFilter = (column: string, value: unknown): void => {
        const text = facetValueText(value);

        setFilters((current) => [...current.filter((clause) => clause.column !== column), { column, operator: "eq", value: text }]);
        setOffset(0);
    };

    // `facetFetcher` / `refetchFacets` and `onViewChange` are read through refs so
    // the two effects below can depend on the *view values* alone. Those callbacks'
    // identities churn every render (recreated unless React Compiler memoizes them);
    // listing them in the deps made the effects re-fire on every render — wasted
    // facet refetches and, worse, a self-perpetuating `onViewChange` → `navigate`
    // loop that re-asserts `/data` and traps the user on the tab. Keying on the
    // values means each fires only when the displayed view actually changes.
    const facetFetcherRef = useRef(facetFetcher);
    const refetchFacetsRef = useRef(refetchFacets);
    const onViewChangeRef = useRef(onViewChange);

    facetFetcherRef.current = facetFetcher;
    refetchFacetsRef.current = refetchFacets;
    onViewChangeRef.current = onViewChange;

    // Refetch every toggled-on facet when the active view (filters / search / shard
    // / table) changes, so the summaries always reflect the previewed rows. The
    // shard / search are already debounced, so this tracks the displayed view; it's
    // gated on a selected table so it doesn't fire before one is open.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- the facet summaries are derived from the active view (a value, not a discrete event); refetching them when it changes is the correct pattern.
        if (selectedTable === null) {
            return;
        }

        // `refetchFacets` re-runs only the already-open facets (read off the hook's
        // ref); toggling a single facet on is handled by `toggleFacet`'s own fetch.
        refetchFacetsRef.current(facetFetcherRef.current(debouncedShard, selectedTable, filters, search));
        // Fire on the active view; the facet callbacks are read via refs (see above).
    }, [debouncedShard, selectedTable, filters, search]);

    // Mirror the active view (shard / search / filters / sort) to the host so it can
    // write it into the URL — making every view a real, shareable link. The shard /
    // search are debounced, so it tracks the displayed view; the table itself is
    // mirrored separately by `onSelectTable`.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- the URL is a projection of the active view (a value, not a discrete event); mirroring it when the view changes is the correct pattern.
        if (selectedTable === null || onViewChangeRef.current === undefined) {
            return;
        }

        onViewChangeRef.current({
            filters: toFilterClauses(filters),
            orderBy: toOrderBy(sorting),
            search,
            shard: debouncedShard,
        });
        // Fire on the displayed view; `onViewChange` is read via `onViewChangeRef` (see above).
    }, [selectedTable, filters, sorting, search, debouncedShard]);

    // `selectTable` read through a ref so the reconcile effect below can depend on
    // `tableParam` ALONE. `selectTable`'s identity churns every render (its deps —
    // `clearFacets` / `onSelectTable` / `stagedEdits` — are recreated unless React
    // Compiler memoizes them), and listing it in the effect's deps made the effect
    // re-fire mid-navigation: an in-app `selectTable("messages")` sets
    // `appliedTableRef` to "messages" and navigates, but before the URL commits the
    // effect would re-run with the still-stale `tableParam` ("inbox"), see it differ
    // from `appliedTableRef`, and "reconcile" by re-selecting "inbox" — bouncing the
    // click back. Keying on `tableParam` only means it fires solely on real URL
    // changes (deep link / back-forward / a committed in-app nav), never mid-flight.
    const selectTableRef = useRef(selectTable);

    selectTableRef.current = selectTable;

    // Reconcile the URL's table into the selection. Fires on first load (deep link)
    // and on browser back/forward; an in-app selection already set `appliedTableRef`
    // to this value, so those are skipped and never double-fetch. The actual select
    // is deferred to a microtask so its state resets don't run synchronously inside
    // the effect, and `appliedTableRef` is claimed up front to coalesce repeat fires.
    //
    // NB: `GlobalDataBrowser` has the structurally identical twin of this effect.
    // Kept inline rather than shared because each browser's `selectTable` differs —
    // this one also resets sort/filter/staged state and is shard-keyed; only the
    // ~6-line reconcile wiring would be common.
    useEffect(() => {
        /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- URL → selection sync: open the table named in the URL (deep link / browser back-forward). There is no user event to hook into; the ref guard + microtask keep it from re-firing or looping. */
        if (tableParam === undefined || tableParam === "" || tableParam === appliedTableRef.current) {
            return;
        }

        appliedTableRef.current = tableParam;
        const target = tableParam;

        queueMicrotask(() => {
            selectTableRef.current(target);
        });
        /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */
        // Fire only on a real `tableParam` change; `selectTable` is read via `selectTableRef` (see above).
    }, [tableParam]);

    const goToPage = (nextOffset: number): void => {
        if (selectedTable === null) {
            return;
        }

        setOffset(Math.max(0, nextOffset));
    };

    // ── Inline cell editing → staged buffer → preview-diff → commit ──────────
    const editableColumn = (column: string): boolean => !META_COLUMNS.has(column);

    const startCellEdit = (targetRow: string, column: string): void => {
        setEditingCell({ column, rowId: targetRow });
    };

    const cancelCellEdit = (): void => {
        setEditingCell(null);
    };

    // Commit every staged cell edit as a per-row patch (the writer merges the
    // changed fields into the existing doc), then reload the page and clear the
    // buffer. Sequential so a failure pins the offending row.
    const commitStaged = async (): Promise<void> => {
        if (selectedTable === null) {
            return;
        }

        setWriteError(null);
        setCommitting(true);

        try {
            for (const [id, columns] of Object.entries(stagedEdits.staged)) {
                // eslint-disable-next-line no-await-in-loop -- one patch per edited row; sequential so a failure pins the offending row
                (await client.query(WRITE_ROW, { doc: columns, id, op: "patch", table: selectedTable }, callOptions(debouncedShard))) as WriteRowResult;
            }

            stagedEdits.clear();
            setEditingCell(null);
            pageQuery.refetch();
        } catch (error) {
            setWriteError((error as Error).message);
        } finally {
            setCommitting(false);
        }
    };

    const discardStaged = (): void => {
        stagedEdits.clear();
        setEditingCell(null);
    };

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

    // Search / filters / sort / page-size changes flow straight into `pageArgs`, so
    // the page query refetches on its own. Each input's handler resets offset to the
    // first page when it narrows the view (`onFilterChange`, `changeFilters`,
    // `facetFilter`, `changeSorting`, `changePageSize`, `selectTable`,
    // `navigateToRef`) — no manual refetch effects are needed (this is what the
    // React Query migration removes).

    // Issue a writeRow op then reload the current page so the change shows. A
    // delete passes no doc; insert (id === "") / patch carry the JSON draft.
    const writeRow = async (op: "delete" | "insert" | "patch", id: null | string, documentText?: string): Promise<void> => {
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
                callOptions(debouncedShard),
            )) as WriteRowResult;
            setEditing(null);
            pageQuery.refetch();
        } catch (error) {
            setWriteError((error as Error).message);
        }
    };

    // Drain a server bulk-delete op (`deleteRows` with a predicate, or
    // `clearTable` with none) by looping a single bounded round-trip while it
    // reports `hasMore` — replacing the old N+1 read-then-delete-per-id loop. The
    // server collects the matching ids and removes each THROUGH the schema-aware
    // writer (so FTS / aggregate / rank shadow tables stay in sync), capped per
    // call; the loop is bounded by `MAX_BULK_DELETE_BATCHES` so it can never run
    // unbounded. Sequential by design: each call's deletes shrink the set the
    // next read sees, so the round-trips can't be parallelised.
    const drainBulk = async (ref: typeof DELETE_ROWS, args: Record<string, unknown>): Promise<void> => {
        if (selectedTable === null) {
            return;
        }

        setWriteError(null);

        try {
            for (let batch = 0; batch < MAX_BULK_DELETE_BATCHES; batch += 1) {
                // eslint-disable-next-line no-await-in-loop -- batches are inherently sequential (each call reflects the prior batch's deletes)
                const result = (await client.query(ref, args, callOptions(debouncedShard))) as BulkDeleteResult;

                if (!result.hasMore) {
                    break;
                }
            }

            setOffset(0);
            pageQuery.refetch();
        } catch (error) {
            setWriteError((error as Error).message);
        }
    };

    // Server-side sort: a column-header click changes the order, so reset to the
    // first page (the operator expects the top of the newly-sorted results, not the
    // same offset reordered). Wraps `setSorting` for the grid; `selectTable` /
    // `navigateToRef` already reset offset themselves, so they keep the raw setter.
    const changeSorting: OnChangeFn<SortingState> = (updater): void => {
        setSorting(updater);
        setOffset(0);
    };

    // Headless table model + virtualizer for the loaded page. The page-local
    // `sorting` state stays here (table switches reset it via `setSorting`); the
    // hook owns only the derived react-table/virtualizer wiring.
    const table = useDataBrowserTable(page, sorting, changeSorting);

    // The currently-displayed view, for the "Copy link" / "Save query" affordances.
    // Derived from the live state (not the `loaded` descriptor) so it reflects the
    // bar as edited, even before a re-fetch lands. Uses the debounced `search` so a
    // half-typed query isn't captured mid-keystroke.
    const currentView = {
        filters: toFilterClauses(filters),
        orderBy: toOrderBy(sorting),
        search,
        shard: shardKey,
        table: selectedTable ?? undefined,
    };

    const total = page?.total ?? 0;
    const hasPrevious = offset > 0;
    const hasNext = page !== null && offset + page.rows.length < total;
    const rangeStart = page === null || page.rows.length === 0 ? 0 : offset + 1;
    const rangeEnd = page === null ? 0 : offset + page.rows.length;

    const loadTables = (): void => {
        tablesQuery.refetch();
    };

    const showTable = (): void => {
        setViewMode("table");
    };

    const showJson = (): void => {
        setViewMode("json");
    };

    const bulkDelete = (): void => {
        fireAndForget(drainBulk(DELETE_ROWS, { filters: toFilterClauses(filtersRef.current), search, table: selectedTable }));
    };

    const emptyTable = (): void => {
        fireAndForget(drainBulk(CLEAR_TABLE, { table: selectedTable }));
    };

    const onFilterChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
        setFilter(event.target.value);
        // A new search narrows the result set — jump back to the first page so the
        // current offset can't point past the (smaller) total.
        setOffset(0);
    };

    // Apply a structured-filter change and reset to the first page (same reason as
    // the search box). Exposed as `onFiltersChange`.
    const changeFilters = (next: EditableFilter[]): void => {
        setFilters(next);
        setOffset(0);
    };

    const addRow = (): void => {
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
    };

    const setEditorDocumentText = (text: string): void => {
        setEditing((current) => (current === null ? current : { docText: text, id: current.id }));
    };

    const saveEdit = (): void => {
        if (editing === null) {
            return;
        }

        fireAndForget(writeRow(editing.id === "" ? "insert" : "patch", editing.id === "" ? null : editing.id, editing.docText));
    };

    const cancelEdit = (): void => {
        setEditing(null);
        setWriteError(null);
    };

    const goPrevious = (): void => {
        goToPage(offset - pageSize);
    };

    const goNext = (): void => {
        goToPage(offset + pageSize);
    };

    // Jump to a 1-based page: translate to an offset at the current page size. The
    // footer clamps the input, but floor at 0 defensively.
    const jumpToPage = (targetPage: number): void => {
        goToPage(Math.max(0, (targetPage - 1) * pageSize));
    };

    // Change rows-per-page; the guarded effect above re-fetches the first page at
    // the new size.
    const changePageSize = (size: number): void => {
        setPageSize(size);
        setOffset(0);
    };

    const onRowEdit = (id: null | string, original: TableRow): void => {
        setWriteError(null);
        setEditing({ docText: JSON.stringify(rowDocument(original), null, 2), id });
    };

    const onRowDelete = (id: null | string): void => {
        fireAndForget(writeRow("delete", id));
    };

    // Delete an explicit set of selected row ids (the checkbox selection), each
    // through the schema-aware writer so FTS / aggregate / rank shadow tables stay
    // in sync, then reload the page. Sequential so a failure pins the offending
    // row; the selection is page-bounded (≤ pageSize), so this never fans out
    // unboundedly the way a predicate delete could.
    const deleteSelected = async (ids: ReadonlyArray<string>): Promise<void> => {
        if (selectedTable === null || ids.length === 0) {
            return;
        }

        setWriteError(null);

        try {
            for (const id of ids) {
                // eslint-disable-next-line no-await-in-loop -- one delete per selected row; sequential so a failure pins the offending row
                (await client.query(WRITE_ROW, { id, op: "delete", table: selectedTable }, callOptions(debouncedShard))) as WriteRowResult;
            }

            pageQuery.refetch();
        } catch (error) {
            setWriteError((error as Error).message);
        }
    };

    const onBulkDeleteSelected = (ids: ReadonlyArray<string>): void => {
        fireAndForget(deleteSelected(ids));
    };

    const onCommitStaged = (): void => {
        fireAndForget(commitStaged());
    };

    return {
        addRow,
        bulkDelete,
        cancelCellEdit,
        cancelEdit,
        changePageSize,
        clearTable: emptyTable,
        columns: page?.columns ?? [],
        committing,
        currentView,
        discardStaged,
        editableColumn,
        editing,
        editingCell,
        facetFilter,
        facets,
        filter,
        filters,
        goNext,
        goPrevious,
        hasNext,
        hasPrevious,
        jumpToPage,
        liveError,
        loadTables,
        navigateToRef,
        onBulkDeleteSelected,
        onCommitStaged,
        onFilterChange,
        onFiltersChange: changeFilters,
        onRowDelete,
        onRowEdit,
        page,
        previewRef,
        pageError,
        pageSize,
        rangeEnd,
        rangeStart,
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
        toggleFacet,
        total,
        viewMode,
        writeError,
    };
};

export type { DataBrowserModel };
export type { FacetState } from "./use-facets";
export { useDataBrowser };
