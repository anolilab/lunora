import type { CallExpression, Node as TsNode } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isContextIdentifier } from "./context-root";

/**
 * Names of the framework middleware that can key on the caller's address (a limiter), so they are not assumed
 * free of it even though they come from `@lunora/*`.
 */
const ADDRESS_AWARE_MIDDLEWARE = /rate|limit|\bip\b|geo|throttle/iu;

/** `ctx` methods that run another function on the same caller, whose own reads this analysis cannot see. */
const COMPOSING_METHODS = /^run[A-Z]/u;

/** Whether `identifier` is an import binding from a `@lunora/*` module (a framework export, not app code). */
const isFrameworkImport = (identifier: TsNode): boolean => {
    if (!Node.isIdentifier(identifier)) {
        return false;
    }

    const declarations = identifier.getSymbol()?.getDeclarations() ?? [];

    return declarations.some((declaration) => {
        const importDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);

        return importDeclaration?.getModuleSpecifierValue().startsWith("@lunora/") === true;
    });
};

/** Whether a `.use(argument)` middleware is a framework one that does not read the caller's address. */
const isAddressFreeMiddleware = (argument: TsNode | undefined): boolean => {
    const callee = Node.isCallExpression(argument) ? argument.getExpression() : argument;
    let name: TsNode | undefined;

    if (Node.isIdentifier(callee)) {
        name = callee;
    } else if (Node.isPropertyAccessExpression(callee)) {
        name = callee.getNameNode();
    }

    return (
        name !== undefined &&
        isFrameworkImport(Node.isPropertyAccessExpression(callee) ? callee.getExpression() : name) &&
        !ADDRESS_AWARE_MIDDLEWARE.test(name.getText())
    );
};

/** Whether `node` is a builder `.use(middleware)` call. */
const isUseCall = (node: TsNode): node is CallExpression => {
    const callee = Node.isCallExpression(node) ? node.getExpression() : undefined;

    if (Node.isElementAccessExpression(callee)) {
        const key = callee.getArgumentExpression();

        return (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key)) && key.getLiteralText() === "use";
    }

    return Node.isPropertyAccessExpression(callee) && callee.getName() === "use";
};

/** Whether one use of the ctx identifier `identifier` stays within what this analysis can read (a property or an alias). */
const isReadableContextUse = (identifier: TsNode): boolean => {
    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === identifier) {
        // `ctx.runQuery(…)` hands the caller to a function this file does not show.
        return !COMPOSING_METHODS.test(parent.getName());
    }

    if (Node.isElementAccessExpression(parent) && parent.getExpression() === identifier) {
        return Node.isStringLiteral(parent.getArgumentExpression()) || Node.isNoSubstitutionTemplateLiteral(parent.getArgumentExpression());
    }

    // `const c = ctx` and `const { db } = ctx`: the alias is itself resolved as a ctx, and its pattern is read below.
    return Node.isVariableDeclaration(parent) && parent.getInitializer()?.getText() === identifier.getText();
};

/** Whether `node` names or destructures a member called `ip`, or collects the rest of an object that could hold it. */
const namesIp = (node: TsNode): boolean => {
    if (Node.isPropertyAccessExpression(node)) {
        return node.getName() === "ip";
    }

    if (Node.isElementAccessExpression(node)) {
        const key = node.getArgumentExpression();

        return (Node.isStringLiteral(key) || Node.isNoSubstitutionTemplateLiteral(key)) && key.getLiteralText() === "ip";
    }

    if (Node.isBindingElement(node)) {
        return node.getDotDotDotToken() !== undefined || (node.getPropertyNameNode()?.getText() ?? node.getName()) === "ip";
    }

    return Node.isShorthandPropertyAssignment(node) && node.getName() === "ip";
};

/**
 * Whether a registration (its handler and the builder chain in front of it) may read `ctx.ip`, decided statically
 * and failing CLOSED: anything this analysis cannot rule out counts as a read.
 *
 * It says "reads" when the source names `ip` on anything, destructures a rest (which could hold it), indexes the ctx by
 * a computed key, passes the ctx (or a piece it cannot follow) to another function or onto another caller
 * (`ctx.runQuery`), or uses a `.use()` middleware that is not a framework one known not to key on the address.
 * The shard learns the same fact at runtime, from the first read; this is what it knows before one.
 * @returns whether the registration may read the caller's address
 */
const mayReadIp = (registration: CallExpression): boolean => {
    for (const node of registration.getDescendants()) {
        if (namesIp(node)) {
            return true;
        }

        if (isUseCall(node) && !isAddressFreeMiddleware(node.getArguments()[0])) {
            return true;
        }

        if (Node.isIdentifier(node) && isContextIdentifier(node) && !isReadableContextUse(node)) {
            // A declaration of the ctx binding itself (a parameter or a destructuring name) is not a use.
            const parent = node.getParent();

            if (!(Node.isParameterDeclaration(parent) || Node.isBindingElement(parent) || Node.isVariableDeclaration(parent))) {
                return true;
            }
        }
    }

    return false;
};

export default mayReadIp;
