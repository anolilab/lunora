import type { CallExpression } from "ts-morph";
import { Node } from "ts-morph";

/** Strips a trailing `.ts` extension from a relative source path. */
export const TS_EXTENSION_RE: RegExp = /\.ts$/u;

/**
 * Export binding name of the exported, top-level function that lexically contains
 * the call (e.g. `export const send = mutation({ … })` → `"send"`), or `""` when
 * the call isn't inside an exported declaration. Walks out past any local
 * `const x = …` declarations to the exported one.
 *
 * Shared by the call-attribution discoverers (`discover-inserts`,
 * `discover-authapi-calls`, `discover-workflow-calls`). The
 * `discover-sql-interpolation` variant has divergent semantics (no export-keyword
 * check, `"<module>"` fallback) and is intentionally NOT this helper.
 */
export const enclosingExportName = (call: CallExpression): string => {
    for (const ancestor of call.getAncestors()) {
        if (Node.isVariableDeclaration(ancestor) && ancestor.getVariableStatement()?.hasExportKeyword() === true) {
            return ancestor.getName();
        }
    }

    return "";
};
