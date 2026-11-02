import type { CallExpression, VariableDeclaration } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { bindingKeyName } from "../../ast";

/**
 * Depth bound for {@link resolveExpressionToCall} so an aliased/cyclic reference
 * (`export const a = b; export const b = a`) can't loop forever.
 */
const RE_EXPORT_RESOLVE_LIMIT = 8;

/** Where a re-export's resolution ended: the registration call, or the declaration it could not see past. */
type Resolution = { call: CallExpression } | { deadEnd: Node };

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
 * reference into a published component whose value lives only in a `.d.ts` has
 * no call literal to reach; those are read off their type instead (the
 * published-bindings lookup below) rather than dropping out of `api.ts`.
 *
 * Guaranteed shapes are the two documented re-export forms —
 * `export const check = component.functions.check` (property access) and
 * `export const { check } = component.functions` (destructure). More indirect
 * relays (e.g. re-bundling into a fresh object first) may not resolve, but they
 * always **fail safe**: the function is skipped, never mis-attributed.
 */
// `resolveExpression` and `resolveDeclaration` are mutually recursive, so one
// reference is necessarily forward whatever the order — the single disable
// below covers it (the project's `func-style` rule rules out hoisted `function`
// declarations that would otherwise avoid it).
const resolveExpression = (node: Node, depth = 0): Resolution | undefined => {
    if (depth > RE_EXPORT_RESOLVE_LIMIT) {
        return undefined;
    }

    if (Node.isCallExpression(node)) {
        return { call: node };
    }

    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node)) {
        return resolveExpression(node.getExpression(), depth + 1);
    }

    if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const declaration = node.getSymbol()?.getValueDeclaration();

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; resolveDeclaration is defined just below
    return declaration ? resolveDeclaration(declaration, depth + 1) : undefined;
};

/** Continue {@link resolveExpression} from the declaration a symbol resolved to. */
const resolveDeclaration = (declaration: Node, depth: number): Resolution | undefined => {
    if (Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration)) {
        const initializer = declaration.getInitializer();

        // No initializer is an ambient `declare const x: T` — a value only its type describes.
        return initializer ? resolveExpression(initializer, depth) : { deadEnd: declaration };
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

        return value ? resolveDeclaration(value, depth + 1) : undefined;
    }

    if (Node.isBindingElement(declaration)) {
        // `const { check } = component.functions` — the value comes from the
        // right-hand side's `check` property, not from the binding element.
        const propertyName = bindingKeyName(declaration);
        const variableDeclaration = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        const rightHandSide = variableDeclaration?.getInitializer();
        const propertyDeclaration = rightHandSide?.getType().getProperty(propertyName)?.getValueDeclaration();

        return propertyDeclaration ? resolveDeclaration(propertyDeclaration, depth + 1) : undefined;
    }

    return { deadEnd: declaration };
};

const resolveExpressionToCall = (node: Node): CallExpression | undefined => {
    const resolution = resolveExpression(node);

    return resolution !== undefined && "call" in resolution ? resolution.call : undefined;
};

/** Whether `node` resolves to a value that exists in this program only as a declaration-file type. */
const resolvesIntoDeclarationFile = (node: Node): boolean => {
    const resolution = resolveExpression(node);

    return resolution !== undefined && "deadEnd" in resolution && resolution.deadEnd.getSourceFile().isDeclarationFile();
};

/**
 * Yield the `[exportName, call]` pairs an exported variable declaration
 * contributes. Handles both `export const list = query({...})` (direct, or an
 * identifier/property-access re-export resolved via {@link resolveExpressionToCall})
 * and `export const { check, reset } = component.functions` (one pair per
 * destructured element). Pairs whose call isn't a Lunora registration are
 * filtered out downstream by `discoverFromCall`.
 */
const exportCallsOfDeclaration = (declaration: VariableDeclaration, isExported: (localName: string) => boolean = () => true): [string, CallExpression][] => {
    const nameNode = declaration.getNameNode();

    if (Node.isObjectBindingPattern(nameNode)) {
        const pairs: [string, CallExpression][] = [];

        for (const element of nameNode.getElements().filter((candidate) => isExported(candidate.getName()))) {
            const call = resolveExpressionToCall(element.getNameNode());

            if (call) {
                pairs.push([element.getName(), call]);
            }
        }

        return pairs;
    }

    if (!isExported(declaration.getName())) {
        return [];
    }

    const initializer = declaration.getInitializer();
    const call = initializer && (Node.isCallExpression(initializer) ? initializer : resolveExpressionToCall(initializer));

    return call ? [[declaration.getName(), call]] : [];
};

/**
 * The exported names of a variable declaration whose value lives in a published
 * package's `.d.ts` — `export const { heartbeat } = presence.functions` over a
 * component from `node_modules`. {@link exportCallsOfDeclaration} cannot follow
 * these to a call; the caller reads them off their type instead. Yields each
 * export name with the name node its type is read at.
 */
const exportPublishedBindingsOfDeclaration = (declaration: VariableDeclaration, isExported: (localName: string) => boolean): [string, Node][] => {
    const nameNode = declaration.getNameNode();

    if (Node.isObjectBindingPattern(nameNode)) {
        return nameNode
            .getElements()
            .filter((element) => isExported(element.getName()) && resolvesIntoDeclarationFile(element.getNameNode()))
            .map((element) => [element.getName(), element.getNameNode()]);
    }

    const initializer = declaration.getInitializer();

    return isExported(declaration.getName()) && initializer !== undefined && resolvesIntoDeclarationFile(initializer)
        ? [[declaration.getName(), nameNode]]
        : [];
};

export { exportCallsOfDeclaration, exportPublishedBindingsOfDeclaration, resolveExpressionToCall };
