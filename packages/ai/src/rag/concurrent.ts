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
 * Deliberately does NOT cancel in-flight work on the first rejection: a failed
 * `index()` may leave a partial vector set behind, and the (idempotent,
 * deterministic-id) retry converges — cancellation would buy nothing but
 * complexity in workerd.
 */
export const concurrentMap = async <T, R>(
    items: ReadonlyArray<T>,
    limit: number,
    function_: (item: T, index: number) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError("concurrentMap: `limit` must be a positive integer");
    }

    const results: R[] = Array.from({ length: items.length });
    let cursor = 0;

    const worker = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor;

            cursor += 1;

            // eslint-disable-next-line no-await-in-loop -- serial await per worker IS the bounded-concurrency mechanism
            results[index] = await function_(items[index] as T, index);
        }
    };

    const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());

    await Promise.all(workers);

    return results;
};
