import type { GlobalFilterClause, GlobalTablePage } from "@lunora/client";
import type { ReactElement } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
import type { MaskView } from "../../lib/mask-preview";
import { maskCell } from "../../lib/mask-preview";
import { CONTROL_TOGGLE_BTN } from "./control-button";
import { CellValue, GridContainer } from "./data-grid";
import { chipValue, rowKey } from "./global-row-format";
import GridPagination from "./grid-pagination";

/**
 * The loaded page of a `.global()` table: its active drill-down chips, the grid,
 * and the pager.
 *
 * Its own component because everything here is a function of ONE loaded page.
 * The browser around it owns discovery, the poll, and the facet state; this
 * renders what came back and reports the four navigation intents.
 */
const GlobalDataPage = ({
    filters,
    hasMaskedColumns,
    mask,
    maskOn,
    onChangePageSize,
    onJumpToPage,
    onNext,
    onPrevious,
    onRemoveFilter,
    onToggleMask,
    page,
    pageSize,
    pagination,
}: {
    /** Active `column = value` drill-downs, rendered as removable chips. */
    readonly filters: ReadonlyArray<GlobalFilterClause>;
    /** Whether the open table has any mask-covered column — gates the toggle (the chips key off `mask` itself). */
    readonly hasMaskedColumns: boolean;
    /** Mask preview: the covered columns + whether the toggle is on. Drives the header chips, the cells, and the drill-down chips. */
    readonly mask: MaskView;
    readonly maskOn: boolean;
    readonly onChangePageSize: (size: number) => void;
    readonly onJumpToPage: (page: number) => void;
    readonly onNext: () => void;
    readonly onPrevious: () => void;
    readonly onRemoveFilter: (index: number) => void;
    readonly onToggleMask: () => void;
    readonly page: GlobalTablePage;
    readonly pageSize: number;
    /** Derived window the pager labels itself from. */
    readonly pagination: { hasNext: boolean; hasPrevious: boolean; rangeEnd: number; rangeStart: number; total: number };
}): ReactElement => {
    const t = useT();
    const { hasNext, hasPrevious, rangeEnd, rangeStart, total } = pagination;

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="gdb-page">
            {hasMaskedColumns && (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
                    <button aria-pressed={maskOn} className={CONTROL_TOGGLE_BTN} data-testid="gdb-mask-toggle" onClick={onToggleMask} type="button">
                        {t("Mask sensitive columns")}
                    </button>
                </div>
            )}

            {filters.length > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2 text-xs" data-testid="gdb-filters">
                    {filters.map((filter, index) => {
                        // A drill-down chip renders a STORED value, so it honours the
                        // preview like every other surface: the facet sidebar withholds
                        // covered columns while masking is on, but a filter added with the
                        // preview off must not keep displaying the raw value once it is
                        // switched back on. There is at most one clause per column, so the
                        // masked form is still a unique key.
                        const shown = chipValue(maskCell(filter.value, filter.column, mask));

                        return (
                            <span
                                className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5"
                                data-testid="gdb-filter-chip"
                                key={`${filter.column}:${shown}`}
                            >
                                <span className="font-medium text-foreground">{filter.column}</span>
                                <span className="text-muted-foreground">=</span>
                                <span className="font-mono text-foreground">{shown}</span>
                                <button
                                    aria-label={t("Remove filter")}
                                    className="ml-0.5 text-muted-foreground hover:text-foreground"
                                    data-testid="gdb-filter-remove"
                                    onClick={() => {
                                        onRemoveFilter(index);
                                    }}
                                    type="button"
                                >
                                    ✕
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}

            <GridContainer layout="fill">
                <div className="min-h-0 flex-1 overflow-auto">
                    <Table data-testid="gdb-rows">
                        <TableHeader>
                            <TableRow>
                                {page.columns.map((column) => (
                                    <TableHead key={column}>
                                        {column}
                                        {mask.columns.has(column) && (
                                            <span
                                                className="ms-1 inline-flex items-center rounded-sm bg-warning/15 px-1 text-[0.625rem] font-medium uppercase text-warning"
                                                data-testid={`gdb-mask-chip-${column}`}
                                                title="This column is masked by a mask() policy"
                                            >
                                                masked
                                            </span>
                                        )}
                                    </TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {page.rows.map((row, rowIndex) => (
                                <TableRow data-testid="gdb-row" key={rowKey(row, rowIndex)}>
                                    {page.columns.map((column) => (
                                        <TableCell className="max-w-xs truncate font-mono text-xs" key={column}>
                                            {mask.enabled && mask.columns.has(column) ? (
                                                <span className="text-muted-foreground italic" data-testid={`gdb-masked-${column}`} title="Masked (preview)">
                                                    <CellValue value={maskCell(row[column], column, mask)} />
                                                </span>
                                            ) : (
                                                <CellValue value={row[column]} />
                                            )}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            </GridContainer>

            <div className="flex shrink-0 items-center border-t border-border px-4 py-2">
                <GridPagination
                    hasNext={hasNext}
                    hasPrevious={hasPrevious}
                    onJumpToPage={onJumpToPage}
                    onNext={onNext}
                    onPageSizeChange={onChangePageSize}
                    onPrevious={onPrevious}
                    pageSize={pageSize}
                    prefix="gdb"
                    rangeEnd={rangeEnd}
                    rangeStart={rangeStart}
                    total={total}
                />
            </div>
        </div>
    );
};

export default GlobalDataPage;
