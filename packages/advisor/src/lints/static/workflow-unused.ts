import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a declared workflow that nothing starts.
 *
 * Cross-references every `defineWorkflow` export against the set of workflow
 * names some function references via `ctx.workflows.get("<name>")`. A workflow
 * with no such call is either dead code (declared, deployed as a billable
 * `WorkflowEntrypoint`, never triggered) or is started through a path the static
 * analysis can't see — the Cloudflare REST API, a `wrangler` invocation, or a
 * cross-service binding. Hence `INFO`/`INTERNAL`: a nudge to confirm intent.
 *
 * Suppressed entirely when any call uses a non-literal name
 * (`ctx.workflows.get(someVariable)`), because a dynamic dispatch could target
 * any declared workflow — flagging "unused" workflows then would be a false
 * positive. Only runs when BOTH feeders supplied evidence (`context.workflows`
 * and `context.workflowCalls` present); a runtime caller flags nothing.
 */
const workflowUnused: Lint = {
    categories: ["SCHEMA"],
    description:
        'No function starts this workflow via `ctx.workflows.get("<name>")`. It may be triggered through a path the advisor can\'t see (the Cloudflare API, a wrangler invocation, a cross-service binding) — or it may be dead code that still deploys as a billable WorkflowEntrypoint.',
    facing: "INTERNAL",
    level: "INFO",
    name: "workflow_unused",
    remediation:
        'If the workflow should be triggered in-app, start it from a mutation/action with `ctx.workflows.get("<name>").create({ params })`. If it is started externally or is no longer needed, this advisory can be ignored (or remove the `defineWorkflow` export).',
    run: (context) => {
        // Both feeds are required, exactly as `workflow_unknown_target` and
        // `geo_index_unused` require theirs. Absent USAGE evidence the "started"
        // set is empty and EVERY declared workflow reads as never started — a
        // verdict about call sites nobody supplied.
        if (context.workflows === undefined || context.workflowCalls === undefined) {
            return [];
        }

        const calls = context.workflowCalls;

        // A dynamic `get(<expr>)` could target any workflow — can't prove any are
        // unused, so stay silent rather than emit false positives.
        if (calls.some((call) => call.workflow === "")) {
            return [];
        }

        const started = new Set(calls.map((call) => call.workflow));

        return context.workflows
            .filter((workflow) => !started.has(workflow.exportName))
            .map((workflow) =>
                emit(workflowUnused, {
                    cacheKey: `workflow_unused:${workflow.exportName}`,
                    detail: `No function calls \`ctx.workflows.get("${workflow.exportName}")\` — workflow "${workflow.exportName}" is declared but never started in app code.`,
                    metadata: { workflow: workflow.exportName },
                }),
            );
    },
    source: "static",
    title: "Workflow is never started",
};

export default workflowUnused;
