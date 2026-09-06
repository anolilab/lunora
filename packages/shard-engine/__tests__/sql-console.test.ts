import { describe, expect, it } from "vitest";

import { classifyStatement } from "../../../shared/sql-readonly";
import type { SqlExec } from "../src/ctx-db";
import { assertReadonly, lintReadonlySql, MAX_SQL_ROWS, runReadonlySql } from "../src/sql-console";

/** A `SqlExec` stub that records the query and returns a fixed row set. */
const stubExec = (rows: Record<string, unknown>[]): { exec: SqlExec["exec"]; lastQuery: string } => {
    const state = { lastQuery: "" };

    return {
        exec: ((query: string) => {
            state.lastQuery = query;

            return { one: () => rows[0], toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
        }) as SqlExec["exec"],
        get lastQuery() {
            return state.lastQuery;
        },
    };
};

/** A `SqlExec` stub whose `exec` throws — models SQLite rejecting a malformed statement. */
const throwingExec = (message: string): SqlExec => {
    return {
        exec: () => {
            throw new Error(message);
        },
    };
};

describe("assertReadonly", () => {
    it("accepts SELECT / WITH / EXPLAIN queries", () => {
        expect.assertions(4);

        expect(() => {
            assertReadonly("SELECT * FROM messages");
        }).not.toThrow();
        expect(() => {
            assertReadonly("  with x as (select 1) select * from x");
        }).not.toThrow();
        expect(() => {
            assertReadonly("EXPLAIN QUERY PLAN SELECT * FROM posts");
        }).not.toThrow();
        // A leading comment is stripped before the read-verb check.
        expect(() => {
            assertReadonly("-- a comment\nSELECT 1");
        }).not.toThrow();
    });

    it("strips leading block comments and returns fast on unterminated ones", () => {
        expect.assertions(3);

        expect(() => {
            assertReadonly("/* leading block */ SELECT 1");
        }).not.toThrow();

        // A long run of unterminated `/*` openers must be rejected in linear time
        // (the leading-noise scan is a single pass, not a backtracking regex).
        const start = performance.now();

        expect(() => {
            assertReadonly(` ${"/*".repeat(50_000)}`);
        }).toThrow(/read-only/);
        expect(performance.now() - start).toBeLessThan(1000);
    });

    it("rejects mutating and DDL statements", () => {
        expect.assertions(6);

        for (const query of [
            "DELETE FROM messages",
            "UPDATE messages SET x = 1",
            "INSERT INTO t VALUES (1)",
            "DROP TABLE t",
            "PRAGMA writable_schema=ON",
            "WITH x AS (SELECT 1) DELETE FROM messages",
        ]) {
            expect(() => {
                assertReadonly(query);
            }).toThrow(/read-only|allowed/u);
        }
    });

    it("rejects empty input and multi-statement batches", () => {
        expect.assertions(2);

        expect(() => {
            assertReadonly("   ");
        }).toThrow(/empty/u);
        expect(() => {
            assertReadonly("SELECT 1; SELECT 2");
        }).toThrow(/single statement/u);
    });
});

describe("runReadonlySql", () => {
    it("returns columns from the first row, the true count, and rows", () => {
        expect.assertions(3);

        const sql = stubExec([
            { id: "a", n: 1 },
            { id: "b", n: 2 },
        ]);
        const result = runReadonlySql(sql, "SELECT id, n FROM t");

        expect(result.columns).toStrictEqual(["id", "n"]);
        expect(result.rowCount).toBe(2);
        expect(result.truncated).toBe(false);
    });

    it("caps the returned rows and flags truncation", () => {
        expect.assertions(3);

        const rows = Array.from({ length: MAX_SQL_ROWS + 5 }, (_, index) => {
            return { i: index };
        });
        const result = runReadonlySql(stubExec(rows), "SELECT i FROM t");

        expect(result.rows).toHaveLength(MAX_SQL_ROWS);
        expect(result.rowCount).toBe(MAX_SQL_ROWS + 5);
        expect(result.truncated).toBe(true);
    });

    it("throws before executing a write", () => {
        expect.assertions(2);

        const sql = stubExec([]);

        expect(() => runReadonlySql(sql, "DELETE FROM t")).toThrow(/read-only/u);
        // The guard runs before exec, so the query was never sent.
        expect(sql.lastQuery).toBe("");
    });
});

describe("classifyStatement offsets", () => {
    it("points at the offending keyword in the ORIGINAL string", () => {
        expect.assertions(3);

        // Leading comment + whitespace must not shift the reported span: the
        // editor underlines against the text the operator actually typed.
        const query = "-- note\n  WITH x AS (SELECT 1) DELETE FROM t";
        const rejection = classifyStatement(query);

        expect(rejection?.code).toBe("SQL_NOT_READONLY");
        expect(query.slice(rejection?.offset ?? 0, (rejection?.offset ?? 0) + (rejection?.length ?? 0))).toBe("DELETE");
        expect(rejection?.message).toMatch(/DELETE/u);
    });

    it("points at the separating semicolon of a batch", () => {
        expect.assertions(2);

        const query = "SELECT 1; SELECT 2";
        const rejection = classifyStatement(query);

        expect(rejection?.code).toBe("SQL_MULTIPLE_STATEMENTS");
        expect(query[rejection?.offset ?? -1]).toBe(";");
    });

    it("allows a single trailing semicolon", () => {
        expect.assertions(1);

        expect(classifyStatement("SELECT 1;")).toBeUndefined();
    });

    it("allows a comment after the trailing semicolon", () => {
        expect.assertions(3);

        // A comment is whitespace to SQLite, so `SELECT 1; -- note` is one
        // statement. The trailing-`;` strip ran on the RAW text, where the comment
        // sits between the `;` and the end, so the regex missed it and the `;` was
        // read as a batch separator — the editor refused a draft the operator
        // could run by deleting the note.
        expect(classifyStatement("SELECT 1;\n-- a closing note")).toBeUndefined();
        expect(classifyStatement("SELECT 1; /* note */")).toBeUndefined();
        // …and the tail is still not a place to hide a second statement.
        expect(classifyStatement("SELECT 1; -- note\nSELECT 2")?.code).toBe("SQL_MULTIPLE_STATEMENTS");
    });

    it.each([
        ["a string literal", "SELECT ';' AS a"],
        ["a doubled-quote escape inside one", "SELECT 'a''b;c' AS x"],
        ["a line comment", "SELECT 1 -- a; b"],
        ["a block comment", "SELECT 1 /* a; b */"],
        ['a "quoted" identifier', 'SELECT "a;b" FROM t'],
        ["a backtick identifier", "SELECT `a;b` FROM t"],
        ["a bracket identifier", "SELECT [a;b] FROM t"],
        ["a CTE's literal", "WITH a AS (SELECT ';') SELECT * FROM a"],
    ])("does not read a semicolon in %s as a statement boundary", (_label, query) => {
        expect.assertions(1);

        // Each of these is a legal read-only query that the batch check refused
        // outright, because it scanned the raw text: SQLite's parser never sees a
        // second statement inside a literal, an identifier, or a comment.
        expect(classifyStatement(query)).toBeUndefined();
    });

    it.each([
        ["a real batch after a literal", "SELECT 'a'; DROP TABLE x"],
        ["a real batch after a comment line", "SELECT 1 -- x\n; SELECT 2"],
        ["a backslash, which SQLite does not treat as an escape", String.raw`SELECT '\'; DROP TABLE x`],
        ["an unterminated quote", "SELECT 'a; DROP TABLE x"],
        ["an unterminated block comment", "SELECT 1 /* a; b"],
    ])("still refuses %s", (_label, query) => {
        expect.assertions(1);

        // The last two fail closed on purpose: nothing can be masked reliably, so
        // the scan falls back to the raw text it always used. Both are syntax
        // errors to SQLite anyway.
        expect(classifyStatement(query)?.code).toBe("SQL_MULTIPLE_STATEMENTS");
    });

    it("still finds the batch when the literal holds an astral character", () => {
        expect.assertions(3);

        // The mask buffer is code-UNIT indexed. Building it with a code-POINT
        // spread desynchronised the two, so one emoji made the fill run a slot
        // short and eat the `;` after the closing quote — `SELECT '😀';ANALYZE`
        // masked to `SELECT xxxxANALYZE` and reached `sql.exec` as one statement.
        expect(classifyStatement("SELECT '😀';SELECT 2")?.code).toBe("SQL_MULTIPLE_STATEMENTS");
        expect(classifyStatement("SELECT '😀';ANALYZE")?.code).toBe("SQL_MULTIPLE_STATEMENTS");

        // And the offset still indexes the ORIGINAL string, which only holds if
        // the mask preserved length.
        const query = "SELECT '😀' ; SELECT 2";

        expect(query[classifyStatement(query)?.offset ?? -1]).toBe(";");
    });

    it("keeps refusing a mutating keyword inside a literal", () => {
        expect.assertions(1);

        // NOT relaxed by the masking above, and deliberately so: `FORBIDDEN_KEYWORD`
        // documents rejecting a mutating word even in a literal as an accepted
        // trade for a tool that must never corrupt the shadow tables. Masking the
        // batch scan fixes a rule nobody chose; this one someone did.
        expect(classifyStatement("SELECT 'DROP TABLE x'")?.code).toBe("SQL_NOT_READONLY");
    });

    it("allows SQLite's read-only `replace()` scalar but still refuses `REPLACE INTO`", () => {
        expect.assertions(4);

        // `replace` is a write only in the `REPLACE INTO` statement form. As a
        // scalar it is a core string function, and refusing it broke a plain
        // SELECT with a message that named no rule the operator had broken.
        expect(classifyStatement("SELECT REPLACE(name, 'a', 'b') FROM users")).toBeUndefined();
        expect(classifyStatement("SELECT replace(name, 'a', 'b') AS n FROM users")).toBeUndefined();
        // The statement form is still refused — including from inside a CTE,
        // which is the reason the keyword scan exists at all.
        expect(classifyStatement("REPLACE INTO t VALUES (1)")?.code).toBe("SQL_NOT_READONLY");
        expect(classifyStatement("WITH x AS (SELECT 1) REPLACE INTO t SELECT * FROM x")?.code).toBe("SQL_NOT_READONLY");
    });
});

describe("lintReadonlySql", () => {
    it("reports a gate rejection as a diagnostic instead of throwing", () => {
        expect.assertions(3);

        const sql = stubExec([]);
        const result = lintReadonlySql(sql, "DELETE FROM t");

        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toMatchObject({ severity: "error", source: "gate" });
        // A refused statement is never planned, so SQLite is never touched.
        expect(sql.lastQuery).toBe("");
    });

    it("stays quiet on an empty buffer", () => {
        expect.assertions(1);

        expect(lintReadonlySql(stubExec([]), "   ").diagnostics).toStrictEqual([]);
    });

    it("plans an allowed statement without executing it", () => {
        expect.assertions(2);

        const sql = stubExec([{ detail: "SEARCH t USING INDEX t_by_id (id=?)" }]);
        const result = lintReadonlySql(sql, "SELECT * FROM t WHERE id = 1");

        expect(sql.lastQuery).toBe("EXPLAIN QUERY PLAN SELECT * FROM t WHERE id = 1");
        expect(result.diagnostics).toStrictEqual([]);
    });

    it("warns on a full table scan in the plan", () => {
        expect.assertions(2);

        const result = lintReadonlySql(stubExec([{ detail: "SCAN messages" }]), "SELECT * FROM messages");

        expect(result.diagnostics[0]).toMatchObject({ severity: "warning", source: "plan" });
        expect(result.diagnostics[0]?.message).toMatch(/messages/u);
    });

    it("warns once per table when the plan scans it more than once", () => {
        expect.assertions(2);

        const result = lintReadonlySql(
            stubExec([{ detail: "SCAN messages" }, { detail: "SCAN messages AS m2" }, { detail: "SCAN threads" }]),
            "SELECT * FROM messages, messages m2, threads",
        );

        // A self-join scans one table twice; two identical sentences would read
        // as two problems.
        expect(result.diagnostics).toHaveLength(2);
        expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toStrictEqual([
            "full table scan on `messages` — this query reads every row",
            "full table scan on `threads` — this query reads every row",
        ]);
    });

    it("stays quiet on plan steps that read no table", () => {
        expect.assertions(1);

        // `SCAN CONSTANT ROW` / `SCAN SUBQUERY n` are SQLite's wording for a
        // constant select and a materialized subquery — neither is a table.
        expect(lintReadonlySql(stubExec([{ detail: "SCAN CONSTANT ROW" }, { detail: "SCAN SUBQUERY 1" }]), "SELECT 1").diagnostics).toStrictEqual([]);
    });

    it("maps a SQLite syntax error onto the offending token", () => {
        expect.assertions(3);

        const query = "SELECT * FRM t";
        const result = lintReadonlySql(throwingExec('near "FRM": syntax error'), query);

        expect(result.diagnostics[0]).toMatchObject({ severity: "error", source: "syntax" });
        expect(result.diagnostics[0]?.offset).toBe(query.indexOf("FRM"));
        expect(result.diagnostics[0]?.length).toBe(3);
    });

    it("falls back to a span-less diagnostic when the token can't be located", () => {
        expect.assertions(2);

        const result = lintReadonlySql(throwingExec("no such table: ghost"), "SELECT * FROM ghost");

        expect(result.diagnostics[0]?.offset).toBeUndefined();
        expect(result.diagnostics[0]?.message).toMatch(/no such table/u);
    });
});
