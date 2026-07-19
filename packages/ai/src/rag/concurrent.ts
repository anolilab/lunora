/**
 * Upper bound on concurrent embed + upsert calls during `index()`. Mirrors
 * `@lunora/bindings/vectors`' `UPSERT_EMBED_CONCURRENCY`: each chunk upsert
 * triggers a remote embedder call plus a Vectorize subrequest, so an unbounded
 * fan-out over a large document would exhaust Workers' subrequest budget.
 */
export const INDEX_CONCURRENCY = 8;

/**
 * Order-preserving bounded concurrent map: run `fn` over `items` with at most
 * `limit` in flight. Results land at their item's index. Inlined here (not a
 * dependency) — `@lunora/ai` stays free of `@lunora/bindings`.
 *
 * Failure semantics — mirrors `@lunora/bindings/vectors`' `concurrentMap`: on
 * the first rejection this does NOT reject eagerly like `Promise.all`. It
 * records the first error, stops every worker from pulling any NEW item, then
 * waits for all already-in-flight calls to settle before re-throwing that
 * first error. Eager rejection would leave sibling workers still burning
 * embedder calls + Vectorize subrequests for every remaining chunk after the
 * caller's `catch` ran; quiescing first also means a subsequent retry can't
 * race a call this invocation already had in flight. Already-completed work
 * from before the failure is not rolled back — a failed `index()` may leave a
 * partial vector set behind, and the (idempotent, deterministic-id) retry
 * converges.
 */
export const concurrentMap = async <T, R>(
    items: ReadonlyArray<T>,
    limit: number,
    function_: (item: T, index: number) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError("concurrentMap: `limit` must be a positive integer");
    }

    if (items.length === 0) {
        return [];
    }

    const effectiveLimit = Math.max(1, Math.min(limit, items.length));
    const results: R[] = Array.from({ length: items.length });
    let cursor = 0;
    let failed = false;
    let firstError: unknown;

    const worker = async (): Promise<void> => {
        for (;;) {
            // Once any worker has recorded a failure, stop pulling new items so
            // no NEW call starts after the caller may begin handling the error.
            // Calls already awaited below still settle (they are not
            // cancelled), which is what guarantees quiescence by the time this
            // function throws.
            if (failed) {
                return;
            }

            const index = cursor;

            cursor += 1;

            if (index >= items.length) {
                return;
            }

            try {
                // `index < items.length` is guaranteed above, so the indexed
                // read yields a real element. Awaiting in-loop is the point:
                // each worker pulls the next item only after its current task
                // settles, which is what bounds the fan-out to `effectiveLimit`
                // in flight.
                // eslint-disable-next-line no-await-in-loop -- serial await per worker IS the bounded-concurrency mechanism
                results[index] = await function_(items[index] as T, index);
            } catch (error) {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `failed` is set by other concurrent workers; not statically const
                if (!failed) {
                    failed = true;
                    firstError = error;
                }

                return;
            }
        }
    };

    const workers = Array.from({ length: effectiveLimit }, () => worker());

    await Promise.all(workers);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `failed` is set inside the worker callbacks; not statically const
    if (failed) {
        throw firstError;
    }

    return results;
};
