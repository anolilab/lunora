import { describe, expect, it, vi } from "vitest";

import type { AnalyticsMetricsSource } from "../src";
import { hotShard, indexUtilization, runAdvisor } from "../src";
// Quarantined (plan 225 / ADVISOR-01): no writer emits the AE events this module
// reads, and the studio caller never supplies `analyticsMetrics`. Not part of the
// package's public surface — import the module directly rather than via `../src`.
import { AE_METRIC_EVENTS, loadAnalyticsRuntimeMetrics } from "../src/ae-metrics";

const SINCE = "2026-10-01T00:00:00.000Z";

type QueryFunction = (sql: string, params: Readonly<Record<string, string>>) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * A stub Analytics SQL source that routes each query to a canned row set by the
 * bound `$event` parameter. Mirrors the `{ rows }` shape `ctx.analyticsSql`
 * resolves.
 */
const stubSource = (responses: {
    indexHit?: Record<string, unknown>[];
    shardRequest?: Record<string, unknown>[];
    tableScan?: Record<string, unknown>[];
}): AnalyticsMetricsSource & { query: ReturnType<typeof vi.fn<QueryFunction>> } => {
    return {
        query: vi.fn<QueryFunction>(async (_sql, params) => {
            if (params.event === AE_METRIC_EVENTS.shardRequest.event) {
                return { rows: responses.shardRequest ?? [] };
            }

            if (params.event === AE_METRIC_EVENTS.tableScan.event) {
                return { rows: responses.tableScan ?? [] };
            }

            if (params.event === AE_METRIC_EVENTS.indexHit.event) {
                return { rows: responses.indexHit ?? [] };
            }

            return { rows: [] };
        }),
    };
};

describe("loadAnalyticsRuntimeMetrics", () => {
    it("reconstructs the runtime-lint arrays from AE rows, coercing numeric strings", async () => {
        expect.assertions(3);

        const metrics = await loadAnalyticsRuntimeMetrics(
            stubSource({
                indexHit: [{ hitIndex: "by_email", hitTable: "users", reads: "120" }],
                // Counts may arrive as numeric strings; the loader coerces them.
                shardRequest: [
                    { requests: "900", shardGroup: "", shardKey: "tenant-a" },
                    { requests: "100", shardGroup: "", shardKey: "tenant-b" },
                ],
                tableScan: [{ scanTable: "events", scans: "40" }],
            }),
            { dataset: "ANALYTICS", since: SINCE },
        );

        expect(metrics.shardTraffic).toStrictEqual([
            { requests: 900, shardKey: "tenant-a" },
            { requests: 100, shardKey: "tenant-b" },
        ]);
        expect(metrics.tableScans).toStrictEqual([{ scans: 40, table: "events" }]);
        expect(metrics.indexHits).toStrictEqual([{ index: "by_email", reads: 120, table: "users" }]);
    });

    it("feeds the runtime lints end-to-end so AE data produces findings", async () => {
        expect.assertions(2);

        const metrics = await loadAnalyticsRuntimeMetrics(
            stubSource({
                shardRequest: [
                    { requests: 900, shardGroup: "messages", shardKey: "room-1" },
                    { requests: 60, shardGroup: "messages", shardKey: "room-2" },
                    { requests: 40, shardGroup: "messages", shardKey: "room-3" },
                ],
                tableScan: [{ scanTable: "events", scans: 40 }],
            }),
            { dataset: "ANALYTICS", since: SINCE },
        );

        const findings = runAdvisor({ schema: { tables: [] }, ...metrics }, { lints: [hotShard, indexUtilization], source: "runtime" });

        // hot_shard fires on room-1 (90% share); index_utilization fires on the hot scan of "events".
        expect(findings.map((finding) => finding.name).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["hot_shard", "index_utilization"]);
        expect(findings.find((finding) => finding.name === "hot_shard")).toMatchObject({
            cacheKey: "hot_shard:messages:room-1",
            metadata: { group: "messages", requests: 900, shardKey: "room-1" },
        });
    });

    it("synthesises reads:0 entries for declared indexes absent from the AE hit feed (dead-index detection)", async () => {
        expect.assertions(2);

        const metrics = await loadAnalyticsRuntimeMetrics(stubSource({ indexHit: [{ hitIndex: "by_email", hitTable: "users", reads: 5 }] }), {
            dataset: "ANALYTICS",
            declaredIndexes: [
                { index: "by_email", table: "users" },
                { index: "by_status", table: "orders" },
            ],
            since: SINCE,
        });

        expect(metrics.indexHits).toContainEqual({ index: "by_status", reads: 0, table: "orders" });

        const findings = indexUtilization.run({ schema: { tables: [] }, ...metrics });

        expect(findings).toContainEqual(
            expect.objectContaining({ metadata: expect.objectContaining({ index: "by_status", kind: "dead_index", table: "orders" }) }),
        );
    });

    it("speaks the Analytics SQL dialect, binding the bound, event and group as parameters", async () => {
        expect.assertions(4);

        const source = stubSource({ shardRequest: [{ requests: 5, shardGroup: "messages", shardKey: "room-1" }] });

        const metrics = await loadAnalyticsRuntimeMetrics(source, { dataset: "app", group: "messages", since: SINCE });

        const shardCall = source.query.mock.calls.find(([, params]) => params.event === AE_METRIC_EVENTS.shardRequest.event);

        expect(shardCall?.[0]).toBe(
            'SELECT blob2 AS shardKey, blob3 AS shardGroup, COUNT(*) AS requests FROM events.analyticsEngine."app" WHERE timestamp >= $since AND blob1 = $event AND blob3 = $group GROUP BY shardKey, shardGroup',
        );
        expect(shardCall?.[1]).toStrictEqual({ event: "lunora.shard.request", group: "messages", since: SINCE });
        // Every read is time-bounded, sample-weighted by the SQL API, and binds its event.
        expect(source.query.mock.calls.every(([sql, params]) => sql.includes("timestamp >= $since AND blob1 = $event") && params.since === SINCE)).toBe(true);
        expect(metrics.shardTraffic).toStrictEqual([{ group: "messages", requests: 5, shardKey: "room-1" }]);
    });

    it("scopes only the shard read to a group, and never splices the group into the statement", async () => {
        expect.assertions(3);

        // Quotes and a trailing backslash: harmless as a bound value, and the statement never sees them.
        const group = String.raw`it's bad\\`;
        const source = stubSource({});

        await loadAnalyticsRuntimeMetrics(source, { dataset: "ANALYTICS", group, since: SINCE });

        const { calls } = source.query.mock;

        expect(calls.find(([, params]) => params.event === AE_METRIC_EVENTS.shardRequest.event)?.[1].group).toBe(group);
        expect(calls.every(([sql]) => !sql.includes("it's"))).toBe(true);
        expect(calls.filter(([, params]) => params.group !== undefined)).toHaveLength(1);
    });

    it("degrades to an empty array for a metric whose query throws", async () => {
        expect.assertions(2);

        const source: AnalyticsMetricsSource = {
            query: async (_sql, params) => {
                if (params.event === AE_METRIC_EVENTS.shardRequest.event) {
                    throw new Error("query exceeded a resource limit");
                }

                return { rows: [{ scanTable: "events", scans: 40 }] };
            },
        };

        const metrics = await loadAnalyticsRuntimeMetrics(source, { dataset: "ANALYTICS", since: SINCE });

        // The failing shard read degrades to empty; the healthy scan read still returns.
        expect(metrics.shardTraffic).toStrictEqual([]);
        expect(metrics.tableScans).toStrictEqual([{ scans: 40, table: "events" }]);
    });

    it("rejects a dataset name that isn't a bare identifier", async () => {
        expect.assertions(1);

        await expect(loadAnalyticsRuntimeMetrics(stubSource({}), { dataset: 'ANALYTICS"; DROP TABLE x', since: SINCE })).rejects.toThrow(
            /invalid Analytics Engine dataset/u,
        );
    });
});
