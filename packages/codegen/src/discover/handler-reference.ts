/**
 * Resolution of a queue / workflow `handler:` written as a reference
 * (`handler: onboard`) rather than an inline function, so discovery can read
 * the function it names wherever it is declared.
 */
import { dirname } from "node:path";

import type { Node as TsNode, ObjectLiteralElementLike } from "ts-morph";
import { Node } from "ts-morph";

import type { HandlerSiteIR } from "../ir";
import { lunoraRelativePath, unwrapExpression } from "./ast";
import { exportedNameOf } from "./attribution";

/** A `handler:` reference resolved to the function it names. */
interface HandlerReference {
    /** The function itself: a `function` declaration, or a `const`'s arrow / function expression. */
    body: TsNode;

    /**
     * The declaring file when it is not the file holding the `handler:` property:
     * lunora-relative inside `lunora/`, project-relative outside it. `undefined`
     * for a handler declared in the same file.
     */
    file?: string;
    /** Set when the function is exported from a lunora source file — see {@link HandlerSiteIR}. */
    site?: HandlerSiteIR;
}

/** The identifier a `handler:` member points at, or `undefined` for an inline function or a method. */
const referenceOf = (property: ObjectLiteralElementLike): TsNode | undefined => {
    if (Node.isPropertyAssignment(property)) {
        return unwrapExpression(property.getInitializer());
    }

    return Node.isShorthandPropertyAssignment(property) ? property.getNameNode() : undefined;
};

/**
 * Follow `handler: onboard` (or the shorthand `{ handler }`) through its symbol —
 * and through imports and re-exports via the aliased symbol — to the function it
 * names. `undefined` for an inline handler, a method, or a reference that does
 * not resolve to a `function` / function-valued `const`.
 */
const resolveHandlerReference = (property: ObjectLiteralElementLike | undefined, lunoraDirectory: string): HandlerReference | undefined => {
    const reference = property === undefined ? undefined : referenceOf(property);

    if (reference === undefined || !Node.isIdentifier(reference)) {
        return undefined;
    }

    const parent = reference.getParent();
    const symbol = Node.isShorthandPropertyAssignment(parent) ? parent.getValueSymbol() : reference.getSymbol();
    const target = symbol?.getAliasedSymbol() ?? symbol;

    for (const declaration of target?.getDeclarations() ?? []) {
        const body = Node.isVariableDeclaration(declaration) ? unwrapExpression(declaration.getInitializer()) : declaration;
        const isFunction = Node.isFunctionDeclaration(body) || Node.isArrowFunction(body) || Node.isFunctionExpression(body);

        if (!isFunction || !(Node.isFunctionDeclaration(declaration) || Node.isVariableDeclaration(declaration))) {
            continue;
        }

        const sourceFile = declaration.getSourceFile();
        const inLunora = lunoraRelativePath(lunoraDirectory, sourceFile.getFilePath());
        const isLunora = !inLunora.startsWith("../");
        const file = isLunora ? inLunora : lunoraRelativePath(dirname(lunoraDirectory), sourceFile.getFilePath());
        const exportName = exportedNameOf(declaration);

        return {
            body,
            ...(sourceFile === reference.getSourceFile() ? {} : { file }),
            ...(isLunora && exportName !== undefined ? { site: { exportName, file } } : {}),
        };
    }

    return undefined;
};

export type { HandlerReference };
export { resolveHandlerReference };
