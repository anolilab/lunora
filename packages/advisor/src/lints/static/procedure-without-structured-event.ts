import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a public `mutation`/`action` whose handler emits no structured
 * observability event.
 *
 * When one of these fails in production you get a stack trace and nothing about
 * the request that caused it — no ids, no tenant, no outcome. `ctx.log` /
 * `ctx.span` attach that context to the invocation, so the failure is
 * searchable instead of merely visible. Reads are excluded: a `query` that
 * returns the wrong rows is diagnosable from its arguments, while a write that
 * half-succeeded is not.
 *
 * Runs only when the codegen feeder supplies procedure evidence; a runtime
 * caller with no evidence flags nothing. The feeder reports "no event" only when
 * it could read the body, so a procedure whose handler it cannot analyze is left
 * alone rather than nagged.
 */
const procedureWithoutStructuredEvent: Lint = {
    categories: ["SCHEMA"],
    description:
        "A public `mutation`/`action` emits no structured event. When it fails you get a stack trace with no request context — no ids, no tenant, no outcome — so the failure is visible but not searchable.",
    facing: "INTERNAL",
    level: "INFO",
    name: "procedure_without_structured_event",
    remediation: 'Emit one event on the primary path: `ctx.log.info("<verb>", { … })`, or wrap the handler in `ctx.span("<name>", …)` to attach timing too.',
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        // `emitsEvent === undefined` means the feeder could not read the body — don't nag.
        return context.procedureProtections
            .filter((procedure) => procedure.visibility === "public" && procedure.kind !== "query" && procedure.emitsEvent === false)
            .map((procedure) =>
                emit(procedureWithoutStructuredEvent, {
                    cacheKey: `procedure_without_structured_event:${procedure.file}:${procedure.exportName}`,
                    detail: `Public ${procedure.kind} \`${procedure.exportName}\` (${procedure.file}) emits no structured event. Add a \`ctx.log\` line or a \`ctx.span\` so a failure carries its request context.`,
                    metadata: { exportName: procedure.exportName, file: procedure.file, kind: procedure.kind },
                }),
            );
    },
    source: "static",
    title: "Public write emits no structured event",
};

export default procedureWithoutStructuredEvent;
