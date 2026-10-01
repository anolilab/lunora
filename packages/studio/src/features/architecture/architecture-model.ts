import type { Edge, Node } from "@xyflow/react";
import { Position } from "@xyflow/react";

import type { ArchitectureEdgeKind, ArchitectureManifest, ArchitectureNode, ArchitectureNodeKind } from "../../../../../shared/architecture-manifest";

/** Edges that hand work off asynchronously — drawn animated. */
const ASYNC_EDGES: ReadonlySet<ArchitectureEdgeKind> = new Set(["enqueue", "publish", "schedule", "start", "subscribe", "trigger"]);

/** Top-to-bottom order of node kinds inside a lane: entry points first, storage last. */
const KIND_ORDER: Readonly<Record<ArchitectureNodeKind, number>> = { cron: 1, function: 2, http: 0, queue: 4, table: 6, topic: 3, workflow: 5 };

/** The lane id for nodes outside every module. */
const APP_LANE = "";

const LANE_WIDTH = 260;
const LANE_GAP = 120;
const LANE_HEADER = 44;
const NODE_HEIGHT = 40;
const NODE_GAP = 12;
const NODE_INSET = 16;

/**
 * Accept the fetched document only when it has the manifest's array fields, so
 * a malformed or foreign response renders the error state instead of throwing
 * inside the canvas.
 */
const parseArchitecture = (value: unknown): ArchitectureManifest | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const candidate = value as Record<string, unknown>;

    return ["edges", "nodes", "modules", "unresolved"].every((key) => Array.isArray(candidate[key]))
        ? (candidate as unknown as ArchitectureManifest)
        : undefined;
};

/** The lane a node is drawn in: its module, or the app lane. */
const laneOf = (node: ArchitectureNode): string => node.module ?? APP_LANE;

/**
 * The nodes shown for a lane filter: the lane's own nodes plus every node one
 * edge away, so a cross-module call stays visible with its other end.
 * `undefined` shows everything.
 */
const visibleNodeIds = (manifest: ArchitectureManifest, lane: string | undefined, kinds: ReadonlySet<ArchitectureEdgeKind>): Set<string> => {
    const own = new Set<string>();

    for (const node of manifest.nodes) {
        if (lane === undefined || laneOf(node) === lane) {
            own.add(node.id);
        }
    }

    if (lane === undefined) {
        return own;
    }

    const visible = new Set(own);

    for (const edge of manifest.edges) {
        if (!kinds.has(edge.kind)) {
            continue;
        }

        if (own.has(edge.from)) {
            visible.add(edge.to);
        }

        if (own.has(edge.to)) {
            visible.add(edge.from);
        }
    }

    return visible;
};

/** The ReactFlow nodes for one lane: the labelled container, then its members stacked inside it. */
const laneNodes = (lane: string, label: string, column: number, members: ReadonlyArray<ArchitectureNode>): Node[] => {
    const laneId = `lane:${lane}`;

    return [
        {
            data: { label },
            id: laneId,
            position: { x: column * (LANE_WIDTH + LANE_GAP), y: 0 },
            selectable: false,
            style: { height: LANE_HEADER + members.length * (NODE_HEIGHT + NODE_GAP) + NODE_INSET, width: LANE_WIDTH },
            type: "lane",
        },
        ...members.map((member, index): Node => {
            return {
                className: "flex items-center truncate rounded-md border border-border bg-card px-2 text-xs text-foreground",
                // The qualifier leads (`query`, `subscription`, a cron schedule, else
                // the kind) so a lane reads as a typed list without a colour key.
                data: { label: `${member.detail ?? member.kind} · ${member.name}` },
                extent: "parent",
                id: member.id,
                parentId: laneId,
                position: { x: NODE_INSET, y: LANE_HEADER + index * (NODE_HEIGHT + NODE_GAP) },
                sourcePosition: Position.Right,
                style: { height: NODE_HEIGHT, width: LANE_WIDTH - NODE_INSET * 2 },
                targetPosition: Position.Left,
            };
        }),
    ];
};

/**
 * One ReactFlow node per lane (a module, or the app lane; custom `lane` type,
 * rendered by the panel) plus its member nodes stacked inside it. Positions are
 * deterministic: lanes left to right in module order, members top to bottom by
 * kind then name.
 */
const layoutArchitecture = (
    manifest: ArchitectureManifest,
    options: { appLaneLabel: string; componentLabel: string; kinds: ReadonlySet<ArchitectureEdgeKind>; lane?: string },
): { edges: Edge[]; nodes: Node[] } => {
    const visible = visibleNodeIds(manifest, options.lane, options.kinds);
    const members = new Map<string, ArchitectureNode[]>();

    for (const node of manifest.nodes) {
        if (visible.has(node.id)) {
            members.set(laneOf(node), [...(members.get(laneOf(node)) ?? []), node]);
        }
    }

    const lanes: { label: string; lane: string }[] = [
        ...manifest.modules.map((entry) => {
            return { label: entry.installed === true ? `${entry.name} · ${options.componentLabel}` : entry.name, lane: entry.name };
        }),
        { label: options.appLaneLabel, lane: APP_LANE },
    ];
    const nodes: Node[] = [];
    let column = 0;

    for (const { label, lane } of lanes) {
        const sorted = (members.get(lane) ?? []).toSorted((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));

        if (sorted.length > 0) {
            nodes.push(...laneNodes(lane, label, column, sorted));
            column += 1;
        }
    }

    const edges: Edge[] = [];

    for (const edge of manifest.edges) {
        if (options.kinds.has(edge.kind) && visible.has(edge.from) && visible.has(edge.to)) {
            edges.push({
                animated: ASYNC_EDGES.has(edge.kind),
                id: `${edge.from}|${edge.kind}|${edge.to}`,
                label: edge.kind,
                source: edge.from,
                target: edge.to,
            });
        }
    }

    return { edges, nodes };
};

export { APP_LANE, laneOf, layoutArchitecture, parseArchitecture, visibleNodeIds };
