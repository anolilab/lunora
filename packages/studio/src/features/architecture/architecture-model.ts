import type { Edge, Node } from "@xyflow/react";

import type { ArchitectureEdgeKind, ArchitectureManifest, ArchitectureNode, ArchitectureNodeKind } from "../../../../../shared/architecture-manifest";

/** Edges that hand work off asynchronously — drawn animated. */
const ASYNC_EDGES: ReadonlySet<ArchitectureEdgeKind> = new Set(["enqueue", "publish", "schedule", "start", "subscribe", "trigger"]);

/** Top-to-bottom order of node kinds inside a lane: entry points first, storage last. */
const KIND_ORDER: Readonly<Record<ArchitectureNodeKind, number>> = { cron: 1, function: 2, http: 0, queue: 4, table: 6, topic: 3, workflow: 5 };

/** Edge styling in theme tokens; hoisted so every render reuses the same objects. */
const EDGE_LINE = { stroke: "var(--muted-foreground)" } as const;
const EDGE_LABEL = { fill: "var(--muted-foreground)", fontSize: 10 } as const;
const EDGE_LABEL_BG = { fill: "var(--background)" } as const;

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

/** Where clicking a node goes in the studio: a tab, plus search params when it can be that precise. */
interface StudioLink {
    readonly search?: Readonly<Record<string, string>>;
    readonly to: string;
}

/** The studio page each node kind opens: a table opens its rows, the rest open the tab that lists them. */
const NODE_LINKS: Readonly<Record<ArchitectureNodeKind, (node: ArchitectureNode) => StudioLink>> = {
    cron: () => {
        return { to: "/schedule" };
    },
    function: () => {
        return { to: "/functions" };
    },
    http: () => {
        return { to: "/api" };
    },
    queue: () => {
        return { to: "/queues" };
    },
    table: (node) => {
        return { search: { table: node.name }, to: "/data" };
    },
    topic: () => {
        return { to: "/queues" };
    },
    workflow: () => {
        return { to: "/workflows" };
    },
};

/** The studio page a diagram node opens when clicked. */
const linkFor = (node: ArchitectureNode): StudioLink => NODE_LINKS[node.kind](node);

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
                className: "flex cursor-pointer items-center truncate rounded-md border border-border bg-card px-2 text-xs text-foreground hover:border-ring",
                // The qualifier leads (`query`, `subscription`, a cron schedule, else
                // the kind) so a lane reads as a typed list without a colour key.
                data: { label: `${member.detail ?? member.kind} · ${member.name}`, link: linkFor(member) },
                extent: "parent",
                id: member.id,
                parentId: laneId,
                position: { x: NODE_INSET, y: LANE_HEADER + index * (NODE_HEIGHT + NODE_GAP) },
                style: { height: NODE_HEIGHT, width: LANE_WIDTH - NODE_INSET * 2 },
                type: "member",
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
                // React Flow's base stylesheet leaves the label box unfilled, which
                // paints solid black; theme it like the canvas instead.
                labelBgStyle: EDGE_LABEL_BG,
                labelStyle: EDGE_LABEL,
                source: edge.from,
                style: EDGE_LINE,
                target: edge.to,
                // Routed around nodes, so an edge between two nodes in one lane
                // does not loop back over them.
                type: "smoothstep",
            });
        }
    }

    return { edges, nodes };
};

export type { StudioLink };
export { APP_LANE, laneOf, layoutArchitecture, linkFor, parseArchitecture, visibleNodeIds };
