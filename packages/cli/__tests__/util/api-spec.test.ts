import { describe, expect, it } from "vitest";

import { API_SPEC_VALUES, parseApiSpec } from "../../src/util/api-spec";

describe("parseApiSpec", () => {
    it("returns undefined for an absent flag (codegen applies its own default)", () => {
        expect.assertions(2);

        expect(parseApiSpec(undefined)).toBeUndefined();
        expect(parseApiSpec("")).toBeUndefined();
    });

    it("accepts every documented spec value", () => {
        expect.assertions(4);

        // The four documented values: both | none | openapi | openrpc.
        expect(API_SPEC_VALUES).toStrictEqual(["both", "none", "openapi", "openrpc"]);
        expect(parseApiSpec("openapi")).toBe("openapi");
        expect(parseApiSpec("openrpc")).toBe("openrpc");
        expect(parseApiSpec("none")).toBe("none");
    });

    it("throws on an unrecognized value", () => {
        expect.assertions(1);

        expect(() => parseApiSpec("swagger")).toThrow(/invalid --api-spec/u);
    });
});
