import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a procedure that throws a bare `new Error(...)`.
 *
 * A bare `Error` crosses the RPC boundary as an opaque message: the client
 * cannot branch on it, `@lunora/fingerprint` cannot group it into an issue, and
 * the message itself is free text that changes whenever someone edits the
 * string. `LunoraError` carries a stable code from `ERROR_CATALOG`, which is
 * what makes an error both matchable on the client and groupable in Studio.
 *
 * Runs only when the codegen feeder supplies procedure evidence; a runtime
 * caller with no evidence flags nothing.
 */
const errorWithoutCatalog: Lint = {
    categories: ["SCHEMA"],
    description:
        "A procedure throws a bare `new Error(...)`. It reaches the client as an opaque message the caller cannot branch on, and error grouping cannot fingerprint it into a stable issue.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "error_without_catalog",
    remediation:
        'Throw a coded error instead: `throw new LunoraError("<CODE>", { … })` from `@lunora/errors`, adding the code to `ERROR_CATALOG` if it is new.',
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        const findings = [];

        for (const procedure of context.procedureProtections) {
            if (procedure.throwsBareError !== true) {
                continue;
            }

            findings.push(
                emit(errorWithoutCatalog, {
                    cacheKey: `error_without_catalog:${procedure.file}:${procedure.exportName}`,
                    detail: `${procedure.kind} \`${procedure.exportName}\` (${procedure.file}) throws a bare \`new Error(...)\`. Use \`LunoraError\` with a catalog code so the client can branch on it and Studio can group it.`,
                    metadata: { exportName: procedure.exportName, file: procedure.file, kind: procedure.kind },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Bare Error thrown instead of a coded LunoraError",
};

export default errorWithoutCatalog;
