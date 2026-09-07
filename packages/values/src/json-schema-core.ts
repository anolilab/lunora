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
 * recurses over. Composite accessors (`inner`/`shape`/`members`/`keyChild`/`valueChild`)
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

    /**
     * Key-child of a `record` node, mapped to `propertyNames`. May be absent on
     * the IR side (and on a `v.record(v.string(), …)` whose key validator adds
     * no constraint beyond `type: "string"` it is merely redundant, not wrong).
     */
    keyChild: (node: TNode) => TNode | undefined;

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
 * Each node names the JSON CARRIER, not the decoded JS type — the transport
 * decodes before the parser sees a value, so describing the JS type would
 * advertise shapes no JSON body can hold. `date`/`timestamp` are
 * epoch-millisecond numbers in Lunora (not ISO strings), so they schema as
 * integers; `bigint` rides as an int64 decimal string, the same carrier the
 * wire codec and `v.literal(5n)` use; `bytes` is an `ArrayBuffer`, surfaced as
 * base64 per JSON Schema 2020-12 content encoding.
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
                // A DECIMAL STRING, not a JSON number. `type: "integer"`
                // advertised the one JSON form the parser definitely refuses,
                // and truncated past 2^53 besides.
                //
                // Read this the way `bytes` and `date` above and below are
                // read: it names the PAYLOAD's form, not a body that validates
                // end to end. The actual RPC carrier is the wire codec's tagged
                // array — `["$lunora.wire$", "bigint", "5"]`, decoded by
                // `decodeWire` before the parser sees it — so a bare `"5"` no
                // more satisfies `v.bigint()` than a bare `5` did. `bytes`
                // (`contentEncoding: "base64"`) and `date` (`type: "integer"`)
                // describe their decoded payloads the same way; a schema that
                // described the tagged array instead would have to change all
                // three, and nothing consumes a tuple schema here today.
                //
                // What this buys is the decimal string being the spelling a
                // bigint actually travels as, everywhere it is written down —
                // the tagged payload's third slot, `v.literal(5n)`'s `const`.
                return { format: "int64", type: "string" };
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
                // The key validator is enforced at runtime (`v.record(v.string().pattern(…), …)`
                // rejects a non-matching key), so it belongs in the schema as
                // `propertyNames` — reading only the value child left the spec
                // unable to express a constraint the server requires.
                const key = reader.keyChild(node);

                return {
                    additionalProperties: value === undefined ? {} : jsonSchemaFromNode(value, reader),
                    ...(key === undefined ? {} : { propertyNames: jsonSchemaFromNode(key, reader) }),
                    type: "object",
                };
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
 * True when the parser accepts this node's field ABSENT — the only honest test
 * for whether a key belongs in `required`.
 *
 * `kind === "optional"` used to be the whole test, which put two kinds in
 * `required` that parse `{}` happily: `v.any()` (its parser returns `undefined`
 * unchanged) and a `v.union(...)` with an optional or `any` member (the union
 * tries members, one of which accepts `undefined`). A spec that requires a field
 * the server does not cannot be satisfied by a generated client.
 * @returns `true` when an absent value parses.
 */
const acceptsAbsent = <TNode>(node: TNode, reader: SchemaNodeReader<TNode>): boolean => {
    const kind = reader.kind(node);

    if (kind === "any" || kind === "optional") {
        return true;
    }

    return kind === "union" && reader.members(node).some((member) => acceptsAbsent(member, reader));
};

/**
 * Build `{ type: "object", properties, required }` from a node shape.
 *
 * Deliberately NOT `additionalProperties: false`: `v.object` STRIPS an
 * undeclared key rather than refusing it (only `.output()`'s
 * `rejectUnknownKeys` mode refuses one, and it is not what this schema
 * describes), so closing the object had a spec-validating client reject bodies
 * the server accepts. Absent means allowed, which is what the parser does.
 *
 * `required` lists every key whose field cannot be absent — see
 * {@link acceptsAbsent}.
 */
const objectSchemaFromNodes = <TNode>(shape: Record<string, TNode>, reader: SchemaNodeReader<TNode>): JsonSchema => {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const [key, child] of Object.entries(shape)) {
        properties[key] = jsonSchemaFromNode(child, reader);

        if (!acceptsAbsent(child, reader)) {
            required.push(key);
        }
    }

    return { properties, required, type: "object" };
};

export type { JsonSchema, SchemaNodeReader };
export { jsonSchemaFromNode, objectSchemaFromNodes };
