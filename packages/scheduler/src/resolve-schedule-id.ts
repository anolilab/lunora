import { toBase64Url } from "../../../shared/base64";

/**
 * Shape a caller-supplied job id must have to be accepted: the alphabet shared by
 * base64url ids and UUIDs, and nothing that could collide with the `:` separators
 * in `id:<id>` / `t:<padded>:<id>`.
 */
const SCHEDULE_ID_PATTERN = /^[\w-]{1,64}$/u;

/**
 * The id a new record is stored under: the caller's, when it is a safe key
 * segment, and otherwise a freshly minted one.
 *
 * Exported because two surfaces have to agree on it. The SchedulerDO applies it
 * when the record is written; `@lunora/server`'s deferred-schedule facade applies
 * it when the call is BUFFERED, because it answers the handler with the id
 * synchronously — long before the DO sees the request. Restating the rule in the
 * facade is how the two drift: an id the facade accepted and the DO replaced
 * leaves the handler holding an id no job was ever stored under, so its later
 * `cancel` silently misses.
 * @param requested the caller's `RunOptions.id`, if any
 */
const resolveScheduleId = (requested: unknown): string =>
    typeof requested === "string" && SCHEDULE_ID_PATTERN.test(requested) ? requested : toBase64Url(crypto.getRandomValues(new Uint8Array(12)));

export default resolveScheduleId;
