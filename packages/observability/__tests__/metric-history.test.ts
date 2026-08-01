import type { SqlExec } from "@lunora/shard-engine";
import { afterEach, describe, expect, it } from "vitest";

import type { MetricEvent } from "../../../shared/metric-event";
import { readMetricHistory, recordMetricHistory } from "../src/metric-history";
import createSqliteExec from "./_helpers/node-sqlite";

/** Build a MetricEvent, defaulting the boilerplate so each test states only what it exercises. */
const event = (over: Partial<MetricEvent> & Pick<MetricEvent, "kind" | "name" | "value">): MetricEvent => {
    return {
        functionPath: "orders:checkout",
        ts: 1_749_300_000_000,
        ...over,
    };
};

const MINUTE = 60_000;

describe("metricHistory", () => {
    // Per-test SQLite handle, torn down below — shared by both nested describe
    // blocks so the harness setup isn't duplicated.
    let harness: ReturnType<typeof createSqliteExec> | undefined;

    const makeSql = (): SqlExec => {
        harness = createSqliteExec();

        return harness.sql;
    };

    afterEach(() => {
        harness?.close();
        harness = undefined;
    });

    describe("recording and reading", () => {
        it("folds measurements in the same minute into one bucket", () => {
            expect.assertions(5);

            const sql = makeSql();
            const base = 1_749_300_000_000;

            recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base + 1000, value: 2 }));
            recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base + 2000, value: 3 }));

            const { series } = readMetricHistory(sql);
            const [point] = series[0]?.points ?? [];

            expect(series).toHaveLength(1);
            expect(series[0]?.points).toHaveLength(1);
            expect(point?.count).toBe(2);
            expect(point?.sum).toBe(5);
            expect(point?.max).toBe(3);
        });

        it("folds many repeats of one series correctly (the known-bucket cache path)", () => {
            expect.assertions(3);

            const sql = makeSql();
            const base = 1_749_300_000_000;

            // The first call primes the known-bucket set; every later call is a cache
            // hit that skips the existence read and goes straight to the upsert. The
            // fold must still be exact — the cache stores membership, never values.
            for (let index = 0; index < 50; index += 1) {
                recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base + index, value: 1 }));
            }

            const { series } = readMetricHistory(sql);
            const [point] = series[0]?.points ?? [];

            expect(series[0]?.points).toHaveLength(1);
            expect(point?.count).toBe(50);
            expect(point?.sum).toBe(50);
        });

        it("does not resurrect a bucket the retention trim removed (late out-of-window sample)", () => {
            expect.assertions(2);

            const sql = makeSql();
            const base = 1_749_300_000_000;
            // METRIC_HISTORY_BUCKET_RETENTION — buckets older than this many minutes
            // behind the newest are trimmed.
            const retention = 1440;

            // One bucket, then a bucket far enough ahead that the first falls outside
            // the retention window and is trimmed the moment the second arrives.
            recordMetricHistory(sql, event({ kind: "counter", name: "m", ts: base, value: 1 }));
            recordMetricHistory(sql, event({ kind: "counter", name: "m", ts: base + (retention + 1) * MINUTE, value: 1 }));

            // Re-record the OLD (now-trimmed) bucket. The known-bucket cache must NOT
            // have marked it as durable — this write must re-check and re-trim it,
            // leaving only the in-window bucket rather than an expired row.
            recordMetricHistory(sql, event({ kind: "counter", name: "m", ts: base, value: 1 }));

            const points = readMetricHistory(sql).series[0]?.points ?? [];

            expect(points).toHaveLength(1);
            expect(points[0]?.bucketMs).toBe(base + (retention + 1) * MINUTE);
        });

        it("splits measurements across minute boundaries into separate buckets", () => {
            expect.assertions(3);

            const sql = makeSql();
            const base = Math.floor(1_749_300_000_000 / MINUTE) * MINUTE;

            recordMetricHistory(sql, event({ kind: "histogram", name: "checkout.ms", ts: base + 1000, value: 100 }));
            recordMetricHistory(sql, event({ kind: "histogram", name: "checkout.ms", ts: base + MINUTE + 1000, value: 200 }));

            const { series } = readMetricHistory(sql);
            const points = series[0]?.points ?? [];

            expect(points).toHaveLength(2);
            // Ascending time order.
            expect(points[0]?.bucketMs).toBeLessThan(points[1]?.bucketMs ?? 0);
            expect(points[1]?.last).toBe(200);
        });

        it("keeps series distinct by name, kind, and dimensions", () => {
            expect.assertions(2);

            const sql = makeSql();

            recordMetricHistory(sql, event({ kind: "counter", name: "http.requests", value: 1 }));
            recordMetricHistory(sql, event({ attributes: { route: "/a" }, kind: "counter", name: "http.requests", value: 1 }));
            recordMetricHistory(sql, event({ kind: "gauge", name: "http.requests", value: 1 }));
            // Dimension key order must not create a distinct series.
            recordMetricHistory(sql, event({ attributes: { region: "eu", route: "/a" }, kind: "counter", name: "http.requests", value: 1 }));
            recordMetricHistory(sql, event({ attributes: { route: "/a", region: "eu" }, kind: "counter", name: "http.requests", value: 1 }));

            const { series } = readMetricHistory(sql);

            expect(series).toHaveLength(4);

            const eu = series.find((s) => s.attributes?.region === "eu" && s.attributes.route === "/a");

            expect(eu?.points[0]?.count).toBe(2);
        });

        it("stores an exemplar traceId per bucket, latest sample winning", () => {
            expect.assertions(2);

            const sql = makeSql();
            const base = Math.floor(1_749_300_000_000 / MINUTE) * MINUTE;

            recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base + 1000, value: 1 }), "trace-a");
            recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base + 2000, value: 1 }), "trace-b");

            const point = readMetricHistory(sql).series[0]?.points[0];

            expect(point?.exemplarTraceId).toBe("trace-b");

            // A later sample without a trace leaves the exemplar intact.
            recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base + 3000, value: 1 }));

            expect(readMetricHistory(sql).series[0]?.points[0]?.exemplarTraceId).toBe("trace-b");
        });

        it("trims buckets older than the retention window", () => {
            expect.assertions(2);

            const sql = makeSql();
            const base = Math.floor(1_749_300_000_000 / MINUTE) * MINUTE;

            // One ancient bucket, then one 2000 minutes later (past the 1440 retention).
            recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base, value: 1 }));
            recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base + 2000 * MINUTE, value: 1 }));

            const points = readMetricHistory(sql).series[0]?.points ?? [];

            expect(points).toHaveLength(1);
            expect(points[0]?.bucketMs).toBe(base + 2000 * MINUTE);
        });

        it("windows the read to buckets at or after sinceMs", () => {
            expect.assertions(1);

            const sql = makeSql();
            const base = Math.floor(1_749_300_000_000 / MINUTE) * MINUTE;

            recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base, value: 1 }));
            recordMetricHistory(sql, event({ kind: "counter", name: "orders.placed", ts: base + 5 * MINUTE, value: 1 }));

            const { series } = readMetricHistory(sql, { sinceMs: base + 3 * MINUTE });

            expect(series[0]?.points).toHaveLength(1);
        });
    });

    describe("distinct-series cap eviction", () => {
        it("evicts the least-recently-updated series to admit a genuinely new one at the cap", () => {
            expect.assertions(3);

            const sql = makeSql();
            const base = Math.floor(1_749_300_000_000 / MINUTE) * MINUTE;
            const maxSeries = 5;

            // Fill the cap, oldest first — series `s0` ends up with the smallest
            // `MAX(last_ts)` since it is never touched again.
            for (let index = 0; index < maxSeries; index += 1) {
                recordMetricHistory(sql, event({ kind: "counter", name: `s${String(index)}`, ts: base + index * 1000, value: 1 }), undefined, { maxSeries });
            }

            // A genuinely new series arrives at capacity.
            recordMetricHistory(sql, event({ kind: "counter", name: "new-series", ts: base + maxSeries * 1000, value: 1 }), undefined, { maxSeries });

            const { series } = readMetricHistory(sql);
            const names = series.map((s) => s.name);

            // The new series was admitted — pre-fix this is absent.
            expect(names).toContain("new-series");
            // The coldest series (`s0`, the oldest `last_ts`) was evicted to make room.
            expect(names).not.toContain("s0");
            // Every other pre-existing series survived — only the coldest was evicted.
            expect(names).toHaveLength(maxSeries);
        });

        it("keeps accumulating an already-tracked series past the cap", () => {
            expect.assertions(1);

            const sql = makeSql();
            const base = Math.floor(1_749_300_000_000 / MINUTE) * MINUTE;
            const maxSeries = 5;

            for (let index = 0; index < maxSeries; index += 1) {
                recordMetricHistory(sql, event({ kind: "counter", name: `s${String(index)}`, ts: base + index * 1000, value: 1 }), undefined, { maxSeries });
            }

            // A second measurement for an already-tracked series must never be
            // refused, however full the table is.
            recordMetricHistory(sql, event({ kind: "counter", name: "s3", ts: base + 9000, value: 1 }), undefined, { maxSeries });

            const { series } = readMetricHistory(sql);

            expect(series.find((s) => s.name === "s3")?.points[0]?.count).toBe(2);
        });

        it("reports capped on readMetricHistory once the series count reaches the cap", () => {
            expect.assertions(2);

            const sql = makeSql();
            const base = Math.floor(1_749_300_000_000 / MINUTE) * MINUTE;
            const maxSeries = 5;

            for (let index = 0; index < maxSeries - 1; index += 1) {
                recordMetricHistory(sql, event({ kind: "counter", name: `s${String(index)}`, ts: base + index * 1000, value: 1 }), undefined, { maxSeries });
            }

            expect(readMetricHistory(sql, { maxSeries }).capped).toBe(false);

            recordMetricHistory(sql, event({ kind: "counter", name: `s${String(maxSeries - 1)}`, ts: base + maxSeries * 1000, value: 1 }), undefined, {
                maxSeries,
            });

            expect(readMetricHistory(sql, { maxSeries }).capped).toBe(true);
        });
    });
});
