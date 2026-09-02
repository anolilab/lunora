import type { TableDefinition } from "@lunora/server";
import { defineTable, initLunora } from "@lunora/server";
import { v } from "@lunora/values";

import type { AgentRegisteredFunction } from "./component-shared";
import { AGENT_EXTENSION_KEY, asInternal, definedColumns } from "./component-shared";

/** Bare table names — auto-prefixed with the extension key at merge time. */
const ENTITIES_BARE_TABLE = "entities";
const EDGES_BARE_TABLE = "edges";

/** The physical (merged) table names the graph functions read/write. */
const ENTITIES_TABLE: "agent_entities" = `${AGENT_EXTENSION_KEY}_${ENTITIES_BARE_TABLE}`;
const EDGES_TABLE: "agent_edges" = `${AGENT_EXTENSION_KEY}_${EDGES_BARE_TABLE}`;

/**
 * The graph-memory tables, spread into the `agent` schema extension by
 * `component.ts`. Owner-scoped (keyed by `owner`, not thread) so knowledge
 * extracted in one conversation is traversable in the next, and `.public()` +
 * RLS-exempt like the thread tables (package code, access-controlled inside the
 * dispatched functions).
 *
 * Explicitly typed as a `Record` of `TableDefinition` values because it is an
 * EXPORTED const with computed (`[BARE]`) keys — under `--isolatedDeclarations`
 * (packem's `.d.ts` emit) a bare exported object literal with computed keys
 * can't have its type inferred (TS9038). The annotation erases nothing that
 * matters: the consumer (`agentExtension`) is already typed `SchemaExtension`,
 * and codegen discovers these tables at runtime.
 */
const graphTables: Record<string, TableDefinition> = {
    /**
     * Graph-memory nodes — one per normalized entity name per owner. `weight` is
     * salience, set once at insert and never updated (absolute, so replay is
     * idempotent); `firstMessageKey` is provenance. Edge weight, by contrast, is
     * bumped to `max(prior, confidence)`.
     */
    [ENTITIES_BARE_TABLE]: defineTable({
        createdAt: v.number(),
        firstMessageKey: v.optional(v.string()),
        /** Normalized (trim/collapse/lowercase) — the per-owner dedup key. */
        name: v.string(),
        owner: v.string(),
        type: v.optional(v.string()),
        updatedAt: v.number(),
        weight: v.optional(v.number()),
    })
        // Upsert dedup AND seed enumeration (prefix-scan on `owner`).
        .index("byOwnerName", ["owner", "name"], { unique: true })
        // Bounds seed enumeration to the most-recently-touched N entities
        // (see GRAPH_SEED_SCAN_CAP) instead of an unbounded owner-wide scan.
        .index("byOwnerUpdatedAt", ["owner", "updatedAt"])
        // Same RLS-exempt rationale as the thread tables (see component.ts).
        .public(),

    /**
     * Graph-memory edges — directed triples storing the normalized endpoint
     * NAMES (no join on write), owner-scoped like the nodes. `weight` is
     * confidence (last-write-wins), `messageKey` is provenance. Traversal is
     * bidirectional, so both endpoints are indexed.
     */
    [EDGES_BARE_TABLE]: defineTable({
        createdAt: v.number(),
        dstName: v.string(),
        label: v.string(),
        messageKey: v.string(),
        owner: v.string(),
        srcName: v.string(),
        updatedAt: v.number(),
        weight: v.optional(v.number()),
    })
        // Outgoing traversal.
        .index("byOwnerSrc", ["owner", "srcName"])
        // Incoming traversal (BFS is bidirectional).
        .index("byOwnerDst", ["owner", "dstName"])
        // Upsert dedup + idempotency (a replay re-writes the same triple).
        .index("byTriple", ["owner", "srcName", "label", "dstName"], { unique: true })
        // Same RLS-exempt rationale as the thread tables (see component.ts).
        .public(),
};

/**
 * Hard cap on entities/relations accepted by a single graph upsert — a
 * runaway extraction can never blow up the graph or the serialized mutation.
 */
const GRAPH_ARRAY_CAP = 64;

/** Traversal bounds — each overridable per `agentGraphTraverse` call. */
const DEFAULT_GRAPH_DEPTH = 2;
const DEFAULT_GRAPH_MAX_SEEDS = 4;
const DEFAULT_GRAPH_FAN_OUT = 8;
const DEFAULT_GRAPH_MAX_NODES = 32;

/**
 * Hard cap on the number of an owner's entities scanned for seed matching.
 * Graph memory is owner-global and accretes across every conversation, so an
 * unbounded owner-wide scan grows per-run cost linearly with lifetime entity
 * count. Instead the scan reads the `byOwnerUpdatedAt` index in DESCENDING
 * order (most-recently-touched first) and caps at this generous constant —
 * seed matching is therefore best-effort over the most-salient/most-recent N
 * entities, not the owner's entire history. Deterministic (no
 * `Date.now()`/`Math.random()`), so replay stays stable.
 */
const GRAPH_SEED_SCAN_CAP = 500;

/** Collapse internal whitespace runs to a single space. */
const WHITESPACE_RUN = /\s+/gu;
/** Split a query into word-ish tokens (letters/numbers), dropping punctuation. */
const NON_WORD = /[^\p{L}\p{N}]+/u;

/**
 * The per-owner dedup key for an entity name: trim, collapse internal
 * whitespace, lowercase. Deterministic (no locale) so a workflow replay or
 * retry writes the exact same key — the graph upsert stays idempotent.
 * @experimental
 */
const normalizeEntityName = (name: string): string => name.trim().replaceAll(WHITESPACE_RUN, " ").toLowerCase();

/**
 * Split a free-text query into lowercase tokens of at least two characters —
 * the seed matcher for traversal. One-character tokens are dropped as noise.
 */
const tokenizeQuery = (text: string): string[] =>
    text
        .toLowerCase()
        .split(NON_WORD)
        .filter((token) => token.length >= 2);

/** A directed edge projected from a stored row — only the traversal-relevant fields. */
interface GraphEdge {
    dstName: string;
    label: string;
    srcName: string;
    weight: number;
}

/** Project a stored edge row into a `GraphEdge` (absent weight defaults to 1). */
const toGraphEdge = (row: Record<string, unknown>): GraphEdge => {
    return {
        dstName: row["dstName"] as string,
        label: row["label"] as string,
        srcName: row["srcName"] as string,
        weight: (row["weight"] as number | undefined) ?? 1,
    };
};

/**
 * Deterministic edge ordering: heavier (more-confident) edges first, then a
 * stable lexical tiebreak on the triple, so traversal output never depends on
 * storage or scan order (replay-stable).
 */
const compareEdgesByWeight = (a: GraphEdge, b: GraphEdge): number =>
    b.weight - a.weight || a.label.localeCompare(b.label) || a.srcName.localeCompare(b.srcName) || a.dstName.localeCompare(b.dstName);

/**
 * Does a normalized entity name match a query token? Substring both ways, so
 * "acme" matches "acme corp" and "corp" matches "corp" — a cheap,
 * paraphrase-tolerant seed match (a vector seeder is a deferred follow-up).
 */
const matchesSeed = (entityName: string, tokens: string[]): boolean => tokens.some((token) => entityName.includes(token) || token.includes(entityName));

/**
 * Render traversed edges into deterministic, compact triple lines
 * (`- src —[label]→ dst`), sorted for replay stability. Empty in → empty out.
 */
const renderTriples = (edges: GraphEdge[]): string =>
    edges
        .map((edge) => `- ${edge.srcName} —[${edge.label}]→ ${edge.dstName}`)
        .toSorted((a, b) => a.localeCompare(b))
        .join("\n");

/** Traversal bounds resolved from the query args (defaults applied). */
interface GraphBounds {
    depth: number;
    fanOut: number;
    maxNodes: number;
}

/** BFS accumulator threaded through the traversal (kept out of the loop body). */
interface TraverseAccumulator {
    collected: GraphEdge[];
    collectedKeys: Set<string>;
    next: string[];
    seen: Set<string>;
}

/** NUL-delimited triple identity — dedups edges collected from both directions. */
const edgeKey = (edge: GraphEdge): string => `${edge.srcName}\u0000${edge.label}\u0000${edge.dstName}`;

/**
 * Record one incident edge and enqueue its far endpoint (once, under the node
 * budget). Extracted from the BFS body to keep the loop's complexity flat.
 */
const addEdge = (edge: GraphEdge, from: string, bounds: GraphBounds, accumulator: TraverseAccumulator): void => {
    const key = edgeKey(edge);

    if (!accumulator.collectedKeys.has(key)) {
        accumulator.collectedKeys.add(key);
        accumulator.collected.push(edge);
    }

    const neighbor = edge.srcName === from ? edge.dstName : edge.srcName;

    if (!accumulator.seen.has(neighbor) && accumulator.seen.size < bounds.maxNodes) {
        accumulator.seen.add(neighbor);
        accumulator.next.push(neighbor);
    }
};

/**
 * Bounded bidirectional breadth-first traversal over the owner's graph. Reads
 * are injected via `edgesFrom` (so the same BFS runs over DO `ctx.db` and the
 * in-memory test double); the traversal is deterministic — per-node edges are
 * ranked by weight and capped at `fanOut`, growth is capped at `maxNodes`, and
 * depth at `bounds.depth`. No `Date.now`/random → replay-stable.
 */
const traverseGraph = async (edgesFrom: (node: string) => Promise<GraphEdge[]>, seeds: string[], bounds: GraphBounds): Promise<GraphEdge[]> => {
    const accumulator: TraverseAccumulator = { collected: [], collectedKeys: new Set(), next: [], seen: new Set(seeds) };
    let frontier = seeds.slice(0, bounds.maxNodes);

    for (let depth = 0; depth < bounds.depth && frontier.length > 0; depth += 1) {
        accumulator.next = [];

        for (const node of frontier) {
            // eslint-disable-next-line no-await-in-loop -- BFS levels are sequential by nature; each depends on the last.
            const nodeEdges = await edgesFrom(node);
            const incident = nodeEdges.toSorted(compareEdgesByWeight).slice(0, bounds.fanOut);

            for (const edge of incident) {
                addEdge(edge, node, bounds, accumulator);
            }
        }

        frontier = accumulator.next;
    }

    return accumulator.collected;
};

// The graph functions are built with the base procedure builders (no generated
// server inside a package), same as the thread functions in component.ts.
const { mutation, query } = initLunora.dataModel().create();

/** The two internal graph-memory functions the durable loop dispatches to. */
interface GraphComponentFunctions {
    agentGraphTraverse: AgentRegisteredFunction;
    agentGraphUpsert: AgentRegisteredFunction;
}

/**
 * Build the graph-memory tier's registered functions — the owner-scoped write
 * (`agentGraphUpsert`) and bounded traversal read (`agentGraphTraverse`). Both
 * are INTERNAL (loop-dispatched: the run-end extract step writes, the
 * per-run traverse step reads) and folded into `agentComponent().functions` so
 * codegen auto-registers them under `agents:*`.
 */
const graphComponent = (): GraphComponentFunctions => {
    /**
     * Graph-memory WRITE (internal mutation). The run-end extraction step
     * dispatches this with the entities/relations the model pulled from the
     * turn. Owner-scoped (the graph tier persists across the user's threads).
     *
     * Idempotent under workflow replay/retry: every write is an absolute set,
     * never an increment — a re-dispatched extraction converges on the same
     * graph. Names/labels are normalized to the per-owner dedup key; empty
     * names and self-loops carry no signal and are dropped; arrays are hard-
     * capped so a runaway extraction can't blow up the serialized mutation.
     */
    const agentGraphUpsert = mutation
        .input({
            entities: v.array(v.object({ name: v.string(), type: v.optional(v.string()) })),
            messageKey: v.string(),
            owner: v.string(),
            relations: v.array(v.object({ confidence: v.optional(v.number()), dst: v.string(), label: v.string(), src: v.string() })),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ entities: number; relations: number }> => {
            const now = Date.now();

            // Upsert one node: insert (weight 1) or patch a newly-known type.
            // Absolute set, never increment → replay/retry converges. Returns
            // the normalized name, or undefined when the name is empty.
            const upsertEntity = async (rawName: string, type?: string): Promise<string | undefined> => {
                const name = normalizeEntityName(rawName);

                if (name.length === 0) {
                    return undefined;
                }

                const existing = await context.db
                    .query(ENTITIES_TABLE)
                    .withIndex("byOwnerName", (q) => q.eq("owner", args.owner).eq("name", name))
                    .first();

                if (existing) {
                    if (type !== undefined && existing["type"] === undefined) {
                        await context.db.patch(existing["_id"] as never, { type, updatedAt: now });
                    }

                    return name;
                }

                await context.db.insert(ENTITIES_TABLE, {
                    createdAt: now,
                    name,
                    owner: args.owner,
                    updatedAt: now,
                    weight: 1,
                    ...definedColumns({ firstMessageKey: args.messageKey, type }),
                });

                return name;
            };

            // Upsert one triple: ensure both endpoints exist (no dangling edge),
            // then insert or bump `weight = max(prior, confidence)`. Returns
            // false for a dropped (empty/self-loop) relation.
            const upsertRelation = async (relation: { confidence?: number; dst: string; label: string; src: string }): Promise<boolean> => {
                const sourceName = normalizeEntityName(relation.src);
                const destinationName = normalizeEntityName(relation.dst);
                const label = normalizeEntityName(relation.label);

                if (sourceName.length === 0 || destinationName.length === 0 || label.length === 0 || sourceName === destinationName) {
                    return false;
                }

                await upsertEntity(sourceName);
                await upsertEntity(destinationName);

                const confidence = relation.confidence ?? 1;
                const existing = await context.db
                    .query(EDGES_TABLE)
                    .withIndex("byTriple", (q) => q.eq("owner", args.owner).eq("srcName", sourceName).eq("label", label).eq("dstName", destinationName))
                    .first();

                if (existing) {
                    const priorWeight = (existing["weight"] as number | undefined) ?? 1;

                    await context.db.patch(existing["_id"] as never, { updatedAt: now, weight: Math.max(priorWeight, confidence) });
                } else {
                    await context.db.insert(EDGES_TABLE, {
                        createdAt: now,
                        dstName: destinationName,
                        label,
                        messageKey: args.messageKey,
                        owner: args.owner,
                        srcName: sourceName,
                        updatedAt: now,
                        weight: confidence,
                    });
                }

                return true;
            };

            let entities = 0;

            for (const entity of args.entities.slice(0, GRAPH_ARRAY_CAP)) {
                // eslint-disable-next-line no-await-in-loop -- serialized mutation; upserts must be sequential for dedup.
                if ((await upsertEntity(entity.name, entity.type)) !== undefined) {
                    entities += 1;
                }
            }

            let relations = 0;

            for (const relation of args.relations.slice(0, GRAPH_ARRAY_CAP)) {
                // eslint-disable-next-line no-await-in-loop -- serialized mutation; upserts must be sequential for dedup.
                if (await upsertRelation(relation)) {
                    relations += 1;
                }
            }

            return { entities, relations };
        });

    /**
     * Graph-memory READ (internal query — queries are dispatchable via `run`,
     * like `agentState`). Bounded JS breadth-first traversal of the owner's
     * graph seeded from the query text, rendered into compact triple lines for
     * injection. Owner-scoped; deterministic; returns `{ context: "" }` when
     * there are no tokens or no seeds (the loop's non-empty guard drops it).
     */
    const agentGraphTraverse = query
        .input({
            depth: v.optional(v.number()),
            fanOut: v.optional(v.number()),
            maxNodes: v.optional(v.number()),
            maxSeeds: v.optional(v.number()),
            owner: v.string(),
            query: v.string(),
        })
        .query(async ({ args, ctx: context }): Promise<{ context: string }> => {
            const tokens = tokenizeQuery(args.query);

            if (tokens.length === 0) {
                return { context: "" };
            }

            // Seed enumeration: scan at most GRAPH_SEED_SCAN_CAP of the owner's
            // most-recently-touched entities (via `byOwnerUpdatedAt`, descending
            // — a bounded DB read, not a `.collect()` of the owner's entire
            // lifetime entity set), keep those whose normalized name matches a
            // query token, rank by salience (weight) then name, and cap at
            // maxSeeds. Best-effort: an entity older/less-recent than the
            // scan cap won't seed a traversal.
            const ownerEntities = await context.db
                .query(ENTITIES_TABLE)
                .withIndex("byOwnerUpdatedAt", (q) => q.eq("owner", args.owner))
                .order("desc")
                .take(GRAPH_SEED_SCAN_CAP);

            const seeds = ownerEntities
                .filter((row) => matchesSeed(row["name"] as string, tokens))
                .toSorted(
                    (a, b) =>
                        ((b["weight"] as number | undefined) ?? 1) - ((a["weight"] as number | undefined) ?? 1) ||
                        (a["name"] as string).localeCompare(b["name"] as string),
                )
                .slice(0, args.maxSeeds ?? DEFAULT_GRAPH_MAX_SEEDS)
                .map((row) => row["name"] as string);

            if (seeds.length === 0) {
                return { context: "" };
            }

            // Both directions — traversal is bidirectional (see the edge table).
            const edgesFrom = async (node: string): Promise<GraphEdge[]> => {
                const [outgoing, incoming] = await Promise.all([
                    context.db
                        .query(EDGES_TABLE)
                        .withIndex("byOwnerSrc", (q) => q.eq("owner", args.owner).eq("srcName", node))
                        .collect(),
                    context.db
                        .query(EDGES_TABLE)
                        .withIndex("byOwnerDst", (q) => q.eq("owner", args.owner).eq("dstName", node))
                        .collect(),
                ]);

                return [...outgoing, ...incoming].map((row) => toGraphEdge(row));
            };

            const edges = await traverseGraph(edgesFrom, seeds, {
                depth: args.depth ?? DEFAULT_GRAPH_DEPTH,
                fanOut: args.fanOut ?? DEFAULT_GRAPH_FAN_OUT,
                maxNodes: args.maxNodes ?? DEFAULT_GRAPH_MAX_NODES,
            });

            return { context: renderTriples(edges) };
        });

    return {
        agentGraphTraverse: asInternal(agentGraphTraverse),
        agentGraphUpsert: asInternal(agentGraphUpsert),
    };
};

export type { GraphComponentFunctions };
export { graphComponent, graphTables, normalizeEntityName };
