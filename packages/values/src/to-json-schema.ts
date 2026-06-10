import type { ColumnMeta, Validator } from "./v";

/**
 * A JSON Schema node (Draft 2020-12 / OpenAPI 3.1 compatible). Intentionally a
 * loose bag — Cirrus only emits a known subset, but consumers (OpenAPI/OpenRPC
 * builders, Swagger UI, form generators) treat it as an opaque schema object.
 */
interface JsonSchema {
    [keyword: string]: unknown;
}

/** The runtime-introspectable surface of a validator (`kind` + the internal `_meta` bag). */
interface Introspectable {
    readonly _meta?: Record<string, unknown>;
    readonly kind: Validator["kind"];
}

/** Read a validator's runtime `kind`/`_meta` without importing the package-private `InternalValidator`. */
const introspect = (validator: Validator): Introspectable => validator;

/** Build `{ type: "object", properties, required }` from a shape, converting each child with `convert`. */
const objectSchema = (shape: Record<string, Validator>, convert: (validator: Validator) => JsonSchema): JsonSchema => {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, child] of Object.entries(shape)) {
        properties[key] = convert(child);

        // A `v.optional(...)` field is the only thing that drops out of `required`.
        if (child.kind !== "optional") {
            required.push(key);
        }
    }

    return { additionalProperties: false, properties, required, type: "object" };
};

/**
 * Convert a single `@cirrus/values` validator to a JSON Schema node. Walks the
 * runtime `kind` + `_meta` recursively, so nested objects/arrays/unions/records
 * are fully expanded (not collapsed to one level). A `.nullable()` validator —
 * which keeps its base `kind` but clears `column.notNull` — widens to also accept
 * `null`. A `.check()`/`.meta()` that contributed a JSON Schema fragment (stored
 * on `_meta.constraints`) is shallow-merged onto the node, so refinements like
 * `{ minLength: 1 }`/`{ pattern: "…" }`/`{ minimum: 0 }` and descriptions are
 * reflected (constraint keys win over the base on conflict). A plain
 * predicate-only `.check()` carries no fragment and stays opaque.
 *
 * `date`/`timestamp` are epoch-millisecond numbers in Cirrus (not ISO strings),
 * so they schema as integers; `bigint` schemas as an int64 (JSON has no bigint
 * type, so `format: int64` is the conventional OpenAPI carrier); `bytes` is an
 * `ArrayBuffer`, surfaced as base64 per JSON Schema 2020-12 content encoding.
 */
const toJsonSchema = (validator: Validator): JsonSchema => {
    const meta = introspect(validator)._meta ?? {};

    const base = ((): JsonSchema => {
        switch (validator.kind) {
            case "any": {
                // An empty schema validates anything.
                return {};
            }
            case "array": {
                return { items: toJsonSchema(meta.inner as Validator), type: "array" };
            }
            case "bigint": {
                return { format: "int64", type: "integer" };
            }
            case "boolean": {
                return { type: "boolean" };
            }
            case "bytes": {
                return { contentEncoding: "base64", description: "binary (ArrayBuffer)", type: "string" };
            }
            case "date": {
                return { description: "epoch milliseconds (date)", type: "integer" };
            }
            case "id": {
                return { description: `Id<"${String(meta.tableName)}">`, type: "string", "x-cirrus-table": meta.tableName };
            }
            case "literal": {
                const { value } = meta;

                // JSON Schema `const` must be JSON-serializable; a bigint literal is
                // carried as its decimal string (mirroring the int64 representation).
                return typeof value === "bigint" ? { const: value.toString(), type: "string" } : { const: value };
            }
            case "null": {
                return { type: "null" };
            }
            case "number": {
                return { type: "number" };
            }
            case "object": {
                return objectSchema(meta.shape as Record<string, Validator>, toJsonSchema);
            }
            case "optional": {
                // Optionality is expressed in the parent's `required` list; a standalone
                // optional just unwraps to its inner schema.
                return toJsonSchema(meta.inner as Validator);
            }
            case "record": {
                return { additionalProperties: toJsonSchema(meta.valueValidator as Validator), type: "object" };
            }
            case "string": {
                return { type: "string" };
            }
            case "timestamp": {
                return { description: "epoch milliseconds (timestamp)", type: "integer" };
            }
            case "union": {
                return { anyOf: (meta.members as ReadonlyArray<Validator>).map((member) => toJsonSchema(member)) };
            }
            default: {
                return {};
            }
        }
    })();

    // Shallow-merge any `.check()`/`.meta()` JSON Schema fragment onto the node.
    // Constraint keys (minLength/pattern/minimum/description/…) win over the base
    // so an enriched refinement can tighten — never silently weaken — the schema.
    const constraints = meta.constraints as JsonSchema | undefined;
    const node = constraints === undefined ? base : { ...base, ...constraints };

    // `.nullable()` is the only modifier that flips `column.notNull` to false;
    // widen the schema to accept null without disturbing the non-nullable default.
    // Constraints describe the underlying value, so they ride inside the non-null
    // branch rather than on the wrapping anyOf.
    const column = meta.column as ColumnMeta | undefined;

    if (column?.notNull === false) {
        return { anyOf: [node, { type: "null" }] };
    }

    return node;
};

/**
 * Convert a function's argument validators (a name-to-validator map) into a
 * single JSON Schema object. Non-`optional` arguments are `required`; the result
 * is the request `params`/`args` schema an OpenAPI operation or OpenRPC method
 * advertises. An empty arg map yields an empty (but valid) object schema.
 */
const argsToJsonSchema = (args: Record<string, Validator>): JsonSchema => objectSchema(args, toJsonSchema);

export type { JsonSchema };
export { argsToJsonSchema, toJsonSchema };
