import { describe, expect, it } from "vitest";

import { argsToJsonSchema, toJsonSchema } from "../src/to-json-schema";
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

            expect(toJsonSchema(v.id("users"))).toStrictEqual({ description: 'Id<"users">', type: "string", "x-cirrus-table": "users" });
        });

        it("emits a const for a literal", () => {
            expect.assertions(2);

            expect(toJsonSchema(v.literal("admin"))).toStrictEqual({ const: "admin" });
            expect(toJsonSchema(v.literal(42))).toStrictEqual({ const: 42 });
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
                        properties: { id: { description: 'Id<"users">', type: "string", "x-cirrus-table": "users" } },
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
                room: { description: 'Id<"rooms">', type: "string", "x-cirrus-table": "rooms" },
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
