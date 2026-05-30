import { useCirrus } from "@cirrus/react";
import { type ReactElement, useCallback, useEffect, useState } from "react";

import { ADMIN_FUNCTIONS, type TableInfo, type TablePage, type WriteRowResult } from "./admin.js";
import { adminRef, callOptions } from "./internal.js";

export interface DataBrowserProps {
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

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);
const WRITE_ROW = adminRef(ADMIN_FUNCTIONS.writeRow);

/**
 * The primary key of a row. Shard tables store it in the `id` column; the
 * `__id__` / `_id` fallbacks cover the column aliases other layers expose.
 * Returns `null` when no id-like column is present (an uneditable row).
 */
const rowId = (row: Record<string, unknown>): null | string => {
    for (const key of ["id", "__id__", "_id"]) {
        const value = row[key];

        if (typeof value === "string" || typeof value === "number") {
            return String(value);
        }
    }

    return null;
};

/**
 * The editable document for a row. Shard rows keep their fields in a `__doc__`
 * JSON column; when present we parse it, otherwise we fall back to the row's own
 * non-meta columns. Used to prefill the edit form.
 */
const rowDoc = (row: Record<string, unknown>): Record<string, unknown> => {
    const raw = row["__doc__"];

    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw) as unknown;

            if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // fall through to the column-strip path
        }
    }

    const doc: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
        if (key !== "id" && key !== "__id__" && key !== "_id" && key !== "_creationTime" && key !== "__doc__") {
            doc[key] = value;
        }
    }

    return doc;
};

/**
 * A stable React key for a row. Cirrus tables always carry a primary key, so
 * prefer it; the positional fallback only applies to the rare idless page and is
 * hidden behind this helper so it isn't an inline array-index key.
 */
const rowKey = (row: Record<string, unknown>, index: number): string => {
    return rowId(row) ?? `row-${index}`;
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
export function DataBrowser({ editable = false, initialShardKey, pageSize = DEFAULT_PAGE_SIZE }: DataBrowserProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [tables, setTables] = useState<TableInfo[] | null>(null);
    const [tablesError, setTablesError] = useState<null | string>(null);

    const [selectedTable, setSelectedTable] = useState<null | string>(null);
    const [offset, setOffset] = useState<number>(0);
    const [page, setPage] = useState<TablePage | null>(null);
    const [pageError, setPageError] = useState<null | string>(null);
    const [viewMode, setViewMode] = useState<"json" | "table">("table");

    // Edit state: the row being edited (its id, or `""` for a new insert) and
    // the JSON-doc draft. `null` when no editor is open. `writeError` surfaces a
    // rejected write without disturbing the page-read error.
    const [editing, setEditing] = useState<null | { docText: string; id: null | string }>(null);
    const [writeError, setWriteError] = useState<null | string>(null);

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

    // Issue a writeRow op then reload the current page so the change shows. A
    // delete passes no doc; insert (id === "") / patch carry the JSON draft.
    const writeRow = useCallback(
        async (op: "delete" | "insert" | "patch", id: null | string, docText?: string): Promise<void> => {
            if (selectedTable === null) {
                return;
            }

            setWriteError(null);

            let doc: Record<string, unknown> | undefined;

            if (op !== "delete") {
                try {
                    doc = docText === undefined || docText.trim() === "" ? {} : (JSON.parse(docText) as Record<string, unknown>);
                } catch (error) {
                    setWriteError(`Invalid JSON: ${(error as Error).message}`);

                    return;
                }
            }

            try {
                (await client.query(WRITE_ROW, { doc, id: id ?? undefined, op, table: selectedTable }, callOptions(shardKey))) as WriteRowResult;
                setEditing(null);
                await fetchPage(shardKey, selectedTable, offset);
            } catch (error) {
                setWriteError((error as Error).message);
            }
        },
        [client, fetchPage, offset, selectedTable, shardKey],
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
                        {editable && (
                            <button
                                data-testid="db-add-row"
                                onClick={() => {
                                    setWriteError(null);
                                    setEditing({ docText: "{}", id: "" });
                                }}
                                type="button"
                            >
                                Add row
                            </button>
                        )}
                    </div>

                    {editable && editing !== null && (
                        <div data-testid="db-editor">
                            <textarea
                                aria-label="Row document JSON"
                                data-testid="db-editor-doc"
                                onChange={(event) => {
                                    setEditing({ docText: event.target.value, id: editing.id });
                                }}
                                value={editing.docText}
                            />
                            <button
                                data-testid="db-editor-save"
                                onClick={() => {
                                    void writeRow(editing.id === "" ? "insert" : "patch", editing.id === "" ? null : editing.id, editing.docText);
                                }}
                                type="button"
                            >
                                Save
                            </button>
                            <button
                                data-testid="db-editor-cancel"
                                onClick={() => {
                                    setEditing(null);
                                    setWriteError(null);
                                }}
                                type="button"
                            >
                                Cancel
                            </button>
                        </div>
                    )}

                    {writeError !== null && (
                        <p data-testid="db-write-error" role="alert">
                            {writeError}
                        </p>
                    )}

                    {viewMode === "table" && (
                        <table data-testid="db-rows">
                            <thead>
                                <tr>
                                    {page.columns.map((column) => (
                                        <th key={column}>{column}</th>
                                    ))}
                                    {editable && <th />}
                                </tr>
                            </thead>
                            <tbody>
                                {page.rows.map((row, rowIndex) => (
                                    <tr data-testid="db-row" key={rowKey(row, rowIndex)}>
                                        {page.columns.map((column) => (
                                            <td key={column}>{formatCell(row[column])}</td>
                                        ))}
                                        {editable && (
                                            <td>
                                                <button
                                                    data-testid={`db-edit-${rowKey(row, rowIndex)}`}
                                                    disabled={rowId(row) === null}
                                                    onClick={() => {
                                                        setWriteError(null);
                                                        setEditing({ docText: JSON.stringify(rowDoc(row), null, 2), id: rowId(row) });
                                                    }}
                                                    type="button"
                                                >
                                                    Edit
                                                </button>
                                                <button
                                                    data-testid={`db-delete-${rowKey(row, rowIndex)}`}
                                                    disabled={rowId(row) === null}
                                                    onClick={() => {
                                                        void writeRow("delete", rowId(row));
                                                    }}
                                                    type="button"
                                                >
                                                    Delete
                                                </button>
                                            </td>
                                        )}
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
