import { describe, expect, it } from "vitest";

import type { AdvisorShardTraffic, LintContext } from "../src";
import { ALL_LINTS, hotShard, indexUtilization, runAdvisor, RUNTIME_LINTS } from "../src";

/** A minimal context with an empty schema — runtime lints read only the observed-signal fields. */
const baseContext = (overrides: Partial<LintContext> = {}): LintContext => {
    return { schema: { tables: [] }, ...overrides };
};

const traffic = (entries: AdvisorShardTraffic[]): LintContext => baseContext({ shardTraffic: entries });

describe("hot_shard", () => {
    it("flags a shard taking a dominant share of traffic", () => {
        expect.assertions(2);

        const findings = hotShard.run(
            traffic([
                { requests: 900, shardKey: "tenant-a" },
                { requests: 40, shardKey: "tenant-b" },
                { requests: 30, shardKey: "tenant-c" },
                { requests: 30, shardKey: "tenant-d" },
            ]),
        );

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            name: "hot_shard",
            categories: ["PERFORMANCE"],
            cacheKey: "hot_shard::tenant-a",
            metadata: { shardKey: "tenant-a", requests: 900, shardCount: 4, totalRequests: 1000 },
        });
    });

    it("does not fire on an even distribution", () => {
        expect.assertions(1);

        const findings = hotShard.run(
            traffic([
                { requests: 260, shardKey: "tenant-a" },
                { requests: 250, shardKey: "tenant-b" },
                { requests: 245, shardKey: "tenant-c" },
                { requests: 245, shardKey: "tenant-d" },
            ]),
        );

        expect(findings).toHaveLength(0);
    });

    it("stays quiet below the minimum-total-requests floor (sparse window)", () => {
        expect.assertions(1);

        // 4 of 5 is 80% share, but 5 total requests is too sparse to trust.
        const findings = hotShard.run(
            traffic([
                { requests: 4, shardKey: "tenant-a" },
                { requests: 1, shardKey: "tenant-b" },
            ]),
        );

        expect(findings).toHaveLength(0);
    });

    it("does not fire with only one active shard", () => {
        expect.assertions(1);

        const findings = hotShard.run(
            traffic([
                { requests: 5000, shardKey: "tenant-a" },
                { requests: 0, shardKey: "tenant-b" },
            ]),
        );

        expect(findings).toHaveLength(0);
    });

    it("finds nothing when no shard traffic is supplied (static caller)", () => {
        expect.assertions(1);

        expect(hotShard.run(baseContext())).toHaveLength(0);
    });

    it("names the function group when scoped", () => {
        expect.assertions(1);

        const findings = hotShard.run(
            traffic([
                { group: "rooms", requests: 800, shardKey: "room-42" },
                { group: "rooms", requests: 100, shardKey: "room-7" },
                { group: "rooms", requests: 100, shardKey: "room-9" },
            ]),
        );

        expect(findings[0]).toMatchObject({ cacheKey: "hot_shard:rooms:room-42", metadata: { group: "rooms" } });
    });
});

describe("index_utilization", () => {
    it("flags a hot full-scanned table (read with no index)", () => {
        expect.assertions(2);

        const findings = indexUtilization.run(baseContext({ tableScans: [{ scans: 120, table: "posts" }] }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "WARN",
            facing: "EXTERNAL",
            name: "index_utilization",
            cacheKey: "index_utilization:hot_scan:posts",
            metadata: { kind: "hot_scan", scans: 120, table: "posts" },
        });
    });

    it("does not flag a table scanned only a handful of times", () => {
        expect.assertions(1);

        expect(indexUtilization.run(baseContext({ tableScans: [{ scans: 3, table: "posts" }] }))).toHaveLength(0);
    });

    it("flags a declared index with zero recorded reads (dead index)", () => {
        expect.assertions(2);

        const findings = indexUtilization.run(baseContext({ indexHits: [{ index: "byAuthor", reads: 0, table: "posts" }] }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "INFO",
            facing: "INTERNAL",
            name: "index_utilization",
            cacheKey: "index_utilization:dead_index:posts:byAuthor",
            metadata: { kind: "dead_index", index: "byAuthor", table: "posts" },
        });
    });

    it("does not flag an index that recorded reads", () => {
        expect.assertions(1);

        expect(indexUtilization.run(baseContext({ indexHits: [{ index: "byAuthor", reads: 4200, table: "posts" }] }))).toHaveLength(0);
    });

    it("emits both halves together (dead index + hot scan)", () => {
        expect.assertions(1);

        const findings = indexUtilization.run(
            baseContext({
                indexHits: [{ index: "byStatus", reads: 0, table: "orders" }],
                tableScans: [{ scans: 90, table: "orders" }],
            }),
        );

        expect(findings).toHaveLength(2);
    });

    it("finds nothing without observed signal (static caller)", () => {
        expect.assertions(1);

        expect(indexUtilization.run(baseContext())).toHaveLength(0);
    });
});

describe("runtime lint registration", () => {
    it("includes both runtime lints, sourced runtime", () => {
        expect.assertions(3);

        expect(RUNTIME_LINTS.map((lint) => lint.name)).toStrictEqual(["hot_shard", "index_utilization", "constraint_validator"]);
        expect(RUNTIME_LINTS.every((lint) => lint.source === "runtime")).toBe(true);
        expect(ALL_LINTS).toContain(hotShard);
    });

    it("runs alongside the static lints, isolated by source filter", () => {
        expect.assertions(2);

        const context = traffic([
            { requests: 900, shardKey: "tenant-a" },
            { requests: 100, shardKey: "tenant-b" },
        ]);

        // The empty schema means no static lint fires; only the runtime hot_shard does.
        expect(runAdvisor(context, { source: "runtime" })).toHaveLength(1);
        expect(runAdvisor(context, { source: "static" })).toHaveLength(0);
    });
});
