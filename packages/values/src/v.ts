import type { ValidationPath } from "./errors.js";
import { describeValue, formatPath, ValidationError } from "./errors.js";

/** Branded id type, e.g. `Id<"users">`. */
export type Id<TableName extends string> = string & { readonly __table: TableName };

/**
 * Runtime "kind" tag attached to every validator. Codegen and reflective tools
 * use this to inspect the shape without crawling the closure.
 */
export type ValidatorKind
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

export interface Validator<T = unknown> {
    readonly __type: T;

    readonly kind: ValidatorKind;

    parse: (value: unknown) => T;

    safeParse: (value: unknown) => { error: ValidationError; ok: false } | { ok: true; value: T };
}

/** Extract the TS type a validator describes (the **select** type). */
export type Infer<V> = V extends Validator<infer T> ? T : never;

/**
 * Column constraints/defaults collected from the `v.*` modifier chain used
 * inside `defineTable`. Inert in argument position. Persisted on the
 * validator's internal `_meta.column` and mirrored into codegen IR.
 */
export interface ColumnMeta {
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
export interface Column<TSelect, TInsert> {
    /** Phantom carrier — type-only, never present at runtime. */
    readonly __column: { insert: TInsert; select: TSelect };
}

/**
 * A {@link Validator} carrying the chainable column-modifier API. The factories
 * (`v.string()`, …) return this so modifiers are available inside `defineTable`.
 * `TSelect` is the read type; `TInsert` is the write type (modifiers may make it
 * `| undefined`, marking the field optional on insert).
 */
export interface ColumnValidator<TSelect, TInsert> extends Column<TSelect, TInsert>, Validator<TSelect> {
    /** Default factory applied in the write layer; field becomes optional on insert. */
    $defaultFn: (fn: () => TSelect) => ColumnValidator<TSelect, TInsert | undefined>;
    /** Recompute the field on every patch/replace when not explicitly provided. */
    $onUpdateFn: (fn: () => TSelect) => ColumnValidator<TSelect, TInsert>;
    /** Override the inferred select/insert type without changing runtime parsing (e.g. `v.string().$type<Id<"users">>()`). */
    $type: <TOverride>() => ColumnValidator<TOverride, TOverride>;
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
export interface TimestampColumnValidator extends ColumnValidator<number, number> {
    /** Default to the current epoch-ms (`Date.now()`) at insert time; field becomes optional on insert. */
    defaultNow: () => ColumnValidator<number, number | undefined>;
}

/** The type a validator/column presents on **select** (reads). */
export type InferSelect<V> = V extends Validator<infer T> ? T : never;

/** The type a validator/column accepts on **insert** (writes). */
export type InferInsert<V> = V extends Column<unknown, infer I> ? I : V extends Validator<infer T> ? T : never;

/** Derive the read shape of a table's column map. */
export type SelectShape<S extends Record<string, Validator>> = {
    [K in keyof S]: InferSelect<S[K]>;
};

/**
 * Derive the write shape of a table's column map. Columns whose insert type
 * includes `undefined` (via `.default()` / `.$defaultFn()` / `v.optional`)
 * become optional keys.
 */
export type InsertShape<S extends Record<string, Validator>> = {
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
    $defaultFn: (fn: () => T) => InternalColumnValidator<T>;
    $onUpdateFn: (fn: () => T) => InternalColumnValidator<T>;
    $type: <TOverride>() => InternalColumnValidator<TOverride>;
    default: (value: T) => InternalColumnValidator<T>;
    defaultNow: () => InternalColumnValidator<T>;
    nullable: () => InternalColumnValidator<null | T>;
    unique: () => InternalColumnValidator<T>;
}

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
        kind,
        _parse(value: unknown, context: ParseContext) {
            return parser(value, context);
        },
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
    validator.$defaultFn = (fn) => rebuild({ defaultFn: fn });
    validator.$onUpdateFn = (fn) => rebuild({ onUpdateFn: fn });
    // `$type` is a compile-time-only override; runtime parsing is unchanged, so
    // it clones the validator and lets the public signature retype the result.
    validator.$type = (() => rebuild({})) as InternalColumnValidator<T>["$type"];
    validator.nullable = () => {
        const nullableParser = (value: unknown, context: ParseContext): null | T => {
            return value === null ? null : parser(value, context);
        };

        return createValidator<null | T>(kind, nullableParser, { ...meta, column: { ...column, notNull: false } });
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
            if (typeof value !== "number" || Number.isNaN(value)) {
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

const array = <V extends Validator>(inner: V): ColumnValidator<Array<Infer<V>>, Array<Infer<V>>> => {
    const innerInternal = toInternal(inner as Validator<Infer<V>>);

    return asColumn(
        createValidator<Array<Infer<V>>>(
            "array",
            (value, context) => {
                if (!Array.isArray(value)) {
                    fail(context, "array", value);
                }

                const out: Array<Infer<V>> = [];

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

const objectValidator = <S extends ObjectShape>(shape: S): ColumnValidator<ObjectShapeType<S>, ObjectShapeType<S>> => {
    return asColumn(
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
                const out: Record<string, unknown> = {};

                for (const key of Object.keys(input)) {
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

                fail(context, `union of ${members.length} member(s)`, value);
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
export const v: {
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
