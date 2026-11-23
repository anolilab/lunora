import { LunoraError } from "@lunora/errors";

import { DEDUP_KEY_GRAMMAR_MESSAGE, isDedupKey } from "../../../shared/dedup-key";

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

    if (!isDedupKey(requested)) {
        throw new LunoraError("INVALID_INPUT", `@lunora/scheduler: ${DEDUP_KEY_GRAMMAR_MESSAGE}`, { status: 400 });
    }

    return requested;
};

export default assertDedupKey;
