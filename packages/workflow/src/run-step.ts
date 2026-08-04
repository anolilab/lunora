/**
 * `createRunStep` — turns a {@link StepDefinition} into a durable step call.
 * Node-safe (no `cloudflare:workers` import): the native step API and the native
 * `NonRetryableError` constructor are injected, so the whole execution path —
 * arg validation, the body, result validation, rollback wiring, and
 * non-retryable-error conversion — is unit-testable with plain doubles.
 */
import { parseValidatorMap } from "@lunora/values";

import type { NativeNonRetryableErrorConstructor } from "./errors";
import { convertNonRetryableError, NonRetryableError } from "./errors";
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
const createRunStep =
    (deps: RunStepDeps): WorkflowRunStepFunction =>
    async <A extends StepArgsValidator, Result>(step: StepDefinition<A, Result>, args: InferStepArgs<A>, options?: RunStepOptions): Promise<Result> => {
        const config = options?.config ?? step.config;

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
                run: deps.run,
                step: nativeContext.step,
            };

            let result: Result;

            try {
                result = await step.handler(stepContext, validatedArgs);
            } catch (error: unknown) {
                // The step BODY threw — that may be a transient failure (network
                // blip, a contended write), so it stays retryable: only a portable
                // NonRetryableError is converted, everything else rethrown as-is.
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
                const nonRetryable = new NonRetryableError(`step "${step.name}" returns validation failed: ${message}`);

                if (error !== undefined) {
                    nonRetryable.cause = error;
                }

                return convertNonRetryableError(nonRetryable, deps.nonRetryableErrorClass);
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
                          run: deps.run,
                      });
                  },
                  rollbackConfig: step.rollbackConfig,
              }
            : undefined;

        return config === undefined ? deps.step.do(step.name, callback, rollbackOptions) : deps.step.do(step.name, config, callback, rollbackOptions);
    };

export { createRunStep, validateStepArgs };
