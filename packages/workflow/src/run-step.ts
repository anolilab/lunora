/**
 * `createRunStep` — turns a {@link StepDefinition} into a durable step call.
 * Node-safe (no `cloudflare:workers` import): the native step API and the native
 * `NonRetryableError` constructor are injected, so the whole execution path —
 * arg validation, the body, result validation, rollback wiring, and
 * non-retryable-error conversion — is unit-testable with plain doubles.
 */
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { isDeterministicDispatchFailure } from "@lunora/dispatch";
import { parseValidatorMap } from "@lunora/values";

import { pinDedupId } from "./dedup-id";
import { RESERVED_EVENT_TYPE_PREFIX } from "./define-event";
import type { NativeNonRetryableErrorConstructor } from "./errors";
import { convertNonRetryableError, raiseNonRetryable } from "./errors";
import type {
    InferStepArgs,
    RunStepOptions,
    StepArgsValidator,
    StepDefinition,
    StepRunContext,
    WorkflowLogger,
    WorkflowRollbackContextLike,
    WorkflowRunFunction,
    WorkflowRunStepFunction,
    WorkflowStepContextLike,
    WorkflowStepLike,
    WorkflowStepRollbackOptionsLike,
} from "./types";

/**
 * Validate a step's args through its validator map, prefixing any
 * `ValidationError` with `step args.<key>` so the failure points at the
 * offending field. Delegates to `@lunora/values`' shared {@link parseValidatorMap}
 * — the same parser the procedure builder and HTTP routes use — so the
 * optional-skip and error-prefix semantics stay in lockstep across the framework.
 */
const validateStepArgs = (validators: StepArgsValidator, source: Record<string, unknown>): Record<string, unknown> =>
    parseValidatorMap(validators, source, "step args");

/** Dependencies needed to run a step: the native step API plus the workflow's env / runner / logger. */
interface RunStepDeps {
    /** The Worker environment bindings, surfaced on the step context. */
    env: Record<string, unknown>;
    /** This workflow instance's id — the namespace for the replay-dedup ids the steps' dispatches carry. */
    instanceId: string;
    /** Structured logger surfaced on the step context. */
    log: WorkflowLogger;
    /** Native `cloudflare:workflows` `NonRetryableError` constructor — injected by `src/do`; absent in Node tests. */
    nonRetryableErrorClass?: NativeNonRetryableErrorConstructor;
    /** The Lunora function runner, surfaced on the step context. */
    run: WorkflowRunFunction;
    /** The native Cloudflare durable-step API. */
    step: WorkflowStepLike;
}

/**
 * Build the `ctx.runStep` function bound to one workflow invocation. Each call
 * runs the step through `step.do(...)`: validate args → run body → validate
 * result (when `returns` is declared), with any portable `NonRetryableError`
 * converted to the native one and any declared rollback forwarded to Cloudflare.
 */
const createRunStep = (deps: RunStepDeps): WorkflowRunStepFunction => {
    /**
     * Ordinal of the NEXT `ctx.runStep` call in this execution of the body —
     * the per-step namespace for replay-dedup ids (see `dedup-id.ts` for why
     * this rather than the native `step.count`). Allocated synchronously below,
     * before the call awaits anything, so concurrently-awaited steps still take
     * their positions in source order. Rebuilt on every replay along with the
     * context, which is what makes a replay re-derive the same ordinals.
     */
    let invocations = 0;

    return async <A extends StepArgsValidator, Result>(step: StepDefinition<A, Result>, args: InferStepArgs<A>, options?: RunStepOptions): Promise<Result> => {
        const dedupScope = `${deps.instanceId}#step${String(invocations)}`;

        invocations += 1;

        const config = options?.config ?? step.config;
        const stepName = options?.name ?? step.name;

        // The step-name namespace is reserved alongside the event-type namespace:
        // `lunora:*` steps belong to the fan-out protocol, and a user step that
        // borrowed one would collide with it. Checked on the RESOLVED name, so a
        // `defineStep("lunora:spawn:x", …)` cannot slip past by omitting `name`.
        if (stepName.startsWith(RESERVED_EVENT_TYPE_PREFIX)) {
            return raiseNonRetryable(
                `@lunora/workflow: ctx.runStep step name "${stepName}" is reserved — the "${RESERVED_EVENT_TYPE_PREFIX}" prefix is used by the framework's own steps`,
                undefined,
                deps.nonRetryableErrorClass,
            );
        }

        // Validate once, here, and close over the result — the body and the
        // rollback (a separate durable replay) both run with the same validated
        // args, so there is a single validation site and no chance of drift.
        // `async` keeps a synchronous validation failure a rejected promise
        // rather than a thrown exception at the call site.
        const validatedArgs = validateStepArgs(step.args, args) as InferStepArgs<A>;

        const callback = async (nativeContext: WorkflowStepContextLike): Promise<Result> => {
            const stepContext: StepRunContext = {
                attempt: nativeContext.attempt,
                config: nativeContext.config,
                env: deps.env,
                log: deps.log,
                // Pinned INSIDE the callback on purpose: Cloudflare retries a
                // failed step body in place, so the counter has to restart at
                // `.1` for each attempt. That is what makes attempt 2 re-issue
                // attempt 1's ids and the shard apply the mutation once instead
                // of once per attempt — the double-charge this closes.
                run: pinDedupId(deps.run, dedupScope),
                step: nativeContext.step,
            };

            let result: Result;

            try {
                result = await step.handler(stepContext, validatedArgs);
            } catch (error: unknown) {
                // The step BODY threw — that may be a transient failure (network
                // blip, a contended write), so it stays retryable by default: only
                // a portable NonRetryableError is converted, everything else
                // rethrown as-is. The one exception is a `ctx.run` dispatch that
                // failed deterministically (a 400/403/404/422 from the dispatched
                // function) — that's the same failure on every retry, so wrap it
                // into a portable NonRetryableError (preserving message + cause)
                // before the existing native-conversion boundary below, rather than
                // burning the step's retry budget re-running its side effects.
                if (isDeterministicDispatchFailure(error)) {
                    return raiseNonRetryable(error.message, error, deps.nonRetryableErrorClass);
                }

                return convertNonRetryableError(error, deps.nonRetryableErrorClass);
            }

            if (!step.returns) {
                return result;
            }

            // Result validation runs on an ALREADY-produced value. A failure here
            // is deterministic — the same body output fails `returns.parse` every
            // attempt — so retrying only burns the retry budget. Convert the
            // ValidationError into a non-retryable failure so the instance fails
            // fast (see errors.ts for the native-conversion boundary).
            try {
                return step.returns.parse(result);
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);

                return raiseNonRetryable(`step "${step.name}" returns validation failed: ${message}`, error, deps.nonRetryableErrorClass);
            }
        };

        const rollbackHandler = step.rollback;
        const rollbackOptions: WorkflowStepRollbackOptionsLike<Result> | undefined = rollbackHandler
            ? {
                  rollback: async (rollbackContext: WorkflowRollbackContextLike<Result>): Promise<void> => {
                      await rollbackHandler({
                          args: validatedArgs,
                          env: deps.env,
                          error: rollbackContext.error,
                          log: deps.log,
                          output: rollbackContext.output,
                          // A rollback is a SECOND durable replay with its own
                          // retry budget, so its dispatches need the same pin —
                          // built per invocation so a retried rollback reproduces
                          // its ids. Its own scope, never the forward step's: a
                          // refund sharing the charge's id would dedup against it
                          // and silently never run.
                          run: pinDedupId(deps.run, `${dedupScope}rollback`),
                      });
                  },
                  rollbackConfig: step.rollbackConfig,
              }
            : undefined;

        return config === undefined ? deps.step.do(stepName, callback, rollbackOptions) : deps.step.do(stepName, config, callback, rollbackOptions);
    };
};

export { createRunStep, validateStepArgs };
