/**
 * DESIGN-SPIKE PROTOTYPE — see `plans/240-agent-run-queue-design.md`.
 *
 * NOT wired into `component.ts`, `agent-loop.ts`, or any trigger path, and
 * NOT exported from `./index`. This proves out the ordering + seq-claim
 * correctness of a durable per-thread run queue for
 * `defineAgent({ onConcurrentRun: "queue" })` — today that value silently
 * degrades to `"reject"` (`component.ts`'s `agentEnsureThread`). It is a
 * throwaway artifact of the spike, not a shipped feature; production wiring
 * (if this direction is ratified) belongs in `component.ts` alongside the
 * real `agentEnsureThread`/`agentPatchThread` mutations, not here.
 *
 * Mirrors just enough of `agentEnsureThread`'s existing reject/replace logic
 * to add a third, `"queue"` branch, plus the completion-side dequeue that
 * `agent-loop.ts` would call instead of its current terminal `patchThread`.
 * Both mutations assume the same single-threaded-per-DO execution model the
 * real component relies on — see the design doc's "Ordering + seq claim"
 * section for why that's what makes the handoff race-free.
 * @experimental
 */

/** Bounded queue depth — see design doc open question #1 (no config surface yet). */
const MAX_QUEUE_DEPTH = 5;

/** Minimal `ctx.db` shape this prototype needs — same shape `component.ts`'s mutations use. */
interface PrototypeRow extends Record<string, unknown> {
    _id: string;
}

interface PrototypeIndexQuery {
    collect: () => Promise<PrototypeRow[]>;
    first: () => Promise<PrototypeRow | null>;
    order: (direction: "asc" | "desc") => { collect: () => Promise<PrototypeRow[]> };
}

interface PrototypeIndexBuilder {
    eq: (field: string, value: unknown) => PrototypeIndexBuilder;
}

interface PrototypeDatabase {
    insert: (table: string, document: Record<string, unknown>) => Promise<string>;
    patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
    query: (table: string) => { withIndex: (name: string, build: (q: PrototypeIndexBuilder) => unknown) => PrototypeIndexQuery };
    remove: (id: string) => Promise<void>;
}

const THREADS_TABLE = "proto_agent_threads";
const QUEUE_TABLE = "proto_agent_run_queue";

interface EnsureThreadOrQueueArgs {
    agent: string;
    instanceId?: string;
    key: string;
    onConcurrentRun?: "queue" | "reject" | "replace";
}

type EnsureThreadOrQueueResult =
    { created: true } | { created: false } | { created: false; priorInstanceId: string; replaced: true } | { created: false; position: number; queued: true };

/** Thrown in place of the real `LunoraError("CONFLICT", ...)` — message-compatible enough for tests to pattern-match. */
class QueueConflictError extends Error {}

/**
 * The `"queue"` branch, split out of `ensureThreadOrQueue` to keep that
 * function's branching within the repo's cognitive-complexity budget. Called
 * only once `isConcurrentRun` is already known true and `policy === "queue"`.
 */
const enqueueOrThrow = async (
    database: PrototypeDatabase,
    args: EnsureThreadOrQueueArgs & { instanceId: string },
    existing: PrototypeRow,
    now: number,
): Promise<EnsureThreadOrQueueResult> => {
    // Idempotent enqueue: a replay of a still-parked run's bootstrap must
    // return its existing position, not create a duplicate row.
    const alreadyQueued = await database
        .query(QUEUE_TABLE)
        .withIndex("byThreadInstance", (q) => q.eq("threadKey", args.key).eq("instanceId", args.instanceId))
        .first();

    if (alreadyQueued) {
        return { created: false, position: alreadyQueued["position"] as number, queued: true };
    }

    const queuedRows = await database
        .query(QUEUE_TABLE)
        .withIndex("byThread", (q) => q.eq("threadKey", args.key))
        .collect();

    if (queuedRows.length >= MAX_QUEUE_DEPTH) {
        throw new QueueConflictError(
            `@lunora/agent: thread "${args.key}" run queue is full (depth ${String(MAX_QUEUE_DEPTH)}) — rejecting instance "${args.instanceId}"`,
        );
    }

    const position = existing["nextPosition"] as number;

    await database.patch(existing["_id"], { nextPosition: position + 1 });
    await database.insert(QUEUE_TABLE, {
        agent: args.agent,
        enqueuedAt: now,
        instanceId: args.instanceId,
        position,
        threadKey: args.key,
    });

    return { created: false, position, queued: true };
};

/**
 * Mirrors `component.ts`'s `agentEnsureThread`, with the `"queue"` branch
 * implemented instead of degraded to reject. See the design doc for why
 * idempotent-by-`(threadKey, instanceId)` enqueue is required (a workflow
 * replay of a still-parked run re-executes this mutation for real, since
 * `ensureThread` — like the production one — runs outside `step.do`).
 */
const ensureThreadOrQueue = async (database: PrototypeDatabase, args: EnsureThreadOrQueueArgs, now = Date.now()): Promise<EnsureThreadOrQueueResult> => {
    const existing = await database
        .query(THREADS_TABLE)
        .withIndex("byKey", (q) => q.eq("key", args.key))
        .first();

    if (!existing) {
        await database.insert(THREADS_TABLE, {
            agent: args.agent,
            key: args.key,
            nextPosition: 0,
            status: "running",
            updatedAt: now,
            ...(args.instanceId === undefined ? {} : { instanceId: args.instanceId }),
        });

        return { created: true };
    }

    const priorInstanceId = existing["instanceId"] as string | undefined;
    const isConcurrentRun =
        (existing["status"] === "running" || existing["status"] === "awaiting_input") &&
        priorInstanceId !== undefined &&
        (args.instanceId === undefined || args.instanceId !== priorInstanceId);

    if (!isConcurrentRun) {
        // Replay (same instance) or a resumed idle/errored/cancelled thread.
        await database.patch(existing["_id"], {
            status: "running",
            updatedAt: now,
            ...(args.instanceId === undefined ? {} : { instanceId: args.instanceId }),
        });

        return { created: false };
    }

    const policy = args.onConcurrentRun ?? "reject";

    if (policy === "replace") {
        await database.patch(existing["_id"], {
            status: "running",
            updatedAt: now,
            ...(args.instanceId === undefined ? {} : { instanceId: args.instanceId }),
        });

        return { created: false, priorInstanceId, replaced: true };
    }

    if (policy === "queue") {
        if (args.instanceId === undefined) {
            // The id-less inbound-email/inbound-channel dispatch path can't be
            // told apart from anyone else later, so it can't be parked and
            // dequeued by instance id — same honest-reject fallback as an
            // overflowing queue.
            throw new QueueConflictError(
                `@lunora/agent: thread "${args.key}" already has a run in flight (instance "${priorInstanceId}") — cannot queue an id-less dispatch`,
            );
        }

        return enqueueOrThrow(database, { ...args, instanceId: args.instanceId }, existing, now);
    }

    // "reject" (default)
    throw new QueueConflictError(
        `@lunora/agent: thread "${args.key}" already has a run in flight (instance "${priorInstanceId}") — onConcurrentRun="${policy}"`,
    );
};

interface CompleteRunArgs {
    instanceId: string;
    key: string;
    terminalStatus: "cancelled" | "error" | "idle";
}

type CompleteRunResult = { dequeued: undefined } | { dequeued: string };

/**
 * Mirrors what `agent-loop.ts`'s terminal `patchThread` call would become:
 * instead of unconditionally setting the terminal status, check the queue
 * first and — inside this SAME mutation — hand the thread straight to the
 * next parked instance if one is waiting. See the design doc for why doing
 * both in one mutation is what makes the handoff race-free (no window where
 * a third caller can observe an ownerless thread).
 *
 * Idempotent under a replay of the FINISHING run's own completion: guarded on
 * `thread.instanceId === args.instanceId` first, so a second call (after
 * ownership has already moved to the dequeued instance) is a no-op rather
 * than dequeuing a second entry and skipping someone's turn.
 */
const completeRunAndDequeue = async (database: PrototypeDatabase, args: CompleteRunArgs, now = Date.now()): Promise<CompleteRunResult> => {
    const thread = await database
        .query(THREADS_TABLE)
        .withIndex("byKey", (q) => q.eq("key", args.key))
        .first();

    if (thread?.["instanceId"] !== args.instanceId) {
        // Already handed off (a replay of this same completion) or unknown —
        // either way, not this call's job to touch it again.
        return { dequeued: undefined };
    }

    const queuedRows = await database
        .query(QUEUE_TABLE)
        .withIndex("byThread", (q) => q.eq("threadKey", args.key))
        .order("asc")
        .collect();

    const head = queuedRows[0];

    if (!head) {
        await database.patch(thread["_id"], { status: args.terminalStatus, updatedAt: now });

        return { dequeued: undefined };
    }

    await database.remove(head["_id"]);
    await database.patch(thread["_id"], { instanceId: head["instanceId"], status: "running", updatedAt: now });

    return { dequeued: head["instanceId"] as string };
};

export { completeRunAndDequeue, ensureThreadOrQueue, MAX_QUEUE_DEPTH, QueueConflictError };
export type {
    CompleteRunArgs,
    CompleteRunResult,
    EnsureThreadOrQueueArgs,
    EnsureThreadOrQueueResult,
    PrototypeDatabase,
    PrototypeIndexBuilder,
    PrototypeIndexQuery,
    PrototypeRow,
};
