import { describe, expect, it, vi } from "vitest";

import type { AnalyticsMetricsSource } from "../src";
import { hotShard, indexUtilization, runAdvisor } from "../src";
// Quarantined (plan 225 / ADVISOR-01): no writer emits the AE events this module
// reads, and the studio caller never supplies `analyticsMetrics`. Not part of the
// package's public surface — import the module directly rather than via `../src`.
import { AE_METRIC_EVENTS, loadAnalyticsRuntimeMetrics } from "../src/ae-metrics";

/**
 * A stub AE SQL source that routes each query to a canned row set by matching the
 * event-name literal in the WHERE clause. Mirrors the AE SQL-API result shape
 * (`{ rows }`) the real `createAnalyticsSqlClient` returns.
 */
const stubSource = (responses: {
    indexHit?: Record<string, unknown>[];
    shardRequest?: Record<string, unknown>[];
    tableScan?: Record<string, unknown>[];
}): AnalyticsMetricsSource => {
    return {
        query: vi.fn<(sql: string) => Promise<{ rows: Record<string, unknown>[] }>>(async (sql: string) => {
            if (sql.includes(`'${AE_METRIC_EVENTS.shardRequest.event}'`)) {
                return { rows: responses.shardRequest ?? [] };
            }

            if (sql.includes(`'${AE_METRIC_EVENTS.tableScan.event}'`)) {
                return { rows: responses.tableScan ?? [] };
            }

            if (sql.includes(`'${AE_METRIC_EVENTS.indexHit.event}'`)) {
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
                // AE returns counts as numeric strings; the loader coerces them.
                shardRequest: [
                    { requests: "900", shardGroup: "", shardKey: "tenant-a" },
                    { requests: "100", shardGroup: "", shardKey: "tenant-b" },
                ],
                tableScan: [{ scanTable: "events", scans: "40" }],
            }),
            { dataset: "ANALYTICS" },
        );

        expect(metrics.shardTraffic).toEqual([
            { requests: 900, shardKey: "tenant-a" },
            { requests: 100, shardKey: "tenant-b" },
        ]);
        expect(metrics.tableScans).toEqual([{ scans: 40, table: "events" }]);
        expect(metrics.indexHits).toEqual([{ index: "by_email", reads: 120, table: "users" }]);
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
            { dataset: "ANALYTICS" },
        );

        const findings = runAdvisor({ schema: { tables: [] }, ...metrics }, { lints: [hotShard, indexUtilization], source: "runtime" });

        // hot_shard fires on room-1 (90% share); index_utilization fires on the hot scan of "events".
        expect(findings.map((finding) => finding.name).toSorted((a, b) => a.localeCompare(b))).toEqual(["hot_shard", "index_utilization"]);
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
        });

        expect(metrics.indexHits).toContainEqual({ index: "by_status", reads: 0, table: "orders" });

        const findings = indexUtilization.run({ schema: { tables: [] }, ...metrics });

        expect(findings).toContainEqual(
            expect.objectContaining({ metadata: expect.objectContaining({ index: "by_status", kind: "dead_index", table: "orders" }) }),
        );
    });

    it("scopes shard traffic to a group when one is given", async () => {
        expect.assertions(2);

        const source = stubSource({ shardRequest: [{ requests: 10, shardGroup: "messages", shardKey: "room-1" }] });

        await loadAnalyticsRuntimeMetrics(source, { dataset: "ANALYTICS", group: "messages" });

        const calls = (source.query as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
        const shardQuery = calls.find((sql) => sql.includes(`'${AE_METRIC_EVENTS.shardRequest.event}'`));

        expect(shardQuery).toContain(`${AE_METRIC_EVENTS.shardRequest.group} = 'messages'`);
        // The other reads are not group-scoped.
        expect(calls.find((sql) => sql.includes(`'${AE_METRIC_EVENTS.tableScan.event}'`))).not.toContain("messages");
    });

    it("degrades to an empty array for a metric whose query throws (misconfigured token)", async () => {
        expect.assertions(2);

        const source: AnalyticsMetricsSource = {
            query: async (sql: string) => {
                if (sql.includes(`'${AE_METRIC_EVENTS.shardRequest.event}'`)) {
                    throw new Error("403 Forbidden");
                }

                return { rows: [{ scanTable: "events", scans: 40 }] };
            },
        };

        const metrics = await loadAnalyticsRuntimeMetrics(source, { dataset: "ANALYTICS" });

        // The failing shard read degrades to empty; the healthy scan read still returns.
        expect(metrics.shardTraffic).toEqual([]);
        expect(metrics.tableScans).toEqual([{ scans: 40, table: "events" }]);
    });

    it("rejects a dataset name that isn't a bare identifier", async () => {
        expect.assertions(1);

        await expect(loadAnalyticsRuntimeMetrics(stubSource({}), { dataset: "ANALYTICS; DROP TABLE x" })).rejects.toThrow(/invalid Analytics Engine dataset/u);
    });

    it("speaks the Analytics SQL dialect to a binding-backed source, binding the event, group and lower bound as params", async () => {
        expect.assertions(4);

        const query = vi.fn<(sql: string, params?: Readonly<Record<string, string>>) => Promise<{ rows: Record<string, unknown>[] }>>(async (_sql, params) => {
            if (params?.event === AE_METRIC_EVENTS.shardRequest.event) {
                return { rows: [{ requests: 5, shardGroup: "messages", shardKey: "room-1" }] };
            }

            return { rows: [] };
        });

        const metrics = await loadAnalyticsRuntimeMetrics(
            { query },
            { dataset: "app", dialect: "analytics-sql", group: "it's", since: "2026-10-01T00:00:00.000Z" },
        );

        const shardCall = query.mock.calls.find(([, params]) => params?.event === AE_METRIC_EVENTS.shardRequest.event);

        expect(shardCall?.[0]).toBe(
            'SELECT blob2 AS shardKey, blob3 AS shardGroup, COUNT(*) AS requests FROM events.analyticsEngine."app" WHERE timestamp >= $since AND blob1 = $event AND blob3 = $group GROUP BY shardKey, shardGroup',
        );
        // Values travel as parameters, never spliced into the statement.
        expect(shardCall?.[1]).toStrictEqual({ event: "lunora.shard.request", group: "it's", since: "2026-10-01T00:00:00.000Z" });
        expect(query.mock.calls.every(([sql]) => !sql.includes("_sample_interval") && sql.includes("timestamp >= $since"))).toBe(true);
        expect(metrics.shardTraffic).toStrictEqual([{ group: "messages", requests: 5, shardKey: "room-1" }]);
    });

    it("keeps the Analytics Engine dialect parameterless for the token client", async () => {
        expect.assertions(2);

        const source = stubSource({});

        await loadAnalyticsRuntimeMetrics(source, { dataset: "ANALYTICS" });

        const { calls } = (source.query as ReturnType<typeof vi.fn>).mock;

        expect(calls.every((call) => call.length === 1)).toBe(true);
        expect(calls.every((call) => (call[0] as string).includes("sum(_sample_interval)"))).toBe(true);
    });

    it("escapes backslashes in the group filter so a trailing backslash cannot consume the closing quote", async () => {
        expect.assertions(1);

        // A group value ending in `\` would, without backslash escaping, produce
        // `... = 'bad\'` where the backslash consumes the closing quote and breaks
        // the SQL literal.  With the fix it becomes `... = 'bad\\'`, a valid
        // escaped-backslash literal.
        const source = stubSource({ shardRequest: [] });

        await loadAnalyticsRuntimeMetrics(source, { dataset: "ANALYTICS", group: "bad\\" });

        const calls = (source.query as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0] as string);
        const shardQuery = calls.find((sql) => sql.includes(`'${AE_METRIC_EVENTS.shardRequest.event}'`));

        // The group literal must appear as `'bad\\'` (backslash doubled) in the SQL.
        expect(shardQuery).toContain(String.raw`'bad\\'`);
    });
});
