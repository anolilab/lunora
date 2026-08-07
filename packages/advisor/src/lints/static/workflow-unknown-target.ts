import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * A correctness lint: every `ctx.workflows.get("name")` call must reference a
 * workflow that exists — i.e. a `defineWorkflow` export in `lunora/workflows.ts`.
 * A `.get("x")` whose `"x"` resolves to no declared workflow is a typo or a
 * reference to a workflow that was removed/renamed; codegen wires the typed
 * `ctx.workflows` accessor off the declared set, so the call throws at runtime.
 * Caught here at codegen time instead.
 *
 * Calls with a non-literal name (`workflow === ""`) are skipped — they can't be
 * statically resolved, so they're neither confirmed-unknown here nor counted as
 * a typo. Only runs when both feeders supplied evidence (declared workflows and
 * discovered calls); a runtime caller flags nothing.
 */
const workflowUnknownTarget: Lint = {
    categories: ["SCHEMA"],
    description:
        'A `ctx.workflows.get("<name>")` call references a workflow that is not declared by any `defineWorkflow` export in `lunora/workflows.ts`. The name is a typo or points at a removed/renamed workflow — the call throws at runtime.',
    facing: "INTERNAL",
    level: "ERROR",
    name: "workflow_unknown_target",
    remediation: 'Fix the workflow name in the `ctx.workflows.get("…")` call, or add the missing `defineWorkflow` export to `lunora/workflows.ts`.',
    run: (context) => {
        // Need both the declared set (to know what's valid) and the call sites.
        if (context.workflows === undefined || context.workflowCalls === undefined) {
            return [];
        }

        const declared = new Set(context.workflows.map((workflow) => workflow.exportName));

        // A dynamic name (`""`) is not statically resolvable, so not a confirmed typo.
        return context.workflowCalls
            .filter((call) => call.workflow !== "" && !declared.has(call.workflow))
            .map((call) =>
                emit(workflowUnknownTarget, {
                    cacheKey: `workflow_unknown_target:${call.file}:${call.exportName}:${call.workflow}`,
                    detail: `\`ctx.workflows.get("${call.workflow}")\` in "${call.exportName}" (${call.file}) references workflow "${call.workflow}", which is not declared in lunora/workflows.ts.`,
                    metadata: { exportName: call.exportName, file: call.file, line: call.line, workflow: call.workflow },
                }),
            );
    },
    source: "static",
    title: "Workflow call references unknown workflow",
};

export default workflowUnknownTarget;
