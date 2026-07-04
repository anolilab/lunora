import { LunoraError } from "@lunora/errors";
import type { SchemaExtension } from "@lunora/server";
import { defineSchemaExtension, defineTable, initLunora } from "@lunora/server";
import { v } from "@lunora/values";

const AGENT_EXTENSION_KEY = "agent";

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
        agentMessages: AgentRegisteredFunction;
        agentPatchThread: AgentRegisteredFunction;
        agentResolveApproval: AgentRegisteredFunction;
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
 * The mutations are **internal** (only the workflow's admin-authenticated
 * dispatch may call them); the queries are public so a client can subscribe
 * to `agents:agentMessages` for a live thread view.
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

    return {
        extension: agentExtension,
        functions: {
            agentAppendMessage: asInternal(agentAppendMessage),
            agentEnsureThread: asInternal(agentEnsureThread),
            agentMessages,
            agentPatchThread: asInternal(agentPatchThread),
            agentResolveApproval,
            agentSetState: asInternal(agentSetState),
            agentState,
            agentThread,
        },
    };
};

export type { SandboxComponent, SandboxRegisteredFunction } from "./sandbox-component";
export { sandboxComponent } from "./sandbox-component";
export { agentExtension };
