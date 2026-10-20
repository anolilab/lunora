/**
 * The admin SQL console over a real Durable Object's `state.storage.sql`.
 *
 * `../sql-console.test.ts` drives `runReadonlySql` / `lintReadonlySql` through
 * hand-built cursors, because `node:sqlite` exposes no `columnNames` / `raw()` on
 * every Node leg CI runs. Workerd's `SqlStorageCursor` has both, so this is the
 * only place the positional path meets the cursor it was written for — and the
 * only place the linter sees workerd's own error and plan wording.
 */
import { aroundEach, beforeEach, describe, expect, it } from "vitest";

import { lintReadonlySql, MAX_SQL_ROWS, runReadonlySql } from "../../src/sql-console";
import type { SqlHarness } from "../_helpers/sql-harness";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);

let harness: SqlHarness;

describe("sql console on workerd SQLite", () => {
    beforeEach(() => {
        harness = createWorkerdExec();
        harness.raw("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)");
        harness.raw("CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT)");
        harness.raw("INSERT INTO users VALUES ('u1', 'Ada')");
        harness.raw("INSERT INTO orders VALUES ('o1', 'u1')");
    });

    it("keeps both values of a join's same-named columns, off the real cursor", () => {
        expect.assertions(2);

        const result = runReadonlySql(harness.sql, "SELECT u.id, o.id FROM users u JOIN orders o ON o.user_id = u.id");

        expect(result.columns).toStrictEqual(["id", "id:2"]);
        expect(result.rows).toStrictEqual([{ id: "u1", "id:2": "o1" }]);
    });

    it("reports the columns of a result that matched no rows", () => {
        expect.assertions(2);

        const result = runReadonlySql(harness.sql, "SELECT id, name FROM users WHERE 1 = 0");

        expect(result.columns).toStrictEqual(["id", "name"]);
        expect(result.rowCount).toBe(0);
    });

    it("caps the rows and flags truncation", () => {
        expect.assertions(3);

        const result = runReadonlySql(
            harness.sql,
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(MAX_SQL_ROWS + 5)}) SELECT i FROM n`,
        );

        expect(result.rows).toHaveLength(MAX_SQL_ROWS);
        expect(result.rowCount).toBe(MAX_SQL_ROWS + 5);
        expect(result.truncated).toBe(true);
    });

    it("refuses a write before it reaches storage", () => {
        expect.assertions(2);

        expect(() => runReadonlySql(harness.sql, "DELETE FROM users")).toThrow(/read-only/u);
        expect(harness.raw("SELECT count(*) AS n FROM users")).toStrictEqual([{ n: 1 }]);
    });

    it("warns on the full scan workerd's planner reports", () => {
        expect.assertions(2);

        const result = lintReadonlySql(harness.sql, "SELECT * FROM users WHERE name = 'Ada'");

        expect(result.plan.length).toBeGreaterThan(0);
        expect(result.diagnostics).toStrictEqual([{ message: "full table scan on `users` — this query reads every row", severity: "warning", source: "plan" }]);
    });

    it("maps workerd's syntax error onto the offending token", () => {
        expect.assertions(3);

        const query = "SELECT * FRM users";
        const result = lintReadonlySql(harness.sql, query);

        expect(result.diagnostics[0]).toMatchObject({ severity: "error", source: "syntax" });
        expect(result.diagnostics[0]?.offset).toBe(query.indexOf("FRM"));
        expect(result.diagnostics[0]?.length).toBe(3);
    });

    it("reports a missing table as a span-less diagnostic", () => {
        expect.assertions(2);

        const result = lintReadonlySql(harness.sql, "SELECT * FROM ghost");

        expect(result.diagnostics[0]?.offset).toBeUndefined();
        expect(result.diagnostics[0]?.message).toMatch(/no such table/u);
    });
});
