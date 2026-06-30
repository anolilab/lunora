import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a durable step name reused within one workflow.
 *
 * Cloudflare Workflows memoizes every `step.do` / `step.sleep` / `step.sleepUntil`
 * / `step.waitForEvent` call by its name: on replay the runtime returns the cached
 * result for a name it has already seen. Two distinct steps that share a name are
 * therefore a silent bug — the second call never runs its body and instead yields
 * the first's result, skipping the work (a charge, a write, an external wait)
 * without error. Hence `ERROR`/`INTERNAL`: it is a developer-facing correctness
 * defect in the workflow's own code, not a runtime-data nit.
 *
 * Only the first string-literal argument of each step call is compared; a step
 * named dynamically (`step.do(\`load-${id}\`, …)`) is omitted by the feeder, so a
 * deliberately-parameterized fan-out is never flagged. `ctx.runStep(stepDef, …)`
 * names (which come from `defineStep` in another file) are out of scope here.
 * Only runs when the declaration feeder supplied step evidence
 * (`workflow.steps` present); a runtime caller flags nothing.
 */
const workflowDuplicateStepName: Lint = {
    categories: ["SCHEMA"],
    description:
        "Two durable steps in this workflow share a name. Cloudflare memoizes a step by its name, so on replay the second call returns the first step's cached result instead of running its body — silently skipping the work without an error.",
    facing: "INTERNAL",
    level: "ERROR",
    // eslint-disable-next-line no-secrets/no-secrets -- the lint's rule id, not a credential
    name: "workflow_duplicate_step_name",
    remediation:
        "Give every `step.do` / `step.sleep` / `step.sleepUntil` / `step.waitForEvent` call in the workflow a unique name. If a step legitimately repeats (e.g. a loop), make the name distinct per iteration by interpolating the item id into the step name.",
    run: (context) => {
        // No declaration evidence → nothing to assert (mirrors the other feeders).
        if (context.workflows === undefined) {
            return [];
        }

        const findings = [];

        for (const workflow of context.workflows) {
            const { steps } = workflow;

            if (steps === undefined || steps.length === 0) {
                continue;
            }

            // Group call sites by name; the first occurrence is the "winner" whose
            // cache later duplicates collide with. Emit one finding per duplicated
            // name, pointing at the later call site(s).
            const firstLineByName = new Map<string, number>();
            const reported = new Set<string>();

            for (const step of steps) {
                const firstLine = firstLineByName.get(step.name);

                if (firstLine === undefined) {
                    firstLineByName.set(step.name, step.line);
                    continue;
                }

                if (reported.has(step.name)) {
                    continue;
                }

                reported.add(step.name);

                findings.push(
                    emit(workflowDuplicateStepName, {
                        cacheKey: `workflow_duplicate_step_name:${workflow.exportName}:${step.name}`,
                        detail: `Workflow "${workflow.exportName}" reuses the durable step name "${step.name}" (first at line ${String(firstLine)}, again at line ${String(step.line)}). The second call returns the first's cached result instead of running.`,
                        metadata: { firstLine, line: step.line, stepName: step.name, workflow: workflow.exportName },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "Duplicate durable step name in workflow",
};

export default workflowDuplicateStepName;
