import { LunoraError } from "@lunora/errors";
import type { CallExpression, Expression, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import type { ColumnMetaIR, ValidatorIR } from "./ir";

/**
 * Resolves a `v.from(...)` argument expression to the wrapped Standard Schema's
 * inferred type, rendered as TS source valid inside `_generated/`.
 */
type StandardTypeResolver = (node: Node) => string | undefined;

/**
 * Registered by the codegen run, because recovering the type needs the type
 * checker AND the same "is this renderable in a generated file?" guards the
 * handler-return path uses — both of which live in `discover-functions`. A
 * module-level hook rather than a threaded parameter keeps the recursive
 * parse functions' signatures unchanged, and importing it the other way would
 * make a cycle (`discover-functions` already imports this module).
 *
 * Unset (a bare parser, a test) simply means `v.from()` stays `unknown`, which
 * is the behaviour that predates the recovery.
 */
let standardTypeResolver: StandardTypeResolver | undefined;

const setStandardTypeResolver = (resolver: StandardTypeResolver | undefined): void => {
    standardTypeResolver = resolver;
};

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
 * Scalar `v.*` kinds that map to a bare `{ kind }` IR with no further parsing.
 * `geoPoint` is arg-less like the scalars (it renders to a fixed `{ lat, lng }`
 * object type in `emit.ts`), so it rides this fast path too.
 */
const SCALAR_KINDS = new Set(["any", "bigint", "boolean", "bytes", "date", "geoPoint", "null", "number", "string", "timestamp"]);

/**
 * Refinement/annotation modifiers that hang off any base `v.*` validator
 * (`.check(pred, …)` adds a runtime predicate; `.meta({ schema })` merges a
 * JSON Schema fragment). Neither changes the validator's *kind* or the TS type
 * it emits, so codegen unwraps them to the base validator's IR. Without this the
 * parser would treat `check`/`meta` as unknown kinds and throw — even though the
 * `unbounded_string_arg` advisor explicitly recommends them for length bounds.
 */
const TRANSPARENT_MODIFIERS = new Set(["check", "meta"]);

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
            throw new LunoraError("INTERNAL", `@lunora/codegen: field name is not a valid JS identifier: ${JSON.stringify(fieldName)}`);
        }

        out[fieldName] = parseValidator(initializer);
    }

    return out;
};

/** Parse an argument node as a nested validator, or fall back when it isn't an expression. */
const parseArgument = (argument: Node | undefined, fallback: ValidatorIR): ValidatorIR =>
    argument && Node.isExpression(argument) ? parseValidator(argument) : fallback;

/**
 * Render a `v.literal(...)` argument as the IR's `literalValue` source text.
 *
 * String and no-substitution template literals are normalized to canonical JSON
 * (`JSON.stringify` of the runtime value) so escapes, backticks, and single
 * quotes survive as a valid, safely-emittable double-quoted literal — splicing
 * the raw source text instead would carry an unescaped backtick/quote or a stray
 * backslash that fails `LITERAL_VALUE_RE` and aborts the whole codegen run with a
 * spurious INTERNAL error. Numbers, `true`/`false`/`null`, and any non-literal
 * expression keep their verbatim source text; the latter is intentionally
 * rejected downstream by `LITERAL_VALUE_RE`.
 */
const renderLiteralSource = (node: Node | undefined): string => {
    if (node === undefined) {
        return "undefined";
    }

    if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
        return JSON.stringify(node.getLiteralValue());
    }

    return node.getText();
};

/**
 * `v.from(externalSchema)` — recover the wrapped schema's inferred type through
 * the registered resolver (`~standard.types.output`, the same property the
 * runtime's `InferStandardOutput` reads).
 *
 * Without this, every argument behind a `v.from()` typed as `unknown` in the
 * generated api, which broke `ctx.run*` calls, made handler args implicitly
 * `any` under `noImplicitAny`, and gave generated clients untyped arguments
 * (LUNORA_ISSUES #22). Falls back to a bare `from` node when unrecoverable, so
 * the emitted type is `unknown` exactly as before.
 */
const parseFrom = (schemaArgument: Node | undefined): ValidatorIR => {
    const tsType = schemaArgument && standardTypeResolver ? standardTypeResolver(schemaArgument) : undefined;

    return tsType === undefined ? { kind: "from" } : { kind: "from", tsType };
};

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
            return parseFrom(first);
        }

        case "id": {
            return { kind: "id", tableName: first && Node.isStringLiteral(first) ? first.getLiteralText() : "_unknown_" };
        }

        case "literal": {
            return {
                kind: "literal",
                // Canonical source text — strings/templates are re-encoded via
                // JSON.stringify (see renderLiteralSource) so escapes/backticks
                // survive; numbers/booleans/null keep their verbatim text.
                literalValue: renderLiteralSource(first),
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
            throw new LunoraError("INTERNAL", `Unsupported validator kind: ${member}`);
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

    // `.check(...)` / `.meta(...)` refine or annotate the base validator without
    // altering its kind — unwrap to the receiver's IR. `.check(...)` additionally
    // records a `hasRefinement` flag (its predicate is a runtime closure the IR
    // can't represent) so the AOT compiler declines the node; `.meta(...)` is pure
    // metadata and leaves the IR unchanged.
    if (TRANSPARENT_MODIFIERS.has(member)) {
        const receiver = callee.getExpression();
        const base = Node.isExpression(receiver) ? parseValidator(receiver) : { kind: "any" };

        return member === "check" ? { ...base, hasRefinement: true } : base;
    }

    return parseBuilderMember(member, args);
};

export { parseObjectShape, parseValidator, setStandardTypeResolver };
export type { StandardTypeResolver };
