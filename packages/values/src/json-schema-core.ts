import type { ValidatorKind } from "./v";

/**
 * A JSON Schema node (Draft 2020-12 / OpenAPI 3.1 compatible). Intentionally a
 * loose bag — Lunora only emits a known subset, but consumers (OpenAPI/OpenRPC
 * builders, Swagger UI, form generators) treat it as an opaque schema object.
 */
interface JsonSchema {
    [keyword: string]: unknown;
}

/**
 * Structural reader over a validator-like node. The shared mapping algorithm
 * ({@link jsonSchemaFromNode}) is parameterized by this interface so the same
 * switch/recursion serves both inputs Lunora maps to JSON Schema: the runtime
 * `@lunora/values` validator (children + metadata live on `_meta`), and the
 * build-time validator IR consumed by codegen (children are plain fields, with
 * no runtime metadata — so `constraints`/`isNullable` may be inert there).
 *
 * A reader normalizes a `TNode` to the small set of children/leaves the mapper
 * recurses over. Composite accessors (`inner`/`shape`/`members`/`valueChild`)
 * return the same `TNode` type so the mapper can recurse uniformly; leaf concerns
 * that differ between the two sources — how a literal's `const` is computed,
 * whether a `.check()`/`.meta()` constraint fragment exists, whether `.nullable()`
 * was applied — are delegated wholesale to the reader.
 */
interface SchemaNodeReader<TNode> {
    /**
     * The `.check()`/`.meta()` JSON Schema fragment to shallow-merge onto the
     * node, or `undefined` when none (the IR side never carries one). Constraint
     * keys win over the base on conflict so a refinement can tighten — never
     * silently weaken — the schema.
     */
    constraints: (node: TNode) => JsonSchema | undefined;

    /** Inner child of an `array`/`optional` node. May be absent on the IR side. */
    inner: (node: TNode) => TNode | undefined;

    /** Whether `.nullable()` was applied (runtime: `_meta.column.notNull === false`). */
    isNullable: (node: TNode) => boolean;

    /** Discriminating validator kind. */
    kind: (node: TNode) => ValidatorKind;

    /**
     * The JSON Schema `const` fragment for a `literal` node. Computed differently
     * per source — runtime reads the live `_meta.value`; the IR parses verbatim
     * source text — so the reader owns it entirely.
     */
    literalSchema: (node: TNode) => JsonSchema;

    /** Member nodes of a `union`. */
    members: (node: TNode) => ReadonlyArray<TNode>;

    /** Property nodes of an `object`, keyed by property name. */
    shape: (node: TNode) => Record<string, TNode>;

    /** Target table name of an `id` node. */
    tableName: (node: TNode) => unknown;

    /** Value-child of a `record` node. May be absent on the IR side. */
    valueChild: (node: TNode) => TNode | undefined;
}

/**
 * The single validator→JSON-Schema mapping algorithm, shared by the runtime
 * `toJsonSchema` (over `@lunora/values` validators) and codegen's IR-backed
 * mapper. It walks a node recursively via the supplied {@link SchemaNodeReader},
 * so nested objects/arrays/unions/records are fully expanded (never collapsed to
 * one level).
 *
 * `date`/`timestamp` are epoch-millisecond numbers in Lunora (not ISO strings),
 * so they schema as integers; `bigint` schemas as an int64 (JSON has no bigint
 * type, so `format: int64` is the conventional OpenAPI carrier); `bytes` is an
 * `ArrayBuffer`, surfaced as base64 per JSON Schema 2020-12 content encoding.
 *
 * A `.check()`/`.meta()` JSON Schema fragment (when the reader exposes one) is
 * shallow-merged onto the node — constraint keys win on conflict. A `.nullable()`
 * node widens to also accept `null`; constraints describe the underlying value,
 * so they ride inside the non-null branch rather than on the wrapping `anyOf`.
 */
const jsonSchemaFromNode = <TNode>(node: TNode, reader: SchemaNodeReader<TNode>): JsonSchema => {
    const base = ((): JsonSchema => {
        switch (reader.kind(node)) {
            case "any": {
                // An empty schema validates anything.
                return {};
            }
            case "array": {
                const inner = reader.inner(node);

                return { items: inner === undefined ? {} : jsonSchemaFromNode(inner, reader), type: "array" };
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
            case "geoPoint": {
                return {
                    description: "geographic point (WGS84 decimal degrees)",
                    properties: { lat: { maximum: 90, minimum: -90, type: "number" }, lng: { maximum: 180, minimum: -180, type: "number" } },
                    required: ["lat", "lng"],
                    type: "object",
                };
            }
            case "id": {
                return { description: `Id<"${String(reader.tableName(node))}">`, type: "string", "x-lunora-table": reader.tableName(node) };
            }
            case "literal": {
                return reader.literalSchema(node);
            }
            case "null": {
                return { type: "null" };
            }
            case "number": {
                return { type: "number" };
            }
            case "object": {
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- objectSchemaFromNodes is mutually recursive with this mapper
                return objectSchemaFromNodes(reader.shape(node), reader);
            }
            case "optional": {
                // Optionality is expressed in the parent's `required` list; a standalone
                // optional just unwraps to its inner schema.
                const inner = reader.inner(node);

                return inner === undefined ? {} : jsonSchemaFromNode(inner, reader);
            }
            case "record": {
                const value = reader.valueChild(node);

                return { additionalProperties: value === undefined ? {} : jsonSchemaFromNode(value, reader), type: "object" };
            }
            case "storage": {
                return { description: "storage object key", type: "string", "x-lunora-storage": true };
            }
            case "string": {
                return { type: "string" };
            }
            case "timestamp": {
                return { description: "epoch milliseconds (timestamp)", type: "integer" };
            }
            case "union": {
                return { anyOf: reader.members(node).map((member) => jsonSchemaFromNode(member, reader)) };
            }
            default: {
                return {};
            }
        }
    })();

    const constraints = reader.constraints(node);
    const withConstraints = constraints === undefined ? base : { ...base, ...constraints };

    if (reader.isNullable(node)) {
        return { anyOf: [withConstraints, { type: "null" }] };
    }

    return withConstraints;
};

/**
 * Build `{ type: "object", properties, required, additionalProperties: false }`
 * from a node shape. A `v.optional(...)` property is the only thing that drops
 * out of `required`; every other property is required.
 */
const objectSchemaFromNodes = <TNode>(shape: Record<string, TNode>, reader: SchemaNodeReader<TNode>): JsonSchema => {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, child] of Object.entries(shape)) {
        properties[key] = jsonSchemaFromNode(child, reader);

        if (reader.kind(child) !== "optional") {
            required.push(key);
        }
    }

    return { additionalProperties: false, properties, required, type: "object" };
};

export type { JsonSchema, SchemaNodeReader };
export { jsonSchemaFromNode, objectSchemaFromNodes };
