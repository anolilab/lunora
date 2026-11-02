import { asSchema, jsonSchema as sdkJsonSchema } from "@ai-sdk/provider-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import jsonSchema from "../src/json-schema";

/** Every module that builds a tool schema, and so used to import the SDK's root (and zod) at module scope. */
const SCHEMA_MODULES = [
    "../src/agentic-memory",
    "../src/as-tool",
    "../src/code-tool",
    "../src/generate",
    "../src/js-code-tool",
    "../src/mcp",
    "../src/sandbox",
    "../src/secret-request-tool",
    "../src/web-search-tool",
];

describe(jsonSchema, () => {
    afterEach(() => {
        vi.doUnmock("@ai-sdk/provider-utils");
        vi.resetModules();
    });

    it("builds the schema object the SDK itself builds", () => {
        expect.assertions(6);

        const definition = { properties: { id: { type: "string" as const } }, required: ["id"], type: "object" as const };
        const validate = () => {
            return { success: true as const, value: { id: "a" } };
        };
        const ours = jsonSchema(definition, { validate });
        const theirs = sdkJsonSchema(definition, { validate });

        expect(new Set(Reflect.ownKeys(ours).map(String))).toStrictEqual(new Set(Reflect.ownKeys(theirs).map(String)));
        expect(ours.jsonSchema).toStrictEqual(definition);
        expect(ours.validate).toBe(validate);
        // The SDK accepts it as a ready-made schema rather than wrapping it as a standard one.
        expect(asSchema(ours)).toBe(ours);
        expect(Object.getOwnPropertySymbols(ours)).toStrictEqual(Object.getOwnPropertySymbols(theirs));
        expect(jsonSchema({ type: "object" }).validate).toBeUndefined();
    });

    it("resolves a function schema once, on first read", () => {
        expect.assertions(4);

        const create = vi.fn<() => { type: "object" }>(() => {
            return { type: "object" };
        });
        const schema = jsonSchema(create);

        expect(create).not.toHaveBeenCalled();
        expect(schema.jsonSchema).toStrictEqual({ type: "object" });
        expect(schema.jsonSchema).toStrictEqual({ type: "object" });
        expect(create).toHaveBeenCalledTimes(1);
    });

    it.each(SCHEMA_MODULES)("%s loads without evaluating @ai-sdk/provider-utils", async (path) => {
        expect.assertions(1);

        vi.doMock(import("@ai-sdk/provider-utils"), () => {
            throw new Error("@ai-sdk/provider-utils was evaluated at module scope");
        });
        vi.resetModules();

        await expect(import(path)).resolves.toBeDefined();
    });
});
