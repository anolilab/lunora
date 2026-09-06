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

import { decodeWire } from "../../../shared/wire-codec";
import { workflowBindingName } from "./define-workflow";
import type { NativeNonRetryableErrorConstructor } from "./errors";
import type { WorkflowBindingResolver } from "./fan-out";
import { createParallel, createSpawn } from "./fan-out";
import { createRunStep } from "./run-step";
import type { WorkflowBindingLike, WorkflowEventLike, WorkflowRunContext, WorkflowRunFunction, WorkflowStepLike } from "./types";
import { createWaitForEvent } from "./wait-for-event";

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
    // `@lunora/dispatch`'s runner is deliberately loose at the boundary (its
    // `ArgsOf` collapses to `Record<string, unknown>`); this package's
    // `WorkflowRunFunction` reads the reference's `__lunoraPhantom` instead, so a
    // call is checked against the target function's own args. The runtime
    // dispatch is identical — only the arg type narrows — hence the cast. (The
    // `FunctionReference`/`ArgsOf` types stay per-package by design; the mirror
    // is pinned by `packages/client/__tests__/structural-mirrors.test.ts`.)
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
    //
    // Deliberately unbounded: `options.event.instanceId` is the HOST's id, at
    // whatever length and in whatever alphabet it mints (`@lunora/platform-node`
    // issues `<definitionId>:<uuid>`), and an explicit id is returned verbatim.
    // The engine's 100-character ceiling is applied where the id reaches `create`
    // — `boundInstanceId` in `fan-out.ts` — so both `ctx.parallel` and `ctx.spawn`
    // fold through one place and neither this allocator nor any other
    // `nextChildId` implementation has to restate the rule.
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
        log,
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
        // `decodeWire`, not the raw payload: a scheduled workflow's args travel in
        // wire form because Workflow `params` are JSON-serialised into durable
        // storage, and this is the first point that can hand the handler real
        // `bigint`/`Date`/bytes values. Identity for pure JSON, so a directly
        // created or spawned instance is unaffected.
        params: decodeWire(options.event.payload) as Readonly<Params>,
        run,
        runStep: createRunStep({ env: options.env, log, nonRetryableErrorClass: options.nonRetryableErrorClass, run, step: options.step }),
        spawn: createSpawn(fanOutDeps),
        step: options.step,
        waitForEvent: createWaitForEvent({ nonRetryableErrorClass: options.nonRetryableErrorClass, step: options.step }),
    };
};

// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export { createWorkflowRunContext };
