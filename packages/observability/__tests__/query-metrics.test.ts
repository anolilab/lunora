import type { SqlExec } from "@lunora/shard-engine";
import { describe, expect, it, vi } from "vitest";

import {
    ensureQueryMetricsTable,
    hashStatement,
    normalizeSql,
    pruneQueryBuckets,
    QUERY_BUCKET_RETENTION,
    QUERY_METRICS_MAX_SQL_LEN,
    QUERY_METRICS_MAX_STATEMENTS,
    QUERY_METRICS_TABLE,
    readQueryInsights,
    readQueryMetrics,
    recordQueryMetric,
} from "../src/query-metrics";
import freshHandleOver from "./_helpers/fresh-handle";
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

describe("ensureQueryMetricsTable", () => {
    it("backfills last_seen_at on a table that predates the eviction feature", () => {
        expect.assertions(3);

        const harness = createSqliteExec();
        const { sql } = harness;

        try {
            // A shard created before the distinct-statement eviction landed has
            // the original column set — build that shape by hand rather than
            // assume the guarded `ALTER TABLE` is safe against it.
            harness.raw(`CREATE TABLE "${QUERY_METRICS_TABLE}" (
                normalized_sql TEXT PRIMARY KEY,
                exec_count     INTEGER NOT NULL DEFAULT 0,
                total_duration_ms REAL NOT NULL DEFAULT 0,
                rows_read      INTEGER NOT NULL DEFAULT 0,
                rows_written   INTEGER NOT NULL DEFAULT 0
            )`);

            expect(() => {
                ensureQueryMetricsTable(sql);
            }).not.toThrow();

            const columns = harness.raw(`PRAGMA table_info("${QUERY_METRICS_TABLE}")`).map((row) => row["name"]);

            expect(columns).toContain("last_seen_at");

            // A write against the back-filled table must not throw either —
            // the column is nullable, so the upsert's explicit `last_seen_at`
            // value is what populates it going forward.
            expect(() => {
                recordQueryMetric(sql, "SELECT * FROM posts WHERE id = 1", 5, 1, 0);
            }).not.toThrow();
        } finally {
            harness.close();
        }
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

    it("evicts the least-recently-seen statement to admit a genuinely new one at the cap", () => {
        expect.assertions(3);

        const { sql, close } = createSqliteExec();

        try {
            // Fill the table to the cap, oldest first — distinct explicit `now`
            // values make eviction order deterministic: `col0`'s statement ends
            // up with the smallest `last_seen_at`.
            for (let i = 0; i < QUERY_METRICS_MAX_STATEMENTS; i += 1) {
                // Use distinct column names to generate distinct normalized SQL (identifier numbers are kept).
                recordQueryMetric(sql, `SELECT col${String(i)} FROM t`, 1, 0, 0, i);
            }

            // A genuinely new statement arrives at capacity.
            recordQueryMetric(sql, "SELECT extra_col FROM t", 999, 0, 0, QUERY_METRICS_MAX_STATEMENTS);

            const rows = readQueryMetrics(sql);

            // Admitted, not dropped — the table stays bounded at the cap.
            expect(rows).toHaveLength(QUERY_METRICS_MAX_STATEMENTS);
            expect(rows.some((r) => r.normalizedSql.includes("extra_col"))).toBe(true);
            // The coldest statement (`col0`, the smallest `last_seen_at`) was
            // evicted to make room.
            expect(rows.some((r) => r.normalizedSql.includes("SELECT col0 "))).toBe(false);
        } finally {
            close();
        }
    }, 15_000);

    it("evicts the evicted statement's bucket rows too", () => {
        expect.assertions(1);

        const { sql, close } = createSqliteExec();

        try {
            for (let i = 0; i < QUERY_METRICS_MAX_STATEMENTS; i += 1) {
                recordQueryMetric(sql, `SELECT col${String(i)} FROM t`, 1, 0, 0, i);
            }

            const evictedHash = hashStatement(normalizeSql("SELECT col0 FROM t"));

            recordQueryMetric(sql, "SELECT extra_col FROM t", 999, 0, 0, QUERY_METRICS_MAX_STATEMENTS);

            // The bucket table (keyed by `sql_hash`) must not keep growing for a
            // statement no longer tracked in the lifetime table.
            const insights = readQueryInsights(sql, 60 * 60_000, QUERY_METRICS_MAX_STATEMENTS);

            expect(insights.entries.some((entry) => entry.normalizedSql === evictedHash)).toBe(false);
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

        expect(QUERY_METRICS_TABLE).toBe("__lunora_metrics_queries");
    });
});

describe("per-handle memoization (OBS-02)", () => {
    it("issues no CREATE TABLE and no COUNT(*) on the second execution of an already-seen statement", () => {
        expect.assertions(2);

        const { sql } = createSqliteExec();

        // Warm the handle: creates both tables and marks the statement known.
        recordQueryMetric(sql, "SELECT * FROM posts WHERE id = 1", 5, 1, 0);

        const original = sql.exec.bind(sql);
        const seen: string[] = [];

        vi.spyOn(sql, "exec").mockImplementation((query: string, ...parameters: unknown[]) => {
            seen.push(query);

            return (original as any)(query, ...parameters);
        });

        recordQueryMetric(sql, "SELECT * FROM posts WHERE id = 2", 6, 1, 0);

        expect(seen.some((query) => query.includes("CREATE TABLE"))).toBe(false);
        expect(seen.some((query) => query.includes("COUNT(*)"))).toBe(false);
    });

    it("re-ensures and re-verifies against durable state on a fresh post-hibernation handle", () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        recordQueryMetric(harness.sql, "SELECT * FROM posts WHERE id = 1", 5, 1, 0);

        // A brand-new handle over the same storage — the WeakSet/WeakMap
        // caches from the first handle must not leak across.
        const fresh = freshHandleOver(harness);

        expect(() => {
            recordQueryMetric(fresh, "SELECT * FROM posts WHERE id = 2", 6, 1, 0);
        }).not.toThrow();

        const rows = readQueryMetrics(fresh);

        expect(rows[0]?.execCount).toBe(2);
    });

    it("re-verifies the distinct-statement cap against durable state on a fresh post-hibernation handle", () => {
        expect.assertions(2);

        const harness = createSqliteExec();

        for (let index = 0; index < QUERY_METRICS_MAX_STATEMENTS; index += 1) {
            recordQueryMetric(harness.sql, `SELECT col${String(index)} FROM t`, 1, 0, 0, index);
        }

        // A fresh handle has no local cache of what's tracked — it must fall
        // back to the durable count rather than assuming an empty local cache
        // means the cap hasn't been reached.
        const fresh = freshHandleOver(harness);

        recordQueryMetric(fresh, "SELECT extra_col FROM t", 999, 0, 0, QUERY_METRICS_MAX_STATEMENTS);

        const rows = readQueryMetrics(fresh);

        // Admitted by evicting the coldest tracked statement, not refused
        // outright, and the table stays bounded at the cap.
        expect(rows.some((row) => row.normalizedSql.includes("extra_col"))).toBe(true);
        expect(rows).toHaveLength(QUERY_METRICS_MAX_STATEMENTS);
    }, 15_000);

    it("reports capped on readQueryInsights once the tracked-statement count reaches the cap", () => {
        expect.assertions(2);

        const { sql } = createSqliteExec();

        for (let index = 0; index < QUERY_METRICS_MAX_STATEMENTS - 1; index += 1) {
            recordQueryMetric(sql, `SELECT col${String(index)} FROM t`, 1, 0, 0, index);
        }

        expect(readQueryInsights(sql, 60_000, QUERY_METRICS_MAX_STATEMENTS).capped).toBe(false);

        recordQueryMetric(sql, `SELECT col${String(QUERY_METRICS_MAX_STATEMENTS - 1)} FROM t`, 1, 0, 0, QUERY_METRICS_MAX_STATEMENTS);

        expect(readQueryInsights(sql, 60_000, QUERY_METRICS_MAX_STATEMENTS).capped).toBe(true);
    }, 15_000);
});

describe("time-bucketed query insights", () => {
    const at = (minute: number): number => 1_700_000_000_000 + minute * 60_000;

    it("answers 'what is hot NOW' rather than 'since the shard was created'", () => {
        expect.assertions(2);

        const { sql } = createSqliteExec();

        // An old statement hammered 100× an hour ago…
        for (let index = 0; index < 100; index += 1) {
            recordQueryMetric(sql, "SELECT * FROM old", 1, 1, 0, at(0));
        }

        // …and a new one run 5× in the last minute.
        for (let index = 0; index < 5; index += 1) {
            recordQueryMetric(sql, "SELECT * FROM hot", 50, 1, 0, at(70));
        }

        const recent = readQueryInsights(sql, 5 * 60_000, at(70));

        // The lifetime leaderboard would rank `old` first on exec count; the
        // ranged read must only see what happened inside the window.
        expect(recent.entries).toHaveLength(1);
        expect(recent.entries[0]?.normalizedSql).toContain("hot");
    });

    it("interpolates percentiles from the latency histogram", () => {
        expect.assertions(2);

        const { sql } = createSqliteExec();

        // 90 fast executions and 10 slow: p50 sits in a low bucket, p95 in a high
        // one. Deliberately NOT 95/5 — at exactly 5% the 95th sample is still a
        // fast one, so nearest-rank p95 correctly reports the low bucket and the
        // assertion would be testing the boundary rather than the tail.
        for (let index = 0; index < 90; index += 1) {
            recordQueryMetric(sql, "SELECT * FROM t", 1, 1, 0, at(0));
        }

        for (let index = 0; index < 10; index += 1) {
            recordQueryMetric(sql, "SELECT * FROM t", 900, 1, 0, at(0));
        }

        const [entry] = readQueryInsights(sql, 5 * 60_000, at(0)).entries;

        expect(entry?.p50DurationMs).toBeLessThanOrEqual(5);
        expect(entry?.p95DurationMs).toBeGreaterThanOrEqual(500);
    });

    it("reports the tracked-statement cap so the UI can avoid implying totality", () => {
        expect.assertions(2);

        const { sql } = createSqliteExec();

        recordQueryMetric(sql, "SELECT 1", 1, 0, 0, at(0));

        const result = readQueryInsights(sql, 60_000, at(0));

        expect(result.capped).toBe(false);
        expect(result.trackedStatements).toBe(1);
    });

    it("emits one chart point per window, oldest first", () => {
        expect.assertions(2);

        const { sql } = createSqliteExec();

        recordQueryMetric(sql, "SELECT 1", 10, 0, 0, at(0));
        recordQueryMetric(sql, "SELECT 1", 30, 0, 0, at(1));

        const { buckets } = readQueryInsights(sql, 10 * 60_000, at(1));

        expect(buckets.map((bucket) => bucket.execCount)).toStrictEqual([1, 1]);
        expect(buckets[1]?.avgDurationMs).toBe(30);
    });

    it("prunes windows past the retention horizon", () => {
        expect.assertions(1);

        const { sql } = createSqliteExec();

        recordQueryMetric(sql, "SELECT 1", 1, 0, 0, at(0));
        pruneQueryBuckets(sql, at(QUERY_BUCKET_RETENTION + 10));

        // Bounded growth is load-bearing here: rows are statements × windows.
        expect(readQueryInsights(sql, 60 * 60_000, at(QUERY_BUCKET_RETENTION + 10)).entries).toStrictEqual([]);
    });

    it("never lets a bucket-table failure break the lifetime counters", () => {
        expect.assertions(2);

        const real = createSqliteExec().sql;
        // Fail ONLY the bucket table's statements, so the lifetime path is truly
        // exercised. Using a healthy handle here passed whether or not the
        // try/catch existed — a green test for an invariant it never checked.
        const sql = {
            exec: (query: string, ...parameters: unknown[]) => {
                if (query.includes("_queries_buckets")) {
                    throw new Error("bucket table unavailable");
                }

                return real.exec(query, ...parameters);
            },
        } as unknown as SqlExec;

        expect(() => {
            recordQueryMetric(sql, "SELECT 1", 5, 1, 0, at(0));
        }).not.toThrow();
        expect(readQueryMetrics(sql)[0]?.execCount).toBe(1);
    });
});
