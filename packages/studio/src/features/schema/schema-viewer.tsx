import type { GlobalTableInfo } from "@lunora/client";
import { useLunora } from "@lunora/react";
import type { ChangeEvent, ReactElement, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ShardInput } from "../../components/shard-input";
import { StorageTierBadge, TIER_META } from "../../components/storage-tier";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import useDebounced from "../../hooks/use-debounced";
import { useT } from "../../i18n/i18n-context";
import type { ColumnMeta, TableIndexesResult, TableIndexInfo, TableInfo, TablePage, TablesColumnsResult } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../lib/internal";
import type { SchemaEditTable } from "../../lib/schema-edit";
import { recordShard } from "../../lib/shard-history";
import { cn } from "../../lib/utils";
import type { DiagramTable } from "./schema-diagram";
import { SchemaDiagram } from "./schema-diagram";
import { SchemaEditorOverlay } from "./schema-editor-overlay";

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

    /**
     * Enable the visual schema-editor overlay (add table / column / index). Off by
     * default so the diagram stays read-only. Set only by the loopback dev hosts
     * (see `StudioProps.schemaEditable`); when true, the authoring overlay
     * (plan 024 Item 4) renders above the table lists and applies additive edits
     * through the dev host's local schema-edit endpoint.
     */
    readonly schemaEditable?: boolean;
}

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const LIST_TABLE_INDEXES = adminRef(ADMIN_FUNCTIONS.listTableIndexes);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);
const DESCRIBE_TABLES = adminRef(ADMIN_FUNCTIONS.describeTables);

/** Hoisted empty column map so the diagram model doesn't allocate a fresh object each render. */
const EMPTY_COLUMNS: Readonly<Record<string, ColumnMeta[]>> = {};
/** Hoisted empty column-name list so an un-probed table's chip row doesn't allocate a fresh array. */
const EMPTY_COLUMN_NAMES: ReadonlyArray<string> = [];
/** Hoisted empty typed-column list so an un-probed diagram table doesn't allocate a fresh array. */
const EMPTY_COLUMN_META: ReadonlyArray<ColumnMeta> = [];

/** How the schema is presented: a textual table list, or the relationship graph. */
type SchemaView = "graph" | "list";

/** A right-pointing chevron that rotates down when its row is expanded. */
const ChevronIcon = ({ open }: { readonly open: boolean }): ReactElement => (
    <svg
        aria-hidden="true"
        className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")}
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.8}
        viewBox="0 0 24 24"
    >
        <path d="m9 6 6 6-6 6" />
    </svg>
);

interface TableEntryProps {
    /** Expanded body (columns, indexes). */
    readonly children: ReactNode;
    readonly expanded: boolean;
    readonly name: string;
    readonly onToggle: () => void;
    readonly rowCount: number;
    /** `data-testid` for the `&lt;li>`. */
    readonly rowTestId: string;
    /** `data-testid` for the toggle `&lt;button>`. */
    readonly toggleTestId: string;
}

/**
 * One expandable table row: a full-width toggle button (chevron · monospace name ·
 * muted row count) over a collapsible body. The button's text is exactly
 * `name (rowCount)` so deep-links and tests can match it verbatim.
 */
const TableEntry = ({ children, expanded, name, onToggle, rowCount, rowTestId, toggleTestId }: TableEntryProps): ReactElement => (
    <li className="border-t border-border/60 first:border-t-0" data-testid={rowTestId}>
        <button
            aria-expanded={expanded}
            className="flex w-full items-center gap-2 px-3 py-2 text-start transition-colors hover:bg-muted/50 aria-expanded:bg-muted/40"
            data-testid={toggleTestId}
            onClick={onToggle}
            type="button"
        >
            <ChevronIcon open={expanded} />
            <span className="truncate font-mono text-xs text-foreground" title={name}>
                {name}
            </span>{" "}
            <span className="ms-auto shrink-0 text-xs text-muted-foreground tabular-nums">({rowCount})</span>
        </button>
        {expanded && <div className="px-3 pb-3 ps-8">{children}</div>}
    </li>
);

/** A wrapped row of monospace column-name pills — the expanded body of a table row. */
const ColumnChips = ({ columns, testId }: { readonly columns: ReadonlyArray<string>; readonly testId: string }): ReactElement => (
    <ul className="flex flex-wrap gap-1.5 pt-1" data-testid={testId}>
        {columns.map((column) => (
            <li className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground" key={column}>
                {column}
            </li>
        ))}
    </ul>
);

/** The declared-index list under an expanded shard table: name · kind · unique · fields. */
const IndexList = ({
    heading,
    indexes,
    testId,
}: {
    readonly heading: string;
    readonly indexes: ReadonlyArray<TableIndexInfo>;
    readonly testId: string;
}): ReactElement => (
    <div className="pt-3">
        <p className="mb-1.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">{heading}</p>
        <ul className="flex flex-col gap-1" data-testid={testId}>
            {indexes.map((index) => (
                <li className="flex flex-wrap items-center gap-1.5 text-xs" key={`${index.type}:${index.name}`}>
                    <span className="font-mono">{index.name}</span>
                    <Badge variant="outline">{index.type}</Badge>
                    {index.unique === true && <Badge variant="secondary">unique</Badge>}
                    <span className="text-muted-foreground">{index.fields.join(", ")}</span>
                </li>
            ))}
        </ul>
    </div>
);

/** Underline tab, matching the Migrations page so the two read as one system. */
const schemaTabClass = (active: boolean): string =>
    cn(
        "border-b-2 px-3 py-2 font-mono text-[11px] tracking-widest uppercase outline-none transition-colors",
        active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
    );

/**
 * Schema overview that shows both storage tiers so the distinction is never a
 * mystery. The shard section lists every user table in the selected Durable
 * Object with row counts, and probes a table's columns on expand via a one-row
 * `__lunora_admin__:readTablePage` (`PRAGMA table_info`). The global section
 * lists every `.global()` table — including the auth tables (`user`, `session`,
 * …) — via the client's `listGlobalTables()`, reading columns from a one-row
 * `readGlobalTablePage` on expand.
 *
 * Two presentations: a **Table list** (searchable, expandable cards per tier)
 * and a **Graph** — a single React Flow relationship diagram showing both tiers
 * on one canvas, with cross-tier FK edges and its own in-canvas find-table box,
 * tier filter, and legend.
 *
 * Read-only and gated by the server's `LUNORA_ADMIN_TOKEN`, like the rest of the
 * studio's admin surface. Global discovery is best-effort: if D1 isn't
 * configured the global section simply reports it, and the shard section still
 * works.
 */
// react-doctor-disable-next-line react-doctor/prefer-useReducer -- the six values are independent reads that arrive from separate queries at separate times, so one reducer would serialise updates that genuinely are not one transition
// react-doctor-disable-next-line react-doctor/no-giant-component -- ~670 lines. Decomposing this is a real refactor with its own review, not a lint fix — deferred deliberately, and recorded under "Deferred" in plans/README.md's Wave 15 so it is not invisible
export const SchemaViewer = ({ initialShardKey, initialTable, schemaEditable }: SchemaViewerProps): ReactElement => {
    const client = useLunora();
    const t = useT();

    // Graph first: the diagram answers "what shape is this database", which is the
    // question you open this page with. The table list is the drill-down.
    const [view, setView] = useState<SchemaView>("graph");
    const [shardKey, setShardKey] = useState<string>(initialShardKey ?? "");
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
    const debouncedShard = useDebounced(shardKey.trim(), 400);

    useEffect(() => {
        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- async schema load, re-run when the debounced shard settles
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

    const showList = (): void => {
        setView("list");
    };
    const showGraph = (): void => {
        setView("graph");
    };
    const onFilterChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setTableFilter(event.target.value);
    };

    // After the overlay applies an additive edit (lunora/schema.ts + codegen),
    // re-list the shard so the new table/column/index shows. The schema-edit
    // endpoint's returned tables describe the SOURCE schema; the studio reads the
    // live DO via `refresh`, which now reflects the regenerated shape.
    const onSchemaApplied = (_tables: ReadonlyArray<SchemaEditTable>): void => {
        fireAndForget(refresh(shardKey));
    };

    // Shard table names offered to the overlay's column/index target pickers.
    const shardTableNames = (tables ?? []).map((table) => table.name);

    return (
        <div className="flex flex-col gap-4" data-testid="lunora-schema">
            <div className="flex flex-wrap items-center gap-3">
                <ShardInput onChange={setShardKey} testId="sc-shard-input" value={shardKey} />

                {/* Tabs, not a pair of toggle buttons: these are two views of one
                    thing, and the Migrations page next door already reads this
                    way. Matches its underline idiom so the two pages agree. */}
                <div aria-label={t("Schema view")} className="flex items-center gap-1" data-testid="sc-view-toggle" role="tablist">
                    <button
                        aria-selected={view === "graph"}
                        className={schemaTabClass(view === "graph")}
                        data-testid="sc-view-graph"
                        onClick={showGraph}
                        role="tab"
                        type="button"
                    >
                        {t("Graph")}
                    </button>
                    <button
                        aria-selected={view === "list"}
                        className={schemaTabClass(view === "list")}
                        data-testid="sc-view-list"
                        onClick={showList}
                        role="tab"
                        type="button"
                    >
                        {t("Table list")}
                    </button>
                </div>
            </div>

            {schemaEditable === true && <SchemaEditorOverlay onApplied={onSchemaApplied} tableNames={shardTableNames} />}

            {view === "list" && (
                <Input
                    aria-label={t("Filter tables")}
                    className="h-8 max-w-xs"
                    data-testid="sc-filter"
                    onChange={onFilterChange}
                    placeholder={t("Filter tables")}
                    value={tableFilter}
                />
            )}

            {view === "graph" && (
                <div className="flex flex-col gap-2" data-testid="sc-graph-view">
                    {error !== null && (
                        <p className="text-sm text-destructive" data-testid="sc-error" role="alert">
                            {error}
                        </p>
                    )}
                    {globalError !== null && (
                        <p className="text-sm text-destructive" data-testid="sc-global-error" role="alert">
                            {globalError}
                        </p>
                    )}
                    <SchemaDiagram columnsError={shardColumnsError[shardKey] === true} tables={diagramTables} testIdPrefix="sc-graph" />
                </div>
            )}

            {view === "list" && (
                <div className="flex flex-col gap-4">
                    <Card data-testid="sc-shard-section" size="sm">
                        <CardHeader>
                            <div className="flex items-center gap-2">
                                <StorageTierBadge tier="shard" />
                                <CardTitle>{t("Shard tables")}</CardTitle>
                                {tables !== null && (
                                    <Badge className="ms-auto tabular-nums" variant="outline">
                                        {filteredTables.length}
                                    </Badge>
                                )}
                            </div>
                            <CardDescription>{TIER_META.shard.hint}</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {error !== null && (
                                <p className="text-sm text-destructive" data-testid="sc-error" role="alert">
                                    {error}
                                </p>
                            )}

                            {tables !== null && tables.length === 0 && (
                                <p className="text-sm text-muted-foreground" data-testid="sc-empty">
                                    {t("No tables in this shard.")}
                                </p>
                            )}

                            {tables !== null && tables.length > 0 && filteredTables.length === 0 && (
                                <p className="text-sm text-muted-foreground" data-testid="sc-no-match">
                                    {t("No tables match your filter.")}
                                </p>
                            )}

                            {filteredTables.length > 0 && (
                                <ul className="-mx-3 overflow-hidden border-t border-border" data-testid="sc-table-list">
                                    {filteredTables.map((table) => {
                                        const cacheKey = `${shardKey}:${table.name}`;
                                        const tableIndexes = indexes[cacheKey] ?? [];

                                        return (
                                            <TableEntry
                                                expanded={expanded === table.name}
                                                key={table.name}
                                                name={table.name}
                                                onToggle={() => {
                                                    fireAndForget(toggle(table.name));
                                                }}
                                                rowCount={table.rowCount}
                                                rowTestId={`sc-table-${table.name}`}
                                                toggleTestId={`sc-toggle-${table.name}`}
                                            >
                                                <ColumnChips columns={columns[cacheKey] ?? EMPTY_COLUMN_NAMES} testId={`sc-columns-${table.name}`} />
                                                {tableIndexes.length > 0 && (
                                                    <IndexList heading={t("Indexes")} indexes={tableIndexes} testId={`sc-indexes-${table.name}`} />
                                                )}
                                            </TableEntry>
                                        );
                                    })}
                                </ul>
                            )}
                        </CardContent>
                    </Card>

                    <Card data-testid="sc-global-section" size="sm">
                        <CardHeader>
                            <div className="flex items-center gap-2">
                                <StorageTierBadge tier="global" />
                                <CardTitle>{t("Global tables (D1)")}</CardTitle>
                                {globalTables !== null && (
                                    <Badge className="ms-auto tabular-nums" variant="outline">
                                        {filteredGlobalTables.length}
                                    </Badge>
                                )}
                            </div>
                            <CardDescription>{TIER_META.global.hint}</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {globalError !== null && (
                                <p className="text-sm text-destructive" data-testid="sc-global-error" role="alert">
                                    {globalError}
                                </p>
                            )}

                            {globalTables !== null && globalTables.length === 0 && (
                                <EmptyState description={TIER_META.global.hint} testId="sc-global-empty" title={t("No global tables.")} />
                            )}

                            {globalTables !== null && globalTables.length > 0 && filteredGlobalTables.length === 0 && (
                                <p className="text-sm text-muted-foreground" data-testid="sc-global-no-match">
                                    {t("No tables match your filter.")}
                                </p>
                            )}

                            {filteredGlobalTables.length > 0 && (
                                <ul className="-mx-3 overflow-hidden border-t border-border" data-testid="sc-global-table-list">
                                    {filteredGlobalTables.map((table) => (
                                        <TableEntry
                                            expanded={globalExpanded === table.name}
                                            key={table.name}
                                            name={table.name}
                                            onToggle={() => {
                                                fireAndForget(toggleGlobal(table.name));
                                            }}
                                            rowCount={table.rowCount}
                                            rowTestId={`sc-global-table-${table.name}`}
                                            toggleTestId={`sc-global-toggle-${table.name}`}
                                        >
                                            <ColumnChips columns={globalColumns[table.name] ?? EMPTY_COLUMN_NAMES} testId={`sc-global-columns-${table.name}`} />
                                        </TableEntry>
                                    ))}
                                </ul>
                            )}
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    );
};

export type { SchemaViewerProps };
