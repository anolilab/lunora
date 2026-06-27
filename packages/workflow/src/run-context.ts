/**
 * Builds the Lunora-flavored context handed to a workflow body. Node-safe (no
 * `cloudflare:workers` import) so the runner and context assembly are unit
 * testable; the workerd-only `src/do` base class consumes it. The `ctx.run`
 * dispatcher + the logger are the shared `@lunora/dispatch` primitives (the same
 * ones `@lunora/queue` uses), POSTing to `/_lunora/scheduler/dispatch` with the
 * admin bearer. Wrap calls in `ctx.step.do(...)` to make them durable.
 */
import { createDispatchLogger, createDispatchRunner } from "@lunora/dispatch";

import type { NativeNonRetryableErrorConstructor } from "./errors";
import { createRunStep } from "./run-step";
import type { WorkflowEventLike, WorkflowRunContext, WorkflowRunFunction, WorkflowStepLike } from "./types";

interface RunContextOptions<Params> {
    env: Record<string, unknown>;
    event: WorkflowEventLike<Params>;
    exportName: string;
    fetchImpl?: typeof fetch;
    /** Native `cloudflare:workflows` `NonRetryableError` — injected by `src/do`; absent in Node tests. */
    nonRetryableErrorClass?: NativeNonRetryableErrorConstructor;
    step: WorkflowStepLike;
}

/** Assemble the {@link WorkflowRunContext} passed to a `defineWorkflow` handler. */
const createWorkflowRunContext = <Params = Record<string, unknown>>(options: RunContextOptions<Params>): WorkflowRunContext<Params> => {
    const log = createDispatchLogger(`[workflow:${options.exportName}]`);
    // The shared runner's `ctx.run` is loosely typed (`Record<string, unknown>`
    // args); workflow's `WorkflowRunFunction` keeps the precise `ArgsOf<F>`
    // inference, so cast — the runtime dispatch is identical, only the arg type
    // narrows. (The `FunctionReference`/`ArgsOf` types stay per-package by design.)
    const run = createDispatchRunner({ env: options.env, fetchImpl: options.fetchImpl, label: "@lunora/workflow" }) as unknown as WorkflowRunFunction;

    return {
        env: options.env,
        event: options.event,
        log,
        params: options.event.payload,
        run,
        runStep: createRunStep({ env: options.env, log, nonRetryableErrorClass: options.nonRetryableErrorClass, run, step: options.step }),
        step: options.step,
    };
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export { createWorkflowRunContext };
