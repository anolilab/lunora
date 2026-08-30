import { describe, expect, it } from "vitest";

import { assertLimit, isSql, joinSql, lit, raw, Sql, sql, tableRef, toText } from "../../src/r2sql/sql";

describe("lit", () => {
    it("renders null and undefined as NULL", () => {
        expect.assertions(2);

        expect(lit(null)).toBe("NULL");
        expect(lit(undefined)).toBe("NULL");
    });

    it("renders booleans, numbers, and bigints", () => {
        expect.assertions(5);

        expect(lit(true)).toBe("true");
        expect(lit(false)).toBe("false");
        expect(lit(42)).toBe("42");
        expect(lit(-3.14)).toBe("-3.14");
        expect(lit(10n)).toBe("10");
    });

    it("single-quotes strings and doubles embedded quotes", () => {
        expect.assertions(2);

        expect(lit("hello")).toBe("'hello'");
        expect(lit("O'Brien")).toBe("'O''Brien'");
    });

    it("neutralises an injection attempt by escaping it into one literal", () => {
        expect.assertions(1);

        expect(lit("North'; DROP TABLE x; --")).toBe("'North''; DROP TABLE x; --'");
    });

    it("renders Date as an RFC3339 string literal", () => {
        expect.assertions(1);

        expect(lit(new Date("2025-09-24T01:00:00.000Z"))).toBe("'2025-09-24T01:00:00.000Z'");
    });

    it("throws a TypeError on an invalid Date, not the RangeError toISOString would raise", () => {
        expect.assertions(2);

        expect(() => lit(new Date(Number.NaN))).toThrow(TypeError);
        expect(() => lit(new Date(Number.NaN))).toThrow(/invalid Date/);
    });

    it("renders arrays as a parenthesised IN list", () => {
        expect.assertions(2);

        expect(lit([1, 2, 3])).toBe("(1, 2, 3)");
        expect(lit(["a", "b"])).toBe("('a', 'b')");
    });

    it("throws on an empty array (IN () is invalid SQL)", () => {
        expect.assertions(1);

        expect(() => lit([])).toThrow(/empty array/);
    });

    it("throws on non-finite numbers", () => {
        expect.assertions(2);

        expect(() => lit(Number.NaN)).toThrow(/non-finite/);
        expect(() => lit(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    });

    it("throws on unsupported types", () => {
        expect.assertions(2);

        expect(() => lit({ a: 1 })).toThrow(/cannot inline/);
        expect(() => lit(Symbol("x"))).toThrow(/cannot inline/);
    });
});

describe("sql tag", () => {
    it("escapes interpolated values and splices Sql fragments verbatim", () => {
        expect.assertions(2);

        const region = "North'; --";
        const fragment = sql`SELECT * FROM s.orders WHERE region = ${region} AND ${raw("active = true")} LIMIT ${10}`;

        expect(fragment).toBeInstanceOf(Sql);
        expect(fragment.text).toBe("SELECT * FROM s.orders WHERE region = 'North''; --' AND active = true LIMIT 10");
    });

    it("handles no interpolations", () => {
        expect.assertions(1);

        expect(sql`SELECT 1`.text).toBe("SELECT 1");
    });
});

describe("raw / isSql / toText", () => {
    it("raw wraps text without escaping", () => {
        expect.assertions(1);

        expect(raw("a + b").text).toBe("a + b");
    });

    it("isSql discriminates", () => {
        expect.assertions(2);

        expect(isSql(raw("x"))).toBe(true);
        expect(isSql("x")).toBe(false);
    });

    it("toText unwraps Sql but passes strings through", () => {
        expect.assertions(2);

        expect(toText(raw("x"))).toBe("x");
        expect(toText("y")).toBe("y");
    });
});

describe("joinSql", () => {
    it("joins fragments and strings with a separator", () => {
        expect.assertions(1);

        expect(joinSql([sql`a = ${1}`, "b = 2", raw("c = 3")], " AND ").text).toBe("a = 1 AND b = 2 AND c = 3");
    });
});

describe("tableRef", () => {
    it("accepts a plain and a dotted identifier", () => {
        expect.assertions(3);

        expect(tableRef("orders")).toBe("orders");
        expect(tableRef("s.orders")).toBe("s.orders");
        expect(tableRef("db.schema.orders")).toBe("db.schema.orders");
    });

    it("accepts one alias, bare or with AS, in either case", () => {
        expect.assertions(4);

        expect(tableRef("s.zones z")).toBe("s.zones z");
        expect(tableRef("users AS u")).toBe("users AS u");
        expect(tableRef("users as u")).toBe("users as u");
        expect(tableRef("db.schema.orders o")).toBe("db.schema.orders o");
    });

    // `\s` matches a newline, so the alias separator may be one. Not a hole: the
    // alias is still `\w+` and the pattern is anchored, so what gets spliced is
    // exactly the space-separated form SQL already treats it as.
    it("treats a newline as the alias separator, same as a space", () => {
        expect.assertions(1);

        expect(tableRef("orders\nx")).toBe("orders\nx");
    });

    it("rejects punctuation that could break out of the FROM position", () => {
        expect.assertions(8);

        expect(() => tableRef("orders'")).toThrow(TypeError);
        expect(() => tableRef('"orders"')).toThrow(/invalid table reference/);
        expect(() => tableRef("orders; DROP TABLE x")).toThrow(/invalid table reference/);
        expect(() => tableRef("orders -- x")).toThrow(/invalid table reference/);
        expect(() => tableRef("orders /* x */")).toThrow(/invalid table reference/);
        expect(() => tableRef("(SELECT 1)")).toThrow(/invalid table reference/);
        expect(() => tableRef("orders, users")).toThrow(/invalid table reference/);
        expect(() => tableRef("s.orders o AND 1=1")).toThrow(/invalid table reference/);
    });

    it("rejects a second alias and an empty reference", () => {
        expect.assertions(3);

        expect(() => tableRef("orders o p")).toThrow(/invalid table reference/);
        expect(() => tableRef("orders AS o p")).toThrow(/invalid table reference/);
        expect(() => tableRef("")).toThrow(/invalid table reference/);
    });

    it("rejects a non-string reference", () => {
        expect.assertions(1);

        expect(() => tableRef(42 as unknown as string)).toThrow(TypeError);
    });
});

describe("assertLimit", () => {
    it("accepts the inclusive 1..10,000 bounds", () => {
        expect.assertions(3);

        expect(() => {
            assertLimit(1);
        }).not.toThrow();
        expect(() => {
            assertLimit(10_000);
        }).not.toThrow();
        expect(() => {
            assertLimit(500);
        }).not.toThrow();
    });

    it("rejects values outside the range", () => {
        expect.assertions(3);

        expect(() => {
            assertLimit(0);
        }).toThrow(RangeError);
        expect(() => {
            assertLimit(-1);
        }).toThrow(/between 1 and 10000/);
        expect(() => {
            assertLimit(10_001);
        }).toThrow(/between 1 and 10000/);
    });

    it("rejects non-integers", () => {
        expect.assertions(3);

        expect(() => {
            assertLimit(3.5);
        }).toThrow(/must be an integer/);
        expect(() => {
            assertLimit(Number.NaN);
        }).toThrow(RangeError);
        expect(() => {
            assertLimit(Number.POSITIVE_INFINITY);
        }).toThrow(RangeError);
    });
});
