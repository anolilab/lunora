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
 * A module-level buffer rather than a threaded return value, for the same reason
 * `parse-validator.ts` registers its Standard Schema resolver that way: the two
 * places that detect an erasure (`unwrap-handler-return.ts` and
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

/** Take everything recorded so far and reset the buffer. */
const takeErasedReturns = (): ErasedReturn[] => {
    const taken = erased;

    erased = [];

    return taken;
};

export type { ErasedReturn };
export { recordErasedReturn, takeErasedReturns };
