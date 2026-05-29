import type { FunctionReference } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { ADMIN_FUNCTIONS, type TableInfo, type TablePage } from "./admin.js";

export interface DataBrowserProps {
    /** Shard key the browser targets on first load. Defaults to the root shard. */
    readonly initialShardKey?: string;
    /** Rows requested per page. Clamped server-side to `[1, 500]`. */
    readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

const LIST_TABLES: FunctionReference = { __cirrusRef: ADMIN_FUNCTIONS.listTables };
const READ_TABLE_PAGE: FunctionReference = { __cirrusRef: ADMIN_FUNCTIONS.readTablePage };

const callOptions = (shardKey: string): { shardKey?: string } => {
    const trimmed = shardKey.trim();

    return trimmed === "" ? {} : { shardKey: trimmed };
};

/**
 * A stable React key for a row. Cirrus tables always carry an `__id__` primary
 * key, so prefer it; the positional fallback only applies to the rare idless
 * page and is hidden behind this helper so it isn't an inline array-index key.
 */
const rowKey = (row: Record<string, unknown>, index: number): string => {
    const id = row["__id__"];

    return typeof id === "string" || typeof id === "number" ? String(id) : `row-${index}`;
};

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
 * Read-only data browser for a single shard's SQLite database. Lists the user
 * tables (via the `__cirrus_admin__:listTables` RPC), then pages through the
 * rows of whichever table is selected (`__cirrus_admin__:readTablePage`).
 *
 * Both calls travel over the ordinary {@link useCirrus} client transport; the
 * admin RPCs are intercepted inside the Durable Object and are gated by the
 * server's `CIRRUS_ADMIN_TOKEN`. The host is responsible for configuring the
 * client's auth token — this component issues no credentials of its own.
 */
export function DataBrowser({ initialShardKey, pageSize = DEFAULT_PAGE_SIZE }: DataBrowserProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [tables, setTables] = useState<TableInfo[] | null>(null);
    const [tablesError, setTablesError] = useState<null | string>(null);

    const [selectedTable, setSelectedTable] = useState<null | string>(null);
    const [offset, setOffset] = useState<number>(0);
    const [page, setPage] = useState<TablePage | null>(null);
    const [pageError, setPageError] = useState<null | string>(null);
    const [viewMode, setViewMode] = useState<"json" | "table">("table");

    const fetchTables = useCallback(
        async (shard: string): Promise<void> => {
            setTablesError(null);

            try {
                const result = (await client.query(LIST_TABLES, {}, callOptions(shard))) as TableInfo[];

                setTables(result);
            } catch (error) {
                setTables(null);
                setTablesError((error as Error).message);
            }
        },
        [client],
    );

    const fetchPage = useCallback(
        async (shard: string, table: string, nextOffset: number): Promise<void> => {
            setPageError(null);

            try {
                const result = (await client.query(READ_TABLE_PAGE, { limit: pageSize, offset: nextOffset, table }, callOptions(shard))) as TablePage;

                setPage(result);
                setOffset(nextOffset);
            } catch (error) {
                setPage(null);
                setPageError((error as Error).message);
            }
        },
        [client, pageSize],
    );

    // Initial load only. Subsequent reloads are driven by the "Load tables"
    // button so typing a shard key doesn't fire a request per keystroke.
    useEffect(() => {
        void fetchTables(initialShardKey ?? "");
    }, [fetchTables, initialShardKey]);

    const selectTable = useCallback(
        (table: string): void => {
            setSelectedTable(table);
            void fetchPage(shardKey, table, 0);
        },
        [fetchPage, shardKey],
    );

    const goToPage = useCallback(
        (nextOffset: number): void => {
            if (selectedTable === null) {
                return;
            }

            void fetchPage(shardKey, selectedTable, Math.max(0, nextOffset));
        },
        [fetchPage, selectedTable, shardKey],
    );

    const total = page?.total ?? 0;
    const hasPrevious = offset > 0;
    const hasNext = page !== null && offset + page.rows.length < total;
    const rangeStart = page === null || page.rows.length === 0 ? 0 : offset + 1;
    const rangeEnd = page === null ? 0 : offset + page.rows.length;

    return (
        <div data-testid="cirrus-data-browser">
            <div>
                <input
                    aria-label="Shard key"
                    data-testid="db-shard-input"
                    onChange={(event) => {
                        setShardKey(event.target.value);
                    }}
                    placeholder="shard key (optional)"
                    value={shardKey}
                />
                <button
                    data-testid="db-load-tables"
                    onClick={() => {
                        void fetchTables(shardKey);
                    }}
                    type="button"
                >
                    Load tables
                </button>
            </div>

            {tablesError !== null && (
                <p data-testid="db-tables-error" role="alert">
                    {tablesError}
                </p>
            )}

            {tables !== null && (
                <ul data-testid="db-table-list">
                    {tables.map((table) => (
                        <li key={table.name}>
                            <button
                                aria-pressed={selectedTable === table.name}
                                data-testid={`db-table-${table.name}`}
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
                <p data-testid="db-page-error" role="alert">
                    {pageError}
                </p>
            )}

            {page !== null && (
                <div data-testid="db-page">
                    <div data-testid="db-view-toggle">
                        <button
                            aria-pressed={viewMode === "table"}
                            data-testid="db-view-table"
                            onClick={() => {
                                setViewMode("table");
                            }}
                            type="button"
                        >
                            Table
                        </button>
                        <button
                            aria-pressed={viewMode === "json"}
                            data-testid="db-view-json"
                            onClick={() => {
                                setViewMode("json");
                            }}
                            type="button"
                        >
                            JSON
                        </button>
                        <button
                            data-testid="db-refresh"
                            onClick={() => {
                                goToPage(offset);
                            }}
                            type="button"
                        >
                            Refresh
                        </button>
                    </div>

                    {viewMode === "table" && (
                        <table data-testid="db-rows">
                            <thead>
                                <tr>
                                    {page.columns.map((column) => (
                                        <th key={column}>{column}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {page.rows.map((row, rowIndex) => (
                                    <tr data-testid="db-row" key={rowKey(row, rowIndex)}>
                                        {page.columns.map((column) => (
                                            <td key={column}>{formatCell(row[column])}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}

                    {viewMode === "json" && <pre data-testid="db-json">{JSON.stringify(page.rows, null, 2)}</pre>}

                    <div>
                        <button
                            data-testid="db-prev"
                            disabled={!hasPrevious}
                            onClick={() => {
                                goToPage(offset - pageSize);
                            }}
                            type="button"
                        >
                            Previous
                        </button>
                        <span data-testid="db-page-info">
                            {rangeStart}-{rangeEnd} of {total}
                        </span>
                        <button
                            data-testid="db-next"
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
