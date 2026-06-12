import type { GlobalTableInfo } from "@cirrus/client";
import { useCirrus } from "@cirrus/react";
import type { CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TableIndexesResult, TableIndexInfo, TableInfo, TablePage } from "./admin";
import { ADMIN_FUNCTIONS } from "./admin";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { useT } from "./i18n-context";
import { adminRef, callOptions, errorMessage, fireAndForget } from "./internal";
import type { SchemaEdge } from "./schema-graph";
import { SchemaGraph } from "./schema-graph";
import { recordShard } from "./shard-history";
import { ShardInput } from "./shard-input";
import { StorageTierBadge, StorageTierHint } from "./storage-tier";
import useDebounced from "./use-debounced";

interface SchemaViewerProps {
    /** Shard key the viewer targets. Defaults to the root shard. */
    readonly initialShardKey?: string;

    /**
     * Table to auto-expand once the shard's tables load. Set by the Insights
     * "add the index" deep-link (`/schema?table=&lt;name>`) so the operator lands
     * directly on the scanned table's index list instead of hunting for it.
     * Re-applied whenever the value changes, so following the link a second time
     * (same tab already open) re-expands the target.
     */
    readonly initialTable?: string;
}

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const LIST_TABLE_INDEXES = adminRef(ADMIN_FUNCTIONS.listTableIndexes);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);

/** Hoisted empty edge list so the graph props don't allocate a fresh array each render. */
const EMPTY_EDGES: ReadonlyArray<SchemaEdge> = [];

/** How the schema is presented: a textual table list, or the relationship graph. */
type SchemaView = "graph" | "list";

/**
 * Turn a `readTablePage`'s `refs` map (column → target table) into directed
 * foreign-key edges from `from` to each referenced target. Tolerates a missing
 * `refs` field (the probe failed or the table has no `v.id` columns).
 */
const referencesToEdges = (from: string, references: Record<string, string> | undefined): SchemaEdge[] => {
    if (references === undefined) {
        return [];
    }

    return Object.entries(references).map(([column, to]) => {
        return { column, from, to };
    });
};

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
 * studio's admin surface. Global discovery is best-effort: if D1 isn't
 * configured the global section simply reports it, and the shard section still
 * works.
 */
export const SchemaViewer = ({ initialShardKey, initialTable }: SchemaViewerProps): ReactElement => {
    const client = useCirrus();
    const t = useT();

    const [view, setView] = useState<SchemaView>("list");
    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
    const [tables, setTables] = useState<TableInfo[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [columns, setColumns] = useState<Record<string, string[]>>({});
    // Declared indexes per `${shardKey}:${table}`, loaded lazily alongside columns on expand.
    const [indexes, setIndexes] = useState<Record<string, TableIndexInfo[]>>({});
    const [expanded, setExpanded] = useState<null | string>(null);

    // Foreign-key edges for the shard tier, keyed by shard so a shard switch
    // can't show a previous shard's relationships. Built by probing each table's
    // `refs` (one-row `readTablePage`) lazily when the graph view is opened.
    const [shardEdges, setShardEdges] = useState<Record<string, SchemaEdge[]>>({});

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
                setIndexes({});
                setExpanded(null);
                // Drop cached relationships for this shard so the graph re-probes
                // against the freshly listed tables.
                setShardEdges((previous) => Object.fromEntries(Object.entries(previous).filter(([cachedShard]) => cachedShard !== shard)));
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

    // Re-read on the debounced shard key so switching shards re-loads the schema
    // once the value settles (no Refresh button). Schema is static between
    // codegen/migrations, so there's no live channel or poll — just this re-load.
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    useEffect(() => {
        fireAndForget(refresh(debouncedShard));
        fireAndForget(refreshGlobal());
    }, [refresh, refreshGlobal, debouncedShard]);

    const toggle = useCallback(
        async (table: string): Promise<void> => {
            if (expanded === table) {
                setExpanded(null);

                return;
            }

            setExpanded(table);

            // Key the column cache by shard + table so editing the shard input
            // (before the debounced re-load settles) and then expanding a table
            // can't return a previous shard's columns; the probe below uses the
            // same shardKey.
            const cacheKey = `${shardKey}:${table}`;

            if (columns[cacheKey] !== undefined) {
                return;
            }

            // Probe columns and indexes concurrently. Indexes are best-effort: an
            // older worker without `listTableIndexes` (or one without an admin
            // token for that read) still shows the column list.
            const [page, indexResult] = await Promise.allSettled([
                client.query(READ_TABLE_PAGE, { limit: 1, offset: 0, table }, callOptions(shardKey)) as Promise<TablePage>,
                client.query(LIST_TABLE_INDEXES, { table }, callOptions(shardKey)) as Promise<TableIndexesResult>,
            ]);

            if (page.status === "fulfilled") {
                setColumns((previous) => {
                    return { ...previous, [cacheKey]: page.value.columns };
                });
            } else {
                setError(errorMessage(page.reason));
            }

            if (indexResult.status === "fulfilled") {
                setIndexes((previous) => {
                    return { ...previous, [cacheKey]: indexResult.value.indexes };
                });
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

    // Auto-expand the deep-linked table (Insights "add the index" jump) once the
    // shard's tables have loaded and the target actually exists. `appliedTable`
    // guards against re-firing every render — we expand a given `initialTable`
    // at most once per value, so the operator can still collapse it by hand.
    const appliedTable = useRef<string | undefined>(undefined);

    useEffect(() => {
        /* eslint-disable react-you-might-not-need-an-effect/no-event-handler -- deep-link sync: expand the `initialTable` navigation prop once the async-loaded `tables` arrive; there's no render-time data and no user event to hook into, and the ref guards against re-firing */
        if (initialTable === undefined || tables === null || appliedTable.current === initialTable) {
            return;
        }

        if (tables.some((table) => table.name === initialTable)) {
            appliedTable.current = initialTable;
            fireAndForget(toggle(initialTable));
        }
        /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */
    }, [initialTable, tables, toggle]);

    // Probe each shard table's `refs` (one row apiece) and collect the foreign-key
    // edges for the graph. A single table's probe failing must not blank the
    // graph, so each probe's rejection is swallowed and that table simply
    // contributes no edges.
    const probeShardEdges = useCallback(
        async (shard: string, names: string[]): Promise<void> => {
            const results = await Promise.all(
                names.map(async (table): Promise<SchemaEdge[]> => {
                    try {
                        const page = (await client.query(READ_TABLE_PAGE, { limit: 1, offset: 0, table }, callOptions(shard))) as TablePage;

                        return referencesToEdges(table, page.refs);
                    } catch {
                        return [];
                    }
                }),
            );

            setShardEdges((previous) => {
                return { ...previous, [shard]: results.flat() };
            });
        },
        [client],
    );

    // When the graph opens (or the shard's tables change) probe the relationships
    // once per shard. List view never probes, so the graph cost is opt-in. This is
    // a genuine lazy data-load, not a click handler: it must also re-run when the
    // shard's `tables` change (after a re-seed) or `shardKey` switches, so it stays
    // an effect keyed on those values rather than firing from the toggle's onClick.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- lazy data-load gated on view + shard, not an event handler
        if (view !== "graph" || tables === null || shardEdges[shardKey] !== undefined) {
            return;
        }

        fireAndForget(
            probeShardEdges(
                shardKey,
                tables.map((table) => table.name),
            ),
        );
    }, [view, tables, shardKey, shardEdges, probeShardEdges]);

    const shardTableNames = useMemo<string[]>(() => (tables ?? []).map((table) => table.name), [tables]);
    const globalTableNames = useMemo<string[]>(() => (globalTables ?? []).map((table) => table.name), [globalTables]);

    const showList = useCallback((): void => {
        setView("list");
    }, []);
    const showGraph = useCallback((): void => {
        setView("graph");
    }, []);

    return (
        <div data-testid="cirrus-schema">
            <div>
                <ShardInput onChange={setShardKey} testId="sc-shard-input" value={shardKey} />
            </div>

            <div aria-label={t("Schema view")} className="my-3 flex gap-1.5" data-testid="sc-view-toggle" role="group">
                <Button
                    aria-pressed={view === "list"}
                    data-testid="sc-view-list"
                    onClick={showList}
                    size="xs"
                    type="button"
                    variant={view === "list" ? "default" : "outline"}
                >
                    {t("Table list")}
                </Button>
                <Button
                    aria-pressed={view === "graph"}
                    data-testid="sc-view-graph"
                    onClick={showGraph}
                    size="xs"
                    type="button"
                    variant={view === "graph" ? "default" : "outline"}
                >
                    {t("Graph")}
                </Button>
            </div>

            {view === "graph" && (
                <div className="flex flex-col gap-5" data-testid="sc-graph-view">
                    {error !== null && (
                        <p data-testid="sc-error" role="alert">
                            {error}
                        </p>
                    )}
                    <SchemaGraph edges={shardEdges[shardKey] ?? EMPTY_EDGES} tables={shardTableNames} testIdPrefix="sc-graph-shard" tier="shard" />
                    {globalError !== null && (
                        <p data-testid="sc-global-error" role="alert">
                            {globalError}
                        </p>
                    )}
                    <SchemaGraph edges={EMPTY_EDGES} tables={globalTableNames} testIdPrefix="sc-graph-global" tier="global" />
                </div>
            )}

            {view === "list" && (
                <>
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
                                        {expanded === table.name && (indexes[`${shardKey}:${table.name}`] ?? []).length > 0 && (
                                            <ul className="mt-1 flex flex-col gap-1" data-testid={`sc-indexes-${table.name}`}>
                                                {(indexes[`${shardKey}:${table.name}`] ?? []).map((index) => (
                                                    <li className="flex flex-wrap items-center gap-1.5 text-xs" key={`${index.type}:${index.name}`}>
                                                        <span className="font-mono">{index.name}</span>
                                                        <Badge variant="outline">{index.type}</Badge>
                                                        {index.unique === true && <Badge variant="secondary">unique</Badge>}
                                                        <span className="text-muted-foreground">{index.fields.join(", ")}</span>
                                                    </li>
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
                </>
            )}
        </div>
    );
};

export type { SchemaViewerProps };
