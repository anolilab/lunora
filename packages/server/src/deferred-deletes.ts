/**
 * `ctx.storage.deleteAfterCommit(key)` — the object half of a row deletion,
 * deferred until the mutation that removed the row has actually committed.
 *
 * ## Why a mutation cannot just delete
 *
 * `ctx.storage` is `ReadOnlyStorage` in a mutation, and deliberately so: a
 * mutation runs inside the shard's storage transaction, which can roll back. An
 * R2 delete cannot. A mutation that deleted the object and then aborted — an OCC
 * conflict, an RLS denial, a failed row halfway through a batch — would leave the
 * row intact and the bytes gone, which is the one direction that is not
 * recoverable.
 *
 * Without a first-class answer, every application arrives at the same workaround:
 * schedule an action from the mutation and delete there. That works, but it costs
 * a scheduled function per deletion, it is written slightly differently in every
 * codebase, and the ordering guarantee it depends on (the schedule is itself part
 * of the transaction) is not obvious enough to be relied on by accident.
 *
 * ## What this does instead
 *
 * `deleteAfterCommit(key)` records the key on the dispatch and returns. It is not
 * a promise — nothing has been attempted yet, so there is nothing to await, and
 * typing it `void` keeps a caller from believing the object is gone on the next
 * line. The dispatch flushes the queue only after its transaction resolves, so
 * the row deletion commits transactionally and the object cleanup runs ONLY if it
 * did — a rolled-back mutation never reaches the flush, and the queue dies with
 * the context. The flush itself runs off the response path where the host can
 * defer it, so the caller never waits on R2.
 *
 * The trade is that cleanup is no longer synchronous with the row write: an
 * object can briefly outlive its row. Nothing reads an object without its row, so
 * that window is invisible — but it does mean a failed delete leaks bytes rather
 * than failing the mutation, which is why {@link flushDeferredDeletes} reports
 * each failure with its key instead of swallowing it.
 *
 * ## Shape
 *
 * The queue is per-dispatch, not per-shard: it hangs off the `ctx.storage`
 * facade, which `buildCtx` builds once per dispatch. `bucket(name)` returns a
 * facade sharing the same queue, so a delete queued against a named bucket is
 * flushed against that bucket rather than the default one.
 *
 * Everything here is `unknown`-in/`unknown`-out for the same reason
 * `asBucketStorage` is: the storage capability arrives through a thunk cast
 * through `unknown`, and the generated shard casts the result back to the
 * context type. The types that matter are on `MutationStorage` in `./types`.
 */

/** One queued deletion: the bucket facade to call, and the key on it. */
interface PendingDelete {
    key: string;
    /** The storage facade the key belongs to — the default one, or a `bucket(name)` sub-facade. */
    storage: { delete?: (key: string) => Promise<void> };
}

/**
 * Where the queue hangs off the facade. A symbol rather than a string key so it
 * cannot collide with a storage method and does not show up in `Object.keys` of
 * a context a handler logs.
 */
const PENDING = Symbol.for("lunora.storage.pendingDeletes");

interface WithPending {
    [PENDING]?: PendingDelete[];
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

        const facade: Record<string, unknown> = {
            // Spread rather than proxy: the facade is built once per dispatch and
            // read on a hot path, and a Proxy would add a trap to every property
            // access `ctx.storage` sees for the life of the handler.
            ...inner,
            deleteAfterCommit: (key: string): void => {
                // Queued against `inner`, not against this wrapper: the delete is
                // performed later through the object that owns it, so `this` is
                // whatever that implementation expects rather than the facade.
                pending.push({ key, storage: inner as PendingDelete["storage"] });
            },
        };

        if (typeof inner.bucket === "function") {
            facade.bucket = (name: string): unknown => wrap(inner.bucket?.(name));
        }

        (facade as WithPending)[PENDING] = pending;

        return facade;
    };

    return wrap(storage);
};

/** How a flush ended, so the caller can report it without this module owning a logger. */
export interface DeferredDeleteFlushResult {
    /** How many keys were attempted. */
    attempted: number;
    /** Keys whose delete rejected, with the reason. Empty when everything succeeded. */
    failures: { error: unknown; key: string }[];
}

/**
 * Delete everything queued on `storage`, draining the queue as it goes.
 *
 * Draining first means a second flush of the same dispatch is a no-op rather than
 * a second round of deletes — cheap insurance, since the two callers (the normal
 * path and any future retry) cannot both be proven unique from here.
 *
 * Never throws. A flush runs after the transaction committed, so there is no
 * longer anything to fail into: rejecting here could only turn a leaked object
 * into a failed response for a mutation that already succeeded. Failures come
 * back in the result for the caller to log.
 * @param storage the `ctx.storage` facade built by {@link withDeferredDeletes}
 */
export const flushDeferredDeletes = async (storage: unknown): Promise<DeferredDeleteFlushResult> => {
    const queue = (storage as WithPending | undefined)?.[PENDING];

    if (!queue || queue.length === 0) {
        return { attempted: 0, failures: [] };
    }

    const draining = queue.splice(0);

    // `allSettled`, so one missing or unreachable key cannot strand the rest of
    // the batch. Deletes are independent and idempotent, and a batch is whatever
    // one mutation queued, so there is nothing to gain from serialising them.
    // "Missing" is the ordinary case — a retried mutation, or a key some other
    // path already reaped — and R2 does not treat it as an error.
    const outcomes = await Promise.allSettled(draining.map(async ({ key, storage: target }) => target.delete?.(key)));

    const failures = outcomes.flatMap((outcome, index) =>
        outcome.status === "rejected" ? [{ error: outcome.reason as unknown, key: draining[index]?.key ?? "" }] : [],
    );

    return { attempted: draining.length, failures };
};
