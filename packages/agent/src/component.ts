import { LunoraError } from "@lunora/errors";
import type { DatabaseWriter, SchemaExtension } from "@lunora/server";
import { defineSchemaExtension, defineTable, initLunora } from "@lunora/server";
import { v } from "@lunora/values";

import type { AgentRegisteredFunction } from "./component-shared";
import { ABANDONED_APPROVAL_MS, AGENT_EXTENSION_KEY, asInternal, definedColumns } from "./component-shared";
import { episodeTables, episodicComponent } from "./episodic-component";
import { graphComponent, graphTables } from "./graph-component";
import type { EnsureThreadOutcome } from "./types";

/** Bare table names — auto-prefixed with the extension key at merge time. */
const THREADS_BARE_TABLE = "threads";
const MESSAGES_BARE_TABLE = "messages";
const RUN_QUEUE_BARE_TABLE = "run_queue";

/** The physical (merged) table names the runtime functions read/write. */
const THREADS_TABLE: "agent_threads" = `${AGENT_EXTENSION_KEY}_${THREADS_BARE_TABLE}`;
const MESSAGES_TABLE: "agent_messages" = `${AGENT_EXTENSION_KEY}_${MESSAGES_BARE_TABLE}`;
const RUN_QUEUE_TABLE: "agent_run_queue" = `${AGENT_EXTENSION_KEY}_${RUN_QUEUE_BARE_TABLE}`;

/**
 * How many runs may park behind the one in flight under
 * `onConcurrentRun: "queue"` before further starts are rejected.
 *
 * Each parked run is a live workflow instance hibernating on `waitForEvent`, so
 * the cap is a real resource bound, not a formality: five is enough to absorb an
 * impatient user double-sending, and small enough that a runaway trigger loop
 * fails loudly instead of billing an unbounded pile of paused instances. Past
 * the cap the start fails with the same `CONFLICT` `"reject"` already throws.
 */
const MAX_QUEUE_DEPTH = 5;

/**
 * How long a thread may sit untouched under a live-looking run before a new run
 * may take it.
 *
 * Ownership moves to a dequeued run before its wake event is sent, so an
 * instance terminated while parked leaves the thread pointing at a workflow that
 * will never resume — and nothing else would ever free it. The window is longer
 * than the loop's own dequeue timeout so a genuinely parked run is never
 * reclaimed out from under itself. Applies to `"running"` threads only — an
 * `"awaiting_input"` thread uses {@link ABANDONED_APPROVAL_MS}.
 */
const ABANDONED_RUN_MS = 13 * 60 * 60 * 1000;

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

        [RUN_QUEUE_BARE_TABLE]: defineTable({
            agent: v.string(),
            enqueuedAt: v.number(),
            /** The parked run's workflow instance — the wake event is scoped to it. */
            instanceId: v.string(),

            /**
             * Monotonic per-thread position, allocated as `max(position) + 1`
             * over the rows currently queued on this thread. Ordering by it
             * rather than by `enqueuedAt` keeps FIFO exact when two runs are
             * enqueued inside the same millisecond.
             */
            position: v.number(),
            threadKey: v.string(),
        })
            // FIFO dequeue.
            .index("byThread", ["threadKey", "position"])
            // Idempotent enqueue: a replay of a still-parked run's bootstrap
            // finds its own row instead of taking a second slot.
            .index("byThreadInstance", ["threadKey", "instanceId"], { unique: true })
            // See the threads table for why the agent tables are `.public()`.
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
 * The writer the queue helpers take. Named from `@lunora/server`'s exported
 * `DatabaseWriter` rather than derived through three levels of `Parameters`
 * indexing off the builder — the derivation was correct and told the next
 * reader nothing about what the type actually is.
 */
type QueueDatabase = DatabaseWriter;

/**
 * Park a run behind the one currently in flight (`onConcurrentRun: "queue"`).
 *
 * Three properties make this safe, and all three come from the DO executing one
 * mutation at a time: the enqueue is idempotent by `(threadKey, instanceId)`, so
 * a workflow replay of a still-parked run finds its own slot instead of taking a
 * second; the position is allocated from the rows currently queued, so FIFO is
 * exact; and the thread's ownership is untouched, so the in-flight run keeps the
 * seq counter until it finishes and hands it over in one mutation.
 */
const enqueueRun = async (
    database: QueueDatabase,
    args: { agent: string; instanceId: string | undefined; key: string; priorInstanceId: string },
    now: number,
): Promise<EnsureThreadOutcome> => {
    if (args.instanceId === undefined) {
        // The id-less dispatch paths (inbound email / inbound channel) can't be
        // told apart from each other later, so they can't be parked and woken by
        // instance id. Rejecting is the honest answer, and the same one an
        // overflowing queue gives.
        throw new LunoraError(
            "CONFLICT",
            `@lunora/agent: thread "${args.key}" already has a run in flight (instance "${args.priorInstanceId}") — cannot queue a dispatch with no instance id`,
        );
    }

    const { instanceId } = args;
    const alreadyQueued = await database
        .query(RUN_QUEUE_TABLE)
        .withIndex("byThreadInstance", (q) => q.eq("threadKey", args.key).eq("instanceId", instanceId))
        .first();

    if (alreadyQueued) {
        return { outcome: "queued", position: alreadyQueued["position"] as number };
    }

    const queued = await database
        .query(RUN_QUEUE_TABLE)
        .withIndex("byThread", (q) => q.eq("threadKey", args.key))
        .collect();

    if (queued.length >= MAX_QUEUE_DEPTH) {
        throw new LunoraError(
            "CONFLICT",
            `@lunora/agent: thread "${args.key}" run queue is full (depth ${String(MAX_QUEUE_DEPTH)}) — rejecting instance "${instanceId}"`,
        );
    }

    const position = ((queued.at(-1)?.["position"] as number | undefined) ?? -1) + 1;

    await database.insert(RUN_QUEUE_TABLE, { agent: args.agent, enqueuedAt: now, instanceId, position, threadKey: args.key });

    return { outcome: "queued", position };
};

/**
 * Apply `onConcurrentRun` when a second run arrives on a thread another live
 * instance already owns: park it, take the thread over, or reject.
 *
 * Split out of `agentEnsureThread` so the mutation body stays about the thread
 * lifecycle (create / continue / replay) and this stays about the policy.
 */
const applyConcurrencyPolicy = async (
    database: QueueDatabase,
    args: {
        agent: string;
        existingId: string;
        instanceId: string | undefined;
        key: string;
        policy: "queue" | "reject" | "replace";
        priorInstanceId: string;
    },
    now: number,
): Promise<EnsureThreadOutcome> => {
    if (args.policy === "queue") {
        return enqueueRun(database, { agent: args.agent, instanceId: args.instanceId, key: args.key, priorInstanceId: args.priorInstanceId }, now);
    }

    if (args.policy !== "replace") {
        throw new LunoraError(
            "CONFLICT",
            `@lunora/agent: thread "${args.key}" already has a run in flight (instance "${args.priorInstanceId}") — onConcurrentRun="${args.policy}"`,
        );
    }

    // Replace: take the thread over now (the caller terminates the prior
    // instance) so the next append is attributed to this run. The incoming
    // instance id may itself be absent (an id-less caller replacing a live run)
    // — omit the column rather than writing an explicit `undefined`, which the
    // validators reject.
    await database.patch(args.existingId as never, {
        error: undefined,
        status: "running",
        updatedAt: now,
        ...(args.instanceId === undefined ? {} : { instanceId: args.instanceId }),
    });

    return { outcome: "replaced", priorInstanceId: args.priorInstanceId };
};

/**
 * `AgentComponent` is part of the experimental `@lunora/agent` API and may change without a major version bump.
 * @experimental
 */
export interface AgentComponent {
    extension: SchemaExtension;
    functions: {
        agentAppendMessage: AgentRegisteredFunction;
        agentCompleteRun: AgentRegisteredFunction;
        agentDeleteMessage: AgentRegisteredFunction;
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
        .mutation(async ({ args, ctx: context }): Promise<EnsureThreadOutcome> => {
            const now = Date.now();
            const existing = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.key))
                .first();

            if (existing) {
                // The owner is immutable: a run started for a different
                // identity must not attach its messages to (or reopen) someone
                // else's thread. The match is EXACT in both directions — an
                // identity-less caller (`owner: undefined`, which is what a token
                // resolving to no identity produces on the public `agentRun`
                // path) is an identity that owns nothing, not a wildcard that
                // matches every thread. It continues an ownerless thread and
                // nothing else; an owned thread only continues for its owner.
                if (existing["owner"] !== args.owner) {
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
                // Staleness reclaim. Ownership transfers to a dequeued run BEFORE
                // its wake event is sent, so an instance terminated while parked
                // leaves the thread owned by a workflow that will never resume.
                // Nothing else reaps that: under `"reject"` every later run
                // CONFLICTs, and under `"queue"` every later run parks behind a
                // corpse. A thread untouched for longer than any run could
                // plausibly hold it is treated as free — but an `awaiting_input`
                // thread is measured against the far longer approval horizon,
                // because its instance really is alive and hibernating on a slow
                // human decision (see ABANDONED_APPROVAL_MS).
                const updatedAt = typeof existing["updatedAt"] === "number" ? existing["updatedAt"] : 0;
                const staleAfter = existing["status"] === "awaiting_input" ? ABANDONED_APPROVAL_MS : ABANDONED_RUN_MS;
                const abandoned = now - updatedAt > staleAfter;
                const isConcurrentRun =
                    !abandoned &&
                    (existing["status"] === "running" || existing["status"] === "awaiting_input") &&
                    priorInstanceId !== undefined &&
                    (args.instanceId === undefined || args.instanceId !== priorInstanceId);

                if (isConcurrentRun) {
                    return applyConcurrencyPolicy(
                        context.db,
                        {
                            agent: args.agent,
                            existingId: existing["_id"] as string,
                            instanceId: args.instanceId,
                            key: args.key,
                            policy: args.onConcurrentRun ?? "reject",
                            priorInstanceId,
                        },
                        now,
                    );
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

                return { outcome: "continued" };
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

            return { outcome: "created" };
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

    /**
     * Delete a message by `(threadKey, messageKey)`. A no-op when absent, so a
     * workflow replay re-running the delete is harmless.
     *
     * Used for exactly one thing: retiring the spent HITL approval marker. The
     * marker is a pending-decision AFFORDANCE, not conversation content — every
     * client renders its Approve/Reject purely from `status ===
     * "awaiting_approval"`, and `model-messages.ts` drops rows with that status
     * so the model never sees a duplicate tool-result part for the call.
     *
     * That is why the marker is DELETED rather than moved to a terminal status:
     * a terminal status would flip it into a second, bogus tool RESULT on both
     * surfaces at once — an extra result event carrying the placeholder's text
     * in every client, and a duplicated tool-result part in the model prompt
     * (breaking provider tool-call pairing). The real outcome is already
     * recorded on the tool-result row under the same `toolCallId`, so removing
     * the placeholder loses nothing.
     *
     * `messageCount` is deliberately NOT decremented — it is the thread's next-
     * `seq` high-water mark, and rolling it back would hand a later message a
     * `seq` that is already taken.
     */
    const agentDeleteMessage = mutation
        .input({
            messageKey: v.string(),
            threadKey: v.string(),
        })
        .mutation(async ({ args, ctx: context }): Promise<void> => {
            const existing = await context.db
                .query(MESSAGES_TABLE)
                .withIndex("byMessageKey", (q) => q.eq("threadKey", args.threadKey).eq("messageKey", args.messageKey))
                .first();

            if (!existing) {
                return;
            }

            await context.db.delete(existing["_id"] as never);
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
     * End the owning run and, in the SAME mutation, hand the thread to the next
     * parked run if one is waiting.
     *
     * Doing both here is the whole correctness argument: a separate
     * "patch terminal status" then "dequeue" pair would leave a window in which
     * the thread is ownerless, and a third run arriving inside that window would
     * see an idle thread and start immediately — ahead of runs that had been
     * queued for their turn, and racing the one being woken.
     *
     * Idempotent under a workflow replay of the FINISHING run: the caller must
     * still own the thread, so a second call (after ownership has already moved
     * on) is a no-op rather than a second dequeue that skips someone's turn.
     */
    const agentCompleteRun = mutation
        .input({
            error: v.optional(v.string()),
            instanceId: v.string(),
            key: v.string(),
            status: v.union(v.literal("idle"), v.literal("error"), v.literal("cancelled")),
            usage: v.optional(v.object({ inputTokens: v.optional(v.number()), outputTokens: v.optional(v.number()), totalTokens: v.optional(v.number()) })),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ dequeued?: string }> => {
            const now = Date.now();
            const thread = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.key))
                .first();

            if (thread?.["instanceId"] !== args.instanceId) {
                // Not the owner: either a replay of a completion whose handoff
                // already happened, or a run that ended while still PARKED — its
                // wait timed out, or it threw before its turn came. The parked
                // case must still release the slot it holds, or an abandoned run
                // occupies a queue position forever and the depth cap eventually
                // refuses every new start on this thread.
                const parked = await context.db
                    .query(RUN_QUEUE_TABLE)
                    .withIndex("byThreadInstance", (q) => q.eq("threadKey", args.key).eq("instanceId", args.instanceId))
                    .first();

                if (parked) {
                    await context.db.delete(parked["_id"] as never);
                }

                return {};
            }

            // `byThread` is `(threadKey, position)`, so an index read is already
            // position-ascending — the head of this list is the FIFO next.
            const queued = await context.db
                .query(RUN_QUEUE_TABLE)
                .withIndex("byThread", (q) => q.eq("threadKey", args.key))
                .collect();
            const next = queued[0];

            if (!next) {
                await context.db.patch(thread["_id"] as never, {
                    status: args.status,
                    updatedAt: now,
                    ...(args.error === undefined ? {} : { error: args.error }),
                    ...(args.usage === undefined ? {} : { usage: args.usage }),
                });

                return {};
            }

            const nextInstanceId = next["instanceId"] as string;

            await context.db.delete(next["_id"] as never);
            // Ownership transfers here, before the waking event is sent: the
            // dequeued run is already the owner when it resumes, so it can append
            // on the shared seq counter the moment it wakes.
            //
            // The finishing run's `error` is CARRIED, not cleared: a run that
            // failed with another queued behind it would otherwise vanish without
            // trace — the thread goes straight from one run to the next and
            // nothing records that the first one failed. The incoming run clears
            // it through its own bootstrap.
            await context.db.patch(thread["_id"] as never, {
                instanceId: nextInstanceId,
                status: "running",
                updatedAt: now,
                ...(args.error === undefined ? {} : { error: args.error }),
                ...(args.usage === undefined ? {} : { usage: args.usage }),
            });

            return { dequeued: nextInstanceId };
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
     * (`agent-approval:<id>`) — the SAME format `agent-loop.ts`'s
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
     * which fronts agents over RPC) can invoke `ctx.agents.<name>.run` without
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
     * restores the app-author chokepoint that `ctx.agents.<name>.run`
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
                // here, before `handle.run`, so no doomed instance is started.
                // The match is EXACT, exactly as the bootstrap's is: a caller
                // whose token resolves to NO identity (`owner === undefined`)
                // does not match an owned thread either — admitting it let an
                // unauthenticated request append to a stranger's history (read
                // back into the owner's next model turn), burn the owner's
                // inference budget, and under `onConcurrentRun: "replace"`
                // terminate the owner's in-flight run.
                if (inflightOwner !== owner) {
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
            agentCompleteRun: asInternal(agentCompleteRun),
            agentEnsureThread: asInternal(agentEnsureThread),
            agentEpisodeRecall: episodic.agentEpisodeRecall,
            agentEpisodeUpsert: episodic.agentEpisodeUpsert,
            agentGraphTraverse: graph.agentGraphTraverse,
            agentGraphUpsert: graph.agentGraphUpsert,
            agentMessages,
            agentDeleteMessage: asInternal(agentDeleteMessage),
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
