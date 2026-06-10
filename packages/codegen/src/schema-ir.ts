import type { JsonSchema, SchemaNodeReader } from "@cirrus/values";
import { jsonSchemaFromNode, objectSchemaFromNodes } from "@cirrus/values";

import type { ValidatorIR } from "./ir";

/**
 * Render a `v.literal(...)` value as a JSON Schema `const`. The IR carries the
 * literal as verbatim source text (`"admin"`, `42`, `true`, `null`), so parse it
 * back to a JSON value; a bigint-style literal is carried as its decimal string.
 */
const literalConst = (literalValue: string | undefined): JsonSchema => {
    if (literalValue === undefined) {
        return {};
    }

    const trimmed = literalValue.trim();

    if (trimmed === "true") {
        return { const: true };
    }

    if (trimmed === "false") {
        return { const: false };
    }

    if (trimmed === "null") {
        // eslint-disable-next-line unicorn/no-null -- a `v.literal(null)` must serialize to a JSON Schema `const: null`
        return { const: null, type: "null" };
    }

    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return { const: trimmed.slice(1, -1), type: "string" };
    }

    const asNumber = Number(trimmed);

    if (!Number.isNaN(asNumber)) {
        return { const: asNumber };
    }

    return { const: trimmed };
};

/**
 * The {@link SchemaNodeReader} over codegen {@link ValidatorIR} (parsed from the
 * schema/handler AST). Children are plain IR fields rather than runtime `_meta`,
 * and the IR carries no runtime metadata, so `.check()`/`.meta()` constraint
 * fragments are always absent (`constraints` → `undefined`). A `literal`'s `const`
 * is parsed from the verbatim source text the IR records (see {@link literalConst}),
 * not a live value. Plugging this reader into the shared {@link jsonSchemaFromNode}
 * core keeps the dialect (Draft 2020-12 / OpenAPI 3.1) identical to
 * `@cirrus/values`' `toJsonSchema` by construction.
 */
const irReader: SchemaNodeReader<ValidatorIR> = {
    constraints: () => undefined,
    inner: (validator) => validator.inner,
    isNullable: (validator) => validator.column?.notNull === false,
    // `ValidatorIR.kind` is a loose `string` (build-time AST); narrow it to the
    // shared reader's `ValidatorKind`. Unknown kinds fall through the mapper's
    // `default` branch to an empty schema, exactly as before.
    kind: (validator) => validator.kind as ReturnType<SchemaNodeReader<ValidatorIR>["kind"]>,
    literalSchema: (validator) => literalConst(validator.literalValue),
    members: (validator) => validator.members ?? [],
    shape: (validator) => validator.shape ?? {},
    tableName: (validator) => validator.tableName,
    valueChild: (validator) => validator.valueType,
};

/**
 * Convert a codegen {@link ValidatorIR} into a JSON Schema node. A thin wrapper
 * over the shared {@link jsonSchemaFromNode} core (from `@cirrus/values`) with the
 * IR-backed {@link irReader}, so the kind→schema mapping is the *same* algorithm
 * `@cirrus/values`' `toJsonSchema` runs — codegen never instantiates the runtime
 * `v.*` objects, it only holds the reflected IR. Shared by the OpenAPI and
 * OpenRPC emitters so both surfaces speak one JSON Schema dialect.
 */
const validatorIrToJsonSchema = (validator: ValidatorIR): JsonSchema => jsonSchemaFromNode(validator, irReader);

/** Build `{ type: "object", properties, required }` from an IR shape (mirrors `@cirrus/values`' object mapping). */
const objectSchema = (shape: Record<string, ValidatorIR>): JsonSchema => objectSchemaFromNodes(shape, irReader);

/** Build the args object schema for an RPC function (mirrors `argsToJsonSchema`). */
const argsObjectSchema = (args: Record<string, ValidatorIR>): JsonSchema => objectSchema(args);

/**
 * The machine-readable `CirrusError` codes Cirrus emits on the RPC + REST
 * surfaces, enumerated from `@cirrus/server`'s `CODE_STATUS` map plus the
 * runtime/DO dispatch codes (`FUNCTION_NOT_FOUND`, `PAYLOAD_TOO_LARGE`,
 * `METHOD_NOT_ALLOWED`, the `*_NOT_CONFIGURED` admin gates, …). The list documents
 * the contract; clients switch on `error.code`. Kept sorted for stable output.
 */
const CIRRUS_ERROR_CODES: ReadonlyArray<string> = [
    "BAD_REQUEST",
    "CONFLICT",
    "COUNT_RLS_UNSUPPORTED",
    "FORBIDDEN",
    "FUNCTION_NOT_FOUND",
    "INTERNAL",
    "INTERNAL_SERVER_ERROR",
    "METHOD_NOT_ALLOWED",
    "NOT_FOUND",
    "NOT_IMPLEMENTED",
    "PAYLOAD_TOO_LARGE",
    "TOO_MANY_REQUESTS",
    "UNAUTHORIZED",
    "UNPROCESSABLE",
    "VALIDATION_ERROR",
];

export { argsObjectSchema, CIRRUS_ERROR_CODES, literalConst, objectSchema, validatorIrToJsonSchema };
