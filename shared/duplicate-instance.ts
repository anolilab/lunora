/**
 * The one definition of "a `WorkflowBinding.create()` rejection means the
 * instance is already there".
 *
 * It is deliberately **not** a package. `@lunora/workflow` owns the Workflows
 * binding contract and re-exports this as `isDuplicateInstanceError`, but
 * `@lunora/runtime`'s scheduler/cron dispatcher reaches the same binding through
 * a purely structural `WorkflowBindingLike` — it keeps no runtime dependency on
 * `@lunora/workflow`, so it inlines this file instead. Two spellings of the same
 * regex is exactly the drift that would let one caller retry forever on what the
 * other already treats as success.
 */

/**
 * Matches Cloudflare Workflows' "instance already exists" rejection.
 *
 * Deliberately separator-agnostic. The local harness cannot pin the exact
 * production text — miniflare's `WorkflowBinding.create` never rejects a
 * duplicate id at all (it calls `stub.init(...)` unconditionally and
 * `Engine.init` returns early for an instance that already has metadata), so the
 * duplicate branch is unreachable LOCALLY: in Node and under `wrangler
 * dev`/workerd alike. Production Workflows does reject it, which is the whole
 * reason the attach/idempotency paths exist — so this is a gap in what the
 * harness can prove, never evidence that those branches are dead code. That
 * makes the *shape* of the message the only thing we can defend, and a
 * `already_exists` / `already-exists` spelling must not read as a transient
 * failure and cost the caller its whole retry budget.
 */
const DUPLICATE_INSTANCE = /already[\s_-]?exists/iu;

/**
 * Whether a `WorkflowBinding.create()` rejection is a duplicate-instance-id
 * error — the idempotency signal that a *previous* attempt's create already
 * applied — as opposed to a transient or config failure (Workflows service
 * error, instance-creation quota, bad params).
 *
 * Every other failure MUST surface, so the caller retries or fails visibly
 * rather than silently reporting success for work that never started.
 */
const isDuplicateInstanceError = (error: unknown): boolean => DUPLICATE_INSTANCE.test(error instanceof Error ? error.message : String(error));

export { isDuplicateInstanceError };
