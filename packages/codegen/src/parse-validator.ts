import { LunoraError } from "@lunora/errors";
import type { CallExpression, Expression, Identifier, ObjectLiteralExpression } from "ts-morph";
import { Node } from "ts-morph";

import { diagnosticAt } from "./diagnostics";
import type { ColumnMetaIR, ValidatorIR } from "./ir";

/**
 * Resolves a `v.from(...)` argument expression to the wrapped Standard Schema's
 * inferred type, rendered as TS source valid inside `_generated/`.
 */
type StandardTypeResolver = (node: Node) => string | undefined;

/**
 * Registered by the codegen run, because recovering the type needs the type
 * checker AND the same "is this renderable in a generated file?" guards the
 * handler-return path uses — both of which live in `discover/functions`. A
 * module-level hook rather than a threaded parameter keeps the recursive
 * parse functions' signatures unchanged, and importing it the other way would
 * make a cycle (`discover/functions` already imports this module).
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
const COLUMN_MODIFIERS = new Set(["$defaultFn", "$onUpdateFn", "$type", "default", "defaultNow", "nullable", "serverDefault", "unique"]);

const applyColumnModifier = (base: ValidatorIR, modifier: string): ValidatorIR => {
    const column: ColumnMetaIR = { notNull: true, ...base.column };

    switch (modifier) {
        // `.serverDefault(fn)` joins the defaults: it stamps the column from the
        // request auth on every write and returns `TInsert | undefined`, so the
        // field is optional on insert for the same reason as the others. It is
        // also the documented way to make a field non-client-controllable, so
        // refusing to parse it took a security control down with the build.
        case "$defaultFn":
        case "default":
        case "defaultNow":
        case "serverDefault": {
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
 * Modifiers that carry a RUNTIME PREDICATE: `.check(...)` spelled out, and every
 * named refinement `@lunora/values` puts on the column surfaces —
 * `v.string().max(200)`, `v.number().int()`, `v.string().email()`, and the rest of
 * `StringColumnValidator` / `NumberColumnValidator` / `ArrayColumnValidator`.
 *
 * Each is a `self.check(...)` at runtime (see `v.ts`), so it refines the value
 * without changing the validator's kind, and each is appended to `refinements` for the
 * same reason: the predicate is a closure the IR cannot represent, so the AOT
 * compiler must decline the node rather than emit a fast path that accepts a
 * 10,000-character string the interpreted parser rejects.
 *
 * Absent from this set the named ones reached {@link parseBuilderMember} as if
 * `.max` were a validator factory, and codegen ABORTED with `Unsupported
 * validator kind: max` — on a schema column as readily as on an `.input()` arg,
 * so a published, publicly-typed API made the whole app ungeneratable.
 *
 * Kept in sync with `packages/values/src/v.ts` by a test that reads the three
 * interfaces and asserts set equality in both directions — the failure mode of
 * drift here is that hard abort, not a degraded type.
 */
const REFINEMENT_MODIFIERS = new Set(["check", "email", "int", "length", "max", "min", "pattern", "positive", "url"]);

/**
 * Modifiers that are pure ANNOTATION: they attach metadata (a JSON Schema
 * fragment) and leave both the kind and the accepted values alone, so the IR
 * passes through untouched and the AOT compiler may still compile the node.
 */
const METADATA_MODIFIERS = new Set(["meta"]);

/**
 * Modifiers that change only how a value is PARSED at runtime, never the
 * inferred type or the set of accepted values — so the IR passes through
 * untouched, exactly like a metadata modifier, and the AOT compiler may still
 * compile the node.
 *
 * `.strip()` marks an object as narrowing on purpose, which only has an effect
 * under `.output()` (where undeclared keys are otherwise an error). Args
 * validation — the only thing the AOT compiler emits — is unaffected either way,
 * so there is nothing here for it to model.
 *
 * Kept separate from {@link METADATA_MODIFIERS} rather than folded in: that set
 * is defined as attaching a JSON Schema fragment, and `.strip()` attaches
 * nothing. Same handling, different reason — and the reason is what the next
 * person needs.
 */
const PARSE_BEHAVIOR_MODIFIERS = new Set(["strip"]);

/**
 * Identifiers currently being followed to their declaration, so a self- or
 * mutually-referential `const` (`const a = b; const b = a;`) terminates instead
 * of recursing forever. Parsing is synchronous and single-threaded, so one
 * module-level set is enough; every entry is removed in a `finally`.
 */
const resolvingAliases = new Set<Identifier>();

/**
 * Follow a bare identifier to the validator expression its `const` holds.
 *
 * A validator written once and reused — `const vDocumentDoc = v.object({…})`,
 * then `.output(v.union(vDocumentDoc, v.null()))` — used to reach the parser as
 * an `Identifier`, which is not a `CallExpression`, so it fell through to the
 * `{ kind: "any" }` catch-all and rendered `unknown` in the generated api. That
 * left consumers narrowing `unknown` to `{}` and erroring on every property
 * access, and pushed authors toward inlining a 20-field object literal at every
 * call site rather than keeping one source of truth for a table's public shape.
 *
 * Resolved through the SYMBOL (with `getAliasedSymbol` for an import) rather
 * than `getDefinitionNodes`, so a validator imported from a sibling module
 * resolves the same as a local one — go-to-definition would stop at the
 * `ImportSpecifier`.
 *
 * Applies to every validator position, not just `.output()`: `.input()` shapes,
 * table columns, and nested `v.array(vRow)` / `v.optional(vRow)` arguments all
 * route through {@link parseValidator}, and all degraded the same way.
 */
const resolveValidatorAlias = (identifier: Identifier): Expression | undefined => {
    const symbol = identifier.getSymbol();
    let declaration = (symbol?.getAliasedSymbol() ?? symbol)?.getValueDeclaration();

    // A shorthand property (`{ bounded }`) is its own initializer, so the
    // identifier reaching here IS the property name — and its symbol is the
    // PROPERTY, whose declaration is the shorthand assignment rather than the
    // const it stands for. Resolution stopped there and the field degraded to
    // `unknown` in the public api surface, while the longhand `{ bounded: bounded }`
    // spelling of the same thing resolved fine. Silent, and the wrong way round:
    // `object-shorthand` autofixes the working spelling into the broken one.
    // `getValueSymbol` is the checker's answer to "what does this shorthand
    // stand for"; the aliased hop after it covers an imported validator.
    if (declaration !== undefined && Node.isShorthandPropertyAssignment(declaration)) {
        const valueSymbol = declaration.getValueSymbol();

        declaration = (valueSymbol?.getAliasedSymbol() ?? valueSymbol)?.getValueDeclaration();
    }

    if (declaration === undefined || !Node.isVariableDeclaration(declaration)) {
        return undefined;
    }

    return declaration.getInitializer();
};

/**
 * The conventional local name of the validator factory namespace.
 *
 * Matched by name rather than by resolving the import, deliberately: a project
 * that aliases it (`import { v as val }`) simply does not get alias resolution
 * and keeps the previous `unknown` rendering — a smaller, safer failure than
 * mis-classifying an arbitrary call as a validator and throwing on it.
 */
const VALIDATOR_NAMESPACE = "v";

/**
 * Whether `expression` is shaped like a validator: a `v.*(…)` chain, or another
 * identifier that {@link parseValidator} will resolve in turn (`const b = a;`).
 *
 * This is the gate that lets a const reference be followed WITHOUT a catch. A
 * const holding something unrelated — `const merged = lodash.merge(a, b)` used
 * where a validator was expected — is left to the `{ kind: "any" }` fallback,
 * exactly as before alias resolution existed.
 */
const rootsAtValidatorFactory = (expression: Expression): boolean => {
    if (Node.isIdentifier(expression)) {
        return true;
    }

    let node: Node = expression;

    while (Node.isCallExpression(node)) {
        const callee = node.getExpression();

        if (!Node.isPropertyAccessExpression(callee)) {
            return false;
        }

        node = callee.getExpression();
    }

    return Node.isIdentifier(node) && node.getText() === VALIDATOR_NAMESPACE;
};

/**
 * Convert a v.* call expression (or any other expression) into a {@link ValidatorIR}.
 * Used by both schema discovery and function-args discovery so the rendered
 * TS types are identical regardless of where a validator appears.
 */
const parseValidator = (expression: Expression): ValidatorIR => {
    if (Node.isIdentifier(expression) && !resolvingAliases.has(expression)) {
        const target = resolveValidatorAlias(expression);

        // Gated on the target LOOKING like a validator rather than wrapped in a
        // try/catch. A catch around the recursive parse would also swallow
        // `Unsupported validator kind` raised by a typo INSIDE a hoisted
        // validator — so `const vRow = v.object({ x: v.strng() })` would quietly
        // render `unknown` while the identical expression written inline aborted
        // the run. Two forms that are supposed to be interchangeable must not
        // diverge on the error path, so the check happens before the parse and
        // anything that gets past it throws exactly as the inline form does.
        if (target !== undefined && rootsAtValidatorFactory(target)) {
            resolvingAliases.add(expression);

            try {
                return parseValidator(target);
            } finally {
                resolvingAliases.delete(expression);
            }
        }
    }

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
        // A shorthand property (`{ status }`, where `status` is a validator held
        // in a const) is its own initializer. Treating it as "not a property
        // assignment" dropped the field from the shape with no error anywhere —
        // the column vanished from `Doc_*`, and an index over it only surfaced
        // as a confusing `index_references_unknown_field` advisory. Every caller
        // of this parser (table shapes, `.input()` args, http routes, mutators)
        // was affected, and `object-shorthand` autofixes plain assignments into
        // this form, so the loss could arrive from a lint run.
        const shorthand = Node.isShorthandPropertyAssignment(property);

        if (!shorthand && !Node.isPropertyAssignment(property)) {
            continue;
        }

        // Skip computed property names (`[expr]: ...`) — we can't derive a stable
        // identifier from them and they can't be emitted safely.
        const nameNode = property.getNameNode();

        if (Node.isComputedPropertyName(nameNode)) {
            continue;
        }

        const initializer = shorthand ? property.getNameNode() : property.getInitializer();

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
 * `any` under `noImplicitAny`, and gave generated clients untyped arguments.
 * Falls back to a bare `from` node when unrecoverable, so
 * the emitted type is `unknown` exactly as before.
 */
const parseFrom = (schemaArgument: Node | undefined): ValidatorIR => {
    const tsType = schemaArgument && standardTypeResolver ? standardTypeResolver(schemaArgument) : undefined;

    return tsType === undefined ? { kind: "from" } : { kind: "from", tsType };
};

/**
 * Parse a single `v.NAME(...)` builder call, dispatching on the member name.
 * `call` anchors a `diagnosticAt` when a member requires a static argument it
 * did not get (e.g. `v.id(...)`'s table-name literal) — it is the whole call
 * expression, used as a fallback pinpoint when the offending argument itself
 * is absent.
 */
const parseBuilderMember = (member: string, args: ReadonlyArray<Node>, call: CallExpression): ValidatorIR => {
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
            // The table name feeds straight into the generated `Id<"...">` type
            // (see `emit.ts`), so codegen must resolve it statically — a
            // non-literal (or missing) argument must fail loudly rather than
            // degrade to a placeholder that still compiles.
            if (!first || !Node.isStringLiteral(first)) {
                throw diagnosticAt(
                    first ?? call,
                    `v.id(...) target table must be a string literal — codegen resolves foreign-key targets statically. Got ${first ? first.getText() : "no argument"}.`,
                );
            }

            return { kind: "id", tableName: first.getLiteralText() };
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

/**
 * Append `member` to a node's refinement chain, lifting its numeric literal
 * argument into `refinementArgs` so the AOT compiler can reproduce a length
 * bound instead of declining it. Only a plain numeric literal is lifted — a
 * computed bound, a regex, a predicate closure leaves no entry, which the
 * compiler reads as "not statically known" and declines.
 */
const applyRefinement = (base: ValidatorIR, member: string, argument: Node | undefined): ValidatorIR => {
    // `base` is destructured rather than spread whole: a chain that DROPS an
    // entry below would otherwise see the receiver's own `refinementArgs`
    // survive into the result, and the compiler would emit a bound the chain no
    // longer stands behind.
    const { refinementArgs: inherited, ...rest } = base;
    const refinements = [...(base.refinements ?? []), member];

    // A name used twice in one chain (`.max(3).max(5)`) keeps NO entry: keyed by
    // name, one entry cannot hold both bounds, and keeping either silently
    // widens the other. Neither recorded ⇒ the compiler declines the node.
    const repeated = base.refinements?.includes(member) === true;
    const entries = Object.entries(inherited ?? {}).filter(([name]) => !(repeated && name === member));

    if (!repeated && argument !== undefined && Node.isNumericLiteral(argument)) {
        entries.push([member, argument.getLiteralValue()]);
    }

    return entries.length > 0 ? { ...rest, refinementArgs: Object.fromEntries(entries), refinements } : { ...rest, refinements };
};

const parseValidatorCall = (call: CallExpression): ValidatorIR => {
    const callee = call.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
        return { kind: "any", sourceText: call.getText() };
    }

    const member = callee.getName();
    const args = call.getArguments();

    // Every modifier unwraps to its receiver's IR; the three sets differ only in
    // what they then record. Partitioned by EFFECT so adding a modifier means
    // choosing which list it belongs in — a single `member === …` comparison
    // standing in for one of the sets is how the next addition silently gets the
    // wrong treatment.
    if (COLUMN_MODIFIERS.has(member) || REFINEMENT_MODIFIERS.has(member) || METADATA_MODIFIERS.has(member) || PARSE_BEHAVIOR_MODIFIERS.has(member)) {
        const receiver = callee.getExpression();
        const base = Node.isExpression(receiver) ? parseValidator(receiver) : { kind: "any" };

        if (COLUMN_MODIFIERS.has(member)) {
            return applyColumnModifier(base, member);
        }

        return REFINEMENT_MODIFIERS.has(member) ? applyRefinement(base, member, args[0]) : base;
    }

    return parseBuilderMember(member, args, call);
};

export { COLUMN_MODIFIERS, METADATA_MODIFIERS, PARSE_BEHAVIOR_MODIFIERS, parseObjectShape, parseValidator, REFINEMENT_MODIFIERS, setStandardTypeResolver };
export type { StandardTypeResolver };
