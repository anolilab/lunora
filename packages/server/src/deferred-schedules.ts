import { assertScheduleDelay, assertScheduleInstant, resolveScheduleId } from "@lunora/scheduler";

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
 * The facade therefore decides the id itself — through `resolveScheduleId`, the
 * same rule the SchedulerDO applies, so a caller's own `options.id` is honoured
 * exactly where the DO would honour it — and passes it to the underlying
 * scheduler when the call is finally made (`@lunora/scheduler`'s `RunOptions.id`).
 * The value a handler is handed is the id the job really gets, deferred or not:
 * outside a mutation the id came from the caller or the DO, and inside one it
 * must answer the same way rather than silently replacing it with a fresh UUID.
 *
 * ## Why the window is open/close rather than "is this a mutation ctx"
 *
 * `ctx.runMutation` hands the CALLER's context to the callee, so a mutation
 * reached from an action runs with the action's `ctx` — and, since that
 * composition opens its own transaction, its schedules must be deferred too
 * while the action's own schedules stay immediate. The window tracks the
 * transaction, not the context's kind; the facade is installed on every dispatch
 * that can host a mutation handler, exactly like the deferred-delete queue.
 *
 * ## Why each window owns its own buffer
 *
 * One buffer per FACADE with a depth counter — which is what this was — makes
 * every transaction reachable through a context share one list, and the two
 * halves of that are both wrong. A window that settles as rolled back while
 * another is still open used to return without draining, so its jobs stayed in
 * the shared list and the next window to commit dispatched them: work whose
 * writes are gone. And the mirror image, an outermost rollback, spliced the
 * whole list — discarding jobs a sibling had already committed. A ctx is shared
 * (`ctx.runMutation` hands it down) and an action need not await the mutation it
 * composes, so both orderings are reachable from ordinary code.
 *
 * So a window is a buffer: the calls made while it is the innermost open one are
 * its own, a rollback drops only those, and a commit either dispatches them (no
 * enclosing window) or hands them to the window that will commit on its behalf.
 */

/** A buffered `runAfter`/`runAt`, ready to be replayed against the real scheduler. */
type PendingSchedule = () => Promise<unknown>;

/** One open deferral window: one transaction's buffered calls. */
interface ScheduleWindow {
    /** Cleared by the window's own settle, so a second settle is a no-op rather than a second drain. */
    open: boolean;
    /** The window that was innermost when this one opened — the transaction whose commit this one rides. */
    parent: ScheduleWindow | undefined;
    pending: PendingSchedule[];
}

interface ScheduleQueue {
    /**
     * The innermost window still open, or `undefined` when calls go straight
     * through — an action schedules immediately, as documented.
     */
    innermost: ScheduleWindow | undefined;
}

/**
 * Per-facade queues, keyed on the facade itself — a `WeakMap` for the same
 * reason the deferred-delete queue is one: `ctx.scheduler` is handed to user code
 * and a queue stamped onto it would show up in anything that walks the context.
 */
const queues = new WeakMap<object, ScheduleQueue>();

/** The nearest window up the chain that has not settled yet, if any. */
const enclosingWindow = (from: ScheduleWindow | undefined): ScheduleWindow | undefined => {
    let candidate = from;

    while (candidate !== undefined && !candidate.open) {
        candidate = candidate.parent;
    }

    return candidate;
};

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
    const queue: ScheduleQueue = { innermost: undefined };

    const call = (method: "runAfter" | "runAt", when: number, target: unknown, args: unknown, options: unknown): Promise<string> =>
        (inner[method] as (when: number, target: unknown, args: unknown, options: unknown) => Promise<string>).call(inner, when, target, args, options);

    const schedule = (
        method: "runAfter" | "runAt",
        when: number,
        target: unknown,
        args: unknown,
        options: Record<string, unknown> | undefined,
    ): Promise<string> => {
        const open = queue.innermost;

        if (open === undefined) {
            return call(method, when, target, args, options);
        }

        // Decided here so the handler gets the real id synchronously; the
        // underlying scheduler is told to use it when the call is replayed. A
        // caller's own `options.id` survives — `resolveScheduleId` is the rule the
        // SchedulerDO applies, so the id answered here is the id the record is
        // stored under, and an id already taken still reaches the DO's refusal.
        const id = resolveScheduleId(options?.id);

        // Buffered against the window that is innermost RIGHT NOW, so it is
        // dropped only if THAT transaction rolls back.
        open.pending.push(async () => call(method, when, target, args, { ...options, id }));

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
        runAt: (timestampMs: number, target: unknown, args?: unknown, options?: Record<string, unknown>): Promise<string> => {
            // `runAfter`'s bound, in absolute terms, and run HERE for the same
            // reason: buffered, the underlying scheduler's guard would not fire
            // until the flush, after the commit.
            assertScheduleInstant(timestampMs, Date.now(), "ctx.scheduler.runAt");

            return schedule("runAt", timestampMs, target, args, options);
        },
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
 * back (they are dropped). The window owns the calls made while IT was the
 * innermost open one, so a rollback drops those and nothing else; on a commit an
 * enclosing window takes them over, which is how a `ctx.runMutation` inside an
 * open transaction hands its schedules to the span that actually commits them.
 *
 * A context whose scheduler was never wrapped gets an inert settle, so a caller
 * needs no branch.
 *
 * The settle NEVER stops early. It runs after the commit, so a job that fails to
 * enqueue can no longer fail the write that queued it — and abandoning the rest
 * of the batch on the first failure loses jobs the caller was told (by the id it
 * was handed) were scheduled. So every buffered call is attempted, in declaration
 * order, and what failed is reported once at the end — as itself when one job
 * failed, so its code and status survive, and as an `AggregateError` when several
 * did.
 * The caller's own post-commit work must still run: a settle that throws does not
 * excuse skipping the deferred-delete flush behind it.
 * @param context the dispatch context whose `scheduler` carries the queue
 */
export const beginDeferredSchedules = (context: DeferredScheduleContext): ((committed: boolean) => Promise<void>) => {
    const { scheduler } = context;
    const queue = typeof scheduler === "object" && scheduler !== null ? queues.get(scheduler) : undefined;

    if (!queue) {
        return async (): Promise<void> => {};
    }

    const opened: ScheduleWindow = { open: true, parent: queue.innermost, pending: [] };

    queue.innermost = opened;

    return async (committed: boolean): Promise<void> => {
        if (!opened.open) {
            return;
        }

        opened.open = false;

        // Windows settle in whatever order their transactions resolve, which is not
        // necessarily the order they opened: an action can leave a `ctx.runMutation`
        // un-awaited. So the innermost is recomputed rather than popped.
        if (queue.innermost === opened) {
            queue.innermost = enclosingWindow(opened.parent);
        }

        const draining = opened.pending.splice(0);

        if (!committed || draining.length === 0) {
            return;
        }

        const enclosing = enclosingWindow(opened.parent);

        if (enclosing !== undefined) {
            // SQLite-in-DO has no savepoints: a nested dispatch shares the enclosing
            // BEGIN/COMMIT span, so it cannot commit — and must not schedule — alone.
            enclosing.pending.push(...draining);

            return;
        }

        const failures: unknown[] = [];

        for (const dispatch of draining) {
            try {
                // eslint-disable-next-line no-await-in-loop -- declaration order is the contract: `runAfter(0, a)` then `runAfter(0, b)` must enqueue a before b
                await dispatch();
            } catch (error) {
                failures.push(error);
            }
        }

        const [first, ...rest] = failures;

        if (first !== undefined) {
            // A lone failure is rethrown AS ITSELF: the SchedulerDO's refusals are
            // coded (`DUPLICATE_SCHEDULE_ID`, `INVALID_INPUT`) and that code decides
            // the status and whether the message survives redaction, all of which an
            // aggregate would bury. Several become one error naming them together,
            // because there is no single answer to give.
            throw rest.length === 0
                ? (first as Error)
                : new AggregateError(
                      failures,
                      `ctx.scheduler: ${String(failures.length)} of ${String(draining.length)} deferred jobs failed to reach the scheduler after the commit`,
                  );
        }
    };
};
