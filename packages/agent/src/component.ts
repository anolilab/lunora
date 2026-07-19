import { LunoraError } from "@lunora/errors";
import type { SchemaExtension } from "@lunora/server";
import { defineSchemaExtension, defineTable, initLunora } from "@lunora/server";
import { v } from "@lunora/values";

import type { AgentRegisteredFunction } from "./component-shared";
import { AGENT_EXTENSION_KEY, asInternal, definedColumns } from "./component-shared";
import { episodeTables, episodicComponent } from "./episodic-component";
import { graphComponent, graphTables } from "./graph-component";

/** Bare table names — auto-prefixed with the extension key at merge time. */
const THREADS_BARE_TABLE = "threads";
const MESSAGES_BARE_TABLE = "messages";

/** The physical (merged) table names the runtime functions read/write. */
const THREADS_TABLE: "agent_threads" = `${AGENT_EXTENSION_KEY}_${THREADS_BARE_TABLE}`;
const MESSAGES_TABLE: "agent_messages" = `${AGENT_EXTENSION_KEY}_${MESSAGES_BARE_TABLE}`;

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
 * @experimental
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

        // The owner-scoped graph-memory tables (`agent_entities`/`agent_edges`)
        // live in graph-component.ts alongside the functions that read/write
        // them; spread in here so the app still merges one `agentExtension`.
        ...graphTables,

        // The owner-scoped episodic-memory table (`agent_episodes`) lives in
        // episodic-component.ts alongside its functions; spread in here too.
        ...episodeTables,
    },
});

// The runtime functions are built with the base procedure builders (no
// generated server inside a package), same as the presence component.
const { mutation, query } = initLunora.dataModel().create();

/**
 * `AgentComponent` is part of the experimental `@lunora/agent` API and may change without a major version bump.
 * @experimental
 */
export interface AgentComponent {
    extension: SchemaExtension;
    functions: {
        agentAppendMessage: AgentRegisteredFunction;
        agentEnsureThread: AgentRegisteredFunction;
        agentEpisodeRecall: AgentRegisteredFunction;
        agentEpisodeUpsert: AgentRegisteredFunction;
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
 * @experimental
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
                // still owns the thread and will resume. A matching instance id is
                // a REPLAY of the same run, which must be allowed. An ABSENT prior
                // instance id (pre-column thread) can't be told apart from a
                // replay either, so it also falls through. But an id-LESS caller
                // dispatching onto a thread with a KNOWN, live prior instance is
                // NOT a safe replay — the inbound-email/inbound-channel paths
                // dispatch with no instanceId at all, and without this check that
                // silently resets an `awaiting_input` thread straight back to
                // "running", resuming writes on the shared `seq` counter out from
                // under the still-hibernating prior instance. So only a *matching*
                // instance id is exempt; missing OR differing both trip the policy.
                const priorInstanceId = existing["instanceId"] as string | undefined;
                const isConcurrentRun =
                    (existing["status"] === "running" || existing["status"] === "awaiting_input") &&
                    priorInstanceId !== undefined &&
                    (args.instanceId === undefined || args.instanceId !== priorInstanceId);

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
                    // The incoming instance id may itself be absent (an id-less
                    // caller replacing a live run) — omit the column rather than
                    // writing an explicit `undefined`, which the validators reject.
                    await context.db.patch(existing["_id"] as never, {
                        error: undefined,
                        status: "running",
                        updatedAt: now,
                        ...(args.instanceId === undefined ? {} : { instanceId: args.instanceId }),
                    });

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

            // A limit keeps the newest N (the tail of the conversation) — read
            // `byThread` (["threadKey", "seq"]) in DESCENDING seq order and
            // `.take(limit)` so the DB read itself is bounded to the tail,
            // instead of collecting the whole thread and slicing in JS. This is
            // a live subscription re-run on every append, so an unbounded read
            // here was O(total thread length) on every turn.
            if (args.limit !== undefined) {
                const tail = await context.db
                    .query(MESSAGES_TABLE)
                    .withIndex("byThread", (q) => q.eq("threadKey", args.key))
                    .order("desc")
                    .take(args.limit);

                return tail.toReversed();
            }

            // Unbounded case: `byThread` is already ordered `[threadKey, seq]`,
            // so index order IS ascending `seq` order — no JS re-sort needed.
            return context.db
                .query(MESSAGES_TABLE)
                .withIndex("byThread", (q) => q.eq("threadKey", args.key))
                .collect();
        });

    /**
     * Resolve a human-in-the-loop tool approval: deliver the client's
     * approve/reject decision to the paused run so its `waitForEvent` resumes.
     * PUBLIC (a client calls it) but OWNER-GATED — the same `readableThread`
     * gate as the reads, so only the thread's owner may approve. The AGENT_*
     * workflow binding is reached via `ctx.agents` (woven onto the function-run
     * ctx by generated code); the mutation ctx has no raw `env`.
     *
     * Two extra checks close a cross-run bypass (the owner gate alone isn't
     * enough — an ownerless thread is readable by anyone who knows its key,
     * and a benign client can simply pass the wrong ids):
     * - `args.instanceId` must match the thread's OWN stored instance. Without
     * this, a caller who passes the owner gate for one thread (including any
     * ownerless one) could deliver an approve/reject to an arbitrary
     * `instanceId` — a different, unrelated run entirely.
     * - The delivered event's `type` is scoped to `toolCallId`
     * (`agent-approval:&lt;id>`) — the SAME format `agent-loop.ts`'s
     * `awaitApproval` matches on — so a decision meant for one pending tool
     * call cannot resolve a different one on the same instance.
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

            if (readable["instanceId"] !== args.instanceId) {
                // The caller passed the owner gate for THIS thread, but named a
                // different instance — never let that resolve someone else's run.
                throw new LunoraError("FORBIDDEN", `@lunora/agent: instance "${args.instanceId}" does not own thread "${args.threadKey}"`);
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
                payload: { decision: args.decision, toolCallId: args.toolCallId, ...(args.note === undefined ? {} : { note: args.note }) },
                // Scoped per tool call — see the doc comment above.
                type: `agent-approval:${args.toolCallId}`,
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

    // The owner-scoped graph-memory tier (tables + the two internal
    // traverse/upsert functions) lives in graph-component.ts; fold its
    // functions in so codegen auto-registers them under `agents:*`.
    const graph = graphComponent();

    // The owner-scoped episodic-memory tier (table + recall/upsert functions)
    // lives in episodic-component.ts; fold its functions in the same way.
    const episodic = episodicComponent();

    return {
        extension: agentExtension,
        functions: {
            agentAppendMessage: asInternal(agentAppendMessage),
            agentEnsureThread: asInternal(agentEnsureThread),
            agentEpisodeRecall: episodic.agentEpisodeRecall,
            agentEpisodeUpsert: episodic.agentEpisodeUpsert,
            agentGraphTraverse: graph.agentGraphTraverse,
            agentGraphUpsert: graph.agentGraphUpsert,
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

export { normalizeEntityName } from "./graph-component";
export type { SandboxComponent, SandboxRegisteredFunction } from "./sandbox-component";
export { sandboxComponent } from "./sandbox-component";
export { agentExtension };
