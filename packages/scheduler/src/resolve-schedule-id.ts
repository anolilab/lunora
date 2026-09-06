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

/**
 * The id a new record is stored under: the caller's, when it is a safe key
 * segment, and otherwise a freshly minted one.
 *
 * Minting swaps a leading `-` for `_` rather than re-rolling: base64url's index
 * 62 IS `-` (RFC 4648 §5), so 1 in 64 minted ids led with one and was refused by
 * the workflow engine on dispatch. `_` is in the engine's leading class, the
 * swap is a single pass, and 96 random bits stay 96 random bits everywhere but
 * that first character.
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
    typeof requested === "string" && SCHEDULE_ID_PATTERN.test(requested)
        ? requested
        : toBase64Url(crypto.getRandomValues(new Uint8Array(12))).replace(/^-/u, "_");

export default resolveScheduleId;
