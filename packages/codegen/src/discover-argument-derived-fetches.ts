import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { ArgumentDerivedFetchIR } from "./ir";

/**
 * True when `node` is a `ctx.fetch` member access — the action-only outbound-request
 * escape hatch. Matched by shape (`ctx.fetch`), the same `import`-agnostic, fail-closed
 * convention the other feeders use, so a re-export or alias still resolves.
 */
const isContextFetchCallee = (node: TsNode): boolean => {
    if (!Node.isPropertyAccessExpression(node) || node.getName() !== "fetch") {
        return false;
    }

    const receiver = node.getExpression();

    return Node.isIdentifier(receiver) && receiver.getText() === "ctx";
};

/** The IR row for a `ctx.fetch(url, …)` call whose URL argument is arg-derived, or `undefined`. */
const fetchInCall = (call: CallExpression, relativePath: string): ArgumentDerivedFetchIR | undefined => {
    if (!isContextFetchCallee(call.getExpression())) {
        return undefined;
    }

    const url = call.getArguments()[0];

    if (!url || !isArgumentDerived(url)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber() };
};

/** Arg-derived `ctx.fetch` URLs in one source file. */
const fetchesInSourceFile = (sourceFile: SourceFile, relativePath: string): ArgumentDerivedFetchIR[] => {
    const found: ArgumentDerivedFetchIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const fetchCall = fetchInCall(call, relativePath);

        if (fetchCall) {
            found.push(fetchCall);
        }
    }

    return found;
};

/**
 * Discover `ctx.fetch(url, …)` calls in `lunora/` whose URL argument is derived from
 * the handler's `args` — the `action_fetch_ssrf` lint input. `ctx.fetch` is the
 * action-only outbound-request escape hatch with no host allowlist, so a URL built
 * from request input is a server-side request forgery vector (cloud metadata
 * endpoints, internal services). A fixed literal URL, or one built from config /
 * `ctx.*`, is not recorded; only an arg-derived URL (directly, or through one local
 * `const` hop) reaches here.
 */
const discoverArgumentDerivedFetches = (project: Project, lunoraDirectory: string): ArgumentDerivedFetchIR[] => {
    const fetches: ArgumentDerivedFetchIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        fetches.push(...fetchesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return fetches;
};

export default discoverArgumentDerivedFetches;
