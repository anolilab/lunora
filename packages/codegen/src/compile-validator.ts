import type { ValidatorIR } from "./ir";

/**
 * Ahead-of-time compiler from {@link ValidatorIR} to a self-contained JavaScript
 * source string that validates a function's `args` envelope on the hot path —
 * the Worker-safe analogue of zod-compiler / Elysia's JIT (Cloudflare Workers
 * forbid runtime `eval`/`new Function`, so the specialised validator is emitted
 * at `lunora codegen` time and statically bundled instead of compiled in-process).
 *
 * The soundness contract (why this is safe): the emitted parser is a
 * `CompiledValidatorMap` (see `@lunora/values`) — it returns the finished record
 * on a confident success, or the `DEFER` sentinel to hand the input back to the
 * single interpreted parser. It is built to be SOUND, not complete: every
 * structural check `return DEFER` on the slightest doubt, and only inputs the
 * emitted code is certain about take the fast path. Three consequences follow.
 *
 * First, the compiled code carries no error/path/message logic at all — a failed
 * guard simply defers, and the interpreted parser produces the one canonical
 * `ValidationError`, so error contracts can never drift. Second, a validator kind
 * or shape the compiler does not model makes {@link compileArgsValidator} return
 * `undefined`, and the caller just skips the install — that function keeps the
 * interpreted path, no behaviour change. Third, the success output mirrors the
 * interpreted parser: objects are rebuilt with declared keys only (unknown keys
 * dropped), arrays are fresh, scalars pass through by reference, an absent
 * optional key is omitted.
 *
 * Refinements (`.check(...)`) are dropped by the AST→IR step and thus invisible
 * here, so the caller must refuse to compile any args whose source text carries a
 * refinement (see `FunctionIR.argsHaveRefinement`).
 *
 * Emitted-code shape: the output is plain JavaScript that is also valid under
 * strict TypeScript (it lands in the type-checked `_generated/functions.ts`).
 * Objects are built as object literals (never `{}` + index-write, which trips
 * `noImplicitAny`), arrays via `new Array(n)`. The arrow closes over a free
 * `DEFER` binding the caller supplies (the `@lunora/values` sentinel).
 */

/** Validator kinds whose runtime value is the input unchanged (returned by reference). */
const PASS_THROUGH_KINDS = new Set(["any", "bigint", "boolean", "date", "id", "null", "number", "storage", "string", "timestamp"]);

/**
 * A primitive literal source text we can inline into a `===` comparison safely:
 * a double- or single-quoted string with no escapes, an integer/decimal (optional
 * leading `-`), or `true`/`false`/`null`. Deliberately conservative — anything
 * fancier (escapes, exponents, a const reference) declines to the interpreted
 * path rather than risk inlining an unsafe expression.
 */
const PRIMITIVE_LITERAL_RE = /^(?:"[^"\\]*"|'[^'\\]*'|-?\d+(?:\.\d+)?|true|false|null)$/u;

/** Monotonic id source for unique temp variable names within one emitted function. */
interface EmitContext {
    next: () => number;
}

/** Result of compiling one node: the guard/build statements (which may `return DEFER` or declare temps) and the expression yielding the built value. */
interface NodeEmit {
    /** Expression that evaluates to the validated/built value. */
    out: string;
    /** Statements emitted before the value is used; each may `return DEFER`. */
    pre: string;
}

/**
 * True when `node` carries a column-modifier chain (`.nullable()` / `.unique()` /
 * `.default()` …). These are vanishingly rare in argument position and change the
 * accepted shape (e.g. `.nullable()` admits `null`); rather than model each, we
 * decline to compile the node so it keeps the interpreted path.
 */
const hasColumnModifier = (node: ValidatorIR): boolean => node.column !== undefined;

/** The boolean guard for a pass-through scalar kind: `return DEFER` when `inExpr` is the wrong runtime type. */
const emitScalarGuard = (kind: string, inExpr: string): string => {
    switch (kind) {
        case "bigint": {
            return `if (typeof ${inExpr} !== "bigint") return DEFER;\n`;
        }
        case "boolean": {
            return `if (typeof ${inExpr} !== "boolean") return DEFER;\n`;
        }
        case "date":
        case "number":
        case "timestamp": {
            // Mirrors v.ts: reject NaN / ±Infinity as well as non-numbers.
            return `if (typeof ${inExpr} !== "number" || !Number.isFinite(${inExpr})) return DEFER;\n`;
        }
        case "null": {
            return `if (${inExpr} !== null) return DEFER;\n`;
        }
        // string / id / storage all parse as a bare string at runtime.
        default: {
            return `if (typeof ${inExpr} !== "string") return DEFER;\n`;
        }
    }
};

/** Compile `v.literal(value)` for a primitive literal; declines for any non-primitive literal source. */
const compileLiteral = (node: ValidatorIR, inExpr: string): NodeEmit | undefined => {
    const literal = node.literalValue?.trim();

    if (literal === undefined || !PRIMITIVE_LITERAL_RE.test(literal)) {
        return undefined;
    }

    return { out: inExpr, pre: `if (${inExpr} !== ${literal}) return DEFER;\n` };
};

/**
 * Emit the guard + build for one validator node against the input expression
 * `inExpr`. Returns `undefined` when the node's kind/shape isn't modelled — the
 * caller propagates that to "don't compile this function". `v.optional` is
 * intentionally not handled here: optionality is meaningful only as an object
 * field / top-level arg (where an absent key is omitted), so those positions
 * handle it inline and any other nesting declines.
 */
const compileNode = (node: ValidatorIR, inExpr: string, context: EmitContext): NodeEmit | undefined => {
    if (hasColumnModifier(node)) {
        return undefined;
    }

    if (PASS_THROUGH_KINDS.has(node.kind)) {
        if (node.kind === "any") {
            // `v.any()` accepts anything and returns it unchanged — no guard.
            return { out: inExpr, pre: "" };
        }

        return { out: inExpr, pre: emitScalarGuard(node.kind, inExpr) };
    }

    switch (node.kind) {
        case "array": {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: compileArray re-enters compileNode for its element type
            return compileArray(node, inExpr, context);
        }

        case "literal": {
            return compileLiteral(node, inExpr);
        }

        case "object": {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- mutual recursion: compileObject re-enters compileNode per field
            return compileObject(node, inExpr, context);
        }

        default: {
            // optional (in a non-field position) / union / record / from / unknown —
            // not modelled; decline so the function keeps the interpreted path.
            return undefined;
        }
    }
};

/** Compile `v.array(inner)`: Array guard + a fresh array built element-by-element through `inner`. */
const compileArray = (node: ValidatorIR, inExpr: string, context: EmitContext): NodeEmit | undefined => {
    const { inner } = node;

    if (!inner) {
        return undefined;
    }

    const id = context.next();
    const array = `__arr${String(id)}`;
    const index = `__i${String(id)}`;
    const element = `__e${String(id)}`;

    const innerEmit = compileNode(inner, element, context);

    if (!innerEmit) {
        return undefined;
    }

    // `new Array(n)` is `any[]`, so the index-write below is type-clean.
    const pre =
        `if (!Array.isArray(${inExpr})) return DEFER;\n` +
        `const ${array} = new Array(${inExpr}.length);\n` +
        `for (let ${index} = 0; ${index} < ${inExpr}.length; ${index}++) {\n` +
        `const ${element} = ${inExpr}[${index}];\n` +
        `${innerEmit.pre}${array}[${index}] = ${innerEmit.out};\n` +
        `}\n`;

    return { out: array, pre };
};

/** One compiled field of an object/args map: the statements to run and the object-literal entry text to splice. */
interface FieldEmit {
    /** The `"key": expr` or `...(cond ? { "key": v } : {})` entry for the object literal. */
    entry: string;
    /** Statements to run before the literal is built (guards, temp consts). */
    pre: string;
}

/**
 * Compile one field `key` (validated against `access`) of an object/args map into
 * a {@link FieldEmit}, mirroring the interpreted semantics: an absent optional key
 * is omitted, a present field is validated and included. Returns `undefined` when
 * the field's validator isn't modelled.
 */
const compileField = (key: string, node: ValidatorIR, access: string, context: EmitContext): FieldEmit | undefined => {
    const keyLiteral = JSON.stringify(key);

    if (node.kind === "optional") {
        const { inner } = node;

        if (!inner) {
            return undefined;
        }

        const innerEmit = compileNode(inner, access, context);

        if (!innerEmit) {
            return undefined;
        }

        const id = context.next();
        const has = `__has${String(id)}`;
        const value = `__val${String(id)}`;

        // `let value` is `any`, assigned only inside the present-branch; the entry
        // spreads the key only when present, so an absent optional key is omitted.
        const pre = `let ${has} = false;\nlet ${value};\nif (${access} !== undefined) {\n${innerEmit.pre}${value} = ${innerEmit.out};\n${has} = true;\n}\n`;

        return { entry: `...(${has} ? { ${keyLiteral}: ${value} } : {})`, pre };
    }

    const emit = compileNode(node, access, context);

    if (!emit) {
        return undefined;
    }

    return { entry: `${keyLiteral}: ${emit.out}`, pre: emit.pre };
};

/** Compile every field of `shape` (validated against `accessFor(key)`) into combined pre-statements and object-literal entries, or `undefined` if any field declines. */
const compileFields = (
    shape: Record<string, ValidatorIR>,
    accessFor: (key: string) => string,
    context: EmitContext,
): { entries: string; pre: string } | undefined => {
    let pre = "";
    const entries: string[] = [];

    for (const key of Object.keys(shape)) {
        const node = shape[key];

        if (!node) {
            return undefined;
        }

        const field = compileField(key, node, accessFor(key), context);

        if (!field) {
            return undefined;
        }

        pre += field.pre;
        entries.push(field.entry);
    }

    return { entries: entries.join(", "), pre };
};

/** Compile `v.object({...})`: object guard + a fresh record rebuilt from declared keys (unknown keys dropped) as an object literal. */
const compileObject = (node: ValidatorIR, inExpr: string, context: EmitContext): NodeEmit | undefined => {
    const shape = node.shape ?? {};
    const fields = compileFields(shape, (key) => `${inExpr}[${JSON.stringify(key)}]`, context);

    if (!fields) {
        return undefined;
    }

    const id = context.next();
    const object = `__obj${String(id)}`;
    const pre =
        `if (typeof ${inExpr} !== "object" || ${inExpr} === null || Array.isArray(${inExpr})) return DEFER;\n` +
        `${fields.pre}const ${object} = { ${fields.entries} };\n`;

    return { out: object, pre };
};

/**
 * Compile a function's whole `args` map into the source of a `CompiledValidatorMap`
 * arrow function (see `@lunora/values`), or `undefined` when any field isn't
 * modelled. The emitted function closes over a `DEFER` binding (the
 * `@lunora/values` sentinel) supplied by the caller's wiring.
 *
 * Mirrors `parseValidatorMap`: declared keys only, an absent optional key omitted,
 * each present field validated and assigned, unknown source keys dropped. Any
 * structural mismatch `return DEFER` so the interpreted parser owns the error.
 */
const compileArgsValidator = (args: Record<string, ValidatorIR>): string | undefined => {
    let counter = 0;
    const context: EmitContext = {
        next: () => {
            counter += 1;

            return counter;
        },
    };

    const fields = compileFields(args, (key) => `source[${JSON.stringify(key)}]`, context);

    if (!fields) {
        return undefined;
    }

    // Defer the pathological non-object source (null / array) to the interpreted
    // parser, which already handles it identically.
    return `(source) => {\nif (typeof source !== "object" || source === null || Array.isArray(source)) return DEFER;\n${fields.pre}return { ${fields.entries} };\n}`;
};

export default compileArgsValidator;
