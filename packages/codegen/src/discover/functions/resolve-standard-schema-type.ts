import type { Node, Type } from "ts-morph";

import isAnyDegraded from "./internal/any-token";
import { expandUnreachableType, referencesUnreachableLocalType } from "./internal/type-expansion";

/**
 * The inferred type of a `v.from(externalSchema)` argument, rendered for
 * `_generated/`.
 *
 * Reads `~standard.types.output` off the wrapped schema — the property Standard
 * Schema v1 exposes precisely so tooling can recover the inferred type, and the
 * same one the runtime's `InferStandardOutput` reads, so the emitted type and
 * the value that actually reaches the handler agree.
 *
 * Runs the result through the same guards as the handler-return path: an
 * `any`-degraded render (checker without tsconfig wiring) falls back to
 * `unknown` rather than misleading, and a locally-declared type unreachable
 * from `_generated/` is structurally expanded rather than emitted as a bare
 * name that would not resolve. Returns `undefined` when nothing safe can be
 * produced, leaving the caller on `unknown`.
 */
const resolveStandardSchemaType = (node: Node): string | undefined => {
    const standard = node.getType().getProperty("~standard");

    if (!standard) {
        return undefined;
    }

    const types = standard.getTypeAtLocation(node).getProperty("types");

    if (!types) {
        return undefined;
    }

    const output = types.getTypeAtLocation(node).getNonNullableType().getProperty("output");

    if (!output) {
        return undefined;
    }

    const outputType = output.getTypeAtLocation(node);
    const rendered = outputType.getText(node);

    if (!rendered || rendered === "any" || rendered === "never" || isAnyDegraded(rendered)) {
        return undefined;
    }

    const filePath = node.getSourceFile().getFilePath();

    if (referencesUnreachableLocalType(outputType, node, filePath)) {
        return expandUnreachableType(outputType, node, filePath, 0, new Set<Type>());
    }

    return rendered;
};

export default resolveStandardSchemaType;
