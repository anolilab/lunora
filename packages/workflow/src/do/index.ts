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
 *     constructor(ctx: ExecutionContext, env: Record&lt;string, unknown>) {
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
        const context = createWorkflowRunContext<Params>({
            env: this.env,
            event,
            exportName: this.#lunoraName,
            step: step as unknown as WorkflowStepLike,
        });

        return this.#definition.handler(context);
    }
}

export default LunoraWorkflow;
