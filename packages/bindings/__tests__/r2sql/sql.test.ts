import { describe, expect, it } from "vitest";

import { isSql, joinSql, lit, raw, Sql, sql, toText } from "../../src/r2sql/sql";

describe("lit", () => {
    it("renders null and undefined as NULL", () => {
        expect(lit(null)).toBe("NULL");
        expect(lit(undefined)).toBe("NULL");
    });

    it("renders booleans, numbers, and bigints", () => {
        expect(lit(true)).toBe("true");
        expect(lit(false)).toBe("false");
        expect(lit(42)).toBe("42");
        expect(lit(-3.14)).toBe("-3.14");
        expect(lit(10n)).toBe("10");
    });

    it("single-quotes strings and doubles embedded quotes", () => {
        expect(lit("hello")).toBe("'hello'");
        expect(lit("O'Brien")).toBe("'O''Brien'");
    });

    it("neutralises an injection attempt by escaping it into one literal", () => {
        expect(lit("North'; DROP TABLE x; --")).toBe("'North''; DROP TABLE x; --'");
    });

    it("renders Date as an RFC3339 string literal", () => {
        expect(lit(new Date("2025-09-24T01:00:00.000Z"))).toBe("'2025-09-24T01:00:00.000Z'");
    });

    it("renders arrays as a parenthesised IN list", () => {
        expect(lit([1, 2, 3])).toBe("(1, 2, 3)");
        expect(lit(["a", "b"])).toBe("('a', 'b')");
    });

    it("throws on an empty array (IN () is invalid SQL)", () => {
        expect(() => lit([])).toThrow(/empty array/);
    });

    it("throws on non-finite numbers", () => {
        expect(() => lit(Number.NaN)).toThrow(/non-finite/);
        expect(() => lit(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    });

    it("throws on unsupported types", () => {
        expect(() => lit({ a: 1 })).toThrow(/cannot inline/);
        expect(() => lit(Symbol("x"))).toThrow(/cannot inline/);
    });
});

describe("sql tag", () => {
    it("escapes interpolated values and splices Sql fragments verbatim", () => {
        const region = "North'; --";
        const fragment = sql`SELECT * FROM s.orders WHERE region = ${region} AND ${raw("active = true")} LIMIT ${10}`;

        expect(fragment).toBeInstanceOf(Sql);
        expect(fragment.text).toBe("SELECT * FROM s.orders WHERE region = 'North''; --' AND active = true LIMIT 10");
    });

    it("handles no interpolations", () => {
        expect(sql`SELECT 1`.text).toBe("SELECT 1");
    });
});

describe("raw / isSql / toText", () => {
    it("raw wraps text without escaping", () => {
        expect(raw("a + b").text).toBe("a + b");
    });

    it("isSql discriminates", () => {
        expect(isSql(raw("x"))).toBe(true);
        expect(isSql("x")).toBe(false);
    });

    it("toText unwraps Sql but passes strings through", () => {
        expect(toText(raw("x"))).toBe("x");
        expect(toText("y")).toBe("y");
    });
});

describe("joinSql", () => {
    it("joins fragments and strings with a separator", () => {
        expect(joinSql([sql`a = ${1}`, "b = 2", raw("c = 3")], " AND ").text).toBe("a = 1 AND b = 2 AND c = 3");
    });
});
