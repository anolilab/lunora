import { LunoraError } from "@lunora/errors";

/** The workflow engine's instance-id grammar and its 100-char ceiling: a dedup key is spent verbatim as an instance id. */
const DEDUP_KEY_PATTERN = /^\w[\w-]{0,99}$/u;

/**
 * Refuse a caller's `RunOptions.dedupKey` the receivers cannot carry, or pass it through.
 *
 * Exported for the same reason `resolveScheduleId` is: the SchedulerDO applies it when the record
 * is written, and `@lunora/server`'s deferred-schedule facade applies it when the call is buffered,
 * inside the mutation, so a bad key rolls the mutation back instead of parking a committed job.
 * @param requested the caller's `RunOptions.dedupKey`, if any
 * @throws LunoraError `INVALID_INPUT` when `requested` is supplied and does not match the grammar
 */
const assertDedupKey = (requested: unknown): string | undefined => {
    if (requested === undefined) {
        return undefined;
    }

    if (typeof requested !== "string" || !DEDUP_KEY_PATTERN.test(requested)) {
        throw new LunoraError("INVALID_INPUT", "@lunora/scheduler: `dedupKey` must match ^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$", { status: 400 });
    }

    return requested;
};

export default assertDedupKey;
