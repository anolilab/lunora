import type { Node as TsNode, NumericLiteral, ObjectLiteralExpression } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

/** No literal: a sentinel distinct from every value a literal can evaluate to, `undefined` included. */
const NOT_LITERAL = Symbol("not-literal");

/**
 * Evaluate a JSON-shaped literal (string, number, boolean, `null`, array, plain
 * object with static keys). Anything else — an identifier, a call, a function —
 * is {@link NOT_LITERAL}: codegen hands these values to package code and copies
 * them into generated output, so it must never evaluate the user's own code.
 */
const scalarLiteralOf = (node: TsNode): unknown => {
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node) || Node.isNumericLiteral(node)) {
        return node.getLiteralValue();
    }

    if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.MinusToken && Node.isNumericLiteral(node.getOperand())) {
        return -(node.getOperand() as NumericLiteral).getLiteralValue();
    }

    if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) {
        return node.getLiteralValue();
    }

    return Node.isNullLiteral(node) ? null : NOT_LITERAL; // eslint-disable-line unicorn/no-null -- the evaluated value of a `null` literal
};

const literalOf = (node: TsNode): unknown => {
    if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
        return literalOf(node.getExpression());
    }

    if (Node.isArrayLiteralExpression(node)) {
        const elements = node.getElements().map((element) => literalOf(element));

        return elements.includes(NOT_LITERAL) ? NOT_LITERAL : elements;
    }

    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; objectLiteralOf evaluates each value back through literalOf
    return Node.isObjectLiteralExpression(node) ? objectLiteralOf(node) : scalarLiteralOf(node);
};

/** An object literal of {@link literalOf} values with static keys. */
const objectLiteralOf = (node: ObjectLiteralExpression): unknown => {
    const entries: [string, unknown][] = [];

    for (const property of node.getProperties()) {
        const nameNode = Node.isPropertyAssignment(property) ? property.getNameNode() : undefined;
        const initializer = Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
        const value = initializer === undefined ? NOT_LITERAL : literalOf(initializer);

        if (nameNode === undefined || value === NOT_LITERAL || !(Node.isIdentifier(nameNode) || Node.isStringLiteral(nameNode))) {
            return NOT_LITERAL;
        }

        const key = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText();

        // In a literal, `__proto__: value` sets the prototype rather than a key, which no copied value reproduces.
        if (key === "__proto__") {
            return NOT_LITERAL;
        }

        entries.push([key, value]);
    }

    return Object.fromEntries(entries);
};

export { literalOf, NOT_LITERAL };
