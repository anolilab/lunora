/**
 * `@lunora/workflow/do` — the workerd-only half of the package.
 *
 * `cloudflare:workers` (the `WorkflowEntrypoint` base) is a runtime-only virtual
 * module, so anything touching it lives behind this subpath: the package root
 * stays importable from Node tooling (codegen, config, app unit tests) while the
 * generated `_generated/workflows.ts` imports the base class from here.
 */
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

import { convertNonRetryableError } from "../errors";
import { errorOutcome, extractBranchMarker, okOutcome, signalBranchParentSafe, stripBranchMarker } from "../fan-out";
import { createWorkflowRunContext } from "../run-context";
import type { WorkflowDefinition, WorkflowStepLike } from "../types";

/**
 * Base class for the generated `WorkflowEntrypoint` classes. Applies a
 * `defineWorkflow` definition onto Cloudflare's `WorkflowEntrypoint`: `run`
 * assembles the Lunora context (native `step`/`event` + the `ctx.run` function
 * dispatcher + a logger) and invokes the user's handler.
 *
 * Generated subclasses stay one line of behavior:
 *
 * ```ts
 * export class OrderPipelineWorkflow extends LunoraWorkflow {
 *     constructor(ctx: ExecutionContext, env: Record<string, unknown>) {
 *         super(ctx, env, orderPipeline, "orderPipeline");
 *     }
 * }
 * ```
 */
class LunoraWorkflow<Params = Record<string, unknown>, Output = unknown> extends WorkflowEntrypoint<Record<string, unknown>, Params> {
    /** The `lunora/workflows.ts` export name, for log correlation. */
    readonly #lunoraName: string;

    /** The `defineWorkflow` result this entrypoint runs. */
    readonly #definition: WorkflowDefinition<Params, Output>;

    public constructor(
        context: ConstructorParameters<typeof WorkflowEntrypoint>[0],
        env: Record<string, unknown>,
        definition: WorkflowDefinition<Params, Output>,
        exportName?: string,
    ) {
        super(context, env);

        this.#definition = definition;
        this.#lunoraName = exportName ?? "workflow";
    }

    public override async run(event: Readonly<WorkflowEvent<Params>>, step: WorkflowStep): Promise<Output> {
        const nativeStep = step as unknown as WorkflowStepLike;

        // When this instance was spawned as a `ctx.parallel` branch, the parent
        // stamped a callback marker into the params. Read it (to signal completion
        // back) and hand the user handler a clean payload without the marker.
        const marker = extractBranchMarker(event.payload);
        const handlerEvent = marker ? ({ ...event, payload: stripBranchMarker(event.payload) } as Readonly<WorkflowEvent<Params>>) : event;

        const context = createWorkflowRunContext<Params>({
            env: this.env,
            event: handlerEvent,
            exportName: this.#lunoraName,
            nonRetryableErrorClass: NonRetryableError,
            step: nativeStep,
        });

        let output: Output;

        try {
            output = await this.#definition.handler(context);
        } catch (error: unknown) {
            // A branch child: tell the parent it failed (best-effort durable send)
            // before the instance itself errors, so the parent fails fast instead
            // of waiting out its `waitForEvent` timeout. The send is swallowed on
            // failure (`signalBranchParentSafe`) so a broken parent signal never
            // replaces the handler's real error nor skips the conversion below.
            if (marker) {
                await signalBranchParentSafe({ env: this.env, log: context.log, step: nativeStep }, marker, errorOutcome(error));
            }

            // Convert a portable `NonRetryableError` thrown outside a step (in
            // the handler body) to the native one so Cloudflare fails the
            // instance immediately. Errors thrown inside `ctx.runStep` are
            // already converted at the step boundary.
            return convertNonRetryableError(error, NonRetryableError);
        }

        // A branch child: report the result to the parent so its `ctx.parallel`
        // join resolves this branch's slot. Swallowed on failure so a broken parent
        // signal never marks a successfully-completed child instance as errored.
        if (marker) {
            await signalBranchParentSafe({ env: this.env, log: context.log, step: nativeStep }, marker, okOutcome(output));
        }

        return output;
    }
}

export default LunoraWorkflow;
