import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a procedure that runs an AI generation but emits no structured event.
 *
 * Model calls are the least reproducible thing in an app and the only one that
 * bills per invocation: the same input can return a different answer tomorrow,
 * and a runaway loop is a cost incident rather than an outage. Without an event
 * recording that the call happened there is no way to attribute spend, compare a
 * bad answer against the prompt that produced it, or notice a retry storm.
 *
 * Keyed on whether the handler runs a model at all — bounded or not. An earlier
 * cut reused the `unboundedAiGeneration` / raw-run signals, which meant the
 * correctly-bounded `generateText({ …, maxOutputTokens })` — the common case, and
 * the one this rule exists for — was never flagged, while procedures another lint
 * had already caught were charged twice.
 */
const aiRunWithoutLogging: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A procedure runs an AI generation but emits no structured event. Model calls bill per invocation and are not reproducible, so without one there is no way to attribute spend or trace a bad answer back to its prompt.",
    facing: "INTERNAL",
    level: "INFO",
    name: "ai_run_without_logging",
    remediation: 'Emit an event around the generation — `ctx.span("<name>", …)`, or a `ctx.log` line carrying the model and token usage.',
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        const findings = [];

        for (const procedure of context.procedureProtections) {
            if (procedure.runsAiGeneration !== true || procedure.emitsEvent !== false) {
                continue;
            }

            findings.push(
                emit(aiRunWithoutLogging, {
                    cacheKey: `ai_run_without_logging:${procedure.file}:${procedure.exportName}`,
                    detail: `${procedure.kind} \`${procedure.exportName}\` (${procedure.file}) runs an AI generation with no structured event, so its cost and output cannot be attributed later.`,
                    metadata: { exportName: procedure.exportName, file: procedure.file, kind: procedure.kind },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "AI generation with no structured event",
};

export default aiRunWithoutLogging;
