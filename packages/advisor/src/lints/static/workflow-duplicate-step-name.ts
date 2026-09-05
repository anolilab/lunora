import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a durable step name reused across two call sites in one workflow.
 *
 * **The mechanism, precisely.** Cloudflare does not key a step by its name alone:
 * the engine keeps a per-run occurrence counter per name and caches under
 * `hash(name-count)-count` (miniflare's `binding.worker.js`, and the public
 * `WorkflowStepContext.step.count` that exists to expose it). So the second call
 * under a repeated name is NOT served the first's cached result — it gets
 * occurrence 2 and runs. That is what makes the documented loop-over-items
 * pattern legal, and one loop is one call site, so it never reaches this lint.
 *
 * What two DISTINCT call sites sharing a name cost instead is that the mapping
 * from call site to cached result becomes positional. Occurrence 2 is "whichever
 * of these ran second", so a conditional, an early return, or a reordering
 * between them re-points a later replay's cache at the other step's stored
 * output — silently, with the workflow proceeding on the wrong value. They are
 * also indistinguishable in the step log and the dashboard. Hence
 * `ERROR`/`INTERNAL`: a developer-facing correctness defect in the workflow's own
 * code, not a runtime-data nit.
 *
 * **Scope — what the feeder can and cannot see.** Only the first string-literal
 * argument of a NATIVE step call (`ctx.step.<method>` or a destructured
 * `step.<method>`) is compared. Three classes are therefore invisible here, by
 * construction rather than by oversight. A dynamically named step
 * (`step.do(\`load-${id}\`, …)`) is omitted so a deliberately-parameterized
 * fan-out is never flagged. `ctx.runStep(stepDef, …)` resolves its name to
 * `options?.name ?? step.name` from a `defineStep` in another file, and
 * `ctx.waitForEvent(eventDef, …)` to `options?.name ?? \`event:${event.type}\``
 * from a `defineWorkflowEvent` in another file — both framework-minted, both
 * needing cross-file resolution to recover.
 *
 * Leaving those two out costs nothing that matters: a repeat of either is an
 * ordinary second occurrence under the engine's counter, so it waits/runs as
 * written. The remediation below names only the surfaces actually compared.
 *
 * Only runs when the declaration feeder supplied step evidence
 * (`workflow.steps` present); a runtime caller flags nothing.
 */
const workflowDuplicateStepName: Lint = {
    categories: ["SCHEMA"],
    description:
        "Two durable step call sites in this workflow share a name. Cloudflare caches a step under its name plus its occurrence number within the run, so which cached result each call site gets is decided by the order they ran — a conditional or a reordering between them re-points a later replay at the other step's stored output, silently and without an error. They are also indistinguishable in the step log.",
    facing: "INTERNAL",
    level: "ERROR",
    // eslint-disable-next-line no-secrets/no-secrets -- the lint's rule id, not a credential
    name: "workflow_duplicate_step_name",
    remediation:
        "Give every `step.do` / `step.sleep` / `step.sleepUntil` / `step.waitForEvent` CALL SITE in the workflow its own name. A single call site that repeats — a loop over items — is fine as written and is not flagged; interpolate the item id into the name only if you want the iterations distinguishable in the step log.",
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
