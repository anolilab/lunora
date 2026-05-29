import { useCirrus } from "@cirrus/react";
import { type ChangeEvent, type ReactElement, useCallback, useEffect, useState } from "react";

import { ADMIN_FUNCTIONS, type TableInfo, type TablePage } from "./admin.js";
import { adminRef, callOptions, errorMessage } from "./internal.js";

export interface SchemaViewerProps {
    /** Shard key the viewer targets. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);

/**
 * Schema overview for a single shard: every user table with its row count, and
 * — on expand — the table's column list. The runtime has no dedicated schema
 * RPC, so columns are derived from a one-row `__cirrus_admin__:readTablePage`
 * probe (`PRAGMA table_info`), fetched lazily the first time a table is opened.
 *
 * Read-only and gated by the server's `CIRRUS_ADMIN_TOKEN`, like the rest of the
 * dashboard's admin surface.
 */
export function SchemaViewer({ initialShardKey }: SchemaViewerProps): ReactElement {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [tables, setTables] = useState<TableInfo[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [columns, setColumns] = useState<Record<string, string[]>>({});
    const [expanded, setExpanded] = useState<null | string>(null);

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setError(null);

            try {
                const result = (await client.query(LIST_TABLES, {}, callOptions(shard))) as TableInfo[];

                setTables(result);
                setColumns({});
                setExpanded(null);
            } catch (error_) {
                setTables(null);
                setError(errorMessage(error_));
            }
        },
        [client],
    );

    useEffect(() => {
        void refresh(initialShardKey ?? "");
    }, [refresh, initialShardKey]);

    const toggle = useCallback(
        async (table: string): Promise<void> => {
            if (expanded === table) {
                setExpanded(null);

                return;
            }

            setExpanded(table);

            if (columns[table] !== undefined) {
                return;
            }

            try {
                const page = (await client.query(READ_TABLE_PAGE, { limit: 1, offset: 0, table }, callOptions(shardKey))) as TablePage;

                setColumns((previous) => ({ ...previous, [table]: page.columns }));
            } catch (error_) {
                setError(errorMessage(error_));
            }
        },
        [client, columns, expanded, shardKey],
    );

    return (
        <div data-testid="cirrus-schema">
            <div>
                <input
                    aria-label="Shard key"
                    data-testid="sc-shard-input"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                        setShardKey(event.target.value);
                    }}
                    placeholder="shard key (optional)"
                    value={shardKey}
                />
                <button
                    data-testid="sc-refresh"
                    onClick={() => {
                        void refresh(shardKey);
                    }}
                    type="button"
                >
                    Refresh
                </button>
            </div>

            {error !== null && (
                <p data-testid="sc-error" role="alert">
                    {error}
                </p>
            )}

            {tables !== null && (
                <ul data-testid="sc-table-list">
                    {tables.map((table) => (
                        <li data-testid={`sc-table-${table.name}`} key={table.name}>
                            <button
                                aria-expanded={expanded === table.name}
                                data-testid={`sc-toggle-${table.name}`}
                                onClick={() => {
                                    void toggle(table.name);
                                }}
                                type="button"
                            >
                                {table.name} ({table.rowCount})
                            </button>
                            {expanded === table.name && (
                                <ul data-testid={`sc-columns-${table.name}`}>
                                    {(columns[table.name] ?? []).map((column) => (
                                        <li key={column}>{column}</li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
