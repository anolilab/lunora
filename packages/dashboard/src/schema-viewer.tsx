import type { GlobalTableInfo } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";

import type { TableInfo, TablePage } from "./admin.js";
import { ADMIN_FUNCTIONS } from "./admin.js";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal.js";
import { recordShard } from "./shard-history.js";
import { ShardInput } from "./shard-input.js";
import { StorageTierBadge, StorageTierHint } from "./storage-tier.js";

interface SchemaViewerProps {
    /** Shard key the viewer targets. Defaults to the root shard. */
    readonly initialShardKey?: string;
}

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);

const SECTION_STYLE: CSSProperties = { margin: "0 0 20px" };
const SECTION_HEADING_STYLE: CSSProperties = { alignItems: "center", display: "flex", gap: 8, margin: "0 0 4px" };
const SECTION_TITLE_STYLE: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };

/**
 * Schema overview that shows both storage tiers side by side so the distinction
 * is never a mystery. The shard section lists every user table in the selected
 * Durable Object with row counts, and probes a table's columns on expand via a
 * one-row `__cirrus_admin__:readTablePage` (`PRAGMA table_info`). The global
 * section lists every `.global()` table — including the auth tables (`user`,
 * `session`, …) — via the client's `listGlobalTables()`, reading columns from a
 * one-row `readGlobalTablePage` on expand.
 *
 * Read-only and gated by the server's `CIRRUS_ADMIN_TOKEN`, like the rest of the
 * dashboard's admin surface. Global discovery is best-effort: if D1 isn't
 * configured the global section simply reports it, and the shard section still
 * works.
 */
export const SchemaViewer = ({ initialShardKey }: SchemaViewerProps): ReactElement => {
    const client = useCirrus();

    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [tables, setTables] = useState<TableInfo[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [columns, setColumns] = useState<Record<string, string[]>>({});
    const [expanded, setExpanded] = useState<null | string>(null);

    const [globalTables, setGlobalTables] = useState<GlobalTableInfo[] | null>(null);
    const [globalError, setGlobalError] = useState<null | string>(null);
    const [globalColumns, setGlobalColumns] = useState<Record<string, string[]>>({});
    const [globalExpanded, setGlobalExpanded] = useState<null | string>(null);

    const refresh = useCallback(
        async (shard: string): Promise<void> => {
            setError(null);

            try {
                const result = (await client.query(LIST_TABLES, {}, callOptions(shard))) as TableInfo[];

                recordShard(shard);
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

    const refreshGlobal = useCallback(async (): Promise<void> => {
        setGlobalError(null);

        try {
            setGlobalTables(await client.listGlobalTables());
        } catch (error_) {
            setGlobalTables(null);
            setGlobalError(errorMessage(error_));
        }
    }, [client]);

    useEffect(() => {
        fireAndForget(refresh(initialShardKey ?? ""));
        fireAndForget(refreshGlobal());
    }, [refresh, refreshGlobal, initialShardKey]);

    const toggle = useCallback(
        async (table: string): Promise<void> => {
            if (expanded === table) {
                setExpanded(null);

                return;
            }

            setExpanded(table);

            // Key the column cache by shard + table so editing the shard input
            // without clicking Refresh and then expanding a table can't return a
            // previous shard's columns; the probe below uses the same shardKey.
            const cacheKey = `${shardKey}:${table}`;

            if (columns[cacheKey] !== undefined) {
                return;
            }

            try {
                const page = (await client.query(READ_TABLE_PAGE, { limit: 1, offset: 0, table }, callOptions(shardKey))) as TablePage;

                setColumns((previous) => {
                    return { ...previous, [cacheKey]: page.columns };
                });
            } catch (error_) {
                setError(errorMessage(error_));
            }
        },
        [client, columns, expanded, shardKey],
    );

    const toggleGlobal = useCallback(
        async (table: string): Promise<void> => {
            if (globalExpanded === table) {
                setGlobalExpanded(null);

                return;
            }

            setGlobalExpanded(table);

            if (globalColumns[table] !== undefined) {
                return;
            }

            try {
                const page = await client.readGlobalTablePage({ limit: 1, offset: 0, table });

                setGlobalColumns((previous) => {
                    return { ...previous, [table]: page.columns };
                });
            } catch (error_) {
                setGlobalError(errorMessage(error_));
            }
        },
        [client, globalColumns, globalExpanded],
    );

    const refreshCurrent = useCallback((): void => {
        fireAndForget(refresh(shardKey));
        fireAndForget(refreshGlobal());
    }, [refresh, refreshGlobal, shardKey]);

    return (
        <div data-testid="cirrus-schema">
            <div>
                <ShardInput onChange={setShardKey} testId="sc-shard-input" value={shardKey} />
                <button data-testid="sc-refresh" onClick={refreshCurrent} type="button">
                    Refresh
                </button>
            </div>

            <section data-testid="sc-shard-section" style={SECTION_STYLE}>
                <div style={SECTION_HEADING_STYLE}>
                    <StorageTierBadge tier="shard" />
                    <h3 style={SECTION_TITLE_STYLE}>Shard tables</h3>
                </div>
                <StorageTierHint tier="shard" />

                {error !== null && (
                    <p data-testid="sc-error" role="alert">
                        {error}
                    </p>
                )}

                {tables !== null && tables.length === 0 && <p data-testid="sc-empty">No tables in this shard.</p>}

                {tables !== null && tables.length > 0 && (
                    <ul data-testid="sc-table-list">
                        {tables.map((table) => (
                            <li data-testid={`sc-table-${table.name}`} key={table.name}>
                                <button
                                    aria-expanded={expanded === table.name}
                                    data-testid={`sc-toggle-${table.name}`}
                                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row toggle closes over table.name; admin dev-tool render path
                                    onClick={() => {
                                        fireAndForget(toggle(table.name));
                                    }}
                                    type="button"
                                >
                                    {table.name} ({table.rowCount})
                                </button>
                                {expanded === table.name && (
                                    <ul data-testid={`sc-columns-${table.name}`}>
                                        {(columns[`${shardKey}:${table.name}`] ?? []).map((column) => (
                                            <li key={column}>{column}</li>
                                        ))}
                                    </ul>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section data-testid="sc-global-section" style={SECTION_STYLE}>
                <div style={SECTION_HEADING_STYLE}>
                    <StorageTierBadge tier="global" />
                    <h3 style={SECTION_TITLE_STYLE}>Global tables</h3>
                </div>
                <StorageTierHint tier="global" />

                {globalError !== null && (
                    <p data-testid="sc-global-error" role="alert">
                        {globalError}
                    </p>
                )}

                {globalTables !== null && globalTables.length === 0 && <p data-testid="sc-global-empty">No global tables.</p>}

                {globalTables !== null && globalTables.length > 0 && (
                    <ul data-testid="sc-global-table-list">
                        {globalTables.map((table) => (
                            <li data-testid={`sc-global-table-${table.name}`} key={table.name}>
                                <button
                                    aria-expanded={globalExpanded === table.name}
                                    data-testid={`sc-global-toggle-${table.name}`}
                                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- per-row toggle closes over table.name; admin dev-tool render path
                                    onClick={() => {
                                        fireAndForget(toggleGlobal(table.name));
                                    }}
                                    type="button"
                                >
                                    {table.name} ({table.rowCount})
                                </button>
                                {globalExpanded === table.name && (
                                    <ul data-testid={`sc-global-columns-${table.name}`}>
                                        {(globalColumns[table.name] ?? []).map((column) => (
                                            <li key={column}>{column}</li>
                                        ))}
                                    </ul>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
};

export type { SchemaViewerProps };
