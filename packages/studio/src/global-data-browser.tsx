import type { GlobalTableInfo, GlobalTablePage } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import { EmptyState } from "./components/ui/empty-state.js";
import { errorMessage, fireAndForget, formatCell } from "./internal.js";
import { StorageTierHeader } from "./storage-tier.js";

interface GlobalDataBrowserProps {
    /** Rows requested per page. Clamped server-side to `[1, 500]`. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * A stable React key for a global-table row. `.global()` docs carry an `_id`
 * primary key; the positional fallback only applies to the rare idless page.
 */
const rowKey = (row: Record<string, unknown>, index: number): string => {
    const id = row["_id"];

    return typeof id === "string" || typeof id === "number" ? String(id) : `row-${index.toString()}`;
};

/**
 * Read-only browser for `.global()` (D1-backed) tables. Twin of
 * `DataBrowser`, but the global counterpart isn't shard-scoped: it lists
 * tables via the client's `listGlobalTables()` (the `/_cirrus/admin/global/tables`
 * endpoint) and pages rows via `readGlobalTablePage()`. Gated by the server's
 * `CIRRUS_ADMIN_TOKEN`, and only surfaces tables declared `.global()`.
 */
export const GlobalDataBrowser = ({ pageSize = DEFAULT_PAGE_SIZE }: GlobalDataBrowserProps = {}): ReactElement => {
    const client = useCirrus();

    const [tables, setTables] = useState<GlobalTableInfo[] | null>(null);
    const [tablesError, setTablesError] = useState<null | string>(null);

    const [selectedTable, setSelectedTable] = useState<null | string>(null);
    const [offset, setOffset] = useState<number>(0);
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
        async (table: string, nextOffset: number): Promise<void> => {
            setPageError(null);

            try {
                const result = await client.readGlobalTablePage({ limit: pageSize, offset: nextOffset, table });

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

    return (
        <div data-testid="cirrus-global-data-browser">
            <StorageTierHeader tier="global" />

            <button data-testid="gdb-load-tables" onClick={reloadTables} type="button">
                Reload tables
            </button>

            {tablesError !== null && (
                <p data-testid="gdb-tables-error" role="alert">
                    {tablesError}
                </p>
            )}

            {tables !== null && tables.length === 0 && (
                <EmptyState
                    description="Tables marked .global() (D1-backed, region-replicated) will appear here."
                    icon={
                        <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} viewBox="0 0 24 24">
                            <circle cx="12" cy="12" r="9" />
                            <path d="M3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
                        </svg>
                    }
                    testId="gdb-empty"
                    title="No global tables."
                />
            )}

            {tables !== null && tables.length > 0 && (
                <ul data-testid="gdb-table-list">
                    {tables.map((table) => (
                        <li key={table.name}>
                            <button
                                aria-pressed={selectedTable === table.name}
                                data-testid={`gdb-table-${table.name}`}
                                // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row handler closes over table.name; admin dev-tool render path
                                onClick={() => {
                                    selectTable(table.name);
                                }}
                                type="button"
                            >
                                {table.name} ({table.rowCount})
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {pageError !== null && (
                <p data-testid="gdb-page-error" role="alert">
                    {pageError}
                </p>
            )}

            {page !== null && (
                <div data-testid="gdb-page">
                    <table data-testid="gdb-rows">
                        <thead>
                            <tr>
                                {page.columns.map((column) => (
                                    <th key={column}>{column}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {page.rows.map((row, rowIndex) => (
                                <tr data-testid="gdb-row" key={rowKey(row, rowIndex)}>
                                    {page.columns.map((column) => (
                                        <td key={column}>{formatCell(row[column])}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <div>
                        <button data-testid="gdb-prev" disabled={!hasPrevious} onClick={goPrevious} type="button">
                            Previous
                        </button>
                        <span data-testid="gdb-page-info">
                            {rangeStart}-{rangeEnd} of {total}
                        </span>
                        <button data-testid="gdb-next" disabled={!hasNext} onClick={goNext} type="button">
                            Next
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};

export type { GlobalDataBrowserProps };
