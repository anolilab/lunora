import { describe, expect, it } from "vitest";

import type { ShardMetricsResult } from "../../../src/features/reports/metrics-aggregate";
import {
    aggregateMetrics,
    computeDelta,
    computeLatencyPercentiles,
    enrichQueryStats,
    percentile,
    shardsToAggregate,
} from "../../../src/features/reports/metrics-aggregate";
import type { MetricsSnapshot, QueryStatEntry, ShardMetrics } from "../../../src/lib/admin";

const snapshot = (over: Partial<ShardMetrics> = {}): ShardMetrics => {
    return {
        cache: null,
        databaseSize: 1000,
        errors: 1,
        requests: 10,
        shard: "s",
        sinceMs: 0,
        uptimeMs: 0,
        ...over,
    };
};

const ok = (shard: string, metrics: ShardMetrics): ShardMetricsResult => {
    return { error: null, metrics, shard };
};
const down = (shard: string): ShardMetricsResult => {
    return { error: "ADMIN_FORBIDDEN", metrics: null, shard };
};

describe("aggregateMetrics", () => {
    it("sums counters and database size across reachable shards", () => {
        expect.assertions(4);

        const agg = aggregateMetrics([
            ok("a", snapshot({ databaseSize: 1000, errors: 1, requests: 10 })),
            ok("b", snapshot({ databaseSize: 500, errors: 2, requests: 30 })),
        ]);

        expect(agg.totalRequests).toBe(40);
        expect(agg.totalErrors).toBe(3);
        expect(agg.totalDatabaseSize).toBe(1500);
        expect(agg.reachable).toBe(2);
    });

    it("counts unreachable shards as failed without throwing", () => {
        expect.assertions(2);

        const agg = aggregateMetrics([ok("a", snapshot()), down("b")]);

        expect(agg.reachable).toBe(1);
        expect(agg.failed).toBe(1);
    });

    it("weights the combined cache hit-rate by hits+misses", () => {
        expect.assertions(1);

        const agg = aggregateMetrics([
            ok("a", snapshot({ cache: { bytes: 0, entries: 0, evictions: 0, hits: 90, misses: 10 } })),
            ok("b", snapshot({ cache: { bytes: 0, entries: 0, evictions: 0, hits: 0, misses: 100 } })),
        ]);

        // (90 + 0) / (100 + 100) = 0.45 — the busy shard doesn't get averaged away.
        expect(agg.hitRate).toBeCloseTo(0.45, 5);
    });

    it("reports a null hit-rate when no shard has a cache", () => {
        expect.assertions(1);

        expect(aggregateMetrics([ok("a", snapshot({ cache: null }))]).hitRate).toBeNull();
    });

    it("skips null databaseSize shards in the size total", () => {
        expect.assertions(1);

        const agg = aggregateMetrics([ok("a", snapshot({ databaseSize: 200 })), ok("b", snapshot({ databaseSize: null }))]);

        expect(agg.totalDatabaseSize).toBe(200);
    });
});

describe("shardsToAggregate", () => {
    it("unions root, current, and recents, de-duplicated and root-first", () => {
        expect.assertions(1);

        expect(shardsToAggregate("room-1", ["room-2", "room-1"])).toEqual(["", "room-1", "room-2"]);
    });

    it("keeps just the root shard when current is blank and there are no recents", () => {
        expect.assertions(1);

        expect(shardsToAggregate("", [])).toEqual([""]);
    });

    it("trims the current shard before de-duplicating", () => {
        expect.assertions(1);

        expect(shardsToAggregate("  room-1  ", ["room-1"])).toEqual(["", "room-1"]);
    });
});

describe("percentile", () => {
    it("returns 0 for an empty array", () => {
        expect.assertions(1);

        expect(percentile([], 90)).toBe(0);
    });

    it("returns the sole element for a single-element array", () => {
        expect.assertions(1);

        expect(percentile([42], 90)).toBe(42);
    });

    it("computes P50 on an odd-length sorted array", () => {
        expect.assertions(1);

        // [1, 2, 3, 4, 5]: ceil(0.5 * 5) - 1 = 2, values[2] = 3
        expect(percentile([3, 1, 4, 1, 5], 50)).toBe(3);
    });

    it("computes P90 from nearest-rank", () => {
        expect.assertions(1);

        // [1..10]: ceil(0.9 * 10) - 1 = 8, values[8] = 9
        expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    });

    it("returns the max value at P100", () => {
        expect.assertions(1);

        expect(percentile([5, 3, 8, 1], 100)).toBe(8);
    });

    it("returns the min value at P0", () => {
        expect.assertions(1);

        expect(percentile([5, 3, 8, 1], 0)).toBe(1);
    });
});

describe("computeDelta", () => {
    it("computes absolute delta and percentage", () => {
        expect.assertions(2);

        const d = computeDelta(100, 120, "bad");

        expect(d.delta).toBe(20);
        expect(d.pct).toBeCloseTo(20, 5);
    });

    it("returns null pct when baseline is zero", () => {
        expect.assertions(1);

        expect(computeDelta(0, 50).pct).toBeNull();
    });

    it("defaults direction to neutral", () => {
        expect.assertions(1);

        expect(computeDelta(10, 20).direction).toBe("neutral");
    });

    it("preserves the provided direction", () => {
        expect.assertions(1);

        expect(computeDelta(10, 5, "good").direction).toBe("good");
    });

    it("handles negative deltas (decrease)", () => {
        expect.assertions(2);

        const d = computeDelta(200, 150, "good");

        expect(d.delta).toBe(-50);
        expect(d.pct).toBeCloseTo(-25, 5);
    });
});

describe("computeLatencyPercentiles", () => {
    const makeSnapshot = (fns: { calls: number; totalDurationMs: number }[]): MetricsSnapshot => {
        return {
            cache: null,
            databaseSize: null,
            errors: 0,
            functions: fns as MetricsSnapshot["functions"],
            requests: 0,
            shard: "",
            sinceMs: 0,
            uptimeMs: 0,
        };
    };

    it("returns { p90: 0, p95: 0 } when the snapshot has no function data", () => {
        expect.assertions(2);

        const r = computeLatencyPercentiles({ cache: null, databaseSize: null, errors: 0, requests: 0, shard: "", sinceMs: 0, uptimeMs: 0 });

        expect(r.p90).toBe(0);
        expect(r.p95).toBe(0);
    });

    it("returns { p90: 0, p95: 0 } when all functions have 0 calls", () => {
        expect.assertions(2);

        const r = computeLatencyPercentiles(makeSnapshot([{ calls: 0, totalDurationMs: 100 }]));

        expect(r.p90).toBe(0);
        expect(r.p95).toBe(0);
    });

    it("computes p90 and p95 from per-function averages weighted by call count", () => {
        expect.assertions(2);

        // One function: 10 calls at 20ms avg → 10 samples of 20.
        // P90 = 20, P95 = 20 (single value).
        const r = computeLatencyPercentiles(makeSnapshot([{ calls: 10, totalDurationMs: 200 }]));

        expect(r.p90).toBeCloseTo(20, 5);
        expect(r.p95).toBeCloseTo(20, 5);
    });
});

describe("enrichQueryStats", () => {
    const entry = (over: Partial<QueryStatEntry> = {}): QueryStatEntry => {
        return {
            execCount: 1,
            normalizedSql: "SELECT 1",
            rowsRead: 0,
            rowsWritten: 0,
            totalDurationMs: 50,
            ...over,
        };
    };

    it("computes avgDurationMs as totalDurationMs / execCount", () => {
        expect.assertions(1);

        const enriched = enrichQueryStats([entry({ execCount: 4, totalDurationMs: 200 })]);

        expect(enriched[0]!.avgDurationMs).toBeCloseTo(50, 5);
    });

    it("sets avgDurationMs to 0 when execCount is 0", () => {
        expect.assertions(1);

        const enriched = enrichQueryStats([entry({ execCount: 0, totalDurationMs: 0 })]);

        expect(enriched[0]!.avgDurationMs).toBe(0);
    });

    it("passes through all original fields", () => {
        expect.assertions(4);

        const e = entry({ execCount: 2, normalizedSql: "SELECT id FROM t", rowsRead: 10, totalDurationMs: 80 });
        const enriched = enrichQueryStats([e]);

        expect(enriched[0]!.normalizedSql).toBe("SELECT id FROM t");
        expect(enriched[0]!.execCount).toBe(2);
        expect(enriched[0]!.rowsRead).toBe(10);
        expect(enriched[0]!.totalDurationMs).toBe(80);
    });
});
