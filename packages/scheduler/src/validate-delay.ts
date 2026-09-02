import { LunoraError } from "@lunora/errors";

/**
 * Reject a `delayMs` a scheduler cannot act on, before it reaches the
 * SchedulerDO.
 *
 * A `NaN`/`Infinity` delay serializes to `null` through JSON and lands as a
 * malformed `scheduledFor`; a negative one schedules into the past. Both are the
 * caller's argument, so the answer has to name the argument — which is why the
 * code is `INVALID_INPUT` (400) and not `INTERNAL`: `toErrorBody` replaces an
 * internal-coded message with "Internal error", redacting the one sentence that
 * says what to fix.
 *
 * Exported because four surfaces enforce it — `createScheduler().runAfter`,
 * `createWorkpool().enqueue`, `@lunora/server`'s deferred-schedule facade (which
 * must reject BEFORE the transaction commits, not at flush time) and
 * `@lunora/testing`'s fake scheduler. They used to restate it and threw three
 * different codes between them, so a test written against the harness caught one
 * code while production threw another.
 * @param delayMs the delay to validate
 * @param surface what to name in the message — the call the delay was passed to (e.g. `"ctx.scheduler.runAfter"`)
 */
const assertScheduleDelay = (delayMs: number, surface: string): void => {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
        throw new LunoraError("INVALID_INPUT", `${surface}: \`delayMs\` must be a non-negative finite number`);
    }
};

export default assertScheduleDelay;
