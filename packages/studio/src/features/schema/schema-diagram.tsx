"use client";

import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Edge, NodeTypes } from "@xyflow/react";
import { Background, Controls, MiniMap, Panel, ReactFlow, useEdgesState, useNodes, useNodesState, useReactFlow } from "@xyflow/react";
import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { StorageTier } from "../../components/storage-tier";
import { StorageTierHint } from "../../components/storage-tier";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { useT } from "../../i18n/i18n-context";
import type { ColumnMeta } from "../../lib/admin";
import { fireAndForget } from "../../lib/internal";
import type { DatabaseSchemaNodeType } from "./database-schema-node";
import { DatabaseSchemaNode } from "./database-schema-node";
import { exportDiagramAsJson, exportDiagramAsPng, exportDiagramAsSvg } from "./diagram-export";
import type { SchemaEdge } from "./layout";
import { computeLayout } from "./layout";

// Registered once: a narrow custom-node component can't be assigned to React
// Flow's broad `NodeTypes` map without widening, so cast at the single seam.
const NODE_TYPES = { databaseSchema: DatabaseSchemaNode } as unknown as NodeTypes;

interface SchemaDiagramProps {
    /** Typed columns per table (from `describeTable`); a table absent here renders with no rows yet. */
    readonly columnsByTable: Readonly<Record<string, ColumnMeta[]>>;
    /** True when the typed-column probe for this tier failed — nodes show a "columns unavailable" hint instead of an empty `—`. */
    readonly columnsError?: boolean;
    /** Foreign-key edges to draw between the tables. */
    readonly edges: ReadonlyArray<SchemaEdge>;
    /** The tables to render as nodes. */
    readonly tables: ReadonlyArray<string>;
    /** Prefix for every `data-testid` so two diagrams on one page don't collide. */
    readonly testIdPrefix: string;
    /** Which storage tier this diagram represents (drives the per-node badge). */
    readonly tier: StorageTier;
}

/** The PK column of a table — the `pk`-flagged column, defaulting to the `_id` system field. */
const pkColumnOf = (columns: ReadonlyArray<ColumnMeta>): string => columns.find((column) => column.pk === true)?.name ?? "_id";

/** Build the React Flow nodes from the tables + their typed columns, seeded by the depth layout. */
const buildNodes = (
    tables: ReadonlyArray<string>,
    edges: ReadonlyArray<SchemaEdge>,
    columnsByTable: Readonly<Record<string, ColumnMeta[]>>,
    tier: StorageTier,
    columnsError: boolean,
): DatabaseSchemaNodeType[] => {
    const counts = new Map<string, number>(tables.map((name) => [name, (columnsByTable[name] ?? []).length]));
    const positions = computeLayout(tables, edges, counts);

    return positions.map(({ name, x, y }) => {
        return {
            data: { columns: columnsByTable[name] ?? [], label: name, loadError: columnsError, tier },
            id: name,
            position: { x, y },
            type: "databaseSchema",
        };
    });
};

/**
 * Build the React Flow edges. An FK edge `from.column → to` is drawn from the
 * referenced table's PK (a right **source** handle on `to`) to the referencing
 * column (a left **target** handle on `from`), so it flows left-to-right with the
 * depth layout. An edge is emitted only when both handles exist (both tables'
 * columns are loaded), so a half-probed graph never references a missing handle.
 */
const buildEdges = (edges: ReadonlyArray<SchemaEdge>, columnsByTable: Readonly<Record<string, ColumnMeta[]>>): Edge[] =>
    edges.flatMap((edge): Edge[] => {
        const targetColumns = columnsByTable[edge.to] ?? [];
        const sourceColumns = columnsByTable[edge.from] ?? [];
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

    const handlePng = useCallback(async (): Promise<void> => {
        const viewport = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");

        if (!viewport) {
            return;
        }

        setExporting("png");

        try {
            await exportDiagramAsPng(viewport, nodes, `${testIdPrefix}-schema-diagram.png`);
        } finally {
            setExporting(null);
        }
    }, [containerRef, nodes, testIdPrefix]);

    const handleSvg = useCallback(async (): Promise<void> => {
        const viewport = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");

        if (!viewport) {
            return;
        }

        setExporting("svg");

        try {
            await exportDiagramAsSvg(viewport, nodes, `${testIdPrefix}-schema-diagram.svg`);
        } finally {
            setExporting(null);
        }
    }, [containerRef, nodes, testIdPrefix]);

    const handleJson = useCallback((): void => {
        setExporting("json");

        try {
            exportDiagramAsJson(nodes, getEdges(), `${testIdPrefix}-schema-diagram.json`);
        } finally {
            setExporting(null);
        }
    }, [nodes, getEdges, testIdPrefix]);

    const onClickPng = useCallback((): void => {
        fireAndForget(handlePng());
    }, [handlePng]);

    const onClickSvg = useCallback((): void => {
        fireAndForget(handleSvg());
    }, [handleSvg]);

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
 * A Supabase-style schema diagram for one storage tier, built on React Flow:
 * each table is a node listing its columns with types and PK/FK markers, and
 * `v.id()` foreign keys are drawn handle-to-handle on a pannable, zoomable,
 * mini-mapped canvas. The seed layout is deterministic (dependency-depth columns,
 * cycle-safe) so the diagram opens stable, then the operator can drag nodes.
 * Read-only — connecting is disabled.
 */
export const SchemaDiagram = ({ columnsByTable, columnsError, edges, tables, testIdPrefix, tier }: SchemaDiagramProps): ReactElement => {
    const t = useT();

    const seededNodes = useMemo(
        () => buildNodes(tables, edges, columnsByTable, tier, columnsError ?? false),
        [tables, edges, columnsByTable, tier, columnsError],
    );
    const seededEdges = useMemo(() => buildEdges(edges, columnsByTable), [edges, columnsByTable]);

    const [nodes, setNodes, onNodesChange] = useNodesState<DatabaseSchemaNodeType>(seededNodes);
    const [flowEdges, setEdges, onEdgesChange] = useEdgesState(seededEdges);

    // A ref to the wrapping div so the export panel can find the
    // `.react-flow__viewport` element without leaving the React tree.
    const canvasRef = useRef<HTMLDivElement>(null);

    // Re-seed when the source data changes (shard switch, columns finished
    // probing). This resets manual drags, which is fine — columns load once.
    useEffect(() => {
        setNodes(seededNodes);
    }, [seededNodes, setNodes]);
    useEffect(() => {
        setEdges(seededEdges);
    }, [seededEdges, setEdges]);

    if (tables.length === 0) {
        return (
            <section className="flex flex-col gap-2" data-testid={`${testIdPrefix}-section`}>
                <StorageTierHint tier={tier} />
                <p className="text-sm text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>
                    {t("No tables to graph.")}
                </p>
            </section>
        );
    }

    return (
        <section className="flex flex-col gap-2" data-testid={`${testIdPrefix}-section`}>
            <StorageTierHint tier={tier} />
            <div className="h-[480px] w-full overflow-hidden rounded-md border border-border" data-testid={`${testIdPrefix}-canvas`} ref={canvasRef}>
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
                    <Controls showInteractive={false} />
                    <MiniMap pannable zoomable />
                    <DiagramExportPanel containerRef={canvasRef} testIdPrefix={testIdPrefix} />
                </ReactFlow>
            </div>
        </section>
    );
};

export { buildEdges, buildNodes };
export type { SchemaDiagramProps };
