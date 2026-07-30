import { describe, expect, it } from "vitest";

import {
    ensureFunctionMetricsTables,
    FUNCTION_METRICS_BUCKET_MS,
    FUNCTION_METRICS_BUCKET_RETENTION,
    FUNCTION_METRICS_MAX_PATHS,
    FUNCTION_METRICS_TABLE,
    mergeScanAttribution,
    readFunctionMetricBuckets,
    readFunctionMetricIndexHits,
    readFunctionMetrics,
    readFunctionMetricScans,
    readFunctionMetricsTotals,
    recordFunctionMetric,
} from "../src/function-metrics";
import createSqliteExec from "./_helpers/node-sqlite";

/** A dispatch with every field the recorder reads, so each test varies only what it is about. */
const dispatch = (overrides: Partial<Parameters<typeof recordFunctionMetric>[1]> = {}) => {
    return { durationMs: 10, errored: false, path: "posts:list", ts: 1_000_000, ...overrides };
};

describe("ensureFunctionMetricsTables", () => {
    it("is idempotent, so read and write paths can both call it defensively", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        ensureFunctionMetricsTables(sql);

        // Both paths call this unconditionally; a second call that threw would
        // make the first read after a write fail on a live shard.
        expect(() => {
            ensureFunctionMetricsTables(sql);
        }).not.toThrow();
    });

    it("adds `scans` and `conflicts` to an accumulator that predates them", () => {
        expect.assertions(2);

        const harness = createSqliteExec();
        const { sql } = harness;

        // A shard created before the causal-attribution and write-contention
        // features has the original column set. The guarded ALTER TABLE is the
        // only thing standing between that shard and a broken upsert, so the
        // pre-feature shape is built by hand here rather than assumed.
        harness.raw(`CREATE TABLE "${FUNCTION_METRICS_TABLE}" (
            path TEXT PRIMARY KEY,
            calls INTEGER NOT NULL DEFAULT 0,
            errors INTEGER NOT NULL DEFAULT 0,
            total_duration_ms REAL NOT NULL DEFAULT 0,
            min_duration_ms REAL,
            max_duration_ms REAL NOT NULL DEFAULT 0,
            last_called_at REAL NOT NULL DEFAULT 0,
            last_error_at REAL,
            last_error_message TEXT
        )`);

        ensureFunctionMetricsTables(sql);

        const columns = harness.raw(`PRAGMA table_info("${FUNCTION_METRICS_TABLE}")`).map((row) => row["name"]);

        expect(columns).toContain("scans");
        expect(columns).toContain("conflicts");
    });
});

describe("recordFunctionMetric", () => {
    it("folds repeat dispatches into one accumulator row", () => {
        expect.assertions(5);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ durationMs: 10, ts: 1000 }));
        recordFunctionMetric(sql, dispatch({ durationMs: 30, ts: 2000 }));

        const [row] = readFunctionMetrics(sql);

        expect(row?.calls).toBe(2);
        expect(row?.totalDurationMs).toBe(40);
        expect(row?.maxDurationMs).toBe(30);

        // `last_called_at` advancing is what orders the studio panel; a stale
        // value would freeze the busiest function at its first call.
        expect(row?.lastCalledAt).toBe(2000);
        expect(row?.errors).toBe(0);
    });

    it("keeps the smallest latency as the minimum when a faster call follows a slower one", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ durationMs: 50 }));
        recordFunctionMetric(sql, dispatch({ durationMs: 5 }));

        // MIN over a column that starts NULL is the subtle one: a naive
        // `MIN(min_duration_ms, excluded...)` yields NULL forever on SQLite.
        const [row] = harness.raw(`SELECT min_duration_ms FROM "${FUNCTION_METRICS_TABLE}"`);

        expect(row?.["min_duration_ms"]).toBe(5);
    });

    it("seeds the minimum from the very first sample rather than leaving it null", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ durationMs: 12 }));

        const [row] = harness.raw(`SELECT min_duration_ms FROM "${FUNCTION_METRICS_TABLE}"`);

        expect(row?.["min_duration_ms"]).toBe(12);
    });

    it("records the failure message and timestamp when a dispatch throws", () => {
        expect.assertions(3);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ errored: true, errorMessage: "boom", ts: 5000 }));

        const [row] = readFunctionMetrics(sql);

        expect(row?.errors).toBe(1);
        expect(row?.lastErrorAt).toBe(5000);
        expect(row?.lastErrorMessage).toBe("boom");
    });

    it("does not let a later success clear the most recent error", () => {
        expect.assertions(3);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ errored: true, errorMessage: "boom", ts: 5000 }));
        recordFunctionMetric(sql, dispatch({ errored: false, ts: 6000 }));

        const [row] = readFunctionMetrics(sql);

        // The operator opens this panel *because* something failed. Clearing the
        // message on the next healthy call is how the evidence disappears.
        expect(row?.lastErrorMessage).toBe("boom");
        expect(row?.lastErrorAt).toBe(5000);
        expect(row?.errors).toBe(1);
    });

    it("counts a conflicted dispatch as both an error and a conflict", () => {
        expect.assertions(2);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ conflicted: true, errored: true }));

        const [row] = readFunctionMetrics(sql);

        // Conflicts are documented as a subset of errors — the write-contention
        // advisor reads the ratio, so double-counting or under-counting skews it.
        expect(row?.conflicts).toBe(1);
        expect(row?.errors).toBe(1);
    });

    it("attributes one scan per distinct table even when a handler stamps the same one twice", () => {
        expect.assertions(3);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ scannedTables: ["posts", "posts", "users"] }));

        const [row] = readFunctionMetrics(sql);

        // A handler can stamp SCAN_DEP repeatedly within one request; charging
        // per stamp would inflate the "slow BECAUSE it scanned X" signal.
        expect(row?.scans).toBe(2);
        expect(readFunctionMetricScans(sql).get("posts:list")).toStrictEqual([
            { scans: 1, table: "posts" },
            { scans: 1, table: "users" },
        ]);
        expect(row?.scannedTables).toHaveLength(2);
    });

    it("counts one index read per distinct table/index pair per dispatch", () => {
        expect.assertions(2);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(
            sql,
            dispatch({
                indexHits: [
                    { index: "byAuthor", table: "posts" },
                    { index: "byAuthor", table: "posts" },
                    { index: "byEmail", table: "users" },
                ],
            }),
        );

        // Cumulative and non-decaying: the dead-index lint treats any non-zero
        // count as proof of life, so per-row counting would make one narrowed
        // read look like many.
        expect(readFunctionMetricIndexHits(sql)).toStrictEqual([
            { index: "byAuthor", reads: 1, table: "posts" },
            { index: "byEmail", reads: 1, table: "users" },
        ]);

        recordFunctionMetric(sql, dispatch({ indexHits: [{ index: "byAuthor", table: "posts" }] }));

        expect(readFunctionMetricIndexHits(sql)[0]?.reads).toBe(2);
    });

    it("leaves the satellite tables untouched for a plain indexed dispatch", () => {
        expect.assertions(2);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch());

        // The hot path is documented as two upserts plus a trim. Rows appearing
        // here would mean every call pays for attribution it never used.
        expect(readFunctionMetricScans(sql).size).toBe(0);
        expect(readFunctionMetricIndexHits(sql)).toStrictEqual([]);
    });

    it("drops a brand-new path once the accumulator is at its cap", () => {
        expect.assertions(2);

        const harness = createSqliteExec();
        const { sql } = harness;

        ensureFunctionMetricsTables(sql);

        // The cap exists because `path` is attacker-reachable: a FUNCTION_NOT_FOUND
        // dispatch still records under the caller-supplied name. Seeding straight
        // to the limit keeps this a test of the guard, not of 5000 upserts.
        for (let index = 0; index < FUNCTION_METRICS_MAX_PATHS; index += 1) {
            harness.raw(`INSERT INTO "${FUNCTION_METRICS_TABLE}" (path) VALUES (?)`, `seed:${String(index)}`);
        }

        recordFunctionMetric(sql, dispatch({ path: "attacker:random" }));

        const [count] = harness.raw(`SELECT COUNT(*) AS n FROM "${FUNCTION_METRICS_TABLE}"`);

        expect(count?.["n"]).toBe(FUNCTION_METRICS_MAX_PATHS);
        expect(harness.raw(`SELECT path FROM "${FUNCTION_METRICS_TABLE}" WHERE path = 'attacker:random'`)).toStrictEqual([]);
    });

    it("keeps accumulating an already-tracked path past the cap", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        ensureFunctionMetricsTables(sql);

        for (let index = 0; index < FUNCTION_METRICS_MAX_PATHS - 1; index += 1) {
            harness.raw(`INSERT INTO "${FUNCTION_METRICS_TABLE}" (path) VALUES (?)`, `seed:${String(index)}`);
        }

        recordFunctionMetric(sql, dispatch({ path: "posts:list" }));
        recordFunctionMetric(sql, dispatch({ path: "posts:list" }));

        // A real app that legitimately reaches the cap must not lose metrics for
        // the functions it already tracks — only new paths are refused.
        const [row] = harness.raw(`SELECT calls FROM "${FUNCTION_METRICS_TABLE}" WHERE path = 'posts:list'`);

        expect(row?.["calls"]).toBe(2);
    });
});

describe("time-series buckets", () => {
    it("groups dispatches within one window into a single bucket", () => {
        expect.assertions(3);

        const harness = createSqliteExec();
        const { sql } = harness;

        const base = FUNCTION_METRICS_BUCKET_MS * 10;

        recordFunctionMetric(sql, dispatch({ ts: base + 1 }));
        recordFunctionMetric(sql, dispatch({ errored: true, ts: base + 500 }));

        const buckets = readFunctionMetricBuckets(sql, "posts:list");

        expect(buckets).toHaveLength(1);
        expect(buckets[0]?.calls).toBe(2);
        expect(buckets[0]?.errors).toBe(1);
    });

    it("floors each bucket to its window start so samples land on one grid", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        const base = FUNCTION_METRICS_BUCKET_MS * 10;

        recordFunctionMetric(sql, dispatch({ ts: base + 59_999 }));

        // Charting depends on a fixed grid; an unfloored timestamp gives every
        // call its own bucket and the retention trim never coalesces.
        expect(readFunctionMetricBuckets(sql, "posts:list")[0]?.bucketMs).toBe(base);
    });

    it("returns buckets oldest-first so a chart plots left to right", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        const base = FUNCTION_METRICS_BUCKET_MS * 10;

        recordFunctionMetric(sql, dispatch({ ts: base + FUNCTION_METRICS_BUCKET_MS * 2 }));
        recordFunctionMetric(sql, dispatch({ ts: base }));

        expect(readFunctionMetricBuckets(sql, "posts:list").map((bucket) => bucket.bucketMs)).toStrictEqual([base, base + FUNCTION_METRICS_BUCKET_MS * 2]);
    });

    it("trims buckets older than the retention window", () => {
        expect.assertions(2);

        const harness = createSqliteExec();
        const { sql } = harness;

        const recent = FUNCTION_METRICS_BUCKET_MS * (FUNCTION_METRICS_BUCKET_RETENTION + 10);

        recordFunctionMetric(sql, dispatch({ ts: 0 }));
        recordFunctionMetric(sql, dispatch({ ts: recent }));

        const buckets = readFunctionMetricBuckets(sql, "posts:list");

        // Unbounded history is how a per-minute series eventually fills the
        // shard's SQLite store alongside the app's real data.
        expect(buckets).toHaveLength(1);
        expect(buckets[0]?.bucketMs).toBe(recent);
    });

    it("trims only the path being written", () => {
        expect.assertions(2);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ path: "old:fn", ts: 0 }));
        recordFunctionMetric(sql, dispatch({ path: "new:fn", ts: FUNCTION_METRICS_BUCKET_MS * (FUNCTION_METRICS_BUCKET_RETENTION + 10) }));

        // The trim's subquery is scoped by path. Were it global, one busy
        // function's clock would evict every other function's history.
        expect(readFunctionMetricBuckets(sql, "old:fn")).toHaveLength(1);
        expect(readFunctionMetricBuckets(sql, "new:fn")).toHaveLength(1);
    });

    it("returns every path's buckets when no path is given", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ path: "a:fn" }));
        recordFunctionMetric(sql, dispatch({ path: "b:fn" }));

        expect(
            readFunctionMetricBuckets(sql)
                .map((bucket) => bucket.path)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(["a:fn", "b:fn"]);
    });
});

describe("reads on a never-called shard", () => {
    it("return empty rather than throwing on a missing table", () => {
        expect.assertions(5);

        const harness = createSqliteExec();
        const { sql } = harness;

        // Every read calls `ensureFunctionMetricsTables` first for exactly this
        // reason: the studio opens these panels before any function has run.
        expect(readFunctionMetrics(sql)).toStrictEqual([]);
        expect(readFunctionMetricBuckets(sql)).toStrictEqual([]);
        expect(readFunctionMetricScans(sql).size).toBe(0);
        expect(readFunctionMetricIndexHits(sql)).toStrictEqual([]);
        expect(readFunctionMetricsTotals(sql)).toStrictEqual({ errors: 0, requests: 0 });
    });
});

describe("readFunctionMetrics", () => {
    it("orders rows newest-called first", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ path: "old:fn", ts: 1000 }));
        recordFunctionMetric(sql, dispatch({ path: "new:fn", ts: 9000 }));

        expect(readFunctionMetrics(sql).map((row) => row.path)).toStrictEqual(["new:fn", "old:fn"]);
    });

    it("leads a function's scan attribution with its busiest table", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ scannedTables: ["users"] }));
        recordFunctionMetric(sql, dispatch({ scannedTables: ["posts"] }));
        recordFunctionMetric(sql, dispatch({ scannedTables: ["posts"] }));

        // The causal read says "slow BECAUSE it scanned X"; X has to be the
        // dominant table, not whichever happened to be inserted first.
        expect(readFunctionMetrics(sql)[0]?.scannedTables).toStrictEqual([
            { scans: 2, table: "posts" },
            { scans: 1, table: "users" },
        ]);
    });

    it("gives a function with no scans an empty attribution list, not undefined", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch());

        expect(readFunctionMetrics(sql)[0]?.scannedTables).toStrictEqual([]);
    });
});

describe("readFunctionMetricsTotals", () => {
    it("sums lifetime calls and errors across every function", () => {
        expect.assertions(1);

        const harness = createSqliteExec();
        const { sql } = harness;

        recordFunctionMetric(sql, dispatch({ path: "a:fn" }));
        recordFunctionMetric(sql, dispatch({ errored: true, path: "b:fn" }));
        recordFunctionMetric(sql, dispatch({ path: "b:fn" }));

        expect(readFunctionMetricsTotals(sql)).toStrictEqual({ errors: 1, requests: 3 });
    });
});

describe("mergeScanAttribution", () => {
    it("adds a table it has not seen", () => {
        expect.assertions(1);

        expect(mergeScanAttribution([], ["posts"])).toStrictEqual([{ scans: 1, table: "posts" }]);
    });

    it("increments a table already in the list", () => {
        expect.assertions(1);

        expect(mergeScanAttribution([{ scans: 3, table: "posts" }], ["posts"])).toStrictEqual([{ scans: 4, table: "posts" }]);
    });

    it("re-sorts busiest-first, ties broken by table name", () => {
        expect.assertions(1);

        const merged = mergeScanAttribution([{ scans: 1, table: "zebra" }], ["posts", "posts", "alpha"]);

        // This is the in-memory twin of the SQL read's ORDER BY. If the two
        // disagree, the warm-instance fallback shows a different dominant table
        // than the durable read for the same workload.
        expect(merged).toStrictEqual([
            { scans: 2, table: "posts" },
            { scans: 1, table: "alpha" },
            { scans: 1, table: "zebra" },
        ]);
    });

    it("mutates and returns the same array the caller passed", () => {
        expect.assertions(1);

        const into = [{ scans: 1, table: "posts" }];

        // Documented as mutating `into`; a copy-returning version would silently
        // drop accumulation at call sites that ignore the return value.
        expect(mergeScanAttribution(into, ["posts"])).toBe(into);
    });
});
