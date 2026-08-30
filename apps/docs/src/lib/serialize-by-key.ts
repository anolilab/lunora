interface KeyedQueue {
    /** Run `task` after everything already queued for `key`. */
    run: <T>(key: string, task: () => Promise<T>) => Promise<T>;
    /** How many keys currently have work in flight. Bounded growth is the point, so it is observable. */
    size: () => number;
}

/**
 * Run tasks one at a time per key, and forget a key once its queue drains.
 *
 * The `/mcp` rate limiter reads a stored count, evaluates, then writes it back,
 * with `await`s in between. Against an in-memory store that read-modify-write is
 * not atomic: concurrent requests for one key can all observe the same prior
 * count, all decide they are under budget, and then overwrite each other — so
 * the limit is only enforced against sequential traffic, which is not the
 * traffic it exists to bound. Chaining per key makes each bucket's updates
 * observe the previous one.
 *
 * Dropping the entry when the queue drains is the other half, and the part that
 * is easy to get wrong: the map is keyed on caller identity, so a version that
 * never deletes grows one permanent entry per caller — the same unbounded-memory
 * hazard the limiter's own store is capped to avoid, on the same public endpoint.
 */
export const serializeByKey = (): KeyedQueue => {
    const pending = new Map<string, Promise<unknown>>();

    return {
        run: async <T>(key: string, task: () => Promise<T>): Promise<T> => {
            const previous = pending.get(key) ?? Promise.resolve();
            const next = previous.then(task);

            // What goes in the map is the *guarded* promise, so one task's
            // rejection cannot break the next caller's link — and the identity
            // check below has to compare against that same guarded promise. It
            // is a different object from `next`, so comparing to `next` never
            // matches and the key is never dropped.
            const guarded = next.catch(() => undefined);

            pending.set(key, guarded);

            try {
                return await next;
            } finally {
                // Only the last task queued for this key clears it; work queued
                // behind us has already replaced the value and must survive.
                if (pending.get(key) === guarded) {
                    pending.delete(key);
                }
            }
        },
        size: () => pending.size,
    };
};
