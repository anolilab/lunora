/**
 * `ctx.workflows` — a thin, typed pass-through over the Cloudflare `Workflow`
 * bindings. Node-safe (structural binding types), so it's exercised by unit
 * tests with plain-object doubles.
 */
import type { LunoraWorkflowsOptions, WorkflowBindingLike, WorkflowCreateOptions, WorkflowHandle, WorkflowInstanceLike, Workflows } from "./types";

/** Wrap a single Cloudflare `Workflow` binding in the {@link WorkflowHandle} surface. */
const handleFor = (binding: WorkflowBindingLike): WorkflowHandle => {
    return {
        create: async (options?: WorkflowCreateOptions): Promise<WorkflowInstanceLike> => binding.create(options),
        createBatch: async (batch: ReadonlyArray<WorkflowCreateOptions>): Promise<WorkflowInstanceLike[]> => binding.createBatch(batch),
        get: async (id: string): Promise<WorkflowInstanceLike> => binding.get(id),
    };
};

/**
 * Build the `ctx.workflows` handle from a map of `lunora/workflows.ts` export
 * name → Cloudflare `Workflow` binding. `get(name)` resolves the typed handle;
 * an unknown name throws with the list of declared workflows.
 */
const createWorkflows = (options: LunoraWorkflowsOptions): Workflows => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
    const bindings = options.bindings ?? {};

    return {
        get: <Params = Record<string, unknown>>(name: string): WorkflowHandle<Params> => {
            const binding = bindings[name];

            if (binding === undefined) {
                const known = Object.keys(bindings);
                const suffix = known.length === 0 ? "no workflows are declared" : `known workflows: ${known.join(", ")}`;

                throw new Error(`@lunora/workflow: no workflow named "${name}" (${suffix})`);
            }

            return handleFor(binding) as WorkflowHandle<Params>;
        },
    };
};

export default createWorkflows;
