import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags an `action` that reaches an outbound surface with no `try`/`catch`
 * anywhere in its body.
 *
 * Actions are where Lunora talks to things it does not control — `ctx.fetch`,
 * mail, queues, storage, external SQL, AI. Every one of those fails routinely
 * (timeout, 5xx, quota), and an uncaught rejection there surfaces to the caller
 * as an opaque failure with no indication of which dependency broke. Catching it
 * is what lets the handler add that context, or degrade instead of failing.
 *
 * Only `action` is checked: queries and mutations run inside the Durable Object
 * and cannot reach these surfaces. Runs only when the codegen feeder supplies
 * procedure evidence.
 */
const actionWithoutErrorHandling: Lint = {
    categories: ["SCHEMA"],
    description:
        "An `action` calls an outbound surface (fetch, mail, queues, storage, sql, ai) with no `try`/`catch`. Those fail routinely, and an uncaught rejection reaches the caller with no indication of which dependency broke.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "action_without_error_handling",
    remediation: "Wrap the outbound call in `try`/`catch`, then either degrade or rethrow a coded `LunoraError` naming the dependency that failed.",
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        const findings = [];

        for (const procedure of context.procedureProtections) {
            if (procedure.kind !== "action" || procedure.reachesOutbound !== true || procedure.handlesErrors !== false) {
                continue;
            }

            findings.push(
                emit(actionWithoutErrorHandling, {
                    cacheKey: `action_without_error_handling:${procedure.file}:${procedure.exportName}`,
                    detail: `Action \`${procedure.exportName}\` (${procedure.file}) calls an outbound surface with no \`try\`/\`catch\`. A dependency failure will surface to the caller unexplained.`,
                    metadata: { exportName: procedure.exportName, file: procedure.file, kind: procedure.kind },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Action performs outbound I/O with no error handling",
};

export default actionWithoutErrorHandling;
