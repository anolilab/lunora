import { assertScheduleDelay } from "@lunora/scheduler";

/**
 * `ctx.scheduler.runAfter(0, …)` — documented as "the deterministic equivalent
 * of an `afterCommit` hook" — held until the mutation's transaction has actually
 * committed.
 *
 * ## Why a mutation cannot just schedule
 *
 * The scheduler is an RPC to a different Durable Object: `runAt` persists the
 * job and arms an alarm the moment it is called. A mutation runs inside the
 * shard's storage transaction, which can roll back — an OCC conflict, an RLS
 * denial, a validator, a failed row halfway through a batch. The rows go away;
 * the job does not. `insert order; runAfter(0, sendReceipt); patch inventory →
 * ConflictError` sends a receipt for an order that never existed, and with a
 * zero delay the job can dispatch while the transaction is still open.
 *
 * So the facade buffers instead: while a deferral window is open (see
 * {@link beginDeferredSchedules}) a `runAfter`/`runAt` call records the call and
 * returns, and the window's settle either dispatches the buffered calls — in
 * declaration order, after the commit — or drops them.
 *
 * ## The job id
 *
 * `runAfter`/`runAt` answer the job id, and a handler routinely stores it on the
 * row it just wrote so it can `cancel` later. A buffered call has not reached the
 * scheduler yet, so it cannot have the id the scheduler would mint — and a
 * promise resolved at flush time is worse than useless: awaiting it inside the
 * mutation would deadlock on a flush that runs after the handler returns.
 *
 * The facade therefore mints the id itself and passes it to the underlying
 * scheduler when the call is finally made (`@lunora/scheduler`'s `RunOptions.id`,
 * which the SchedulerDO honours as the record's id). The value a handler is
 * handed is the id the job really gets.
 *
 * ## Why the window is open/close rather than "is this a mutation ctx"
 *
 * `ctx.runMutation` hands the CALLER's context to the callee, so a mutation
 * reached from an action runs with the action's `ctx` — and, since that
 * composition opens its own transaction, its schedules must be deferred too
 * while the action's own schedules stay immediate. The window tracks the
 * transaction, not the context's kind; the facade is installed on every dispatch
 * that can host a mutation handler, exactly like the deferred-delete queue.
 */

/** A buffered `runAfter`/`runAt`, ready to be replayed against the real scheduler. */
type PendingSchedule = () => Promise<unknown>;

interface ScheduleQueue {
    /**
     * How many deferral windows are open. `0` means calls go straight through —
     * an action schedules immediately, as documented. Only the OUTERMOST window
     * settles the queue: a nested `runMutation` rides the enclosing transaction's
     * commit, so it must not dispatch (nor discard) on its own.
     */
    depth: number;
    pending: PendingSchedule[];
}

/**
 * Per-facade queues, keyed on the facade itself — a `WeakMap` for the same
 * reason the deferred-delete queue is one: `ctx.scheduler` is handed to user code
 * and a queue stamped onto it would show up in anything that walks the context.
 */
const queues = new WeakMap<object, ScheduleQueue>();

/** The slice of a function context the window needs. */
interface DeferredScheduleContext {
    scheduler?: unknown;
}

/**
 * The scheduler surface the facade wraps — the two methods it intercepts, plus
 * whatever else the concrete scheduler carries (spread through untouched).
 *
 * A structural mirror rather than an import: `@lunora/scheduler`'s `Scheduler`,
 * `@lunora/shard-engine`'s `SchedulerLike` and the test harness's fake all reach
 * here, and their `target`/`args` parameters disagree. `never` parameters accept
 * every one of them while still pinning the shape and the `Promise<string>` a
 * caller depends on.
 */
interface SchedulerLike {
    runAfter: (delayMs: number, target: never, args?: never, options?: never) => Promise<string>;
    runAt: (timestampMs: number, target: never, args?: never, options?: never) => Promise<string>;
}

/**
 * Wrap a scheduler so `runAfter`/`runAt` can be held for a transaction.
 *
 * Call once per dispatch, OUTSIDE the read-stamping wrapper: the spread reads
 * through that proxy's `get` trap, so `get`/`list` stay stamped.
 *
 * Generic so the facade comes back as the SAME scheduler type it was handed:
 * every method but `runAfter`/`runAt` is spread through unchanged, and a caller
 * that had to widen to `unknown` and cast back — the generated shard among them
 * — could not be type-checked against the contract this docblock describes.
 * @param scheduler the `ctx.scheduler` implementation to wrap
 */
export const withDeferredSchedules = <S extends SchedulerLike>(scheduler: S): S => {
    const inner = scheduler as unknown as Record<string, unknown>;
    const queue: ScheduleQueue = { depth: 0, pending: [] };

    const call = (method: "runAfter" | "runAt", when: number, target: unknown, args: unknown, options: unknown): Promise<string> =>
        (inner[method] as (when: number, target: unknown, args: unknown, options: unknown) => Promise<string>).call(inner, when, target, args, options);

    const schedule = (
        method: "runAfter" | "runAt",
        when: number,
        target: unknown,
        args: unknown,
        options: Record<string, unknown> | undefined,
    ): Promise<string> => {
        if (queue.depth === 0) {
            return call(method, when, target, args, options);
        }

        // Minted here so the handler gets the real id synchronously; the
        // underlying scheduler is told to use it when the call is replayed.
        const id = crypto.randomUUID();

        queue.pending.push(async () => call(method, when, target, args, { ...options, id }));

        return Promise.resolve(id);
    };

    // Spread rather than a Proxy — same trade as the deferred-delete facade: the
    // scheduler is built once per dispatch and read on a hot path.
    const facade: Record<string, unknown> = {
        ...inner,
        runAfter: (delayMs: number, target: unknown, args?: unknown, options?: Record<string, unknown>): Promise<string> => {
            // Run here rather than left to the underlying scheduler: buffered, the
            // guard would not fire until the flush — which runs AFTER the commit,
            // turning a caller's bad argument into a 500 on a mutation that already
            // succeeded.
            assertScheduleDelay(delayMs, "ctx.scheduler.runAfter");

            return schedule("runAfter", delayMs, target, args, options);
        },
        runAt: (timestampMs: number, target: unknown, args?: unknown, options?: Record<string, unknown>): Promise<string> =>
            schedule("runAt", timestampMs, target, args, options),
    };

    Object.setPrototypeOf(facade, Object.getPrototypeOf(inner) as object | null);

    queues.set(facade, queue);

    // The facade is `inner` plus two overrides on the same prototype, so it is
    // the same scheduler by every structural measure the caller can apply.
    return facade as unknown as S;
};

/**
 * Open a deferral window on `context.scheduler` and return its settle function.
 *
 * Call it around the transaction, then settle with `true` once the commit has
 * landed (the buffered calls are dispatched, in order) or `false` when it rolled
 * back (they are dropped). Nested windows are counted: only the outermost one
 * settles, so a `ctx.runMutation` inside an open transaction hands its schedules
 * to the span that actually commits them.
 *
 * A context whose scheduler was never wrapped gets an inert settle, so a caller
 * needs no branch.
 * @param context the dispatch context whose `scheduler` carries the queue
 */
export const beginDeferredSchedules = (context: DeferredScheduleContext): ((committed: boolean) => Promise<void>) => {
    const { scheduler } = context;
    const queue = typeof scheduler === "object" && scheduler !== null ? queues.get(scheduler) : undefined;

    if (!queue) {
        return async (): Promise<void> => {};
    }

    queue.depth += 1;

    return async (committed: boolean): Promise<void> => {
        queue.depth -= 1;

        if (queue.depth > 0) {
            return;
        }

        const draining = queue.pending.splice(0);

        if (!committed) {
            return;
        }

        for (const dispatch of draining) {
            // eslint-disable-next-line no-await-in-loop -- declaration order is the contract: `runAfter(0, a)` then `runAfter(0, b)` must enqueue a before b
            await dispatch();
        }
    };
};
