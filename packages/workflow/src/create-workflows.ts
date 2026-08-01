/**
 * `ctx.workflows` — a thin, typed pass-through over the Cloudflare `Workflow`
 * bindings. Node-safe (structural binding types), so it's exercised by unit
 * tests with plain-object doubles.
 */
import { LunoraError } from "@lunora/errors";

import { BRANCH_MARKER_KEY, hasBranchMarker } from "../../../shared/branch-marker";
import type { LunoraWorkflowsOptions, WorkflowBindingLike, WorkflowCreateOptions, WorkflowHandle, WorkflowInstanceLike, Workflows } from "./types";

/**
 * Reject any public create whose params carry the reserved branch-marker key.
 * `__lunoraBranch` is an internal join-callback marker that `ctx.parallel`
 * injects and a child trusts to address its parent's instance/binding/event; a
 * caller-supplied marker (forwarding client-controlled args into a create) would
 * let a forged marker reach a child's `event.payload` and spoof events into an
 * arbitrary workflow instance. Closing it at the trust boundary keeps user params
 * free of the reserved key while leaving `createParallel`'s own injection intact.
 */
const rejectReservedParams = (options?: WorkflowCreateOptions): void => {
    if (hasBranchMarker(options?.params)) {
        throw new LunoraError("BAD_REQUEST", `@lunora/workflow: params may not contain the reserved key "${BRANCH_MARKER_KEY}"`);
    }
};

/** Wrap a single Cloudflare `Workflow` binding in the {@link WorkflowHandle} surface. */
const handleFor = (binding: WorkflowBindingLike): WorkflowHandle => {
    return {
        create: async (options?: WorkflowCreateOptions): Promise<WorkflowInstanceLike> => {
            rejectReservedParams(options);

            return binding.create(options);
        },
        createBatch: async (batch: ReadonlyArray<WorkflowCreateOptions>): Promise<WorkflowInstanceLike[]> => {
            for (const options of batch) {
                rejectReservedParams(options);
            }

            return binding.createBatch(batch);
        },
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

                throw new LunoraError("INTERNAL", `@lunora/workflow: no workflow named "${name}" (${suffix})`);
            }

            return handleFor(binding) as WorkflowHandle<Params>;
        },
    };
};

export default createWorkflows;
