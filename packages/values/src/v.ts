import { LunoraError } from "@lunora/errors";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { describeValue, formatPath, ValidationError } from "./errors";

/** Branded id type, e.g. `Id<"users">`. */
type Id<TableName extends string> = string & { readonly __table: TableName };

/**
 * A JSON Schema fragment (Draft 2020-12 / OpenAPI 3.1 compatible). Intentionally
 * a loose bag — a `.check()`/`.meta()` caller contributes keywords like
 * `minLength`/`pattern`/`minimum` that `toJsonSchema` shallow-merges onto the
 * node for the enclosing validator. Mirrors the `JsonSchema` shape exported by
 * `./to-json-schema`; kept structurally identical and local so `v.ts` never
 * imports the converter and the two files stay decoupled.
 */
interface JsonSchemaFragment {
    [keyword: string]: unknown;
}

/**
 * Options for a {@link Validator.check} refinement. Lets a predicate carry both
 * a human-facing `message` and an introspectable JSON Schema `schema` fragment
 * (e.g. `{ minLength: 1 }`) so the constraint flows into `toJsonSchema`. The
 * legacy `.check(pred, "message")` string form remains supported.
 */
interface CheckOptions {
    /** Failure message thrown on the `ValidationError` (default `"value matching refinement"`). */
    message?: string;
    /** JSON Schema fragment merged onto this validator's node by `toJsonSchema`. */
    schema?: JsonSchemaFragment;
}

/**
 * Options for {@link Validator.meta} — pure metadata with no runtime parsing
 * effect, used to enrich the emitted JSON Schema node (description + constraint
 * keywords) without attaching a predicate.
 */
interface MetaOptions {
    /** A human description merged onto this validator's JSON Schema node. */
    description?: string;
    /** JSON Schema fragment merged onto this validator's node by `toJsonSchema`. */
    schema?: JsonSchemaFragment;
}

/**
 * Runtime "kind" tag attached to every validator. Codegen and reflective tools
 * use this to inspect the shape without crawling the closure.
 */
type ValidatorKind =
    | "any"
    | "array"
    | "bigint"
    | "boolean"
    | "bytes"
    | "date"
    | "from"
    | "geoPoint"
    | "id"
    | "literal"
    | "null"
    | "number"
    | "object"
    | "optional"
    | "record"
    | "storage"
    | "string"
    | "timestamp"
    | "union";

interface Validator<T = unknown> extends StandardSchemaV1<T, T> {
    readonly __type: T;

    /**
     * Attach a refinement predicate. The returned validator parses with the
     * original rules first; if the result satisfies `predicate` it passes
     * through, otherwise it throws a {@link ValidationError} carrying
     * `message` (default: `"value matching refinement"`). Multiple `.check()`
     * calls chain — every predicate must return true.
     *
     * The second argument may be a plain message string (legacy form) or a
     * {@link CheckOptions} object that additionally carries a JSON Schema
     * `schema` fragment (e.g. `{ minLength: 1 }`) reflected by `toJsonSchema`.
     *
     * Works in any context — argument validators, column validators, or
     * standalone — so it can encode invariants like
     * `v.number().check(n => n >= 0)`.
     *
     * For the common length/format/range cases, prefer the named shortcuts
     * (`v.string().min(1)`, `.max(n)`, `.length(n)`, `.pattern(re)`, `.email()`,
     * `.url()`; `v.number().min(n)`, `.max(n)`, `.int()`, `.positive()`;
     * `v.array(...).min(n)`, `.max(n)`) — each is sugar over this same
     * `.check(predicate, { schema })` path, so the predicate and the JSON Schema
     * keyword are set together and can never drift apart. `.check()` remains the
     * escape hatch for anything the shortcuts don't cover, e.g.
     * `v.string().check(s => s.length > 0, { message: "non-empty", schema: { minLength: 1 } })`.
     */
    check: (predicate: (value: T) => boolean, options?: CheckOptions | string) => Validator<T>;

    readonly kind: ValidatorKind;

    /**
     * Attach pure metadata (description + JSON Schema constraint fragment) with
     * no effect on runtime parsing. The fragment is shallow-merged onto this
     * validator's emitted JSON Schema node, composing with any `.check()`
     * `schema` fragments (later wins on conflicting keys).
     */
    meta: (options: MetaOptions) => Validator<T>;

    parse: (value: unknown, options?: ParseOptions) => T;

    safeParse: (value: unknown, options?: ParseOptions) => { error: ValidationError; ok: false } | { ok: true; value: T };
}

/** Extract the TS type a validator describes (the **select** type). */
type Infer<V> = V extends Validator<infer T> ? T : never;

/**
 * Column constraints/defaults collected from the `v.*` modifier chain used
 * inside `defineTable`. Inert in argument position. Persisted on the
 * validator's internal `_meta.column` and mirrored into codegen IR.
 */
interface ColumnMeta {
    /** `.$defaultFn(fn)` — default factory; field is optional on insert. */
    defaultFn?: () => unknown;
    /** `.default(value)` — literal default; field is optional on insert. */
    defaultValue?: unknown;
    /** Default `true`; `.nullable()` flips it to `false`. */
    notNull: boolean;
    /** `.$onUpdateFn(fn)` — recomputed on every patch/replace. */
    onUpdateFn?: () => unknown;

    /**
     * `.serverDefault(fn)` — a SERVER-trusted value factory. Unlike
     * `.$defaultFn` (which only fills an absent field), this runs on every
     * insert/update and SILENTLY OVERWRITES any client-supplied value with
     * `fn({ auth })`, so the column is never client-controllable (e.g.
     * `ownerId`/`tenantId` stamped from `auth.userId`). Field is optional on
     * insert. The factory runs server-side with the resolved request auth.
     */
    serverDefault?: (context: ServerDefaultContext) => unknown;
    /** `.unique()` — synthesizes a UNIQUE index. */
    unique?: boolean;
}

/**
 * Context handed to a `.serverDefault(fn)` factory at write time. Carries the
 * resolved request identity so a column can be stamped from the caller
 * (`auth.userId`) rather than trusted from the client. Structurally mirrors the
 * `auth` slice of the server's procedure context without depending on
 * `@lunora/server`.
 */
interface ServerDefaultContext {
    readonly auth: {
        /** The raw identity claims, or `null` for the anonymous/no-resolver case. */
        readonly identity: Record<string, unknown> | null;
        /** The resolved caller id, or `null` when unauthenticated. */
        readonly userId: null | string;
    };
}

/**
 * Phantom carrier of a column's select/insert types. Never present at runtime;
 * `defineTable` reads it to derive `$inferSelect` / `$inferInsert`.
 */
interface Column<TSelect, TInsert> {
    /** Phantom carrier — type-only, never present at runtime. */
    readonly __column: { insert: TInsert; select: TSelect };
}

/**
 * A {@link Validator} carrying the chainable column-modifier API. The factories
 * (`v.string()`, …) return this so modifiers are available inside `defineTable`.
 * `TSelect` is the read type; `TInsert` is the write type (modifiers may make it
 * `| undefined`, marking the field optional on insert).
 */
interface ColumnValidator<TSelect, TInsert> extends Column<TSelect, TInsert>, Validator<TSelect> {
    /** Default factory applied in the write layer; field becomes optional on insert. */
    $defaultFn: (function_: () => TSelect) => ColumnValidator<TSelect, TInsert | undefined>;
    /** Recompute the field on every patch/replace when not explicitly provided. */
    $onUpdateFn: (function_: () => TSelect) => ColumnValidator<TSelect, TInsert>;
    /** Override the inferred select/insert type without changing runtime parsing (e.g. `v.string().$type<Id<"users">>()`). */
    $type: <TOverride>() => ColumnValidator<TOverride, TOverride>;
    /** Refinement predicate run after parsing — see {@link Validator.check}. Chainable; preserves column modifiers. */
    check: (predicate: (value: TSelect) => boolean, options?: CheckOptions | string) => ColumnValidator<TSelect, TInsert>;
    /** Literal default applied in the write layer; field becomes optional on insert. */
    default: (value: TSelect) => ColumnValidator<TSelect, TInsert | undefined>;
    /** Attach JSON Schema metadata — see {@link Validator.meta}. Chainable; preserves column modifiers. */
    meta: (options: MetaOptions) => ColumnValidator<TSelect, TInsert>;
    /** Allow SQL NULL — widens the select type to `T | null`. */
    nullable: () => ColumnValidator<null | TSelect, null | TInsert>;

    /**
     * Stamp this column SERVER-side from the request auth on every write,
     * overwriting any client-supplied value. The field becomes optional on
     * insert (the server fills it). Use for owner/tenant columns that must never
     * be client-controllable — e.g. `v.string().serverDefault(({ auth }) => auth.userId)`.
     */
    serverDefault: (function_: (context: ServerDefaultContext) => TSelect) => ColumnValidator<TSelect, TInsert | undefined>;
    /** Enforce a UNIQUE constraint (synthesizes a unique index). */
    unique: () => ColumnValidator<TSelect, TInsert>;
}

/**
 * A time-valued {@link ColumnValidator} (epoch milliseconds). Adds
 * {@link TimestampColumnValidator.defaultNow} so the field can default to the
 * insert-time clock.
 */
interface TimestampColumnValidator extends ColumnValidator<number, number> {
    /** Default to the current epoch-ms (`Date.now()`) at insert time; field becomes optional on insert. */
    defaultNow: () => ColumnValidator<number, number | undefined>;
}

/**
 * A {@link ColumnValidator} for `v.string()` with ergonomic refinement
 * shortcuts. Each method is sugar over `.check(predicate, { schema })` — it
 * sets the runtime predicate AND the matching JSON Schema keyword in one call
 * so the two can never drift (see the module-level `.check()` docstring for
 * the underlying two-part mechanism). Chainable among each other; `.check()`/
 * `.meta()` compose after them but the return narrows to the base
 * {@link ColumnValidator} (no further refinement shortcuts after that point).
 */
interface StringColumnValidator extends ColumnValidator<string, string> {
    /** Require a valid email address (`format: "email"`). Uses a pragmatic (non-RFC-5322-exhaustive) pattern. */
    email: () => StringColumnValidator;
    /** Require exactly `length` characters (`minLength`/`maxLength` both set to `length`). */
    length: (length: number) => StringColumnValidator;
    /** Require at most `max` characters (`maxLength`). */
    max: (max: number) => StringColumnValidator;
    /** Require at least `min` characters (`minLength`). */
    min: (min: number) => StringColumnValidator;

    /**
     * Require the value to match `pattern` (JSON Schema `pattern` set from
     * `pattern.source`; emitted `pattern` does not encode `pattern.flags` — a
     * case-insensitive `/i` regex, for instance, emits a flag-less JSON Schema
     * pattern). A `g`/`y`-flagged `pattern` is tested statelessly (its
     * `lastIndex` is never consulted or advanced), so a single validator
     * instance gives the same answer for the same input on every call.
     */
    pattern: (pattern: RegExp) => StringColumnValidator;

    /**
     * Require a valid `http:`/`https:` URL (`format: "uri"`). Parseable by the
     * WHATWG `URL` constructor is necessary but not sufficient — schemes such as
     * `javascript:`, `data:`, `file:`, and `vbscript:` all parse successfully but
     * are rejected here, since accepting them lets a validated "link" field carry
     * an XSS payload straight into an anchor's `href` or `window.location` at
     * render time.
     */
    url: () => StringColumnValidator;
}

/**
 * A {@link ColumnValidator} for `v.number()` with ergonomic refinement
 * shortcuts — see {@link StringColumnValidator} for the delegation pattern.
 */
interface NumberColumnValidator extends ColumnValidator<number, number> {
    /** Require an integer value (`Number.isInteger`); JSON Schema `type` narrows to `"integer"`. */
    int: () => NumberColumnValidator;
    /** Require at most `max` (`maximum`). */
    max: (max: number) => NumberColumnValidator;
    /** Require at least `min` (`minimum`). */
    min: (min: number) => NumberColumnValidator;
    /** Require a value strictly greater than zero (`exclusiveMinimum: 0`). */
    positive: () => NumberColumnValidator;
}

/**
 * A {@link ColumnValidator} for `v.object(...)`, carrying the `.strip()` opt-out.
 */
interface ObjectColumnValidator<T> extends ColumnValidator<T, T> {
    /**
     * Drop keys this shape does not declare, even under `.output()`.
     *
     * Only meaningful there — input parsing strips already. Say it when the
     * narrowing is deliberate (trimming an internal field off a row before it
     * reaches a client); without it, an undeclared key on the way OUT is an
     * error, because the alternative is deleting server data silently.
     */
    strip: () => ObjectColumnValidator<T>;
}

/**
 * A {@link ColumnValidator} for `v.array(...)` with ergonomic length-refinement
 * shortcuts — see {@link StringColumnValidator} for the delegation pattern.
 */
interface ArrayColumnValidator<TItem> extends ColumnValidator<TItem[], TItem[]> {
    /** Require at most `max` items (`maxItems`). */
    max: (max: number) => ArrayColumnValidator<TItem>;
    /** Require at least `min` items (`minItems`). */
    min: (min: number) => ArrayColumnValidator<TItem>;
}

/** The type a validator/column presents on **select** (reads). */
type InferSelect<V> = V extends Validator<infer T> ? T : never;

/** The type a validator/column accepts on **insert** (writes). */
type InferInsert<V> = V extends Column<unknown, infer I> ? I : V extends Validator<infer T> ? T : never;

/** Derive the read shape of a table's column map. */
type SelectShape<S extends Record<string, Validator>> = {
    [K in keyof S]: InferSelect<S[K]>;
};

/**
 * Derive the write shape of a table's column map. Columns whose insert type
 * includes `undefined` (via `.default()` / `.$defaultFn()` / `v.optional`)
 * become optional keys.
 */
type InsertShape<S extends Record<string, Validator>> = {
    [K in keyof S as undefined extends InferInsert<S[K]> ? K : never]?: Exclude<InferInsert<S[K]>, undefined>;
} & {
    [K in keyof S as undefined extends InferInsert<S[K]> ? never : K]: InferInsert<S[K]>;
};

/** Options for {@link Validator.parse} / {@link Validator.safeParse}. */
interface ParseOptions {
    /** See {@link ParseContext.rejectUnknownKeys}. */
    rejectUnknownKeys?: boolean;
}

interface ParseContext {
    /**
     * Mutable path stack walked from the root to the value currently being
     * parsed. Composite parsers `push` a segment before descending into a child
     * and `pop` it on return, so on the success path no per-child array is
     * allocated. `fail()` snapshots it (the live array is reused), so the
     * {@link ValidationError} retains a stable copy.
     */
    path: (number | string)[];

    /**
     * Set by `v.union` for the duration of a branch trial. While it is `true`,
     * {@link fail} throws the shared {@link PROBE_MISS} instead of building a
     * real {@link ValidationError} — see that constant for why.
     */
    probe?: boolean;

    /**
     * Reject keys an object shape does not declare, instead of dropping them.
     *
     * Off for input, where stripping is what stops an over-posted field reaching
     * a handler. On for `.output()`, where the same behaviour deletes a field the
     * server meant to send: a column present in the row and missing from the
     * validator vanished from every response with no error anywhere. An object
     * that opts out with `.strip()` keeps stripping under this flag, so
     * deliberate narrowing stays possible and — unlike before — visible.
     */
    rejectUnknownKeys?: boolean;
}

interface InternalValidator<T> extends Validator<T> {
    /** @internal */
    readonly _meta?: Record<string, unknown>;
    /** @internal */
    _parse: (value: unknown, context: ParseContext) => T;
}

/**
 * Runtime shape returned by {@link createValidator}: an internal validator with
 * the modifier methods attached. Modifier return types are intentionally loose
 * here (insert type untracked); the public factories cast to the precise
 * {@link ColumnValidator} surface.
 */
interface InternalColumnValidator<T> extends InternalValidator<T> {
    $defaultFn: (function_: () => T) => InternalColumnValidator<T>;
    $onUpdateFn: (function_: () => T) => InternalColumnValidator<T>;
    $type: <TOverride>() => InternalColumnValidator<TOverride>;
    check: (predicate: (value: T) => boolean, options?: CheckOptions | string) => InternalColumnValidator<T>;
    default: (value: T) => InternalColumnValidator<T>;
    defaultNow: () => InternalColumnValidator<T>;
    meta: (options: MetaOptions) => InternalColumnValidator<T>;
    nullable: () => InternalColumnValidator<null | T>;
    serverDefault: (function_: (context: ServerDefaultContext) => T) => InternalColumnValidator<T>;
    unique: () => InternalColumnValidator<T>;
}

/** Internal runtime shape backing {@link StringColumnValidator}. */
interface InternalStringColumnValidator extends InternalColumnValidator<string> {
    email: () => InternalStringColumnValidator;
    length: (length: number) => InternalStringColumnValidator;
    max: (max: number) => InternalStringColumnValidator;
    min: (min: number) => InternalStringColumnValidator;
    pattern: (pattern: RegExp) => InternalStringColumnValidator;
    url: () => InternalStringColumnValidator;
}

/** Internal runtime shape backing {@link NumberColumnValidator}. */
interface InternalNumberColumnValidator extends InternalColumnValidator<number> {
    int: () => InternalNumberColumnValidator;
    max: (max: number) => InternalNumberColumnValidator;
    min: (min: number) => InternalNumberColumnValidator;
    positive: () => InternalNumberColumnValidator;
}

/** Internal runtime shape backing {@link ArrayColumnValidator}. */
interface InternalArrayColumnValidator<T> extends InternalColumnValidator<T[]> {
    max: (max: number) => InternalArrayColumnValidator<T>;
    min: (min: number) => InternalArrayColumnValidator<T>;
}

/**
 * A pragmatic (not RFC-5322-exhaustive) email pattern: one-or-more
 * non-whitespace/non-`@` chars (dots allowed), `@`, then one-or-more
 * dot-separated domain labels each excluding `.` from their own character
 * class. The domain-label classes are dot-exclusive specifically so the two
 * `+`-quantified groups either side of the repeated `\.` never overlap in
 * what they can match — that disjointness is what keeps the match linear
 * instead of letting the engine try every possible split point around each
 * dot (a super-linear backtracking blowup on adversarial input otherwise).
 * Good enough to catch the common "missing `@`"/"missing domain" mistakes
 * without pretending to fully validate deliverability (RFC 5322 pedantry does
 * not either).
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u;

/**
 * True when `value` parses as a WHATWG URL AND uses the `http:`/`https:`
 * scheme. An allowlist rather than a denylist deliberately — `URL.canParse`
 * alone accepts any scheme the parser recognizes (`javascript:`, `data:`,
 * `file:`, `vbscript:`, …), and a denylist would need to name every dangerous
 * scheme up front and stay current as new ones appear. http(s)-only covers the
 * overwhelming majority of "validate a link" use cases and fails closed on
 * everything else.
 */
const isValidUrl = (value: string): boolean => {
    if (!URL.canParse(value)) {
        return false;
    }

    const { protocol } = new URL(value);

    return protocol === "http:" || protocol === "https:";
};

/**
 * Pre-built miss signal thrown by {@link fail} while a `v.union` branch trial is
 * in flight (`context.probe`). Constructing a real {@link ValidationError} costs
 * ~2.4µs, ~90% of it V8's stack capture — and a union pays that for every branch
 * it tries before the matching one, so a *successful* parse of a 3-member union's
 * last branch cost ~400x a first-branch match. Nothing reads the diagnostics of a
 * branch that merely missed, so the trial throws this shared, stackless instance
 * instead and the union re-runs the loop without `probe` only when *every* branch
 * missed — i.e. on the error path, where building the real diagnostic is fine.
 *
 * It is a `ValidationError` so the existing `instanceof` catch sites keep
 * working, and it can never escape to a caller: `probe` is set only inside
 * `union`'s trial (restored in a `finally`), and the only rethrow is into an
 * enclosing union that is itself probing.
 */
const PROBE_MISS = new ValidationError("union branch probe miss (internal)", { expected: "", path: [], received: "" });

// Declared as a function (not an arrow expression) so TypeScript treats its
// `: never` return as a control-flow assertion — callers rely on this to narrow
// `value` after `if (!check) fail(...)`. `func-style` is disabled here because
// an arrow const loses that narrowing and surfaces no-unsafe-call downstream.
// eslint-disable-next-line func-style
function fail(context: ParseContext, expected: string, received: unknown, options?: { redactValue?: boolean }): never {
    if (context.probe === true) {
        throw PROBE_MISS;
    }

    // Snapshot the live mutable path stack — composite parsers push/pop into it,
    // so the ValidationError must own its own copy.
    const path = [...context.path];
    // `redactValue` suppresses the concrete primitive literal in `received`/the
    // message. Set only on `.check()` refinement failures (the value already
    // passed its type check) so a secret-bearing field never leaks its value to
    // the wire/logs; type-mismatch failures keep the literal for diagnostics.
    const receivedDescription = describeValue(received, { literal: !options?.redactValue });

    throw new ValidationError(`Expected ${expected} at ${formatPath(path)}, received ${receivedDescription}`, {
        expected,
        path,
        received: receivedDescription,
    });
}

/**
 * Shallow-merge a JSON Schema `fragment` onto the `constraints` already carried
 * in `meta`, returning the next meta bag. Later fragments win on conflicting
 * keys (matching how chained `.check()`/`.meta()` calls read left-to-right).
 * When there is no fragment the original meta is returned untouched so the
 * common (constraint-free) path allocates nothing extra.
 * @returns The merged meta bag, or the original `meta` when no fragment is provided.
 */
const mergeConstraints = (meta: Record<string, unknown> | undefined, fragment: JsonSchemaFragment | undefined): Record<string, unknown> | undefined => {
    if (fragment === undefined) {
        return meta;
    }

    const previous = meta?.constraints as JsonSchemaFragment | undefined;

    return { ...meta, constraints: { ...previous, ...fragment } };
};

const createValidator = <T>(
    kind: ValidatorKind,
    parser: (value: unknown, context: ParseContext) => T,
    meta?: Record<string, unknown>,
): InternalColumnValidator<T> => {
    const column: ColumnMeta = (meta?.column as ColumnMeta | undefined) ?? { notNull: true };

    const validator = {
        __type: undefined as unknown as T,
        // The Standard Schema v1 surface (https://standardschema.dev). `validate`
        // delegates to `safeParse`: on success it returns `{ value }`, on a
        // ValidationError it maps to `{ issues: [...] }`. Lunora paths are already
        // `(string | number)[]`, a subset of Standard Schema's
        // `ReadonlyArray<PropertyKey | PathSegment>`, so they pass through
        // verbatim — no per-segment wrapping needed (same as Zod/Valibot, which
        // also emit bare keys). Synchronous validate is permitted by the spec.
        "~standard": {
            /** @returns A Standard Schema result object — either `{ value }` on success or `{ issues }` on failure. */
            validate(value: unknown): StandardSchemaV1.Result<T> {
                const result = validator.safeParse(value);

                if (result.ok) {
                    return { value: result.value };
                }

                return { issues: [{ message: result.error.message, path: result.error.path }] };
            },
            vendor: "lunora",
            version: 1,
        } satisfies StandardSchemaV1.Props<T, T>,
        _meta: { ...meta, column },
        _parse(value: unknown, context: ParseContext) {
            return parser(value, context);
        },
        kind,
        parse(value: unknown, options?: ParseOptions) {
            return parser(value, { path: [], ...options });
        },
        /** @returns `{ ok: true, value }` on success or `{ ok: false, error }` on a validation failure. */
        safeParse(value: unknown, options?: ParseOptions): { error: ValidationError; ok: false } | { ok: true; value: T } {
            try {
                return { ok: true as const, value: parser(value, { path: [], ...options }) };
            } catch (error: unknown) {
                if (error instanceof ValidationError) {
                    return { error, ok: false as const };
                }

                throw error;
            }
        },
    } as unknown as InternalColumnValidator<T>;

    const rebuild = (patch: Partial<ColumnMeta>): InternalColumnValidator<T> => createValidator<T>(kind, parser, { ...meta, column: { ...column, ...patch } });

    validator.default = (value) => rebuild({ defaultValue: value });
    validator.defaultNow = () => rebuild({ defaultFn: () => Date.now() });
    validator.unique = () => rebuild({ unique: true });
    validator.$defaultFn = (function_) => rebuild({ defaultFn: function_ });
    validator.$onUpdateFn = (function_) => rebuild({ onUpdateFn: function_ });
    validator.serverDefault = (function_) => rebuild({ serverDefault: function_ });
    // `$type` is a compile-time-only override; runtime parsing is unchanged, so
    // it clones the validator and lets the public signature retype the result.
    validator.$type = (() => rebuild({})) as InternalColumnValidator<T>["$type"];
    validator.nullable = () => {
        // eslint-disable-next-line unicorn/no-null -- .nullable() represents a SQL NULL column; null is the value it must accept and return
        const nullableParser = (value: unknown, context: ParseContext): null | T => (value === null ? null : parser(value, context));

        return createValidator<null | T>(kind, nullableParser, { ...meta, column: { ...column, notNull: false } });
    };
    // `.check()` composes a refinement on top of the existing parser. The
    // returned validator keeps the same kind + column meta so column modifiers
    // chained either before or after a check still apply. The optional second
    // argument is either a bare message string (legacy form) or a
    // {@link CheckOptions} object additionally carrying a JSON Schema `schema`
    // fragment, which is accumulated into `_meta.constraints` (later checks win
    // on conflicting keys) so `toJsonSchema` can reflect it.
    validator.check = (predicate, options) => {
        const message = typeof options === "string" ? options : options?.message;
        const fragment = typeof options === "string" ? undefined : options?.schema;
        const refinedParser = (value: unknown, context: ParseContext): T => {
            const parsed = parser(value, context);

            if (!predicate(parsed)) {
                fail(context, message ?? "value matching refinement", parsed, { redactValue: true });
            }

            return parsed;
        };

        return createValidator<T>(kind, refinedParser, mergeConstraints(meta, fragment));
    };
    // `.meta()` carries pure metadata (description + JSON Schema fragment) with
    // no parsing effect, so the parser is reused unchanged. A `description` is
    // folded into the same `constraints` bag toJsonSchema shallow-merges.
    validator.meta = (options) => {
        const fragment: JsonSchemaFragment | undefined =
            options.description === undefined ? options.schema : { description: options.description, ...options.schema };

        return createValidator<T>(kind, parser, mergeConstraints(meta, fragment));
    };

    // Kind-specific ergonomic refinements (`.min()`/`.email()`/`.int()`/…). Each
    // is sugar over the SAME `validator.check(predicate, { schema })` path just
    // defined above, so runtime predicate and JSON-Schema keyword can never
    // drift apart. Attached here (inside `createValidator`, gated on `kind`)
    // rather than on the public factories so they survive `.check()`'s
    // recursive `createValidator` call and stay available for further chaining
    // (`.min(1).email()`), since `kind` is threaded through every rebuild.
    switch (kind) {
        case "array": {
            const self = validator as unknown as InternalArrayColumnValidator<unknown>;

            self.min = (min) =>
                self.check((value) => value.length >= min, {
                    message: `expected array length >= ${String(min)}`,
                    schema: { minItems: min },
                }) as InternalArrayColumnValidator<unknown>;
            self.max = (max) =>
                self.check((value) => value.length <= max, {
                    message: `expected array length <= ${String(max)}`,
                    schema: { maxItems: max },
                }) as InternalArrayColumnValidator<unknown>;

            break;
        }
        case "number": {
            const self = validator as unknown as InternalNumberColumnValidator;

            self.min = (min) =>
                self.check((value) => value >= min, {
                    message: `expected number >= ${String(min)}`,
                    schema: { minimum: min },
                }) as InternalNumberColumnValidator;
            self.max = (max) =>
                self.check((value) => value <= max, {
                    message: `expected number <= ${String(max)}`,
                    schema: { maximum: max },
                }) as InternalNumberColumnValidator;
            self.int = () =>
                self.check((value) => Number.isInteger(value), {
                    message: "expected an integer",
                    schema: { type: "integer" },
                }) as InternalNumberColumnValidator;
            self.positive = () =>
                self.check((value) => value > 0, {
                    message: "expected a positive number",
                    schema: { exclusiveMinimum: 0 },
                }) as InternalNumberColumnValidator;

            break;
        }
        case "string": {
            const self = validator as unknown as InternalStringColumnValidator;

            self.min = (min) =>
                self.check((value) => value.length >= min, {
                    message: `expected string length >= ${String(min)}`,
                    schema: { minLength: min },
                }) as InternalStringColumnValidator;
            self.max = (max) =>
                self.check((value) => value.length <= max, {
                    message: `expected string length <= ${String(max)}`,
                    schema: { maxLength: max },
                }) as InternalStringColumnValidator;
            self.length = (length) =>
                self.check((value) => value.length === length, {
                    message: `expected string length === ${String(length)}`,
                    schema: { maxLength: length, minLength: length },
                }) as InternalStringColumnValidator;
            self.pattern = (pattern) => {
                // `g`/`y`-flagged regexes are stateful: `RegExp.prototype.test`
                // advances `lastIndex` on match and resumes from it next call, so
                // reusing the caller's `RegExp` instance directly across requests
                // makes the same input alternate between passing and failing
                // depending on call order. Strip `g`/`y` once here into a fresh,
                // non-advancing `RegExp` so `.test()` is a pure function of its
                // input; the JSON Schema `pattern` still comes from the original
                // `pattern.source` (flags are never encoded there regardless).
                const stable = pattern.global || pattern.sticky ? new RegExp(pattern.source, pattern.flags.replaceAll(/[gy]/gu, "")) : pattern;

                return self.check((value) => stable.test(value), {
                    message: `expected string matching ${pattern.toString()}`,
                    schema: { pattern: pattern.source },
                }) as InternalStringColumnValidator;
            };
            self.email = () =>
                self.check((value) => EMAIL_PATTERN.test(value), {
                    message: "expected a valid email address",
                    schema: { format: "email" },
                }) as InternalStringColumnValidator;
            self.url = () =>
                self.check((value) => isValidUrl(value), {
                    message: "expected a valid URL",
                    schema: { format: "uri" },
                }) as InternalStringColumnValidator;

            break;
        }
        default: {
            break;
        }
    }

    return validator;
};

const toInternal = <T>(validator: Validator<T>): InternalValidator<T> => validator as InternalValidator<T>;

/** Bridge the loose runtime validator to the precise public column surface. */
const asColumn = <TSelect, TInsert = TSelect>(validator: InternalColumnValidator<TSelect>): ColumnValidator<TSelect, TInsert> =>
    validator as unknown as ColumnValidator<TSelect, TInsert>;

/** Bridge the loose runtime validator to the public {@link StringColumnValidator} surface. */
const asStringColumn = (validator: InternalStringColumnValidator): StringColumnValidator => validator as unknown as StringColumnValidator;

/** Bridge the loose runtime validator to the public {@link NumberColumnValidator} surface. */
const asNumberColumn = (validator: InternalNumberColumnValidator): NumberColumnValidator => validator as unknown as NumberColumnValidator;

/** Bridge the loose runtime validator to the public {@link ArrayColumnValidator} surface. */
const asArrayColumn = <T>(validator: InternalArrayColumnValidator<T>): ArrayColumnValidator<T> => validator as unknown as ArrayColumnValidator<T>;

const string = (): StringColumnValidator =>
    asStringColumn(
        createValidator<string>("string", (value, context) => {
            if (typeof value !== "string") {
                fail(context, "string", value);
            }

            return value;
        }) as unknown as InternalStringColumnValidator,
    );

/**
 * Shared parser for `v.number()` and the (epoch-millisecond) time validators.
 * Rejects NaN and ±Infinity — they round-trip through JSON as `null` and break
 * downstream code that assumes a real numeric value.
 */
const parseFiniteNumber = (value: unknown, context: ParseContext): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(context, "number", value);
    }

    return value;
};

const number = (): NumberColumnValidator => asNumberColumn(createValidator<number>("number", parseFiniteNumber) as unknown as InternalNumberColumnValidator);

/** Epoch-millisecond timestamp (`number`). Pair with `.defaultNow()` for an insert-time clock. */
const timestamp = (): TimestampColumnValidator => createValidator<number>("timestamp", parseFiniteNumber) as unknown as TimestampColumnValidator;

/** Calendar date stored as an epoch-millisecond `number`. Pair with `.defaultNow()` for an insert-time clock. */
const date = (): TimestampColumnValidator => createValidator<number>("date", parseFiniteNumber) as unknown as TimestampColumnValidator;

const boolean = (): ColumnValidator<boolean, boolean> =>
    asColumn(
        createValidator<boolean>("boolean", (value, context) => {
            if (typeof value !== "boolean") {
                fail(context, "boolean", value);
            }

            return value;
        }),
    );

const bigintValidator = (): ColumnValidator<bigint, bigint> =>
    asColumn(
        createValidator<bigint>("bigint", (value, context) => {
            if (typeof value !== "bigint") {
                fail(context, "bigint", value);
            }

            return value;
        }),
    );

const nullValidator = (): ColumnValidator<null, null> =>
    asColumn(
        createValidator<null>("null", (value, context) => {
            if (value !== null) {
                fail(context, "null", value);
            }

            return value;
        }),
    );

const bytes = (): ColumnValidator<ArrayBuffer, ArrayBuffer> =>
    asColumn(
        createValidator<ArrayBuffer>("bytes", (value, context) => {
            if (!(value instanceof ArrayBuffer)) {
                fail(context, "ArrayBuffer", value);
            }

            return value;
        }),
    );

const id = <TableName extends string>(tableName: TableName): ColumnValidator<Id<TableName>, Id<TableName>> =>
    asColumn(
        createValidator<Id<TableName>>(
            "id",
            (value, context) => {
                if (typeof value !== "string") {
                    fail(context, `Id<"${tableName}">`, value);
                }

                return value as Id<TableName>;
            },
            { tableName },
        ),
    );

/**
 * A reference to a stored R2 object: the column holds the object's **key** (a
 * string), the same key `@lunora/storage` puts/gets by. Functionally it parses
 * like `v.string()`, but the distinct `"storage"` kind lets codegen and the
 * studio join the data model to R2 — the file browser uses it to show which
 * record owns a file and to flag orphaned objects no row references. The
 * optional `bucket` names the typed bucket the key lives in (for app-context
 * signed URLs); omit it for the app's default bucket.
 */
const storage = (bucket?: string): ColumnValidator<string, string> =>
    asColumn(
        createValidator<string>(
            "storage",
            (value, context) => {
                if (typeof value !== "string") {
                    fail(context, "storage object key (string)", value);
                }

                return value;
            },
            bucket === undefined ? undefined : { bucket },
        ),
    );

/**
 * A geographic point — latitude/longitude in decimal degrees (WGS84). The value
 * a `v.geoPoint()` column reads/writes. Stored as a JSON object alongside the
 * row; a `.geoIndex(name, { field })` on the table maintains a geohash companion
 * so `withGeoIndex(name, q => q.near(point, radius) | q.within(bbox))` can answer
 * proximity/bounding-box reads.
 */
interface GeoPoint {
    /** Latitude in decimal degrees, `-90 … 90`. */
    lat: number;
    /** Longitude in decimal degrees, `-180 … 180`. */
    lng: number;
}

/**
 * A latitude/longitude point (WGS84 decimal degrees). Parses an object with
 * finite `lat` ∈ `[-90, 90]` and `lng` ∈ `[-180, 180]`; any other shape or an
 * out-of-range coordinate throws a {@link ValidationError}. Pair with a table's
 * `.geoIndex(name, { field })` to enable `near` / `within` reads.
 */
const geoPoint = (): ColumnValidator<GeoPoint, GeoPoint> =>
    asColumn(
        createValidator<GeoPoint>("geoPoint", (value, context) => {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                fail(context, "geoPoint { lat, lng }", value);
            }

            const point = value as Record<string, unknown>;
            const { lat, lng } = point;

            if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
                context.path.push("lat");
                fail(context, "latitude in [-90, 90]", lat);
            }

            if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
                context.path.push("lng");
                fail(context, "longitude in [-180, 180]", lng);
            }

            return { lat, lng };
        }),
    );

const literal = <T extends bigint | boolean | number | string | null>(literalValue: T): ColumnValidator<T, T> =>
    asColumn(
        createValidator<T>(
            "literal",
            (value, context) => {
                if (value !== literalValue) {
                    fail(context, `literal(${String(literalValue)})`, value);
                }

                return value as T;
            },
            { value: literalValue },
        ),
    );

const array = <V extends Validator>(inner: V): ArrayColumnValidator<Infer<V>> => {
    const innerInternal = toInternal(inner as Validator<Infer<V>>);

    return asArrayColumn(
        createValidator<Infer<V>[]>(
            "array",
            (value, context) => {
                if (!Array.isArray(value)) {
                    fail(context, "array", value);
                }

                const { length } = value;
                // Built by `push` onto an empty literal rather than preallocated
                // with `Array.from({ length })`. `Array.from` over a bare
                // array-like has no fast path in V8 — it walks the length-only
                // object through the generic iteration protocol, which measured
                // ~27x slower than either alternative and made parsing a 32-item
                // array several times slower than the naive loop it replaced
                // (see `__bench__/parse-hotpath.bench.ts`). `push` also keeps the
                // result PACKED, which `new Array(length)` would not — a holey
                // array stays slower for every downstream consumer that iterates it.
                const out: Infer<V>[] = [];
                const { path } = context;

                for (let index = 0; index < length; index += 1) {
                    path.push(index);
                    out.push(innerInternal._parse(value[index], context));
                    path.pop();
                }

                return out;
            },
            { inner },
        ) as unknown as InternalArrayColumnValidator<Infer<V>>,
    );
};

/**
 * Split a value-type map into optional + required keys: any member whose value
 * type includes `undefined` becomes an optional key. The single optionality rule
 * shared by object-shape inference ({@link ObjectShapeType}) and args-map
 * inference (`InferValidatorMap` in `./validator-map`), so the two can never
 * drift. (`InsertShape` stays separate — it additionally `Exclude`s `undefined`
 * from the optional value, a deliberate insert-type difference.)
 */
type OptionalizeShape<M> = {
    [K in keyof M as undefined extends M[K] ? K : never]?: M[K];
} & { [K in keyof M as undefined extends M[K] ? never : K]: M[K] };

type ObjectShape = Record<string, Validator>;
type ObjectShapeType<S extends ObjectShape> = OptionalizeShape<{ [K in keyof S]: Infer<S[K]> }>;

const objectValidator = <S extends ObjectShape>(shape: S, stripUnknown?: boolean): ObjectColumnValidator<ObjectShapeType<S>> => {
    // Precompute the key list, per-key internal validator, and the optional flag
    // once at construction time — the shape is fixed, so the per-parse hot path
    // never re-runs Object.keys (one array alloc) or re-casts each child.
    const entries = Object.keys(shape).map((key) => {
        const child = toInternal(shape[key] as Validator);

        return { child, isOptional: child.kind === "optional", key } as const;
    });

    // A declared `__proto__` field can't be written back with a plain `out[key] =
    // …` assignment below — `__proto__` is an accessor on `Object.prototype`, so
    // the assignment would invoke its setter (reparenting `out`, or no-op'ing for
    // a non-object value) instead of creating a data property, silently dropping
    // the field. Building `out` as a null-proto object would dodge that, but it
    // would also change the prototype of EVERY parsed object (not just ones with
    // this field) — a schema this rare isn't worth that blast radius (it would
    // desync `@lunora/codegen`'s AOT-compiled fast path, which emits plain object
    // literals, from this interpreted oracle). Reject it here instead, at
    // construction time, same tier as `v.union`'s empty-members guard above.
    if (entries.some(({ key }) => key === "__proto__")) {
        throw new LunoraError("INTERNAL", 'v.object: "__proto__" cannot be a declared field name — it collides with the Object.prototype accessor');
    }

    const validator = asColumn(
        createValidator<ObjectShapeType<S>>(
            "object",
            (value, context) => {
                if (typeof value !== "object" || value === null || Array.isArray(value)) {
                    fail(context, "object", value);
                }

                const input = value as Record<string, unknown>;
                const out: Record<string, unknown> = {};
                const { path } = context;

                // Under `.output()` an undeclared key is a mistake, not noise:
                // silently dropping it is how a column present in the row goes
                // missing from every response. `.strip()` is the opt-out for a
                // shape that is narrowing on purpose.
                if (context.rejectUnknownKeys === true && stripUnknown !== true) {
                    const declared = new Set(entries.map(({ key }) => key));
                    const undeclared = Object.keys(input).filter((key) => !declared.has(key));

                    if (undeclared.length > 0) {
                        throw new ValidationError(
                            `object has ${String(undeclared.length)} undeclared key(s): ${undeclared.join(", ")}. ` +
                                `Add them to the validator, or call .strip() on it to drop them on purpose.`,
                            {
                                expected: `only the declared keys (${entries.map(({ key }) => key).join(", ")})`,
                                path: [...path],
                                received: undeclared.join(", "),
                            },
                        );
                    }
                }

                for (const { child, isOptional, key } of entries) {
                    // Read via Object.hasOwn so a declared field whose name
                    // collides with an Object.prototype member (`toString`,
                    // `constructor`, `valueOf`, `hasOwnProperty`, …) reads as
                    // absent (`undefined`) rather than the inherited function —
                    // otherwise the optional-skip below never fires and the inner
                    // parser rejects a perfectly valid input (`received function`).
                    const fieldValue = Object.hasOwn(input, key) ? input[key] : undefined;

                    // An absent optional field is skipped wholesale, so a
                    // `.check()` refinement attached to a `v.optional(...)` never
                    // runs for an absent field here (it does when the same
                    // validator is `parse`d standalone). A refinement meant to
                    // reject `undefined` must not rely on the object/args path.
                    if (fieldValue === undefined && isOptional) {
                        continue;
                    }

                    path.push(key);
                    out[key] = child._parse(fieldValue, context);
                    path.pop();
                }

                return out as ObjectShapeType<S>;
            },
            { shape },
        ),
    ) as unknown as ObjectColumnValidator<ObjectShapeType<S>>;

    // Rebuilt rather than mutated, so `.strip()` returns a NEW validator: the
    // shape it is called on may already be a const shared across procedures, and
    // flipping its behaviour in place would change what every other holder
    // parses.
    validator.strip = () => objectValidator(shape, true);

    return validator;
};

const record = <K extends Validator<string>, V extends Validator>(
    keyValidator: K,
    valueValidator: V,
): ColumnValidator<Record<Infer<K>, Infer<V>>, Record<Infer<K>, Infer<V>>> => {
    const keyInternal = toInternal(keyValidator as unknown as Validator<Infer<K>>);
    const valueInternal = toInternal(valueValidator as Validator<Infer<V>>);

    return asColumn(
        createValidator<Record<Infer<K>, Infer<V>>>(
            "record",
            (value, context) => {
                if (typeof value !== "object" || value === null || Array.isArray(value)) {
                    fail(context, "record", value);
                }

                const input = value as Record<string, unknown>;
                // `Object.create(null)` so the result has no prototype chain.
                // Because the target has a null prototype, assigning any key —
                // including `__proto__`/`constructor`/`prototype` — creates a
                // plain own property and cannot pollute Object.prototype, so we
                // round-trip every own enumerable key instead of silently
                // dropping legitimate data under those names.
                const out = Object.create(null) as Record<string, unknown>;
                const { path } = context;

                for (const key of Object.keys(input)) {
                    path.push(key);
                    const parsedKey = keyInternal._parse(key, context);
                    const parsedValue = valueInternal._parse(input[key], context);

                    path.pop();
                    out[parsedKey as string] = parsedValue;
                }

                return out as Record<Infer<K>, Infer<V>>;
            },
            { keyValidator, valueValidator },
        ),
    );
};

/**
 * The cold half of `v.union`'s parser: every branch already missed under the
 * trial pass, so re-run them WITHOUT `context.probe` to build the real
 * diagnostic. Paying per-branch {@link ValidationError} construction is fine
 * here — this only runs on the error path, and the re-run is what keeps the
 * message byte-identical to the pre-trial implementation.
 *
 * Split out of the parser rather than inlined so the hot path stays a single
 * loop. Always throws; the return type only documents that.
 */
const failUnion = (memberInternals: ReadonlyArray<InternalValidator<unknown>>, value: unknown, context: ParseContext, baseDepth: number): never => {
    const { path } = context;
    // Keep the deepest (longest-path) branch failure — the most specific detail.
    let deepestError: ValidationError | undefined;
    // A member that redacted the value (a `.check()` miss on a secret-bearing
    // field) described it by its bare type tag. The union's own diagnostic wraps
    // that miss and must withhold the same literal, whichever member it was —
    // otherwise `v.union(password, …)` echoed what `password` alone did not.
    const bareTag = describeValue(value, { literal: false });
    let redactValue = false;

    for (const member of memberInternals) {
        try {
            member._parse(value, context);
        } catch (error: unknown) {
            if (!(error instanceof ValidationError)) {
                throw error;
            }

            path.length = baseDepth;
            redactValue ||= error.received === bareTag;

            if (deepestError === undefined || error.path.length > deepestError.path.length) {
                deepestError = error;
            }
        }
    }

    // With exactly one member, surface its own (more specific) error; otherwise
    // report the union miss at the union's own path, citing the closest branch.
    if (memberInternals.length === 1 && deepestError !== undefined) {
        throw deepestError;
    }

    const detail = deepestError === undefined ? "" : ` (closest: expected ${deepestError.expected} at ${formatPath(deepestError.path)})`;

    return fail(context, `union of ${String(memberInternals.length)} member(s)${detail}`, value, { redactValue });
};

const union = <Vs extends ReadonlyArray<Validator>>(...members: Vs): ColumnValidator<Infer<Vs[number]>, Infer<Vs[number]>> => {
    if (members.length === 0) {
        throw new LunoraError("INTERNAL", "v.union requires at least one member");
    }

    const memberInternals = members.map((member) => toInternal(member));

    return asColumn(
        createValidator<Infer<Vs[number]>>(
            "union",
            (value, context): Infer<Vs[number]> => {
                const { path } = context;
                const baseDepth = path.length;
                // Trial pass. `probe` makes `fail` throw the shared PROBE_MISS
                // rather than build a per-branch ValidationError nobody reads once
                // a later branch matches — that construction was the entire cost of
                // a union whose match is not its first member. A non-ValidationError
                // from a member's refinement is a programmer error, not a branch
                // miss, so it propagates instead of being swallowed.
                const outerProbe = context.probe === true;

                context.probe = true;

                try {
                    for (const member of memberInternals) {
                        try {
                            return member._parse(value, context) as Infer<Vs[number]>;
                        } catch (error: unknown) {
                            if (!(error instanceof ValidationError)) {
                                throw error;
                            }

                            // A composite member that threw mid-descent left its own
                            // segments on the shared path stack (the pop after the
                            // throwing child never ran); unwind to our entry depth
                            // before trying the next branch.
                            path.length = baseDepth;
                        }
                    }
                } finally {
                    context.probe = outerProbe;
                }

                // Every branch missed. Under an enclosing union's own trial the
                // diagnostic is that union's to build, so signal the miss and stop.
                if (outerProbe) {
                    throw PROBE_MISS;
                }

                // `failUnion` is `: never`; returning it makes every path of this
                // arrow explicitly terminal (consistent-return doesn't track those).
                return failUnion(memberInternals, value, context, baseDepth);
            },
            { members },
        ),
    );
};

const optional = <V extends Validator>(inner: V): ColumnValidator<Infer<V> | undefined, Infer<V> | undefined> => {
    const innerInternal = toInternal(inner as Validator<Infer<V>>);

    return asColumn(
        createValidator<Infer<V> | undefined>(
            "optional",
            (value, context): Infer<V> | undefined => (value === undefined ? undefined : innerInternal._parse(value, context)),
            { inner },
        ),
    );
};

/** Every member of a shape made optional — the result of {@link partial}. */
type PartialShape<S extends ObjectShape> = { [K in keyof S]: ColumnValidator<Infer<S[K]> | undefined, Infer<S[K]> | undefined> };

/**
 * Wrap every member of a shape in {@link optional}.
 *
 * A patch-style procedure takes "any subset of these columns" — the same shape
 * the table declares, with nothing required. Spelling that out by hand means a
 * second copy of the shape that has to be kept in step with the first, and the
 * failure when it drifts is quiet: a column added to the table is simply not
 * accepted by the patch, and nothing typechecks it against the table.
 *
 * Takes and returns a *shape record* rather than a `v.object(...)`, so the one
 * function serves both positions — a procedure's args map (`.input(...)`) and a
 * nested object (`v.object(v.partial(shape))`).
 *
 * A member that is already `v.optional(...)` is passed through rather than
 * double-wrapped, so this is idempotent.
 *
 * **Pass the fields a caller may patch, not a whole table's shape.** Handing this
 * `schema.tables.x.shape` makes every present and *future* column client-writable:
 * add `ownerId`, `role`, or `isVerified` to the table later and it silently joins
 * the patch, with no diff on the procedure to review. Row-level policies do not
 * close that — they decide which ROW you may write, not which fields — so the
 * allow-list has to be here.
 * @example
 * ```ts
 * const editable = { body: v.string(), title: v.string() };
 *
 * mutation.input({ id: v.id("threads"), ...v.partial(editable) }).mutation(…)
 * ```
 */
const partial = <S extends ObjectShape>(shape: S): PartialShape<S> =>
    // `Object.fromEntries` defines data properties (CreateDataPropertyOrThrow),
    // so a `__proto__` member round-trips as a plain key instead of hitting the
    // Object.prototype setter the way `out[key] = …` would. `v.object` rejects
    // that field name anyway, but this helper also feeds args maps, which do not.
    Object.fromEntries(
        Object.entries(shape).map(([key, member]) => [key, toInternal(member).kind === "optional" ? member : optional(member)]),
    ) as PartialShape<S>;

const any = (): ColumnValidator<unknown, unknown> => asColumn(createValidator<unknown>("any", (value) => value));

/**
 * The type a Standard Schema v1 object validates TO — what a read gets back.
 *
 * Defer to the spec's own helper rather than matching `~standard.types`: the spec
 * declares that property optional (it is a phantom that never exists at runtime),
 * so every real library types it as a union with `undefined`, and a hand-written
 * `extends { output: infer O }` misses all of them. A schema that declares no
 * `types` still resolves through the constraint to `unknown`.
 */
type InferStandardOutput<S extends StandardSchemaV1> = StandardSchemaV1.InferOutput<S>;

/**
 * The type a Standard Schema v1 object validates FROM — what a write supplies.
 *
 * Distinct from {@link InferStandardOutput} only for a transforming schema
 * (`z.string().transform(…)`, `z.coerce.number()`), where the value handed in is
 * not the value stored. Identical for everything else.
 */
type InferStandardInput<S extends StandardSchemaV1> = StandardSchemaV1.InferInput<S>;

/**
 * Build the issue path from a Standard Schema issue's `path` segments. Each
 * segment is either a `PropertyKey` or a `{ key: PropertyKey }` object; only
 * string/number keys are kept. Typed loosely (a read-only array of `unknown`)
 * so the runtime narrowing is genuine rather than elided by the static type.
 */
const standardIssuePath = (path: ReadonlyArray<unknown> | undefined): (number | string)[] => {
    const issuePath: (number | string)[] = [];

    if (!path) {
        return issuePath;
    }

    for (const segment of path) {
        const key = typeof segment === "object" && segment !== null && "key" in segment ? (segment as { key: PropertyKey }).key : (segment as PropertyKey);

        if (typeof key === "string" || typeof key === "number") {
            issuePath.push(key);
        }
    }

    return issuePath;
};

/**
 * Wrap any Standard Schema v1 validator (`zod`, `valibot`, `arktype`, …) so it
 * can be used as an args validator in `query`/`mutation`/`action`, or as a table
 * column. The wrapped validator's output type is inferred from
 * `~standard.types.output` when declared; falls back to `unknown` when the
 * schema omits the types field.
 *
 * **Columns are stored by the value's runtime type.** A shard row is a JSON
 * document, so a `v.from()` column needs no SQL type of its own. For a
 * `.global()` table it maps to a TEXT column holding whatever the encoder
 * produces: a scalar is written verbatim (a `v.from(z.string())` column holds a
 * bare `hello`, not `"hello"`), and an object or array is JSON-encoded. That is
 * the same rule `v.union` and `v.any` follow, and it is why the column cannot be
 * a Postgres/MySQL `JSON` column — a bare `hello` is not valid JSON.
 *
 * The consequence worth knowing: a stored *string* that itself looks like JSON
 * (`'{"a":1}'`) is ambiguous on read and decodes to the parsed object. Declare
 * the column with a concrete `v.*` type when the plain column type matters — for
 * a comparison index, or to avoid that ambiguity.
 *
 * **Not seedable.** `@lunora/seed` cannot introspect an external schema to
 * invent a valid value, so it refuses a `v.from()` column with an actionable
 * error rather than generating one that fails validation on insert.
 *
 * **Sync-only.** Standard Schema allows async `validate`; Lunora validation is
 * synchronous and throws when a Promise is returned.
 *
 * **Reads and writes can differ.** A write supplies the schema's INPUT and a read
 * gets its OUTPUT back, because what is stored is `validate()`'s result. The two
 * coincide for every non-transforming schema; they part for `z.coerce.number()`
 * and friends, where typing the insert side as the output would demand the
 * post-transform value from a caller whose value the validator is there to
 * transform.
 */
const from = <S extends StandardSchemaV1>(schema: S): ColumnValidator<InferStandardOutput<S>, InferStandardInput<S>> => {
    // Cast through a loose shape: the static type guarantees `~standard`, but
    // `v.from` is a runtime boundary (callers pass untyped values via `as any`),
    // so the guard below must actually run.
    const props = (schema as { "~standard"?: { validate?: unknown; version?: number } })["~standard"];

    if (props?.version !== 1 || typeof props.validate !== "function") {
        throw new LunoraError("INTERNAL", '@lunora/values: v.from() expects a Standard Schema v1 object (missing or invalid "~standard")');
    }

    const validate = props.validate as StandardSchemaV1["~standard"]["validate"];

    return asColumn(
        createValidator<InferStandardOutput<S>>("from", (value, context) => {
            const result = validate(value);

            // Sync-only. Reject native Promises AND non-native thenables — a
            // thenable slips past `instanceof Promise` and would otherwise fall
            // through to `result.value` (undefined), silently passing an
            // unvalidated value to the handler instead of throwing.
            if (result instanceof Promise || typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
                throw new ValidationError("v.from(): async Standard Schema validators are not supported in args", {
                    expected: "sync Standard Schema result",
                    path: [...context.path],
                    received: "Promise",
                });
            }

            // At this point `result` is a sync StandardSchemaV1.Result (Promise
            // was rejected above). A spec-compliant validator always returns a
            // result object, but `v.from` is a runtime boundary: a non-object
            // result (null / primitive) is a protocol violation that must surface
            // as a clear ValidationError rather than a silent `undefined` `.value`
            // read. The declared `validate` return type promises a result object,
            // but this is a runtime boundary, so guard via a loose cast (mirroring
            // the `then` probe above) rather than trusting the static type.
            const looseResult = result as unknown;

            if (looseResult === null || typeof looseResult !== "object") {
                throw new ValidationError("v.from(): Standard Schema validator returned a non-object result", {
                    expected: "Standard Schema result object",
                    path: [...context.path],
                    received: describeValue(looseResult),
                });
            }

            const syncResult: StandardSchemaV1.Result<InferStandardOutput<S>> = result;

            // `issues` is the spec's own discriminant — declared `readonly issues?:
            // undefined` on the success arm and required on the failure arm — so
            // this narrows the union on its own. An absent key and a present-but-
            // undefined one both read as `undefined`, which is why no `in` probe is
            // needed to tell them apart.
            //
            // ANY defined `issues` is a failure, empty array included. The spec's
            // rule is that a FALSY `issues` means success, and `[]` is truthy, so a
            // validator returning `{ issues: [] }` is reporting failure — badly, but
            // reporting it. Letting an empty array through would fall to the success
            // path and return a `FailureResult`'s absent `value`, handing the caller
            // `undefined` as though it had validated.
            if (syncResult.issues !== undefined) {
                const first = syncResult.issues[0];
                const message = first?.message ?? "Standard Schema validation failed";

                throw new ValidationError(message, {
                    expected: "valid value",
                    path: [...context.path, ...standardIssuePath(first?.path)],
                    received: describeValue(value),
                });
            }

            return syncResult.value;
        }),
    );
};

/**
 * True when `validator` is `v.from(...)` or structurally wraps one through
 * `v.optional` / `v.array` / `v.object` / `v.record` / `v.union`. The nested
 * children live on the validator's `_meta` (`inner`, `shape`, `members`,
 * `keyValidator`/`valueValidator`) and are themselves validators.
 *
 * For tooling that must know whether a value is validated by an external
 * Standard Schema rather than a concrete `v.*` type — a seeder that cannot
 * invent a conforming value, a JSON Schema exporter that has nothing to
 * describe. `defineTable` no longer calls it: a `v.from()` column is allowed
 * and stores JSON, see {@link from}.
 */
const isOrWrapsFromValidator = (validator: Validator): boolean => {
    if (validator.kind === "from") {
        return true;
    }

    const meta = (validator as { _meta?: Record<string, unknown> })._meta;

    if (!meta) {
        return false;
    }

    // Gather candidate nested validators from the structural meta, then recurse.
    const children: unknown[] = [meta.inner, meta.keyValidator, meta.valueValidator];

    if (Array.isArray(meta.members)) {
        children.push(...(meta.members as unknown[]));
    }

    if (meta.shape !== null && typeof meta.shape === "object") {
        children.push(...(Object.values(meta.shape) as unknown[]));
    }

    for (const child of children) {
        if (child !== null && typeof child === "object" && "kind" in child && isOrWrapsFromValidator(child as Validator)) {
            return true;
        }
    }

    return false;
};

/**
 * The inner validator wrapped by `v.optional(inner)`, or `undefined` for any
 * other validator. The nested child lives on the validator's internal `_meta`
 * bag; this accessor keeps that knowledge inside `@lunora/values` (the package
 * that owns validator internals) so consumers don't reach into `_meta`
 * themselves. Used by `@lunora/server`'s `defineEnv` to coerce through a leading
 * `v.optional(...)`.
 * @returns The inner validator if `v.optional(...)`, otherwise `undefined`.
 */
const optionalInner = (validator: Validator): Validator | undefined => {
    if (validator.kind !== "optional") {
        return undefined;
    }

    return (validator as { _meta?: { inner?: Validator } })._meta?.inner;
};

/**
 * Validator/codec namespace. Each factory returns a {@link Validator} with a
 * runtime `parse`/`safeParse` plus a phantom `__type` field for inference.
 */
const v: {
    any: typeof any;
    array: typeof array;
    bigint: typeof bigintValidator;
    boolean: typeof boolean;
    bytes: typeof bytes;
    date: typeof date;
    from: typeof from;
    geoPoint: typeof geoPoint;
    id: typeof id;
    literal: typeof literal;
    null: typeof nullValidator;
    number: typeof number;
    object: typeof objectValidator;
    optional: typeof optional;
    partial: typeof partial;
    record: typeof record;
    storage: typeof storage;
    string: typeof string;
    timestamp: typeof timestamp;
    union: typeof union;
} = {
    any,
    array,
    bigint: bigintValidator,
    boolean,
    bytes,
    date,
    from,
    geoPoint,
    id,
    literal,
    null: nullValidator,
    number,
    object: objectValidator,
    optional,
    partial,
    record,
    storage,
    string,
    timestamp,
    union,
};

export type {
    ArrayColumnValidator,
    CheckOptions,
    Column,
    ColumnMeta,
    ColumnValidator,
    GeoPoint,
    Id,
    Infer,
    InferInsert,
    InferSelect,
    InferStandardInput,
    InferStandardOutput,
    InsertShape,
    JsonSchemaFragment,
    MetaOptions,
    NumberColumnValidator,
    ObjectColumnValidator,
    OptionalizeShape,
    ParseOptions,
    PartialShape,
    SelectShape,
    ServerDefaultContext,
    StringColumnValidator,
    TimestampColumnValidator,
    Validator,
    ValidatorKind,
};
export { isOrWrapsFromValidator, optionalInner, v };
