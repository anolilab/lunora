/* eslint-disable no-restricted-syntax -- `sql\`…\`` is a drizzle tagged-template SQL builder, not a string conversion. */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqlEngine } from "../src/drizzle";
import { renderSql } from "../src/drizzle";
import type { WhereSqlStrategy } from "../src/where-sql";
import { compileWhereSql } from "../src/where-sql";

/** Booleans serialize to 1/0 (SQLite-shaped values), like the real column codec. */
const serialize = (value: unknown): unknown => {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    return value;
};

const baseStrategy: WhereSqlStrategy = {
    fieldRef: (field) => sql`${sql.identifier(field)}`,
    serialize,
};

const mysqlStrategy: WhereSqlStrategy = {
    containsExpr: (reference, term) => sql`LOCATE(${term}, ${reference}) > 0`,
    fieldRef: (field) => sql`${sql.identifier(field)}`,
    serialize,
};

const postgresStrategy: WhereSqlStrategy = {
    containsExpr: (reference, term) => sql`strpos(${reference}, ${term}) > 0`,
    fieldRef: (field) => sql`${sql.identifier(field)}`,
    serialize,
};

/** Compile + render in one step for an engine. */
const render = (where: Record<string, unknown>, engine: SqlEngine, strategy: WhereSqlStrategy = baseStrategy): { params: unknown[]; sql: string } => {
    const compiled = compileWhereSql(where, strategy);

    if (!compiled) {
        return { params: [], sql: "" };
    }

    return renderSql(engine, compiled);
};

// Clause chains render BALANCED, not flat: `a AND (b AND c)` rather than
// `a AND b AND c`. SQLite parses a flat chain left-deep, one expression-tree
// node per clause, against Workerd's depth cap of 100 — so the compiler splits
// the chain in half recursively. AND/OR are associative under three-valued
// logic, so the grouping is invisible to what matches, and placeholder
// numbering stays left-to-right.
describe("compileWhereSql — per-engine rendering", () => {
    it("renders equality shorthand with the engine's identifier quoting + placeholder style", () => {
        expect.assertions(3);

        expect(render({ archived: false, priority: "high" }, "postgres")).toEqual({
            params: [0, "high"],
            sql: `("archived" = $1) AND ("priority" = $2)`,
        });
        expect(render({ archived: false, priority: "high" }, "mysql")).toEqual({
            params: [0, "high"],
            sql: "(`archived` = ?) AND (`priority` = ?)",
        });
        expect(render({ archived: false, priority: "high" }, "sqlite")).toEqual({
            params: [0, "high"],
            sql: `("archived" = ?) AND ("priority" = ?)`,
        });
    });

    it("numbers IN-list members sequentially (Postgres) / passes `?` through (SQLite)", () => {
        expect.assertions(2);

        expect(render({ priority: { in: ["high", "medium", "low"] } }, "postgres")).toEqual({
            params: ["high", "medium", "low"],
            sql: `"priority" IN ($1, $2, $3)`,
        });
        expect(render({ priority: { in: ["high", "medium", "low"] } }, "sqlite")).toEqual({
            params: ["high", "medium", "low"],
            sql: `"priority" IN (?, ?, ?)`,
        });
    });

    it("maps null comparisons to IS [NOT] NULL and consumes no placeholder", () => {
        expect.assertions(1);

        expect(render({ a: { eq: null }, b: 2, c: null }, "postgres")).toEqual({
            params: [2],
            sql: `("a" IS NULL) AND (("b" = $1) AND ("c" IS NULL))`,
        });
    });

    it("preserves global placeholder numbering across nested OR / NOT / IN groups (Postgres)", () => {
        expect.assertions(1);

        const where = {
            NOT: { archived: true },
            OR: [{ priority: "high" }, { status: { in: ["open", "blocked"] } }],
            projectId: "p1",
        };

        expect(render(where, "postgres")).toEqual({
            params: [1, "high", "open", "blocked", "p1"],
            sql: `(NOT ("archived" = $1)) AND ((("priority" = $2) OR ("status" IN ($3, $4))) AND ("projectId" = $5))`,
        });
    });

    it("renders comparison operators in OPERATOR_KEYS order", () => {
        expect.assertions(1);

        // lte precedes gt in OPERATOR_KEYS, so it binds first.
        expect(render({ seq: { gt: 2, lte: 9 } }, "postgres")).toEqual({
            params: [9, 2],
            sql: `("seq" <= $1) AND ("seq" > $2)`,
        });
    });

    it("renders `contains` as a position test per dialect, never as a LIKE pattern", () => {
        expect.assertions(3);

        // Workerd caps a LIKE pattern at 50 bytes, so `contains` uses a position
        // function; each dialect's must fold case the way its LIKE does.
        expect(render({ title: { contains: "O'Brien" } }, "sqlite")).toEqual({
            params: ["O'Brien"],
            sql: `instr(lower("title"), lower(?)) > 0`,
        });
        expect(render({ title: { contains: "O'Brien" } }, "mysql", mysqlStrategy)).toEqual({
            params: ["O'Brien"],
            sql: "LOCATE(?, `title`) > 0",
        });
        expect(render({ title: { contains: "O'Brien" } }, "postgres", postgresStrategy)).toEqual({
            params: ["O'Brien"],
            sql: `strpos("title", $1) > 0`,
        });
    });

    it("binds a `contains` term literally — wildcards need no escaping in a position test", () => {
        expect.assertions(2);

        // Pre-fix these were rewritten to `50\\%\\_off\\\\` to survive LIKE; a position
        // function takes the term as-is, so a client-supplied `%` is just text.
        expect(render({ title: { contains: "50%_off\\" } }, "sqlite")).toEqual({
            params: ["50%_off\\"],
            sql: `instr(lower("title"), lower(?)) > 0`,
        });
        expect(render({ title: { contains: "a_b" } }, "sqlite")).toEqual({
            params: ["a_b"],
            sql: `instr(lower("title"), lower(?)) > 0`,
        });
    });

    it("renders empty IN / NOT IN as never-matches / always-matches sentinels", () => {
        expect.assertions(2);

        expect(render({ x: { in: [] } }, "sqlite")).toEqual({ params: [], sql: `0 = 1` });
        expect(render({ x: { notIn: [] } }, "sqlite")).toEqual({ params: [], sql: `1 = 1` });
    });

    it("returns undefined for an empty / absent where", () => {
        expect.assertions(2);

        expect(compileWhereSql({}, baseStrategy)).toBeUndefined();
        expect(compileWhereSql(undefined, baseStrategy)).toBeUndefined();
    });

    describe("relationExists push-down hook", () => {
        // A test strategy whose relationExists builds a correlated `[NOT] EXISTS (…)` subquery.
        const existsStrategy: WhereSqlStrategy = {
            fieldRef: (field) => sql`${sql.identifier(field)}`,
            relationExists: (request) => {
                const { negated, table } = request as { negated: boolean; table: string };
                const exists = sql`EXISTS (SELECT 1 FROM ${sql.identifier(table)} AS p WHERE p.${sql.identifier("authorId")} = ${sql.identifier("id")})`;

                return negated ? sql`NOT ${exists}` : exists;
            },
            serialize,
        };

        it("compiles a __relationExists marker into a correlated EXISTS, AND-joined with sibling clauses", () => {
            expect.assertions(1);

            const where = { __relationExists: { negated: false, table: "posts" }, status: "active" };

            expect(render(where, "sqlite", existsStrategy)).toEqual({
                params: ["active"],
                sql: `(EXISTS (SELECT 1 FROM "posts" AS p WHERE p."authorId" = "id")) AND ("status" = ?)`,
            });
        });

        it("compiles a negated marker into NOT EXISTS", () => {
            expect.assertions(1);

            expect(render({ __relationExists: { negated: true, table: "posts" } }, "sqlite", existsStrategy)).toEqual({
                params: [],
                sql: `NOT EXISTS (SELECT 1 FROM "posts" AS p WHERE p."authorId" = "id")`,
            });
        });

        it("throws when a marker is present but the strategy has no relationExists hook", () => {
            expect.assertions(1);

            expect(() => compileWhereSql({ __relationExists: { table: "posts" } }, baseStrategy)).toThrow(/relationExists strategy hook/);
        });
    });
});
