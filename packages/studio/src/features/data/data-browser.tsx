import type { ReactElement, ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { ShardInput } from "../../components/shard-input";
import { EmptyState } from "../../components/ui/empty-state";
import { useT } from "../../i18n/i18n-context";
import type { TableInfo } from "../../lib/admin";
import type { GridEdit, TableRow } from "./data-browser-grid";
import { DataBrowserTableView } from "./data-browser-grid";
import type { EditableFilter } from "./data-filters";
import { DataFilters } from "./data-filters";
import { GridPagination, TableListSidebar, TransposedTable } from "./data-grid";
import { CellDetailDialog, GridActionsBar } from "./grid-features";
import { useDataBrowser } from "./hooks/use-data-browser";
import { RowDetailDrawer } from "./row-detail";
import RowFormEditor from "./row-form";
import { StagedDiffPanel } from "./staged-edits";

interface DataBrowserProps {
    /**
     * Allow editing: surfaces insert/edit/delete actions that issue
     * `__cirrus_admin__:writeRow` ops through the schema-aware writer. Off by
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
    /** Shard key the browser targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;

    /**
     * Follow a `v.id` ref whose target is a global table — the Table editor switches
     * to the global tier and opens that table. When omitted (standalone use), a ref
     * to a global table falls through to the in-shard read (and surfaces its error).
     */
    readonly onNavigateToGlobal?: (table: string, id: string) => void;

    /**
     * Called whenever the open table changes, so the host can mirror it to the URL
     * (the Table editor pushes `?table=…`). Omitted in standalone use.
     */
    readonly onSelectTable?: (table: string) => void;
    /** Rows requested per page. Clamped server-side to `[1, 500]`. */
    readonly pageSize?: number;

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

/**
 * The table-list sidebar header: the schema/source switch (when the browser is
 * composed into the Table editor) and the shard-key picker, stacked for the
 * narrow full-height rail. The table list auto-loads for the (debounced) shard
 * key — no manual "Load tables" button — with the sidebar's refresh icon for an
 * on-demand re-fetch. Presentational: the parent owns the shard-key state.
 */
const DataBrowserSidebarHeader = ({
    onShardChange,
    schemaSwitch,
    shardKey,
}: {
    onShardChange: (value: string) => void;
    schemaSwitch?: ReactNode;
    shardKey: string;
}): ReactElement => (
    <div className="flex shrink-0 flex-col items-stretch gap-2 border-b border-border p-3">
        {schemaSwitch}
        <ShardInput onChange={onShardChange} testId="db-shard-input" value={shardKey} />
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
    liveError,
    onAddRow,
    onBulkDelete,
    onClearTable,
    onFilterChange,
    onFiltersChange,
    onShowJson,
    onShowTable,
    total,
    viewMode,
}: {
    columns: string[];
    editable: boolean;
    filter: string;
    filters: EditableFilter[];
    liveError: string | undefined;
    onAddRow: () => void;
    onBulkDelete: () => void;
    onClearTable: () => void;
    onFilterChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    onFiltersChange: (filters: EditableFilter[]) => void;
    onShowJson: () => void;
    onShowTable: () => void;
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
                    <span aria-hidden="true" className={`size-1.5 rounded-full ${liveError === undefined ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
                    {liveError === undefined ? t("Live") : t("Live unavailable")}
                </span>
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
};

/**
 * Read-only data browser for a single shard's SQLite database. Lists the user
 * tables (via the `__cirrus_admin__:listTables` RPC), then pages through the
 * rows of whichever table is selected (`__cirrus_admin__:readTablePage`).
 *
 * Both calls travel over the ordinary `useCirrus` client transport; the
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
export const DataBrowser = ({
    editable = false,
    globalTableNames,
    initialShardKey,
    onNavigateToGlobal,
    onSelectTable,
    pageSize: initialPageSize = DEFAULT_PAGE_SIZE,
    schemaSwitch,
    tableParam,
}: DataBrowserProps): ReactElement => {
    const {
        addRow,
        bulkDelete,
        cancelCellEdit,
        cancelEdit,
        changePageSize,
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
        total,
        viewMode,
        writeError,
    } = useDataBrowser({ initialShardKey, onSelectTable, pageSize: initialPageSize, tableParam });

    // The row whose full document the detail drawer is showing, if any. Pure
    // view state — kept out of the data hook since it touches no fetch logic.
    const [inspecting, setInspecting] = useState<TableRow | null>(null);
    const closeInspect = useCallback((): void => {
        setInspecting(null);
    }, []);

    // Whether the table view is transposed (fields as rows, records as columns) —
    // pure view state for reading wide tables. Reset implicitly per render of the grid.
    const [transposed, setTransposed] = useState<boolean>(false);
    const onToggleTranspose = useCallback((): void => {
        setTransposed((current) => !current);
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

    // Follow a `v.id` ref cell. Targets in another storage tier (a `.global()` D1
    // table) can't be read from this shard, so route those to the global tier via
    // `onNavigateToGlobal`; same-tier (shard) targets use the in-shard navigation.
    const handleNavigateRef = useCallback(
        (target: string, id: string): void => {
            if (onNavigateToGlobal !== undefined && globalTableNames?.has(target) === true) {
                onNavigateToGlobal(target, id);

                return;
            }

            navigateToRef(target, id);
        },
        [globalTableNames, navigateToRef, onNavigateToGlobal],
    );

    // The inline-edit context passed down to every grid cell.
    const edit = useMemo<GridEdit>(() => {
        return {
            cancelEdit: cancelCellEdit,
            editable,
            editableColumn,
            editingCell,
            onExpandCell,
            onNavigateRef: handleNavigateRef,
            onPreviewRef: previewRef,
            refs: page?.refs,
            stage,
            stagedValue,
            startEdit: startCellEdit,
        };
    }, [cancelCellEdit, editable, editableColumn, editingCell, onExpandCell, handleNavigateRef, previewRef, page?.refs, stage, stagedValue, startCellEdit]);

    return (
        <div className="flex h-full min-w-0" data-testid="cirrus-data-browser">
            <TableListSidebar
                header={<DataBrowserSidebarHeader onShardChange={setShardKey} schemaSwitch={schemaSwitch} shardKey={shardKey} />}
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
                                liveError={liveError}
                                onAddRow={addRow}
                                onBulkDelete={bulkDelete}
                                onClearTable={clearTable}
                                onFilterChange={onFilterChange}
                                onFiltersChange={onFiltersChange}
                                onShowJson={showJson}
                                onShowTable={showTable}
                                total={total}
                                viewMode={viewMode}
                            />

                            {viewMode === "table" && page.rows.length > 0 && (
                                <GridActionsBar
                                    columns={page.columns}
                                    editable={editable}
                                    name={selectedTable ?? "export"}
                                    onBulkDelete={onBulkDeleteSelected}
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

                        {viewMode === "table" && page.rows.length > 0 && transposed && <TransposedTable columns={page.columns} rows={page.rows} />}

                        {viewMode === "table" && page.rows.length > 0 && !transposed && (
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

            {inspecting !== null && page !== null && (
                <RowDetailDrawer columns={page.columns} onClose={closeInspect} onNavigate={handleNavigateRef} refs={page.refs} row={inspecting} />
            )}

            {expandedCell !== null && <CellDetailDialog column={expandedCell.column} onClose={closeExpandedCell} value={expandedCell.value} />}
        </div>
    );
};

export type { DataBrowserProps };
