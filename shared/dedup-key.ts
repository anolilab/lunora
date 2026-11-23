/**
 * The grammar a scheduled job's `dedupKey` must match, shared without a runtime dependency edge:
 * `@lunora/scheduler` refuses a bad key when the job is written, and `@lunora/runtime`'s dispatch
 * route (which does not depend on `@lunora/scheduler`) refuses one arriving on a hand-crafted body.
 *
 * The key is spent verbatim as a workflow instance id and as the `x-lunora-mutation-id` header, so
 * the workflow engine's instance-id grammar and 100-char ceiling bound it, and a header-illegal
 * character (a newline) cannot reach `new Request`.
 */
const DEDUP_KEY_PATTERN = /^\w[\w-]{0,99}$/u;

export const DEDUP_KEY_GRAMMAR_MESSAGE = "`dedupKey` must match ^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$";

export const isDedupKey = (candidate: unknown): candidate is string => typeof candidate === "string" && DEDUP_KEY_PATTERN.test(candidate);
