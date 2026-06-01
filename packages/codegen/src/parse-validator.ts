import type { CallExpression, Expression, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import type { ColumnMetaIR, ValidatorIR } from "./ir.js";

const FIELD_NAME_RE = /^[A-Za-z_$][\w$]*$/u;

/**
 * Column-modifier methods that hang off a base `v.*` validator inside
 * `defineTable`. They unwrap to the base validator's IR with the constraint
 * recorded under `column`, rather than counting as their own validator kind.
 */
const COLUMN_MODIFIERS = new Set(["$defaultFn", "$onUpdateFn", "$type", "default", "defaultNow", "nullable", "unique"]);

const applyColumnModifier = (base: ValidatorIR, modifier: string): ValidatorIR => {
    const column: ColumnMetaIR = { notNull: true, ...base.column };

    switch (modifier) {
        case "$defaultFn":
        case "default":
        case "defaultNow": {
            column.hasDefault = true;

            break;
        }
        case "$onUpdateFn": {
            column.hasOnUpdate = true;

            break;
        }
        case "$type": {
            // Type-only override: the generated code can't import the caller's
            // override type, so it stays a no-op and we emit the base kind.
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
export function parseValidator(expression: Expression): ValidatorIR {
    if (Node.isCallExpression(expression)) {
        // parseValidatorCall <-> parseValidator/parseObjectShape are mutually
        // recursive, so one forward reference is unavoidable here. Function
        // declarations hoist, so this is safe at runtime.
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        return parseValidatorCall(expression);
    }

    return { kind: "any", sourceText: expression.getText() };
}

export function parseObjectShape(object: ObjectLiteralExpression): Record<string, ValidatorIR> {
    const out: Record<string, ValidatorIR> = {};

    for (const property of object.getProperties()) {
        if (!Node.isPropertyAssignment(property)) {
            continue;
        }

        // Skip computed property names (`[expr]: ...`) — we can't derive a stable
        // identifier from them and they can't be emitted safely.
        const nameNode = property.getNameNode();

        if (Node.isComputedPropertyName(nameNode)) {
            continue;
        }

        const initializer = property.getInitializer();

        if (!initializer) {
            continue;
        }

        const fieldName = property.getName();

        if (!FIELD_NAME_RE.test(fieldName)) {
            throw new Error(`@cirrus/codegen: field name is not a valid JS identifier: ${JSON.stringify(fieldName)}`);
        }

        out[fieldName] = parseValidator(initializer);
    }

    return out;
}

function parseValidatorCall(call: CallExpression): ValidatorIR {
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
        case "date":
        case "null":
        case "number":
        case "string":
        case "timestamp": {
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
}
