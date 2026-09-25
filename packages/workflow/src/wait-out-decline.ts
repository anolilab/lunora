/**
 * Waiting out a shard's `409 DISPATCH_IN_PROGRESS` decline inside the calling
 * step, instead of throwing it.
 *
 * A decline means an earlier dispatch of the SAME dedup id is still running on
 * the shard — for a workflow, the step's own previous attempt: `ctx.run` gives up
 * on a call after 30 seconds while the shard keeps running it, the step retries,
 * and the retry re-issues the same id (which is what keeps the call
 * exactly-once). Thrown, the decline is charged as a failed attempt, so a call
 * slower than the step's retry ladder (about five and a half minutes at the
 * engine's defaults) spent the whole budget on declines and errored the
 * instance while that call was still in flight.
 *
 * Re-checking in place spends nothing: the id is dispatched again after a
 * growing pause, and once the first run settles the shard serves its result
 * from the replay cache — or, if that run died, runs the call. The decline is
 * never taken as success, so the guarantee stays at-least-once.
 *
 * **Bounded by the claim.** A shard claim cannot decline for longer than
 * {@link DISPATCH_CLAIM_CEILING_MS}, so re-checking stops once that long has
 * passed since the first decline (the claim was taken no later than that), and
 * a decline after that is rethrown to the engine's ordinary retry. Two things
 * can still charge an attempt: the step's own `timeout` (Cloudflare's default is
 * ten minutes) cutting a long wait short, and that final rethrow.
 */
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { DISPATCH_CLAIM_CEILING_MS, isDispatchDecline } from "@lunora/dispatch";

import type { ArgsOf, FunctionReference } from "../../../shared/function-reference";
import type { RunFunctionOptions, WorkflowRunFunction } from "./types";

/** The first pause after a decline; each later one doubles, up to {@link MAX_RECHECK_MS}. */
const FIRST_RECHECK_MS = 1000;

/** The longest pause between two re-checks of a declined call. */
const MAX_RECHECK_MS = 30_000;

const pause = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

/** Wrap a runner so a declined call is re-dispatched with the same options until it is served, for at most the claim ceiling. */
const waitOutDeclines =
    (run: WorkflowRunFunction): WorkflowRunFunction =>
    async <F extends FunctionReference>(function_: F, arguments_?: ArgsOf<F>, options?: RunFunctionOptions): Promise<unknown> => {
        const attempt = async (declinedSince: number | undefined, recheckMs: number): Promise<unknown> => {
            try {
                return await run(function_, arguments_, options);
            } catch (error: unknown) {
                if (!isDispatchDecline(error)) {
                    throw error;
                }

                const now = Date.now();
                const since = declinedSince ?? now;
                const remaining = since + DISPATCH_CLAIM_CEILING_MS - now;

                if (remaining <= 0) {
                    throw error;
                }

                await pause(Math.min(recheckMs, remaining));

                return attempt(since, Math.min(recheckMs * 2, MAX_RECHECK_MS));
            }
        };

        return attempt(undefined, FIRST_RECHECK_MS);
    };

// eslint-disable-next-line import/prefer-default-export -- named export by package convention
export { waitOutDeclines };
