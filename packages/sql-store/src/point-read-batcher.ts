/**
 * Microtask coalescing for point reads against a remote SQL store.
 *
 * A shard-local `ctx.db.get` is a synchronous SQLite lookup, so issuing N of
 * them costs nothing much. Against a `.global()` backend — D1, or Postgres/
 * MySQL through Hyperdrive — every one of them is a network round-trip, and the
 * idiomatic join pattern
 *
 * ```ts
 * const authors = await Promise.all(ids.map((id) => ctx.db.get(id)));
 * ```
 *
 * pays N of them serially-ish for what a single `WHERE id IN (…)` could answer.
 * That is the difference between one round-trip and one hundred.
 *
 * `Promise.all` starts every `get` in the same tick, so the batcher simply
 * collects the ids requested before the microtask queue drains and issues one
 * fetch for the lot. Callers see the ordinary per-id promise; nothing about the
 * `ctx.db.get` contract changes.
 *
 * Batching is per (table, tick): a request for a different table opens its own
 * batch, since the SQL is table-specific. Batches are capped so a pathological
 * fan-out cannot build an unbounded `IN (…)` list — the overflow simply forms
 * the next batch.
 */

/**
 * How many ids one coalesced fetch may ask for. Beyond this, a new batch opens.
 * Matches the chunk size the relation pre-resolver already uses for its
 * `IN (…)` lists, which is sized against D1's documented bound-parameter limit.
 */
const DEFAULT_MAX_BATCH = 50;

interface PendingRead<Row> {
    reject: (error: unknown) => void;
    resolve: (row: Row | undefined) => void;
}

interface PointReadBatcherOptions {
    /** Upper bound on ids per fetch (default {@link DEFAULT_MAX_BATCH}). */
    maxBatch?: number;
}

/**
 * Fetch every row named by `ids` from `table`, keyed by id. A missing id must
 * simply be absent from the map — the batcher resolves it to `undefined`.
 */
type FetchMany<Row> = (table: string, ids: string[]) => Promise<Map<string, Row>>;

interface PointReadBatcher<Row> {
    /** Read one row, coalesced with every other `load` issued in the same tick. */
    load: (table: string, id: string) => Promise<Row | undefined>;
}

/**
 * Build a batcher over `fetchMany`.
 *
 * The returned `load` never rejects for a missing row (it resolves `undefined`); it
 * rejects only if the underlying fetch throws, and then every id in that batch
 * rejects with the same error — matching what N independent reads would have
 * done had they all failed.
 */
const createPointReadBatcher = <Row>(fetchMany: FetchMany<Row>, options: PointReadBatcherOptions = {}): PointReadBatcher<Row> => {
    // A non-positive size would leave the chunk loop's `offset += maxBatch`
    // never advancing — an infinite loop holding every caller's promise open.
    const requested = options.maxBatch ?? DEFAULT_MAX_BATCH;
    const maxBatch = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_MAX_BATCH;

    /** Ids awaiting the next flush, per table. Several callers may want the same id. */
    const pending = new Map<string, Map<string, PendingRead<Row>[]>>();
    let scheduled = false;

    const flushTable = async (table: string, waiters: Map<string, PendingRead<Row>[]>): Promise<void> => {
        const ids = [...waiters.keys()];

        for (let offset = 0; offset < ids.length; offset += maxBatch) {
            const chunk = ids.slice(offset, offset + maxBatch);

            try {
                // eslint-disable-next-line no-await-in-loop -- chunks are sequential on purpose: an unbounded fan-out of concurrent queries is the problem this guards against
                const rows = await fetchMany(table, chunk);

                for (const id of chunk) {
                    const row = rows.get(id);

                    for (const waiter of waiters.get(id) ?? []) {
                        waiter.resolve(row);
                    }
                }
            } catch (error) {
                for (const id of chunk) {
                    for (const waiter of waiters.get(id) ?? []) {
                        waiter.reject(error);
                    }
                }
            }
        }
    };

    const flush = (): void => {
        scheduled = false;

        const batches = [...pending.entries()];

        pending.clear();

        for (const [table, waiters] of batches) {
            // Every waiter's promise is settled inside `flushTable`, which
            // catches its own fetch errors — the guard below exists only so an
            // unexpected throw can never surface as an unhandled rejection.
            flushTable(table, waiters).catch(() => undefined);
        }
    };

    return {
        async load(table, id) {
            return new Promise<Row | undefined>((resolve, reject) => {
                let waiters = pending.get(table);

                if (!waiters) {
                    waiters = new Map<string, PendingRead<Row>[]>();
                    pending.set(table, waiters);
                }

                const existing = waiters.get(id);

                if (existing) {
                    existing.push({ reject, resolve });
                } else {
                    waiters.set(id, [{ reject, resolve }]);
                }

                if (!scheduled) {
                    scheduled = true;
                    queueMicrotask(flush);
                }
            });
        },
    };
};

export { createPointReadBatcher, DEFAULT_MAX_BATCH };
export type { FetchMany, PointReadBatcher, PointReadBatcherOptions };
