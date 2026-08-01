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

    it("from: round-trips an object without turning a numeric string into a number", () => {
        expect.assertions(4);

        // `v.from(externalSchema)` is heterogeneous — the schema may describe an
        // object OR a scalar — and `sqliteEncode` keys off the runtime JS type.
        // So `from` rides the union/any rule, not object/array/record: parsing
        // unconditionally would read a `v.from(z.string())` column holding "123"
        // back as the number 123, and the generated type promises a string.
        expect(sqliteDecode(sqliteEncode({ command: "run" }), "from")).toEqual({ command: "run" });
        expect(sqliteDecode(sqliteEncode(["a"]), "from")).toEqual(["a"]);
        expect(sqliteDecode(sqliteEncode("123"), "from")).toBe("123");
        expect(sqliteDecode(sqliteEncode("plain"), "from")).toBe("plain");
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

    describe("bytes (plan 265)", () => {
        // `v.bytes()` validates `value instanceof ArrayBuffer` — a BLOB read back
        // as any other view (node:sqlite `Uint8Array`, pg/mysql2 `Buffer`) fails
        // re-validation without this branch. Pre-fix: `sqliteDecode` had no
        // `"bytes"` case, so the switch's `default` returned the view unconverted.
        it("passes a genuine ArrayBuffer through unchanged", () => {
            expect.assertions(1);

            const { buffer } = new Uint8Array([1, 2, 3, 4]);

            expect(sqliteDecode(buffer, "bytes")).toBe(buffer);
        });

        it("converts a Uint8Array view to an ArrayBuffer with the same bytes", () => {
            expect.assertions(2);

            const view = new Uint8Array([9, 8, 7, 6]);
            const decoded = sqliteDecode(view, "bytes");

            expect(decoded).toBeInstanceOf(ArrayBuffer);
            expect(new Uint8Array(decoded as ArrayBuffer)).toStrictEqual(new Uint8Array([9, 8, 7, 6]));
        });

        it("slices to the view's own window — a Buffer-pool view does not leak neighboring bytes", () => {
            expect.assertions(3);

            // A single larger backing pool, with a 4-byte view starting at offset 8 —
            // mirrors how Node's Buffer allocator shares one backing ArrayBuffer
            // across several small Buffers.
            const pool = new ArrayBuffer(16);
            const poolBytes = new Uint8Array(pool);

            poolBytes.set([255, 255, 255, 255, 255, 255, 255, 255, 11, 22, 33, 44, 255, 255, 255, 255]);

            const view = new Uint8Array(pool, 8, 4);
            const decoded = sqliteDecode(view, "bytes");

            // Pre-fix (no "bytes" case): `decoded` is the original view object
            // itself, not a genuine ArrayBuffer — this is the assertion that
            // actually distinguishes pre-fix from post-fix; byteLength/contents
            // alone happen to already match since the view was already windowed.
            expect(decoded).toBeInstanceOf(ArrayBuffer);
            expect((decoded as ArrayBuffer).byteLength).toBe(4);
            expect(new Uint8Array(decoded as ArrayBuffer)).toStrictEqual(new Uint8Array([11, 22, 33, 44]));
        });

        it("null stays null", () => {
            expect.assertions(1);

            expect(sqliteDecode(null, "bytes")).toBeNull();
        });
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

    it('unwraps v.optional(v.bytes()) to "bytes" (plan 265)', () => {
        expect.assertions(1);

        expect(effectiveColumnKind(validator("optional", validator("bytes")))).toBe("bytes");
    });
});
