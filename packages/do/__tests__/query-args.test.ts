import { describe, expect, test } from "vitest";

import { buildSeekWhere, compileOrderBy, decodeCursor, encodeCursor, normalizeOrderKeys } from "../src/query-args.js";
import type { WhereCompilerStrategy } from "../src/where-clause-compiler.js";
import { compileWhere } from "../src/where-clause-compiler.js";

const DOC_COLUMN = "__doc__";

const json = (field: string): string => `json_extract(${DOC_COLUMN}, '$.${field}')`;

const doFieldRef = (field: string): string => {
    if (field === "_id" || field === "id") {
        return "id";
    }

    if (field === "_creationTime") {
        return "_creationTime";
    }

    return json(field);
};

const doDialect: WhereCompilerStrategy = {
    fieldRef: doFieldRef,
    serialize: (value) => value,
};

const d1FieldRef = (field: string): string => `"${field}"`;

describe("normalizeOrderKeys", () => {
    test("defaults to creation order when absent", () => {
        expect(normalizeOrderKeys(undefined)).toEqual([{ direction: "asc", field: "_creationTime" }]);
        expect(normalizeOrderKeys([])).toEqual([{ direction: "asc", field: "_creationTime" }]);
    });

    test("flattens the { field: dir }[] form, preserving order", () => {
        expect(normalizeOrderKeys([{ priority: "desc" }, { createdAt: "asc" }])).toEqual([
            { direction: "desc", field: "priority" },
            { direction: "asc", field: "createdAt" },
        ]);
    });
});

describe("compileOrderBy", () => {
    test("appends a stable ascending id tiebreak", () => {
        expect(compileOrderBy([{ direction: "asc", field: "createdAt" }], doFieldRef)).toBe(`${json("createdAt")} ASC, id ASC`);
    });

    test("honors desc direction", () => {
        expect(compileOrderBy([{ direction: "desc", field: "createdAt" }], doFieldRef)).toBe(`${json("createdAt")} DESC, id ASC`);
    });

    test("does not double up the tiebreak when already sorting by id", () => {
        expect(compileOrderBy([{ direction: "desc", field: "id" }], doFieldRef)).toBe("id DESC");
    });

    test("renders per dialect", () => {
        expect(compileOrderBy([{ direction: "asc", field: "createdAt" }], d1FieldRef)).toBe('"createdAt" ASC, "id" ASC');
    });
});

describe("encodeCursor / decodeCursor", () => {
    test("round-trips the orderBy values plus id", () => {
        const keys = [{ direction: "asc" as const, field: "createdAt" }];
        const doc = { _id: "row_42", createdAt: 1700, title: "ignored" };

        const cursor = encodeCursor(doc, keys);

        expect(decodeCursor(cursor)).toEqual([1700, "row_42"]);
    });

    test("survives unicode payloads", () => {
        const keys = [{ direction: "asc" as const, field: "name" }];
        const doc = { _id: "café", name: "naïve — 日本語" };

        expect(decodeCursor(encodeCursor(doc, keys))).toEqual(["naïve — 日本語", "café"]);
    });

    test("rejects a non-array payload", () => {
        const bogus = btoa(JSON.stringify({ not: "an array" }));

        expect(() => decodeCursor(bogus)).toThrow("invalid cursor");
    });
});

describe("buildSeekWhere", () => {
    test("single ascending key expands to a two-branch lexicographic seek", () => {
        const where = buildSeekWhere([{ direction: "asc", field: "createdAt" }], [1700, "row_42"]);
        const compiled = compileWhere(where, doDialect);

        expect(compiled).toEqual({
            params: [1700, 1700, "row_42"],
            sql: `(${json("createdAt")} > ? OR (${json("createdAt")} = ? AND id > ?))`,
        });
    });

    test("descending key uses < for the strict comparison", () => {
        const where = buildSeekWhere([{ direction: "desc", field: "createdAt" }], [1700, "row_42"]);
        const compiled = compileWhere(where, doDialect);

        expect(compiled).toEqual({
            params: [1700, 1700, "row_42"],
            sql: `(${json("createdAt")} < ? OR (${json("createdAt")} = ? AND id > ?))`,
        });
    });

    test("mixed directions chain equality prefixes correctly", () => {
        const where = buildSeekWhere(
            [
                { direction: "asc", field: "a" },
                { direction: "desc", field: "b" },
            ],
            ["av", "bv", "row_1"],
        );
        const compiled = compileWhere(where, doDialect);

        expect(compiled.sql).toBe(`(${json("a")} > ? OR (${json("a")} = ? AND ${json("b")} < ?) OR (${json("a")} = ? AND ${json("b")} = ? AND id > ?))`);
        expect(compiled.params).toEqual(["av", "av", "bv", "av", "bv", "row_1"]);
    });

    test("an explicit id sort key is used as the terminal column (no synthetic tiebreak)", () => {
        const where = buildSeekWhere([{ direction: "asc", field: "id" }], ["row_1"]);
        const compiled = compileWhere(where, doDialect);

        expect(compiled).toEqual({ params: ["row_1"], sql: "(id > ?)" });
    });
});
