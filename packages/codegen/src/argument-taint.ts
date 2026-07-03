import type { Identifier, Node as TsNode } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

/**
 * True when `identifier` is a *value* reference to the handler's `args` binding —
 * the taint root shared by every Wave 3 argument-taint feeder. Excludes the
 * trailing `.args` of a member access and the key of an explicit `{ args: … }`
 * property, which name a different `args` and carry no taint; a `{ args }`
 * shorthand IS a value reference and is kept.
 */
const isArgsValueReference = (identifier: Identifier): boolean => {
    if (identifier.getText() !== "args") {
        return false;
    }

    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    return !(Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier);
};

/**
 * True when `identifier` is a *value* reference to the handler's `ctx` binding —
 * the server-trusted root. Mirror of {@link isArgsValueReference}: excludes the
 * trailing `.ctx` of a member access and the key of an explicit `{ ctx: … }`
 * property; a `{ ctx }` shorthand IS a value reference and is kept.
 */
const isContextValueReference = (identifier: Identifier): boolean => {
    if (identifier.getText() !== "ctx") {
        return false;
    }

    const parent = identifier.getParent();

    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) {
        return false;
    }

    return !(Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier);
};

/** True when `node` is, or textually contains, a value reference to the `ctx` binding. */
const textuallyReferencesContext = (node: TsNode): boolean => {
    if (Node.isIdentifier(node)) {
        return isContextValueReference(node);
    }

    return node.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => isContextValueReference(identifier));
};

/** True when `node` is, or textually contains, a value reference to the `args` binding. */
export const referencesArgs = (node: TsNode): boolean => {
    if (Node.isIdentifier(node)) {
        return isArgsValueReference(node);
    }

    return node.getDescendantsOfKind(SyntaxKind.Identifier).some((identifier) => isArgsValueReference(identifier));
};

/**
 * When `node` is a bare identifier bound by a `const key = args.key` in the enclosing
 * handler, return that initializer so a *single* extra hop of taint can be checked
 * (`const key = args.key; … key`); otherwise `undefined`. Only same-function
 * declarations are followed — the taint stays deliberately single-hop.
 */
export const singleHopInitializer = (node: TsNode): TsNode | undefined => {
    if (!Node.isIdentifier(node)) {
        return undefined;
    }

    const name = node.getText();
    const enclosingFunction = node.getFirstAncestor(
        (ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor) || Node.isFunctionDeclaration(ancestor),
    );

    return enclosingFunction
        ?.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
        .find((variable) => variable.getName() === name)
        ?.getInitializer();
};

/**
 * True when `expression` is derived from the handler's `args` — directly (`args.x`,
 * a template / `new URL(...)` / helper call embedding `args.*`) or through one local
 * hop (`const key = args.key; … key`). This is the shared taint predicate every
 * Wave 3 sink feeder (SSRF fetch, owner-field write, storage/kv IDOR) reads.
 */
export const isArgumentDerived = (expression: TsNode): boolean => {
    if (referencesArgs(expression)) {
        return true;
    }

    const initializer = singleHopInitializer(expression);

    return initializer !== undefined && referencesArgs(initializer);
};

/**
 * True when `node` is scoped by a server-trusted `ctx` value — directly, or through
 * one local `const` hop, symmetric with {@link isArgumentDerived}. A storage/kv key
 * such as `${ctx.auth.userId}/${args.name}` references *both* `args` and `ctx`; the
 * IDOR sinks treat any key that reaches `ctx` — even via `const k = scoped; … k` —
 * as scoped rather than attacker-controlled, so a correctly-prefixed key is not
 * flagged. Following the same single hop as the taint check keeps the two
 * predicates from disagreeing on a local-`const` key.
 */
export const isScopedByContext = (node: TsNode): boolean => {
    if (textuallyReferencesContext(node)) {
        return true;
    }

    const initializer = singleHopInitializer(node);

    return initializer !== undefined && textuallyReferencesContext(initializer);
};

/** The export name of the nearest exported `const x = …` ancestor, or `"&lt;module>"` when at file scope. */
export const enclosingExportName = (node: TsNode): string => {
    const declaration = node.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);

    return declaration?.getName() ?? "<module>";
};
