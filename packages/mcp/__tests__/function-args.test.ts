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

    it("rejects an int64 string the wire codec cannot carry, as a bad request rather than an internal error", () => {
        expect.assertions(2);

        const oversized = "1".repeat(1025);

        expect(() => coerceArgs(schemaOf({ amount: INT64 }), { amount: oversized })).toThrow(LunoraError);
        expect(() => coerceArgs(schemaOf({ amount: INT64 }), { amount: oversized })).toThrow('"args.amount" must be a decimal integer string');
    });

    it("still accepts an int64 string at the wire codec's digit limit", () => {
        expect.assertions(1);

        const largest = coerceArgs(schemaOf({ amount: INT64 }), { amount: "1".repeat(1024) }) as { amount: bigint };

        expect(largest.amount).toBe(BigInt("1".repeat(1024)));
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

    it("decodes a union or nullable argument through the one branch whose JSON type fits the value", () => {
        expect.assertions(3);

        const schema = schemaOf({
            either: { anyOf: [INT64, { type: "number" }] },
            maybe: { anyOf: [INT64, { type: "null" }] },
        });

        expect(coerceArgs(schema, { either: "7", maybe: "8" })).toEqual({ either: 7n, maybe: 8n });
        expect(coerceArgs(schema, { either: 7, maybe: null })).toEqual({ either: 7, maybe: null });
        expect(coerceArgs(schema, { either: "7", extra: "kept", maybe: null })).toEqual({ either: 7n, extra: "kept", maybe: null });
    });

    it("sends a value that fits several branches as it is, because choosing one would guess", () => {
        expect.assertions(1);

        const schema = schemaOf({ either: { anyOf: [INT64, { type: "string" }] } });

        expect(coerceArgs(schema, { either: "7" })).toEqual({ either: "7" });
    });

    it("decodes the values of a record through its additionalProperties schema", () => {
        expect.assertions(1);

        const schema = schemaOf({ totals: { additionalProperties: INT64, type: "object" } });

        expect(coerceArgs(schema, { totals: { a: "1", b: "2" } })).toEqual({ totals: { a: 1n, b: 2n } });
    });

    it("narrows a union of bigint literals by const, so the matching literal is decoded", () => {
        expect.assertions(1);

        const literal = (value: string): Record<string, unknown> => {
            return { ...INT64, const: value };
        };
        const schema = schemaOf({ pick: { anyOf: [literal("5"), literal("7")] } });

        expect(coerceArgs(schema, { pick: "7" })).toEqual({ pick: 7n });
    });

    it("narrows a discriminated object union by its const discriminator, then decodes that branch's bigint", () => {
        expect.assertions(1);

        const variant = (kind: string): Record<string, unknown> => schemaOf({ amount: INT64, kind: { const: kind, type: "string" } });
        const schema = schemaOf({ event: { anyOf: [variant("credit"), variant("debit")] } });

        expect(coerceArgs(schema, { event: { amount: "9", kind: "debit" } })).toEqual({ event: { amount: 9n, kind: "debit" } });
    });

    it("decodes a decimal and a base64 string through a bigint-or-bytes union, each by the carrier it is in", () => {
        expect.assertions(2);

        const schema = schemaOf({ value: { anyOf: [INT64, BYTES] } });
        const { value: decimal } = coerceArgs(schema, { value: "42" }) as { value: unknown };
        const { value: bytes } = coerceArgs(schema, { value: "AQID" }) as { value: ArrayBuffer };

        expect(decimal).toBe(42n);
        expect([...new Uint8Array(bytes)]).toEqual([1, 2, 3]);
    });

    it("sends a string that is both a decimal and a canonical base64 carrier as it is, because it still fits two branches", () => {
        expect.assertions(1);

        const schema = schemaOf({ value: { anyOf: [INT64, BYTES] } });

        expect(coerceArgs(schema, { value: "12345678" })).toEqual({ value: "12345678" });
    });

    it("leaves a number as sent, since the schema already describes it as a number", () => {
        expect.assertions(1);

        expect(coerceArgs(schemaOf({ count: { type: "integer" } }), { count: 3 })).toEqual({ count: 3 });
    });
});
