import { describe, expect, it } from "vitest";

import { argumentsTemplate, formatSignature } from "../src/function-signature.js";
import type { FunctionArgumentDescriptor } from "../src/types.js";

const ARGS: FunctionArgumentDescriptor[] = [
    { kind: "id", name: "channelId", optional: false, table: "channels" },
    { kind: "string", name: "text", optional: false },
    { kind: "number", name: "limit", optional: true },
    { element: "string", kind: "array", name: "tags", optional: false },
];

const UNKNOWN_ARGS: FunctionArgumentDescriptor[] = [
    { kind: "id", name: "ref", optional: false },
    { kind: "array", name: "xs", optional: false },
];

const NUMERIC_ARGS: FunctionArgumentDescriptor[] = [
    { kind: "number", name: "n", optional: false },
    { kind: "boolean", name: "b", optional: false },
];

const OPTIONAL_ONLY: FunctionArgumentDescriptor[] = [{ kind: "number", name: "limit", optional: true }];

describe("formatSignature", () => {
    it("renders id<table>, arrays, and optional markers", () => {
        expect.assertions(1);

        expect(formatSignature(ARGS)).toBe("(channelId: id<channels>, text: string, limit?: number, tags: string[])");
    });

    it("renders `()` for no arguments", () => {
        expect.assertions(2);

        expect(formatSignature([])).toBe("()");
        expect(formatSignature(undefined)).toBe("()");
    });

    it("falls back to bare kinds when id table / array element are unknown", () => {
        expect.assertions(1);

        expect(formatSignature(UNKNOWN_ARGS)).toBe("(ref: id, xs: array)");
    });
});

describe("argumentsTemplate", () => {
    it("includes only required args, with placeholders by kind", () => {
        expect.assertions(1);

        // `limit` is optional → omitted; arrays → [], strings/ids → "".
        expect(JSON.parse(argumentsTemplate(ARGS))).toStrictEqual({ channelId: "", tags: [], text: "" });
    });

    it("returns `{}` for no required args", () => {
        expect.assertions(2);

        expect(argumentsTemplate(OPTIONAL_ONLY)).toBe("{}");
        expect(argumentsTemplate(undefined)).toBe("{}");
    });

    it("placeholders numbers and booleans by kind", () => {
        expect.assertions(1);

        expect(JSON.parse(argumentsTemplate(NUMERIC_ARGS))).toStrictEqual({ b: false, n: 0 });
    });
});
