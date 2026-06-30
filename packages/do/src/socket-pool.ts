/**
 * Bounded fan-out helper for the ShardDO write-flush paths.
 *
 * `refreshSubscriptions` (per-socket query re-run) and `pokeShapeSubscribers`
 * (per-socket shape diff) both fan one write out to every live socket, and both
 * want the SAME shape: cap how many sockets are processed in parallel, but drain
 * each worker's picks sequentially so a per-send `awaitWsDrain` gate inside
 * `processOne` still applies backpressure to a slow consumer. This is that
 * single, shared loop.
 *
 * Semantics:
 * - Each item is visited EXACTLY once: `concurrency` workers pull from a shared
 *   cursor, so no item is processed twice and none is skipped.
 * - At most `concurrency` (default 8) `processOne` calls are in flight at once.
 *   Larger batches don't help the subscription paths — their handlers spend
 *   their time on the DO's single-threaded SQLite — and risk exhausting the
 *   I/O budget.
 * - Within a worker, items run one at a time (awaited), so a `processOne` that
 *   awaits `awaitWsDrain` before each `ws.send` genuinely paces that socket.
 * - `undefined` is the past-the-end sentinel (an out-of-range index), so callers
 *   must not pass an array containing `undefined` items.
 */
export const runSocketPool = async <T>(items: readonly T[], processOne: (item: T) => Promise<void>, concurrency = 8): Promise<void> => {
    let cursor = 0;

    const worker = async (): Promise<void> => {
        let item = items[cursor];

        cursor += 1;

        while (item !== undefined) {
            // eslint-disable-next-line no-await-in-loop -- each worker drains its picks sequentially; parallelism comes from running `concurrency` workers
            await processOne(item);
            item = items[cursor];
            cursor += 1;
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
};
