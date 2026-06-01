import { describe, expect, test } from "vitest";

import type { WhereCompilerStrategy, WhereInput } from "../src/where-clause-compiler.js";
import { compileWhere } from "../src/where-clause-compiler.js";

const DOC_COLUMN = "__doc__";

/**
 * Mirrors `serializeSqlValue` in `ctx-db.ts` so the fixtures bind parameters
 * exactly the way the runtime will. Both dialects share it.
 */
const serialize = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    if (value === null || typeof value === "string" || typeof value === "number") {
        return value;
    }

    if (typeof value === "bigint") {
        return value.toString();
    }

    return JSON.stringify(value);
};

/** DO dialect: fields resolve through `json_extract`, internal columns passthrough. */
const doDialect: WhereCompilerStrategy = {
    fieldRef: (field) => {
        if (field === "_id" || field === "id") {
            return "id";
        }

        if (field === "_creationTime") {
            return "_creationTime";
        }

        return `json_extract(${DOC_COLUMN}, '$.${field.replaceAll("'", "''")}')`;
    },
    serialize,
};

/** D1 dialect: fields are real, quoted columns. */
const d1Dialect: WhereCompilerStrategy = {
    fieldRef: (field) => `"${field.replaceAll('"', '""')}"`,
    serialize,
};

const json = (field: string): string => `json_extract(${DOC_COLUMN}, '$.${field}')`;

describe("compileWhere — empty / absent input", () => {
    test("undefined where yields no SQL and no params", () => {
        expect.assertions(1);

        expect(compileWhere(undefined, doDialect)).toEqual({ params: [], sql: "" });
    });

    test("empty object yields no SQL and no params", () => {
        expect.assertions(1);

        expect(compileWhere({}, doDialect)).toEqual({ params: [], sql: "" });
    });
});

describe("compileWhere — equality shorthand", () => {
    test("scalar shorthand compiles to `= ?` with a bound, serialized param", () => {
        expect.assertions(1);

        expect(compileWhere({ priority: "high" }, doDialect)).toEqual({
            params: ["high"],
            sql: `${json("priority")} = ?`,
        });
    });

    test("boolean shorthand serializes to 1/0", () => {
        expect.assertions(1);

        expect(compileWhere({ archived: false }, doDialect)).toEqual({
            params: [0],
            sql: `${json("archived")} = ?`,
        });
    });

    test("null shorthand compiles to IS NULL (no param)", () => {
        expect.assertions(1);

        expect(compileWhere({ note: null }, doDialect)).toEqual({
            params: [],
            sql: `${json("note")} IS NULL`,
        });
    });

    test("multiple fields are AND-joined in authoring order", () => {
        expect.assertions(1);

        expect(compileWhere({ archived: false, priority: "high" }, doDialect)).toEqual({
            params: [0, "high"],
            sql: `${json("archived")} = ? AND ${json("priority")} = ?`,
        });
    });
});

describe("compileWhere — operators", () => {
    test("eq / ne with a value", () => {
        expect.assertions(1);

        expect(compileWhere({ a: { eq: 1 }, b: { ne: 2 } }, doDialect)).toEqual({
            params: [1, 2],
            sql: `${json("a")} = ? AND ${json("b")} <> ?`,
        });
    });

    test("eq:null → IS NULL, ne:null → IS NOT NULL (no params)", () => {
        expect.assertions(1);

        expect(compileWhere({ a: { eq: null }, b: { ne: null } }, doDialect)).toEqual({
            params: [],
            sql: `${json("a")} IS NULL AND ${json("b")} IS NOT NULL`,
        });
    });

    test("lt / lte / gt / gte", () => {
        expect.assertions(1);

        expect(compileWhere({ a: { gt: 1, gte: 2, lt: 3, lte: 4 } }, doDialect)).toEqual({
            // canonical order: lt, lte, gt, gte
            params: [3, 4, 1, 2],
            sql: `${json("a")} < ? AND ${json("a")} <= ? AND ${json("a")} > ? AND ${json("a")} >= ?`,
        });
    });

    test("in with members → IN (?, …) with ordered params", () => {
        expect.assertions(1);

        expect(compileWhere({ priority: { in: ["high", "medium"] } }, doDialect)).toEqual({
            params: ["high", "medium"],
            sql: `${json("priority")} IN (?, ?)`,
        });
    });

    test("in [] is a syntax-safe constant-false (no params)", () => {
        expect.assertions(1);

        expect(compileWhere({ priority: { in: [] } }, doDialect)).toEqual({
            params: [],
            sql: "0 = 1",
        });
    });

    test("notIn with members → NOT IN (?, …)", () => {
        expect.assertions(1);

        expect(compileWhere({ priority: { notIn: ["low"] } }, doDialect)).toEqual({
            params: ["low"],
            sql: `${json("priority")} NOT IN (?)`,
        });
    });

    test("notIn [] is a constant-true (complement of empty set)", () => {
        expect.assertions(1);

        expect(compileWhere({ priority: { notIn: [] } }, doDialect)).toEqual({
            params: [],
            sql: "1 = 1",
        });
    });

    test("isNull true / false", () => {
        expect.assertions(1);

        expect(compileWhere({ a: { isNull: true }, b: { isNull: false } }, doDialect)).toEqual({
            params: [],
            sql: `${json("a")} IS NULL AND ${json("b")} IS NOT NULL`,
        });
    });

    test("contains binds the term as a param (no string interpolation)", () => {
        expect.assertions(1);

        // A term with a quote proves the value never lands in the SQL string.
        expect(compileWhere({ title: { contains: "O'Brien" } }, doDialect)).toEqual({
            params: ["O'Brien"],
            sql: `${json("title")} LIKE '%' || ? || '%'`,
        });
    });
});

describe("compileWhere — AND / OR / NOT nesting", () => {
    test("parenthesizes an OR group with ordered params", () => {
        expect.assertions(1);

        const where: WhereInput = { OR: [{ priority: "high" }, { priority: "medium" }] };

        expect(compileWhere(where, doDialect)).toEqual({
            params: ["high", "medium"],
            sql: `(${json("priority")} = ? OR ${json("priority")} = ?)`,
        });
    });

    test("wraps a NOT around its inner predicate", () => {
        expect.assertions(1);

        expect(compileWhere({ NOT: { archived: true } }, doDialect)).toEqual({
            params: [1],
            sql: `NOT (${json("archived")} = ?)`,
        });
    });

    test("fields, OR and NOT combine, preserving authoring order and param order", () => {
        expect.assertions(1);

        const where: WhereInput = {
            projectId: "p1",
            OR: [{ priority: "high" }, { status: { in: ["open", "blocked"] } }],
            NOT: { archived: true },
        };

        expect(compileWhere(where, doDialect)).toEqual({
            params: ["p1", "high", "open", "blocked", 1],
            sql: `${json("projectId")} = ? AND (${json("priority")} = ? OR ${json("status")} IN (?, ?)) AND NOT (${json("archived")} = ?)`,
        });
    });

    test("nested AND inside OR produces correctly grouped SQL", () => {
        expect.assertions(1);

        const where: WhereInput = {
            OR: [{ AND: [{ a: 1 }, { b: 2 }] }, { c: 3 }],
        };

        expect(compileWhere(where, doDialect)).toEqual({
            params: [1, 2, 3],
            sql: `((${json("a")} = ? AND ${json("b")} = ?) OR ${json("c")} = ?)`,
        });
    });

    test("empty OR is constant-false, empty AND contributes nothing", () => {
        expect.assertions(3);

        expect(compileWhere({ OR: [] }, doDialect)).toEqual({ params: [], sql: "0 = 1" });
        expect(compileWhere({ AND: [] }, doDialect)).toEqual({ params: [], sql: "" });
        expect(compileWhere({ a: 1, AND: [] }, doDialect)).toEqual({ params: [1], sql: `${json("a")} = ?` });
    });
});

describe("compileWhere — dialect parity", () => {
    test("the same fixture differs only in field references", () => {
        expect.assertions(3);

        const where: WhereInput = {
            archived: false,
            priority: { in: ["high", "medium"] },
            projectId: "p1",
        };

        const doResult = compileWhere(where, doDialect);
        const d1Result = compileWhere(where, d1Dialect);

        // Identical params and operator structure...
        expect(d1Result.params).toEqual(doResult.params);
        expect(doResult.sql).toBe(`${json("archived")} = ? AND ${json("priority")} IN (?, ?) AND ${json("projectId")} = ?`);
        expect(d1Result.sql).toBe(`"archived" = ? AND "priority" IN (?, ?) AND "projectId" = ?`);
    });

    test("internal columns and quote escaping resolve per dialect", () => {
        expect.assertions(2);

        expect(compileWhere({ _creationTime: { gt: 100 }, _id: "x" }, doDialect)).toEqual({
            params: [100, "x"],
            sql: "_creationTime > ? AND id = ?",
        });

        expect(compileWhere({ 'weird"name': "v" }, d1Dialect)).toEqual({
            params: ["v"],
            sql: '"weird""name" = ?',
        });
    });
});
