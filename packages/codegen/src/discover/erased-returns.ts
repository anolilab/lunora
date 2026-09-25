import type { Finding } from "@lunora/advisor";

import { lunoraRelativePath } from "./ast";
import type { ErasedReturn } from "./functions/internal/erased-returns";
import { takeErasedReturns } from "./functions/internal/erased-returns";

/**
 * Report a procedure whose return/output type could not be rendered into
 * `_generated/` and was replaced by `unknown`.
 *
 * The mirror of `procedure_arguments_unreadable` on the OUTPUT side, and for the
 * same reason. Codegen can name a type only if the text it emits resolves from
 * `_generated/`; when it does not, the honest answer is `unknown`. That answer is
 * also indistinguishable, at the call site, from a procedure that genuinely
 * returns nothing useful — so a whole app's outputs erasing at once shows up as
 * several hundred type errors in consumer code, with `lunora codegen` exiting 0
 * and no advisory raised (issue #810).
 *
 * A warning, never an abort: `unknown` is sound — it under-states the contract,
 * it never mis-states it — and refusing to generate would leave an app unable to
 * build over a type the runtime handles fine.
 */
const findingFor = (record: ErasedReturn, relativePath: string): Finding => {
    const where = record.exportName ?? `line ${record.line.toString()}`;

    return {
        cacheKey: `procedure_return_type_erased:${relativePath}:${where}`,
        categories: ["SCHEMA"],
        description:
            "Codegen renders a procedure's return type into `_generated/`, where only names that resolve from that directory may appear. A type it can neither name nor reproduce structurally — a class instance, a call or index signature, a recursive or very deeply nested shape — is emitted as `unknown` instead, so callers lose the shape while the runtime still returns it.",
        detail: `\`${where}\` in \`${relativePath}\` (line ${record.line.toString()}) returns \`${record.rendered}\`, which codegen could not reproduce — its generated type is \`unknown\`.`,
        facing: "INTERNAL",
        level: "WARN",
        metadata: { exportName: record.exportName, filePath: relativePath, line: record.line, rendered: record.rendered },
        name: "procedure_return_type_erased",
        remediation:
            "Declare the shape explicitly with `.output(...)`, or export the type from the module that declares it so codegen can name it. A class instance cannot cross the wire at all — return a plain object.",
        title: "Procedure return type is missing from the generated type",
    };
};

/**
 * Drain the erasures this codegen run recorded and turn them into findings.
 *
 * Reads a buffer the discovery passes filled rather than re-deriving anything —
 * the signal is "expansion was attempted and produced nothing", which exists
 * only at the moment of the fallback. Deduplicated on the cache key, because one
 * procedure can record several erasures in a single pass — one per erasing
 * `v.from(...)` inside its `.output(...)`. Re-run inference passes are not the
 * source: `inferToFixpoint` rewinds each one's records before the next.
 */
const discoverErasedReturns = (lunoraDirectory: string): Finding[] => {
    const byKey = new Map<string, Finding>();

    for (const record of takeErasedReturns()) {
        const finding = findingFor(record, lunoraRelativePath(lunoraDirectory, record.filePath));

        byKey.set(finding.cacheKey, finding);
    }

    return [...byKey.values()].toSorted((a, b) => a.cacheKey.localeCompare(b.cacheKey));
};

/**
 * Discard anything recorded before this run started. The buffer is module-level,
 * so a run that threw before draining it would otherwise report its erasures
 * against the next project.
 */
const resetErasedReturns = (): void => {
    takeErasedReturns();
};

export { discoverErasedReturns, resetErasedReturns };
