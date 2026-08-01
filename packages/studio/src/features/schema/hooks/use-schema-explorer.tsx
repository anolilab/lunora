import type { GlobalTableInfo } from "@lunora/client";
import { useLunora } from "@lunora/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useShardKey } from "../../../hooks/use-shard-key";
import type { ColumnMeta, TableIndexesResult, TableIndexInfo, TableInfo, TablePage, TablesColumnsResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../../lib/internal";
import { recordShard } from "../../../lib/shard-history";
import type { DiagramTable } from "../schema-diagram";

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);

const LIST_TABLE_INDEXES = adminRef(ADMIN_FUNCTIONS.listTableIndexes);

const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);

const DESCRIBE_TABLES = adminRef(ADMIN_FUNCTIONS.describeTables);

/** How the schema is presented: a textual table list, or the relationship graph. */
type SchemaView = "graph" | "list";

/** Hoisted empty column map so the diagram model doesn't allocate a fresh object each render. */
const EMPTY_COLUMNS: Readonly<Record<string, ColumnMeta[]>> = {};

/** Hoisted empty typed-column list so an un-probed diagram table doesn't allocate a fresh array. */
const EMPTY_COLUMN_META: ReadonlyArray<ColumnMeta> = [];

/** The schema the viewer explores: both planes, their lazy loads, and the selection. */
interface SchemaExplorer {
    columns: Record<string, string[]>;
    diagramTables: DiagramTable[];
    error: null | string;
    /** The shard table whose detail row is open, or `null`. */
    expanded: null | string;
    filteredGlobalTables: GlobalTableInfo[];
    filteredTables: TableInfo[];
    globalColumns: Record<string, string[]>;
    globalError: null | string;
    globalExpanded: null | string;
    globalTables: GlobalTableInfo[] | null;
    indexes: Record<string, TableIndexInfo[]>;
    /** Re-list the shard — used after the editor overlay applies an additive edit. */
    refresh: (shard: string) => Promise<void>;
    setShardKey: (value: string) => void;
    setTableFilter: (value: string) => void;
    setView: (view: SchemaView) => void;
    /** Tables whose graph column probe failed, keyed by shard. */
    shardColumnsError: Record<string, boolean>;
    shardKey: string;
    tableFilter: string;
    tables: TableInfo[] | null;
    toggle: (table: string) => Promise<void>;
    toggleGlobal: (table: string) => Promise<void>;
    view: SchemaView;
}

/**
 * Everything the schema viewer explores: the shard's tables with their lazily
 * probed columns and indexes, the `.global()` (D1) tables with theirs, the
 * graph's column probe, and the view / shard / filter selection.
 *
 * Extracted from the component because the viewer was 471 lines of this behind
 * 18 lines of markup — the same split `useDataBrowser` and `useFileBrowser`
 * already use. Two schema planes (shard and global) with the same
 * expand-then-load shape live here together on purpose: the graph probe needs
 * both table lists, so separating them would mean threading one into the other.
 */
const useSchemaExplorer = ({ initialShardKey, initialTable }: { initialShardKey?: string; initialTable?: string }): SchemaExplorer => {
    const client = useLunora();
    const [view, setView] = useState<SchemaView>("graph");
    const { queryShardKey, setShardKey, shardKey } = useShardKey(initialShardKey);
    const [tableFilter, setTableFilter] = useState<string>("");
    const [tables, setTables] = useState<TableInfo[] | null>(null);
    const [error, setError] = useState<null | string>(null);
    const [columns, setColumns] = useState<Record<string, string[]>>({});
    // Declared indexes per `${shardKey}:${table}`, loaded lazily alongside columns on expand.
    const [indexes, setIndexes] = useState<Record<string, TableIndexInfo[]>>({});
    const [expanded, setExpanded] = useState<null | string>(null);

    // Typed columns for the diagram, keyed by shard → table → columns. Probed
    // once per shard via a single batched `describeTables` over every table —
    // shard-local AND global — when the graph opens. The metadata is
    // schema-sourced (real types + PK/FK markers, absent from `PRAGMA
    // table_info`), and the diagram derives the FK edges (including cross-tier
    // ones) straight from the columns' `ref`s.
    const [shardColumns, setShardColumns] = useState<Record<string, Record<string, ColumnMeta[]>>>({});

    // Shards whose typed-column probe (`describeTables`) failed — drives the
    // diagram's "columns unavailable" signal so a failed load isn't mistaken for
    // an empty table.
    const [shardColumnsError, setShardColumnsError] = useState<Record<string, boolean>>({});

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
                // Drop cached typed columns for this shard so the diagram
                // re-probes against the freshly listed tables.
                setShardColumns((previous) => Object.fromEntries(Object.entries(previous).filter(([cachedShard]) => cachedShard !== shard)));
                setShardColumnsError((previous) => Object.fromEntries(Object.entries(previous).filter(([cachedShard]) => cachedShard !== shard)));
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
    useEffect(() => {
        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- async schema load, re-run when the debounced shard settles
        fireAndForget(refresh(queryShardKey));
        fireAndForget(refreshGlobal());
    }, [refresh, refreshGlobal, queryShardKey]);

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

    const toggleGlobal = async (table: string): Promise<void> => {
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
    };

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
            // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- deep-link sync: expands `initialTable` once the async tables arrive, guarded against re-firing by a ref
            fireAndForget(toggle(initialTable));
        }
        /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */
    }, [initialTable, tables, toggle]);

    // Probe every table's columns once per shard when the graph opens. Schema
    // metadata comes from one batched `describeTables` over both tiers (real types
    // + PK/FK markers); the diagram derives its FK edges — including cross-tier
    // ones (a shard column referencing a global table) — straight from the columns'
    // `ref`s, so no separate per-table edge probe is needed.
    //
    // `describeTables` only covers tables declared in `defineSchema`. Plugin-owned
    // global tables (the auth tables — account, session, …) live in D1 but aren't
    // in the schema, so they get NO typed columns there. For those we fall back to
    // `readGlobalTablePage` (the same PRAGMA the list view uses) to at least render
    // their column names. A `describeTables` rejection (an older worker without the
    // admin op) flags the shard so schema tables show "columns unavailable" rather
    // than mistaking the failure for empty tables.
    const probeSchema = useCallback(
        async (shard: string, shardNames: string[], globalNames: string[]): Promise<void> => {
            const [described, globalPages] = await Promise.all([
                Promise.allSettled([
                    client.query(DESCRIBE_TABLES, { tables: [...shardNames, ...globalNames] }, callOptions(shard)) as Promise<TablesColumnsResult>,
                ]),
                Promise.all(
                    globalNames.map(async (table): Promise<{ columns: string[]; refs: Record<string, string>; table: string }> => {
                        const page = await Promise.allSettled([client.readGlobalTablePage({ limit: 1, offset: 0, table })]);
                        const value = page[0].status === "fulfilled" ? page[0].value : undefined;

                        return { columns: value?.columns ?? [], refs: value?.refs ?? {}, table };
                    }),
                ),
            ]);

            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: an older/malformed worker can resolve a fulfilled payload without columnsByTable, which the static type can't express
            const typedColumns = described[0].status === "fulfilled" ? (described[0].value?.columnsByTable ?? {}) : {};
            const columnsFailed = described[0].status === "rejected";

            // Name-only columns for global tables the schema doesn't know about.
            // PRAGMA gives no types, but `PRAGMA foreign_key_list` recovers real FK
            // constraints, so a column that references another table carries its
            // `ref` — letting the diagram draw global→global edges (e.g. better-auth's
            // `session.userId → user`, `twoFactor.userId → user`).
            const globalFallback = new Map<string, ColumnMeta[]>(
                globalPages.map(({ columns: columnNames, refs, table }) => [
                    table,
                    columnNames.map((name): ColumnMeta => {
                        const ref = refs[name];

                        return ref === undefined ? { name, optional: false, type: "" } : { name, optional: false, ref, type: "id" };
                    }),
                ]),
            );

            const resolved = [...shardNames, ...globalNames].map((table): [string, ColumnMeta[]] => {
                const typed = typedColumns[table] ?? [];

                return [table, typed.length > 0 ? typed : (globalFallback.get(table) ?? [])];
            });

            setShardColumns((previous) => {
                return { ...previous, [shard]: Object.fromEntries(resolved) };
            });
            setShardColumnsError((previous) => {
                return { ...previous, [shard]: columnsFailed };
            });
        },
        [client],
    );

    // When the graph opens (or the shard switches) probe every table's columns
    // once per shard. List view never probes, so the graph cost is opt-in. This is
    // a genuine lazy data-load, not a click handler: it must also re-run when the
    // shard's `tables` change (after a re-seed) or `shardKey` switches, so it stays
    // an effect keyed on those values rather than firing from the toggle's onClick.
    // It waits for global discovery to resolve (success or failure) so the probe
    // covers global table names too.
    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- lazy data-load gated on view + shard, not an event handler
        if (view !== "graph" || tables === null || (globalTables === null && globalError === null) || shardColumns[shardKey] !== undefined) {
            return;
        }

        fireAndForget(
            // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- lazy column probe gated on view + shard, not derived state
            probeSchema(
                shardKey,
                tables.map((table) => table.name),
                (globalTables ?? []).map((table) => table.name),
            ),
        );
    }, [view, tables, globalTables, globalError, shardKey, shardColumns, probeSchema]);

    // The unified diagram model: every table across both tiers, tagged with its
    // storage tier and carrying the columns probed for this shard (schema-typed
    // where available, name-only PRAGMA fallback for plugin-owned global tables).
    // A shard column referencing a global table resolves to a real node, so the
    // cross-tier FK edge can render.
    const diagramTables = useMemo<DiagramTable[]>(() => {
        const columnsForShard = shardColumns[shardKey] ?? EMPTY_COLUMNS;
        const shardOnes = (tables ?? []).map((table): DiagramTable => {
            return { columns: columnsForShard[table.name] ?? EMPTY_COLUMN_META, name: table.name, tier: "shard" };
        });
        const globalOnes = (globalTables ?? []).map((table): DiagramTable => {
            return { columns: columnsForShard[table.name] ?? EMPTY_COLUMN_META, name: table.name, tier: "global" };
        });

        return [...shardOnes, ...globalOnes];
    }, [tables, globalTables, shardColumns, shardKey]);

    // Substring filter (case-insensitive) over each tier's table names, applied
    // only in the list view. An empty filter shows every table.
    const filteredTables = useMemo<TableInfo[]>(() => {
        const needle = tableFilter.trim().toLowerCase();

        return (tables ?? []).filter((table) => table.name.toLowerCase().includes(needle));
    }, [tables, tableFilter]);
    const filteredGlobalTables = useMemo<GlobalTableInfo[]>(() => {
        const needle = tableFilter.trim().toLowerCase();

        return (globalTables ?? []).filter((table) => table.name.toLowerCase().includes(needle));
    }, [globalTables, tableFilter]);

    return {
        columns,
        diagramTables,
        error,
        expanded,
        filteredGlobalTables,
        filteredTables,
        globalColumns,
        globalError,
        globalExpanded,
        globalTables,
        indexes,
        refresh,
        setShardKey,
        setTableFilter,
        setView,
        shardColumnsError,
        shardKey,
        tableFilter,
        tables,
        toggle,
        toggleGlobal,
        view,
    };
};

export type { SchemaView };
export { useSchemaExplorer };
