import type { ReactElement } from "react";

import { useT } from "./i18n-context.js";
import type { StorageTier } from "./storage-tier.js";
import { StorageTierBadge, StorageTierHint } from "./storage-tier.js";

/** A directed foreign-key edge: `from`'s `column` references table `to`. */
interface SchemaEdge {
    column: string;
    from: string;
    to: string;
}

interface SchemaGraphProps {
    /** Foreign-key edges to draw between the tables. */
    readonly edges: ReadonlyArray<SchemaEdge>;
    /** The tables to render as nodes. */
    readonly tables: ReadonlyArray<string>;
    /** Prefix for every `data-testid` so two graphs on one page don't collide. */
    readonly testIdPrefix: string;
    /** Which storage tier this graph represents (drives the header badge). */
    readonly tier: StorageTier;
}

const NODE_WIDTH = 148;
const NODE_HEIGHT = 34;
const COLUMN_GAP = 72;
const ROW_GAP = 18;
const PADDING = 20;

interface PositionedNode {
    name: string;
    x: number;
    y: number;
}

/**
 * Assign each table a column by dependency depth: a table sits one column right
 * of the deepest table it references. Cycle/self-ref safe — a table already on
 * the current DFS stack contributes depth 0 to a back-edge instead of looping.
 */
const computeDepths = (tables: ReadonlyArray<string>, edges: ReadonlyArray<SchemaEdge>): Map<string, number> => {
    const targetsOf = new Map<string, string[]>();

    for (const table of tables) {
        targetsOf.set(table, []);
    }

    for (const edge of edges) {
        if (edge.to !== edge.from && targetsOf.has(edge.from) && targetsOf.has(edge.to)) {
            targetsOf.get(edge.from)?.push(edge.to);
        }
    }

    const depth = new Map<string, number>();
    const visiting = new Set<string>();

    const resolve = (table: string): number => {
        const cached = depth.get(table);

        if (cached !== undefined) {
            return cached;
        }

        if (visiting.has(table)) {
            return 0;
        }

        visiting.add(table);

        let deepest = 0;

        for (const target of targetsOf.get(table) ?? []) {
            deepest = Math.max(deepest, resolve(target) + 1);
        }

        visiting.delete(table);
        depth.set(table, deepest);

        return deepest;
    };

    for (const table of tables) {
        resolve(table);
    }

    return depth;
};

interface Layout {
    height: number;
    nodes: PositionedNode[];
    width: number;
}

/** Lay the tables out in depth columns, stacked top-to-bottom within a column. */
const computeLayout = (tables: ReadonlyArray<string>, edges: ReadonlyArray<SchemaEdge>): Layout => {
    const depth = computeDepths(tables, edges);
    const perColumn = new Map<number, number>();
    const nodes: PositionedNode[] = [];

    for (const name of tables) {
        const column = depth.get(name) ?? 0;
        const row = perColumn.get(column) ?? 0;

        perColumn.set(column, row + 1);
        nodes.push({ name, x: PADDING + column * (NODE_WIDTH + COLUMN_GAP), y: PADDING + row * (NODE_HEIGHT + ROW_GAP) });
    }

    const columns = tables.length === 0 ? 0 : Math.max(...[...depth.values()].map((d) => d + 1));
    const rows = perColumn.size === 0 ? 0 : Math.max(...perColumn.values());
    const width = PADDING * 2 + columns * NODE_WIDTH + Math.max(0, columns - 1) * COLUMN_GAP;
    const height = PADDING * 2 + rows * NODE_HEIGHT + Math.max(0, rows - 1) * ROW_GAP;

    return { height, nodes, width };
};

/** Bezier path between two nodes (right edge of `from` → left edge of `to`), or a small loop for a self-reference. */
const edgePath = (from: PositionedNode, to: PositionedNode): string => {
    if (from.name === to.name) {
        const x = from.x + NODE_WIDTH / 2;
        const { y } = from;

        return `M ${(x - 14).toString()} ${y.toString()} C ${(x - 22).toString()} ${(y - 26).toString()}, ${(x + 22).toString()} ${(y - 26).toString()}, ${(x + 14).toString()} ${y.toString()}`;
    }

    const startX = from.x + NODE_WIDTH;
    const startY = from.y + NODE_HEIGHT / 2;
    const endX = to.x;
    const endY = to.y + NODE_HEIGHT / 2;
    const midX = (startX + endX) / 2;

    return `M ${startX.toString()} ${startY.toString()} C ${midX.toString()} ${startY.toString()}, ${midX.toString()} ${endY.toString()}, ${endX.toString()} ${endY.toString()}`;
};

/**
 * An inline-SVG graph of the data model for one storage tier: tables as nodes,
 * `v.id()` foreign keys as directed edges. The layout is deterministic
 * (dependency-depth columns) and tolerant of cycles and self-references, so it
 * never loops or crashes on a recursive schema. Dependency-free — no graph
 * library, just SVG.
 */
export const SchemaGraph = ({ edges, tables, testIdPrefix, tier }: SchemaGraphProps): ReactElement => {
    const t = useT();
    const { height, nodes, width } = computeLayout(tables, edges);
    const byName = new Map(nodes.map((node) => [node.name, node]));
    const arrowId = `${testIdPrefix}-arrow`;

    return (
        <section className="flex flex-col gap-2" data-testid={`${testIdPrefix}-section`}>
            <div className="flex items-center gap-2">
                <StorageTierBadge tier={tier} />
            </div>
            <StorageTierHint tier={tier} />

            {tables.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>
                    {t("No tables to graph.")}
                </p>
            ) : (
                <div className="overflow-auto rounded-md border border-border">
                    <svg
                        data-testid={`${testIdPrefix}-canvas`}
                        height={height}
                        role="img"
                        viewBox={`0 0 ${width.toString()} ${height.toString()}`}
                        width={width}
                    >
                        <defs>
                            <marker id={arrowId} markerHeight="6" markerWidth="6" orient="auto-start-reverse" refX="5" refY="3">
                                <path className="fill-muted-foreground" d="M0 0 L6 3 L0 6 z" />
                            </marker>
                        </defs>

                        {edges.map((edge) => {
                            const from = byName.get(edge.from);
                            const to = byName.get(edge.to);

                            if (from === undefined || to === undefined) {
                                return null;
                            }

                            return (
                                <path
                                    className="fill-none stroke-muted-foreground/60"
                                    d={edgePath(from, to)}
                                    data-testid={`${testIdPrefix}-edge-${edge.from}-${edge.column}-${edge.to}`}
                                    key={`${edge.from}.${edge.column}->${edge.to}`}
                                    markerEnd={`url(#${arrowId})`}
                                />
                            );
                        })}

                        {nodes.map((node) => (
                            <g data-testid={`${testIdPrefix}-node-${node.name}`} key={node.name}>
                                <rect className="fill-card stroke-border" height={NODE_HEIGHT} rx={6} width={NODE_WIDTH} x={node.x} y={node.y} />
                                <text className="fill-foreground text-xs" x={node.x + 10} y={node.y + NODE_HEIGHT / 2 + 4}>
                                    {node.name}
                                </text>
                            </g>
                        ))}
                    </svg>
                </div>
            )}
        </section>
    );
};

export type { SchemaEdge, SchemaGraphProps };
