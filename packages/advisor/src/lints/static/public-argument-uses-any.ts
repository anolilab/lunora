import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `v.any()` argument on a public procedure.
 *
 * `v.any()` disables validation: the field accepts arbitrary, untyped,
 * arbitrarily-large input straight from an untrusted client. That defeats the
 * end-to-end type safety Lunora exists to provide and opens the door to injection,
 * prototype pollution, and oversized-payload abuse. Public input should be a
 * precise validator (`v.object`, `v.string`, `v.union`, …).
 *
 * Runs only when the codegen feeder supplies arg evidence
 * (`context.argValidators`, public procedures only); a runtime caller flags
 * nothing. One finding per offending arg.
 */
const publicArgumentUsesAny: Lint = {
    categories: ["SECURITY"],
    description:
        "A public procedure declares a `v.any()` argument. `v.any()` accepts arbitrary untyped input from an untrusted client — defeating validation and opening injection / oversized-payload abuse.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "public_arg_uses_any",
    remediation:
        "Replace `v.any()` with a precise validator — `v.object({...})`, `v.string()`, `v.union(...)`, etc. If the shape is genuinely dynamic, model the known variants with `v.union` rather than accepting anything.",
    run: (context) => {
        if (context.argValidators === undefined) {
            return [];
        }

        return context.argValidators.flatMap((procedure) =>
            procedure.anyArgs.map((argument) =>
                emit(publicArgumentUsesAny, {
                    cacheKey: `public_arg_uses_any:${procedure.file}:${procedure.exportName}:${argument}`,
                    detail: `Arg \`${argument}\` of public procedure \`${procedure.exportName}\` (${procedure.file}:${procedure.line.toString()}) is \`v.any()\` — untrusted input with no validation. Give it a precise validator.`,
                    metadata: { argument, exportName: procedure.exportName, file: procedure.file, line: procedure.line },
                }),
            ),
        );
    },
    source: "static",
    title: "Public argument uses v.any()",
};

export default publicArgumentUsesAny;
