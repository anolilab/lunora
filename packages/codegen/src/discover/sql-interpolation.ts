import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { isArgumentDerived } from "../argument-taint";
import type { SqlInterpolationIR } from "../ir";
import { bindingKeyName, collectCallRows, isConstDeclaration, unwrapExpression } from "./ast";
import { callSiteScopeOf } from "./attribution";
import { isContextSurface } from "./context-root";

/** The `SqlClient` methods that splice their first (`text`) argument verbatim into the query. */
const SQL_TEXT_METHODS = new Set(["query", "unsafe"]);

/** How many `const` hops {@link isConstantText} follows before giving up and treating the value as dynamic. */
const CONST_HOP_LIMIT = 3;

/**
 * True when `node` is a `ctx.sql.query` / `ctx.sql.unsafe` member access — the
 * Hyperdrive `SqlClient` text-running methods. `ctx.sql` is NOT a tagged-template
 * function; it's an object whose `query`/`unsafe` methods bind ONLY the `params`
 * array, splicing the `text` argument verbatim into the SQL. So the real injection
 * sink is the first argument to these calls, not a tagged-template span.
 */
const isContextSqlTextCallee = (node: TsNode): boolean => {
    if (!Node.isPropertyAccessExpression(node) || !SQL_TEXT_METHODS.has(node.getName())) {
        return false;
    }

    return isContextSurface(node.getExpression(), ["sql"]);
};

/** The initializer of `node` when it names a `const` binding with an initializer, or `undefined`. */
const constInitializerOf = (node: TsNode): TsNode | undefined => {
    if (!Node.isIdentifier(node)) {
        return undefined;
    }

    const declaration = node.getSymbol()?.getDeclarations()[0];

    if (!isConstDeclaration(declaration) || !Node.isIdentifier(declaration.getNameNode())) {
        return undefined;
    }

    return declaration.getInitializer();
};

/**
 * What a `const` name was bound from: the initializer of `const x = …`, or, for `const { x } = source`, the
 * `x` property when `source` is (a `const` naming) an object literal that declares it, else `source` itself.
 * `undefined` for anything else.
 */
const boundSourceOf = (node: TsNode): TsNode | undefined => {
    const direct = constInitializerOf(node);

    if (direct !== undefined || !Node.isIdentifier(node)) {
        return direct;
    }

    const declaration = node.getSymbol()?.getDeclarations()[0];
    const holder = Node.isBindingElement(declaration) ? declaration.getParent().getParent() : undefined;

    if (!Node.isBindingElement(declaration) || !isConstDeclaration(holder)) {
        return undefined;
    }

    const source = holder.getInitializer();
    const unwrapped = unwrapExpression(source);
    const literal = unwrapExpression(unwrapped !== undefined && Node.isIdentifier(unwrapped) ? constInitializerOf(unwrapped) : unwrapped);
    // Only the property this binding reads decides it: a sibling `params: [args.id]` must not taint fixed text.
    // A literal with a spread keeps the whole source, since the spread may supply or overwrite the key.
    const property =
        Node.isObjectLiteralExpression(literal) && !literal.getProperties().some((member) => Node.isSpreadAssignment(member))
            ? literal.getProperty(bindingKeyName(declaration))
            : undefined;

    if (Node.isShorthandPropertyAssignment(property)) {
        return property.getNameNode();
    }

    return Node.isPropertyAssignment(property) ? property.getInitializer() : source;
};

/**
 * True when `node` is a `left + right` concatenation or a `X.join(...)` call, the two
 * ways a `.join`-style builder assembles text. A substitution template is handled
 * separately because it is a distinct syntax node.
 */
const isBuiltText = (node: TsNode): boolean => {
    const value = unwrapExpression(node);

    if (!value) {
        return false;
    }

    if (Node.isTemplateExpression(value)) {
        return true;
    }

    if (Node.isBinaryExpression(value)) {
        return value.getOperatorToken().getKind() === SyntaxKind.PlusToken;
    }

    if (!Node.isCallExpression(value)) {
        return false;
    }

    const callee = value.getExpression();

    return Node.isPropertyAccessExpression(callee) && ["concat", "join"].includes(callee.getName());
};

/**
 * The call half of `isConstantText`, which passes itself in as `isConstant`: a `.concat(...)` of a constant receiver and constant arguments, or a
 * `.join(...)` over an array literal of constants with a constant separator.
 */
const isConstantCall = (call: CallExpression, isConstant: (node: TsNode | undefined) => boolean): boolean => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return false;
    }

    const constantArguments = call.getArguments().every((argument) => isConstant(argument));

    // Strings are immutable, so a constant receiver concatenated with constant arguments is fixed text.
    if (callee.getName() === "concat") {
        return constantArguments && isConstant(callee.getExpression());
    }

    // Only an inline array: a `const` array can still be pushed to before the `.join`.
    const array = unwrapExpression(callee.getExpression());

    return (
        callee.getName() === "join" && constantArguments && Node.isArrayLiteralExpression(array) && array.getElements().every((element) => isConstant(element))
    );
};

/**
 * True when `node` is provably a fixed string: a literal, a template whose spans are
 * all constant, a `+` or `.concat(...)` of constants, a `.join(...)` over an array literal of constants, or a
 * `const` binding (followed up to {@link CONST_HOP_LIMIT} hops) whose initializer is.
 * A parameter, a request-derived value or any other expression is not constant.
 */
const isConstantText = (node: TsNode | undefined, depth = CONST_HOP_LIMIT): boolean => {
    const value = unwrapExpression(node);

    if (!value) {
        return false;
    }

    if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value) || Node.isNumericLiteral(value)) {
        return true;
    }

    if (Node.isTemplateExpression(value)) {
        return value.getTemplateSpans().every((span) => isConstantText(span.getExpression(), depth));
    }

    if (Node.isBinaryExpression(value)) {
        return value.getOperatorToken().getKind() === SyntaxKind.PlusToken && isConstantText(value.getLeft(), depth) && isConstantText(value.getRight(), depth);
    }

    if (Node.isIdentifier(value)) {
        return depth > 0 && isConstantText(constInitializerOf(value), depth - 1);
    }

    if (Node.isCallExpression(value)) {
        return isConstantCall(value, (candidate) => isConstantText(candidate, depth));
    }

    return false;
};

/**
 * True when the `text` argument is a `sql_injection_risk` sink: it is not provably
 * constant, and either it builds a string in place (a template, `+`, `.join`), names a
 * `const` that does so, or is a non-constant value derived from the handler's `args`.
 * A plain parameter passed straight through is left alone: the caller is not visible.
 */
const isRiskyText = (text: TsNode): boolean => {
    const value = unwrapExpression(text);

    if (!value || isConstantText(value)) {
        return false;
    }

    // Follow the `const` chain the text came through, so an alias of an alias, or a field destructured from a
    // request object, is judged by its source rather than by the last name it was given.
    let current: TsNode | undefined = value;

    for (let hop = 0; current !== undefined && hop <= CONST_HOP_LIMIT; hop += 1) {
        if (isBuiltText(current) || isArgumentDerived(current)) {
            return true;
        }

        const next = boundSourceOf(current);

        // A cast or parentheses around an intermediate alias must not end the walk before the builder.
        current = next === undefined ? undefined : unwrapExpression(next);
    }

    return false;
};

/** The IR row for a `ctx.sql.query(text, …)` / `.unsafe(text, …)` call whose `text` is risky, or `undefined`. */
const interpolationInCall = (call: CallExpression, relativePath: string): SqlInterpolationIR | undefined => {
    if (!isContextSqlTextCallee(call.getExpression())) {
        return undefined;
    }

    const text = call.getArguments()[0];

    if (!text || !isRiskyText(text)) {
        return undefined;
    }

    return { file: relativePath, line: text.getStartLineNumber(), scope: callSiteScopeOf(call) };
};

/**
 * Discover `ctx.sql.query(text, …)` / `ctx.sql.unsafe(text, …)` calls whose `text`
 * argument is risky — the `sql_injection_risk` lint input. The Hyperdrive driver binds
 * ONLY the `params` array and splices `text` verbatim (`client.query(text, params)`),
 * so the rule is "is `text` provably constant?", not "is it written inline?". Text
 * built in a `const`, passed as a raw handler argument, or assembled with `+` / `.join`
 * is recorded; a module constant interpolated into a template, or a literal, is not.
 */
const discoverSqlInterpolation = (project: Project, lunoraDirectory: string): SqlInterpolationIR[] =>
    collectCallRows(project, lunoraDirectory, interpolationInCall);

export default discoverSqlInterpolation;
