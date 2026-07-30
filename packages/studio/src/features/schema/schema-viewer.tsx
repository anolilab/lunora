import type { ChangeEvent, ReactElement, ReactNode } from "react";

import { ShardInput } from "../../components/shard-input";
import { StorageTierBadge, TIER_META } from "../../components/storage-tier";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { useT } from "../../i18n/i18n-context";
import type { TableIndexInfo } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import type { SchemaEditTable } from "../../lib/schema-edit";
import { cn } from "../../lib/utils";
import { useSchemaExplorer } from "./hooks/use-schema-explorer";
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

/** Hoisted empty column-name list so an un-probed table's chip row doesn't allocate a fresh array. */
const EMPTY_COLUMN_NAMES: ReadonlyArray<string> = [];
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
export const SchemaViewer = ({ initialShardKey, initialTable, schemaEditable }: SchemaViewerProps): ReactElement => {
    const t = useT();

    // Graph first: the diagram answers "what shape is this database", which is the
    // question you open this page with. The table list is the drill-down.
    const {
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
    } = useSchemaExplorer({ initialShardKey, initialTable });
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
