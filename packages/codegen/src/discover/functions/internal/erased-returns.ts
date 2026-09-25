import type { Node as TsNode } from "ts-morph";
import { Node } from "ts-morph";

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
 * Return types this codegen run erased to `unknown` because no renderable form
 * could be produced.
 *
 * A module-level buffer rather than a threaded return value: the two places that
 * detect an erasure (`unwrap-handler-return.ts` and
 * `resolve-standard-schema-type.ts`) are reached through `discoverFunctions`,
 * `discoverMutators`, `discoverHttpRoutes`, the builder-chain walker and the
 * validator parser, each of which returns a rendered STRING. Threading a finding
 * back out would change six signatures to carry something only one caller reads.
 *
 * Drained rather than read, and drained once at the start of a run as well, so a
 * run that threw mid-way cannot leak its records into the next one.
 */
let erased: ErasedReturn[] = [];

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
    erased.push({
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
 * Mark the buffer's current end; the returned function drops everything recorded
 * after it. The inference fixpoint re-runs discovery until the render stops
 * changing, and a return that erased on an early pass can render on a later one —
 * only the final pass's erasures describe what is written.
 */
const checkpointErasedReturns = (): (() => void) => {
    const mark = erased.length;

    return () => {
        erased.splice(mark);
    };
};

/** Take everything recorded so far and reset the buffer. */
const takeErasedReturns = (): ErasedReturn[] => {
    const taken = erased;

    erased = [];

    return taken;
};

export type { ErasedReturn };
export { checkpointErasedReturns, parseOutput, recordErasedOutput, recordErasedReturn, takeErasedReturns };
