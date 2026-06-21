import { describe, expect, it } from "vitest";

import type { JsonSchema, SchemaNodeReader } from "../src/json-schema-core";
import { jsonSchemaFromNode, objectSchemaFromNodes } from "../src/json-schema-core";
import { argsToJsonSchema, toJsonSchema } from "../src/to-json-schema";
import type { Validator, ValidatorKind } from "../src/v";
import { v } from "../src/v";

describe("toJsonSchema", () => {
    describe("scalars", () => {
        it("maps the primitive kinds", () => {
            expect.assertions(4);

            expect(toJsonSchema(v.string())).toStrictEqual({ type: "string" });
            expect(toJsonSchema(v.number())).toStrictEqual({ type: "number" });
            expect(toJsonSchema(v.boolean())).toStrictEqual({ type: "boolean" });
            expect(toJsonSchema(v.null())).toStrictEqual({ type: "null" });
        });

        it("carries bigint as an int64 integer", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.bigint())).toStrictEqual({ format: "int64", type: "integer" });
        });

        it("schemas date and timestamp as epoch-millisecond integers", () => {
            expect.assertions(2);

            expect(toJsonSchema(v.date())).toStrictEqual({ description: "epoch milliseconds (date)", type: "integer" });
            expect(toJsonSchema(v.timestamp())).toStrictEqual({ description: "epoch milliseconds (timestamp)", type: "integer" });
        });

        it("schemas bytes as base64-encoded string", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.bytes())).toStrictEqual({ contentEncoding: "base64", description: "binary (ArrayBuffer)", type: "string" });
        });

        it("represents any as the empty (anything) schema", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.any())).toStrictEqual({});
        });
    });

    describe("id and literal", () => {
        it("annotates an id with its target table", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.id("users"))).toStrictEqual({ description: 'Id<"users">', type: "string", "x-lunora-table": "users" });
        });

        it("emits a const for a literal", () => {
            expect.assertions(2);

            expect(toJsonSchema(v.literal("admin"))).toStrictEqual({ const: "admin" });
            expect(toJsonSchema(v.literal(42))).toStrictEqual({ const: 42 });
        });

        it("marks a storage key as a string with the lunora-storage extension", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.storage())).toStrictEqual({ description: "storage object key", type: "string", "x-lunora-storage": true });
        });
    });

    describe("composites", () => {
        it("maps an array to items", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.array(v.string()))).toStrictEqual({ items: { type: "string" }, type: "array" });
        });

        it("maps a record to additionalProperties", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.record(v.string(), v.number()))).toStrictEqual({ additionalProperties: { type: "number" }, type: "object" });
        });

        it("maps a union to anyOf", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.union(v.string(), v.number()))).toStrictEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
        });

        it("expands a nested object, listing only non-optional keys as required", () => {
            expect.assertions(1);

            const schema = toJsonSchema(
                v.object({
                    age: v.optional(v.number()),
                    name: v.string(),
                    tags: v.array(v.string()),
                }),
            );

            expect(schema).toStrictEqual({
                additionalProperties: false,
                properties: {
                    age: { type: "number" },
                    name: { type: "string" },
                    tags: { items: { type: "string" }, type: "array" },
                },
                required: ["name", "tags"],
                type: "object",
            });
        });

        it("recurses through deeply nested shapes", () => {
            expect.assertions(1);

            const schema = toJsonSchema(v.object({ author: v.object({ id: v.id("users") }) }));

            expect(schema).toStrictEqual({
                additionalProperties: false,
                properties: {
                    author: {
                        additionalProperties: false,
                        properties: { id: { description: 'Id<"users">', type: "string", "x-lunora-table": "users" } },
                        required: ["id"],
                        type: "object",
                    },
                },
                required: ["author"],
                type: "object",
            });
        });
    });

    describe("nullable", () => {
        it("widens a nullable validator to also accept null", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.string().nullable())).toStrictEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
        });
    });

    describe("constraint-carrying .check()/.meta()", () => {
        it("merges a .check() schema fragment onto the node", () => {
            expect.assertions(1);

            const schema = toJsonSchema(v.string().check((s) => s.length > 0, { message: "non-empty", schema: { minLength: 1 } }));

            expect(schema).toStrictEqual({ minLength: 1, type: "string" });
        });

        it("ignores a predicate-only .check() (stays opaque)", () => {
            expect.assertions(1);

            expect(toJsonSchema(v.string().check((s) => s.length > 0, "non-empty"))).toStrictEqual({ type: "string" });
        });

        it("composes multiple .check() fragments, later keys winning on conflict", () => {
            expect.assertions(1);

            const schema = toJsonSchema(
                v
                    .number()
                    .check((n) => n >= 0, { schema: { minimum: 0 } })
                    .check((n) => n <= 100, { schema: { maximum: 100, minimum: 1 } }),
            );

            expect(schema).toStrictEqual({ maximum: 100, minimum: 1, type: "number" });
        });

        it("reflects .meta() description and schema", () => {
            expect.assertions(1);

            const schema = toJsonSchema(v.string().meta({ description: "a slug", schema: { pattern: "^[a-z]+$" } }));

            expect(schema).toStrictEqual({ description: "a slug", pattern: "^[a-z]+$", type: "string" });
        });

        it("rides inside the non-null branch when combined with .nullable()", () => {
            expect.assertions(1);

            const schema = toJsonSchema(
                v
                    .string()
                    .check((s) => s.length > 0, { schema: { minLength: 1 } })
                    .nullable(),
            );

            expect(schema).toStrictEqual({ anyOf: [{ minLength: 1, type: "string" }, { type: "null" }] });
        });
    });
});

describe("argsToJsonSchema", () => {
    it("treats non-optional args as required and optional ones as not", () => {
        expect.assertions(1);

        const schema = argsToJsonSchema({
            cursor: v.optional(v.string()),
            limit: v.number(),
            room: v.id("rooms"),
        });

        expect(schema).toStrictEqual({
            additionalProperties: false,
            properties: {
                cursor: { type: "string" },
                limit: { type: "number" },
                room: { description: 'Id<"rooms">', type: "string", "x-lunora-table": "rooms" },
            },
            required: ["limit", "room"],
            type: "object",
        });
    });

    it("yields an empty object schema for a no-arg function", () => {
        expect.assertions(1);

        expect(argsToJsonSchema({})).toStrictEqual({ additionalProperties: false, properties: {}, required: [], type: "object" });
    });
});

describe("literal const carrier", () => {
    it("carries a bigint literal as its decimal string with type string", () => {
        expect.assertions(1);

        // The `typeof value === "bigint"` branch of validatorReader.literalSchema —
        // JSON Schema `const` must be JSON-serializable, so a bigint is stringified.
        expect(toJsonSchema(v.literal(9_007_199_254_740_993n))).toStrictEqual({ const: "9007199254740993", type: "string" });
    });
});

describe("metaOf fallback", () => {
    it("treats a validator with no _meta bag as an empty (anything) schema", () => {
        expect.assertions(1);

        // The `introspect(validator)._meta ?? {}` fallback: a hand-rolled
        // validator-shaped node carrying only a `kind` and no `_meta`.
        const metaless = { kind: "any" } as unknown as Validator;

        expect(toJsonSchema(metaless)).toStrictEqual({});
    });
});

describe("jsonSchemaFromNode over an IR-style reader", () => {
    // A minimal reader that mimics the codegen IR side: composite children may be
    // absent (`inner`/`valueChild` return undefined), exercising the branches the
    // runtime validatorReader (which always populates _meta) can never reach.
    const makeReader = (): SchemaNodeReader<{ kind: ValidatorKind }> => {
        return {
            constraints: () => undefined,
            inner: () => undefined,
            isNullable: () => false,
            kind: (node) => node.kind,
            literalSchema: () => {
                return { const: undefined };
            },
            members: () => [],
            shape: () => {
                return {};
            },
            tableName: () => undefined,
            valueChild: () => undefined,
        };
    };

    it("maps an array node with an absent inner child to an empty-items schema", () => {
        expect.assertions(1);

        const node: { kind: ValidatorKind } = { kind: "array" };

        expect(jsonSchemaFromNode(node, makeReader())).toStrictEqual({ items: {}, type: "array" });
    });

    it("maps an optional node with an absent inner child to an empty schema", () => {
        expect.assertions(1);

        const node: { kind: ValidatorKind } = { kind: "optional" };

        expect(jsonSchemaFromNode(node, makeReader())).toStrictEqual({});
    });

    it("maps a record node with an absent value child to open additionalProperties", () => {
        expect.assertions(1);

        const node: { kind: ValidatorKind } = { kind: "record" };

        expect(jsonSchemaFromNode(node, makeReader())).toStrictEqual({ additionalProperties: {}, type: "object" });
    });

    it("falls back to the empty schema for an unknown kind (default case)", () => {
        expect.assertions(1);

        // An out-of-band kind exercises the switch `default:` guard.
        const reader = makeReader();
        const node: { kind: ValidatorKind } = { kind: "totally-unknown" as ValidatorKind };

        expect(jsonSchemaFromNode<{ kind: ValidatorKind }>(node, reader)).toStrictEqual({});
    });

    it("objectSchemaFromNodes lists every non-optional key as required", () => {
        expect.assertions(1);

        const reader: SchemaNodeReader<{ kind: ValidatorKind }> = makeReader();
        const shape: Record<string, { kind: ValidatorKind }> = { flag: { kind: "boolean" }, maybe: { kind: "optional" } };
        const schema: JsonSchema = objectSchemaFromNodes(shape, reader);

        expect(schema).toStrictEqual({
            additionalProperties: false,
            properties: { flag: { type: "boolean" }, maybe: {} },
            required: ["flag"],
            type: "object",
        });
    });
});
