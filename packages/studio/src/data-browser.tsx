import type { ReactElement } from "react";
import { useCallback, useMemo, useState } from "react";

import type { TableInfo } from "./admin";
import { EmptyState } from "./components/ui/empty-state";
import { ConfirmButton } from "./confirm-button";
import type { GridEdit, TableRow } from "./data-browser-grid";
import { DataBrowserTableView } from "./data-browser-grid";
import type { EditableFilter } from "./data-filters";
import { DataFilters } from "./data-filters";
import { GridPagination, TableListSidebar } from "./data-grid";
import { CellDetailDialog, GridActionsBar } from "./grid-features";
import { LiveToggle } from "./live-toggle";
import { RowDetailDrawer } from "./row-detail";
import RowFormEditor from "./row-form";
import { ShardInput } from "./shard-input";
import { StagedDiffPanel } from "./staged-edits";
import { StorageTierBadge } from "./storage-tier";
import { useDataBrowser } from "./use-data-browser";

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

/** Shared Supabase-style control-button class for the toolbar actions. */
const CONTROL_BTN =
    "inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-accent-foreground";

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
export const DataBrowser = ({ editable = false, initialShardKey, pageSize: initialPageSize = DEFAULT_PAGE_SIZE }: DataBrowserProps): ReactElement => {
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
        live,
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
    } = useDataBrowser({ initialShardKey, pageSize: initialPageSize });

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
                <RowDetailDrawer columns={page.columns} onClose={closeInspect} onNavigate={navigateToRef} refs={page.refs} row={inspecting} />
            )}

            {expandedCell !== null && <CellDetailDialog column={expandedCell.column} onClose={closeExpandedCell} value={expandedCell.value} />}
        </div>
    );
};

export type { DataBrowserProps };
