import { LunoraError } from "@lunora/errors";

import { toBase64Url } from "../../../shared/base64";

/**
 * Shape a caller-supplied job id must have to be accepted: the alphabet shared by
 * base64url ids and UUIDs, nothing that could collide with the `:` separators in
 * `id:<id>` / `t:<padded>:<id>`, and a LEADING character Cloudflare Workflows
 * accepts.
 *
 * That last clause is not cosmetic. The id is handed to `WorkflowBinding.create({
 * id })` verbatim (`@lunora/runtime`'s `startWorkflowInstance`), and the engine
 * validates instance ids against `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` — a leading `-`
 * is a hard rejection, it is not a duplicate-instance error, so the scheduler
 * retries the identical record `MAX_RETRY_ATTEMPTS` times and parks it under
 * `dead:`. `-` is legal everywhere but position 0, hence `\w` then `[\w-]`.
 */
const SCHEDULE_ID_PATTERN = /^\w[\w-]{0,63}$/u;

/** base64url's index 62 IS `-` (RFC 4648 §5) — legal everywhere but position 0. */
const LEADING_DASH = /^-/u;

/**
 * The id a new record is stored under: the caller's, or a freshly minted one when
 * they did not name it.
 *
 * A caller id that is not a safe key segment is REFUSED, not replaced.
 * `RunOptions.id` is not an idempotency key — an id already scheduled answers
 * `409 DUPLICATE_SCHEDULE_ID` — so quietly swapping an invalid one for a random
 * id made `runAt(ts, ref, args, { id: "-daily-2026-09-06" })` mint a fresh id on
 * every call and run the job once per call, where naming it was the caller's way
 * of saying "at most once".
 *
 * Minting swaps a leading `-` for `_` rather than re-rolling: 1 in 64 minted ids
 * led with one and was refused by the workflow engine on dispatch. `_` is in the
 * engine's leading class, the swap is a single pass, and 96 random bits stay 96
 * random bits everywhere but that first character.
 *
 * Exported because two surfaces have to agree on it. The SchedulerDO applies it
 * when the record is written (turning the refusal into a `400`);
 * `@lunora/server`'s deferred-schedule facade applies it when the call is
 * BUFFERED, because it answers the handler with the id synchronously — long
 * before the DO sees the request. Restating the rule in the facade is how the two
 * drift: an id the facade accepted and the DO replaced leaves the handler holding
 * an id no job was ever stored under, so its later `cancel` silently misses.
 * @param requested the caller's `RunOptions.id`, if any
 * @throws LunoraError `INVALID_SCHEDULE_ID` when `requested` is supplied and is not a safe key segment
 */
const resolveScheduleId = (requested: unknown): string => {
    if (requested === undefined) {
        return toBase64Url(crypto.getRandomValues(new Uint8Array(12))).replace(LEADING_DASH, "_");
    }

    if (typeof requested !== "string" || !SCHEDULE_ID_PATTERN.test(requested)) {
        throw new LunoraError(
            "INVALID_SCHEDULE_ID",
            "@lunora/scheduler: `id` must be 1-64 characters of [A-Za-z0-9_-] and must not start with `-`; omit it to have one minted",
            { status: 400 },
        );
    }

    return requested;
};

export default resolveScheduleId;
