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

/**
 * Shortest a wrapping column may be. Floors the derived cap so a handful of
 * tables cannot wrap into a row of one-node columns.
 */
const MIN_COLUMN_HEIGHT = 480;

/**
 * Roughly how much wider than tall the finished cluster should be — a viewport's
 * shape, so `fitView` has nothing to waste.
 */
const TARGET_ASPECT = 1.4;

/**
 * Per-column height cap, DERIVED from the total content rather than fixed.
 *
 * A fixed cap gets it wrong at both ends. Too tall and tables sharing a
 * dependency depth — the common case, since most tables have no outgoing foreign
 * key — stack into a single strip one node wide and thousands of pixels tall.
 * Too short and a large schema wraps into a strip thousands of pixels WIDE: the
 * full playground schema fitted at scale 0.22, pinned against `minZoom` and
 * unreadable. Either way `fitView` solves for an aspect ratio nothing like a
 * viewport's and zooms everything away.
 *
 * Solving `columns² ≈ TARGET_ASPECT × total / NODE_WIDTH` picks the column count
 * whose cluster lands near {@link TARGET_ASPECT}, then divides the stack across
 * that many columns.
 */
const columnHeightCap = (totalHeight: number): number => {
    const columns = Math.max(1, Math.round(Math.sqrt((TARGET_ASPECT * totalHeight) / (NODE_WIDTH + COLUMN_GAP))));

    return Math.max(MIN_COLUMN_HEIGHT, totalHeight / columns);
};
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

    // Group by dependency depth first, preserving input order so the result stays
    // deterministic and the operator's drags start from a stable seed.
    const byDepth = new Map<number, string[]>();

    for (const name of tables) {
        const at = depth.get(name) ?? 0;
        const bucket = byDepth.get(at);

        if (bucket === undefined) {
            byDepth.set(at, [name]);
        } else {
            bucket.push(name);
        }
    }

    // Derived from the whole stack, so the cap suits this schema's size.
    const totalHeight = tables.reduce((sum, name) => sum + nodeHeight(columnCounts.get(name) ?? 0) + ROW_GAP, 0);
    const cap = columnHeightCap(totalHeight);

    const nodes: NodePosition[] = [];
    // Each depth may need several side-by-side sub-columns once it wraps, so a
    // depth's x offset depends on how many sub-columns every shallower depth
    // actually used — not on the depth number itself.
    let columnCursor = 0;

    for (const at of [...byDepth.keys()].toSorted((left, right) => left - right)) {
        let subColumn = 0;
        let y = PADDING;

        for (const name of byDepth.get(at) ?? []) {
            const height = nodeHeight(columnCounts.get(name) ?? 0);

            // Wrap only if something is already in this sub-column: a single node
            // taller than the cap still gets its own column rather than an empty one.
            if (y > PADDING && y + height > cap) {
                subColumn += 1;
                y = PADDING;
            }

            nodes.push({ name, x: PADDING + (columnCursor + subColumn) * (NODE_WIDTH + COLUMN_GAP), y });
            y += height + ROW_GAP;
        }

        columnCursor += subColumn + 1;
    }

    return nodes;
};

export { computeDepths, computeLayout, NODE_WIDTH, nodeHeight };
export type { NodePosition, SchemaEdge };
