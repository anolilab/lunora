/** A directed foreign-key edge: `from`'s `column` references table `to`. */
interface SchemaEdge {
    column: string;
    from: string;
    to: string;
}

/** A table's seed position on the diagram canvas. */
interface NodePosition {
    name: string;
    x: number;
    y: number;
}

/** Width of a table node; columns wrap within it. */
const NODE_WIDTH = 256;
/** Horizontal gap between dependency-depth columns. */
const COLUMN_GAP = 112;
/** Vertical gap between stacked nodes in the same column. */
const ROW_GAP = 36;
/** Outer padding around the laid-out cluster. */
const PADDING = 24;
/** Height of a node's header row. */
const HEADER_HEIGHT = 38;
/** Height of one column row in a node's body. */
const ROW_HEIGHT = 28;

/** Estimated rendered height of a table node carrying `columnCount` columns. */
const nodeHeight = (columnCount: number): number => HEADER_HEIGHT + Math.max(1, columnCount) * ROW_HEIGHT;

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

/**
 * Lay the tables out in dependency-depth columns, stacking top-to-bottom within
 * a column. Node heights vary with column count, so each column tracks its own
 * running vertical offset (the bare-box graph could assume a fixed height; the
 * diagram can't). Deterministic and cycle-safe, so React Flow gets a stable seed
 * the operator can then drag.
 */
const computeLayout = (tables: ReadonlyArray<string>, edges: ReadonlyArray<SchemaEdge>, columnCounts: ReadonlyMap<string, number>): NodePosition[] => {
    const depth = computeDepths(tables, edges);
    const offsetByColumn = new Map<number, number>();
    const nodes: NodePosition[] = [];

    for (const name of tables) {
        const column = depth.get(name) ?? 0;
        const y = offsetByColumn.get(column) ?? PADDING;

        nodes.push({ name, x: PADDING + column * (NODE_WIDTH + COLUMN_GAP), y });
        offsetByColumn.set(column, y + nodeHeight(columnCounts.get(name) ?? 0) + ROW_GAP);
    }

    return nodes;
};

export { computeDepths, computeLayout, NODE_WIDTH, nodeHeight };
export type { NodePosition, SchemaEdge };
