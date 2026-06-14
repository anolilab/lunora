import { describe, expect, it } from "vitest";

import {
    normalizeSql,
    QUERY_METRICS_MAX_SQL_LEN,
    QUERY_METRICS_MAX_STATEMENTS,
    QUERY_METRICS_TABLE,
    readQueryMetrics,
    recordQueryMetric,
} from "../src/query-metrics";
import createSqliteExec from "./_helpers/node-sqlite";

describe("normalizeSql", () => {
    it("strips single-quoted string literals", () => {
        expect.assertions(1);

        expect(normalizeSql("SELECT * FROM users WHERE name = 'Alice'")).toBe("SELECT * FROM users WHERE name = ?");
    });

    it("strips nested escaped single quotes", () => {
        expect.assertions(1);

        expect(normalizeSql("SELECT * FROM t WHERE v = 'it''s fine'")).toBe("SELECT * FROM t WHERE v = ?");
    });

    it("strips hex literals", () => {
        expect.assertions(1);

        expect(normalizeSql("SELECT * FROM t WHERE id = 0xFF")).toBe("SELECT * FROM t WHERE id = ?");
    });

    it("strips numeric literals after = ( , or whitespace", () => {
        expect.assertions(2);

        expect(normalizeSql("SELECT * FROM t WHERE age > 30")).toBe("SELECT * FROM t WHERE age > ?");
        expect(normalizeSql("SELECT * FROM t LIMIT 10")).toBe("SELECT * FROM t LIMIT ?");
    });

    it("does not strip numbers inside identifiers", () => {
        expect.assertions(1);

        // table1 should not become table?
        expect(normalizeSql("SELECT * FROM table1")).toBe("SELECT * FROM table1");
    });

    it("collapses runs of whitespace to single space", () => {
        expect.assertions(1);

        expect(normalizeSql("SELECT  *\n  FROM\t  t")).toBe("SELECT * FROM t");
    });

    it("trims leading and trailing whitespace", () => {
        expect.assertions(1);

        expect(normalizeSql("  SELECT 1  ")).toBe("SELECT ?");
    });

    it("truncates to QUERY_METRICS_MAX_SQL_LEN with ellipsis", () => {
        expect.assertions(2);

        const long = `SELECT * FROM t WHERE col = ${"x".repeat(600)}`;
        const result = normalizeSql(long);

        expect(result).toHaveLength(QUERY_METRICS_MAX_SQL_LEN);
        expect(result.endsWith("…")).toBe(true);
    });

    it("preserves double-quoted identifiers unchanged", () => {
        expect.assertions(1);

        expect(normalizeSql(`SELECT "user_id" FROM t`)).toBe(`SELECT "user_id" FROM t`);
    });
});

describe("recordQueryMetric + readQueryMetrics", () => {
    it("creates the table and records one execution", () => {
        expect.assertions(5);

        const { sql, close } = createSqliteExec();

        try {
            recordQueryMetric(sql, "SELECT * FROM posts WHERE id = 1", 5.2, 3, 0);

            const rows = readQueryMetrics(sql);

            expect(rows).toHaveLength(1);
            expect(rows[0]!.normalizedSql).toBe("SELECT * FROM posts WHERE id = ?");
            expect(rows[0]!.execCount).toBe(1);
            expect(rows[0]!.totalDurationMs).toBeCloseTo(5.2, 5);
            expect(rows[0]!.rowsRead).toBe(3);
        } finally {
            close();
        }
    });

    it("accumulates subsequent executions via upsert", () => {
        expect.assertions(3);

        const { sql, close } = createSqliteExec();

        try {
            const stmt = "SELECT * FROM posts WHERE id = 1";

            recordQueryMetric(sql, stmt, 10, 2, 0);
            recordQueryMetric(sql, stmt, 20, 4, 0);
            recordQueryMetric(sql, stmt, 30, 6, 0);

            const rows = readQueryMetrics(sql);

            expect(rows).toHaveLength(1);
            expect(rows[0]!.execCount).toBe(3);
            expect(rows[0]!.totalDurationMs).toBeCloseTo(60, 5);
        } finally {
            close();
        }
    });

    it("normalizes before grouping — different literals map to same entry", () => {
        expect.assertions(2);

        const { sql, close } = createSqliteExec();

        try {
            recordQueryMetric(sql, "SELECT * FROM t WHERE id = 1", 1, 0, 0);
            recordQueryMetric(sql, "SELECT * FROM t WHERE id = 2", 2, 0, 0);
            recordQueryMetric(sql, "SELECT * FROM t WHERE id = 99", 3, 0, 0);

            const rows = readQueryMetrics(sql);

            expect(rows).toHaveLength(1);
            expect(rows[0]!.execCount).toBe(3);
        } finally {
            close();
        }
    });

    it("tracks rows_read and rows_written separately", () => {
        expect.assertions(2);

        const { sql, close } = createSqliteExec();

        try {
            recordQueryMetric(sql, "INSERT INTO t (v) VALUES (1)", 2, 0, 1);
            recordQueryMetric(sql, "INSERT INTO t (v) VALUES (2)", 3, 0, 2);

            const rows = readQueryMetrics(sql);

            expect(rows[0]!.rowsRead).toBe(0);
            expect(rows[0]!.rowsWritten).toBe(3);
        } finally {
            close();
        }
    });

    it("readQueryMetrics returns [] when no statements have been recorded", () => {
        expect.assertions(1);

        const { sql, close } = createSqliteExec();

        try {
            expect(readQueryMetrics(sql)).toEqual([]);
        } finally {
            close();
        }
    });

    it("orders results by total_duration_ms DESC", () => {
        expect.assertions(3);

        const { sql, close } = createSqliteExec();

        try {
            // Use structurally distinct SQL so normalization doesn't merge them.
            recordQueryMetric(sql, "SELECT col_a FROM t", 5, 0, 0);
            recordQueryMetric(sql, "SELECT col_b FROM t", 100, 0, 0);
            recordQueryMetric(sql, "SELECT col_c FROM t", 50, 0, 0);

            const rows = readQueryMetrics(sql);

            // col_b (100ms) > col_c (50ms) > col_a (5ms)
            expect(rows[0]!.totalDurationMs).toBeCloseTo(100, 5);
            expect(rows[1]!.totalDurationMs).toBeCloseTo(50, 5);
            expect(rows[2]!.totalDurationMs).toBeCloseTo(5, 5);
        } finally {
            close();
        }
    });

    it("skips new entries once the cap is reached", () => {
        expect.assertions(2);

        const { sql, close } = createSqliteExec();

        try {
            // Fill the table to the cap.
            for (let i = 0; i < QUERY_METRICS_MAX_STATEMENTS; i += 1) {
                // Use distinct column names to generate distinct normalized SQL (identifier numbers are kept).
                recordQueryMetric(sql, `SELECT col${String(i)} FROM t`, 1, 0, 0);
            }

            // Attempt to add one more new statement.
            recordQueryMetric(sql, "SELECT extra_col FROM t", 999, 0, 0);

            const rows = readQueryMetrics(sql);

            expect(rows).toHaveLength(QUERY_METRICS_MAX_STATEMENTS);

            // The extra statement must NOT appear (it was dropped).
            const found = rows.some((r) => r.normalizedSql.includes("extra_col"));

            expect(found).toBe(false);
        } finally {
            close();
        }
    }, 15_000);

    it("still updates an existing entry even when the cap is reached", () => {
        expect.assertions(2);

        const { sql, close } = createSqliteExec();

        try {
            // Record the target statement first, before the cap.
            recordQueryMetric(sql, "SELECT id FROM users WHERE id = 1", 10, 1, 0);

            // Fill the rest of the cap with other statements.
            for (let i = 0; i < QUERY_METRICS_MAX_STATEMENTS - 1; i += 1) {
                recordQueryMetric(sql, `SELECT col${String(i)} FROM t`, 1, 0, 0);
            }

            // Recording the existing statement again must update, not drop.
            recordQueryMetric(sql, "SELECT id FROM users WHERE id = 2", 20, 2, 0);

            const rows = readQueryMetrics(sql);
            const target = rows.find((r) => r.normalizedSql.includes("users"));

            expect(target).toBeDefined();
            expect(target!.execCount).toBe(2);
        } finally {
            close();
        }
    }, 15_000);

    it("uses the reserved table name", () => {
        expect.assertions(1);

        expect(QUERY_METRICS_TABLE).toBe("__cirrus_metrics_queries");
    });
});
