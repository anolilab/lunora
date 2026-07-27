import { LunoraError } from "@lunora/errors";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { describeValue, formatPath, ValidationError } from "./errors";

/** Branded id type, e.g. `Id&lt;"users">`. */
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
     * `v.number().check(n => n >= 0)` or
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
    /** Override the inferred select/insert type without changing runtime parsing (e.g. `v.string().$type&lt;Id&lt;"users">>()`). */
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
    /**
     * Mutable path stack walked from the root to the value currently being
     * parsed. Composite parsers `push` a segment before descending into a child
     * and `pop` it on return, so on the success path no per-child array is
     * allocated. `fail()` snapshots it (the live array is reused), so the
     * {@link ValidationError} retains a stable copy.
     */
    path: (number | string)[];
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

// Declared as a function (not an arrow expression) so TypeScript treats its
// `: never` return as a control-flow assertion — callers rely on this to narrow
// `value` after `if (!check) fail(...)`. `func-style` is disabled here because
// an arrow const loses that narrowing and surfaces no-unsafe-call downstream.
// eslint-disable-next-line func-style
function fail(context: ParseContext, expected: string, received: unknown, options?: { redactValue?: boolean }): never {
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
        parse(value: unknown) {
            return parser(value, { path: [] });
        },
        /** @returns `{ ok: true, value }` on success or `{ ok: false, error }` on a validation failure. */
        safeParse(value: unknown): { error: ValidationError; ok: false } | { ok: true; value: T } {
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

const array = <V extends Validator>(inner: V): ColumnValidator<Infer<V>[], Infer<V>[]> => {
    const innerInternal = toInternal(inner as Validator<Infer<V>>);

    return asColumn(
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
        ),
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

const objectValidator = <S extends ObjectShape>(shape: S): ColumnValidator<ObjectShapeType<S>, ObjectShapeType<S>> => {
    // Precompute the key list, per-key internal validator, and the optional flag
    // once at construction time — the shape is fixed, so the per-parse hot path
    // never re-runs Object.keys (one array alloc) or re-casts each child.
    const entries = Object.keys(shape).map((key) => {
        const child = toInternal(shape[key] as Validator);

        return { child, isOptional: child.kind === "optional", key } as const;
    });

    return asColumn(
        createValidator<ObjectShapeType<S>>(
            "object",
            (value, context) => {
                if (typeof value !== "object" || value === null || Array.isArray(value)) {
                    fail(context, "object", value);
                }

                const input = value as Record<string, unknown>;
                const out: Record<string, unknown> = {};
                const { path } = context;

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

const union = <Vs extends ReadonlyArray<Validator>>(...members: Vs): ColumnValidator<Infer<Vs[number]>, Infer<Vs[number]>> => {
    if (members.length === 0) {
        throw new LunoraError("INTERNAL", "v.union requires at least one member");
    }

    const memberInternals = members.map((member) => toInternal(member));

    return asColumn(
        createValidator<Infer<Vs[number]>>(
            "union",
            (value, context): Infer<Vs[number]> => {
                // Parse each member against the live context so the real path is
                // threaded into any per-branch ValidationError. We keep the
                // deepest (longest-path) branch failure to surface the most
                // specific diagnostic. A non-ValidationError from a member's
                // refinement is a programmer error, not a branch miss, so it
                // propagates instead of being swallowed.
                let deepestError: ValidationError | undefined;
                const { path } = context;
                const baseDepth = path.length;

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

                        if (deepestError === undefined || error.path.length > deepestError.path.length) {
                            deepestError = error;
                        }
                    }
                }

                // All branches failed. If exactly one member exists, surface its
                // own (more specific) error; otherwise report the union miss at
                // the union's own path while citing the closest branch detail.
                if (memberInternals.length === 1 && deepestError !== undefined) {
                    throw deepestError;
                }

                const detail = deepestError === undefined ? "" : ` (closest: expected ${deepestError.expected} at ${formatPath(deepestError.path)})`;

                // `fail` is `: never`; returning it makes every path of this arrow
                // explicitly terminal (consistent-return doesn't track never-returns).
                return fail(context, `union of ${String(members.length)} member(s)${detail}`, value);
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

const any = (): ColumnValidator<unknown, unknown> => asColumn(createValidator<unknown>("any", (value) => value));

/**
 * Infer the output type of a Standard Schema v1 object. When the schema omits
 * `~standard.types` (it is optional in the spec), falls back to `unknown` so
 * callers always get a usable type rather than `never`.
 */
type InferStandardOutput<S extends StandardSchemaV1> = S["~standard"]["types"] extends { output: infer O } ? O : unknown;

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
 * can be used as an **args** validator in `query`/`mutation`/`action`. The
 * wrapped validator's output type is inferred from `~standard.types.output`
 * when declared; falls back to `unknown` when the schema omits the types field.
 *
 * **Args-only.** `v.from(...)` validators must not be used as table columns —
 * `defineTable` checks the `kind` and throws a clear error if you try.
 *
 * **Sync-only.** Standard Schema allows async `validate`; Lunora args
 * validation is synchronous and throws when a Promise is returned.
 */
const from = <S extends StandardSchemaV1>(schema: S): ColumnValidator<InferStandardOutput<S>, InferStandardOutput<S>> => {
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
            // as a clear ValidationError rather than an opaque `TypeError` from
            // the `in` operator below (or a silent `undefined` `.value` read).
            // The declared `validate` return type promises a result object, but
            // this is a runtime boundary, so guard via a loose cast (mirroring the
            // `then` probe above) rather than trusting the static type.
            const looseResult = result as unknown;

            if (looseResult === null || typeof looseResult !== "object") {
                throw new ValidationError("v.from(): Standard Schema validator returned a non-object result", {
                    expected: "Standard Schema result object",
                    path: [...context.path],
                    received: describeValue(looseResult),
                });
            }

            const syncResult: StandardSchemaV1.Result<InferStandardOutput<S>> = result as StandardSchemaV1.Result<InferStandardOutput<S>>;
            const syncResultObject: Record<string, unknown> = syncResult as unknown as Record<string, unknown>;

            if ("issues" in syncResultObject && syncResult.issues !== undefined && syncResult.issues.length > 0) {
                const first = syncResult.issues[0];
                const message = first?.message ?? "Standard Schema validation failed";

                throw new ValidationError(message, {
                    expected: "valid value",
                    path: [...context.path, ...standardIssuePath(first?.path)],
                    received: describeValue(value),
                });
            }

            return (syncResult as { value: InferStandardOutput<S> }).value;
        }),
    );
};

/**
 * True when `validator` is `v.from(...)` or structurally wraps one through
 * `v.optional` / `v.array` / `v.object` / `v.record` / `v.union`. `defineTable`
 * uses it to reject Standard-Schema-backed validators anywhere in a column —
 * not just at the top level — since they are args-only and have no SQL column
 * type. The nested children live on the validator's `_meta` (`inner`, `shape`,
 * `members`, `keyValidator`/`valueValidator`) and are themselves validators.
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
    record,
    storage,
    string,
    timestamp,
    union,
};

export type {
    CheckOptions,
    Column,
    ColumnMeta,
    ColumnValidator,
    GeoPoint,
    Id,
    Infer,
    InferInsert,
    InferSelect,
    InferStandardOutput,
    InsertShape,
    JsonSchemaFragment,
    MetaOptions,
    OptionalizeShape,
    SelectShape,
    ServerDefaultContext,
    TimestampColumnValidator,
    Validator,
    ValidatorKind,
};
export { isOrWrapsFromValidator, optionalInner, v };
