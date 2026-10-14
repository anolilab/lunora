import { describe, expect, it } from "vitest";

import type { ShardSloResult } from "../../../src/features/reports/slo-aggregate";
import { dedupeMigrations, mergeFunctionStats, sumShardMetrics } from "../../../src/features/reports/slo-aggregate";
import type { FunctionCallStat, MetricsSnapshot, MigrationStatusRow } from "../../../src/lib/admin";

const snapshot = (requests: number, errors: number, history: MetricsSnapshot["history"] = [], historyTruncated?: boolean): MetricsSnapshot => {
    return { cache: null, databaseSize: null, errors, history, historyTruncated, requests, shard: "", sinceMs: 0, uptimeMs: 0 };
};

const stat = (path: string, calls: number, errors: number): FunctionCallStat => {
    return { calls, errors, lastCalledAt: 0, lastErrorAt: null, lastErrorMessage: null, maxDurationMs: 0, path, totalDurationMs: 0 };
};

const migration = (id: string, status: MigrationStatusRow["status"], updatedAt: number): MigrationStatusRow => {
    return { changed: 0, cursor: null, direction: "up", error: null, id, processed: 0, startedAt: 0, status, updatedAt };
};

const result = (overrides: Partial<ShardSloResult>): ShardSloResult => {
    return { functions: [], metrics: null, migrations: [], ...overrides };
};

describe("sumShardMetrics", () => {
    it("sums requests/errors over reachable shards and counts the unreachable as failed", () => {
        expect.assertions(4);

        const totals = sumShardMetrics([result({ metrics: snapshot(100, 3) }), result({ metrics: snapshot(50, 1) }), result({ metrics: null })]);

        expect(totals.requests).toBe(150);
        expect(totals.errors).toBe(4);
        expect(totals.reachable).toBe(2);
        expect(totals.failed).toBe(1);
    });

    it("concatenates every reachable shard's history buckets", () => {
        expect.assertions(1);

        const totals = sumShardMetrics([
            result({ metrics: snapshot(10, 0, [{ bucketMs: 1000, calls: 10, errors: 0, path: "a:b" }]) }),
            result({ metrics: snapshot(20, 0, [{ bucketMs: 1000, calls: 20, errors: 0, path: "c:d" }]) }),
        ]);

        expect(totals.history).toHaveLength(2);
    });

    it("reports historyTruncated when ANY reachable shard's history was cut", () => {
        expect.assertions(1);

        const totals = sumShardMetrics([result({ metrics: snapshot(10, 0, [], false) }), result({ metrics: snapshot(20, 0, [], true) })]);

        expect(totals.historyTruncated).toBe(true);
    });

    it("does not report historyTruncated when no shard was cut", () => {
        expect.assertions(1);

        const totals = sumShardMetrics([result({ metrics: snapshot(10, 0, [], false) }), result({ metrics: snapshot(20, 0) })]);

        expect(totals.historyTruncated).toBe(false);
    });
});

describe("mergeFunctionStats", () => {
    it("merges the same path across shards, summing calls/errors", () => {
        expect.assertions(3);

        const merged = mergeFunctionStats([[stat("feed:list", 100, 5), stat("users:get", 10, 0)], [stat("feed:list", 50, 5)]]);
        const byPath = new Map(merged.map((entry) => [entry.path, entry]));

        expect(merged).toHaveLength(2);
        expect(byPath.get("feed:list")).toMatchObject({ calls: 150, errors: 10 });
        expect(byPath.get("users:get")).toMatchObject({ calls: 10, errors: 0 });
    });
});

describe("dedupeMigrations", () => {
    it("keeps the worst status for a shared migration id across shards", () => {
        expect.assertions(2);

        const deduped = dedupeMigrations([[migration("m1", "completed", 1000)], [migration("m1", "failed", 500)], [migration("m2", "in_progress", 1000)]]);
        const byId = new Map(deduped.map((row) => [row.id, row]));

        // `failed` beats `completed` even though it was updated earlier.
        expect(byId.get("m1")?.status).toBe("failed");
        expect(byId.get("m2")?.status).toBe("in_progress");
    });
});
