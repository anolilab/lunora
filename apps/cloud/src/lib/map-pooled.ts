/** Map `items` through `fn` with at most `concurrency` in flight, preserving order. */
const mapPooled = async <T, R>(items: ReadonlyArray<T>, concurrency: number, function_: (item: T) => Promise<R>): Promise<R[]> => {
    // Assigned by index below, so order is preserved without pre-sizing; the
    // annotation is what types the result, since `Array.from({ length })` alone
    // would widen to `unknown[]`.
    const results: R[] = [];
    let cursor = 0;
    const runWorker = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor;

            cursor += 1;
            // The index is in-bounds by construction (the `while` guards it), but
            // `noUncheckedIndexedAccess` widens the element to `T | undefined`, so
            // the assertion is load-bearing for `tsc` even though the lint rule's
            // view of the types disagrees.
            // eslint-disable-next-line no-await-in-loop, @typescript-eslint/no-unnecessary-type-assertion -- a worker processes its share sequentially (`concurrency` run in parallel); the assertion is required under noUncheckedIndexedAccess
            results[index] = await function_(items[index] as T);
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));

    return results;
};

export default mapPooled;
