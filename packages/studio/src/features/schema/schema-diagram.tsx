"use client";

import type { Edge, NodeTypes } from "@xyflow/react";
import { Background, Controls, MiniMap, ReactFlow, useEdgesState, useNodesState } from "@xyflow/react";
import type { ReactElement } from "react";
import { useEffect, useMemo } from "react";

import type { StorageTier } from "../../components/storage-tier";
import { StorageTierHint } from "../../components/storage-tier";
import { useT } from "../../i18n/i18n-context";
import type { ColumnMeta } from "../../lib/admin";
import type { DatabaseSchemaNodeType } from "./database-schema-node";
import { DatabaseSchemaNode } from "./database-schema-node";
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
            <div className="h-[480px] w-full overflow-hidden rounded-md border border-border" data-testid={`${testIdPrefix}-canvas`}>
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
                </ReactFlow>
            </div>
        </section>
    );
};

export { buildEdges, buildNodes };
export type { SchemaDiagramProps };
