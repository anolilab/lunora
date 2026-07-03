/**
 * Builds the Lunora-flavored context handed to a workflow body. Node-safe (no
 * `cloudflare:workers` import) so the runner and context assembly are unit
 * testable; the workerd-only `src/do` base class consumes it. The `ctx.run`
 * dispatcher + the logger are the shared `@lunora/dispatch` primitives (the same
 * ones `@lunora/queue` uses), POSTing to `/_lunora/scheduler/dispatch` with the
 * admin bearer. Wrap calls in `ctx.step.do(...)` to make them durable.
 */
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { createDispatchLogger, createDispatchRunner } from "@lunora/dispatch";
import { LunoraError } from "@lunora/errors";

import { workflowBindingName } from "./define-workflow";
import type { NativeNonRetryableErrorConstructor } from "./errors";
import type { WorkflowBindingResolver } from "./fan-out";
import { createParallel, createSpawn } from "./fan-out";
import { createRunStep } from "./run-step";
import type { WorkflowBindingLike, WorkflowEventLike, WorkflowRunContext, WorkflowRunFunction, WorkflowStepLike } from "./types";

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

    // Resolve a child workflow's `WORKFLOW_*` binding from its export name via the
    // shared naming helper — the same derivation codegen and the config layer use,
    // so no generated binding map is needed for the workflow body to spawn children.
    const resolveBinding: WorkflowBindingResolver = (workflow: string) => {
        const bindingName = workflowBindingName(workflow);
        const binding = options.env[bindingName] as WorkflowBindingLike | undefined;

        if (!binding || typeof binding.create !== "function" || typeof binding.get !== "function") {
            throw new LunoraError(
                "INTERNAL",
                `@lunora/workflow: cannot spawn child workflow "${workflow}" — no Workflow binding "${bindingName}" on env (is it declared in lunora/workflows.ts?)`,
            );
        }

        return binding;
    };

    // Deterministic child-id allocator: the handler replays in the same order, so
    // a per-invocation counter yields replay-stable ids and `step.do` memoization
    // re-attaches to the existing children instead of double-spawning.
    let childCounter = 0;
    const nextChildId = (explicit?: string): string => {
        if (explicit !== undefined) {
            return explicit;
        }

        const id = `${options.event.instanceId}-c${String(childCounter)}`;
        childCounter += 1;

        return id;
    };

    const fanOutDeps = {
        env: options.env,
        instanceId: options.event.instanceId,
        nextChildId,
        parentBinding: workflowBindingName(options.exportName),
        resolveBinding,
        step: options.step,
    };

    return {
        env: options.env,
        event: options.event,
        log,
        parallel: createParallel(fanOutDeps),
        params: options.event.payload,
        run,
        runStep: createRunStep({ env: options.env, log, nonRetryableErrorClass: options.nonRetryableErrorClass, run, step: options.step }),
        spawn: createSpawn(fanOutDeps),
        step: options.step,
    };
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export { createWorkflowRunContext };
