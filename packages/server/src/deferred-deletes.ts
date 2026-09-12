/**
 * `ctx.storage.deleteAfterCommit(key)` — the object half of a row deletion,
 * deferred until the write that removed the row has actually committed.
 *
 * ## Why a mutation cannot just delete
 *
 * `ctx.storage` is read-only in a mutation, and deliberately so: a mutation runs
 * inside the shard's storage transaction, which can roll back. An R2 delete
 * cannot. A mutation that deleted the object and then aborted — an OCC conflict,
 * an RLS denial, a failed row halfway through a batch — would leave the row
 * intact and the bytes gone, which is the one direction that is not recoverable.
 *
 * `deleteAfterCommit(key)` records the key on the dispatch and returns. It is not
 * a promise: nothing has been attempted yet, so there is nothing to await, and
 * typing it `void` keeps a caller from believing the object is gone on the next
 * line. The dispatch flushes the queue only after its transaction resolves, so
 * the row deletion commits transactionally and the object cleanup runs ONLY if it
 * did — a rolled-back write never reaches the flush, and the queue dies with the
 * context.
 *
 * The trade is that cleanup is no longer synchronous with the row write: an
 * object can briefly outlive its row. Nothing reads an object without its row, so
 * that window is invisible — but it does mean a failed delete leaks bytes rather
 * than failing the write, which is why {@link flushDeferredDeletes} reports each
 * failure with its key instead of swallowing it.
 *
 * ## Why every dispatch is wrapped, not just the mutation one
 *
 * The queue hangs off the `ctx.storage` facade, which is built once per dispatch.
 * But `ctx.runMutation` hands the CALLER's context to the callee's handler rather
 * than building a fresh one — so a mutation reached from an action runs with the
 * action's `ctx`. Wrapping only mutation dispatches made that composition throw a
 * bare `TypeError` on a method the handler's own type says exists, and the
 * canonical "do the I/O in an action, then persist in a mutation" shape is
 * exactly the shape that hits it.
 *
 * So the facade is installed for every dispatch that can host a mutation handler,
 * and every one of those dispatches flushes. The alternative — a queue nothing
 * drains — is the worse failure: it leaks silently, with no error to find.
 *
 * ## Why the queue needs windows, not one list per dispatch
 *
 * One list per facade — which is what this was — makes "the dispatch ended" the
 * only thing the flush knows, and that is the wrong question for a queue a NESTED
 * transaction can write to. An action that composes `ctx.runMutation` shares its
 * `ctx`, so the sub-mutation's keys land in the action's list; when that
 * sub-mutation ROLLED BACK the action swallowed the error, returned, and its
 * flush deleted the objects anyway — with the rows that point at them still
 * there. That is precisely the loss this module exists to prevent, and the
 * deferred-schedule buffer next door already had the shape that prevents it.
 *
 * So a queue is a stack of windows over one flushable list: {@link
 * beginDeferredDeletes} opens a window around a transaction, the keys queued
 * while it is the innermost open one are ITS keys, and its settle either hands
 * them to the window that will commit on its behalf (or, with none, to the
 * flushable list) or drops them. Keys queued with no window open — an action's
 * own `deleteAfterCommit` — are flushable immediately, as before.
 */

/** One queued deletion: the bucket facade to call, and the key on it. */
interface PendingDelete {
    key: string;
    /** The storage facade the key belongs to — the default one, or a `bucket(name)` sub-facade. */
    storage: { delete?: (key: string) => Promise<void> };
}

/** One open deferral window: the keys queued while it was the innermost open one. */
interface DeleteWindow {
    /** Cleared by the window's own settle, so {@link enclosingWindow} skips it once its transaction has resolved. */
    open: boolean;
    /** The window that was innermost when this one opened — the transaction whose commit this one rides. */
    parent: DeleteWindow | undefined;
    pending: PendingDelete[];
}

interface DeleteQueue {
    /** Keys that belong to no open transaction — what {@link flushDeferredDeletes} drains. */
    flushable: PendingDelete[];
    /** The innermost window still open, or `undefined` when a queued key is flushable at once. */
    innermost: DeleteWindow | undefined;
}

/**
 * Per-facade queues, keyed on the facade itself.
 *
 * A `WeakMap` rather than a property on the object: `ctx.storage` is handed to
 * user code, and a queue stamped onto it would show up in anything that walks or
 * serializes the context. Keying externally also means the facade a handler sees
 * is exactly the storage surface and nothing else.
 */
const queues = new WeakMap<object, DeleteQueue>();

/**
 * The nearest window up the chain that has not settled yet, if any.
 *
 * Recomputed rather than popped for the reason the deferred-schedule buffer
 * recomputes it: windows settle in whatever order their transactions resolve,
 * which is not necessarily the order they opened — an action need not await the
 * `ctx.runMutation` it composed.
 */
const enclosingWindow = (from: DeleteWindow | undefined): DeleteWindow | undefined => {
    let candidate = from;

    while (candidate !== undefined && !candidate.open) {
        candidate = candidate.parent;
    }

    return candidate;
};

/** The slice of a function context the flush needs: the facade to drain, and somewhere to report. */
interface DeferredDeleteContext {
    log?: { warn: (message: string, fields?: Record<string, unknown>) => void };
    storage?: unknown;
}

/**
 * Wrap a storage facade so it also accepts `deleteAfterCommit(key)`.
 *
 * Call once per dispatch, outside any read-stamping wrapper: `bucket()` delegates
 * to the wrapped facade, so a sub-facade is still stamped by whatever wrapped it.
 * @param storage the bucket-aware facade from `asBucketStorage`
 */
export const withDeferredDeletes = (storage: unknown): unknown => {
    const queue: DeleteQueue = { flushable: [], innermost: undefined };

    const wrap = (target: unknown): unknown => {
        const inner = (target ?? {}) as Record<string, unknown> & { bucket?: (name: string) => unknown };

        // Spread rather than a Proxy: the facade is built once per dispatch and
        // read on a hot path, and a Proxy would add a trap to every property
        // access `ctx.storage` sees for the life of the handler.
        //
        // Spread specifically, NOT `getOwnPropertyDescriptors`: the storage this
        // wraps is itself a read-stamping Proxy, and a spread reads through its
        // `get` trap (so the stamped methods are what get copied) where a
        // descriptor copy would read past it and silently drop the stamping.
        const facade: Record<string, unknown> = {
            ...inner,
            deleteAfterCommit: (key: string): void => {
                // Queued against `inner`, not against this wrapper: the delete is
                // performed later through the object that owns it, so `this` is
                // whatever that implementation expects rather than the facade.
                //
                // Into the window that is innermost RIGHT NOW, so the key is
                // dropped if — and only if — THAT transaction rolls back.
                (queue.innermost?.pending ?? queue.flushable).push({ key, storage: inner as PendingDelete["storage"] });
            },
        };

        // A spread copies own enumerable properties only. The storage facades
        // this ships with are closure-built literals, so that is all of them —
        // but a caller supplying a class instance would otherwise lose every
        // prototype method here, in mutations only. Re-parenting keeps them
        // reachable. (A method that touches private fields still will not work
        // through a copy; a storage facade should expose own-property methods.)
        Object.setPrototypeOf(facade, Object.getPrototypeOf(inner) as object | null);

        if (typeof inner.bucket === "function") {
            facade.bucket = (name: string): unknown => wrap(inner.bucket?.(name));
        }

        queues.set(facade, queue);

        return facade;
    };

    return wrap(storage);
};

/**
 * Open a deferral window on `context.storage` and return its settle function.
 *
 * Call it around a transaction, then settle with `true` once the commit has
 * landed — the keys queued inside become flushable — or `false` when it rolled
 * back, which DROPS them. An R2 delete cannot be undone, so a key whose queuing
 * transaction never committed must never reach {@link flushDeferredDeletes}: the
 * row that points at the object is still there.
 *
 * The window owns the keys queued while IT was the innermost open one, so a
 * rollback drops those and nothing else; on a commit an enclosing window takes
 * them over, which is how a `ctx.runMutation` inside an open transaction hands
 * its keys to the span that actually commits them.
 *
 * Synchronous, and it never throws: it only moves entries between lists, and it
 * runs on the rollback path of a dispatch that is already failing.
 *
 * A context whose storage was never wrapped gets an inert settle, so a caller
 * needs no branch.
 * @param context the dispatch context whose `storage` carries the queue
 */
export const beginDeferredDeletes = (context: unknown): ((committed: boolean) => void) => {
    const { storage } = (context ?? {}) as DeferredDeleteContext;
    const queue = typeof storage === "object" && storage !== null ? queues.get(storage) : undefined;

    if (!queue) {
        return (): void => {};
    }

    const opened: DeleteWindow = { open: true, parent: queue.innermost, pending: [] };

    queue.innermost = opened;

    // Idempotent without a guard: the settle empties `pending`, so a second call
    // has nothing to hand off and nothing to drop.
    return (committed: boolean): void => {
        opened.open = false;

        if (queue.innermost === opened) {
            queue.innermost = enclosingWindow(opened.parent);
        }

        const draining = opened.pending.splice(0);

        if (!committed || draining.length === 0) {
            return;
        }

        // SQLite-in-DO has no savepoints: a nested dispatch shares the enclosing
        // BEGIN/COMMIT span, so its keys are not safe to delete until that span
        // commits either.
        (enclosingWindow(opened.parent)?.pending ?? queue.flushable).push(...draining);
    };
};

/** How a flush ended, so a caller can assert on it without this module owning a logger. */
export interface DeferredDeleteFlushResult {
    /** How many keys were attempted. */
    attempted: number;
    /** Keys whose delete did not happen, with the reason. Empty when everything succeeded. */
    failures: { error: unknown; key: string }[];
}

/**
 * Delete everything queued on `context.storage` that belongs to no open
 * transaction, draining the queue as it goes, and report each failure through
 * `context.log`.
 *
 * Keys still inside an OPEN window are left where they are: their transaction
 * has not resolved, so whether they may be deleted is not yet known. Settling
 * that window (see {@link beginDeferredDeletes}) is what makes them flushable.
 *
 * Draining first means a second flush of the same dispatch is a no-op rather than
 * a second round of deletes.
 *
 * Never throws. A flush runs after the write committed, so there is no longer
 * anything to fail into: rejecting here could only turn a leaked object into a
 * failed response for a write that already succeeded. Failures are logged and
 * also returned, so a dispatch can call this and ignore the result.
 * @param context the dispatch context; a context with no queued deletes is a no-op
 */
export const flushDeferredDeletes = async (context: unknown): Promise<DeferredDeleteFlushResult> => {
    const { log, storage } = (context ?? {}) as DeferredDeleteContext;
    const queue = typeof storage === "object" && storage !== null ? queues.get(storage) : undefined;

    if (!queue || queue.flushable.length === 0) {
        return { attempted: 0, failures: [] };
    }

    const draining = queue.flushable.splice(0);

    // `allSettled`, so one unreachable key cannot strand the rest of the batch.
    // Deletes are independent and idempotent, and a batch is whatever one write
    // queued, so there is nothing to gain from serialising them. A key that is
    // already gone is the ordinary case — a retried write, or a key some other
    // path reaped — and R2 does not treat it as an error.
    const outcomes = await Promise.allSettled(
        draining.map(async ({ key, storage: target }) => {
            if (typeof target.delete !== "function") {
                // The no-storage stub. Every other method on it throws "no storage
                // configured"; reporting this as a failure keeps the one storage
                // call that cannot throw from being the one that says nothing.
                throw new TypeError("ctx.storage: no storage configured, so the object was not deleted");
            }

            await target.delete(key);
        }),
    );

    const failures = outcomes.flatMap((outcome, index) =>
        outcome.status === "rejected" ? [{ error: outcome.reason as unknown, key: draining[index]?.key ?? "" }] : [],
    );

    for (const failure of failures) {
        log?.warn("ctx.storage.deleteAfterCommit: delete failed, object leaked", { error: String(failure.error), key: failure.key });
    }

    return { attempted: draining.length, failures };
};
