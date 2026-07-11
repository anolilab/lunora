import { LunoraError } from "@lunora/errors";
import type { SchemaExtension } from "@lunora/server";
import { defineSchemaExtension, defineTable, initLunora } from "@lunora/server";
import { v } from "@lunora/values";

const AGENT_EXTENSION_KEY = "agent";

/** Bare table names — auto-prefixed with the extension key at merge time. */
const THREADS_BARE_TABLE = "threads";
const MESSAGES_BARE_TABLE = "messages";
const ENTITIES_BARE_TABLE = "entities";
const EDGES_BARE_TABLE = "edges";

/** The physical (merged) table names the runtime functions read/write. */
const THREADS_TABLE: "agent_threads" = `${AGENT_EXTENSION_KEY}_${THREADS_BARE_TABLE}`;
const MESSAGES_TABLE: "agent_messages" = `${AGENT_EXTENSION_KEY}_${MESSAGES_BARE_TABLE}`;
const ENTITIES_TABLE: "agent_entities" = `${AGENT_EXTENSION_KEY}_${ENTITIES_BARE_TABLE}`;
const EDGES_TABLE: "agent_edges" = `${AGENT_EXTENSION_KEY}_${EDGES_BARE_TABLE}`;

/**
 * The agent thread tables, shipped as a schema extension so an app merges
 * them with one call and they can never collide with app tables:
 *
 * ```ts
 * // lunora/schema.ts
 * export default defineSchema({ ... }).extend(agentExtension);
 * ```
 *
 * Message ordering follows the Convex-agent model: `seq` is the monotonic
 * per-thread position (allocated from the thread's `messageCount` counter, so
 * allocation is O(1) inside the serialized mutation), and `messageKey` is the
 * deterministic idempotency key — a workflow replay that re-persists the same
 * message is a no-op instead of a duplicate.
 */
const agentExtension: SchemaExtension = defineSchemaExtension(AGENT_EXTENSION_KEY, {
    tables: {
        [MESSAGES_BARE_TABLE]: defineTable({
            content: v.string(),
            createdAt: v.number(),
            messageKey: v.string(),
            role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"), v.literal("system")),
            seq: v.number(),

            /**
             * Human-in-the-loop approval marker: `"awaiting_approval"` on the
             * placeholder written while a run pauses on a gated tool, then
             * `"approved"`/`"rejected"` on the tool result once resolved. Optional
             * so ordinary messages (and pre-existing rows) are unaffected.
             */
            status: v.optional(v.union(v.literal("awaiting_approval"), v.literal("approved"), v.literal("rejected"))),
            stepName: v.optional(v.string()),
            threadKey: v.string(),
            toolCallId: v.optional(v.string()),
            toolCalls: v.optional(v.array(v.object({ id: v.string(), input: v.any(), name: v.string() }))),
            toolName: v.optional(v.string()),
        })
            // Drives the ordered thread read (the live subscription).
            .index("byThread", ["threadKey", "seq"])
            // Drives the idempotent-persist lookup; unique = the dedup guarantee.
            .index("byMessageKey", ["threadKey", "messageKey"], { unique: true })
            // See the threads table for why the agent tables are `.public()`.
            .public(),
        [THREADS_BARE_TABLE]: defineTable({
            agent: v.string(),
            createdAt: v.number(),
            error: v.optional(v.string()),

            /**
             * The workflow instance id of the run that currently owns this
             * thread. The concurrency guard compares it to a starting run's own
             * instance id — a match is a replay (allow), a mismatch while
             * `status === "running"` is a genuine second run (apply
             * `onConcurrentRun`). Also the target for `cancel`/`replace`. Optional
             * so pre-existing threads (written before this column) are unaffected.
             */
            instanceId: v.optional(v.string()),
            key: v.string(),
            // Next message seq — incremented on every append (see above).
            messageCount: v.number(),

            /**
             * Verified identity of the thread owner (pass `ctx.auth.userId`
             * when starting a run). When set, the public queries only answer
             * for a caller with that identity; when absent the thread is
             * readable by anyone who knows its key (single-tenant/anonymous
             * apps). First writer wins — a later run may not change it.
             */
            owner: v.optional(v.string()),

            /**
             * The thread's synced agent state — a JSON object written by the
             * internal `agentSetState` mutation (absolute REPLACE) and read by the
             * public `agentState` query (`ctx.getState` / `useAgentState`). Seeded
             * from `defineAgent({ initialState })` on thread creation. Optional so
             * agent-free apps and pre-existing threads (written before this column)
             * are unaffected.
             */
            state: v.optional(v.any()),
            status: v.union(v.literal("idle"), v.literal("running"), v.literal("error"), v.literal("cancelled"), v.literal("awaiting_input")),
            title: v.optional(v.string()),
            updatedAt: v.number(),

            /**
             * Cumulative token usage for the latest run on this thread, patched
             * at run end. Optional so agent-free apps and pre-existing threads
             * (written before this column existed) are unaffected.
             */
            usage: v.optional(v.object({ inputTokens: v.optional(v.number()), outputTokens: v.optional(v.number()), totalTokens: v.optional(v.number()) })),
        })
            .index("byKey", ["key"], { unique: true })
            .index("byAgent", ["agent"])
            // Targets a thread by the workflow instance that owns it — the
            // lookup `cancel` uses to mark the right thread cancelled.
            .index("byInstance", ["instanceId"])
            // RLS-exempt on purpose: under `.rls("required")` these tables are
            // written by the workflow's dispatched internal mutations and read
            // by the public queries, none of which can engage app RLS policies
            // (they're package code auto-registered by codegen). Access control
            // is enforced IN the functions instead — owner-scoped reads above,
            // internal-only writes.
            .public(),

        /**
         * Graph-memory nodes — one per normalized entity name per owner. The
         * graph tier is OWNER-scoped (not thread-scoped): a node keyed by
         * `owner` persists across every thread of that user, so knowledge
         * extracted in one conversation is traversable in the next. `weight` is
         * salience (last-write-wins, absolute set → replay-idempotent),
         * `firstMessageKey` is provenance.
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
            // Same RLS-exempt rationale as the thread tables (see above).
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
            // Same RLS-exempt rationale as the thread tables (see above).
            .public(),
    },
});

// The runtime functions are built with the base procedure builders (no
// generated server inside a package), same as the presence component.
const { mutation, query } = initLunora.dataModel().create();

/** Stamp a registered function internal — server-side callable only. */
const asInternal = <T>(function_: T): T => {
    return { ...function_, visibility: "internal" };
};

/**
 * Drop the `undefined`-valued keys from an optional-column bag so a
 * `defineTable` insert never writes an explicit `undefined` (which the
 * validators reject) — the spread-and-omit pattern for `owner`/`title`/
 * `instanceId`/`state`, hoisted out of the insert to keep the handler's
 * cyclomatic complexity flat as more optional columns are added.
 */
const definedColumns = (columns: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(columns)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }

    return result;
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

/** Collapse internal whitespace runs to a single space. */
const WHITESPACE_RUN = /\s+/gu;
/** Split a query into word-ish tokens (letters/numbers), dropping punctuation. */
const NON_WORD = /[^\p{L}\p{N}]+/u;

/**
 * The per-owner dedup key for an entity name: trim, collapse internal
 * whitespace, lowercase. Deterministic (no locale) so a workflow replay or
 * retry writes the exact same key — the graph upsert stays idempotent.
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

/**
 * Loose structural view of a registered Lunora function — wide enough for any
 * concrete `RegisteredMutation`/`RegisteredQuery` (whose precise validator-map
 * generics make them invariant), narrow enough for re-export, dispatch, and
 * tests. Codegen registers the runtime value; it never needs the generics.
 */
export interface AgentRegisteredFunction {
    readonly args: unknown;
    readonly handler: (context: unknown, args: never) => unknown;
    readonly kind: "mutation" | "query";
    readonly visibility?: "internal" | "public";
}

export interface AgentComponent {
    extension: SchemaExtension;
    functions: {
        agentAppendMessage: AgentRegisteredFunction;
        agentEnsureThread: AgentRegisteredFunction;
        agentGraphTraverse: AgentRegisteredFunction;
        agentGraphUpsert: AgentRegisteredFunction;
        agentMessages: AgentRegisteredFunction;
        agentPatchThread: AgentRegisteredFunction;
        agentResolveApproval: AgentRegisteredFunction;
        agentRun: AgentRegisteredFunction;
        agentSetState: AgentRegisteredFunction;
        agentState: AgentRegisteredFunction;
        agentThread: AgentRegisteredFunction;
    };
}

/**
 * Build the agent runtime component: the thread schema extension plus the
 * functions the durable loop dispatches to (and the client subscribes to).
 * Codegen auto-registers them under the `agents:*` namespace whenever
 * `lunora/agents.ts` declares an agent — the loop's dispatch paths assume
 * that namespace, and apps never re-export these by hand.
 *
 * Most mutations are **internal** (only the workflow's admin-authenticated
 * dispatch may call them); the queries are public so a client can subscribe
 * to `agents:agentMessages` for a live thread view. Two mutations are public:
 * `agentResolveApproval` (a client resolves a HITL approval) and `agentRun`
 * (an HTTP client starts a durable run) — both owner-gated.
 */
export const agentComponent = (): AgentComponent => {
    const agentEnsureThread = mutation
        .input({
            agent: v.string(),
            // Seed the thread's synced state — set on the INSERT branch only
            // (first writer wins, like owner/title), so a replay never re-seeds.
            initialState: v.optional(v.any()),
            instanceId: v.optional(v.string()),
            key: v.string(),
            onConcurrentRun: v.optional(v.union(v.literal("reject"), v.literal("queue"), v.literal("replace"))),
            owner: v.optional(v.string()),
            title: v.optional(v.string()),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ created: boolean; priorInstanceId?: string; replaced?: boolean }> => {
            const now = Date.now();
            const existing = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.key))
                .first();

            if (existing) {
                // The owner is immutable: a run started for a different
                // identity must not attach its messages to (or reopen) someone
                // else's thread. `undefined` continues an ownerless thread.
                if (existing["owner"] !== args.owner && args.owner !== undefined) {
                    throw new Error(`@lunora/agent: thread "${args.key}" belongs to another owner`);
                }

                // Concurrency guard: a thread already owned by a DIFFERENT
                // workflow instance is a genuine second run — the two would
                // interleave their messages on the shared seq counter. "running"
                // and "awaiting_input" both mean the prior instance is alive: the
                // latter is a HITL pause hibernating on step.waitForEvent, which
                // still owns the thread and will resume. A matching (or absent,
                // pre-column) instance id is a REPLAY of the same run, which must
                // be allowed. Only a known, differing instance id trips the policy.
                const priorInstanceId = existing["instanceId"] as string | undefined;
                const isConcurrentRun =
                    (existing["status"] === "running" || existing["status"] === "awaiting_input") &&
                    priorInstanceId !== undefined &&
                    args.instanceId !== undefined &&
                    priorInstanceId !== args.instanceId;

                if (isConcurrentRun) {
                    const policy = args.onConcurrentRun ?? "reject";

                    // "queue" has no durable queue yet — degrade to reject rather
                    // than silently interleave (tracked as a follow-up).
                    if (policy !== "replace") {
                        throw new LunoraError(
                            "CONFLICT",
                            `@lunora/agent: thread "${args.key}" already has a run in flight (instance "${priorInstanceId}") — onConcurrentRun="${policy}"`,
                        );
                    }

                    // Replace: take the thread over now (the caller terminates the
                    // prior instance) so the next append is attributed to this run.
                    await context.db.patch(existing["_id"] as never, { error: undefined, instanceId: args.instanceId, status: "running", updatedAt: now });

                    return { created: false, priorInstanceId, replaced: true };
                }

                // Replay (same instance) or a resumed idle/errored/cancelled
                // thread: resetting status/error to "running" is idempotent and
                // correct, since (re)starting means the run IS active again. The
                // instance id is (re)stamped so cancel/replace can target it.
                await context.db.patch(existing["_id"] as never, {
                    error: undefined,
                    status: "running",
                    updatedAt: now,
                    ...(args.instanceId === undefined ? {} : { instanceId: args.instanceId }),
                });

                return { created: false };
            }

            await context.db.insert(THREADS_TABLE, {
                agent: args.agent,
                createdAt: now,
                key: args.key,
                messageCount: 0,
                status: "running",
                updatedAt: now,
                ...definedColumns({ instanceId: args.instanceId, owner: args.owner, state: args.initialState, title: args.title }),
            });

            return { created: true };
        });

    const agentAppendMessage = mutation
        .input({
            content: v.string(),
            messageKey: v.string(),
            role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"), v.literal("system")),
            status: v.optional(v.union(v.literal("awaiting_approval"), v.literal("approved"), v.literal("rejected"))),
            stepName: v.optional(v.string()),
            threadKey: v.string(),
            toolCallId: v.optional(v.string()),
            toolCalls: v.optional(v.array(v.object({ id: v.string(), input: v.any(), name: v.string() }))),
            toolName: v.optional(v.string()),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ seq: number }> => {
            // Idempotent by (threadKey, messageKey): a replayed persist returns
            // the recorded position instead of duplicating the row.
            const existing = await context.db
                .query(MESSAGES_TABLE)
                .withIndex("byMessageKey", (q) => q.eq("threadKey", args.threadKey).eq("messageKey", args.messageKey))
                .first();

            if (existing) {
                return { seq: existing["seq"] as number };
            }

            const thread = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.threadKey))
                .first();

            if (!thread) {
                throw new Error(`@lunora/agent: cannot append to unknown thread "${args.threadKey}" — run agentEnsureThread first`);
            }

            const seq = thread["messageCount"] as number;
            const now = Date.now();

            await context.db.insert(MESSAGES_TABLE, {
                content: args.content,
                createdAt: now,
                messageKey: args.messageKey,
                role: args.role,
                seq,
                threadKey: args.threadKey,
                ...(args.status === undefined ? {} : { status: args.status }),
                ...(args.stepName === undefined ? {} : { stepName: args.stepName }),
                ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
                ...(args.toolCalls === undefined ? {} : { toolCalls: args.toolCalls }),
                ...(args.toolName === undefined ? {} : { toolName: args.toolName }),
            });
            await context.db.patch(thread["_id"] as never, { messageCount: seq + 1, updatedAt: now });

            return { seq };
        });

    const agentPatchThread = mutation
        .input({
            error: v.optional(v.string()),
            // Target by thread key (the loop) OR by workflow instance id (cancel,
            // which only knows the instance it terminated). Exactly one is set.
            instanceId: v.optional(v.string()),
            key: v.optional(v.string()),
            status: v.optional(v.union(v.literal("idle"), v.literal("running"), v.literal("error"), v.literal("cancelled"), v.literal("awaiting_input"))),
            title: v.optional(v.string()),
            usage: v.optional(v.object({ inputTokens: v.optional(v.number()), outputTokens: v.optional(v.number()), totalTokens: v.optional(v.number()) })),
        })
        .mutation(async ({ args, ctx: context }): Promise<void> => {
            const { instanceId, key } = args;
            let thread: Record<string, unknown> | null | undefined;

            if (key !== undefined) {
                thread = await context.db
                    .query(THREADS_TABLE)
                    .withIndex("byKey", (q) => q.eq("key", key))
                    .first();
            } else if (instanceId !== undefined) {
                thread = await context.db
                    .query(THREADS_TABLE)
                    .withIndex("byInstance", (q) => q.eq("instanceId", instanceId))
                    .first();
            }

            if (!thread) {
                return;
            }

            await context.db.patch(thread["_id"] as never, {
                updatedAt: Date.now(),
                ...(args.error === undefined ? {} : { error: args.error }),
                ...(args.status === undefined ? {} : { status: args.status }),
                ...(args.title === undefined ? {} : { title: args.title }),
                // The loop patches a per-run cumulative total; setting it (rather
                // than adding) keeps the write idempotent under workflow replay.
                ...(args.usage === undefined ? {} : { usage: args.usage }),
            });
        });

    /**
     * Replace the thread's synced state (the `ctx.setState` target). INTERNAL —
     * only the workflow's admin-dispatch may call it, from inside a tool's
     * memoized durable step. Absolute set (whole-object REPLACE), so a step-retry
     * that re-applies the same value is a no-op — idempotent under workflow
     * replay, mirroring `agentPatchThread`'s usage semantics. No-op when the
     * thread is missing.
     */
    const agentSetState = mutation
        .input({
            key: v.string(),
            state: v.any(),
        })
        .mutation(async ({ args, ctx: context }): Promise<void> => {
            const thread = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.key))
                .first();

            if (!thread) {
                return;
            }

            await context.db.patch(thread["_id"] as never, { state: args.state, updatedAt: Date.now() });
        });

    /**
     * Owner gate for the public reads: an owned thread only answers for a
     * caller whose verified identity matches; an ownerless thread is open (the
     * app chose no identity). A mismatch is indistinguishable from a missing
     * thread, so key-guessing leaks nothing — not even existence.
     */
    const readableThread = (thread: Record<string, unknown> | null, auth: { userId?: string | null }): Record<string, unknown> | undefined => {
        if (!thread) {
            return undefined;
        }

        const { owner } = thread as { owner?: string };

        if (owner !== undefined && owner !== (auth.userId ?? undefined)) {
            return undefined;
        }

        return thread;
    };

    // KEEP IN SYNC: the arg/return TYPES of the two public queries below are
    // mirrored by hand into codegen's `syntheticAgentApiFunctions` (emit.ts) —
    // codegen cannot statically read this package's types, and only the arg
    // key sets are drift-tested. Changing an input or return shape here means
    // updating the emitted `api.agents.*` reference types there too.
    const agentThread = query.input({ key: v.string() }).query(async ({ args, ctx: context }): Promise<Record<string, unknown> | undefined> => {
        const thread = await context.db
            .query(THREADS_TABLE)
            .withIndex("byKey", (q) => q.eq("key", args.key))
            .first();

        return readableThread(thread, context.auth);
    });

    // The live synced-state view: subscribe to `agents:agentState` (via
    // `useAgentState`) and every `setState` streams the fresh state object over
    // the existing reactive transport. A dedicated query (rather than reading
    // `thread.state` off `agentThread`) so the per-socket JSON memo suppresses a
    // push unless the STATE actually changed — not on every status/usage flip.
    // Same owner gate as agentThread; returns `undefined` when unknown/forbidden
    // or before any state was seeded.
    const agentState = query.input({ key: v.string() }).query(async ({ args, ctx: context }): Promise<Record<string, unknown> | undefined> => {
        const thread = await context.db
            .query(THREADS_TABLE)
            .withIndex("byKey", (q) => q.eq("key", args.key))
            .first();

        return readableThread(thread, context.auth)?.["state"] as Record<string, unknown> | undefined;
    });

    // The live thread view: subscribe to `agents:agentMessages` and every
    // append (user turn, tool call, tool result, assistant reply) streams to
    // the client over the existing reactive-subscription transport.
    const agentMessages = query
        .input({ key: v.string(), limit: v.optional(v.number()) })
        .query(async ({ args, ctx: context }): Promise<Record<string, unknown>[]> => {
            const thread = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.key))
                .first();

            // Same gate as agentThread: an owned thread's history only answers
            // for its owner; unknown and forbidden are both the empty thread.
            if (readableThread(thread, context.auth) === undefined) {
                return [];
            }

            const rows = await context.db
                .query(MESSAGES_TABLE)
                .withIndex("byThread", (q) => q.eq("threadKey", args.key))
                .collect();

            const ordered = rows.toSorted((a, b) => (a["seq"] as number) - (b["seq"] as number));

            // A limit keeps the newest N (the tail of the conversation).
            return args.limit === undefined ? ordered : ordered.slice(Math.max(0, ordered.length - args.limit));
        });

    /**
     * Resolve a human-in-the-loop tool approval: deliver the client's
     * approve/reject decision to the paused run so its `waitForEvent` resumes.
     * PUBLIC (a client calls it) but OWNER-GATED — the same `readableThread`
     * gate as the reads, so only the thread's owner may approve. The AGENT_*
     * workflow binding is reached via `ctx.agents` (woven onto the function-run
     * ctx by generated code); the mutation ctx has no raw `env`.
     */
    const agentResolveApproval = mutation
        .input({
            decision: v.union(v.literal("approve"), v.literal("reject")),
            instanceId: v.string(),
            note: v.optional(v.string()),
            threadKey: v.string(),
            toolCallId: v.string(),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ resolved: boolean }> => {
            const thread = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.threadKey))
                .first();

            const readable = readableThread(thread, context.auth);

            if (readable === undefined) {
                // Unknown and forbidden are indistinguishable — key-guessing leaks nothing.
                throw new LunoraError("FORBIDDEN", `@lunora/agent: not allowed to resolve approvals on thread "${args.threadKey}"`);
            }

            const agentName = readable["agent"] as string;
            const { agents } = context as { agents?: Record<string, { sendEvent?: (id: string, event: { payload: unknown; type: string }) => Promise<void> }> };
            const handle = agents?.[agentName];

            if (typeof handle?.sendEvent !== "function") {
                throw new LunoraError(
                    "INTERNAL",
                    `@lunora/agent: no ctx.agents["${agentName}"] producer to resolve the approval — run codegen/dev so the agent binding is wired`,
                );
            }

            await handle.sendEvent(args.instanceId, {
                payload: { decision: args.decision, ...(args.note === undefined ? {} : { note: args.note }) },
                type: "agent-approval",
            });

            return { resolved: true };
        });

    /**
     * Start a durable agent run. PUBLIC (owner-gated) — the only HTTP-reachable
     * way to begin a run, so an external client (e.g. the `@lunora/mcp` server,
     * which fronts agents over RPC) can invoke `ctx.agents.&lt;name>.run` without
     * app code. Internal functions are unreachable over client RPC, so this must
     * NOT be `asInternal(...)`; the security boundary is the per-agent
     * `publicRun` opt-in and owner-scoping here (NOT the MCP-side `allowAgents`
     * gate, which only controls what that separate process advertises).
     *
     * Per-agent capability gate (fail-closed): a run over this PUBLIC boundary is
     * a privileged side effect (LLM cost, powerful tools), so an agent is
     * reachable here ONLY when its author opted in with
     * `defineAgent({ publicRun: true })`. Without the opt-in an `agentRun` caller
     * could start ANY declared agent regardless of MCP configuration; the flag
     * restores the app-author chokepoint that `ctx.agents.&lt;name>.run`
     * (server-side app code) has always been — that programmatic path is
     * unaffected, it never routes through this gate.
     *
     * Deterministic: `threadKey` is REQUIRED and supplied by the caller — the
     * mutation never mints an id (no `crypto.randomUUID`/`Date.now`), so a
     * retry/replay reuses the same thread. It is also idempotent under RPC retry:
     * a call for a thread that already has a run in flight returns the in-flight
     * instance instead of starting a SECOND run (which under
     * `onConcurrentRun:"replace"` would terminate the original). The run itself
     * starts a workflow via the `ctx.agents` binding (woven onto the ctx by
     * generated code), mirroring how `agentResolveApproval` reaches the binding.
     */
    const agentRun = mutation
        .input({
            agent: v.string(),
            input: v.string(),
            threadKey: v.string(),
            title: v.optional(v.string()),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ id: string; threadKey: string }> => {
            const { agents } = context as {
                agents?: Record<
                    string,
                    { publicRun?: boolean; run?: (input: { input: string; owner?: string; threadKey: string; title?: string }) => Promise<{ id: string }> }
                >;
            };
            const handle = agents?.[args.agent];

            if (typeof handle?.run !== "function") {
                throw new LunoraError(
                    "INTERNAL",
                    `@lunora/agent: no ctx.agents["${args.agent}"] producer to start a run — run codegen/dev so the agent binding is wired, and check the agent name`,
                );
            }

            // Fail-closed per-agent gate — see the doc comment. Only an agent
            // explicitly marked `publicRun: true` may be started over the public
            // RPC boundary; every other agent is refused, so declaring an agent
            // never exposes it to arbitrary clients.
            if (handle.publicRun !== true) {
                throw new LunoraError(
                    "FORBIDDEN",
                    `@lunora/agent: agent "${args.agent}" is not enabled for public runs — set defineAgent({ publicRun: true }) to allow an external client (e.g. the @lunora/mcp server) to start it`,
                );
            }

            // Owner-scope the thread to the caller's verified identity (see the
            // owner column on the threads table). A token that resolves to no
            // identity leaves the thread ownerless/open (single-tenant/anonymous).
            const owner = context.auth.userId ?? undefined;

            // Idempotent start: if a run is already in flight for this thread — a
            // retried agentRun (an offline-queue replay or an HTTP retry after a
            // lost ack) — return the in-flight instance instead of starting a
            // SECOND run, which under `onConcurrentRun:"replace"` would terminate
            // the original. A finished (idle/error/cancelled) thread is NOT
            // deduped, so reusing the threadKey to continue a conversation still
            // starts a fresh run. Only dedupe when the caller may attach (owner
            // matches or the thread is ownerless). A retry that races the
            // not-yet-written thread row falls through to `handle.run` — the
            // `agentEnsureThread` concurrency guard is the backstop there.
            const inflight = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.threadKey))
                .first();

            if (inflight) {
                const status = inflight["status"] as string;
                const inflightInstanceId = inflight["instanceId"] as string | undefined;
                const inflightOwner = inflight["owner"] as string | undefined;

                if (
                    (status === "running" || status === "awaiting_input") &&
                    inflightInstanceId !== undefined &&
                    (inflightOwner === undefined || inflightOwner === owner)
                ) {
                    return { id: inflightInstanceId, threadKey: args.threadKey };
                }

                // A thread's owner is immutable (see agentEnsureThread's owner
                // gate): an authenticated caller may never (re)start a run on a
                // thread owned by a DIFFERENT identity. The workflow bootstrap
                // rejects this too, but only AFTER a workflow instance has been
                // spawned — so an authenticated caller could amplify billable
                // compute by targeting known/guessed foreign threadKeys. Reject
                // here, before `handle.run`, so no doomed instance is started. An
                // ownerless caller (owner === undefined) is still admitted,
                // exactly as the bootstrap admits it.
                if (inflightOwner !== owner && owner !== undefined) {
                    throw new LunoraError("FORBIDDEN", `@lunora/agent: thread "${args.threadKey}" belongs to another owner`);
                }
            }

            const { id } = await handle.run({
                input: args.input,
                threadKey: args.threadKey,
                ...(owner === undefined ? {} : { owner }),
                ...(args.title === undefined ? {} : { title: args.title }),
            });

            return { id, threadKey: args.threadKey };
        });

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

            // Seed enumeration: prefix-scan the owner's entities, keep those
            // whose normalized name matches a query token, rank by salience
            // (weight) then name, and cap at maxSeeds.
            const ownerEntities = await context.db
                .query(ENTITIES_TABLE)
                .withIndex("byOwnerName", (q) => q.eq("owner", args.owner))
                .collect();

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
        extension: agentExtension,
        functions: {
            agentAppendMessage: asInternal(agentAppendMessage),
            agentEnsureThread: asInternal(agentEnsureThread),
            agentGraphTraverse: asInternal(agentGraphTraverse),
            agentGraphUpsert: asInternal(agentGraphUpsert),
            agentMessages,
            agentPatchThread: asInternal(agentPatchThread),
            agentResolveApproval,
            agentRun,
            agentSetState: asInternal(agentSetState),
            agentState,
            agentThread,
        },
    };
};

export type { SandboxComponent, SandboxRegisteredFunction } from "./sandbox-component";
export { sandboxComponent } from "./sandbox-component";
export { agentExtension, normalizeEntityName };
