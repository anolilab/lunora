import type { ValidatorLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { decodeBigint, effectiveColumnKind, sqliteDecode, sqliteEncode, tryJsonParse } from "../src/value-codec";

describe("sqliteEncode", () => {
    it("maps booleans to 1/0", () => {
        expect.assertions(2);

        expect(sqliteEncode(true)).toBe(1);
        expect(sqliteEncode(false)).toBe(0);
    });

    it("passes strings, numbers and null through verbatim", () => {
        expect.assertions(3);

        expect(sqliteEncode("hi")).toBe("hi");
        expect(sqliteEncode(42)).toBe(42);
        expect(sqliteEncode(null)).toBeNull();
    });

    it("stringifies bigints as decimal", () => {
        expect.assertions(1);

        expect(sqliteEncode(9_007_199_254_740_993n)).toBe("9007199254740993");
    });

    it("jSON-encodes objects and arrays", () => {
        expect.assertions(2);

        expect(sqliteEncode({ x: 1 })).toBe('{"x":1}');
        expect(sqliteEncode([1, 2])).toBe("[1,2]");
    });
});

describe("sqliteDecode — round-trips with sqliteEncode by kind", () => {
    it("boolean: 1/0 → true/false; other values verbatim", () => {
        expect.assertions(3);

        expect(sqliteDecode(sqliteEncode(true), "boolean")).toBe(true);
        expect(sqliteDecode(sqliteEncode(false), "boolean")).toBe(false);
        expect(sqliteDecode(2, "boolean")).toBe(2);
    });

    it("bigint: decimal string → BigInt", () => {
        expect.assertions(1);

        expect(sqliteDecode(sqliteEncode(123n), "bigint")).toBe(123n);
    });

    it("object/array/record: JSON string → parsed value", () => {
        expect.assertions(2);

        expect(sqliteDecode(sqliteEncode({ x: 1 }), "object")).toEqual({ x: 1 });
        expect(sqliteDecode(sqliteEncode([1, 2]), "array")).toEqual([1, 2]);
    });

    it("union/any: parses JSON non-scalars, leaves plain strings", () => {
        expect.assertions(2);

        expect(sqliteDecode('{"x":1}', "union")).toEqual({ x: 1 });
        expect(sqliteDecode("plain", "any")).toBe("plain");
    });

    it("null is preserved regardless of kind", () => {
        expect.assertions(1);

        expect(sqliteDecode(null, "object")).toBeNull();
    });

    it("string/number/date/id: verbatim", () => {
        expect.assertions(2);

        expect(sqliteDecode("2026-06-20", "date")).toBe("2026-06-20");
        expect(sqliteDecode(7, "number")).toBe(7);
    });
});

describe("decodeBigint / tryJsonParse edge cases", () => {
    it("decodeBigint leaves non-numeric strings and non-strings alone", () => {
        expect.assertions(2);

        expect(decodeBigint("not-a-number")).toBe("not-a-number");
        expect(decodeBigint(5)).toBe(5);
    });

    it("tryJsonParse returns the raw string on invalid JSON", () => {
        expect.assertions(1);

        expect(tryJsonParse("{nope")).toBe("{nope");
    });
});

describe("effectiveColumnKind", () => {
    const validator = (kind: string, inner?: ValidatorLike): ValidatorLike => ({ _meta: inner ? { inner } : {}, kind }) as unknown as ValidatorLike;

    it("returns the validator's own kind when not optional", () => {
        expect.assertions(1);

        expect(effectiveColumnKind(validator("boolean"))).toBe("boolean");
    });

    it("unwraps optional to the inner kind", () => {
        expect.assertions(1);

        expect(effectiveColumnKind(validator("optional", validator("bigint")))).toBe("bigint");
    });

    it("unwraps nested optionals", () => {
        expect.assertions(1);

        expect(effectiveColumnKind(validator("optional", validator("optional", validator("object"))))).toBe("object");
    });
});
