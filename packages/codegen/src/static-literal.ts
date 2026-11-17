import type { BinaryExpression, Node as TsNode, NumericLiteral, ObjectLiteralExpression } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

/** No literal: a sentinel distinct from every value a literal can evaluate to, `undefined` included. */
const NOT_LITERAL = Symbol("not-literal");

/**
 * Evaluate a JSON-shaped literal (string, number, boolean, `null`, array, plain
 * object with static keys). Anything else — an identifier, a call, a function —
 * is {@link NOT_LITERAL}: codegen hands these values to package code and copies
 * them into generated output, so it must never evaluate the user's own code.
 */
/** A numeric literal's value as JavaScript reads it. `getLiteralValue()` answers `NaN` for an overflowing `1e999`, which is `Infinity`. */
const numericValueOf = (node: NumericLiteral): number => Number(node.getText().replaceAll("_", ""));

/**
 * The boolean a static boolean literal evaluates to: `true`, `false`, or a minifier's `!0` / `!1`; `undefined` for
 * anything else. The validator and every boolean reader of `lunora.config` go through here, so a value one accepts
 * is a value the other reads.
 */
const staticBooleanOf = (node: TsNode): boolean | undefined => {
    if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) {
        return node.getLiteralValue();
    }

    return Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.ExclamationToken && Node.isNumericLiteral(node.getOperand())
        ? numericValueOf(node.getOperand() as NumericLiteral) === 0
        : undefined;
};

const scalarLiteralOf = (node: TsNode): unknown => {
    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        return node.getLiteralValue();
    }

    if (Node.isNumericLiteral(node)) {
        return numericValueOf(node);
    }

    if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.MinusToken && Node.isNumericLiteral(node.getOperand())) {
        return -numericValueOf(node.getOperand() as NumericLiteral);
    }

    const boolean = staticBooleanOf(node);

    if (boolean !== undefined) {
        return boolean;
    }

    if (Node.isBinaryExpression(node)) {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; arithmeticOf folds its operands through literalOf
        return arithmeticOf(node);
    }

    return Node.isNullLiteral(node) ? null : NOT_LITERAL; // eslint-disable-line unicorn/no-null -- the evaluated value of a `null` literal
};

const ARITHMETIC: Readonly<Partial<Record<SyntaxKind, (left: number, right: number) => number>>> = {
    [SyntaxKind.AsteriskAsteriskToken]: (left, right) => left ** right,
    [SyntaxKind.AsteriskToken]: (left, right) => left * right,
    [SyntaxKind.MinusToken]: (left, right) => left - right,
    [SyntaxKind.PercentToken]: (left, right) => left % right,
    [SyntaxKind.PlusToken]: (left, right) => left + right,
    [SyntaxKind.SlashToken]: (left, right) => left / right,
};

/**
 * `60 * 60 * 1000` — numeric arithmetic folded over literal operands, the way a
 * documented option like `{ ttlMs: 60 * 60 * 1000 }` is written. Only operators
 * on finite numbers; anything else (a string `+`, an identifier) stays unreadable.
 */
const arithmeticOf = (node: BinaryExpression): unknown => {
    const operate = ARITHMETIC[node.getOperatorToken().getKind()];
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion; literalOf evaluates each operand
    const [left, right] = [literalOf(node.getLeft()), literalOf(node.getRight())];

    return operate !== undefined && typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right)
        ? operate(left, right)
        : NOT_LITERAL;
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

export { literalOf, NOT_LITERAL, staticBooleanOf };
