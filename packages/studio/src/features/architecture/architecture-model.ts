import type { Edge, Node } from "@xyflow/react";
import { Position } from "@xyflow/react";

import type { ArchitectureEdgeKind, ArchitectureManifest, ArchitectureNodeKind } from "../../../../../shared/architecture-manifest";

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

/**
 * The nodes shown for a module filter: the module's own nodes plus every node
 * one edge away, so a cross-module call stays visible with its other end.
 * `undefined` shows everything.
 */
const visibleNodeIds = (manifest: ArchitectureManifest, module: string | undefined, kinds: ReadonlySet<ArchitectureEdgeKind>): Set<string> => {
    if (module === undefined) {
        return new Set(manifest.nodes.map((node) => node.id));
    }

    const own = new Set(manifest.nodes.filter((node) => (node.module ?? APP_LANE) === module).map((node) => node.id));
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

/**
 * One ReactFlow node per lane (a module, or the app lane; custom `lane` type,
 * rendered by the panel) plus its member nodes stacked inside it. Positions are
 * deterministic: lanes left to right in module order, members top to bottom by
 * kind then name.
 */
const layoutArchitecture = (
    manifest: ArchitectureManifest,
    options: { appLaneLabel: string; kinds: ReadonlySet<ArchitectureEdgeKind>; module?: string },
): { edges: Edge[]; nodes: Node[] } => {
    const visible = visibleNodeIds(manifest, options.module, options.kinds);
    const lanes = [...manifest.modules.map((module) => module.name), APP_LANE];
    const nodes: Node[] = [];
    let column = 0;

    for (const lane of lanes) {
        const members = manifest.nodes
            .filter((node) => (node.module ?? APP_LANE) === lane && visible.has(node.id))
            .toSorted((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name));

        if (members.length === 0) {
            continue;
        }

        const laneId = `lane:${lane}`;

        nodes.push({
            data: { label: lane === APP_LANE ? options.appLaneLabel : lane },
            id: laneId,
            position: { x: column * (LANE_WIDTH + LANE_GAP), y: 0 },
            selectable: false,
            style: { height: LANE_HEADER + members.length * (NODE_HEIGHT + NODE_GAP) + NODE_INSET, width: LANE_WIDTH },
            type: "lane",
        });

        for (const [index, member] of members.entries()) {
            nodes.push({
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
            });
        }

        column += 1;
    }

    const edges = manifest.edges
        .filter((edge) => options.kinds.has(edge.kind) && visible.has(edge.from) && visible.has(edge.to))
        .map((edge): Edge => {
            return {
                animated: ASYNC_EDGES.has(edge.kind),
                id: `${edge.from}|${edge.kind}|${edge.to}`,
                label: edge.kind,
                source: edge.from,
                target: edge.to,
            };
        });

    return { edges, nodes };
};

export { APP_LANE, layoutArchitecture, parseArchitecture, visibleNodeIds };
