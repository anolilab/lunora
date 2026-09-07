import { describe, expect, it } from "vitest";

import type { AdvisorShardTraffic, LintContext } from "../src";
import { ALL_LINTS, fanOutBreadth, hotShard, indexUtilization, runAdvisor, RUNTIME_LINTS } from "../src";

/** A minimal context with an empty schema — no observed signal, so every runtime lint is a no-op against it. */
const baseContext = (overrides: Partial<LintContext> = {}): LintContext => {
    return { schema: { tables: [] }, ...overrides };
};

const traffic = (entries: AdvisorShardTraffic[]): LintContext => baseContext({ shardTraffic: entries });

/** `count` active shards in one group — breadth is what this lint reads. */
const shardsInGroup = (group: string, count: number): AdvisorShardTraffic[] =>
    Array.from({ length: count }, (_unused, index) => {
        return { group, requests: 1, shardKey: `${group}-${String(index)}` };
    });

/**
 * The shape the shipped feeder actually emits: `{ requests, shardKey }` with no
 * `group` at all, and `""` for the unnamed root DO. `@lunora/runtime`'s
 * `ShardTrafficEntry` has no `group` field, and the studio hands
 * `rollUpShardTraffic`'s rows straight through, so this — not
 * {@link shardsInGroup} — is what every real run sees.
 */
const liveShards = (count: number): AdvisorShardTraffic[] =>
    Array.from({ length: count }, (_unused, index) => {
        return { requests: 1, shardKey: index === 0 ? "" : `tenant-${String(index)}` };
    });

describe("fan_out_breadth", () => {
    it("flags a shard set wide enough to strain a cross-shard read", () => {
        expect.assertions(2);

        const findings = fanOutBreadth.run(traffic(shardsInGroup("listRooms", 500)));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ level: "WARN", metadata: { group: "listRooms", shards: 500 }, name: "fan_out_breadth" });
    });

    it("stays silent one shard below the threshold", () => {
        expect.assertions(1);

        expect(fanOutBreadth.run(traffic(shardsInGroup("listRooms", 499)))).toHaveLength(0);
    });

    // The studio feeder reports every live shard including failed ones at
    // `requests: 0`. Counting those would let a long tail of dormant tenants
    // raise the alarm on a deployment that never fans out.
    it("ignores idle shards, as hot_shard does", () => {
        expect.assertions(1);

        const idle = Array.from({ length: 600 }, (_unused, index) => {
            return { requests: 0, shardKey: `dormant-${String(index)}` };
        });

        expect(fanOutBreadth.run(traffic(idle))).toHaveLength(0);
    });

    it("groups where the feeder supplies one, since the ceiling is per invocation", () => {
        expect.assertions(1);

        // Two groups of 400: 800 shards live, but no single shard set is wide
        // enough for a fan-out over it to approach the ceiling.
        expect(fanOutBreadth.run(traffic([...shardsInGroup("listRooms", 400), ...shardsInGroup("listUsers", 400)]))).toHaveLength(0);
    });

    // The shape production emits: no `group` on any row (the runtime's
    // `ShardTrafficEntry` has no such field) and `""` for the root DO. Every
    // finding-producing case above supplies a group, so the ungrouped
    // deployment-wide prose and cacheKey were asserted nowhere.
    it("flags the ungrouped deployment-wide shard set the shipped feeder emits", () => {
        expect.assertions(3);

        const findings = fanOutBreadth.run(traffic(liveShards(500)));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "fan_out_breadth:",
            level: "WARN",
            metadata: { group: "", shards: 500 },
            name: "fan_out_breadth",
        });
        expect(findings[0]?.detail).toContain("This deployment has 500 active shards");
    });

    it("finds nothing for a static caller with no traffic feeder", () => {
        expect.assertions(1);

        expect(fanOutBreadth.run(baseContext())).toHaveLength(0);
    });
});

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

    // `rollUpShardTraffic` reports the unnamed root DO as `shardKey: ""`, and on
    // the shipped (ungrouped) feed that is the label and cacheKey every real run
    // would produce for a root-dominant deployment.
    it("names the unnamed root DO as `the root shard` on the ungrouped feed", () => {
        expect.assertions(2);

        const findings = hotShard.run(
            traffic([
                { requests: 900, shardKey: "" },
                { requests: 100, shardKey: "tenant-a" },
            ]),
        );

        expect(findings[0]).toMatchObject({ cacheKey: "hot_shard::", metadata: { shardKey: "" } });
        expect(findings[0]?.detail).toContain("the root shard handled 900 of 1000 requests");
    });

    it("measures each shard's share against its own group, not the combined total (Finding 5)", () => {
        expect.assertions(3);

        // Three sharded functions, each served by two shards where one is 100%
        // hot. Summed across all groups no single shard reaches 50% of the ~3x
        // combined total, so the old cross-group total hid every hot shard. Per
        // group each hot shard is >90% and must be flagged.
        const findings = hotShard.run(
            traffic([
                { group: "rooms", requests: 300, shardKey: "room-1" },
                { group: "rooms", requests: 5, shardKey: "room-2" },
                { group: "chats", requests: 300, shardKey: "chat-1" },
                { group: "chats", requests: 5, shardKey: "chat-2" },
                { group: "feeds", requests: 300, shardKey: "feed-1" },
                { group: "feeds", requests: 5, shardKey: "feed-2" },
            ]),
        );

        expect(findings).toHaveLength(3);

        const flaggedKeys = findings.map((f) => f.metadata["shardKey"]).toSorted((left, right) => String(left).localeCompare(String(right)));

        expect(flaggedKeys).toEqual(["chat-1", "feed-1", "room-1"]);
        // Each finding's total is its own group's total (305), never the 915 combined.
        expect(findings.every((f) => f.metadata["totalRequests"] === 305)).toBe(true);
    });

    it("does not let unrelated groups satisfy the active-count gate (Finding 5)", () => {
        expect.assertions(1);

        // Two different single-shard groups. Combined they are two "active"
        // shards, but each group has only one shard, so neither can be
        // "disproportionately" busy relative to a peer — no finding.
        const findings = hotShard.run(
            traffic([
                { group: "rooms", requests: 500, shardKey: "room-1" },
                { group: "chats", requests: 500, shardKey: "chat-1" },
            ]),
        );

        expect(findings).toHaveLength(0);
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
    it("includes all runtime lints, sourced runtime", () => {
        expect.assertions(3);

        expect(RUNTIME_LINTS.map((lint) => lint.name)).toStrictEqual(["hot_shard", "index_utilization", "fan_out_breadth"]);
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
