import { describe, expect, it } from "vitest";

import type { ShardMetrics } from "../src/admin.js";
import type { ShardMetricsResult } from "../src/metrics-aggregate.js";
import { aggregateMetrics, shardsToAggregate } from "../src/metrics-aggregate.js";

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

const ok = (shard: string, metrics: ShardMetrics): ShardMetricsResult => { return { error: null, metrics, shard }; };
const down = (shard: string): ShardMetricsResult => { return { error: "ADMIN_FORBIDDEN", metrics: null, shard }; };

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
