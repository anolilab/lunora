import type { Finding } from "@lunora/advisor";
import type { Node as TsNode } from "ts-morph";
import { Node } from "ts-morph";

import { lunoraRelativePath } from "./ast";

/** One return/output type that could not be rendered into `_generated/` and became `unknown`. */
interface ErasedReturn {
    /** The exported binding the type belongs to, when the node sits inside one. */
    exportName?: string;
    /** Absolute path of the file declaring the procedure. */
    filePath: string;
    /** 1-based line of the node whose type was erased. */
    line: number;
    /** What the checker printed, before the fallback replaced it — the whole point of reporting. */
    rendered: string;
}

/**
 * Where erasures go right now: the innermost {@link collectErasures} call's list,
 * or `undefined` outside every one — and then a record is dropped.
 *
 * Module state rather than a threaded return value: the two places that detect
 * an erasure (`unwrap-handler-return.ts` and `resolve-standard-schema-type.ts`)
 * are reached through `discoverFunctions`, `discoverMutators`,
 * `discoverHttpRoutes`, the builder-chain walker and the validator parser, each
 * of which returns a rendered STRING. Threading a finding back out would change
 * six signatures to carry something only one caller reads.
 *
 * Scoped to a callback and restored in a `finally`, so nothing outlives the call
 * that wanted it: a run that throws discards its records with its stack frame,
 * and no reset, drain or rewind has to be remembered anywhere else.
 */
let collector: ErasedReturn[] | undefined;

/**
 * The `.output(...)` call whose validator is being parsed, or `undefined` outside
 * one. The `v.from(...)` resolver runs for table fields and `.input(...)` too,
 * where an erasure is not a RETURN type and must not be reported as one.
 *
 * Carried as context rather than found by an ancestor walk because
 * `.output(sharedSchema)` resolves an identifier: the `v.from` node then sits
 * under the shared `const`, nowhere near the procedure. Recording against that
 * node would name the schema, not the procedure, and fold every procedure sharing
 * it into one finding — so the record anchors here instead.
 */
let outputSite: TsNode | undefined;

/**
 * Call `run` and return what it produced alongside every erasure recorded while it
 * ran. Nests: an inner call takes its own records, and they reach an outer one
 * only if the caller passes them on with {@link reportErasures}.
 */
const collectErasures = <T>(run: () => T): { erased: ErasedReturn[]; value: T } => {
    const previous = collector;
    const erased: ErasedReturn[] = [];

    collector = erased;

    try {
        return { erased, value: run() };
    } finally {
        collector = previous;
    }
};

/** Pass records taken by an inner {@link collectErasures} on to the enclosing one. */
const reportErasures = (records: ReadonlyArray<ErasedReturn>): void => {
    collector?.push(...records);
};

/**
 * The nearest enclosing variable binding — `export const getDoc = query…` — so
 * the report names the procedure rather than only a line. `undefined` for a
 * handler that is not bound to a name at all, which stays reportable by file and
 * line.
 */
const enclosingBindingName = (node: TsNode): string | undefined => {
    for (const ancestor of node.getAncestors()) {
        if (Node.isVariableDeclaration(ancestor)) {
            return ancestor.getName();
        }
    }

    return undefined;
};

/**
 * Record that `node`'s type erased to `unknown`.
 *
 * Called only from the expansion-failure paths — never from the deliberate
 * fallbacks (`any`-degraded inference, a value `encodeWire` refuses), which have
 * their own reasons and would turn this into noise.
 */
const recordErasedReturn = (node: TsNode, rendered: string): void => {
    collector?.push({
        exportName: enclosingBindingName(node),
        filePath: node.getSourceFile().getFilePath(),
        line: node.getStartLineNumber(),
        rendered,
    });
};

/**
 * Record that a `v.from(...)` schema's output type erased — against the
 * `.output(...)` call {@link parseOutput} is parsing, and only then, since only
 * there is it a return type.
 */
const recordErasedOutput = (rendered: string): void => {
    if (outputSite !== undefined) {
        recordErasedReturn(outputSite, rendered);
    }
};

/**
 * Run `parse` over the validator of the `.output(...)` call `site`, so its
 * erasures are reported there.
 *
 * Opt-in, and the only way in: an erasure recorded outside this context is
 * DROPPED, because the same resolver also runs for table fields and `.input()`.
 * So every `.output(...)` parse site whose type reaches a generated file must
 * go through here, or its erasures are silently never reported.
 */
const parseOutput = <T>(site: TsNode, parse: () => T): T => {
    const previous = outputSite;

    outputSite = site;

    try {
        return parse();
    } finally {
        outputSite = previous;
    }
};

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
 * Turn the erasures one discovery pass collected into findings.
 *
 * The records come from the pass rather than being re-derived here — the signal
 * is "expansion was attempted and produced nothing", which exists only at the
 * moment of the fallback. Deduplicated on the cache key, because one procedure
 * can record several erasures in a single pass: one per erasing `v.from(...)`
 * inside its `.output(...)`.
 */
const erasedReturnFindings = (records: ReadonlyArray<ErasedReturn>, lunoraDirectory: string): Finding[] => {
    const byKey = new Map<string, Finding>();

    for (const record of records) {
        const finding = findingFor(record, lunoraRelativePath(lunoraDirectory, record.filePath));

        byKey.set(finding.cacheKey, finding);
    }

    return [...byKey.values()].toSorted((a, b) => a.cacheKey.localeCompare(b.cacheKey));
};

export type { ErasedReturn };
export { collectErasures, erasedReturnFindings, parseOutput, recordErasedOutput, recordErasedReturn, reportErasures };
