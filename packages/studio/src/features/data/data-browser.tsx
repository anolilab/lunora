import { useLunora } from "@lunora/react";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { ShardInput } from "../../components/shard-input";
import { EmptyState } from "../../components/ui/empty-state";
import { useAdminQuery } from "../../hooks/use-admin-query";
import { useT } from "../../i18n/i18n-context";
import type { ColumnMeta, FilterClause, TableInfo, TablesColumnsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { usePersistedValue } from "../../lib/browser-storage";
import { adminRef, callOptions, fireAndForget } from "../../lib/internal";
import { maskColumnsForTable, maskRows, mergeSensitiveColumns } from "../../lib/mask-preview";
import type { DataView, SavedQuery } from "../../lib/saved-queries";
import { useSqlAssistant } from "../sql/hooks/use-sql-assistant";
import { backRelationKey, backRelationsFor } from "./back-relations";
import type { TableRow } from "./data-browser-grid";
import { DataBrowserTableView } from "./data-browser-grid";
import DataFacets from "./data-facets";
import type { EditableFilter } from "./data-filters";
import { DataFilters } from "./data-filters";
import { TransposedTable } from "./data-grid";
import DataQueryBar from "./data-query-bar";
import { GenerateRowsDialog } from "./generate-rows-dialog";
import { CellDetailDialog, GridActionsBar } from "./grid-features";
import GridPagination from "./grid-pagination";
import { useBackRelations } from "./hooks/use-back-relations";
import { useDataBrowser } from "./hooks/use-data-browser";
import { useGenerateRows } from "./hooks/use-generate-rows";
import useMaskPolicies from "./hooks/use-mask-policies";
import { RowDetailDrawer } from "./row-detail";
import RowFormEditor from "./row-form";
import { ShardExplorer } from "./shard-explorer";
import { StagedDiffPanel } from "./staged-edits";
import { TableListSidebar } from "./table-list-sidebar";

/** Browser-local store for per-table pinned columns. */
const PINNED_COLUMNS_KEY = "lunora-studio-pinned-columns";

/** Browser-local store for per-table enabled reverse-relation columns. */
const BACK_RELATIONS_KEY = "lunora-studio-back-relations";

/** Hoisted empty schema map so an unresolved `describeTables` doesn't churn the resolver's identity. */
const EMPTY_COLUMNS_BY_TABLE: Readonly<Record<string, ColumnMeta[]>> = {};

interface DataBrowserProps {
    /**
     * Allow editing: surfaces insert/edit/delete actions that issue
     * `__lunora_admin__:writeRow` ops through the schema-aware writer. Off by
     * default — the browser is read-only unless the host opts in.
     */
    readonly editable?: boolean;

    /**
     * Names of the `.global()` (D1-backed) tables. A `v.id` ref cell whose target
     * is one of these is followed cross-tier via `onNavigateToGlobal` instead of
     * being read from this shard (where it doesn't exist). Supplied by the Table
     * editor; defaults to none when the browser is used standalone.
     */
    readonly globalTableNames?: ReadonlySet<string>;
    /** Structured filters to hydrate from a shared link / saved query. */
    readonly initialFilters?: FilterClause[];
    /** Sort to hydrate from a shared link / saved query. */
    readonly initialOrderBy?: DataView["orderBy"];
    /** Comma-separated pinned columns from the URL; wins over the per-browser default. */
    readonly initialPins?: string;
    /** Substring search to hydrate from a shared link / saved query. */
    readonly initialSearch?: string;
    /** Shard key the browser targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;

    /**
     * Follow a `v.id` ref whose target is a global table — the Table editor switches
     * to the global tier and opens that table. When omitted (standalone use), a ref
     * to a global table falls through to the in-shard read (and surfaces its error).
     */
    readonly onNavigateToGlobal?: (table: string, id: string) => void;

    /**
     * Navigate the URL to a table (the Table editor pushes `?table=…`), opening it
     * clean; `options.search` pre-fills the search for an FK-cell traversal.
     * Omitted in standalone use.
     */
    readonly onSelectTable?: (table: string, options?: { search?: string }) => void;

    /**
     * Called whenever the loaded view (shard / search / filters / sort) changes, so
     * the host can mirror it to the URL — making every view a shareable link.
     * Omitted in standalone use (view state stays in-component).
     */
    readonly onViewChange?: (view: Pick<DataView, "filters" | "orderBy" | "search" | "shard">) => void;
    /** Rows requested per page. Clamped server-side to `[1, 500]`. */
    readonly pageSize?: number;

    /**
     * The canned-query toolbar's handlers + saved list. Supplied by the Table editor
     * (it owns the router and the `saved-queries` localStorage helper); omitted in
     * standalone use, which hides the toolbar entirely. `onSaveQuery` receives the
     * name plus the current view to persist.
     */
    readonly queryBar?: {
        readonly onApplyQuery: (query: SavedQuery) => void;
        readonly onCopyLink: () => void;
        readonly onDeleteQuery: (name: string) => void;
        readonly onSaveQuery: (name: string, view: DataView) => void;
        readonly saved: ReadonlyArray<SavedQuery>;
    };

    /**
     * The schema/source selector rendered at the top of the table-list sidebar —
     * the Table editor's `schema public ▾` switch. Supplied when this browser is
     * composed into the Table editor; omitted when it's used alone.
     */
    readonly schemaSwitch?: ReactNode;

    /**
     * The table named in the URL. Drives the selection — a deep link or browser
     * back/forward to a different `?table=…` re-opens that table. Supplied by the
     * Table editor; omitted in standalone use (selection stays purely in-component).
     */
    readonly tableParam?: string;
}

const DEFAULT_PAGE_SIZE = 50;

/** Hoisted empty table list — a stable reference for the "no tables yet" sidebar (avoids a fresh `[]` literal in JSX). */
const NO_TABLES: ReadonlyArray<TableInfo> = [];

/** Shared Supabase-style control-button class for the toolbar actions. */
const CONTROL_BTN =
    "inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-accent-foreground";

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);

/**
 * The table-list sidebar header: the schema/source switch (when the browser is
 * composed into the Table editor) and the shard-key picker, stacked for the
 * narrow full-height rail. The table list auto-loads for the (debounced) shard
 * key — no manual "Load tables" button — with the sidebar's refresh icon for an
 * on-demand re-fetch. Presentational: the parent owns the shard-key state.
 */
const DataBrowserSidebarHeader = ({
    onFetchShardTables,
    onShardChange,
    schemaSwitch,
    shardKey,
}: {
    onFetchShardTables: (shardKey: string) => Promise<ReadonlyArray<TableInfo> | undefined>;
    onShardChange: (value: string) => void;
    schemaSwitch?: ReactNode;
    shardKey: string;
}): ReactElement => (
    <div className="flex shrink-0 flex-col items-stretch gap-2 border-b border-border p-3">
        {schemaSwitch}
        <ShardInput onChange={onShardChange} testId="db-shard-input" value={shardKey} />
        <ShardExplorer onFetchTables={onFetchShardTables} onSelect={onShardChange} />
    </div>
);

/**
 * The page's view toggle / live status / search / add-row controls. All state
 * lives in the parent; this component is purely the control bar markup. The grid
 * is always live (Convex-style) — there is no Refresh or Live toggle; a passive
 * indicator shows the stream is healthy, and flips to "Live unavailable" only when
 * the admin subscription is rejected (the grid still shows its last-fetched rows).
 */
const DataBrowserViewControls = ({
    columns,
    editable,
    filter,
    filters,
    hasMaskedColumns,
    liveError,
    maskOn,
    onAddRow,
    onBulkDelete,
    onAskAiFilter,
    onClearTable,
    onFilterChange,
    onFiltersChange,
    onGenerateRows,
    onShowJson,
    onShowTable,
    onToggleMask,
    total,
    viewMode,
}: {
    columns: string[];
    editable: boolean;
    filter: string;
    filters: EditableFilter[];
    /** Whether the selected table has any mask-covered columns — gates the toggle's visibility. */
    hasMaskedColumns: boolean;
    liveError: string | undefined;
    /** Whether the "Mask sensitive columns" preview is on. */
    maskOn: boolean;
    onAddRow: () => void;
    /** Ask the model for structured clauses; omitted when no AI binding is available. */
    onAskAiFilter?: (prompt: string) => void;
    onBulkDelete: () => void;
    onClearTable: () => void;
    onFilterChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onFiltersChange: (filters: EditableFilter[]) => void;
    onGenerateRows: () => void;
    onShowJson: () => void;
    onShowTable: () => void;
    onToggleMask: () => void;
    total: number;
    viewMode: "json" | "table";
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-col gap-2" data-testid="db-view-toggle">
            <div className="flex flex-wrap items-center gap-1.5">
                <button aria-pressed={viewMode === "table"} className={CONTROL_BTN} data-testid="db-view-table" onClick={onShowTable} type="button">
                    Table
                </button>
                <button aria-pressed={viewMode === "json"} className={CONTROL_BTN} data-testid="db-view-json" onClick={onShowJson} type="button">
                    JSON
                </button>
                <span
                    className="inline-flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground"
                    data-testid="db-live-indicator"
                    role="status"
                    title={liveError === undefined ? t("Live — changes stream in automatically") : t("Live unavailable: {liveError}", { liveError })}
                >
                    <span aria-hidden="true" className={`size-1.5 rounded-full ${liveError === undefined ? "bg-success" : "bg-muted-foreground/50"}`} />
                    {liveError === undefined ? t("Live") : t("Live unavailable")}
                </span>
                {hasMaskedColumns && (
                    <button aria-pressed={maskOn} className={CONTROL_BTN} data-testid="db-mask-toggle" onClick={onToggleMask} type="button">
                        {t("Mask sensitive columns")}
                    </button>
                )}
                {editable && (
                    <button className={CONTROL_BTN} data-testid="db-add-row" onClick={onAddRow} type="button">
                        Add row
                    </button>
                )}
                {editable && (
                    <button className={CONTROL_BTN} data-testid="db-generate-rows" onClick={onGenerateRows} type="button">
                        {t("Generate rows")}
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
            <DataFilters
                columns={columns}
                filters={filters}
                onAskAi={onAskAiFilter}
                onFiltersChange={onFiltersChange}
                onSearchChange={onFilterChange}
                search={filter}
            />
        </div>
    );
};

/**
 * Read-only data browser for a single shard's SQLite database. Lists the user
 * tables (via the `__lunora_admin__:listTables` RPC), then pages through the
 * rows of whichever table is selected (`__lunora_admin__:readTablePage`).
 *
 * Both calls travel over the ordinary `useLunora` client transport; the
 * admin RPCs are intercepted inside the Durable Object and are gated by the
 * server's `LUNORA_ADMIN_TOKEN`. The host is responsible for configuring the
 * client's auth token — this component issues no credentials of its own.
 *
 * The table view is built on a headless `@tanstack/react-table` model: column
 * defs derive from `page.columns`, sorting and (global) filtering run
 * page-locally over the loaded rows, and the rendered rows are virtualized with
 * `@tanstack/react-virtual` so a large page never inflates the DOM. None of this
 * touches the server — pagination still flows through `readTablePage`. All of
 * that state lives in {@link useDataBrowser}; this component is just the markup.
 */
// react-doctor-disable-next-line react-doctor/no-giant-component -- splitting this component is a real refactor with its own review, not a lint fix; tracked separately rather than done blind inside an unrelated change
export const DataBrowser = ({
    editable = false,
    globalTableNames,
    initialFilters,
    initialOrderBy,
    initialPins,
    initialSearch,
    initialShardKey,
    onNavigateToGlobal,
    onSelectTable,
    onViewChange,
    pageSize: initialPageSize = DEFAULT_PAGE_SIZE,
    queryBar,
    schemaSwitch,
    tableParam,
}: DataBrowserProps): ReactElement => {
    // Reverse relations ("← messages") are opt-in per table: resolving them is
    // proportional to relations × page size, and most sessions never look at
    // them. The EDGES are derived from schema metadata the studio can fetch once;
    // only the COUNTS need a per-page round trip.
    const schemaQuery = useAdminQuery<TablesColumnsResult>(ADMIN_FUNCTIONS.describeTables, {}, { shardKey: initialShardKey ?? "" });
    const columnsByTable = schemaQuery.data?.columnsByTable ?? EMPTY_COLUMNS_BY_TABLE;
    const [backRelationsOn, setBackRelationsOn] = usePersistedValue<Record<string, string[]>>(BACK_RELATIONS_KEY, {});

    // MEMOIZED DELIBERATELY, unlike the derivations below. This feeds
    // `activeBackRelations` → the grid's `columnDefs` → `useReactTable`, and
    // react-table resets its internal state (column sizing, row selection) the
    // moment `columns` changes identity. React Compiler would hold it stable, but
    // a compiler bail-out here is a visible bug, not a slow render.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour here: react-table resets on a new `columns` identity
    const resolveBackRelations = useCallback(
        (table: string) => {
            const enabled = new Set(backRelationsOn[table]);

            return backRelationsFor(table, columnsByTable).filter((relation) => enabled.has(backRelationKey(relation)));
        },
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- `columnsByTable` IS `schemaQuery.data?.columnsByTable`, destructured above; the deps are complete
        [backRelationsOn, columnsByTable],
    );

    const {
        addRow,
        bulkDelete,
        cancelCellEdit,
        cancelEdit,
        changePageSize,
        clearTable,
        columns,
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
        onFiltersChange,
        onRowDelete,
        onRowEdit,
        page,
        pageError,
        previewRef,
        pageSize,
        queryShardKey,
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
        stage,
        stagedChanges,
        stagedValue,
        startCellEdit,
        table,
        tables,
        tablesError,
        toggleFacet,
        total,
        viewMode,
        writeError,
    } = useDataBrowser({
        initialFilters,
        initialOrderBy,
        initialSearch,
        initialShardKey,
        onSelectTable,
        onViewChange,
        pageSize: initialPageSize,
        resolveBackRelations,
        tableParam,
    });

    // Natural-language filtering. The model returns STRUCTURED clauses which
    // land in the visible filter rows for the operator to see and edit — the
    // query never runs off un-reviewed model output.
    const assistant = useSqlAssistant(shardKey);

    const askAiFilter = (prompt: string): void => {
        const apply = async (): Promise<void> => {
            const clauses = await assistant.suggestFilter(prompt, selectedTable ?? "");

            if (clauses !== undefined) {
                onFiltersChange(
                    clauses.map((clause) => {
                        // The wire value is `unknown`; a filter row is a string
                        // input, so only scalars round-trip meaningfully.
                        const raw: unknown = clause.value;
                        const value = typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "";

                        return { column: clause.column, operator: clause.operator, value };
                    }),
                );
            }
        };

        fireAndForget(apply());
    };

    // Available reverse edges for the open table, and the counts for the loaded
    // page. Only the switched-on edges are resolved; the rest cost nothing.
    // Plain derivations — React Compiler memoizes them, and `useBackRelations`
    // keys its fetch on a serialised signature rather than these identities, so
    // nothing downstream cares whether they are stable.
    const availableBackRelations = selectedTable === null ? [] : backRelationsFor(selectedTable, columnsByTable);
    const enabledBackRelations = new Set(backRelationsOn[selectedTable ?? ""]);
    // One pass, not map-then-filter: a page is up to a few hundred rows.
    const pageIds: string[] = [];

    for (const row of page?.rows ?? []) {
        const id = row._id ?? row.id;

        if (typeof id === "string" && id !== "") {
            pageIds.push(id);
        }
    }
    // The DEBOUNCED shard, matching the page these ids came from — the live one
    // would refetch per keystroke and could count children on a shard other than
    // the one whose rows are on screen.
    const backRelationCounts = useBackRelations(enabledBackRelations, availableBackRelations, pageIds, queryShardKey);

    const onToggleBackRelation = (key: string): void => {
        setBackRelationsOn((current) => {
            const forTable = selectedTable ?? "";
            const existing: string[] = current[forTable] ?? [];

            return { ...current, [forTable]: existing.includes(key) ? existing.filter((entry) => entry !== key) : [...existing, key] };
        });
    };

    // Pinned columns, per table, persisted on this browser. Per table because a
    // pin is a statement about THAT table's shape ("keep the email visible"),
    // not a global preference; persisted because re-pinning on every navigation
    // would make the feature not worth using.
    const [pinsByTable, setPinsByTable] = usePersistedValue<Record<string, string[]>>(PINNED_COLUMNS_KEY, {});
    // `selectedTable` is null before a table is chosen; key on "" so the lookup
    // is total and no pins are ever attributed to the wrong table.
    const pinKey = selectedTable ?? "";
    // STORAGE wins, with the URL as the seed for a table nobody has pinned on
    // this browser yet. The precedence was the other way round, which made every
    // pin/unpin a no-op for the rest of the session whenever `?pins=` was
    // present — the toggle wrote to storage that was never read again.
    const stored = pinsByTable[pinKey];
    const pinnedColumns = stored === undefined ? new Set((initialPins ?? "").split(",").filter((name) => name !== "")) : new Set(stored);

    const onTogglePin = (columnId: string): void => {
        setPinsByTable((current) => {
            // Seed from whatever is displayed (storage, else the URL) so the
            // first toggle after arriving on a `?pins=` link edits that set
            // rather than starting from empty.
            const existing: string[] = current[pinKey] ?? [...pinnedColumns];
            const next = existing.includes(columnId) ? existing.filter((id) => id !== columnId) : [...existing, columnId];

            return { ...current, [pinKey]: next };
        });
    };

    const client = useLunora();

    // Fetch the table list for a given shard key — used by the ShardExplorer to
    // show a live table/row-count summary when the operator picks a recent shard.
    const onFetchShardTables = async (targetShard: string): Promise<ReadonlyArray<TableInfo> | undefined> => {
        const result = (await client.query(LIST_TABLES, {}, callOptions(targetShard))) as ReadonlyArray<TableInfo>;

        return result;
    };

    // Generate & insert dummy rows via the local seed endpoint (Node-side @lunora/seed).
    const onRefreshAfterGenerate = (): void => {
        if (selectedTable !== null) {
            selectTable(selectedTable);
        }
    };

    const {
        closeDialog: closeGenerateDialog,
        columnMeta,
        fkPools,
        insertBatch,
        open: generateOpen,
        openDialog: openGenerateDialog,
    } = useGenerateRows(onRefreshAfterGenerate);

    const onOpenGenerateRows = (): void => {
        if (selectedTable !== null) {
            openGenerateDialog(selectedTable, shardKey);
        }
    };

    const onInsertGeneratedRows = (rows: ReadonlyArray<Record<string, unknown>>): Promise<string | undefined> => insertBatch(rows, closeGenerateDialog);

    // The row whose full document the detail drawer is showing, if any. Pure
    // view state — kept out of the data hook since it touches no fetch logic.
    const [inspecting, setInspecting] = useState<TableRow | null>(null);
    const closeInspect = (): void => {
        setInspecting(null);
    };

    // Whether the table view is transposed (fields as rows, records as columns) —
    // pure view state for reading wide tables; persists across table switches until
    // the operator toggles it back.
    const [transposed, setTransposed] = useState<boolean>(false);
    const onToggleTranspose = (): void => {
        setTransposed((current) => !current);
    };

    // The deployment's codegen-discovered mask policies (table + column + strategy),
    // loaded once. Drives the "Mask sensitive columns" preview: a render-only
    // redaction of what a `.use(mask(...))` caller would see, plus the per-column
    // "masked" header chips. The operator keeps full DB access — this is a preview,
    // not enforcement.
    const maskPolicies = useMaskPolicies();
    // Default the preview ON so plaintext secrets are hidden out of the box (the
    // operator reveals them by toggling). The toggle is only rendered when the
    // active table actually has sensitive columns, so an ordinary table is
    // unaffected; when it does, the safe-by-default state is masked.
    const [maskOn, setMaskOn] = useState<boolean>(true);
    const onToggleMask = (): void => {
        setMaskOn((current) => !current);
    };

    // The active table's masked columns (column → strategy). Explicit codegen
    // policies (`.use(mask(...))`) are layered with a name-heuristic fallback so a
    // plaintext `password` / `api_key` / `token` column with no declared policy is
    // still masked by default (as `"redact"`). Explicit policies always win.
    const explicitMaskColumns = maskColumnsForTable(maskPolicies, selectedTable ?? "");
    const maskColumns = mergeSensitiveColumns(explicitMaskColumns, columns);

    // The threaded view the grid/JSON/transposed renderers read. The chips show
    // whenever a column is covered; cell values are only rewritten when the toggle
    // is on.
    const maskView = { columns: maskColumns, enabled: maskOn };

    // The cell whose full value the expand dialog is showing, if any. Opened from
    // the per-cell expand affordance; pure view state like `inspecting`.
    const [expandedCell, setExpandedCell] = useState<null | { column: string; value: unknown }>(null);
    const onExpandCell = (column: string, value: unknown): void => {
        setExpandedCell({ column, value });
    };
    const closeExpandedCell = (): void => {
        setExpandedCell(null);
    };

    // Follow a `v.id` ref cell. Targets in another storage tier (a `.global()` D1
    // table) can't be read from this shard, so route those to the global tier via
    // `onNavigateToGlobal`; same-tier (shard) targets use the in-shard navigation.
    const handleNavigateRef = (target: string, id: string): void => {
        if (onNavigateToGlobal !== undefined && globalTableNames?.has(target) === true) {
            onNavigateToGlobal(target, id);

            return;
        }

        navigateToRef(target, id);
    };

    // Inject the current view into the query bar's save handler, so the bar only has
    // to collect a name. Stable as long as the view / host handler are.
    const onSaveQuery = queryBar?.onSaveQuery;
    const saveCurrentQuery = (name: string): void => {
        onSaveQuery?.(name, currentView);
    };

    // The inline-edit context passed down to every grid cell.
    const edit = {
        cancelEdit: cancelCellEdit,
        editable,
        editableColumn,
        editingCell,
        onExpandCell,
        stage,
        stagedValue,
        startEdit: startCellEdit,
    };

    // The foreign-key context passed alongside it: the column → table map plus the
    // navigate/preview handlers a ref cell needs.
    const references = { columns: page?.refs, onNavigate: handleNavigateRef, onPreview: previewRef };

    return (
        <div className="flex h-full min-w-0" data-testid="lunora-data-browser">
            <TableListSidebar
                header={
                    <DataBrowserSidebarHeader
                        onFetchShardTables={onFetchShardTables}
                        onShardChange={setShardKey}
                        schemaSwitch={schemaSwitch}
                        shardKey={shardKey}
                    />
                }
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
                                hasMaskedColumns={maskColumns.size > 0}
                                liveError={liveError}
                                maskOn={maskOn}
                                onAddRow={addRow}
                                onAskAiFilter={assistant.unavailable ? undefined : askAiFilter}
                                onBulkDelete={bulkDelete}
                                onClearTable={clearTable}
                                onFilterChange={onFilterChange}
                                onFiltersChange={onFiltersChange}
                                onGenerateRows={onOpenGenerateRows}
                                onShowJson={showJson}
                                onShowTable={showTable}
                                onToggleMask={onToggleMask}
                                total={total}
                                viewMode={viewMode}
                            />

                            {queryBar !== undefined && (
                                <DataQueryBar
                                    onApply={queryBar.onApplyQuery}
                                    onCopyLink={queryBar.onCopyLink}
                                    onDelete={queryBar.onDeleteQuery}
                                    onSave={saveCurrentQuery}
                                    saved={queryBar.saved}
                                />
                            )}

                            {viewMode === "table" && page.rows.length > 0 && (
                                <GridActionsBar
                                    backRelations={availableBackRelations}
                                    columns={page.columns}
                                    editable={editable}
                                    enabledBackRelations={enabledBackRelations}
                                    name={selectedTable ?? "export"}
                                    onBulkDelete={onBulkDeleteSelected}
                                    onToggleBackRelation={onToggleBackRelation}
                                    onToggleTranspose={onToggleTranspose}
                                    rows={page.rows}
                                    table={table.table}
                                    transposed={transposed}
                                />
                            )}

                            {editable && editing !== null && (
                                <RowFormEditor
                                    documentText={editing.docText}
                                    onCancel={cancelEdit}
                                    onDocumentTextChange={setEditorDocumentText}
                                    onSave={saveEdit}
                                    refs={page.refs}
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

                        {viewMode === "table" && page.rows.length > 0 && transposed && (
                            <TransposedTable columns={page.columns} rows={maskRows(page.rows, maskView)} />
                        )}

                        {viewMode === "table" && page.rows.length > 0 && !transposed && (
                            <DataBrowserTableView
                                attachScroll={table.attachScroll}
                                backRelationCounts={backRelationCounts}
                                edit={edit}
                                editable={editable}
                                highlight={filter}
                                mask={maskView}
                                onDelete={onRowDelete}
                                onEdit={onRowEdit}
                                onInspect={setInspecting}
                                onTogglePin={onTogglePin}
                                pinnedColumns={pinnedColumns}
                                refs={references}
                                scrollLeft={table.scrollLeft}
                                scrollToIndex={table.scrollToIndex}
                                table={table.table}
                                tableRows={table.tableRows}
                                tbodyStyle={table.tbodyStyle}
                                viewportWidth={table.viewportWidth}
                                virtualRows={table.virtualRows}
                            />
                        )}

                        {viewMode === "json" && (
                            <pre className="min-h-0 flex-1 overflow-auto border-t border-border bg-muted/30 p-3 text-xs" data-testid="db-json">
                                {JSON.stringify(maskRows(page.rows, maskView), null, 2)}
                            </pre>
                        )}

                        <div className="flex shrink-0 items-center border-t border-border px-4 py-2">
                            <GridPagination
                                hasNext={hasNext}
                                hasPrevious={hasPrevious}
                                onJumpToPage={jumpToPage}
                                onNext={goNext}
                                onPageSizeChange={changePageSize}
                                onPrevious={goPrevious}
                                pageSize={pageSize}
                                prefix="db"
                                rangeEnd={rangeEnd}
                                rangeStart={rangeStart}
                                total={total}
                            />
                        </div>
                    </div>
                )}
            </div>

            {page !== null && <DataFacets columns={columns} facets={facets} onFacetFilter={facetFilter} onToggleFacet={toggleFacet} />}

            {inspecting !== null && page !== null && (
                <RowDetailDrawer columns={page.columns} onClose={closeInspect} onNavigate={handleNavigateRef} refs={page.refs} row={inspecting} />
            )}

            {expandedCell !== null && <CellDetailDialog column={expandedCell.column} onClose={closeExpandedCell} value={expandedCell.value} />}

            {generateOpen && selectedTable !== null && columnMeta !== undefined && (
                <GenerateRowsDialog
                    columns={columnMeta}
                    fkPools={fkPools}
                    onClose={closeGenerateDialog}
                    onInsertRows={onInsertGeneratedRows}
                    table={selectedTable}
                />
            )}
        </div>
    );
};

export type { DataBrowserProps };
