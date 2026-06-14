/**
 * `createWorkflowContext` — the codegen-facing factory that builds the
 * `ctx.workflows` surface from the Worker `env` plus the binding specs emitted
 * into `_generated/shard.ts`. Mirrors `@cirrus/container`'s
 * `createContainerContext`: codegen owns the spec list, this resolves each
 * `env[binding]` and hands the map to {@link createWorkflows}.
 *
 * Node-safe (structural binding types only) so it's unit-testable with
 * plain-object env doubles.
 */
import createWorkflows from "./create-workflows";
import type { WorkflowBindingLike, Workflows } from "./types";

/** Wiring info for one declared workflow, emitted by codegen into the generated shard. */
export interface WorkflowBindingSpec {
    /** The Cloudflare `Workflow` binding name, e.g. `WORKFLOW_ORDER_PIPELINE`. */
    binding: string;
    /** The `cirrus/workflows.ts` export name, e.g. `orderPipeline`. */
    exportName: string;
}

/**
 * Build the `ctx.workflows` handle for a request: resolve every spec's
 * `env[binding]` into the `exportName → Workflow binding` map and wrap it in
 * {@link createWorkflows}. A spec whose binding is absent from `env` is skipped
 * here — the helpful "no workflow named …" error is raised lazily by
 * `workflows.get(name)` when the missing workflow is actually used.
 */
export const createWorkflowContext = (env: Record<string, unknown>, specs: ReadonlyArray<WorkflowBindingSpec>): Workflows => {
    const bindings: Record<string, WorkflowBindingLike> = {};

    for (const spec of specs) {
        const binding = env[spec.binding] as WorkflowBindingLike | undefined;

        if (binding && typeof binding.create === "function" && typeof binding.createBatch === "function" && typeof binding.get === "function") {
            bindings[spec.exportName] = binding;
        }
    }

    return createWorkflows({ bindings });
};
