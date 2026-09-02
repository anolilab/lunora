import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a public `v.string()` argument with no length bound.
 *
 * A string field that accepts an unbounded value lets a client send megabytes of
 * text per request — inflating storage, blowing the row/document size budget, and
 * driving CPU/memory on every handler that processes it. A `.max(n)` (or
 * `.length(n)`) bound caps the blast radius. Only those two count: `.meta({
 * maxLength })` publishes a cap the parser never enforces, and a bare `.check()`
 * may predicate anything — neither is evidence the length is bounded. Advisory
 * (INFO): a deliberately-open free-text field is sometimes legitimate, so this
 * nudges rather than blocks.
 *
 * Runs only when the codegen feeder supplies arg evidence
 * (`context.argValidators`, public procedures only); a runtime caller flags
 * nothing. One finding per offending arg.
 */
const unboundedStringArgument: Lint = {
    categories: ["SECURITY"],
    description:
        "A public `v.string()` argument has no maximum-length bound. An unbounded string lets a client submit arbitrarily large input — abusing storage and CPU on every request that processes it.",
    facing: "EXTERNAL",
    level: "INFO",
    name: "unbounded_string_arg",
    remediation:
        "Add an enforced max-length bound with `.max(n)` on the string validator (e.g. cap a name at 256, a body at a few KB). `.meta({ maxLength })` only documents a cap — the parser does not enforce it. Size the cap to the field's real-world maximum.",
    run: (context) => {
        if (context.argValidators === undefined) {
            return [];
        }

        return context.argValidators.flatMap((procedure) =>
            procedure.unboundedStringArgs.map((argument) =>
                emit(unboundedStringArgument, {
                    cacheKey: `unbounded_string_arg:${procedure.file}:${procedure.exportName}:${argument}`,
                    detail: `Arg \`${argument}\` of public procedure \`${procedure.exportName}\` (${procedure.file}:${procedure.line.toString()}) is an unbounded \`v.string()\`. Add a max-length bound to cap payload size.`,
                    metadata: { argument, exportName: procedure.exportName, file: procedure.file, line: procedure.line },
                }),
            ),
        );
    },
    source: "static",
    title: "Public string argument has no length bound",
};

export default unboundedStringArgument;
