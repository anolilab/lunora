import { describe, expect, it } from "vitest";

import { encodeIndexKey, encodeIndexValue } from "../src/index-key-codec";

/** Encode, asserting the value was encodable — keeps the ordering tests readable. */
const enc = (value: unknown): string => {
    const encoded = encodeIndexValue(value);

    if (encoded === undefined) {
        throw new Error(`expected ${String(value)} to be encodable`);
    }

    return encoded;
};

/**
 * Does `a` sort before `b` under the plain lexicographic `&lt;` the invalidation
 * layer uses? Expressed as a named predicate because `toBeLessThan` is typed
 * for numbers only — these are encoded strings.
 */
const sortsBefore = (a: unknown, b: unknown): boolean => enc(a) < enc(b);

/** Do the raw (unencoded) strings sort in this order under JS `&lt;`? */
const rawSortsBefore = (a: string, b: string): boolean => a < b;

/** Sort a copy with plain lexicographic `&lt;`, the comparison the codec must make correct. */
const lexSorted = (values: unknown[]): unknown[] => values.toSorted((a, b) => (enc(a) < enc(b) ? -1 : 1));

describe("encodeIndexValue", () => {
    it("orders storage classes null < number < string, matching SQLite", () => {
        expect.assertions(2);

        expect(sortsBefore(null, -1e300)).toBe(true);
        expect(sortsBefore(9.99e300, "")).toBe(true);
    });

    it("preserves numeric order across sign, magnitude, and fractions", () => {
        expect.assertions(1);

        const values = [0, -1, 1, -0.5, 0.5, 1e300, -1e300, 42, -42, 2 ** 53, -(2 ** 53)];

        expect(lexSorted(values)).toStrictEqual([-1e300, -(2 ** 53), -42, -1, -0.5, 0, 0.5, 1, 42, 2 ** 53, 1e300]);
    });

    it("normalizes -0 and +0 to the same key (SQL compares them equal)", () => {
        expect.assertions(1);

        expect(enc(-0)).toBe(enc(0));
    });

    it("orders strings by UTF-8 bytes, not UTF-16 code units", () => {
        expect.assertions(2);

        // U+FF3A (fullwidth Z) vs U+1D400 (astral). UTF-16 code-unit order puts
        // the astral char FIRST (its high surrogate 0xD835 < 0xFF3A), while
        // UTF-8 byte order puts it LAST (0xF0… > 0xEF…). SQLite's BINARY
        // collation uses UTF-8, so the codec must agree with UTF-8.
        const fullwidth = "Ｚ";
        const astral = "\u{1D400}";

        expect(rawSortsBefore(astral, fullwidth)).toBe(true);
        expect(sortsBefore(fullwidth, astral)).toBe(true);
    });

    it("orders ASCII strings conventionally and treats a prefix as smaller", () => {
        expect.assertions(1);

        expect(lexSorted(["b", "", "ab", "a", "aa", "B"])).toStrictEqual(["", "B", "a", "aa", "ab", "b"]);
    });

    it("refuses values with no faithful ordering", () => {
        expect.assertions(5);

        expect(encodeIndexValue(undefined)).toBeUndefined();
        expect(encodeIndexValue(Number.NaN)).toBeUndefined();
        expect(encodeIndexValue(Number.POSITIVE_INFINITY)).toBeUndefined();
        expect(encodeIndexValue(Number.NEGATIVE_INFINITY)).toBeUndefined();
        // Objects never reach the codec (serializeSqlValue stringifies them
        // first); an unserialized one must refuse rather than guess.
        expect(encodeIndexValue({ a: 1 })).toBeUndefined();
    });
});

describe("encodeIndexKey", () => {
    it("orders compound keys component-by-component", () => {
        expect.assertions(2);

        const ab = encodeIndexKey([1, "b"]) ?? "";
        const ac = encodeIndexKey([1, "c"]) ?? "";
        const ba = encodeIndexKey([2, "a"]) ?? "";

        expect(rawSortsBefore(ab, ac)).toBe(true);
        expect(rawSortsBefore(ac, ba)).toBe(true);
    });

    it("sorts a shorter key below any key extending it", () => {
        expect.assertions(1);

        // The separator must sort below every emitted character, so that a
        // prefix range over (a) contains every (a, b) row.
        const prefix = encodeIndexKey([1]) ?? "";
        const extended = encodeIndexKey([1, "anything"]) ?? "";

        expect(rawSortsBefore(prefix, extended)).toBe(true);
    });

    it("refuses the whole key when any component is unencodable", () => {
        expect.assertions(2);

        expect(encodeIndexKey([1, Number.NaN])).toBeUndefined();
        expect(encodeIndexKey([undefined, "a"])).toBeUndefined();
    });

    it("encodes the empty key as the empty string (a full-index range)", () => {
        expect.assertions(1);

        expect(encodeIndexKey([])).toBe("");
    });
});
