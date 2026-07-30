import { useLunora } from "@lunora/react";
import type { ReactElement, ReactNode } from "react";
import { useCallback } from "react";

import { ShardInput } from "../../components/shard-input";
import { useAdminQuery } from "../../hooks/use-admin-query";
import type { ColumnMeta, FilterClause, TableInfo, TablesColumnsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { usePersistedValue } from "../../lib/browser-storage";
import { adminRef, callOptions, fireAndForget } from "../../lib/internal";
import type { DataView, SavedQuery } from "../../lib/saved-queries";
import { useSqlAssistant } from "../sql/hooks/use-sql-assistant";
import { backRelationKey, backRelationsFor } from "./back-relations";
import { DataBrowserPage } from "./data-browser-page";
import DataFacets from "./data-facets";
import { GenerateRowsDialog } from "./generate-rows-dialog";
import { CellDetailDialog } from "./grid-features";
import { useBackRelations } from "./hooks/use-back-relations";
import { useDataBrowser } from "./hooks/use-data-browser";
import { useDataViewPreferences } from "./hooks/use-data-view-preferences";
import { useGenerateRows } from "./hooks/use-generate-rows";
import { RowDetailDrawer } from "./row-detail";
import { ShardExplorer } from "./shard-explorer";
import { TableListSidebar } from "./table-list-sidebar";

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

    const browser = useDataBrowser({
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

    const {
        cancelCellEdit,
        columns,
        currentView,
        editableColumn,
        editingCell,
        facetFilter,
        facets,
        loadTables,
        navigateToRef,
        onFiltersChange,
        page,
        pageError,
        previewRef,
        queryShardKey,
        selectedTable,
        selectTable,
        setShardKey,
        shardKey,
        stage,
        stagedValue,
        startCellEdit,
        tables,
        tablesError,
        toggleFacet,
    } = browser;

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
    const preferences = useDataViewPreferences({ columns, initialPins, selectedTable });

    const { closeExpandedCell, closeInspect, expandedCell, inspecting, onExpandCell } = preferences;

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
                    <DataBrowserPage
                        assistant={assistant}
                        backRelations={{
                            available: availableBackRelations,
                            counts: backRelationCounts,
                            enabled: enabledBackRelations,
                            onToggle: onToggleBackRelation,
                        }}
                        browser={browser}
                        edit={edit}
                        editable={editable}
                        onAskAiFilter={askAiFilter}
                        onOpenGenerateRows={onOpenGenerateRows}
                        onSaveQuery={saveCurrentQuery}
                        page={page}
                        preferences={preferences}
                        queryBar={queryBar}
                        references={references}
                    />
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
