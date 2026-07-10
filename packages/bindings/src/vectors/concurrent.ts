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
 *
 * Failure semantics — IMPORTANT: on the first rejection this does NOT reject
 * eagerly like `Promise.all`. It records the first error, stops every worker
 * from pulling any NEW item, then waits for all already-in-flight calls to
 * settle before re-throwing that first error. Eager rejection would leave
 * sibling calls running past the caller's `catch`; the vector sync hook relies
 * on quiescence so its compensating deletes can't race a still-in-flight upsert
 * (an upsert landing after its index's compensation would leave a stale vector).
 */
export const concurrentMap = async <T, U>(items: ReadonlyArray<T>, limit: number, function_: (item: T, index: number) => Promise<U>): Promise<U[]> => {
    if (items.length === 0) {
        return [];
    }

    const effectiveLimit = Math.max(1, Math.min(limit, items.length));
    const results: U[] = Array.from({ length: items.length });
    let cursor = 0;
    let failed = false;
    let firstError: unknown;

    const workers = Array.from({ length: effectiveLimit }, async () => {
        for (;;) {
            // Once any worker has recorded a failure, stop pulling new items so
            // no NEW call starts after the caller may begin compensating. Calls
            // already awaited below still settle (they are not cancelled), which
            // is what guarantees quiescence by the time this function throws.
            if (failed) {
                return;
            }

            const index = cursor;

            cursor += 1;

            if (index >= items.length) {
                return;
            }

            try {
                // `index < items.length` is guaranteed above, so the indexed read
                // yields a real element. Awaiting in-loop is the point: each worker
                // pulls the next item only after its current task settles, which is
                // what bounds the fan-out to `effectiveLimit` in flight.
                // eslint-disable-next-line no-await-in-loop -- sequential by design: bounds concurrency
                results[index] = await function_(items[index] as T, index);
            } catch (error) {
                if (!failed) {
                    failed = true;
                    firstError = error;
                }

                return;
            }
        }
    });

    await Promise.all(workers);

    if (failed) {
        throw firstError;
    }

    return results;
};
