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

/**
 * Streaming sibling of {@link concurrentMap}: run `fn` over `items` with at most
 * `limit` in flight, pulling the next item only as capacity frees.
 *
 * The difference that matters is what is NOT held: `concurrentMap` needs the
 * whole array up front, so feeding it a listing means materialising every entry
 * before any work starts. This drains an iterable incrementally, so a source
 * that pages a large bucket costs `limit` items of memory rather than all of
 * them, and the first item is processed without waiting for the last to be
 * listed. Nothing is returned — a streaming map would have to accumulate a
 * result per item and give the memory straight back.
 *
 * Accepts a sync iterable too, so a source that hands back a plain array needs
 * no special case at the call site.
 *
 * Failure semantics are {@link concurrentMap}'s, unchanged: the first error is
 * recorded, every worker stops pulling and stops starting NEW work, in-flight
 * calls are allowed to settle, and only then is that first error re-thrown.
 * `iterator.return()` is called on the way out so a generator source runs its
 * `finally` blocks and releases whatever it holds open.
 */
export const concurrentForEach = async <T>(items: AsyncIterable<T> | Iterable<T>, limit: number, function_: (item: T) => Promise<void>): Promise<void> => {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError("concurrentForEach: `limit` must be a positive integer");
    }

    const iterator: AsyncIterator<T> | Iterator<T> = Symbol.asyncIterator in items ? items[Symbol.asyncIterator]() : items[Symbol.iterator]();

    let failed = false;
    let firstError: unknown;

    /** Latch the first error only — later ones are fallout from the same failure. */
    const recordFailure = (error: unknown): void => {
        if (!failed) {
            failed = true;
            firstError = error;
        }
    };

    // Every pull chains onto the previous one, so two workers can never be
    // inside `iterator.next()` at the same time. An iterator is not required to
    // tolerate overlapping `next()` calls — a generator throws outright — and
    // `limit` workers all pulling as they free up is exactly the overlap that
    // would trigger it. `.catch()` keeps the chain alive so one rejected pull
    // does not wedge every later one.
    let tail: Promise<unknown> = Promise.resolve();

    const pull = (): Promise<IteratorResult<T>> => {
        const next = tail.then(async () => await iterator.next());

        tail = next.catch(() => undefined);

        return next;
    };

    /**
     * Take the next item, or `undefined` once there is nothing more to do.
     *
     * `failed` is re-checked AFTER the pull as well as before it: a worker can
     * be queued behind another's pull at the moment that other worker fails, and
     * the item it then receives is work that had not started yet.
     */
    const takeNext = async (): Promise<{ item: T } | undefined> => {
        if (failed) {
            return undefined;
        }

        const result = await pull();

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `failed` is set by other concurrent workers; not statically const
        return result.done === true || failed ? undefined : { item: result.value };
    };

    const worker = async (): Promise<void> => {
        for (;;) {
            try {
                // Awaiting in-loop is the point: a worker takes its next item
                // only after its current one settles, which is what bounds the
                // fan-out to `limit` in flight.
                // eslint-disable-next-line no-await-in-loop -- serial await per worker IS the bounded-concurrency mechanism
                const next = await takeNext();

                if (next === undefined) {
                    return;
                }

                // eslint-disable-next-line no-await-in-loop -- see above
                await function_(next.item);
            } catch (error) {
                recordFailure(error);

                return;
            }
        }
    };

    await Promise.all(
        Array.from({ length: limit }, async () => {
            await worker();
        }),
    );

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `failed` is set inside the worker callbacks; not statically const
    if (failed) {
        // Safe to close only here: every worker has returned, so no pull is
        // still in flight to race this. A source that fails to close is not
        // allowed to mask the error that got us here.
        try {
            await iterator.return?.();
        } catch {
            /* the original failure is the one worth reporting */
        }

        throw firstError;
    }
};
