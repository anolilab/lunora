import type { GlobalFilterClause, GlobalTablePage } from "@lunora/client";
import type { ReactElement } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useT } from "../../i18n/i18n-context";
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
    onChangePageSize,
    onJumpToPage,
    onNext,
    onPrevious,
    onRemoveFilter,
    page,
    pageSize,
    pagination,
}: {
    /** Active `column = value` drill-downs, rendered as removable chips. */
    readonly filters: ReadonlyArray<GlobalFilterClause>;
    readonly onChangePageSize: (size: number) => void;
    readonly onJumpToPage: (page: number) => void;
    readonly onNext: () => void;
    readonly onPrevious: () => void;
    readonly onRemoveFilter: (index: number) => void;
    readonly page: GlobalTablePage;
    readonly pageSize: number;
    /** Derived window the pager labels itself from. */
    readonly pagination: { hasNext: boolean; hasPrevious: boolean; rangeEnd: number; rangeStart: number; total: number };
}): ReactElement => {
    const t = useT();
    const { hasNext, hasPrevious, rangeEnd, rangeStart, total } = pagination;

    return (
        <div className="flex min-h-0 flex-1 flex-col" data-testid="gdb-page">
            {filters.length > 0 && (
                <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-4 py-2 text-xs" data-testid="gdb-filters">
                    {filters.map((filter, index) => (
                        <span
                            className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5"
                            data-testid="gdb-filter-chip"
                            key={`${filter.column}:${chipValue(filter.value)}`}
                        >
                            <span className="font-medium text-foreground">{filter.column}</span>
                            <span className="text-muted-foreground">=</span>
                            <span className="font-mono text-foreground">{chipValue(filter.value)}</span>
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
                    ))}
                </div>
            )}

            <GridContainer layout="fill">
                <div className="min-h-0 flex-1 overflow-auto">
                    <Table data-testid="gdb-rows">
                        <TableHeader>
                            <TableRow>
                                {page.columns.map((column) => (
                                    <TableHead key={column}>{column}</TableHead>
                                ))}
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {page.rows.map((row, rowIndex) => (
                                <TableRow data-testid="gdb-row" key={rowKey(row, rowIndex)}>
                                    {page.columns.map((column) => (
                                        <TableCell className="max-w-xs truncate font-mono text-xs" key={column}>
                                            <CellValue value={row[column]} />
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

export { GlobalDataPage };
