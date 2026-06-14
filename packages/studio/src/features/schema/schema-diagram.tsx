"use client";

import type { Edge, NodeTypes } from "@xyflow/react";
import { Background, Controls, MiniMap, Panel, ReactFlow, useEdgesState, useNodesState } from "@xyflow/react";
import type { ChangeEvent, CSSProperties, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { StorageTier } from "../../components/storage-tier";
import { TIER_META } from "../../components/storage-tier";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useT } from "../../i18n/i18n-context";
import type { ColumnMeta } from "../../lib/admin";
import type { DatabaseSchemaNodeType } from "./database-schema-node";
import { DatabaseSchemaNode } from "./database-schema-node";
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

interface SchemaDiagramProps {
    /** True when the typed-column probe failed — nodes show a "columns unavailable" hint instead of an empty `—`. */
    readonly columnsError?: boolean;
    /** Every table to render, across both storage tiers, with its typed columns. */
    readonly tables: ReadonlyArray<DiagramTable>;
    /** Prefix for every `data-testid` so the diagram's controls are addressable. */
    readonly testIdPrefix: string;
}

/**
 * The PK column an FK edge attaches to: the `pk`-flagged column when the schema
 * marks one (Cirrus tables), else the Cirrus system PK `_id`, else the `id`
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

/** Build the React Flow nodes from the tables + their typed columns, seeded by the depth layout. */
const buildNodes = (tables: ReadonlyArray<DiagramTable>, columnsError: boolean): DatabaseSchemaNodeType[] => {
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card/95 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
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
export const SchemaDiagram = ({ columnsError, tables, testIdPrefix }: SchemaDiagramProps): ReactElement => {
    const t = useT();

    const [tierFilter, setTierFilter] = useState<TierVisibility>(ALL_TIERS);
    const [query, setQuery] = useState<string>("");

    // The tables actually drawn: kept by the active tier toggles and matching the
    // find-table query (case-insensitive substring). Edges to a filtered-out table
    // drop automatically, since `buildEdges` only sees the visible set.
    const visibleTables = useMemo<DiagramTable[]>(() => {
        const needle = query.trim().toLowerCase();

        return tables.filter((table) => tierFilter[table.tier] && table.name.toLowerCase().includes(needle));
    }, [tables, tierFilter, query]);

    const seededNodes = useMemo(() => buildNodes(visibleTables, columnsError ?? false), [visibleTables, columnsError]);
    const seededEdges = useMemo(() => buildEdges(visibleTables), [visibleTables]);

    const [nodes, setNodes, onNodesChange] = useNodesState<DatabaseSchemaNodeType>(seededNodes);
    const [flowEdges, setEdges, onEdgesChange] = useEdgesState(seededEdges);

    // Re-seed when the source data or filters change (shard switch, columns
    // finished probing, a tier toggled). This resets manual drags, which is fine —
    // columns load once and the operator re-applies the filter deliberately.
    useEffect(() => {
        setNodes(seededNodes);
    }, [seededNodes, setNodes]);
    useEffect(() => {
        setEdges(seededEdges);
    }, [seededEdges, setEdges]);

    const onQueryChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
        setQuery(event.target.value);
    }, []);
    const toggleShard = useCallback((): void => {
        setTierFilter((previous) => {
            return { ...previous, shard: !previous.shard };
        });
    }, []);
    const toggleGlobal = useCallback((): void => {
        setTierFilter((previous) => {
            return { ...previous, global: !previous.global };
        });
    }, []);

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
        <section className="flex flex-col gap-2" data-testid={`${testIdPrefix}-section`}>
            <div className="h-[560px] w-full overflow-hidden rounded-md border border-border bg-muted/20" data-testid={`${testIdPrefix}-canvas`}>
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
                        <div className="flex flex-col gap-2 rounded-md border border-border bg-card/95 p-2 shadow-sm backdrop-blur">
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
                    <Panel position="bottom-left">
                        <Legend />
                    </Panel>
                    <Controls showInteractive={false} />
                    <MiniMap pannable zoomable />
                </ReactFlow>
            </div>
        </section>
    );
};

export { buildEdges, buildNodes, deriveEdges };
export type { DiagramTable, SchemaDiagramProps };
