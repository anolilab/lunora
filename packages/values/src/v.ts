import type { ValidationPath } from "./errors.js";
import { describeValue, formatPath, ValidationError } from "./errors.js";

/** Branded id type, e.g. `Id&lt;"users">`. */
type Id<TableName extends string> = string & { readonly __table: TableName };

/**
 * Runtime "kind" tag attached to every validator. Codegen and reflective tools
 * use this to inspect the shape without crawling the closure.
 */
type ValidatorKind
    = | "any"
        | "array"
        | "bigint"
        | "boolean"
        | "bytes"
        | "date"
        | "id"
        | "literal"
        | "null"
        | "number"
        | "object"
        | "optional"
        | "record"
        | "string"
        | "timestamp"
        | "union";

interface Validator<T = unknown> {
    readonly __type: T;

    /**
     * Attach a refinement predicate. The returned validator parses with the
     * original rules first; if the result satisfies `predicate` it passes
     * through, otherwise it throws a {@link ValidationError} carrying
     * `message` (default: `"failed refinement"`). Multiple `.check()` calls
     * chain — every predicate must return true.
     *
     * Works in any context — argument validators, column validators, or
     * standalone — so it can encode invariants like
     * `v.number().check(n => n >= 0)` or
     * `v.string().check(s => s.length > 0, "must not be empty")`.
     */
    check: (predicate: (value: T) => boolean, message?: string) => Validator<T>;

    readonly kind: ValidatorKind;

    parse: (value: unknown) => T;

    safeParse: (value: unknown) => { error: ValidationError; ok: false } | { ok: true; value: T };
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
    /** `.unique()` — synthesizes a UNIQUE index. */
    unique?: boolean;
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
    /** Override the inferred select/insert type without changing runtime parsing (e.g. `v.string().$type&lt;Id&lt;"users">>()`). */
    $type: <TOverride>() => ColumnValidator<TOverride, TOverride>;
    /** Refinement predicate run after parsing — see {@link Validator.check}. Chainable; preserves column modifiers. */
    check: (predicate: (value: TSelect) => boolean, message?: string) => ColumnValidator<TSelect, TInsert>;
    /** Literal default applied in the write layer; field becomes optional on insert. */
    default: (value: TSelect) => ColumnValidator<TSelect, TInsert | undefined>;
    /** Allow SQL NULL — widens the select type to `T | null`. */
    nullable: () => ColumnValidator<null | TSelect, null | TInsert>;
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

interface ParseContext {
    path: ValidationPath;
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
    check: (predicate: (value: T) => boolean, message?: string) => InternalColumnValidator<T>;
    default: (value: T) => InternalColumnValidator<T>;
    defaultNow: () => InternalColumnValidator<T>;
    nullable: () => InternalColumnValidator<null | T>;
    unique: () => InternalColumnValidator<T>;
}

// Declared as a function (not an arrow expression) so TypeScript treats its
// `: never` return as a control-flow assertion — callers rely on this to narrow
// `value` after `if (!check) fail(...)`. `func-style` is disabled here because
// an arrow const loses that narrowing and surfaces no-unsafe-call downstream.
// eslint-disable-next-line func-style
function fail(context: ParseContext, expected: string, received: unknown): never {
    const { path } = context;
    const receivedDescription = describeValue(received);

    throw new ValidationError(`Expected ${expected} at ${formatPath(path)}, received ${receivedDescription}`, {
        expected,
        path,
        received: receivedDescription,
    });
}

const createValidator = <T>(
    kind: ValidatorKind,
    parser: (value: unknown, context: ParseContext) => T,
    meta?: Record<string, unknown>,
): InternalColumnValidator<T> => {
    const column: ColumnMeta = (meta?.column as ColumnMeta | undefined) ?? { notNull: true };

    const validator = {
        __type: undefined as unknown as T,
        _meta: { ...meta, column },
        _parse(value: unknown, context: ParseContext) {
            return parser(value, context);
        },
        kind,
        parse(value: unknown) {
            return parser(value, { path: [] });
        },
        safeParse(value: unknown) {
            try {
                return { ok: true as const, value: parser(value, { path: [] }) };
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
    // `$type` is a compile-time-only override; runtime parsing is unchanged, so
    // it clones the validator and lets the public signature retype the result.
    validator.$type = (() => rebuild({})) as InternalColumnValidator<T>["$type"];
    validator.nullable = () => {
        const nullableParser = (value: unknown, context: ParseContext): null | T => (value === null ? null : parser(value, context));

        return createValidator<null | T>(kind, nullableParser, { ...meta, column: { ...column, notNull: false } });
    };
    // `.check()` composes a refinement on top of the existing parser. The
    // returned validator keeps the same kind + column meta so column modifiers
    // chained either before or after a check still apply.
    validator.check = (predicate, message) => {
        const refinedParser = (value: unknown, context: ParseContext): T => {
            const parsed = parser(value, context);

            if (!predicate(parsed)) {
                fail(context, message ?? "value matching refinement", parsed);
            }

            return parsed;
        };

        return createValidator<T>(kind, refinedParser, meta);
    };

    return validator;
};

const toInternal = <T>(validator: Validator<T>): InternalValidator<T> => validator as InternalValidator<T>;

/** Bridge the loose runtime validator to the precise public column surface. */
const asColumn = <TSelect, TInsert = TSelect>(validator: InternalColumnValidator<TSelect>): ColumnValidator<TSelect, TInsert> =>
    validator as unknown as ColumnValidator<TSelect, TInsert>;

const string = (): ColumnValidator<string, string> =>
    asColumn(
        createValidator<string>("string", (value, context) => {
            if (typeof value !== "string") {
                fail(context, "string", value);
            }

            return value;
        }),
    );

const number = (): ColumnValidator<number, number> =>
    asColumn(
        createValidator<number>("number", (value, context) => {
            // Reject NaN and ±Infinity — they round-trip through JSON as `null`
            // and break downstream code that assumes a real numeric value.
            if (typeof value !== "number" || !Number.isFinite(value)) {
                fail(context, "number", value);
            }

            return value;
        }),
    );

/** Shared parser for the time validators: a finite epoch-millisecond number. */
const parseEpochMillis = (value: unknown, context: ParseContext): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(context, "number", value);
    }

    return value;
};

/** Epoch-millisecond timestamp (`number`). Pair with `.defaultNow()` for an insert-time clock. */
const timestamp = (): TimestampColumnValidator => createValidator<number>("timestamp", parseEpochMillis) as unknown as TimestampColumnValidator;

/** Calendar date stored as an epoch-millisecond `number`. Pair with `.defaultNow()` for an insert-time clock. */
const date = (): TimestampColumnValidator => createValidator<number>("date", parseEpochMillis) as unknown as TimestampColumnValidator;

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

const array = <V extends Validator>(inner: V): ColumnValidator<Infer<V>[], Infer<V>[]> => {
    const innerInternal = toInternal(inner as Validator<Infer<V>>);

    return asColumn(
        createValidator<Infer<V>[]>(
            "array",
            (value, context) => {
                if (!Array.isArray(value)) {
                    fail(context, "array", value);
                }

                const out: Infer<V>[] = [];

                for (const [index, element] of value.entries()) {
                    out.push(innerInternal._parse(element, { path: [...context.path, index] }));
                }

                return out;
            },
            { inner },
        ),
    );
};

type ObjectShape = Record<string, Validator>;
type ObjectShapeType<S extends ObjectShape> = {
    [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]>;
} & { [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]> };

const objectValidator = <S extends ObjectShape>(shape: S): ColumnValidator<ObjectShapeType<S>, ObjectShapeType<S>> =>
    asColumn(
        createValidator<ObjectShapeType<S>>(
            "object",
            (value, context) => {
                if (typeof value !== "object" || value === null || Array.isArray(value)) {
                    fail(context, "object", value);
                }

                const input = value as Record<string, unknown>;
                const out: Record<string, unknown> = {};

                for (const key of Object.keys(shape)) {
                    const child = toInternal(shape[key] as Validator);
                    const fieldValue = input[key];

                    if (fieldValue === undefined && child.kind === "optional") {
                        continue;
                    }

                    out[key] = child._parse(fieldValue, { path: [...context.path, key] });
                }

                return out as ObjectShapeType<S>;
            },
            { shape },
        ),
    );

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
                // `Object.create(null)` so the result has no prototype chain —
                // belt-and-braces against a `__proto__` key sneaking through.
                const out = Object.create(null) as Record<string, unknown>;

                for (const key of Object.keys(input)) {
                    // Skip dangerous keys outright — these mutate the object
                    // prototype if assigned via `out[key] = ...` on a normal
                    // object literal, which is a JSON-level injection risk.
                    if (key === "__proto__" || key === "constructor" || key === "prototype") {
                        continue;
                    }

                    const parsedKey = keyInternal._parse(key, { path: [...context.path, key] });
                    const parsedValue = valueInternal._parse(input[key], { path: [...context.path, key] });

                    out[parsedKey as string] = parsedValue;
                }

                return out as Record<Infer<K>, Infer<V>>;
            },
            { keyValidator, valueValidator },
        ),
    );
};

const union = <Vs extends ReadonlyArray<Validator>>(...members: Vs): ColumnValidator<Infer<Vs[number]>, Infer<Vs[number]>> => {
    if (members.length === 0) {
        throw new Error("v.union requires at least one member");
    }

    return asColumn(
        createValidator<Infer<Vs[number]>>(
            "union",
            (value, context): Infer<Vs[number]> => {
                for (const member of members) {
                    const result = member.safeParse(value);

                    if (result.ok) {
                        return result.value as Infer<Vs[number]>;
                    }
                }

                fail(context, `union of ${String(members.length)} member(s)`, value);
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
            (value, context) => {
                if (value === undefined) {
                    return undefined;
                }

                return innerInternal._parse(value, context);
            },
            { inner },
        ),
    );
};

const any = (): ColumnValidator<unknown, unknown> => asColumn(createValidator<unknown>("any", (value) => value));

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
    id: typeof id;
    literal: typeof literal;
    null: typeof nullValidator;
    number: typeof number;
    object: typeof objectValidator;
    optional: typeof optional;
    record: typeof record;
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
    id,
    literal,
    null: nullValidator,
    number,
    object: objectValidator,
    optional,
    record,
    string,
    timestamp,
    union,
};

export type {
    Column,
    ColumnMeta,
    ColumnValidator,
    Id,
    Infer,
    InferInsert,
    InferSelect,
    InsertShape,
    SelectShape,
    TimestampColumnValidator,
    Validator,
    ValidatorKind,
};
export { v };
