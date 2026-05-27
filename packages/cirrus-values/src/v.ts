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
        | "id"
        | "literal"
        | "null"
        | "number"
        | "object"
        | "optional"
        | "record"
        | "string"
        | "union";

export interface Validator<T = unknown> {
    readonly __type: T;

    readonly kind: ValidatorKind;

    parse: (value: unknown) => T;

    safeParse: (value: unknown) => { error: ValidationError; ok: false } | { ok: true; value: T };
}

/** Extract the TS type a validator describes. */
export type Infer<V> = V extends Validator<infer T> ? T : never;

interface ParseContext {
    path: ValidationPath;
}

interface InternalValidator<T> extends Validator<T> {
    /** @internal */
    readonly _meta?: Record<string, unknown>;
    /** @internal */
    _parse: (value: unknown, context: ParseContext) => T;
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
): InternalValidator<T> => {
    const validator: InternalValidator<T> = {
        __type: undefined as unknown as T,
        _meta: meta,
        kind,
        _parse(value, context) {
            return parser(value, context);
        },
        parse(value) {
            return parser(value, { path: [] });
        },
        safeParse(value) {
            try {
                return { ok: true, value: parser(value, { path: [] }) };
            } catch (error: unknown) {
                if (error instanceof ValidationError) {
                    return { error, ok: false };
                }

                throw error;
            }
        },
    };

    return validator;
};

const toInternal = <T>(validator: Validator<T>): InternalValidator<T> => validator as InternalValidator<T>;

const string = (): Validator<string> =>
    createValidator<string>("string", (value, context) => {
        if (typeof value !== "string") {
            fail(context, "string", value);
        }

        return value;
    });

const number = (): Validator<number> =>
    createValidator<number>("number", (value, context) => {
        if (typeof value !== "number" || Number.isNaN(value)) {
            fail(context, "number", value);
        }

        return value;
    });

const boolean = (): Validator<boolean> =>
    createValidator<boolean>("boolean", (value, context) => {
        if (typeof value !== "boolean") {
            fail(context, "boolean", value);
        }

        return value;
    });

const bigintValidator = (): Validator<bigint> =>
    createValidator<bigint>("bigint", (value, context) => {
        if (typeof value !== "bigint") {
            fail(context, "bigint", value);
        }

        return value;
    });

const nullValidator = (): Validator<null> =>
    createValidator<null>("null", (value, context) => {
        if (value !== null) {
            fail(context, "null", value);
        }

        return value;
    });

const bytes = (): Validator<ArrayBuffer> =>
    createValidator<ArrayBuffer>("bytes", (value, context) => {
        if (!(value instanceof ArrayBuffer)) {
            fail(context, "ArrayBuffer", value);
        }

        return value;
    });

const id = <TableName extends string>(tableName: TableName): Validator<Id<TableName>> =>
    createValidator<Id<TableName>>(
        "id",
        (value, context) => {
            if (typeof value !== "string") {
                fail(context, `Id<"${tableName}">`, value);
            }

            return value as Id<TableName>;
        },
        { tableName },
    );

const literal = <T extends bigint | boolean | number | string | null>(literalValue: T): Validator<T> =>
    createValidator<T>(
        "literal",
        (value, context) => {
            if (value !== literalValue) {
                fail(context, `literal(${String(literalValue)})`, value);
            }

            return value as T;
        },
        { value: literalValue },
    );

const array = <V extends Validator>(inner: V): Validator<Array<Infer<V>>> => {
    const innerInternal = toInternal(inner as Validator<Infer<V>>);

    return createValidator<Array<Infer<V>>>(
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
    );
};

type ObjectShape = Record<string, Validator>;
type ObjectShapeType<S extends ObjectShape> = {
    [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]>;
} & { [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]> };

const objectValidator = <S extends ObjectShape>(shape: S): Validator<ObjectShapeType<S>> => {
    return createValidator<ObjectShapeType<S>>(
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
    );
};

const record = <K extends Validator<string>, V extends Validator>(keyValidator: K, valueValidator: V): Validator<Record<Infer<K>, Infer<V>>> => {
    const keyInternal = toInternal(keyValidator as unknown as Validator<Infer<K>>);
    const valueInternal = toInternal(valueValidator as Validator<Infer<V>>);

    return createValidator<Record<Infer<K>, Infer<V>>>(
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
    );
};

const union = <Vs extends ReadonlyArray<Validator>>(...members: Vs): Validator<Infer<Vs[number]>> => {
    if (members.length === 0) {
        throw new Error("v.union requires at least one member");
    }

    return createValidator<Infer<Vs[number]>>(
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
    );
};

const optional = <V extends Validator>(inner: V): Validator<Infer<V> | undefined> => {
    const innerInternal = toInternal(inner as Validator<Infer<V>>);

    return createValidator<Infer<V> | undefined>(
        "optional",
        (value, context) => {
            if (value === undefined) {
                return undefined;
            }

            return innerInternal._parse(value, context);
        },
        { inner },
    );
};

const any = (): Validator => createValidator<unknown>("any", (value) => value);

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
    id: typeof id;
    literal: typeof literal;
    null: typeof nullValidator;
    number: typeof number;
    object: typeof objectValidator;
    optional: typeof optional;
    record: typeof record;
    string: typeof string;
    union: typeof union;
} = {
    any,
    array,
    bigint: bigintValidator,
    boolean,
    bytes,
    id,
    literal,
    null: nullValidator,
    number,
    object: objectValidator,
    optional,
    record,
    string,
    union,
};
