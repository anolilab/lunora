import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { coerceArgs } from "../src/function-args";

const INT64 = { format: "int64", type: "string" };
const BYTES = { contentEncoding: "base64", description: "binary (ArrayBuffer)", type: "string" };

const schemaOf = (properties: Record<string, unknown>): Record<string, unknown> => {
    return { properties, type: "object" };
};

describe("coerceArgs", () => {
    it("turns an int64 decimal string into a bigint, so a v.bigint() argument validates", () => {
        expect.assertions(1);

        const args = coerceArgs(schemaOf({ amount: INT64 }), { amount: "9007199254740993" });

        expect(args).toEqual({ amount: 9_007_199_254_740_993n });
    });

    it("accepts a negative int64 string", () => {
        expect.assertions(1);

        expect(coerceArgs(schemaOf({ delta: INT64 }), { delta: "-5" })).toEqual({ delta: -5n });
    });

    it("rejects an int64 string that is not a decimal integer", () => {
        expect.assertions(2);

        expect(() => coerceArgs(schemaOf({ amount: INT64 }), { amount: "12.5" })).toThrow(LunoraError);
        expect(() => coerceArgs(schemaOf({ amount: INT64 }), { amount: "0x1f" })).toThrow('"args.amount" must be a decimal integer string');
    });

    it("turns a base64 string into an ArrayBuffer", () => {
        expect.assertions(2);

        const { payload } = coerceArgs(schemaOf({ payload: BYTES }), { payload: "AQID" }) as { payload: ArrayBuffer };

        expect(payload).toBeInstanceOf(ArrayBuffer);
        expect([...new Uint8Array(payload)]).toEqual([1, 2, 3]);
    });

    it("rejects a base64 string that does not decode", () => {
        expect.assertions(1);

        expect(() => coerceArgs(schemaOf({ payload: BYTES }), { payload: "!!!" })).toThrow('"args.payload" must be base64');
    });

    it("walks nested objects and arrays", () => {
        expect.assertions(1);

        const schema = schemaOf({ entries: { items: schemaOf({ amount: INT64 }), type: "array" } });

        expect(coerceArgs(schema, { entries: [{ amount: "1" }, { amount: "2" }] })).toEqual({ entries: [{ amount: 1n }, { amount: 2n }] });
    });

    it("leaves a union branch and an unknown key as sent", () => {
        expect.assertions(1);

        const schema = schemaOf({ either: { anyOf: [INT64, { type: "number" }] }, note: { type: "string" } });

        expect(coerceArgs(schema, { either: "7", extra: "kept", note: "hi" })).toEqual({ either: "7", extra: "kept", note: "hi" });
    });

    it("leaves a number as sent, since the schema already describes it as a number", () => {
        expect.assertions(1);

        expect(coerceArgs(schemaOf({ count: { type: "integer" } }), { count: 3 })).toEqual({ count: 3 });
    });
});
