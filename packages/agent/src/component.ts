import { LunoraError } from "@lunora/errors";
import type { SecretValueHost } from "@lunora/platform";
import { SecretValueTooLargeError } from "@lunora/platform";
import type { DatabaseWriter, SchemaExtension, TableDefinition } from "@lunora/server";
import { defineSchemaExtension, defineTable, initLunora } from "@lunora/server";
import { v } from "@lunora/values";

import type { AgentRegisteredFunction } from "./component-shared";
import { ABANDONED_APPROVAL_MS, AGENT_EXTENSION_KEY, AGENT_SECRET_TTL_MS, asInternal, definedColumns, SECRET_WAIT_GRACE_MS } from "./component-shared";
import { episodeTables, episodicComponent } from "./episodic-component";
import { graphComponent, graphTables } from "./graph-component";
import type { EnsureThreadOutcome } from "./types";

/** Bare table names — auto-prefixed with the extension key at merge time. */
const THREADS_BARE_TABLE = "threads";
const MESSAGES_BARE_TABLE = "messages";
const RUN_QUEUE_BARE_TABLE = "run_queue";
const GRANTS_BARE_TABLE = "approval_grants";
const REQUESTS_BARE_TABLE = "secret_requests";

/** The physical (merged) table names the runtime functions read/write. */
const THREADS_TABLE: "agent_threads" = `${AGENT_EXTENSION_KEY}_${THREADS_BARE_TABLE}`;
const MESSAGES_TABLE: "agent_messages" = `${AGENT_EXTENSION_KEY}_${MESSAGES_BARE_TABLE}`;
const RUN_QUEUE_TABLE: "agent_run_queue" = `${AGENT_EXTENSION_KEY}_${RUN_QUEUE_BARE_TABLE}`;
const GRANTS_TABLE: "agent_approval_grants" = `${AGENT_EXTENSION_KEY}_${GRANTS_BARE_TABLE}`;
const REQUESTS_TABLE: "agent_secret_requests" = `${AGENT_EXTENSION_KEY}_${REQUESTS_BARE_TABLE}`;

/** Default and ceiling for the approvals inbox `limit`. The ceiling caps the per-thread fan-out, since `.take()` has none. */
const DEFAULT_APPROVALS_LIMIT = 50;
const MAX_APPROVALS_LIMIT = 200;

/**
 * Paused threads the inbox reads before giving up. Secret-paused threads share the
 * `awaiting_input` index but carry no approval, so a page of them would otherwise
 * hide an older approval. This bounds how far they can starve the inbox.
 */
const MAX_APPROVALS_SCAN = 500;

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
 * The token usage a thread row stores and its mutations accept. Every field is
 * optional: a row written before the cache and reasoning breakdowns existed carries
 * only the three totals, and it must keep reading and patching. Nothing is
 * backfilled, so an absent breakdown reads as absent, never as zero. The same holds
 * for `status`, which a row written before it existed does not carry.
 */
const USAGE_VALIDATOR = v.object({
    cacheReadTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    status: v.optional(v.union(v.literal("complete"), v.literal("partial"), v.literal("unavailable"))),
    totalTokens: v.optional(v.number()),
});

/** What `agentHistory` returns: the uncovered messages plus the summary covering the rest. */
interface AgentHistory {
    /** Rebuild only: the stored summary and its cursor, for when the from-scratch summary fails. */
    fallback?: { summary: string; throughSeq: number };
    messages: Record<string, unknown>[];
    /** Incremental only: the stored summary the uncovered messages fold into. */
    summary?: string;
}

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
const agentExtension: SchemaExtension<
    Record<
        | keyof typeof episodeTables
        | keyof typeof graphTables
        | typeof GRANTS_BARE_TABLE
        | typeof MESSAGES_BARE_TABLE
        | typeof REQUESTS_BARE_TABLE
        | typeof RUN_QUEUE_BARE_TABLE
        | typeof THREADS_BARE_TABLE,
        TableDefinition
    >,
    typeof AGENT_EXTENSION_KEY
> = defineSchemaExtension(AGENT_EXTENSION_KEY, {
    tables: {
        [MESSAGES_BARE_TABLE]: defineTable({
            /**
             * On the tool-result row of an approved call: `"thread"` when the
             * approver granted the tool for the rest of the thread (see
             * {@link GRANTS_BARE_TABLE}), absent for a one-off approval.
             */
            approvalScope: v.optional(v.literal("thread")),
            content: v.string(),
            createdAt: v.number(),

            /**
             * When a pending approval stops accepting a lasting grant. Set on the marker
             * when the run pauses, because a timeout runs no mutation to retire it.
             */
            expiresAt: v.optional(v.number()),
            messageKey: v.string(),
            role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"), v.literal("system")),
            seq: v.number(),

            /**
             * Human-in-the-loop approval marker: `"awaiting_approval"` on the
             * placeholder written while a run pauses on a gated tool, then
             * `"approved"`/`"rejected"` on the tool result once resolved. Optional
             * so ordinary messages (and pre-existing rows) are unaffected.
             */
            status: v.optional(v.union(v.literal("awaiting_approval"), v.literal("awaiting_secret"), v.literal("approved"), v.literal("rejected"))),
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

            /**
             * The failure message of the last run that ended in `status: "error"`.
             *
             * NULLABLE, not just optional, because a starting run has to CLEAR it —
             * and `ctx.db.patch` has exactly one way to clear a column: write
             * `null`. An explicit `undefined` is rejected outright
             * (`assertNoExplicitUndefined`), since the patch merge would drop the
             * key and silently delete the field.
             *
             * `null` and absent mean the same thing to every reader — "no error" —
             * so read it for truthiness, never for presence. Absent is a thread
             * that has never failed (or predates the column); `null` is one whose
             * error a later run cleared.
             */
            error: v.optional(v.string().nullable()),

            /**
             * The workflow instance id of the run that last completed on this
             * thread — whether it ended the thread or handed it to a queued
             * successor. The one durable fact a run's own replay cannot
             * reconstruct: an activation boundary resets every in-memory flag,
             * and `instanceId` alone answers neither question below.
             *
             * `agentCompleteRun` reads it to tell a first completion from a
             * re-dispatch of one that already happened. The empty-queue branch
             * leaves `instanceId` naming the finishing run, so a writer which
             * marks the thread live again WITHOUT taking ownership
             * (`agentEnsureThread` with no `instanceId` — a voice turn, an inbound
             * dispatch) leaves the finished run still reading as the owner of a
             * thread somebody else is holding; re-reading the queue there would
             * wake a run parked behind that holder. The handoff branch has the
             * mirror problem: it moves `instanceId` to the successor, so the
             * finishing run's replay reads as neither owner nor queued —
             * `agentEnsureThread` would treat it as a second run, and its
             * re-dispatched completion would report no successor to wake.
             *
             * Retired by the next writer that TAKES ownership (stamps a different
             * `instanceId`), cleared with `null` — by then the completion it
             * describes has been superseded and no replay of it may act.
             */
            completedInstanceId: v.optional(v.string().nullable()),

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

            /**
             * Running compaction brief: a summary of every message with `seq <=
             * summaryThroughSeq`, so a turn reads (and summarises) only what is newer.
             * `summaryConfig` identifies the compaction settings that produced it, so a
             * run whose settings differ reads the full history and rebuilds instead of
             * applying a cursor that would hide messages the new settings would keep.
             * `summaryRebuiltSeq` is the cursor at the last from-scratch rebuild; a
             * rebuild is due once the covered span has doubled since then, which keeps
             * the total rebuild work linear in the thread length. All optional, so
             * pre-existing threads and agents without `compaction` are unaffected.
             */
            summary: v.optional(v.string()),
            summaryConfig: v.optional(v.string()),
            summaryRebuiltSeq: v.optional(v.number()),
            summaryThroughSeq: v.optional(v.number()),
            title: v.optional(v.string()),
            updatedAt: v.number(),

            /**
             * Token usage for the latest run on this thread, patched at run end
             * (an absolute total for that run, never a sum across runs). Optional so
             * agent-free apps and pre-existing threads (written before this column
             * existed) are unaffected. The cache and reasoning breakdowns are optional
             * for the same reason: rows written before they existed read as absent.
             */
            usage: v.optional(USAGE_VALIDATOR),
        })
            .index("byKey", ["key"], { unique: true })
            .index("byAgent", ["agent"])
            // Targets a thread by the workflow instance that owns it — the
            // lookup `cancel` uses to mark the right thread cancelled.
            .index("byInstance", ["instanceId"])
            // Drives the approvals inbox (`agentPendingApprovals`): the owner
            // leads so the owner gate applies BEFORE the limit cap, and
            // `updatedAt` gives newest-first order without a sort.
            .index("byOwnerStatus", ["owner", "status", "updatedAt"])
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

        /**
         * Thread-scoped approval grants: a tool named here skips its
         * `needsApproval` gate for every later call in the thread. Written only by
         * `agentResolveApproval` (an `approve` for the thread) and removed only by
         * `agentRevokeApprovalGrant`; the gate reads it inside its own durable step,
         * so a grant made after a call's gate resolved never changes that call.
         */
        [GRANTS_BARE_TABLE]: defineTable({
            createdAt: v.number(),
            threadKey: v.string(),
            toolName: v.string(),
        })
            // One grant per tool per thread; unique makes a repeated approve a no-op.
            .index("byThreadTool", ["threadKey", "toolName"], { unique: true })
            // See the threads table for why the agent tables are `.public()`.
            .public(),

        /**
         * One row per `requestSecretTool` pause, keyed by the request's slot, `<turn>:<tool-call id>`.
         * Every transition (supply, decline, expiry, consumption) is a compare-and-set
         * on `status` inside one mutation, so a supply and the timeout cannot both
         * win. The row holds the host's ref, which the loop never sees: the model is
         * handed the slot, and the consuming tool resolves it here. The value
         * itself is never stored in this table.
         */
        [REQUESTS_BARE_TABLE]: defineTable({
            /** The only tool whose claimant may read the value (`requestSecretTool({ consumer })`). */
            consumerTool: v.string(),
            createdAt: v.number(),
            /** Absolute deadline: a supply at or after it is refused, whether or not the loop has settled. */
            expiresAt: v.number(),

            /**
             * The run that owns the request. A tool-call id is provider-issued, so a later
             * run can reuse one; the instance tells a replayed pause from a new run.
             */
            instanceId: v.string(),
            /** The host's ref, set by the supply and cleared when a later run reuses the row. Sensitive: never listed, logged or returned. */
            ref: v.optional(v.string().nullable()),

            /**
             * What the model says the secret is for, shown to the owner by `agentSecretRequests`. Absent on rows written
             * before it existed, and on a row whose run gave no label to keep.
             */
            label: v.optional(v.string().nullable()),
            status: v.union(v.literal("pending"), v.literal("supplied"), v.literal("declined"), v.literal("expired"), v.literal("consumed")),
            threadKey: v.string(),
            /** The request's slot (`<turn>:<tool-call id>`): the key its steps, wait and row are stored under. */
            toolCallId: v.string(),
            /** The provider's tool-call id: what a client sees on the tool call, and answers with. Not unique across turns. */
            callId: v.optional(v.string()),
            toolName: v.string(),
            updatedAt: v.number(),
        })
            // One request per slot per thread; the unique key makes a replayed pause a no-op.
            .index("byThreadCall", ["threadKey", "toolCallId"], { unique: true })
            .index("byThreadCallId", ["threadKey", "callId"])
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
 * Record a thread-scoped approval grant for the tool of the call awaiting approval
 * right now. The tool name comes from the stored marker row, never from the
 * client, so an approve cannot grant a tool the paused run did not ask for. With
 * no pending marker (already decided, timed out, or a stale instance) there is
 * nothing to grant, and the decision is refused before the run is woken.
 */
const grantApprovalForThread = async (database: QueueDatabase, threadKey: string, instanceId: string, toolCallId: string): Promise<void> => {
    const marker = await database
        .query(MESSAGES_TABLE)
        .withIndex("byMessageKey", (q) => q.eq("threadKey", threadKey).eq("messageKey", `${instanceId}:approval:${toolCallId}`))
        .first();

    if (marker?.["status"] !== "awaiting_approval") {
        throw new LunoraError("CONFLICT", `@lunora/agent: no pending approval for tool call "${toolCallId}" to grant for thread "${threadKey}"`);
    }

    // A timeout ends the wait without running any mutation, so the marker can still read
    // "awaiting_approval" after the run has already rejected the call. The deadline is the only
    // thing that closes that window.
    // A marker with no deadline (one written before deadlines were recorded) cannot show its window is still open,
    // so it grants nothing: every marker this code writes carries one.
    const { expiresAt } = marker;

    if (typeof expiresAt !== "number") {
        throw new LunoraError(
            "CONFLICT",
            `@lunora/agent: the approval for tool call "${toolCallId}" on thread "${threadKey}" has no recorded deadline, so it cannot be granted for the thread`,
        );
    }

    if (Date.now() >= expiresAt) {
        throw new LunoraError("CONFLICT", `@lunora/agent: the approval for tool call "${toolCallId}" on thread "${threadKey}" has timed out`);
    }

    const toolName = marker["toolName"] as string;
    const existing = await database
        .query(GRANTS_TABLE)
        .withIndex("byThreadTool", (q) => q.eq("threadKey", threadKey).eq("toolName", toolName))
        .first();

    if (!existing) {
        await database.insert(GRANTS_TABLE, { createdAt: Date.now(), threadKey, toolName });
    }
};

/**
 * Retire the pending approval marker in the mutation that decides it. The loop only deletes the marker after its wait
 * resolves, so until then a second decision on the same call would still find it pending and could record a grant.
 */
/** Whether the call's approval marker still awaits a decision. Mutations run one at a time, so a read is decisive. */
const approvalIsPending = async (database: QueueDatabase, threadKey: string, instanceId: string, toolCallId: string): Promise<boolean> => {
    const marker = await database
        .query(MESSAGES_TABLE)
        .withIndex("byMessageKey", (q) => q.eq("threadKey", threadKey).eq("messageKey", `${instanceId}:approval:${toolCallId}`))
        .first();

    return marker?.["status"] === "awaiting_approval";
};

const retireApprovalMarker = async (database: QueueDatabase, threadKey: string, instanceId: string, toolCallId: string): Promise<void> => {
    const marker = await database
        .query(MESSAGES_TABLE)
        .withIndex("byMessageKey", (q) => q.eq("threadKey", threadKey).eq("messageKey", `${instanceId}:approval:${toolCallId}`))
        .first();

    if (marker?.["status"] === "awaiting_approval") {
        await database.delete(marker["_id"] as never);
    }
};

/**
 * The secret store the secret mutations reach through the generated ctx. Codegen
 * weaves `agentSecrets` onto the ctx only for a target that can hold a value,
 * in an app that imports `requestSecretTool`; any other host refuses here, before
 * a value is accepted, rather than crashing on an undefined field.
 */
const secretStoreOf = (context: unknown): SecretValueHost => {
    const { agentSecrets } = context as { agentSecrets?: SecretValueHost };

    if (agentSecrets === undefined) {
        throw new LunoraError(
            "NOT_IMPLEMENTED",
            "@lunora/agent: no secret store is wired on this deployment. Codegen wires one only when a source in lunora/ value-imports requestSecretTool from @lunora/agent (directly, through a namespace import, or through a relative barrel that re-exports it); add that import, or this target cannot hold a human-supplied secret value",
        );
    }

    return agentSecrets;
};

/**
 * The owner gate for the human-facing secret mutations, deliberately stricter
 * than `readableThread`: an ownerless thread is readable by anyone who
 * knows its key, and it must NOT be allowed to take a credential. Requires a
 * verified identity that equals the thread's stored owner.
 */
const ownedSecretThread = (thread: Record<string, unknown> | null, auth: { userId?: string | null }, action: string): Record<string, unknown> => {
    const userId = auth.userId ?? undefined;

    if (thread === null || userId === undefined || thread["owner"] !== userId) {
        throw new LunoraError("FORBIDDEN", `@lunora/agent: only the thread's owner can ${action}`);
    }

    return thread;
};

/**
 * The pending `awaiting_secret` marker row for `toolCallId`, keyed off the
 * thread's own stored instance. A marker the loop has retired (timeout, a
 * decision already taken, or a double submit) is a CONFLICT, so a late supply
 * stores nothing.
 */
const pendingSecretMarker = async (database: QueueDatabase, thread: Record<string, unknown>, toolCallId: string): Promise<Record<string, unknown>> => {
    const { instanceId, key: threadKey } = thread as { instanceId?: unknown; key: string };
    const marker =
        typeof instanceId === "string"
            ? await database
                  .query(MESSAGES_TABLE)
                  .withIndex("byMessageKey", (q) => q.eq("threadKey", threadKey).eq("messageKey", `${instanceId}:secret:${toolCallId}`))
                  .first()
            : undefined;

    if (marker?.["status"] !== "awaiting_secret") {
        throw new LunoraError("CONFLICT", `@lunora/agent: no pending secret request for tool call "${toolCallId}" on thread "${threadKey}"`);
    }

    return marker;
};

/** The request row for one tool call on a thread, or `undefined` (a pre-change thread has none). */
const secretRequestOf = async (database: QueueDatabase, threadKey: string, toolCallId: string): Promise<Record<string, unknown> | undefined> => {
    const request = await database
        .query(REQUESTS_TABLE)
        .withIndex("byThreadCall", (q) => q.eq("threadKey", threadKey).eq("toolCallId", toolCallId))
        .first();

    return request ?? undefined;
};

/**
 * The one request a client's tool-call id names on a thread: pending, still before its deadline, and owned by the thread's
 * current run. A replaced run can leave a pending row under the same call id, so those rows do not count. A paused run takes
 * no further turn, so two matches are refused rather than guessed at.
 */
const pendingSecretRequestForCall = async (
    database: QueueDatabase,
    threadKey: string,
    instanceId: unknown,
    callId: string,
    now: number,
): Promise<Record<string, unknown>> => {
    const matches = await database
        .query(REQUESTS_TABLE)
        .withIndex("byThreadCallId", (q) => q.eq("threadKey", threadKey).eq("callId", callId))
        .collect();
    const pending = matches.filter(
        (request) => request["status"] === "pending" && request["instanceId"] === instanceId && now < (request["expiresAt"] as number),
    );

    if (pending.length !== 1) {
        throw new LunoraError("CONFLICT", `@lunora/agent: no pending secret request for tool call "${callId}" on thread "${threadKey}"`);
    }

    return pending[0] as Record<string, unknown>;
};

/**
 * How long a supplied value must stay takeable: until the wait it may be waking has
 * ended, which is the request deadline plus the wait's grace. The store clamps the
 * result to its own ceiling, so a deadline beyond that ceiling still loses the value.
 */
const secretValueTtlMs = (expiresAt: number, now: number): number => Math.max(AGENT_SECRET_TTL_MS, expiresAt + SECRET_WAIT_GRACE_MS - now);

/**
 * The request row, which must still be open for an answer: pending and before its
 * deadline. Read again after the host `put` in supply, because the deadline can pass
 * while the value is being stored. A missing row (a thread paused before this table
 * existed) refuses the same way, so nothing is stored for it.
 */
const openSecretRequestOrThrow = async (database: QueueDatabase, threadKey: string, toolCallId: string, now: number): Promise<Record<string, unknown>> => {
    const request = await secretRequestOf(database, threadKey, toolCallId);

    if (request?.["status"] !== "pending" || now >= (request["expiresAt"] as number)) {
        throw new LunoraError("CONFLICT", `@lunora/agent: no open secret request for tool call "${toolCallId}" on thread "${threadKey}"`);
    }

    return request;
};

/**
 * The thread's agent `sendEvent` handle plus its running instance: the path that
 * wakes a paused secret wait.
 */
const secretWaitHandle = (
    context: unknown,
    thread: Record<string, unknown>,
): { instanceId: string; sendEvent: (id: string, event: { payload: unknown; type: string }) => Promise<void> } => {
    const { instanceId } = thread;
    const { agents } = context as { agents?: Record<string, { sendEvent?: (id: string, event: { payload: unknown; type: string }) => Promise<void> }> };
    const handle = agents?.[thread["agent"] as string];

    if (typeof instanceId !== "string" || typeof handle?.sendEvent !== "function") {
        throw new LunoraError("INTERNAL", `@lunora/agent: no ctx.agents["${String(thread["agent"])}"] producer to deliver the secret — run codegen/dev`);
    }

    return { instanceId, sendEvent: handle.sendEvent };
};

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
    // store rejects. `error` IS being cleared, so it is written as `null`, the
    // one value a patch can clear a column with.
    await database.patch(args.existingId as never, {
        // eslint-disable-next-line unicorn/no-null -- `null` is how `ctx.db.patch` clears a nullable column; `undefined` is rejected (shard-engine's `assertNoExplicitUndefined`)
        error: null,
        status: "running",
        updatedAt: now,
        // Taking ownership retires the previous run's completion marker: a
        // replay of that run must not still read this thread as the one it
        // handed on. A caller with no id takes no ownership, so it retires
        // nothing — see `completedInstanceId`.
        // eslint-disable-next-line unicorn/no-null -- as above: `null` is the only value a patch can clear a column with
        ...(args.instanceId === undefined ? {} : { completedInstanceId: null, instanceId: args.instanceId }),
    });

    return { outcome: "replaced", priorInstanceId: args.priorInstanceId };
};

/**
 * The live instance this dispatch would CONTEND with, or `undefined` when it may
 * write to the thread itself.
 *
 * A thread already owned by a DIFFERENT workflow instance is a genuine second
 * run — the two would interleave their messages on the shared seq counter.
 * "running" and "awaiting_input" both mean the prior instance is alive: the
 * latter is a HITL pause hibernating on step.waitForEvent, which still owns the
 * thread and will resume. A matching instance id is a REPLAY of the same run,
 * which must be allowed. An ABSENT prior instance id (pre-column thread) can't
 * be told apart from a replay either, so it also falls through. But an id-LESS
 * caller dispatching onto a thread with a KNOWN, live prior instance is NOT a
 * safe replay — the inbound-email/inbound-channel paths dispatch with no
 * instanceId at all, and without this check that silently resets an
 * `awaiting_input` thread straight back to "running", resuming writes on the
 * shared `seq` counter out from under the still-hibernating prior instance. So
 * only a *matching* instance id is exempt; missing OR differing both contend.
 *
 * Staleness reclaim. Ownership transfers to a dequeued run BEFORE its wake event
 * is sent, so an instance terminated while parked leaves the thread owned by a
 * workflow that will never resume. Nothing else reaps that: under `"reject"`
 * every later run CONFLICTs, and under `"queue"` every later run parks behind a
 * corpse. A thread untouched for longer than any run could plausibly hold it is
 * treated as free — but an `awaiting_input` thread is measured against the far
 * longer approval horizon, because its instance really is alive and hibernating
 * on a slow human decision (see ABANDONED_APPROVAL_MS).
 */
const liveOwnerContendedBy = (existing: Record<string, unknown>, instanceId: string | undefined, now: number): string | undefined => {
    const priorInstanceId = existing["instanceId"] as string | undefined;

    if (priorInstanceId === undefined || instanceId === priorInstanceId) {
        return undefined;
    }

    if (existing["status"] !== "running" && existing["status"] !== "awaiting_input") {
        return undefined;
    }

    const updatedAt = typeof existing["updatedAt"] === "number" ? existing["updatedAt"] : 0;
    const staleAfter = existing["status"] === "awaiting_input" ? ABANDONED_APPROVAL_MS : ABANDONED_RUN_MS;

    return now - updatedAt > staleAfter ? undefined : priorInstanceId;
};

/**
 * `AgentComponent` is part of the experimental `@lunora/agent` API and may change without a major version bump.
 * @experimental
 */
export interface AgentComponent {
    extension: SchemaExtension;
    functions: {
        agentAppendMessage: AgentRegisteredFunction;
        agentApprovalGranted: AgentRegisteredFunction;
        agentApprovalGrants: AgentRegisteredFunction;
        agentCompleteRun: AgentRegisteredFunction;
        agentDeclineSecret: AgentRegisteredFunction;
        agentDeleteMessage: AgentRegisteredFunction;
        agentDiscardSecret: AgentRegisteredFunction;
        agentEnsureThread: AgentRegisteredFunction;
        agentEpisodeRecall: AgentRegisteredFunction;
        agentEpisodeUpsert: AgentRegisteredFunction;
        agentGraphTraverse: AgentRegisteredFunction;
        agentGraphUpsert: AgentRegisteredFunction;
        agentHistory: AgentRegisteredFunction;
        agentMessages: AgentRegisteredFunction;
        agentOpenSecretRequest: AgentRegisteredFunction;
        agentPatchThread: AgentRegisteredFunction;
        agentPendingApprovals: AgentRegisteredFunction;
        agentResolveApproval: AgentRegisteredFunction;
        agentRevokeApprovalGrant: AgentRegisteredFunction;
        agentRun: AgentRegisteredFunction;
        agentSecretRequests: AgentRegisteredFunction;
        agentSetState: AgentRegisteredFunction;
        agentSettleSecretRequest: AgentRegisteredFunction;
        agentState: AgentRegisteredFunction;
        agentSupplySecret: AgentRegisteredFunction;
        agentTakeSecret: AgentRegisteredFunction;
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

                // This run already completed, and is replaying because the
                // completion's REPLY was lost (a dispatch timeout is a retryable
                // 503 even when the mutation committed). The body re-executes
                // from the top — a workflow memoizes steps, not the top level —
                // and arrives here holding no claim on the thread: if it handed
                // the thread to a queued successor, `instanceId` now names that
                // successor, and without this the guard below would read the
                // run's own replay as a genuine second run and apply
                // `onConcurrentRun` to it — failing the replay under "reject",
                // parking it behind the very successor it dequeued under
                // "queue". Neither is a state it can be in.
                //
                // So it falls straight through, taking no ownership and
                // reviving nothing: its body re-dispatches the same terminal
                // completion (absolute, so it converges) and re-sends the
                // successor's wake, which is the only effect still outstanding.
                if (args.instanceId !== undefined && existing["completedInstanceId"] === args.instanceId) {
                    return { outcome: "completed" };
                }

                const contendedWith = liveOwnerContendedBy(existing, args.instanceId, now);

                if (contendedWith !== undefined) {
                    return applyConcurrencyPolicy(
                        context.db,
                        {
                            agent: args.agent,
                            existingId: existing["_id"] as string,
                            instanceId: args.instanceId,
                            key: args.key,
                            policy: args.onConcurrentRun ?? "reject",
                            priorInstanceId: contendedWith,
                        },
                        now,
                    );
                }

                // Replay (same instance) or a resumed idle/errored/cancelled
                // thread: resetting status/error to "running" is idempotent and
                // correct, since (re)starting means the run IS active again. The
                // instance id is (re)stamped so cancel/replace can target it.
                // `error` is cleared with `null` — see the column's doc comment.
                await context.db.patch(existing["_id"] as never, {
                    // eslint-disable-next-line unicorn/no-null -- `null` is how `ctx.db.patch` clears a nullable column; `undefined` is rejected (shard-engine's `assertNoExplicitUndefined`)
                    error: null,
                    status: "running",
                    updatedAt: now,
                    // Taking ownership retires the previous run's completion
                    // marker — see `completedInstanceId`. An id-less caller
                    // (voice, inbound) takes no ownership and retires nothing,
                    // which is what keeps a finished run's re-dispatched
                    // completion from waking a run parked behind THIS writer.
                    // eslint-disable-next-line unicorn/no-null -- as above: `null` is the only value a patch can clear a column with
                    ...(args.instanceId === undefined ? {} : { completedInstanceId: null, instanceId: args.instanceId }),
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
            approvalScope: v.optional(v.literal("thread")),
            content: v.string(),
            expiresAt: v.optional(v.number()),
            messageKey: v.string(),
            role: v.union(v.literal("user"), v.literal("assistant"), v.literal("tool"), v.literal("system")),
            status: v.optional(v.union(v.literal("awaiting_approval"), v.literal("awaiting_secret"), v.literal("approved"), v.literal("rejected"))),
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
                ...(args.approvalScope === undefined ? {} : { approvalScope: args.approvalScope }),
                ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
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
            // When set, the whole patch applies only while this run still owns the
            // thread (`instanceId`), so a replaced run's late write is a no-op.
            ifInstanceId: v.optional(v.string()),
            // Target by thread key (the loop) OR by workflow instance id (cancel,
            // which only knows the instance it terminated). Exactly one is set.
            instanceId: v.optional(v.string()),
            key: v.optional(v.string()),
            status: v.optional(v.union(v.literal("idle"), v.literal("running"), v.literal("error"), v.literal("cancelled"), v.literal("awaiting_input"))),
            summary: v.optional(v.string()),
            summaryConfig: v.optional(v.string()),
            summaryRebuiltSeq: v.optional(v.number()),
            summaryThroughSeq: v.optional(v.number()),
            title: v.optional(v.string()),
            usage: v.optional(USAGE_VALIDATOR),
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

            if (!thread || (args.ifInstanceId !== undefined && thread["instanceId"] !== args.ifInstanceId)) {
                return;
            }

            await context.db.patch(thread["_id"] as never, {
                updatedAt: Date.now(),
                ...(args.error === undefined ? {} : { error: args.error }),
                ...(args.status === undefined ? {} : { status: args.status }),
                ...(args.summary === undefined ? {} : { summary: args.summary }),
                ...(args.summaryConfig === undefined ? {} : { summaryConfig: args.summaryConfig }),
                ...(args.summaryRebuiltSeq === undefined ? {} : { summaryRebuiltSeq: args.summaryRebuiltSeq }),
                ...(args.summaryThroughSeq === undefined ? {} : { summaryThroughSeq: args.summaryThroughSeq }),
                ...(args.title === undefined ? {} : { title: args.title }),
                // The loop patches a per-run cumulative total; setting it (rather
                // than adding) keeps the write idempotent under workflow replay.
                ...(args.usage === undefined ? {} : { usage: args.usage }),
            });
        });

    /**
     * The compaction read: the stored running summary plus ONLY the messages it
     * does not yet cover (`seq > summaryThroughSeq`), so a turn's read and
     * summarisation input stay bounded by the uncovered tail instead of growing
     * with the thread. The incremental read is taken only when the stored summary
     * was built under the caller's current compaction settings (`configKey` — a run
     * that raised `maxMessages` must not apply a stale cursor that hides messages
     * it would now keep) AND no from-scratch rebuild is due: a rebuild happens once
     * the covered span has at least doubled since the last one, which keeps total
     * rebuild work linear in the thread length rather than re-summarising the whole
     * thread on a fixed cadence. On either miss the whole thread is returned for a
     * fresh summary, with the stored summary and cursor riding along as `fallback`
     * for when that rebuild fails. Internal: the loop is the only reader.
     */
    const agentHistory = query.input({ configKey: v.optional(v.string()), key: v.string() }).query(async ({ args, ctx: context }): Promise<AgentHistory> => {
        const thread = await context.db
            .query(THREADS_TABLE)
            .withIndex("byKey", (q) => q.eq("key", args.key))
            .first();
        const summary = thread?.["summary"] as string | null | undefined;
        const through = thread?.["summaryThroughSeq"] as number | null | undefined;
        const rebuiltSeq = thread?.["summaryRebuiltSeq"] as number | null | undefined;
        const storedConfig = thread?.["summaryConfig"] as string | null | undefined;
        const hasSummary = typeof summary === "string" && summary.length > 0 && typeof through === "number";
        const configMatches = args.configKey === undefined || storedConfig === args.configKey;
        // A summary whose settings changed, or one never anchored by a rebuild under this scheme, rebuilds first.
        const rebuildDue = typeof rebuiltSeq !== "number" || (typeof through === "number" && through >= 2 * rebuiltSeq + 1);
        const incremental = hasSummary && configMatches && !rebuildDue;
        const messages = await context.db
            .query(MESSAGES_TABLE)
            .withIndex("byThread", (q) => (incremental ? q.eq("threadKey", args.key).gt("seq", through) : q.eq("threadKey", args.key)))
            .collect();

        if (incremental) {
            return { messages, summary };
        }

        return hasSummary ? { fallback: { summary, throughSeq: through }, messages } : { messages };
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
     *
     * INVARIANT the empty-queue branch rests on. That branch writes the terminal
     * status but leaves `instanceId` naming this run, so a re-dispatched
     * completion (the loop's body re-runs on every workflow activation) passes
     * the ownership check a second time and re-reads the queue. Re-writing the
     * terminal status then is right — it is absolute and converges — and finding
     * the queue still empty is not luck: a run can only park here while the
     * thread is `"running"`/`"awaiting_input"` under a DIFFERENT instance (see
     * `agentEnsureThread`), and this branch just moved it to a terminal status.
     * The next run to take the thread stamps its own `instanceId`, which retires
     * this one. What would break it is a writer that marks the thread live again
     * WITHOUT taking ownership: the finished run would still read as the owner,
     * and could hand the thread — and wake — a run parked behind whoever is
     * actually holding it. Any new such writer needs a stored completion marker
     * here, because none of the columns this reads would distinguish the two.
     */
    const agentCompleteRun = mutation
        .input({
            error: v.optional(v.string()),
            instanceId: v.string(),
            key: v.string(),
            status: v.union(v.literal("idle"), v.literal("error"), v.literal("cancelled")),
            usage: v.optional(USAGE_VALIDATOR),
        })
        .mutation(async ({ args, ctx: context }): Promise<{ dequeued?: string }> => {
            const now = Date.now();
            const thread = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.key))
                .first();

            if (thread?.["instanceId"] !== args.instanceId) {
                // Not the owner because this run ALREADY handed the thread on:
                // the handoff moved `instanceId` to the successor and left the
                // marker naming this run. Its wake is the one effect that could
                // still be outstanding — the handoff and the wake are separate
                // trips, and a completion whose reply was lost never made the
                // second one. Re-report the successor so the replay can, and
                // dequeue nobody: the queue was already advanced, atomically,
                // by the commit this call is re-applying.
                //
                // The successor is read as the thread's CURRENT owner, which is
                // exact while the marker stands — any writer that took ownership
                // since retires it (see `completedInstanceId`), so a stale
                // pointer cannot be reported here.
                if (thread?.["completedInstanceId"] === args.instanceId && thread["status"] === "running" && typeof thread["instanceId"] === "string") {
                    return { dequeued: thread["instanceId"] };
                }

                // Otherwise: a replay of a completion that ended the thread, or
                // a run that ended while still PARKED — its wait timed out, or
                // it threw before its turn came. The parked case must still
                // release the slot it holds, or an abandoned run occupies a
                // queue position forever and the depth cap eventually refuses
                // every new start on this thread.
                const parked = await context.db
                    .query(RUN_QUEUE_TABLE)
                    .withIndex("byThreadInstance", (q) => q.eq("threadKey", args.key).eq("instanceId", args.instanceId))
                    .first();

                if (parked) {
                    await context.db.delete(parked["_id"] as never);
                }

                return {};
            }

            // Owning the thread is not the same as still running on it. The
            // no-queue branch below leaves `instanceId` naming this run, so a
            // writer that marks the thread live again WITHOUT taking ownership —
            // `agentEnsureThread` dispatched with no `instanceId`, which is what
            // the voice turn and the inbound paths do — leaves a finished run
            // reading as the owner of a thread someone else is holding. Anything
            // parked since then is waiting for that holder, not for this run:
            // waking it would put two writers on the shared `seq` counter, the one
            // thing the queue exists to prevent. Re-applying the terminal status
            // is still right (it is absolute, and the re-dispatch of a completion
            // whose reply was lost has to converge), so only the DEQUEUE is
            // withheld — the holder's own completion hands the thread on.
            const alreadyCompleted = thread["completedInstanceId"] === args.instanceId;
            // `byThread` is `(threadKey, position)`, so an index read is already
            // position-ascending — the head of this list is the FIFO next.
            const queued = alreadyCompleted
                ? []
                : await context.db
                      .query(RUN_QUEUE_TABLE)
                      .withIndex("byThread", (q) => q.eq("threadKey", args.key))
                      .collect();
            const next = queued[0];

            if (!next) {
                await context.db.patch(thread["_id"] as never, {
                    completedInstanceId: args.instanceId,
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
            // The completion marker is written in the SAME mutation as the
            // transfer, which is what makes the pair survive an activation
            // boundary: the wake is a second trip, and a run whose first trip
            // committed but whose reply was lost replays with every in-memory
            // flag reset. The marker is how both this mutation and
            // `agentEnsureThread` recognise that replay for what it is.
            //
            // The finishing run's `error` is CARRIED, not cleared: a run that
            // failed with another queued behind it would otherwise vanish without
            // trace — the thread goes straight from one run to the next and
            // nothing records that the first one failed. The incoming run clears
            // it through its own bootstrap.
            await context.db.patch(thread["_id"] as never, {
                completedInstanceId: args.instanceId,
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

    // KEEP IN SYNC: the arg/return TYPES of the public queries (here and
    // `agentPendingApprovals` above) are mirrored by hand into codegen's
    // `syntheticAgentApiFunctions` (emit/api.ts) — codegen cannot statically
    // read this package's types, and only the arg key sets are drift-tested.
    // Changing an input or return shape here means updating the emitted
    // `api.agents.*` reference types there too.
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
     * The approvals inbox: every human-in-the-loop approval the caller's OWN
     * paused threads are waiting on, newest thread first. PUBLIC and OWNER-SCOPED
     * to the verified identity — an anonymous caller gets `[]`, and ownerless
     * threads are never listed (their only protection is key secrecy, which a
     * cross-thread listing would turn into enumeration). Each item carries the
     * triple `agentResolveApproval` takes.
     *
     * Only a marker minted by the thread's CURRENT instance is returned: an older
     * instance's marker is unresolvable (`agentResolveApproval` rejects any
     * instance that does not own the thread), so surfacing it would hand the
     * client a triple that can only fail.
     *
     * A marker past its `expiresAt` (or with none) is not listed: the grant path refuses it
     * as timed out or as having no deadline, so offering it would advertise a dead action.
     * `limit` is clamped to `[1, MAX_APPROVALS_LIMIT]` and counts threads that hold an
     * approval. Paused threads are scanned newest first, up to `MAX_APPROVALS_SCAN`, so
     * threads paused for a secret do not consume the page. Each thread's message read
     * is a prefix range on `byMessageKey`, so it touches only that instance's
     * markers and never the whole history.
     */
    const agentPendingApprovals = query.input({ limit: v.optional(v.number()) }).query(async ({ args, ctx: context }): Promise<Record<string, unknown>[]> => {
        const { userId } = context.auth;

        if (!userId) {
            return [];
        }

        const threads = await context.db
            .query(THREADS_TABLE)
            .withIndex("byOwnerStatus", (q) => q.eq("owner", userId).eq("status", "awaiting_input"))
            .order("desc")
            .take(MAX_APPROVALS_SCAN);
        // Read once, so every marker is judged against the same instant.
        const now = Date.now();
        const wanted = Math.min(MAX_APPROVALS_LIMIT, Math.max(1, Math.trunc(args.limit ?? DEFAULT_APPROVALS_LIMIT)));
        // One thread's pending approvals. Each thread's read is a prefix range on `byMessageKey`.
        const readApprovals = async (thread: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
            const instanceId = thread["instanceId"] as string | undefined;

            if (instanceId === undefined) {
                return [];
            }

            // Markers are keyed `<instanceId>:approval:<toolCallId>`. `;` is the byte after `:`,
            // so the range `[markerPrefix, markerUpper)` holds exactly this instance's markers.
            const markerPrefix = `${instanceId}:approval:`;
            const markerUpper = `${instanceId}:approval;`;
            const rows = await context.db
                .query(MESSAGES_TABLE)
                .withIndex("byMessageKey", (q) => q.eq("threadKey", thread["key"]).gte("messageKey", markerPrefix).lt("messageKey", markerUpper))
                .collect();

            return (
                rows
                    // A marker past its deadline is still stored until the run's wait settles and deletes it,
                    // and `agentResolveApproval` refuses it as timed out, so it is not offered.
                    .filter((row) => row["status"] === "awaiting_approval" && typeof row["expiresAt"] === "number" && now < row["expiresAt"])
                    .map((row) =>
                        definedColumns({
                            agent: thread["agent"],
                            content: row["content"],
                            instanceId,
                            requestedAt: row["createdAt"],
                            threadKey: thread["key"],
                            threadTitle: thread["title"],
                            threadUpdatedAt: thread["updatedAt"],
                            toolCallId: row["toolCallId"],
                            toolName: row["toolName"],
                        }),
                    )
            );
        };
        // Chunks of `wanted` threads are read in parallel, stopping once `wanted` threads hold an approval.
        const approvals: Record<string, unknown>[] = [];
        let matched = 0;

        for (let start = 0; start < threads.length && matched < wanted; start += wanted) {
            // eslint-disable-next-line no-await-in-loop -- each chunk decides whether the next one is needed
            const perThread = await Promise.all(threads.slice(start, start + wanted).map((thread) => readApprovals(thread)));

            for (const items of perThread) {
                if (items.length > 0 && matched < wanted) {
                    approvals.push(...items);
                    matched += 1;
                }
            }
        }

        return approvals;
    });

    /**
     * Resolve a human-in-the-loop tool approval: deliver the client's
     * approve/reject decision to the paused run so its `waitForEvent` resumes.
     * PUBLIC (a client calls it) but OWNER-GATED — the same `readableThread`
     * gate as the reads, so only the thread's owner may approve. The agent's
     * exported workflow is reached via `ctx.agents` (woven onto the function-run
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
     *
     * `"approve_for_thread"` is an approve that also records a grant for the
     * tool (see `grantApprovalForThread`), so later calls to it in this thread
     * skip the gate. The grant is written here, before the event is sent, so it
     * is committed with the decision and the run never sees a decision whose
     * grant was lost. Only the thread's verified owner may record a grant; on an
     * ownerless thread `"approve"` and `"reject"` still work for any caller.
     */
    const agentResolveApproval = mutation
        .input({
            decision: v.union(v.literal("approve"), v.literal("approve_for_thread"), v.literal("reject")),
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

            // Only the first decision on a call counts. A call with no pending marker was already decided, so this
            // one is refused before a grant is written or an event is sent, a reject included.
            if (!(await approvalIsPending(context.db, args.threadKey, args.instanceId, args.toolCallId))) {
                throw new LunoraError(
                    "CONFLICT",
                    `@lunora/agent: no pending approval for tool call "${args.toolCallId}" on thread "${args.threadKey}" to decide`,
                );
            }

            if (args.decision === "approve_for_thread") {
                // A lasting grant outlives this call, so it takes a verified owner: an ownerless
                // thread is readable by anyone who knows its key, which is fine for a one-off
                // approve or reject but not for skipping the gate on every later call.
                ownedSecretThread(thread, context.auth, "grant a lasting approval for a tool");
                await grantApprovalForThread(context.db, args.threadKey, args.instanceId, args.toolCallId);
            }

            await retireApprovalMarker(context.db, args.threadKey, args.instanceId, args.toolCallId);

            await handle.sendEvent(args.instanceId, {
                payload: {
                    decision: args.decision === "reject" ? "reject" : "approve",
                    toolCallId: args.toolCallId,
                    ...(args.decision === "approve_for_thread" ? { scope: "thread" } : {}),
                    ...(args.note === undefined ? {} : { note: args.note }),
                },
                // Scoped per tool call — see the doc comment above.
                type: `agent-approval:${args.toolCallId}`,
            });

            return { resolved: true };
        });

    /**
     * Store a human-supplied secret and wake the paused `requestSecretTool` call.
     * The request row moves to `supplied` with the host's ref, and the wake-up
     * carries no payload, so neither the ref nor the value reaches the workflow
     * journal or an event. The loop reads the outcome from the row. PUBLIC and
     * OWNER-GATED, fail closed (see {@link ownedSecretThread}). The plaintext
     * transits this mutation's arguments, so the `secret` arg is marked
     * `v.sensitive`: the request log masks it, a rejected value is not echoed, and
     * the client never queues it offline.
     *
     * The host `put` writes through the raw storage handle, not the mutation's own
     * transaction, so the store write can overlap a change to the row. The supply is
     * one compare-and-set on the row it was checked against: the request must still
     * be pending, before its deadline, and owned by the same run. Any failure before
     * that commit discards the value, so a refused supply leaves nothing readable.
     *
     * The wake-up is sent after the commit, and its failure does not undo the supply.
     * Rolling back on a failed wake would be wrong: the wake may have been delivered
     * and only its acknowledgement lost, the run would already have resumed, and it
     * would expire a request whose value the owner just stored. The committed
     * `supplied` row is the authority; the wait settles at its deadline and honours it.
     */
    const agentSupplySecret = mutation
        .input({ secret: v.sensitive(v.string()), threadKey: v.string(), toolCallId: v.string() })
        .mutation(async ({ args, ctx: context }): Promise<{ resolved: boolean }> => {
            const thread = ownedSecretThread(
                await context.db
                    .query(THREADS_TABLE)
                    .withIndex("byKey", (q) => q.eq("key", args.threadKey))
                    .first(),
                context.auth,
                "supply or decline a secret on it",
            );
            const store = secretStoreOf(context);
            const pending = await pendingSecretRequestForCall(context.db, args.threadKey, thread["instanceId"], args.toolCallId, Date.now());
            const slot = pending["toolCallId"] as string;
            const marker = await pendingSecretMarker(context.db, thread, slot);
            const handle = secretWaitHandle(context, thread);
            // The owner is the instance the request was selected for, not whatever the row says on a later read.
            const ownerInstanceId = thread["instanceId"] as string;
            const assertStillOwned = (request: Record<string, unknown>): void => {
                if (request["instanceId"] !== ownerInstanceId) {
                    throw new LunoraError(
                        "CONFLICT",
                        `@lunora/agent: tool call "${args.toolCallId}" on thread "${args.threadKey}" was reopened by a newer run while its secret was being stored`,
                    );
                }
            };
            const checked = await openSecretRequestOrThrow(context.db, args.threadKey, slot, Date.now());

            assertStillOwned(checked);

            let ref: string;

            try {
                ref = await store.put(args.secret, { scope: args.threadKey, ttlMs: secretValueTtlMs(checked["expiresAt"] as number, Date.now()) });
            } catch (error: unknown) {
                if (error instanceof SecretValueTooLargeError) {
                    throw new LunoraError("PAYLOAD_TOO_LARGE", error.message);
                }

                throw error;
            }

            try {
                const request = await openSecretRequestOrThrow(context.db, args.threadKey, slot, Date.now());

                assertStillOwned(request);

                await context.db.patch(request["_id"] as never, { ref, status: "supplied", updatedAt: Date.now() });
                // Retire the marker in this same mutation, so the UI stops offering the form.
                await context.db.delete(marker["_id"] as never);
            } catch (error: unknown) {
                // The row did not move to `supplied`, so nothing will consume the value. A discard that fails must not
                // replace the error that says why the supply was refused: the stored value then waits for its TTL.
                await store.discard(ref).catch(() => undefined);

                throw error;
            }

            try {
                await handle.sendEvent(handle.instanceId, { payload: {}, type: `agent-secret:${slot}` });
            } catch {
                // Deliberately not rethrown: the supply is committed, and the wait settles at its
                // deadline and honours it. The cost is that a lost wake resumes the run late.
            }

            return { resolved: true };
        });

    /**
     * Refuse a human-facing secret request: the request row moves to `declined` and
     * the paused call resumes with a deterministic "declined" result instead of
     * waiting out its timeout. Gated like {@link agentSupplySecret}, so a decline and
     * a supply cannot both win. PUBLIC and OWNER-GATED.
     */
    const agentDeclineSecret = mutation
        .input({ threadKey: v.string(), toolCallId: v.string() })
        .mutation(async ({ args, ctx: context }): Promise<{ resolved: boolean }> => {
            const thread = ownedSecretThread(
                await context.db
                    .query(THREADS_TABLE)
                    .withIndex("byKey", (q) => q.eq("key", args.threadKey))
                    .first(),
                context.auth,
                "supply or decline a secret on it",
            );
            const pending = await pendingSecretRequestForCall(context.db, args.threadKey, thread["instanceId"], args.toolCallId, Date.now());
            const slot = pending["toolCallId"] as string;
            const marker = await pendingSecretMarker(context.db, thread, slot);
            const handle = secretWaitHandle(context, thread);
            const request = await openSecretRequestOrThrow(context.db, args.threadKey, slot, Date.now());

            await context.db.patch(request["_id"] as never, { status: "declined", updatedAt: Date.now() });
            await context.db.delete(marker["_id"] as never);

            try {
                await handle.sendEvent(handle.instanceId, { payload: {}, type: `agent-secret:${slot}` });
            } catch {
                // Deliberately not rethrown, as in supply: the decline is committed, and the wait
                // settles at its deadline and reads it. Failing here would roll the decline back.
            }

            return { resolved: true };
        });

    /**
     * Record a pending secret request when a run pauses on one. INTERNAL and idempotent
     * for the run that owns the row: a replayed pause finds its own row and changes
     * nothing, so a retry never reopens a request that was already answered. A row left
     * by an earlier run that reused this tool-call id is retired: that run has finished,
     * so its value is discarded and the row starts over as pending for this run.
     */
    const agentOpenSecretRequest = asInternal(
        mutation
            .input({
                consumerTool: v.string(),
                expiresAt: v.number(),
                instanceId: v.string(),
                callId: v.optional(v.string()),
                label: v.optional(v.string()),
                threadKey: v.string(),
                toolCallId: v.string(),
                toolName: v.string(),
            })
            .mutation(async ({ args, ctx: context }): Promise<void> => {
                const existing = await secretRequestOf(context.db, args.threadKey, args.toolCallId);
                const now = Date.now();

                if (existing === undefined) {
                    await context.db.insert(REQUESTS_TABLE, {
                        consumerTool: args.consumerTool,
                        createdAt: now,
                        expiresAt: args.expiresAt,
                        instanceId: args.instanceId,
                        // eslint-disable-next-line unicorn/no-null -- `null` is the stored form of "no label"; the column is nullable
                        label: args.label ?? null,
                        status: "pending",
                        callId: args.callId ?? args.toolCallId,
                        threadKey: args.threadKey,
                        toolCallId: args.toolCallId,
                        toolName: args.toolName,
                        updatedAt: now,
                    });

                    return;
                }

                if (existing["instanceId"] === args.instanceId) {
                    return;
                }

                if (typeof existing["ref"] === "string") {
                    // The secret store is absent only on a target that cannot hold a value, where there is nothing to discard.
                    const { agentSecrets } = context as { agentSecrets?: SecretValueHost };

                    await agentSecrets?.discard(existing["ref"]);
                }

                await context.db.patch(existing["_id"] as never, {
                    consumerTool: args.consumerTool,
                    createdAt: now,
                    expiresAt: args.expiresAt,
                    // eslint-disable-next-line unicorn/no-null -- `null` is how `ctx.db.patch` clears a nullable column; `undefined` is rejected
                    label: args.label ?? null,
                    // eslint-disable-next-line unicorn/no-null -- `null` is how `ctx.db.patch` clears a nullable column; `undefined` is rejected
                    ref: null,
                    callId: args.callId ?? args.toolCallId,
                    instanceId: args.instanceId,
                    status: "pending",
                    toolName: args.toolName,
                    updatedAt: now,
                });
            }),
    );

    /**
     * Settle a paused secret request once its wait has ended, by a wake-up or by the
     * timeout, and report the outcome. INTERNAL and idempotent. A pending row moves to
     * `expired` here, so a supply that arrives later is refused; a supply that already
     * landed is honoured even though the wait timed out. Returns the status only, never
     * the ref. A missing row (a thread paused before this table existed) reads as
     * `expired`, so the run fails closed instead of crashing. A row that a later run
     * reopened under the same tool-call id belongs to that run, so the settling run's
     * wait reads as `expired` and the row is left as it is.
     */
    const agentSettleSecretRequest = asInternal(
        mutation
            .input({ instanceId: v.string(), threadKey: v.string(), toolCallId: v.string() })
            .mutation(async ({ args, ctx: context }): Promise<{ status: "declined" | "expired" | "supplied" }> => {
                const request = await secretRequestOf(context.db, args.threadKey, args.toolCallId);

                if (request?.["instanceId"] !== args.instanceId) {
                    return { status: "expired" };
                }

                const { status } = request;

                if (status === "pending") {
                    await context.db.patch(request["_id"] as never, { status: "expired", updatedAt: Date.now() });

                    return { status: "expired" };
                }

                if (status === "supplied" || status === "consumed") {
                    return { status: "supplied" };
                }

                return { status: status === "declined" ? "declined" : "expired" };
            }),
    );

    /**
     * Read a supplied secret for the consuming tool's claimant. INTERNAL: only a tool
     * step dispatches it. Every check runs before the host is touched, so a refused
     * take binds nothing: the request is supplied (or already consumed), the claimant
     * is exactly the step of the consuming tool the request declared
     * (`tool:<consumer>:<consumerCallId>`), and the request belongs to `threadKey`, which
     * the host re-checks as its scope. The host binds the claimant on the first take.
     */
    const agentTakeSecret = asInternal(
        mutation
            .input({ claimant: v.string(), consumerCallId: v.string(), instanceId: v.string(), threadKey: v.string(), toolCallId: v.string() })
            .mutation(async ({ args, ctx: context }): Promise<string | undefined> => {
                const request = await secretRequestOf(context.db, args.threadKey, args.toolCallId);

                if (request?.["instanceId"] !== args.instanceId || (request["status"] !== "supplied" && request["status"] !== "consumed")) {
                    return undefined;
                }

                if (typeof request["ref"] !== "string" || args.claimant !== `tool:${request["consumerTool"] as string}:${args.consumerCallId}`) {
                    return undefined;
                }

                return secretStoreOf(context).take(request["ref"], { claimant: args.claimant, scope: args.threadKey });
            }),
    );

    /**
     * Discard a secret value and mark its request `consumed`. INTERNAL and idempotent.
     * The consuming tool dispatches it only after a take succeeded, so a refused call
     * cannot discard a value that another tool can still use. It discards only for the
     * instance that owns the request: a delayed discard from an older run must not
     * discard the value a newer run was supplied under the same tool-call id.
     */
    const agentDiscardSecret = asInternal(
        mutation.input({ instanceId: v.string(), threadKey: v.string(), toolCallId: v.string() }).mutation(async ({ args, ctx: context }): Promise<void> => {
            const request = await secretRequestOf(context.db, args.threadKey, args.toolCallId);

            // A row a later run reopened holds that run's value, which this run must not discard.
            if (request?.["instanceId"] !== args.instanceId) {
                return;
            }

            if (typeof request["ref"] === "string") {
                await secretStoreOf(context).discard(request["ref"]);
            }

            if (request["status"] === "supplied") {
                await context.db.patch(request["_id"] as never, { status: "consumed", updatedAt: Date.now() });
            }
        }),
    );

    /**
     * A thread's secret requests, so a client can show what is pending, supplied,
     * declined or expired. PUBLIC and OWNER-GATED: an anonymous or ownerless caller is
     * refused, as for supply. Each entry is built field by field, so neither the ref
     * nor a value can appear in it.
     */
    const agentSecretRequests = query
        .input({ threadKey: v.string() })
        .query(
            async ({
                args,
                ctx: context,
            }): Promise<{ createdAt: number; expiresAt: number; label?: string; status: string; toolCallId: string; toolName: string }[]> => {
                const thread = await context.db
                    .query(THREADS_TABLE)
                    .withIndex("byKey", (q) => q.eq("key", args.threadKey))
                    .first();

                ownedSecretThread(thread, context.auth, "list its secret requests");

                const requests = await context.db
                    .query(REQUESTS_TABLE)
                    .withIndex("byThreadCall", (q) => q.eq("threadKey", args.threadKey))
                    .collect();

                const now = Date.now();

                return requests.map((request) => {
                    return {
                        createdAt: request["createdAt"] as number,
                        expiresAt: request["expiresAt"] as number,
                        // Absent (not `null`) when there is no label, so a row from before the column reads the same as one with none.
                        ...(typeof request["label"] === "string" ? { label: request["label"] } : {}),
                        // A pending row past its deadline is one the wait has not settled yet. Supply already refuses it, so the list
                        // reports the status settlement is about to write, and reads the same before and after it runs.
                        status: request["status"] === "pending" && now >= (request["expiresAt"] as number) ? "expired" : (request["status"] as string),
                        // A row written before `callId` existed keeps its call id in `toolCallId`.
                        toolCallId: (request["callId"] ?? request["toolCallId"]) as string,
                        toolName: request["toolName"] as string,
                    };
                });
            },
        );

    /**
     * Whether a thread-scoped approval grant exists for `toolName` on this thread.
     * INTERNAL: the loop reads it from inside a tool's approval-gate step, so the
     * gate's replay-stable decision is memoized with the read itself. Not owner-
     * gated, because the workflow dispatching it carries no caller identity.
     */
    const agentApprovalGranted = asInternal(
        query.input({ key: v.string(), toolName: v.string() }).query(async ({ args, ctx: context }): Promise<boolean> => {
            const grant = await context.db
                .query(GRANTS_TABLE)
                .withIndex("byThreadTool", (q) => q.eq("threadKey", args.key).eq("toolName", args.toolName))
                .first();

            return grant !== null;
        }),
    );

    /**
     * The thread's approval grants — the tools approved for the rest of the thread.
     * PUBLIC and owner-gated like the other reads: an unknown or forbidden thread
     * lists nothing, so key-guessing leaks nothing.
     */
    const agentApprovalGrants = query.input({ key: v.string() }).query(async ({ args, ctx: context }): Promise<{ createdAt: number; toolName: string }[]> => {
        const thread = await context.db
            .query(THREADS_TABLE)
            .withIndex("byKey", (q) => q.eq("key", args.key))
            .first();

        if (readableThread(thread, context.auth) === undefined) {
            return [];
        }

        const grants = await context.db
            .query(GRANTS_TABLE)
            .withIndex("byThreadTool", (q) => q.eq("threadKey", args.key))
            .collect();

        return grants.map((grant) => {
            return { createdAt: grant["createdAt"] as number, toolName: grant["toolName"] as string };
        });
    });

    /**
     * Revoke a thread-scoped approval grant, so the tool's gate applies again to
     * every later call in the thread. PUBLIC and owner-gated. A call whose gate
     * already resolved keeps its decision (the gate is memoized in its step), so a
     * revoke never reaches back into a run that is in flight.
     */
    const agentRevokeApprovalGrant = mutation
        .input({ threadKey: v.string(), toolName: v.string() })
        .mutation(async ({ args, ctx: context }): Promise<{ revoked: boolean }> => {
            const thread = await context.db
                .query(THREADS_TABLE)
                .withIndex("byKey", (q) => q.eq("key", args.threadKey))
                .first();

            if (readableThread(thread, context.auth) === undefined) {
                throw new LunoraError("FORBIDDEN", `@lunora/agent: not allowed to revoke approvals on thread "${args.threadKey}"`);
            }

            const grant = await context.db
                .query(GRANTS_TABLE)
                .withIndex("byThreadTool", (q) => q.eq("threadKey", args.threadKey).eq("toolName", args.toolName))
                .first();

            if (!grant) {
                return { revoked: false };
            }

            await context.db.delete(grant["_id"] as never);

            return { revoked: true };
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
            agentApprovalGranted,
            agentApprovalGrants,
            agentAppendMessage: asInternal(agentAppendMessage),
            agentCompleteRun: asInternal(agentCompleteRun),
            agentEnsureThread: asInternal(agentEnsureThread),
            agentEpisodeRecall: episodic.agentEpisodeRecall,
            agentEpisodeUpsert: episodic.agentEpisodeUpsert,
            agentGraphTraverse: graph.agentGraphTraverse,
            agentGraphUpsert: graph.agentGraphUpsert,
            agentHistory: asInternal(agentHistory),
            agentMessages,
            agentDeleteMessage: asInternal(agentDeleteMessage),
            agentPatchThread: asInternal(agentPatchThread),
            agentPendingApprovals,
            agentResolveApproval,
            agentRevokeApprovalGrant,
            agentRun,
            agentSetState: asInternal(agentSetState),
            agentState,
            agentSupplySecret,
            agentTakeSecret,
            agentThread,
            agentDeclineSecret,
            agentDiscardSecret,
            agentOpenSecretRequest,
            agentSecretRequests,
            agentSettleSecretRequest,
        },
    };
};

export { normalizeEntityName } from "./graph-component";
export type { SandboxComponent, SandboxRegisteredFunction } from "./sandbox-component";
export { sandboxComponent } from "./sandbox-component";
export { agentExtension };
