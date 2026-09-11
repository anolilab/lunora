/**
 * Schema-derived relation graph — the edge set a `v.id("target")` column
 * already describes, and the bounded breadth-first walk `ctx.db.related(...)`
 * runs over it.
 *
 * A `v.id("customers")` column is a foreign key: it names the table the value
 * points at, and `@lunora/values` keeps that name on the validator's metadata
 * bag. Until now nothing read it at runtime, so "give me this customer's
 * tickets, and those tickets' messages" had to be spelled out as a hand-written
 * chain of `findMany` calls with the join columns typed in by hand — the exact
 * expansion the schema already fully determines.
 *
 * **This module holds no SQL.** Every hop goes back through the caller's own
 * writer — one batched `findMany(… WHERE _id IN (…))` per out-edge, one
 * `findMany(… WHERE fk IN (…))` per in-edge — which is what keeps the traversal
 * honest about everything that layer already does: read-dependency stamping for
 * live subscriptions, soft-delete scoping, `.global()` routing to the D1
 * writer, and the RLS `baseWhere` / `relationBaseWhere` and column-mask seams a
 * `with` hop already threads. A traversal that emitted its own SQL would
 * quietly opt out of all of them.
 *
 * **Bounded by construction.** `depth` is capped at {@link RELATED_MAX_DEPTH}
 * and `limit` at {@link RELATED_MAX_LIMIT}, and a `visited` set makes a cyclic
 * schema (`a.bId` → `b`, `b.aId` → `a`) terminate at the first revisit rather
 * than expanding forever. Both caps are refusals, not silent clamps: a caller
 * asking for depth 9 has a wrong mental model of the cost, and quietly serving
 * them depth 4 hides it.
 *
 * `@lunora/codegen` derives the same edge set from the static schema IR
 * (its own `relation-graph.ts`) to answer a question the runtime cannot —
 * whether the app declares a relation graph at all, which is the
 * `PlatformSignals` input gating the `relationGraph` capability. The two name
 * edges identically and both are pinned by tests.
 */
import { LunoraError } from "@lunora/errors";

import { mergeWhere } from "./aggregates";
import { CURSOR_PREFIX, decodeCursor, toBase64 } from "./query-args";
import type {
    DatabaseWriterLike,
    RelatedDirection,
    RelatedNode,
    RelatedOptions,
    RelatedPage,
    RelatedStart,
    RelationEdge,
    SchemaLike,
    ValidatorLike,
} from "./schema-types";
import type { WhereInput } from "./where-types";

/**
 * Hard ceiling on `depth`.
 *
 * Four hops is already `edges × frontier` reads per hop against one shard
 * inside one request, and the frontier grows multiplicatively — the fifth hop
 * is where a realistic schema stops being bounded by `limit` and starts being
 * bounded by how long a request may run. A deeper walk is a graph query, which
 * is a different product; this is a retrieval primitive.
 */
const RELATED_MAX_DEPTH = 4;

/** Default `depth` — the direct neighbourhood, which is the common case. */
const RELATED_DEFAULT_DEPTH = 1;

/** Default `limit` — enough to feed a prompt or a side panel without paging. */
const RELATED_DEFAULT_LIMIT = 50;

/** Hard ceiling on `limit`, for the same reason `depth` has one. */
const RELATED_MAX_LIMIT = 200;

/**
 * Per-hop score decay: a node's score is `RELATED_DEPTH_DECAY ** (depth - 1)`,
 * so depth 1 scores `1`, depth 2 `0.5`, depth 3 `0.25`.
 *
 * Halving rather than `1 / depth` because the useful property is that distant
 * evidence cannot out-weigh a direct neighbour: the geometric tail from depth 2
 * sums to less than one depth-1 hit as long as the branching factor stays under
 * 2, which is the shape a rank fusion wants from a proximity signal.
 */
const RELATED_DEPTH_DECAY = 0.5;

/**
 * The `v.id` target of a column validator, unwrapping the wrappers a foreign
 * key is legitimately declared under, or `undefined` when the column is not a
 * foreign key.
 *
 * `v.optional(v.id("t"))` (a nullable FK) and `v.array(v.id("t"))` (a to-many
 * one) are as much an edge as a bare `v.id("t")`, so both wrappers are
 * traversed. Anything else — an id inside a `v.object`, a `v.union`, a
 * `v.record` — is deliberately NOT an edge: it is not a column the query layer
 * can filter on, so an edge named for it would describe a hop no read could
 * take.
 */
const foreignKeyTargetOf = (validator: ValidatorLike): { array: boolean; targetTable: string } | undefined => {
    if (validator.kind === "id") {
        const tableName = validator._meta?.tableName;

        return typeof tableName === "string" && tableName.length > 0 ? { array: false, targetTable: tableName } : undefined;
    }

    if (validator.kind !== "array" && validator.kind !== "optional") {
        return undefined;
    }

    const inner = validator._meta?.inner;
    const resolved = inner === undefined ? undefined : foreignKeyTargetOf(inner);

    if (resolved === undefined) {
        return undefined;
    }

    return { array: resolved.array || validator.kind === "array", targetTable: resolved.targetTable };
};

/**
 * Derive every foreign-key edge `schema` declares, in a deterministic order
 * (table declaration order, then column order within a table) so a traversal
 * over the same schema always visits the same nodes in the same sequence —
 * which is what lets a page cursor be an offset.
 *
 * An edge whose target table is not declared in this schema is DROPPED: it
 * names a hop no read could serve, and keeping it would put an unresolvable
 * name in the set a caller picks `edges` from.
 * @param schema The shard's table definitions.
 * @returns Every declared, resolvable foreign-key edge.
 */
const deriveRelationEdges = (schema: SchemaLike): RelationEdge[] => {
    const edges: RelationEdge[] = [];

    for (const [sourceTable, definition] of Object.entries(schema.tables)) {
        for (const [column, validator] of Object.entries(definition.shape)) {
            const target = foreignKeyTargetOf(validator);

            if (target === undefined || schema.tables[target.targetTable] === undefined) {
                continue;
            }

            edges.push({
                array: target.array,
                column,
                name: `${sourceTable}.${column}`,
                sourceTable,
                targetTable: target.targetTable,
            });
        }
    }

    return edges;
};

/** The reads a traversal makes — the caller's own writer, narrowed to what a hop needs. */
type RelationGraphReader = Pick<DatabaseWriterLike, "findMany"> & Pick<Partial<DatabaseWriterLike>, "lookupById">;

/** A node on the walk's frontier: the loaded row plus how it was reached. */
interface FrontierNode {
    document: Record<string, unknown>;
    id: string;
    path: string[];
    pathIds: string[];
    table: string;
}

/** The per-hop seams a hop needs beyond the edge itself. */
interface HopContext {
    /** Most rows this hop may still pull back — always `>= 1` at the call site. */
    limit: number;
    mask: RelatedOptions["relationMask"];
    relationBaseWhere: RelatedOptions["relationBaseWhere"];
    visited: Set<string>;
}

/** Encode a page offset as an opaque cursor, in the same envelope every other `ctx.db` cursor uses. */
const encodeRelatedCursor = (offset: number): string => CURSOR_PREFIX + toBase64(JSON.stringify([offset]));

/** Decode a traversal cursor back into its page offset; a malformed one is the caller's mistake, not a server fault. */
const decodeRelatedCursor = (cursor: string): number => {
    const [offset] = decodeCursor(cursor);

    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
        throw new LunoraError("BAD_REQUEST", "invalid cursor");
    }

    return offset;
};

/** Refuse an out-of-range integer option up front, naming the bound it broke. */
const readBoundedInteger = (value: number | undefined, fallback: number, max: number, name: string): number => {
    if (value === undefined) {
        return fallback;
    }

    if (!Number.isInteger(value) || value < 1 || value > max) {
        throw new LunoraError("BAD_REQUEST", `ctx.db.related: \`${name}\` must be an integer between 1 and ${String(max)}, got ${String(value)}`);
    }

    return value;
};

/**
 * Narrow the edge set to the caller's `edges` allow-list, refusing any name the
 * schema does not declare. A typo that silently widened the traversal to every
 * edge is the failure this rules out.
 */
const selectEdges = (edges: ReadonlyArray<RelationEdge>, names: ReadonlyArray<string> | undefined): RelationEdge[] => {
    if (names === undefined) {
        return [...edges];
    }

    const declared = new Set(edges.map((edge) => edge.name));
    const unknown = names.filter((name) => !declared.has(name));

    if (unknown.length > 0) {
        throw new LunoraError("BAD_REQUEST", `ctx.db.related: unknown edge ${unknown.length === 1 ? "name" : "names"}: ${unknown.join(", ")}`);
    }

    const wanted = new Set(names);

    return edges.filter((edge) => wanted.has(edge.name));
};

/** The id values an out-edge's column holds on one row — one for a scalar FK, many for an array one. */
const outboundIds = (document: Record<string, unknown>, edge: RelationEdge): string[] => {
    const value = document[edge.column];

    if (edge.array) {
        return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
    }

    return typeof value === "string" && value.length > 0 ? [value] : [];
};

/** Read `limit` rows of `table` matching `where`, with the hop's policy filter AND-merged and its column mask applied. */
const readHop = async (reader: RelationGraphReader, table: string, where: WhereInput, hop: HopContext): Promise<Record<string, unknown>[]> => {
    const page = await reader.findMany(table, {
        limit: hop.limit,
        omitContinueCursor: true,
        where: mergeWhere(where, hop.relationBaseWhere?.(table)) ?? where,
    });

    return hop.mask?.(table, page.page) ?? page.page;
};

/**
 * Expand a frontier along one OUT edge: load the rows whose ids the frontier's
 * foreign-key columns hold.
 *
 * One batched read for the whole frontier rather than a `get` per id, so the
 * hop's cost is a function of the edge set rather than of the frontier width —
 * and so the policy filter and column mask, which only a `findMany` can carry,
 * apply to an out-hop exactly as they do to an in-hop.
 */
const expandOutEdge = async (
    reader: RelationGraphReader,
    frontier: ReadonlyArray<FrontierNode>,
    edge: RelationEdge,
    hop: HopContext,
): Promise<FrontierNode[]> => {
    /** First parent to name a target id owns the path to it — the shortest one, since the walk is breadth-first. */
    const parentOf = new Map<string, FrontierNode>();

    for (const node of frontier) {
        if (node.table !== edge.sourceTable) {
            continue;
        }

        for (const targetId of outboundIds(node.document, edge)) {
            if (!hop.visited.has(targetId) && !parentOf.has(targetId)) {
                parentOf.set(targetId, node);
            }
        }
    }

    if (parentOf.size === 0) {
        return [];
    }

    const rows = await readHop(reader, edge.targetTable, { _id: { in: [...parentOf.keys()] } }, hop);
    const reached: FrontierNode[] = [];

    for (const row of rows) {
        const id = row["_id"];
        const parent = typeof id === "string" ? parentOf.get(id) : undefined;

        if (typeof id !== "string" || parent === undefined || hop.visited.has(id)) {
            continue;
        }

        hop.visited.add(id);
        reached.push({ document: row, id, path: [...parent.path, edge.name], pathIds: [...parent.pathIds, id], table: edge.targetTable });
    }

    return reached;
};

/**
 * Expand a frontier along one IN edge: every row of the holder table whose
 * foreign key points at one of the frontier's ids, in a single batched read.
 *
 * **Array foreign keys have no in-direction.** `where` carries no
 * array-containment operator, so finding the rows whose `v.array(v.id(...))`
 * column CONTAINS an id would mean scanning the holder table and filtering in
 * memory — per node, per hop. An unbounded scan is worse than a missing hop, so
 * an array edge is followed outward only; the docs page says so too.
 */
const expandInEdge = async (
    reader: RelationGraphReader,
    frontier: ReadonlyArray<FrontierNode>,
    edge: RelationEdge,
    hop: HopContext,
): Promise<FrontierNode[]> => {
    if (edge.array) {
        return [];
    }

    const parentOf = new Map<string, FrontierNode>();

    for (const node of frontier) {
        if (node.table === edge.targetTable && !parentOf.has(node.id)) {
            parentOf.set(node.id, node);
        }
    }

    if (parentOf.size === 0) {
        return [];
    }

    const rows = await readHop(reader, edge.sourceTable, { [edge.column]: { in: [...parentOf.keys()] } }, hop);
    const reached: FrontierNode[] = [];

    for (const row of rows) {
        const id = row["_id"];
        const foreignKey = row[edge.column];
        const parent = typeof foreignKey === "string" ? parentOf.get(foreignKey) : undefined;

        if (typeof id !== "string" || parent === undefined || hop.visited.has(id)) {
            continue;
        }

        hop.visited.add(id);
        reached.push({ document: row, id, path: [...parent.path, edge.name], pathIds: [...parent.pathIds, id], table: edge.sourceTable });
    }

    return reached;
};

/**
 * Expand one whole frontier by one hop: every selected edge, in both requested
 * directions, stopping as soon as `budget` nodes have been reached.
 *
 * Sequential rather than concurrent, and that is load-bearing: each expansion
 * must observe the `visited` set the previous one updated, or two edges in the
 * same hop would both claim the same target row and return it twice.
 */
const expandFrontier = async (
    reader: RelationGraphReader,
    frontier: ReadonlyArray<FrontierNode>,
    edges: ReadonlyArray<RelationEdge>,
    options: {
        budget: number;
        direction: RelatedDirection;
        mask: RelatedOptions["relationMask"];
        relationBaseWhere: RelatedOptions["relationBaseWhere"];
        visited: Set<string>;
    },
): Promise<FrontierNode[]> => {
    const reached: FrontierNode[] = [];
    const hopOf = (): HopContext => {
        return {
            limit: options.budget - reached.length,
            mask: options.mask,
            relationBaseWhere: options.relationBaseWhere,
            visited: options.visited,
        };
    };

    for (const edge of edges) {
        if (options.direction !== "in" && hopOf().limit > 0) {
            // eslint-disable-next-line no-await-in-loop -- see the docblock: `visited` must be authoritative across edges within one hop
            reached.push(...(await expandOutEdge(reader, frontier, edge, hopOf())));
        }

        if (options.direction !== "out" && hopOf().limit > 0) {
            // eslint-disable-next-line no-await-in-loop -- same
            reached.push(...(await expandInEdge(reader, frontier, edge, hopOf())));
        }
    }

    return reached;
};

/** Resolve `{ table, id }` from either accepted start form, or refuse it. */
const resolveStart = async (reader: RelationGraphReader, start: RelatedStart): Promise<{ id: string; table: string }> => {
    const documentId = (start as Record<string, unknown>)["_id"];

    if (typeof documentId === "string" && documentId.length > 0) {
        // A loaded document carries its id but not its table, so the writer's
        // `lookupById` seam supplies it. A `.global()` row is not resolvable
        // through that seam (its table lives in D1), which is why the refusal
        // names the `{ table, id }` form rather than reporting "no such row".
        const located = await reader.lookupById?.(documentId);

        if (!located) {
            throw new LunoraError("BAD_REQUEST", "ctx.db.related: could not resolve the start document's table from its `_id` — pass `{ table, id }` instead");
        }

        return { id: documentId, table: located.tableName };
    }

    const { id, table } = start as { id?: unknown; table?: unknown };

    if (typeof table !== "string" || table.length === 0 || typeof id !== "string" || id.length === 0) {
        throw new LunoraError("BAD_REQUEST", "ctx.db.related: `start` must be a loaded document or `{ table, id }`");
    }

    return { id, table };
};

/**
 * Walk the relation graph out of `start` and return one page of reached nodes.
 *
 * Breadth-first: every depth-1 neighbour is emitted before any depth-2 one, so
 * the result is already ordered by the score it carries. The walk stops as soon
 * as it holds one node more than the page needs, which is what makes `isDone`
 * honest without expanding a frontier nobody asked for.
 *
 * The cursor is an OFFSET, not a keyset. The edge set, the frontier order and
 * the per-edge read order are all deterministic, so page N+1 re-walks and skips
 * what page N returned. That is the honest trade for a breadth-first expansion
 * — there is no single ordered column to seek on — and the re-walk is bounded
 * by the same depth and limit caps as the first page.
 * @param reader The caller's writer, so every hop inherits its read behaviour.
 * @param edges The schema's edge set, from {@link deriveRelationEdges}.
 * @param start A loaded document or `{ table, id }`.
 * @param options Depth, direction, edge allow-list, limit, cursor, and the engine-internal RLS/mask seams.
 * @returns One page of reached nodes, nearest first.
 */
const findRelated = async (
    reader: RelationGraphReader,
    edges: ReadonlyArray<RelationEdge>,
    start: RelatedStart,
    options: RelatedOptions = {},
): Promise<RelatedPage> => {
    const depth = readBoundedInteger(options.depth, RELATED_DEFAULT_DEPTH, RELATED_MAX_DEPTH, "depth");
    const limit = readBoundedInteger(options.limit, RELATED_DEFAULT_LIMIT, RELATED_MAX_LIMIT, "limit");
    const offset = options.cursor ? decodeRelatedCursor(options.cursor) : 0;
    const direction = options.direction ?? "both";
    const selected = selectEdges(edges, options.edges);
    const { id: startId, table: startTable } = await resolveStart(reader, start);

    // Through the same `readHop` every other read uses, so the start row is
    // subject to its table's policy filter too: a start row the caller may not
    // read must look absent, not like a node whose neighbourhood is then handed
    // back.
    const [startDocument] = await readHop(
        reader,
        startTable,
        { _id: startId },
        { limit: 1, mask: options.relationMask, relationBaseWhere: options.relationBaseWhere, visited: new Set() },
    );

    if (startDocument === undefined) {
        throw new LunoraError("NOT_FOUND", `ctx.db.related: no "${startTable}" row with id ${startId}`);
    }

    // One more than the page needs, so `isDone` can tell "that was everything"
    // from "the walk stopped because the page was full".
    const wanted = offset + limit + 1;
    const visited = new Set<string>([startId]);
    const nodes: RelatedNode[] = [];
    let frontier: FrontierNode[] = [{ document: startDocument, id: startId, path: [], pathIds: [startId], table: startTable }];

    for (let hop = 1; hop <= depth && frontier.length > 0 && nodes.length < wanted; hop += 1) {
        // eslint-disable-next-line no-await-in-loop -- each hop expands the frontier the PREVIOUS hop produced; that is what breadth-first means
        const reached = await expandFrontier(reader, frontier, selected, {
            budget: wanted - nodes.length,
            direction,
            mask: options.relationMask,
            relationBaseWhere: options.relationBaseWhere,
            visited,
        });
        const score = RELATED_DEPTH_DECAY ** (hop - 1);

        for (const node of reached) {
            nodes.push({ depth: hop, document: node.document, path: node.path, pathIds: node.pathIds, score, table: node.table });
        }

        frontier = reached;
    }

    const isDone = nodes.length <= offset + limit;

    return {
        // eslint-disable-next-line unicorn/no-null -- the `QueryPage` envelope this mirrors uses `null` for "no further page"
        continueCursor: isDone ? null : encodeRelatedCursor(offset + limit),
        isDone,
        nodes: nodes.slice(offset, offset + limit),
    };
};

export { deriveRelationEdges, findRelated, RELATED_DEFAULT_LIMIT, RELATED_DEPTH_DECAY, RELATED_MAX_DEPTH, RELATED_MAX_LIMIT };
export type { RelationGraphReader };
