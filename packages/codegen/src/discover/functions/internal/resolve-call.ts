import type { CallExpression, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

/**
 * Depth bound for {@link resolveExpressionToCall} so an aliased/cyclic reference
 * (`export const a = b; export const b = a`) can't loop forever.
 */
const RE_EXPORT_RESOLVE_LIMIT = 8;

/**
 * Follow a non-call initializer back to the `query/mutation/action({...})` call
 * that produced it, so a **re-exported** registered function is discovered the
 * same as a directly-declared one. This is what makes a plugin/component's
 * `export const { check } = component.functions` (or
 * `export const check = component.functions.check`) emit into the generated
 * `api`, rather than being silently skipped.
 *
 * Resolution hops through ts-morph symbols — identifier → its `const`
 * initializer, property access → the object-literal `PropertyAssignment`,
 * destructured binding → the matching property on the right-hand side — until it
 * reaches a `CallExpression` (then `discoverFromCall` classifies it) or
 * runs out of resolvable steps (then it bails to `undefined`, i.e. skip). A
 * reference into a published component whose value lives only in a `.d.ts` (no
 * call literal) bails cleanly — same as before this resolver existed.
 *
 * Guaranteed shapes are the two documented re-export forms —
 * `export const check = component.functions.check` (property access) and
 * `export const { check } = component.functions` (destructure). More indirect
 * relays (e.g. re-bundling into a fresh object first) may not resolve, but they
 * always **fail safe**: the function is skipped, never mis-attributed.
 */
// `resolveExpressionToCall` and `resolveDeclarationToCall` are mutually
// recursive, so one reference is necessarily forward whatever the order — the
// single disable below covers it (the project's `func-style` rule rules out
// hoisted `function` declarations that would otherwise avoid it).
const resolveExpressionToCall = (node: Node, depth = 0): CallExpression | undefined => {
    if (depth > RE_EXPORT_RESOLVE_LIMIT) {
        return undefined;
    }

    if (Node.isCallExpression(node)) {
        return node;
    }

    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node)) {
        return resolveExpressionToCall(node.getExpression(), depth + 1);
    }

    if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const declaration = node.getSymbol()?.getValueDeclaration();

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; resolveDeclarationToCall is defined just below
    return declaration ? resolveDeclarationToCall(declaration, depth + 1) : undefined;
};

/** Continue {@link resolveExpressionToCall} from the declaration a symbol resolved to. */
const resolveDeclarationToCall = (declaration: Node, depth: number): CallExpression | undefined => {
    if (Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration)) {
        const initializer = declaration.getInitializer();

        return initializer ? resolveExpressionToCall(initializer, depth) : undefined;
    }

    if (Node.isShorthandPropertyAssignment(declaration)) {
        // `{ check }` shorthand — resolve the local `check` it refers to.
        //
        // Must go through the shorthand's VALUE symbol. Its name node looks like
        // the local binding but TypeScript answers that identifier with the
        // shorthand property's own symbol, so resolving the name node walked
        // straight back to this same ShorthandPropertyAssignment and ping-ponged
        // until the hop bound cut it off — every shorthand-bundled function
        // silently missing from `api.ts`, with only the bound preventing an
        // infinite recursion.
        const value = declaration.getValueSymbol()?.getValueDeclaration();

        return value ? resolveDeclarationToCall(value, depth + 1) : undefined;
    }

    if (Node.isBindingElement(declaration)) {
        // `const { check } = component.functions` — the value comes from the
        // right-hand side's `check` property, not from the binding element.
        const propertyName = declaration.getPropertyNameNode()?.getText() ?? declaration.getName();
        const variableDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        const rightHandSide = variableDeclaration?.getInitializer();
        const propertyDeclaration = rightHandSide?.getType().getProperty(propertyName)?.getValueDeclaration();

        return propertyDeclaration ? resolveDeclarationToCall(propertyDeclaration, depth + 1) : undefined;
    }

    return undefined;
};

/**
 * Yield the `[exportName, call]` pairs an exported variable declaration
 * contributes. Handles both `export const list = query({...})` (direct, or an
 * identifier/property-access re-export resolved via {@link resolveExpressionToCall})
 * and `export const { check, reset } = component.functions` (one pair per
 * destructured element). Pairs whose call isn't a Lunora registration are
 * filtered out downstream by `discoverFromCall`.
 */
const exportCallsOfDeclaration = (declaration: VariableDeclaration): [string, CallExpression][] => {
    const nameNode = declaration.getNameNode();

    if (Node.isObjectBindingPattern(nameNode)) {
        const pairs: [string, CallExpression][] = [];

        for (const element of nameNode.getElements()) {
            const call = resolveExpressionToCall(element.getNameNode());

            if (call) {
                pairs.push([element.getName(), call]);
            }
        }

        return pairs;
    }

    const initializer = declaration.getInitializer();
    const call = initializer && (Node.isCallExpression(initializer) ? initializer : resolveExpressionToCall(initializer));

    return call ? [[declaration.getName(), call]] : [];
};

export { exportCallsOfDeclaration, resolveExpressionToCall };
