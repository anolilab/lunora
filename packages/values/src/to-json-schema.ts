import type { JsonSchema, SchemaNodeReader } from "./json-schema-core";
import { jsonSchemaFromNode, objectSchemaFromNodes } from "./json-schema-core";
import type { ColumnMeta, Validator } from "./v";

/** The runtime-introspectable surface of a validator (`kind` + the internal `_meta` bag). */
interface Introspectable {
    readonly _meta?: Record<string, unknown>;
    readonly kind: Validator["kind"];
}

/** Read a validator's runtime `kind`/`_meta` without importing the package-private `InternalValidator`. */
const introspect = (validator: Validator): Introspectable => validator;

/** `_meta` of a validator, or an empty bag when absent. */
const metaOf = (validator: Validator): Record<string, unknown> => introspect(validator)._meta ?? {};

/**
 * The {@link SchemaNodeReader} over runtime `@lunora/values` validators: children
 * and metadata live on the validator's internal `_meta` bag. A `.nullable()`
 * validator keeps its base `kind` but clears `column.notNull`; a `.check()`/
 * `.meta()` that contributed a JSON Schema fragment stores it on `_meta.constraints`
 * (a plain predicate-only `.check()` carries no fragment and stays opaque). A
 * `literal`'s `const` reads the live `_meta.value` — a bigint literal is carried
 * as its decimal string (mirroring the int64 representation), since JSON Schema
 * `const` must be JSON-serializable.
 */
const validatorReader: SchemaNodeReader<Validator> = {
    constraints: (validator) => metaOf(validator).constraints as JsonSchema | undefined,
    inner: (validator) => metaOf(validator).inner as Validator | undefined,
    isNullable: (validator) => (metaOf(validator).column as ColumnMeta | undefined)?.notNull === false,
    keyChild: (validator) => metaOf(validator).keyValidator as Validator | undefined,
    kind: (validator) => validator.kind,
    literalSchema: (validator) => {
        const { value } = metaOf(validator);

        return typeof value === "bigint" ? { const: value.toString(), format: "int64", type: "string" } : { const: value };
    },
    members: (validator) => metaOf(validator).members as ReadonlyArray<Validator>,
    shape: (validator) => metaOf(validator).shape as Record<string, Validator>,
    tableName: (validator) => metaOf(validator).tableName,
    valueChild: (validator) => metaOf(validator).valueValidator as Validator | undefined,
};

/**
 * Convert a single `@lunora/values` validator to a JSON Schema node (Draft
 * 2020-12 / OpenAPI 3.1). A thin wrapper over the shared {@link jsonSchemaFromNode}
 * core with the runtime {@link validatorReader}; see that core for the full
 * kind→schema mapping (date/timestamp → epoch-ms integer, bigint → int64, bytes →
 * base64, id → annotated string, literal → `const`, optionality via the parent
 * `required` list, `.nullable()` widening, `.check()`/`.meta()` constraint merge).
 */
const toJsonSchema = (validator: Validator): JsonSchema => jsonSchemaFromNode(validator, validatorReader);

/**
 * Convert a function's argument validators (a name-to-validator map) into a
 * single JSON Schema object. Non-`optional` arguments are `required`; the result
 * is the request `params`/`args` schema an OpenAPI operation or OpenRPC method
 * advertises. An empty arg map yields an empty (but valid) object schema.
 */
const argsToJsonSchema = (args: Record<string, Validator>): JsonSchema => objectSchemaFromNodes(args, validatorReader);

export type { JsonSchema } from "./json-schema-core";
export { argsToJsonSchema, toJsonSchema };
