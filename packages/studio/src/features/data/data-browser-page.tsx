import type { ReactElement } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { EmptyState } from "../../components/ui/empty-state";
import { useT } from "../../i18n/i18n-context";
import type { ColumnMeta, TablePage } from "../../lib/admin";
import { jsonRowReplacer } from "../../lib/internal";
import { maskRows } from "../../lib/mask-preview";
import type { SavedQuery } from "../../lib/saved-queries";
import type { SqlAssistant } from "../sql/hooks/use-sql-assistant";
import { CONTROL_TOGGLE_BTN } from "./control-button";
import type { GridEdit, GridReferences, TableRow } from "./data-browser-grid";
import { DataBrowserTableView } from "./data-browser-grid";
import type { EditableFilter } from "./data-filters";
import { DataFilters } from "./data-filters";
import { TransposedTable } from "./data-grid";
import DataQueryBar from "./data-query-bar";
import { GridActionsBar } from "./grid-features";
import GridPagination from "./grid-pagination";
import type { DataBrowserModel } from "./hooks/use-data-browser";
import type { DataViewPreferences } from "./hooks/use-data-view-preferences";
import RowFormEditor from "./row-form";
import { StagedDiffPanel } from "./staged-edits";

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
    hasPredicate,
    liveError,
    maskOn,
    onAddRow,
    onBulkDelete,
    onBulkPatch,
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
    /** The RAW search box value — the controlled input's `value`, and nothing else. */
    filter: string;
    filters: EditableFilter[];
    /** Whether the selected table has any mask-covered columns — gates the toggle's visibility. */
    hasMaskedColumns: boolean;

    /**
     * Whether the view carries a predicate the bulk ops would actually send —
     * the DEBOUNCED search plus the structured filters. Gates the predicate
     * actions (and, inverted, the whole-table one) so the button on screen and
     * the request it fires can never disagree; gating on `filter` put "Delete N
     * matching" up for the 300ms debounce window with an empty predicate, which
     * deletes the whole table.
     */
    hasPredicate: boolean;
    liveError: string | undefined;
    /** Whether the "Mask sensitive columns" preview is on. */
    maskOn: boolean;
    onAddRow: () => void;
    /** Ask the model for structured clauses; omitted when no AI binding is available. */
    onAskAiFilter?: (prompt: string) => void;
    onBulkDelete: () => void;
    /** Open the "set a column on every matching row" dialog. */
    onBulkPatch: () => void;
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
                <button aria-pressed={viewMode === "table"} className={CONTROL_TOGGLE_BTN} data-testid="db-view-table" onClick={onShowTable} type="button">
                    Table
                </button>
                <button aria-pressed={viewMode === "json"} className={CONTROL_TOGGLE_BTN} data-testid="db-view-json" onClick={onShowJson} type="button">
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
                    <button aria-pressed={maskOn} className={CONTROL_TOGGLE_BTN} data-testid="db-mask-toggle" onClick={onToggleMask} type="button">
                        {t("Mask sensitive columns")}
                    </button>
                )}
                {editable && (
                    <button className={CONTROL_TOGGLE_BTN} data-testid="db-add-row" onClick={onAddRow} type="button">
                        Add row
                    </button>
                )}
                {editable && (
                    <button className={CONTROL_TOGGLE_BTN} data-testid="db-generate-rows" onClick={onGenerateRows} type="button">
                        {t("Generate rows")}
                    </button>
                )}
                {editable && total > 0 && hasPredicate && (
                    <ConfirmButton confirmLabel={`Delete ${total.toString()} matching?`} onConfirm={onBulkDelete} testId="db-bulk-delete">
                        {`Delete ${total.toString()} matching`}
                    </ConfirmButton>
                )}
                {/*
                 * Gated on an active predicate exactly like "Delete N matching", so the
                 * label's "matching" is always true. Deliberately NOT offered unfiltered:
                 * the whole-table equivalent is `clearTable`'s territory, which the
                 * codebase already decided needs its own confirmed action rather than
                 * riding on a predicate button.
                 *
                 * No `ConfirmButton` on top: the dialog is the confirmation step — it
                 * names the row count and cannot be submitted without a parsed value.
                 */}
                {editable && total > 0 && hasPredicate && (
                    <button className={CONTROL_TOGGLE_BTN} data-testid="db-bulk-patch" onClick={onBulkPatch} type="button">
                        {t("Set column on {total} matching", { total: total.toString() })}
                    </button>
                )}
                {editable && total > 0 && !hasPredicate && (
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
 * Everything shown once a table's page has loaded: the view controls, the write
 * and staged-edit banners, the grid (table or JSON, upright or transposed), and
 * the pager.
 *
 * Takes the MODELS rather than their fields. The naive extraction here wants
 * ~55 loose props, which would move the wiring without reducing it; passing
 * `browser` and `preferences` whole keeps the boundary at three cohesive objects
 * and means adding a field to either does not ripple through this signature.
 */
const DataBrowserPage = ({
    assistant,
    backRelations,
    browser,
    columnMeta,
    edit,
    editable,
    onAskAiFilter,
    onInspect,
    onOpenBulkPatch,
    onOpenGenerateRows,
    onRowDelete,
    onSaveQuery,
    page,
    preferences,
    queryBar,
    references,
}: {
    readonly assistant: SqlAssistant;
    /** Reverse-relation columns: what is available, which are on, and their counts. */
    readonly backRelations: {
        available: ReadonlyArray<{ column: string; table: string }>;
        /** relation column → row id → count, as `useBackRelations` reports it. */
        counts: Readonly<Record<string, Readonly<Record<string, number>>>>;
        enabled: ReadonlySet<string>;
        onToggle: (key: string) => void;
    };
    /** The data model — reads, writes, pagination, staged edits. */
    readonly browser: DataBrowserModel;
    /** Declared columns of the open table, keyed by name — the row editor's type source. */
    readonly columnMeta?: Record<string, ColumnMeta>;
    /** The inline-edit context every grid cell reads. */
    readonly edit: GridEdit;
    readonly editable: boolean;
    /** Turns a natural-language prompt into filter clauses. */
    readonly onAskAiFilter: (prompt: string) => void;
    /** Open a row's detail drawer. From `useRowInspection`, whose other fields the page never reads. */
    readonly onInspect: (row: TableRow | null) => void;
    /** Open the bulk-patch dialog. Host-owned like `onOpenGenerateRows` — the dialog renders alongside the browser, not inside the page. */
    readonly onOpenBulkPatch: () => void;
    readonly onOpenGenerateRows: () => void;

    /**
     * Delete one row by id. Passed explicitly rather than read off `browser`
     * because the host wraps `browser.onRowDelete` in the cascade-impact preview
     * — the delete only runs once the operator confirms it there.
     */
    readonly onRowDelete: (id: null | string) => void;
    readonly onSaveQuery: (name: string) => void;
    /** The loaded page. Non-null by construction — the parent renders this only once a page has arrived. */
    readonly page: TablePage;
    /** How the operator is looking at the table — pins, masking, transpose, inspection. */
    readonly preferences: DataViewPreferences;
    /** The canned-query toolbar's handlers and saved list; omitted hides the toolbar. */
    readonly queryBar:
        | undefined
        | {
              readonly onApplyQuery: (query: SavedQuery) => void;
              readonly onCopyLink: () => void;
              readonly onDeleteQuery: (name: string) => void;
              readonly saved: ReadonlyArray<SavedQuery>;
          };
    /** The foreign-key context: the column → table map plus a ref cell's navigate/preview handlers. */
    readonly references: GridReferences;
}): ReactElement => (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="db-page">
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3">
            <DataBrowserViewControls
                columns={browser.columns}
                editable={editable}
                filter={browser.filter}
                filters={browser.filters}
                hasMaskedColumns={preferences.maskColumns.size > 0}
                hasPredicate={browser.hasPredicate}
                liveError={browser.liveError}
                maskOn={preferences.maskOn}
                onAddRow={browser.addRow}
                onAskAiFilter={assistant.unavailable ? undefined : onAskAiFilter}
                onBulkDelete={browser.bulkDelete}
                onBulkPatch={onOpenBulkPatch}
                onClearTable={browser.clearTable}
                onFilterChange={browser.onFilterChange}
                onFiltersChange={browser.onFiltersChange}
                onGenerateRows={onOpenGenerateRows}
                onShowJson={browser.showJson}
                onShowTable={browser.showTable}
                onToggleMask={preferences.onToggleMask}
                total={browser.total}
                viewMode={browser.viewMode}
            />

            {queryBar !== undefined && (
                <DataQueryBar
                    onApply={queryBar.onApplyQuery}
                    onCopyLink={queryBar.onCopyLink}
                    onDelete={queryBar.onDeleteQuery}
                    onSave={onSaveQuery}
                    saved={queryBar.saved}
                />
            )}

            {browser.viewMode === "table" && page.rows.length > 0 && (
                <GridActionsBar
                    backRelations={backRelations.available}
                    columns={page.columns}
                    editable={editable}
                    enabledBackRelations={backRelations.enabled}
                    name={browser.selectedTable ?? "export"}
                    onBulkDelete={browser.onBulkDeleteSelected}
                    onToggleBackRelation={backRelations.onToggle}
                    onToggleTranspose={preferences.onToggleTranspose}
                    rows={maskRows(page.rows, preferences.maskView)}
                    table={browser.table.table}
                    transposed={preferences.transposed}
                />
            )}

            {editable && browser.editing !== null && (
                <RowFormEditor
                    columnMeta={columnMeta}
                    documentText={browser.editing.docText}
                    onCancel={browser.cancelEdit}
                    onDocumentTextChange={browser.setEditorDocumentText}
                    onSave={browser.saveEdit}
                    refs={page.refs}
                />
            )}

            {editable && browser.stagedChanges.length > 0 && (
                <StagedDiffPanel
                    changes={browser.stagedChanges}
                    committing={browser.committing}
                    onCommit={browser.onCommitStaged}
                    onDiscard={browser.discardStaged}
                />
            )}

            {browser.writeError !== null && (
                <p className="text-sm text-destructive" data-testid="db-write-error" role="alert">
                    {browser.writeError}
                </p>
            )}

            {browser.writeNotice !== null && (
                <p className="text-sm text-muted-foreground" data-testid="db-write-notice" role="status">
                    {browser.writeNotice}
                </p>
            )}
        </div>

        {browser.viewMode === "table" && page.rows.length === 0 && (
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

        {browser.viewMode === "table" && page.rows.length > 0 && preferences.transposed && (
            <TransposedTable columns={page.columns} rows={maskRows(page.rows, preferences.maskView)} />
        )}

        {browser.viewMode === "table" && page.rows.length > 0 && !preferences.transposed && (
            <DataBrowserTableView
                backRelationCounts={backRelations.counts}
                columnMeta={columnMeta}
                edit={edit}
                editable={editable}
                highlight={browser.filter}
                mask={preferences.maskView}
                onDelete={onRowDelete}
                onEdit={browser.onRowEdit}
                onInspect={onInspect}
                onTogglePin={preferences.onTogglePin}
                pinnedColumns={preferences.pinnedColumns}
                refs={references}
                tableModel={browser.table}
            />
        )}

        {browser.viewMode === "json" && (
            <pre className="min-h-0 flex-1 overflow-auto border-t border-border bg-muted/30 p-3 text-xs" data-testid="db-json">
                {JSON.stringify(maskRows(page.rows, preferences.maskView), jsonRowReplacer, 2)}
            </pre>
        )}

        <div className="flex shrink-0 items-center border-t border-border px-4 py-2">
            <GridPagination
                hasNext={browser.hasNext}
                hasPrevious={browser.hasPrevious}
                onJumpToPage={browser.jumpToPage}
                onNext={browser.goNext}
                onPageSizeChange={browser.changePageSize}
                onPrevious={browser.goPrevious}
                pageSize={browser.pageSize}
                prefix="db"
                rangeEnd={browser.rangeEnd}
                rangeStart={browser.rangeStart}
                total={browser.total}
            />
        </div>
    </div>
);

export default DataBrowserPage;
