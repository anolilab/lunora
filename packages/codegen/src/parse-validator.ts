import type { CallExpression, Expression, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import type { ColumnMetaIR, ValidatorIR } from "./ir";

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

/** Scalar `v.*` kinds that map to a bare `{ kind }` IR with no further parsing. */
const SCALAR_KINDS = new Set(["any", "bigint", "boolean", "bytes", "date", "null", "number", "string", "timestamp"]);

/**
 * Convert a v.* call expression (or any other expression) into a {@link ValidatorIR}.
 * Used by both schema discovery and function-args discovery so the rendered
 * TS types are identical regardless of where a validator appears.
 */
const parseValidator = (expression: Expression): ValidatorIR => {
    if (Node.isCallExpression(expression)) {
        // parseValidatorCall <-> parseValidator/parseObjectShape are mutually
        // recursive, so one forward reference is unavoidable here. Arrow consts
        // are all defined before any is called, so this is safe at runtime.
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion between validator parsers
        return parseValidatorCall(expression);
    }

    return { kind: "any", sourceText: expression.getText() };
};

const parseObjectShape = (object: ObjectLiteralExpression): Record<string, ValidatorIR> => {
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
};

/** Parse an argument node as a nested validator, or fall back when it isn't an expression. */
const parseArgument = (argument: Node | undefined, fallback: ValidatorIR): ValidatorIR =>
    argument && Node.isExpression(argument) ? parseValidator(argument) : fallback;

/** Parse a single `v.NAME(...)` builder call, dispatching on the member name. */
const parseBuilderMember = (member: string, args: ReadonlyArray<Node>): ValidatorIR => {
    if (SCALAR_KINDS.has(member)) {
        return { kind: member };
    }

    const [first, second] = args;

    switch (member) {
        case "array": {
            return { inner: parseArgument(first, { kind: "any" }), kind: "array" };
        }

        case "from": {
            // v.from(externalSchema) — the external Standard Schema validator's
            // output type is not statically recoverable at codegen time.
            // Emit an `unknown`-typed IR node so generated api types compile.
            return { kind: "from" };
        }

        case "id": {
            return { kind: "id", tableName: first && Node.isStringLiteral(first) ? first.getLiteralText() : "_unknown_" };
        }

        case "literal": {
            return {
                kind: "literal",
                // Captures the source text — for string/number/boolean/null literals
                // this matches the TS type representation directly.
                literalValue: first ? first.getText() : "undefined",
            };
        }

        case "object": {
            return first && Node.isObjectLiteralExpression(first) ? { kind: "object", shape: parseObjectShape(first) } : { kind: "object", shape: {} };
        }

        case "optional": {
            return { inner: parseArgument(first, { kind: "any" }), kind: "optional" };
        }

        case "record": {
            return {
                keyType: parseArgument(first, { kind: "string" }),
                kind: "record",
                valueType: parseArgument(second, { kind: "any" }),
            };
        }

        case "storage": {
            return first && Node.isStringLiteral(first) ? { bucket: first.getLiteralText(), kind: "storage" } : { kind: "storage" };
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

    return parseBuilderMember(member, args);
};

export { parseObjectShape, parseValidator };
