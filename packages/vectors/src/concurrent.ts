/**
 * Cap on parallel embedder/Vectorize fan-out within a single write or batch.
 * Shared by `upsertMany` (the batch path) and the per-mutation sync hook so
 * both bound their fan-out identically rather than letting one path spawn an
 * unbounded number of concurrent subrequests.
 */
export const UPSERT_EMBED_CONCURRENCY = 8;

/**
 * Map `items` through `fn` with bounded parallelism — at most `limit` calls in
 * flight at once. Preserves input order in the output. Written inline to avoid
 * a `p-limit` dependency.
 */
export const concurrentMap = async <T, U>(items: ReadonlyArray<T>, limit: number, function_: (item: T, index: number) => Promise<U>): Promise<U[]> => {
    if (items.length === 0) {
        return [];
    }

    const effectiveLimit = Math.max(1, Math.min(limit, items.length));
    const results: U[] = Array.from({ length: items.length });
    let cursor = 0;

    const workers = Array.from({ length: effectiveLimit }, async () => {
        for (;;) {
            const index = cursor;

            cursor += 1;

            if (index >= items.length) {
                return;
            }

            // `index < items.length` is guaranteed above, so the indexed read
            // yields a real element. Awaiting in-loop is the point: each worker
            // pulls the next item only after its current task settles, which is
            // what bounds the fan-out to `effectiveLimit` in flight.
            // eslint-disable-next-line no-await-in-loop -- sequential by design: bounds concurrency
            results[index] = await function_(items[index] as T, index);
        }
    });

    await Promise.all(workers);

    return results;
};
