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
 */

/** One queued deletion: the bucket facade to call, and the key on it. */
interface PendingDelete {
    key: string;
    /** The storage facade the key belongs to — the default one, or a `bucket(name)` sub-facade. */
    storage: { delete?: (key: string) => Promise<void> };
}

/**
 * Per-facade queues, keyed on the facade itself.
 *
 * A `WeakMap` rather than a property on the object: `ctx.storage` is handed to
 * user code, and a queue stamped onto it would show up in anything that walks or
 * serializes the context. Keying externally also means the facade a handler sees
 * is exactly the storage surface and nothing else.
 */
const queues = new WeakMap<object, PendingDelete[]>();

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
    const pending: PendingDelete[] = [];

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
                pending.push({ key, storage: inner as PendingDelete["storage"] });
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

        queues.set(facade, pending);

        return facade;
    };

    return wrap(storage);
};

/** How a flush ended, so a caller can assert on it without this module owning a logger. */
export interface DeferredDeleteFlushResult {
    /** How many keys were attempted. */
    attempted: number;
    /** Keys whose delete did not happen, with the reason. Empty when everything succeeded. */
    failures: { error: unknown; key: string }[];
}

/**
 * Delete everything queued on `context.storage`, draining the queue as it goes,
 * and report each failure through `context.log`.
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

    if (!queue || queue.length === 0) {
        return { attempted: 0, failures: [] };
    }

    const draining = queue.splice(0);

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
