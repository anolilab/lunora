import type { WhereInput, WhereSqlStrategy } from "@lunora/shard-engine";
import { compileWhereSql,renderSql } from "@lunora/shard-engine";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { buildSeekWhere, decodeCursor, encodeCursor, normalizeOrderKeys } from "../src/query-args";

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

const doStrategy: WhereSqlStrategy = { fieldRef: (field) => sql.raw(doFieldRef(field)), serialize: (value) => value };

/** Compile a `where` tree through the drizzle compiler + render it for SQLite — the rendering path `buildSeekWhere`'s output flows through in production. */
const compile = (where: WhereInput): { params: unknown[]; sql: string } => renderSql("sqlite", compileWhereSql(where, doStrategy) ?? sql``);

describe("normalizeOrderKeys", () => {
    it("defaults to creation order when absent", () => {
        expect.assertions(2);

        expect(normalizeOrderKeys(undefined)).toEqual([{ direction: "asc", field: "_creationTime" }]);
        expect(normalizeOrderKeys([])).toEqual([{ direction: "asc", field: "_creationTime" }]);
    });

    it("flattens the { field: dir }[] form, preserving order", () => {
        expect.assertions(1);

        expect(normalizeOrderKeys([{ priority: "desc" }, { createdAt: "asc" }])).toEqual([
            { direction: "desc", field: "priority" },
            { direction: "asc", field: "createdAt" },
        ]);
    });
});

describe("encodeCursor / decodeCursor", () => {
    it("round-trips the orderBy values plus id", () => {
        expect.assertions(1);

        const keys = [{ direction: "asc" as const, field: "createdAt" }];
        const doc = { _id: "row_42", createdAt: 1700, title: "ignored" };

        const cursor = encodeCursor(doc, keys);

        expect(decodeCursor(cursor)).toEqual([1700, "row_42"]);
    });

    it("survives unicode payloads", () => {
        expect.assertions(1);

        const keys = [{ direction: "asc" as const, field: "name" }];
        const doc = { _id: "café", name: "naïve — 日本語" };

        expect(decodeCursor(encodeCursor(doc, keys))).toEqual(["naïve — 日本語", "café"]);
    });

    it("rejects a non-array payload", () => {
        expect.assertions(1);

        const bogus = btoa(JSON.stringify({ not: "an array" }));

        expect(() => decodeCursor(bogus)).toThrow("invalid cursor");
    });
});

describe("buildSeekWhere", () => {
    it("single ascending key expands to a two-branch lexicographic seek", () => {
        expect.assertions(1);

        const where = buildSeekWhere([{ direction: "asc", field: "createdAt" }], [1700, "row_42"]);
        const compiled = compile(where);

        expect(compiled).toEqual({
            params: [1700, 1700, "row_42"],
            sql: `(${json("createdAt")} > ?) OR ((${json("createdAt")} = ?) AND (id > ?))`,
        });
    });

    it("descending key uses < for the strict comparison", () => {
        expect.assertions(1);

        const where = buildSeekWhere([{ direction: "desc", field: "createdAt" }], [1700, "row_42"]);
        const compiled = compile(where);

        expect(compiled).toEqual({
            params: [1700, 1700, "row_42"],
            sql: `(${json("createdAt")} < ?) OR ((${json("createdAt")} = ?) AND (id > ?))`,
        });
    });

    it("mixed directions chain equality prefixes correctly", () => {
        expect.assertions(2);

        const where = buildSeekWhere(
            [
                { direction: "asc", field: "a" },
                { direction: "desc", field: "b" },
            ],
            ["av", "bv", "row_1"],
        );
        const compiled = compile(where);

        expect(compiled.sql).toBe(
            `(${json("a")} > ?) OR ((${json("a")} = ?) AND (${json("b")} < ?)) OR ((${json("a")} = ?) AND (${json("b")} = ?) AND (id > ?))`,
        );
        expect(compiled.params).toEqual(["av", "av", "bv", "av", "bv", "row_1"]);
    });

    it("an explicit id sort key is used as the terminal column (no synthetic tiebreak)", () => {
        expect.assertions(1);

        const where = buildSeekWhere([{ direction: "asc", field: "id" }], ["row_1"]);
        const compiled = compile(where);

        expect(compiled).toEqual({ params: ["row_1"], sql: "id > ?" });
    });
});
