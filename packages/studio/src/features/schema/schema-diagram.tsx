"use client";

import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Edge, NodeTypes } from "@xyflow/react";
import { Background, Controls, MiniMap, Panel, ReactFlow, useEdgesState, useNodes, useNodesInitialized, useNodesState, useReactFlow } from "@xyflow/react";
import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { StorageTier } from "../../components/storage-tier";
import { TIER_META } from "../../components/storage-tier";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { useT } from "../../i18n/i18n-context";
import type { ColumnMeta } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import { cn } from "../../lib/utils";
import type { DatabaseSchemaNodeType } from "./database-schema-node";
import { DatabaseSchemaNode } from "./database-schema-node";
import { exportDiagramAsJson, exportDiagramAsPng, exportDiagramAsSvg } from "./diagram-export";
import type { SchemaEdge } from "./layout";
import { computeLayout } from "./layout";

// Registered once: a narrow custom-node component can't be assigned to React
// Flow's broad `NodeTypes` map without widening, so cast at the single seam.
const NODE_TYPES = { databaseSchema: DatabaseSchemaNode } as unknown as NodeTypes;

/** Hoisted tier-dot styles so the in-canvas chips + legend don't allocate a fresh style object each render. */
const SHARD_DOT_STYLE: CSSProperties = { backgroundColor: TIER_META.shard.color };
const GLOBAL_DOT_STYLE: CSSProperties = { backgroundColor: TIER_META.global.color };

/** A table to render on the diagram: its name, storage tier, and typed columns. */
interface DiagramTable {
    /** Typed columns (from `describeTables`); empty until probed, or when the probe failed. */
    readonly columns: ReadonlyArray<ColumnMeta>;
    readonly name: string;
    /** Which storage tier the table lives in — drives its node badge and the tier filter. */
    readonly tier: StorageTier;
}

/** Which storage tiers the canvas renders. Both on by default so the operator sees the whole schema. */
interface TierVisibility {
    readonly global: boolean;
    readonly shard: boolean;
}

const ALL_TIERS: TierVisibility = { global: true, shard: true };

/** Hoisted empty decoration map so the plain schema viewer does not allocate one per render. */
const EMPTY_NODE_CLASSES: Readonly<Record<string, string>> = {};

interface SchemaDiagramProps {
    /** True when the typed-column probe failed — nodes show a "columns unavailable" hint instead of an empty `—`. */
    readonly columnsError?: boolean;

    /**
     * Fill the flex parent instead of standing at a fixed height.
     *
     * Off by default: the Schema page renders inside the studio's page-scrolled
     * content area, where there is no resolved height to fill and a `h-full`
     * canvas would collapse. The Migrations page opts in — it owns its viewport
     * height (see `FULL_HEIGHT_TABS`) and shares it with the change list, so a
     * hardcoded canvas height there pushed the verdict below the fold.
     */
    readonly fill?: boolean;

    /**
     * Extra CSS classes per table name, applied to that table's node. Used by the
     * schema-history diff to ring added / changed / removed tables and dim
     * untouched context; the plain schema viewer passes nothing.
     */
    readonly nodeClasses?: Readonly<Record<string, string>>;
    /** Every table to render, across both storage tiers, with its typed columns. */
    readonly tables: ReadonlyArray<DiagramTable>;
    /** Prefix for every `data-testid` so the diagram's controls are addressable. */
    readonly testIdPrefix: string;
}

/**
 * The PK column an FK edge attaches to: the `pk`-flagged column when the schema
 * marks one (Lunora tables), else the Lunora system PK `_id`, else the `id`
 * column external tables use (e.g. better-auth's), else the first column. The
 * `id` fallback matters for global→global edges into external auth tables, whose
 * PRAGMA-sourced columns carry no `pk` flag and no `_id`.
 */
const pkColumnOf = (columns: ReadonlyArray<ColumnMeta>): string => {
    const flagged = columns.find((column) => column.pk === true)?.name;

    if (flagged !== undefined) {
        return flagged;
    }

    if (columns.some((column) => column.name === "_id")) {
        return "_id";
    }

    if (columns.some((column) => column.name === "id")) {
        return "id";
    }

    return columns[0]?.name ?? "_id";
};

/**
 * Derive the directed FK edges straight from the columns' schema metadata: every
 * `v.id("target")` column (carrying a `ref`) is an edge `from.column → target`.
 * Authoritative and tier-blind, so a shard column referencing a global table
 * (for example `messages.author → users`) yields a cross-tier edge — the single
 * unified canvas can then draw it, which two split per-tier canvases never could.
 */
const deriveEdges = (tables: ReadonlyArray<DiagramTable>): SchemaEdge[] =>
    tables.flatMap((table) =>
        table.columns
            .filter((column) => column.ref !== undefined)
            .map((column) => {
                return { column: column.name, from: table.name, to: column.ref as string };
            }),
    );

/**
 * Build the React Flow nodes from the tables + their typed columns, seeded by
 * the depth layout. `nodeClasses` decorates a node by table name (the schema
 * history view rings added/changed/removed tables); absent for the plain viewer.
 */
const buildNodes = (tables: ReadonlyArray<DiagramTable>, columnsError: boolean, nodeClasses: Readonly<Record<string, string>>): DatabaseSchemaNodeType[] => {
    const names = tables.map((table) => table.name);
    const counts = new Map<string, number>(tables.map((table) => [table.name, table.columns.length]));
    const positions = computeLayout(names, deriveEdges(tables), counts);
    const byName = new Map(tables.map((table) => [table.name, table]));

    return positions.flatMap(({ name, x, y }): DatabaseSchemaNodeType[] => {
        const table = byName.get(name);

        if (table === undefined) {
            return [];
        }

        return [
            {
                className: nodeClasses[name],
                data: { columns: table.columns, label: name, loadError: columnsError, tier: table.tier },
                id: name,
                position: { x, y },
                type: "databaseSchema",
            },
        ];
    });
};

/**
 * Build the React Flow edges. Each FK edge `from.column → to` is drawn from the
 * referenced table's PK (a right **source** handle on `to`) to the referencing
 * column (a left **target** handle on `from`), so it flows left-to-right with the
 * depth layout. An edge is emitted only when both handles exist (both tables'
 * columns are loaded and visible), so a half-probed or tier-filtered graph never
 * references a missing handle.
 */
const buildEdges = (tables: ReadonlyArray<DiagramTable>): Edge[] => {
    const columnsByTable = new Map(tables.map((table) => [table.name, table.columns]));

    return deriveEdges(tables).flatMap((edge): Edge[] => {
        const targetColumns = columnsByTable.get(edge.to) ?? [];
        const sourceColumns = columnsByTable.get(edge.from) ?? [];
        const pk = pkColumnOf(targetColumns);

        if (!targetColumns.some((column) => column.name === pk) || !sourceColumns.some((column) => column.name === edge.column)) {
            return [];
        }

        return [
            {
                id: `${edge.from}.${edge.column}->${edge.to}`,
                source: edge.to,
                sourceHandle: pk,
                target: edge.from,
                targetHandle: edge.column,
            },
        ];
    });
};

/** A bottom-left legend explaining the per-column glyphs and the two storage-tier colours. */
const Legend = (): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-card/95 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-xs">
            <span className="flex items-center gap-1">
                <span aria-hidden="true" className="size-1.5 rounded-full" style={SHARD_DOT_STYLE} />
                {TIER_META.shard.label}
            </span>
            <span className="flex items-center gap-1">
                <span aria-hidden="true" className="size-1.5 rounded-full" style={GLOBAL_DOT_STYLE} />
                {TIER_META.global.label}
            </span>
            <span className="flex items-center gap-1">
                <Badge className="px-1 py-0 text-[10px] leading-tight" variant="secondary">
                    PK
                </Badge>
                {t("Primary key")}
            </span>
            <span className="flex items-center gap-1">
                <Badge className="px-1 py-0 text-[10px] leading-tight" variant="outline">
                    FK
                </Badge>
                {t("Foreign key")}
            </span>
        </div>
    );
};

/** Below this many tables a minimap costs more attention than it saves. */
const MINIMAP_MIN_TABLES = 12;

/**
 * Re-fit the viewport whenever the canvas is re-seeded.
 *
 * The `fitView` PROP only fits on mount. These nodes are re-seeded by an effect
 * every time their source changes — and the big one is asynchronous: columns are
 * probed after the first paint, so the mount-time fit measured empty
 * header-only nodes and never ran again. The result was the whole graph stranded
 * to one side at the wrong zoom, which is what this fixes.
 *
 * Keyed on `seedKey` AND `useNodesInitialized`: the latter drops to false while
 * React Flow measures a new node set and flips back to true once it has real
 * dimensions, so the fit always runs against measured nodes rather than racing
 * them. Must be a CHILD of `ReactFlow` — these hooks need its provider.
 *
 * Re-fitting discards a manual pan, which is consistent: the re-seed it follows
 * already discards manual drags.
 */
const FitOnSeed = ({ containerRef, seedKey }: { readonly containerRef: React.RefObject<HTMLElement | null>; readonly seedKey: string }): null => {
    const initialized = useNodesInitialized();
    const { fitView } = useReactFlow();

    useEffect(() => {
        if (!initialized) {
            return undefined;
        }

        // `duration: 0` — a fit is a correction, not a transition; animating it
        // reads as the graph drifting on its own.
        const fit = (): void => {
            // `maxZoom` above 1 on purpose. React Flow refuses to scale UP past
            // 1:1 by default, so a small schema fitted to a large canvas sat as a
            // postage stamp in the middle of it — which is what this looked like
            // even once the fit itself was correct. Capped at 1.6 so a two-table
            // schema does not render as billboard text.
            fireAndForget(fitView({ duration: 0, maxZoom: 1.6, padding: 0.14 }));
        };

        fit();

        const node = containerRef.current;

        if (node === null) {
            return undefined;
        }

        // `fitView` solves for the container size AT CALL TIME, so a single fit
        // when the nodes are measured is not enough: this canvas lives in a flex
        // column that is still settling on that frame, and the graph ended up
        // fitted to a box a third of the final size and offset to one side.
        // Re-fitting on resize also covers the sidebar collapsing and the window
        // changing, which previously left the graph stranded in the same way.
        const observer = new ResizeObserver(() => {
            fit();
        });

        observer.observe(node);

        return () => {
            observer.disconnect();
        };
    }, [containerRef, fitView, initialized, seedKey]);

    return null;
};

/**
 * Export toolbar rendered inside the React Flow canvas via `Panel`.
 *
 * Must be mounted as a child of `ReactFlow` so it can call `useReactFlow()`
 * and `useNodes()`. The PNG/SVG handlers locate the `.react-flow__viewport`
 * element through a ref on the wrapping container and pass it to `html-to-image`.
 */
const DiagramExportPanel = ({ containerRef, testIdPrefix }: { containerRef: React.RefObject<HTMLElement | null>; testIdPrefix: string }): ReactElement => {
    const t = useT();
    const nodes = useNodes();
    const { getEdges } = useReactFlow();
    const [exporting, setExporting] = useState<"json" | "png" | "svg" | null>(null);

    const handlePng = async (): Promise<void> => {
        const viewport = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");

        if (!viewport) {
            return;
        }

        setExporting("png");

        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `try` without `catch`; the export must clear its in-flight marker on the throw path, and adding a catch just to satisfy the compiler would swallow the failure
        try {
            await exportDiagramAsPng(viewport, nodes, `${testIdPrefix}-schema-diagram.png`);
        } finally {
            setExporting(null);
        }
    };

    const handleSvg = async (): Promise<void> => {
        const viewport = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");

        if (!viewport) {
            return;
        }

        setExporting("svg");

        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `try` without `catch`; the export must clear its in-flight marker on the throw path, and adding a catch just to satisfy the compiler would swallow the failure
        try {
            await exportDiagramAsSvg(viewport, nodes, `${testIdPrefix}-schema-diagram.svg`);
        } finally {
            setExporting(null);
        }
    };

    const handleJson = (): void => {
        setExporting("json");

        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `try` without `catch`; the export must clear its in-flight marker on the throw path, and adding a catch just to satisfy the compiler would swallow the failure
        try {
            exportDiagramAsJson(nodes, getEdges(), `${testIdPrefix}-schema-diagram.json`);
        } finally {
            setExporting(null);
        }
    };

    const onClickPng = (): void => {
        fireAndForget(handlePng());
    };

    const onClickSvg = (): void => {
        fireAndForget(handleSvg());
    };

    return (
        <Panel position="top-right">
            <DropdownMenu>
                <DropdownMenuTrigger
                    className="group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium whitespace-nowrap hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                    data-testid={`${testIdPrefix}-export-trigger`}
                    disabled={exporting !== null}
                >
                    <HugeiconsIcon className="size-3.5" icon={Download01Icon} strokeWidth={2} />
                    {t("Export")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem data-testid={`${testIdPrefix}-export-png`} disabled={exporting !== null} onClick={onClickPng}>
                        {t("PNG")}
                    </DropdownMenuItem>
                    <DropdownMenuItem data-testid={`${testIdPrefix}-export-svg`} disabled={exporting !== null} onClick={onClickSvg}>
                        {t("SVG")}
                    </DropdownMenuItem>
                    <DropdownMenuItem data-testid={`${testIdPrefix}-export-json`} disabled={exporting !== null} onClick={handleJson}>
                        {t("JSON")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </Panel>
    );
};

/**
 * A Supabase-style schema diagram on a single React Flow canvas: every table —
 * shard-local and global alike — is one node listing its columns with types and
 * PK/FK markers, and `v.id()` foreign keys are drawn handle-to-handle, including
 * **cross-tier** edges (a shard table referencing a global one). The canvas
 * carries its own controls: a top-left find-table box + storage-tier filter
 * (both tiers on by default) and a bottom-left legend, plus a pannable, zoomable
 * mini-map. The seed layout is deterministic (dependency-depth columns,
 * cycle-safe) so the diagram opens stable, then the operator can drag nodes.
 * Read-only — connecting is disabled.
 */
export const SchemaDiagram = ({ columnsError, fill = false, nodeClasses, tables, testIdPrefix }: SchemaDiagramProps): ReactElement => {
    const t = useT();

    const [tierFilter, setTierFilter] = useState<TierVisibility>(ALL_TIERS);
    const [query, setQuery] = useState<string>("");

    // The tables actually drawn: kept by the active tier toggles and matching the
    // find-table query (case-insensitive substring). Edges to a filtered-out table
    // drop automatically, since `buildEdges` only sees the visible set.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour: the re-seed effects below key on it, and this component bails out of the compiler anyway (see the try/finally above)
    const visibleTables = useMemo<DiagramTable[]>(() => {
        const needle = query.trim().toLowerCase();

        return tables.filter((table) => tierFilter[table.tier] && table.name.toLowerCase().includes(needle));
    }, [tables, tierFilter, query]);

    // Memoized because the re-seed effects below depend on these IDENTITIES: a new
    // array every render would call `setNodes`/`setEdges` every render, which is a
    // render loop, not a slow render. Not a compiler-replaceable perf hint.
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour here: the re-seed effects below key on it
    const seededNodes = useMemo(
        () => buildNodes(visibleTables, columnsError ?? false, nodeClasses ?? EMPTY_NODE_CLASSES),
        [visibleTables, columnsError, nodeClasses],
    );
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- identity is behaviour: the re-seed effects below key on it, and this component bails out of the compiler anyway (see the try/finally above)
    const seededEdges = useMemo(() => buildEdges(visibleTables), [visibleTables]);
    // Identifies the current seed by VALUE, so the re-fit fires when the graph
    // actually changes rather than on every render.
    const seedKey = visibleTables.map((table) => table.name).join(",");

    const [nodes, setNodes, onNodesChange] = useNodesState<DatabaseSchemaNodeType>(seededNodes);
    const [flowEdges, setEdges, onEdgesChange] = useEdgesState(seededEdges);

    // A ref to the wrapping div so the export panel can find the
    // `.react-flow__viewport` element without leaving the React tree.
    const canvasRef = useRef<HTMLDivElement>(null);

    // Re-seed when the source data or filters change (shard switch, columns
    // finished probing, a tier toggled). This resets manual drags, which is fine —
    // columns load once and the operator re-applies the filter deliberately.
    useEffect(() => {
        setNodes(seededNodes);
    }, [seededNodes, setNodes]);
    useEffect(() => {
        setEdges(seededEdges);
    }, [seededEdges, setEdges]);

    const onQueryChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setQuery(event.target.value);
    };
    const toggleShard = (): void => {
        setTierFilter((previous) => {
            return { ...previous, shard: !previous.shard };
        });
    };
    const toggleGlobal = (): void => {
        setTierFilter((previous) => {
            return { ...previous, global: !previous.global };
        });
    };

    if (tables.length === 0) {
        return (
            <section className="flex flex-col gap-2" data-testid={`${testIdPrefix}-section`}>
                <p className="text-sm text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>
                    {t("No tables to graph.")}
                </p>
            </section>
        );
    }

    return (
        <section className={cn("flex flex-col", fill && "min-h-0 flex-1")} data-testid={`${testIdPrefix}-section`}>
            <div
                className={cn("w-full overflow-hidden border border-border bg-muted/20", fill ? "min-h-0 flex-1" : "h-[560px]")}
                data-testid={`${testIdPrefix}-canvas`}
                ref={canvasRef}
            >
                <ReactFlow
                    edges={flowEdges}
                    elementsSelectable
                    fitView
                    minZoom={0.2}
                    nodes={nodes}
                    nodesConnectable={false}
                    nodeTypes={NODE_TYPES}
                    onEdgesChange={onEdgesChange}
                    onNodesChange={onNodesChange}
                >
                    <Background />
                    <Panel position="top-left">
                        <div className="flex flex-col gap-2 rounded-xl border border-border bg-card/95 p-2 shadow-xs">
                            <Input
                                aria-label={t("Find table…")}
                                className="h-7 w-44 text-xs"
                                data-testid={`${testIdPrefix}-find`}
                                onChange={onQueryChange}
                                placeholder={t("Find table…")}
                                value={query}
                            />
                            <div aria-label={t("Storage tiers")} className="flex items-center gap-1.5" role="group">
                                <Button
                                    aria-pressed={tierFilter.shard}
                                    className="gap-1.5"
                                    data-testid={`${testIdPrefix}-tier-shard`}
                                    onClick={toggleShard}
                                    size="xs"
                                    type="button"
                                    variant={tierFilter.shard ? "default" : "outline"}
                                >
                                    <span aria-hidden="true" className="size-1.5 rounded-full" style={SHARD_DOT_STYLE} />
                                    {TIER_META.shard.label}
                                </Button>
                                <Button
                                    aria-pressed={tierFilter.global}
                                    className="gap-1.5"
                                    data-testid={`${testIdPrefix}-tier-global`}
                                    onClick={toggleGlobal}
                                    size="xs"
                                    type="button"
                                    variant={tierFilter.global ? "default" : "outline"}
                                >
                                    <span aria-hidden="true" className="size-1.5 rounded-full" style={GLOBAL_DOT_STYLE} />
                                    {TIER_META.global.label}
                                </Button>
                            </div>
                        </div>
                    </Panel>
                    {/* Bottom-CENTRE, not bottom-left. React Flow docks its zoom
                        controls bottom-left by default, so the legend sat on top
                        of them: the fit-view button's dashed-square icon showed
                        through just left of "Shard-local" (reading as a broken
                        glyph), and the +/− buttons crowded the legend's edge. */}
                    <Panel position="bottom-center">
                        <Legend />
                    </Panel>
                    <Controls showInteractive={false} />
                    {/* Only once the graph outgrows the viewport. Below that it
                        was an unstyled white block covering the legend, to
                        navigate seven nodes you could already see. */}
                    {visibleTables.length > MINIMAP_MIN_TABLES && (
                        <MiniMap
                            className="!border !border-border !bg-card"
                            maskColor="var(--color-muted)"
                            nodeColor="var(--color-muted-foreground)"
                            nodeStrokeWidth={0}
                            pannable
                            zoomable
                        />
                    )}
                    <DiagramExportPanel containerRef={canvasRef} testIdPrefix={testIdPrefix} />
                    <FitOnSeed containerRef={canvasRef} seedKey={seedKey} />
                </ReactFlow>
            </div>
        </section>
    );
};

export { buildEdges, buildNodes, deriveEdges };
export type { DiagramTable, SchemaDiagramProps };
