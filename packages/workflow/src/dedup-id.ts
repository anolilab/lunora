/**
 * Replay-dedup ids for the function dispatches a workflow body makes.
 *
 * A `ctx.run` is an ordinary POST to the worker's dispatch endpoint; the shard
 * applies it exactly once only when it carries a `dedupId`, which rides through
 * as the replay-dedup `mutationId`. Without one the dispatch is at-least-once —
 * and a workflow is a replay machine, so "at-least-once" means a retried step
 * body charges the card twice and a body that re-runs after a `step.sleep`
 * charges it once per activation.
 *
 * An id must satisfy two properties at once:
 *
 * - **Same logical call on a replay ⇒ same id.** This is what makes the second
 * application a no-op.
 * - **Two genuinely different calls ⇒ different ids.** The shard's dedup table
 * is keyed `(identity, mutationId)` with no function path in it, and every
 * server-initiated dispatch shares the one `"system:"` identity — so a reused
 * id makes the second call return the FIRST one's cached result and never
 * execute. A collision is strictly worse than no id at all.
 *
 * The scheme is `<scope>.<n>`, `n` counting the calls made through one pinned
 * runner in order. The scope carries the instance id (ids are global to the
 * shard, so two instances must not share a namespace) plus what part of the
 * body is calling. Three scopes exist, and they are mutually disjoint:
 *
 * - `<instanceId>#body` — top-level `ctx.run` in the handler body.
 * - `<instanceId>#step<i>` — `ctx.run` inside the i-th `ctx.runStep` call.
 * - that same scope suffixed `rollback` — `ctx.run` inside the step's rollback
 * handler, which must never share the forward call's ids or a refund would
 * dedup against the charge and silently never run.
 *
 * `<i>` is the ordinal of the `ctx.runStep` CALL within one execution of the
 * body, allocated synchronously before the call awaits anything — NOT the
 * native `step.count`. Two things make the ordinal the right key: it stays
 * distinct when a workflow reuses one step name (a documented loop pattern,
 * where `step.count` is the only thing separating the occurrences), and it does
 * not depend on a runtime field a host may not model — `@lunora/platform-node`
 * reports `step.count` as `1` for every step.
 *
 * Stability across an in-place retry is structural, not assumed: the scope is
 * fixed before `step.do` runs and the counter is created INSIDE the callback,
 * so attempt 2 restarts at `.1` and reproduces attempt 1's ids exactly. Across
 * a body REPLAY it rests on the same determinism contract every replay already
 * assumes — the body issuing its calls in the same order. A body that branches
 * on `Date.now()` / `Math.random()` must pass its own `dedupId`, which always
 * wins over the pin.
 */
import type { ArgsOf, FunctionReference } from "../../../shared/function-reference";
import type { RunFunctionOptions, WorkflowRunFunction } from "./types";

/**
 * Wrap a runner so every call it makes carries `<scope>.<n>` as its dedup id.
 *
 * Build one per scope INSTANCE, not per scope name: the counter restarting is
 * what makes a retry reproduce the previous attempt's ids.
 *
 * A caller-supplied `dedupId` wins — the escape hatch for a non-deterministic
 * body. The counter still advances for such a call, so the surrounding calls
 * keep the positions they would have had either way.
 */
const pinDedupId = (run: WorkflowRunFunction, scope: string): WorkflowRunFunction => {
    let calls = 0;

    return <F extends FunctionReference>(function_: F, arguments_?: ArgsOf<F>, options?: RunFunctionOptions): Promise<unknown> => {
        calls += 1;

        return run(function_, arguments_, { ...options, dedupId: options?.dedupId ?? `${scope}.${String(calls)}` });
    };
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention
export { pinDedupId };
