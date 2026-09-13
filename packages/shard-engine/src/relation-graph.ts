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
 * **This is the only derivation of the edge set.** `@lunora/codegen` answers a
 * question the runtime cannot — whether the app declares a relation graph AT
 * ALL, the `PlatformSignals` input gating the `relationGraph` capability — but
 * it answers only that, off the static schema IR, as a boolean
 * (`schemaDeclaresRelationGraph`). It used to derive a whole parallel edge set
 * and discard everything but `.length > 0`; two derivations of one fact, pinned
 * by independent fixtures, drift silently. Codegen's own
 * `relation-graph.test.ts` now cross-pins its boolean against this function over
 * a shared fixture.
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
 * Hard ceiling on the page offset a cursor may carry.
 *
 * The offset is re-walk work, not a skip: a page at offset N makes each hop read
 * `N + limit + 1` rows, because breadth-first traversal has no ordered column to
 * seek on. So the offset IS a read-size knob, and leaving it unbounded left
 * `limit`'s ceiling trivially bypassable — cursors are unsigned base64 JSON, so
 * a forged `offset` of a billion made a shard materialise every row of up to
 * {@link RELATED_MAX_DEPTH} tables inside one request.
 *
 * 10 000 is 50 pages at {@link RELATED_MAX_LIMIT}, past any interactive paging,
 * and caps a hop's read at ~10 200 rows. Refused rather than clamped, like every
 * other bound here: a caller paging beyond it is doing something the traversal
 * is the wrong tool for.
 */
const RELATED_MAX_OFFSET = 10_000;

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

/**
 * Decode a traversal cursor back into its page offset; a malformed one is the
 * caller's mistake, not a server fault.
 *
 * The {@link RELATED_MAX_OFFSET} check is a real bound, not a sanity check: a
 * cursor is unsigned base64 JSON that any caller can write, and the offset sets
 * each hop's read size. Without it, `limit`'s refusal was bypassable by moving
 * the same number into the cursor.
 */
const decodeRelatedCursor = (cursor: string): number => {
    const [offset] = decodeCursor(cursor);

    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
        throw new LunoraError("BAD_REQUEST", "invalid cursor");
    }

    if (offset > RELATED_MAX_OFFSET) {
        throw new LunoraError(
            "BAD_REQUEST",
            `ctx.db.related: cursor offset ${String(offset)} exceeds the maximum of ${String(RELATED_MAX_OFFSET)} — narrow the walk with \`edges\` or \`direction\` instead of paging past it`,
        );
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
 * How ONE direction of an edge is walked — the four things an out-hop and an
 * in-hop disagree about, and nothing else. Everything around them (the parent
 * map, the single batched read, the dedupe, the `FrontierNode` built) is
 * identical, which is why the two used to be thirty duplicated lines.
 */
interface EdgeDirectionPlan {
    /**
     * The column on {@link EdgeDirectionPlan.table} carrying the key each row was
     * reached under: `_id` outward (the frontier already holds the target's id),
     * the foreign-key column inward (the row holds its parent's id). It is both
     * what the batched `where` filters on and what recovers a loaded row's parent.
     */
    keyColumn: (edge: RelationEdge) => string;

    /** The keys one frontier node contributes; empty when this edge does not leave that node. */
    keysOf: (node: FrontierNode, edge: RelationEdge) => ReadonlyArray<string>;

    /**
     * Whether a key already in `visited` is dropped before the read.
     *
     * Out-keys are the ids of the rows about to be LOADED, so a visited one is a
     * row the dedupe below would discard anyway — dropping it early keeps the
     * `IN (…)` list, and so the hop's budget, tight. In-keys are the ids of the
     * FRONTIER nodes being expanded from, every one of which is in `visited` by
     * definition, so the same filter would drop the whole hop.
     */
    skipVisitedKeys: boolean;

    /** The table this direction reads — also the table that labels every node it reaches. */
    table: (edge: RelationEdge) => string;
}

/**
 * The two directions, as data.
 *
 * **Array foreign keys have no in-direction.** `where` carries no
 * array-containment operator, so finding the rows whose `v.array(v.id(...))`
 * column CONTAINS an id would mean scanning the holder table and filtering in
 * memory — per node, per hop. An unbounded scan is worse than a missing hop, so
 * an array edge contributes no in-keys and is followed outward only; the docs
 * page says so too.
 */
const EDGE_DIRECTIONS: Readonly<Record<"in" | "out", EdgeDirectionPlan>> = {
    in: {
        keyColumn: (edge) => edge.column,
        keysOf: (node, edge) => (edge.array || node.table !== edge.targetTable ? [] : [node.id]),
        skipVisitedKeys: false,
        table: (edge) => edge.sourceTable,
    },
    out: {
        keyColumn: () => "_id",
        keysOf: (node, edge) => (node.table === edge.sourceTable ? outboundIds(node.document, edge) : []),
        skipVisitedKeys: true,
        table: (edge) => edge.targetTable,
    },
};

/**
 * Expand a frontier along ONE edge in one direction: out, the rows whose ids the
 * frontier's foreign-key columns hold; in, the rows whose foreign key points at
 * one of the frontier's ids.
 *
 * One batched read for the whole frontier rather than a `get` per id, so the
 * hop's cost is a function of the edge set rather than of the frontier width —
 * and so the policy filter and column mask, which only a `findMany` can carry,
 * apply to an out-hop exactly as they do to an in-hop.
 */
const expandEdge = async (
    reader: RelationGraphReader,
    frontier: ReadonlyArray<FrontierNode>,
    edge: RelationEdge,
    hop: HopContext,
    direction: "in" | "out",
): Promise<FrontierNode[]> => {
    const plan = EDGE_DIRECTIONS[direction];
    const keyColumn = plan.keyColumn(edge);
    const table = plan.table(edge);

    /** First parent to name a key owns the path to it — the shortest one, since the walk is breadth-first. */
    const parentOf = new Map<string, FrontierNode>();

    for (const node of frontier) {
        for (const key of plan.keysOf(node, edge)) {
            if (!parentOf.has(key) && !(plan.skipVisitedKeys && hop.visited.has(key))) {
                parentOf.set(key, node);
            }
        }
    }

    if (parentOf.size === 0) {
        return [];
    }

    const rows = await readHop(reader, table, { [keyColumn]: { in: [...parentOf.keys()] } }, hop);
    const reached: FrontierNode[] = [];

    for (const row of rows) {
        const id = row["_id"];
        const key = row[keyColumn];
        const parent = typeof key === "string" ? parentOf.get(key) : undefined;

        if (typeof id !== "string" || parent === undefined || hop.visited.has(id)) {
            continue;
        }

        hop.visited.add(id);
        reached.push({ document: row, id, path: [...parent.path, edge.name], pathIds: [...parent.pathIds, id], table });
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

    /** How many more nodes this hop may pull back. Read directly for the guards, so a boolean test costs no `HopContext`. */
    const remaining = (): number => options.budget - reached.length;

    const hopOf = (): HopContext => {
        return {
            limit: remaining(),
            mask: options.mask,
            relationBaseWhere: options.relationBaseWhere,
            visited: options.visited,
        };
    };

    for (const edge of edges) {
        if (options.direction !== "in" && remaining() > 0) {
            // eslint-disable-next-line no-await-in-loop -- see the docblock: `visited` must be authoritative across edges within one hop
            reached.push(...(await expandEdge(reader, frontier, edge, hopOf(), "out")));
        }

        if (options.direction !== "out" && remaining() > 0) {
            // eslint-disable-next-line no-await-in-loop -- same
            reached.push(...(await expandEdge(reader, frontier, edge, hopOf(), "in")));
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

export { deriveRelationEdges, findRelated, RELATED_DEFAULT_LIMIT, RELATED_DEPTH_DECAY, RELATED_MAX_DEPTH, RELATED_MAX_LIMIT, RELATED_MAX_OFFSET };
export type { RelationGraphReader };
