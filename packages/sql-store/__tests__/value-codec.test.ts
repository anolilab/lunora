import type { ValidatorLike } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { decodeBigint, effectiveColumnKind, sqliteDecode, sqliteEncode, tryJsonParse } from "../src/value-codec";

describe("nested wire-typed values", () => {
    it("round-trips a bigint and bytes nested inside a composite column", () => {
        expect.assertions(2);

        // A bare `JSON.stringify` threw an untyped `TypeError` on a nested bigint
        // (surfacing as an opaque 500) and flattened nested bytes to `{}` — data
        // destroyed with no error at all. The shard twin round-trips both.
        const withBigint = sqliteEncode({ n: 1n });

        expect(sqliteDecode(withBigint, "object")).toStrictEqual({ n: 1n });

        const bytes = new Uint8Array([1, 2, 3]).buffer;
        const decoded = sqliteDecode(sqliteEncode({ b: bytes }), "object") as { b: ArrayBuffer };

        expect(new Uint8Array(decoded.b)).toStrictEqual(new Uint8Array([1, 2, 3]));
    });

    it("stores an ordinary composite byte-identically to plain JSON", () => {
        expect.assertions(1);

        // `encodeWire` is identity for pure JSON, so existing rows keep their
        // stored form and still read back unchanged.
        expect(sqliteEncode({ a: 1, b: [true, "x"], c: null })).toBe(JSON.stringify({ a: 1, b: [true, "x"], c: null }));
    });

    it.each(["array", "object", "record", "any", "union"])("returns a legacy %s row that looks wire-encoded unchanged", (kind) => {
        expect.assertions(1);

        // Legitimate app data that happens to be shaped like a wire payload, and
        // written before this path existed — so it never passed through
        // `encodeWire`'s `"arr"` escape. Sniffing the content for the tag decodes
        // it as `42n`, and the next patch/replace persists that corruption. Only
        // the explicit prefix that `sqliteEncode` writes marks a wire value.
        const legacy = ["$lunora.wire$", "bigint", "42"];

        expect(sqliteDecode(JSON.stringify(legacy), kind)).toStrictEqual(legacy);
    });

    it("still round-trips that same array when it is written through the encoder", () => {
        expect.assertions(2);

        // The escape hatch has to keep working: written through `sqliteEncode` the
        // array is escaped, marked, and must come back as itself — not as `42n`.
        const hostile = ["$lunora.wire$", "bigint", "42"];
        const stored = sqliteEncode(hostile) as string;

        expect(stored.startsWith("$lunora.wire$")).toBe(true);
        expect(sqliteDecode(stored, "array")).toStrictEqual(hostile);
    });

    it("marks a genuinely wire-encoded value and leaves ordinary JSON unmarked", () => {
        expect.assertions(2);

        expect(sqliteEncode({ n: 1n }) as string).toMatch(/^\$lunora\.wire\$/);
        expect(sqliteEncode({ n: 1 }) as string).not.toMatch(/^\$lunora\.wire\$/);
    });
});

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

    it("encodes bigints as a fixed-width, order-preserving text key", () => {
        expect.assertions(3);

        // Sign character + 39 digits of magnitude. Exact past 2^53, where
        // `Number()` would collapse neighbouring values onto one double.
        expect(sqliteEncode(9_007_199_254_740_993n)).toBe(`1${"9007199254740993".padStart(39, "0")}`);
        expect(sqliteEncode(0n)).toBe(`1${"0".repeat(39)}`);
        // Negatives: nines' complement under the lower sign character.
        expect(sqliteEncode(-5n)).toBe(`0${"9".repeat(38)}4`);
    });

    /**
     * The defect this encoding exists for. Plain decimal text is exact for `=`
     * but sorts `"9"` after `"10"`, so a range filter, an `ORDER BY`, a page
     * cursor and `MIN`/`MAX` over a `v.bigint()` column all returned the wrong
     * rows — `where: { n: { gt: 9n } }` matched nothing while `10n` and `100n`
     * sat in the table. Byte order over the encoded keys has to BE numeric order.
     */
    it("sorts lexicographically in numeric order, across zero", () => {
        expect.assertions(1);

        const values = [2n, 9n, 10n, 100n, -5n, -200n, 0n, 9_007_199_254_740_993n, -9_007_199_254_740_993n];
        const byKey = values.toSorted((a, b) => String(sqliteEncode(a)).localeCompare(String(sqliteEncode(b))));
        const numerically = values.toSorted((a, b) => Number(a - b));

        expect(byKey).toStrictEqual(numerically);
    });

    it("refuses a magnitude past the fixed key width rather than mis-sorting it", () => {
        expect.assertions(1);

        expect(() => sqliteEncode(10n ** 39n)).toThrow(/over the 39-digit limit/u);
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

    it("geoPoint: JSON string → the { lat, lng } object", () => {
        expect.assertions(2);

        // `sqliteEncode` stores the point as JSON in a TEXT column. Without a
        // `geoPoint` case the decode fell through to `default:` and every client
        // read the raw JSON text back — `doc.at.lat` was `undefined`.
        const at = { lat: 52.52, lng: 13.405 };

        expect(sqliteEncode(at)).toBe('{"lat":52.52,"lng":13.405}');
        expect(sqliteDecode(sqliteEncode(at), "geoPoint")).toEqual(at);
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

        it("returns a genuine ArrayBuffer for a SharedArrayBuffer-backed view", () => {
            expect.assertions(3);

            // `.slice()` on a BUFFER preserves its species, so slicing the backing
            // store of a shared-memory view hands back a SharedArrayBuffer — which
            // fails `v.bytes()`'s `instanceof ArrayBuffer` check just as the raw view
            // would. Copying through an owned Uint8Array is what forces a real
            // ArrayBuffer regardless of the backing store.
            const shared = new SharedArrayBuffer(8);

            new Uint8Array(shared).set([255, 255, 5, 6, 7, 8, 255, 255]);

            const decoded = sqliteDecode(new Uint8Array(shared, 2, 4), "bytes");

            expect(decoded).toBeInstanceOf(ArrayBuffer);
            expect((decoded as ArrayBuffer).byteLength).toBe(4);
            expect(new Uint8Array(decoded as ArrayBuffer)).toStrictEqual(new Uint8Array([5, 6, 7, 8]));
        });

        it("null stays null", () => {
            expect.assertions(1);

            expect(sqliteDecode(null, "bytes")).toBeNull();
        });
    });
});

describe("decodeBigint / tryJsonParse edge cases", () => {
    /**
     * A column written before the key encoding holds plain decimal text. It is
     * never 40 characters with a `"0"`/`"1"` sign character (`toString()` emits
     * no leading zero), so the key test cannot claim it and it decodes through
     * the `BigInt(raw)` fallback — reads keep working on an unconverted row.
     */
    it("decodeBigint still reads a decimal string written before the key encoding", () => {
        expect.assertions(3);

        expect(decodeBigint("10")).toBe(10n);
        expect(decodeBigint("-5")).toBe(-5n);
        expect(decodeBigint("9007199254740993")).toBe(9_007_199_254_740_993n);
    });

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
