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
 * a decline after that is rethrown to the engine's ordinary retry.
 *
 * **Bounded by the step's timeout.** Inside `ctx.runStep` the wait also stops
 * {@link STEP_TIMEOUT_MARGIN_MS} before the attempt's `timeout` (read from the
 * config the engine hands the step, Cloudflare's ten-minute default when it
 * names none) and rethrows the decline there. Left to run, the engine's
 * timeout would fail the attempt anyway, but the abandoned wait would keep
 * re-dispatching alongside the next attempt. Ending it first charges the
 * attempt once, to the decline, and the next attempt picks the wait up. A
 * re-check that finds the claim gone runs the call, so each one is given no
 * more `timeoutMs` than the time left, and the wait ends while at least
 * {@link MIN_RECHECK_DISPATCH_MS} remains.
 *
 * A rollback is bounded by its OWN `rollbackConfig.timeout`. The engine hands
 * a rollback the forward step's context: on the local Workflows engine a step
 * with `timeout: "1 hour"` and `rollbackConfig: { timeout: "7 seconds" }` gave
 * its rollback `ctx.config.timeout === "1 hour"`.
 *
 * The Node host does not enforce a step timeout (see `NODE_CAPABILITIES`'s
 * `workflows` note), so there the bound charges an attempt that host would not
 * have ended; the next attempt resumes the wait.
 */
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { DEFAULT_DISPATCH_TIMEOUT_MS, DISPATCH_CLAIM_CEILING_MS, isDispatchDecline } from "@lunora/dispatch";

import type { ArgsOf, FunctionReference } from "../../../shared/function-reference";
import type { RunFunctionOptions, WorkflowRunFunction, WorkflowStepConfigLike } from "./types";

/** The first pause after a decline; each later one doubles, up to {@link MAX_RECHECK_MS}. */
const FIRST_RECHECK_MS = 1000;

/** The longest pause between two re-checks of a declined call. */
const MAX_RECHECK_MS = 30_000;

/** How long before a step's timeout the wait gives up, leaving room for the last re-check's round trip. */
const STEP_TIMEOUT_MARGIN_MS = 2000;

/** The least time a re-check under a step deadline is given to dispatch; with less left, the wait ends instead. */
const MIN_RECHECK_DISPATCH_MS = 1000;

/** Cloudflare Workflows' step `timeout` when the config names none. */
const DEFAULT_STEP_TIMEOUT_MS = 600_000;

/** Milliseconds per unit of a Workflows duration label such as `"30 seconds"`. */
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
    day: 86_400_000,
    hour: 3_600_000,
    millisecond: 1,
    minute: 60_000,
    second: 1000,
    week: 604_800_000,
};

/** `"<amount> <unit>"`, with the unit's plural `s` left out of the capture. */
const DURATION_LABEL = /^(\d+(?:\.\d+)?)\s*([a-z]+?)s?$/iu;

/** A step `timeout` in milliseconds, or `undefined` for one this cannot read (the wait is then bounded by the claim alone). */
const stepTimeoutMs = (timeout: WorkflowStepConfigLike["timeout"]): number | undefined => {
    if (timeout === undefined) {
        return DEFAULT_STEP_TIMEOUT_MS;
    }

    if (typeof timeout === "number") {
        return Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
    }

    const match = DURATION_LABEL.exec(timeout.trim());
    const perUnit = match === null ? undefined : DURATION_UNIT_MS[(match[2] ?? "").toLowerCase()];

    return match === null || perUnit === undefined ? undefined : Number(match[1]) * perUnit;
};

/** When a wait inside a step attempt that started at `startedAt` has to give up, given the config the engine handed the attempt. */
const stepWaitDeadline = (config: WorkflowStepConfigLike | undefined, startedAt: number): number | undefined => {
    const timeout = stepTimeoutMs(config?.timeout);

    return timeout === undefined ? undefined : startedAt + timeout - STEP_TIMEOUT_MARGIN_MS;
};

const pause = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

/**
 * Wrap a runner so a declined call is re-dispatched with the same options until
 * it is served, for at most the claim ceiling and never past `deadline` (epoch
 * ms, see {@link stepWaitDeadline}).
 */
const waitOutDeclines =
    (run: WorkflowRunFunction, deadline?: number): WorkflowRunFunction =>
    async <F extends FunctionReference>(function_: F, arguments_?: ArgsOf<F>, options?: RunFunctionOptions): Promise<unknown> => {
        const attempt = async (declinedSince: number | undefined, recheckMs: number): Promise<unknown> => {
            try {
                // A re-check can find the claim gone and run the call itself, and a
                // dispatch may take the runner's whole 30s default; under a deadline it is
                // given no more than what is left, so it cannot outlive the step.
                const bounded =
                    declinedSince === undefined || deadline === undefined
                        ? options
                        : { ...options, timeoutMs: Math.min(DEFAULT_DISPATCH_TIMEOUT_MS, deadline - Date.now()) };

                return await run(function_, arguments_, bounded);
            } catch (error: unknown) {
                if (!isDispatchDecline(error)) {
                    throw error;
                }

                const now = Date.now();
                const since = declinedSince ?? now;
                const untilCeiling = since + DISPATCH_CLAIM_CEILING_MS - now;
                // Under a deadline, keep room for one more dispatch after the pause.
                const untilDeadline = deadline === undefined ? Number.POSITIVE_INFINITY : deadline - now - MIN_RECHECK_DISPATCH_MS;
                const remaining = Math.min(untilCeiling, untilDeadline);

                if (remaining <= 0) {
                    throw error;
                }

                await pause(Math.min(recheckMs, remaining));

                // A timer can fire late; if the pause ran past either bound, give the
                // decline back rather than start a dispatch with no time left for it.
                // The pause already leaves room for one dispatch before the deadline, so
                // only an actual overrun counts; ordinary timer jitter must not end the wait.
                const resumed = Date.now();

                if (resumed >= since + DISPATCH_CLAIM_CEILING_MS || (deadline !== undefined && resumed >= deadline)) {
                    throw error;
                }

                return attempt(since, Math.min(recheckMs * 2, MAX_RECHECK_MS));
            }
        };

        return attempt(undefined, FIRST_RECHECK_MS);
    };

export { stepWaitDeadline, waitOutDeclines };
