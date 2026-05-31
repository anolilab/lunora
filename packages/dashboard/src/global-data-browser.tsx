import type { GlobalTableInfo, GlobalTablePage } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { errorMessage } from "./internal.js";

export interface GlobalDataBrowserProps {
    /** Rows requested per page. Clamped server-side to `[1, 500]`. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

/** Render a single cell value as text without throwing on objects or null. */
const formatCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return "";
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    return String(value);
};

/**
 * A stable React key for a global-table row. `.global()` docs carry an `_id`
 * primary key; the positional fallback only applies to the rare idless page.
 */
const rowKey = (row: Record<string, unknown>, index: number): string => {
    const id = row["_id"];

    return typeof id === "string" || typeof id === "number" ? String(id) : `row-${index}`;
};

/**
 * Read-only browser for `.global()` (D1-backed) tables. Twin of
 * {@link DataBrowser}, but the global counterpart isn't shard-scoped: it lists
 * tables via the client's `listGlobalTables()` (the `/_cirrus/admin/global/tables`
 * endpoint) and pages rows via `readGlobalTablePage()`. Gated by the server's
 * `CIRRUS_ADMIN_TOKEN`, and only surfaces tables declared `.global()`.
 */
export function GlobalDataBrowser({ pageSize = DEFAULT_PAGE_SIZE }: GlobalDataBrowserProps = {}): ReactElement {
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
        void fetchTables();
    }, [fetchTables]);

    const selectTable = useCallback(
        (table: string): void => {
            setSelectedTable(table);
            void fetchPage(table, 0);
        },
        [fetchPage],
    );

    const goToPage = useCallback(
        (nextOffset: number): void => {
            if (selectedTable === null) {
                return;
            }

            void fetchPage(selectedTable, Math.max(0, nextOffset));
        },
        [fetchPage, selectedTable],
    );

    const total = page?.total ?? 0;
    const hasPrevious = offset > 0;
    const hasNext = page !== null && offset + page.rows.length < total;
    const rangeStart = page === null || page.rows.length === 0 ? 0 : offset + 1;
    const rangeEnd = page === null ? 0 : offset + page.rows.length;

    return (
        <div data-testid="cirrus-global-data-browser">
            <button
                data-testid="gdb-load-tables"
                onClick={() => {
                    void fetchTables();
                }}
                type="button"
            >
                Reload tables
            </button>

            {tablesError !== null && (
                <p data-testid="gdb-tables-error" role="alert">
                    {tablesError}
                </p>
            )}

            {tables !== null && tables.length === 0 && <p data-testid="gdb-empty">No global tables.</p>}

            {tables !== null && tables.length > 0 && (
                <ul data-testid="gdb-table-list">
                    {tables.map((table) => (
                        <li key={table.name}>
                            <button
                                aria-pressed={selectedTable === table.name}
                                data-testid={`gdb-table-${table.name}`}
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
                        <button
                            data-testid="gdb-prev"
                            disabled={!hasPrevious}
                            onClick={() => {
                                goToPage(offset - pageSize);
                            }}
                            type="button"
                        >
                            Previous
                        </button>
                        <span data-testid="gdb-page-info">
                            {rangeStart}-{rangeEnd} of {total}
                        </span>
                        <button
                            data-testid="gdb-next"
                            disabled={!hasNext}
                            onClick={() => {
                                goToPage(offset + pageSize);
                            }}
                            type="button"
                        >
                            Next
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
