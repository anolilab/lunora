import type { SqlExec } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

import { assertReadonly, MAX_SQL_ROWS, runReadonlySql } from "../src/sql-console.js";

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
