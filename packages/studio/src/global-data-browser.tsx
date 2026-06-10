import type { GlobalTableInfo, GlobalTablePage } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { EmptyState } from "./components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./components/ui/table";
import { CellValue, GridContainer, GridPagination, TableListSidebar } from "./data-grid";
import { useT } from "./i18n-context";
import { errorMessage, fireAndForget } from "./internal";
import { CLOUDFLARE_D1_URL } from "./lib/cf-links";
import { StorageTierBadge } from "./storage-tier";

interface GlobalDataBrowserProps {
    /** Rows requested per page. Clamped server-side to `[1, 500]`. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

/** Hoisted empty table list — a stable reference for the "no tables yet" sidebar (avoids a fresh `[]` literal in JSX). */
const NO_TABLES: ReadonlyArray<GlobalTableInfo> = [];

/**
 * A stable React key for a global-table row. `.global()` docs carry an `_id`
 * primary key; the positional fallback only applies to the rare idless page.
 */
const rowKey = (row: Record<string, unknown>, index: number): string => {
    const id = row["_id"];

    return typeof id === "string" || typeof id === "number" ? String(id) : `row-${index.toString()}`;
};

/**
 * Read-only browser for `.global()` (D1-backed) tables. Twin of `DataBrowser`,
 * but not shard-scoped: it lists tables via `listGlobalTables()` and pages rows
 * via `readGlobalTablePage()`. Laid out like Supabase's Table Editor — a left
 * table sidebar + a bordered grid with a paginated footer — and gated by the
 * server's `CIRRUS_ADMIN_TOKEN`.
 */
export const GlobalDataBrowser = ({ pageSize: initialPageSize = DEFAULT_PAGE_SIZE }: GlobalDataBrowserProps = {}): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [tables, setTables] = useState<GlobalTableInfo[] | null>(null);
    const [tablesError, setTablesError] = useState<null | string>(null);

    const [selectedTable, setSelectedTable] = useState<null | string>(null);
    const [offset, setOffset] = useState<number>(0);
    // Rows-per-page is user-adjustable via the footer's selector; the prop seeds it.
    const [pageSize, setPageSize] = useState<number>(initialPageSize);
    const [page, setPage] = useState<GlobalTablePage | null>(null);
    const [pageError, setPageError] = useState<null | string>(null);

    const fetchTables = useCallback(async (): Promise<void> => {
        setTablesError(null);

        try {
            setTables(await client.listGlobalTables());
        } catch (error) {
            setTables(null);
            setTablesError(errorMessage(error));
        }
    }, [client]);

    const fetchPage = useCallback(
        async (table: string, nextOffset: number, limit: number = pageSize): Promise<void> => {
            setPageError(null);

            try {
                const result = await client.readGlobalTablePage({ limit, offset: nextOffset, table });

                setPage(result);
                setOffset(nextOffset);
            } catch (error) {
                setPage(null);
                setPageError(errorMessage(error));
            }
        },
        [client, pageSize],
    );

    useEffect(() => {
        fireAndForget(fetchTables());
    }, [fetchTables]);

    const selectTable = useCallback(
        (table: string): void => {
            setSelectedTable(table);
            fireAndForget(fetchPage(table, 0));
        },
        [fetchPage],
    );

    const goToPage = useCallback(
        (nextOffset: number): void => {
            if (selectedTable === null) {
                return;
            }

            fireAndForget(fetchPage(selectedTable, Math.max(0, nextOffset)));
        },
        [fetchPage, selectedTable],
    );

    const total = page?.total ?? 0;
    const hasPrevious = offset > 0;
    const hasNext = page !== null && offset + page.rows.length < total;
    const rangeStart = page === null || page.rows.length === 0 ? 0 : offset + 1;
    const rangeEnd = page === null ? 0 : offset + page.rows.length;

    const reloadTables = useCallback((): void => {
        fireAndForget(fetchTables());
    }, [fetchTables]);

    const goPrevious = useCallback((): void => {
        goToPage(offset - pageSize);
    }, [goToPage, offset, pageSize]);

    const goNext = useCallback((): void => {
        goToPage(offset + pageSize);
    }, [goToPage, offset, pageSize]);

    const jumpToPage = useCallback(
        (targetPage: number): void => {
            goToPage(Math.max(0, (targetPage - 1) * pageSize));
        },
        [goToPage, pageSize],
    );

    // Change rows-per-page and re-read the first page at the new size (passed
    // explicitly so it doesn't wait for the state-updated closure).
    const changePageSize = useCallback(
        (size: number): void => {
            setPageSize(size);

            if (selectedTable !== null) {
                fireAndForget(fetchPage(selectedTable, 0, size));
            }
        },
        [fetchPage, selectedTable],
    );

    return (
        <div className="flex h-full min-w-0" data-testid="cirrus-global-data-browser">
            <TableListSidebar
                header={
                    <div className="flex shrink-0 items-center gap-2 border-b border-border p-3">
                        <StorageTierBadge tier="global" />
                        <a
                            className="ml-auto text-sm text-primary underline-offset-4 hover:underline"
                            data-testid="gdb-cf-link"
                            href={CLOUDFLARE_D1_URL}
                            rel="noreferrer"
                            target="_blank"
                        >
                            {t("Open in Cloudflare")}
                        </a>
                    </div>
                }
                onReload={reloadTables}
                onSelect={selectTable}
                prefix="gdb"
                selected={selectedTable}
                tables={tables ?? NO_TABLES}
            />

            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                {tablesError !== null && (
                    <p className="shrink-0 border-b border-border px-4 py-2 text-sm text-destructive" data-testid="gdb-tables-error" role="alert">
                        {tablesError}
                    </p>
                )}

                {tables !== null && tables.length === 0 && (
                    <div className="flex flex-1 items-center justify-center p-6">
                        <EmptyState
                            description={t("Tables marked .global() (D1-backed, region-replicated) will appear here.")}
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
                                    <circle cx="12" cy="12" r="9" />
                                    <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
                                </svg>
                            }
                            testId="gdb-empty"
                            title={t("No global tables.")}
                        />
                    </div>
                )}

                {pageError !== null && (
                    <p className="shrink-0 border-b border-border px-4 py-2 text-sm text-destructive" data-testid="gdb-page-error" role="alert">
                        {pageError}
                    </p>
                )}

                {tables !== null && tables.length > 0 && page === null && pageError === null && (
                    <div className="flex flex-1 items-center justify-center p-6">
                        <p className="text-sm text-muted-foreground">{t("Select a table to browse its rows.")}</p>
                    </div>
                )}

                {page !== null && (
                    <div className="flex min-h-0 flex-1 flex-col" data-testid="gdb-page">
                        <GridContainer fill>
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
                                onJumpToPage={jumpToPage}
                                onNext={goNext}
                                onPageSizeChange={changePageSize}
                                onPrevious={goPrevious}
                                pageSize={pageSize}
                                prefix="gdb"
                                rangeEnd={rangeEnd}
                                rangeStart={rangeStart}
                                total={total}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export type { GlobalDataBrowserProps };
