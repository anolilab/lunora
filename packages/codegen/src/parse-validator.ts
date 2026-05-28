import type { CallExpression, Expression, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import type { ColumnMetaIR, ValidatorIR } from "./ir.js";

/**
 * Column-modifier methods that hang off a base `v.*` validator inside
 * `defineTable`. They unwrap to the base validator's IR with the constraint
 * recorded under `column`, rather than counting as their own validator kind.
 */
const COLUMN_MODIFIERS = new Set(["$defaultFn", "$onUpdateFn", "default", "nullable", "unique"]);

const applyColumnModifier = (base: ValidatorIR, modifier: string): ValidatorIR => {
    const column: ColumnMetaIR = { notNull: true, ...base.column };

    switch (modifier) {
        case "$defaultFn":
        case "default": {
            column.hasDefault = true;

            break;
        }
        case "$onUpdateFn": {
            column.hasOnUpdate = true;

            break;
        }
        case "nullable": {
            column.notNull = false;

            break;
        }
        case "unique": {
            column.unique = true;

            break;
        }
        default: {
            // The caller only routes known modifiers here; ignore anything else.
            break;
        }
    }

    return { ...base, column };
};

/**
 * Convert a v.* call expression (or any other expression) into a {@link ValidatorIR}.
 * Used by both schema discovery and function-args discovery so the rendered
 * TS types are identical regardless of where a validator appears.
 */
export const parseValidator = (expression: Expression): ValidatorIR => {
    if (Node.isCallExpression(expression)) {
        return parseValidatorCall(expression);
    }

    return { kind: "any", sourceText: expression.getText() };
};

export const parseObjectShape = (object: ObjectLiteralExpression): Record<string, ValidatorIR> => {
    const out: Record<string, ValidatorIR> = {};

    for (const property of object.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        const initializer = property.getInitializer();

        if (!initializer) {
            continue;
        }

        out[property.getName()] = parseValidator(initializer);
    }

    return out;
};

const parseValidatorCall = (call: CallExpression): ValidatorIR => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return { kind: "any", sourceText: call.getText() };
    }

    const member = callee.getName();
    const args = call.getArguments();

    if (COLUMN_MODIFIERS.has(member)) {
        const receiver = callee.getExpression();
        const base = Node.isExpression(receiver) ? parseValidator(receiver) : { kind: "any" };

        return applyColumnModifier(base, member);
    }

    switch (member) {
        case "any":
        case "bigint":
        case "boolean":
        case "bytes":
        case "null":
        case "number":
        case "string": {
            return { kind: member };
        }

        case "array": {
            const first = args[0];

            return { inner: first && Node.isExpression(first) ? parseValidator(first) : { kind: "any" }, kind: "array" };
        }

        case "id": {
            const first = args[0];

            return { kind: "id", tableName: first && Node.isStringLiteral(first) ? first.getLiteralText() : "_unknown_" };
        }

        case "literal": {
            const first = args[0];

            return {
                kind: "literal",
                // Captures the source text — for string/number/boolean/null literals
                // this matches the TS type representation directly.
                literalValue: first ? first.getText() : "undefined",
            };
        }

        case "object": {
            const first = args[0];

            if (first && Node.isObjectLiteralExpression(first)) {
                return { kind: "object", shape: parseObjectShape(first) };
            }

            return { kind: "object", shape: {} };
        }

        case "optional": {
            const first = args[0];

            return { inner: first && Node.isExpression(first) ? parseValidator(first) : { kind: "any" }, kind: "optional" };
        }

        case "record": {
            const first = args[0];
            const second = args[1];

            return {
                kind: "record",
                keyType: first && Node.isExpression(first) ? parseValidator(first) : { kind: "string" },
                valueType: second && Node.isExpression(second) ? parseValidator(second) : { kind: "any" },
            };
        }

        case "union": {
            return {
                kind: "union",
                members: args.filter((argument): argument is Expression => Node.isExpression(argument)).map((argument) => parseValidator(argument)),
            };
        }

        default: {
            // Loud failure — silently emitting `unknown` masks codegen bugs.
            // `emit.ts` keeps a fallback case for safety, but this parser
            // must call out validator kinds it does not recognise.
            throw new Error(`Unsupported validator kind: ${member}`);
        }
    }
};
