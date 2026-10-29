/**
 * The row cap on one batch write, shared by the shard writer (`@lunora/shard-engine`)
 * and the RLS middleware (`@lunora/server`), which re-checks it because its
 * `deleteMany`/`patchMany` loop per id instead of delegating to the writer's batch method.
 */

/**
 * Default cap on the rows a single batch write (`insertMany`/`deleteMany`/`patchMany`,
 * and the matches of `deleteWhere`/`patchWhere`) accepts. Keeps a batch well under the
 * Durable Object request/CPU-burst limits and turns an accidental oversized payload into
 * a clear up-front error instead of a degraded mutation. Override per call via
 * `options.limit`; callers with larger sets should chunk.
 */
const DEFAULT_BATCH_LIMIT = 500;

/** Builds the caller's own error for a refused batch: this file cannot import `@lunora/errors`. */
type BatchLimitError = (message: string) => Error;

/**
 * The cap a batch call runs under: `limit`, or {@link DEFAULT_BATCH_LIMIT} when unset.
 * `Infinity` lifts the cap; any other limit that is not a non-negative integer throws.
 */
const resolveBatchCap = (limit: number | undefined, op: string, toError: BatchLimitError): number => {
    if (limit !== undefined && limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 0)) {
        throw toError(`${op}: batch limit must be a non-negative integer`);
    }

    return limit ?? DEFAULT_BATCH_LIMIT;
};

/** Throws when a batch of `count` rows exceeds `cap`. */
const assertWithinBatchCap = (count: number, cap: number, op: string, toError: BatchLimitError): void => {
    if (count > cap) {
        throw toError(`${op}: batch of ${String(count)} exceeds the limit of ${String(cap)} (raise options.limit or chunk the call)`);
    }
};

export type { BatchLimitError };
export { assertWithinBatchCap, DEFAULT_BATCH_LIMIT, resolveBatchCap };
