import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * A shard must take at least this fraction of total observed traffic before it
 * counts as "hot". 0.5 means a single shard handling the majority of all
 * requests — a clear skew that defeats the point of sharding (the busy shard
 * becomes the bottleneck while its siblings sit idle). Deliberately high so the
 * lint only fires on a genuinely dominant shard, not ordinary unevenness.
 */
const HOT_SHARE_THRESHOLD = 0.5;

/**
 * The skew is only meaningful once there is more than one shard *and* enough
 * traffic for the proportion to be trustworthy. Below this total request count a
 * 50%+ share is just noise (e.g. 1 of 1 requests), so the lint stays quiet.
 */
const MIN_TOTAL_REQUESTS = 50;

/**
 * `hot_shard` — flag a shard whose request share is disproportionately high.
 *
 * Sharding (`.shardBy(key)`) spreads state and load across many Durable Objects
 * by user / tenant / room. Its whole value is *even* distribution: when one
 * shard absorbs a dominant fraction of traffic, that single DO becomes the
 * bottleneck (one request stream, one SQLite, one WS fan-out) while its siblings
 * idle — the hot-key skew sharding is meant to avoid. That usually means the
 * shard key has too little cardinality, or one entity is unusually busy and
 * needs its own split.
 *
 * The per-shard request volume comes from the runtime feeder
 * (`context.shardTraffic`): the studio backend fans out over the function's
 * shards and reads each shard's recorded `__lunora_metrics` call total. The lint
 * is pure over that distribution, so it only fires once the window has more than
 * one shard and enough total requests (`MIN_TOTAL_REQUESTS`) for the proportion
 * to be trustworthy.
 */
/** One shard-group's traffic rows. Mutable: {@link groupByShardGroup} builds the buckets by pushing. */
type ShardTraffic = NonNullable<Parameters<NonNullable<Lint["run"]>>[0]["shardTraffic"]>[number][];

/**
 * Bucket shards by their `.shardBy(...)` group. `undefined` and `""` (both
 * "ungrouped / whole deployment") collapse into one bucket so they neither
 * split nor collide on the `hot_shard:<group>:<shardKey>` cacheKey.
 */
const groupByShardGroup = (active: ShardTraffic): Map<string, ShardTraffic> => {
    const byGroup = new Map<string, ShardTraffic>();

    for (const shard of active) {
        const groupKey = shard.group ?? "";
        const bucket = byGroup.get(groupKey);

        if (bucket === undefined) {
            byGroup.set(groupKey, [shard]);
        } else {
            bucket.push(shard);
        }
    }

    return byGroup;
};

/**
 * The hot shards of ONE group. A shard's share is measured against its own
 * group's total, never the combined traffic of every group — summing across
 * groups dilutes a genuinely hot shard below the threshold (three single-shard
 * groups each look like ~33%) and lets the active-count gate be met by shards
 * from unrelated groups.
 */
const hotShardsInGroup = (lint: Lint, groupKey: string, groupShards: ShardTraffic): ReturnType<typeof emit>[] => {
    const totalRequests = groupShards.reduce((sum, shard) => sum + shard.requests, 0);

    // A single shard can't be "disproportionately" busy relative to peers, and a
    // sparse window's proportions aren't trustworthy.
    if (groupShards.length < 2 || totalRequests < MIN_TOTAL_REQUESTS) {
        return [];
    }

    return groupShards
        .filter((shard) => shard.requests / totalRequests >= HOT_SHARE_THRESHOLD)
        .map((shard) => {
            const share = shard.requests / totalRequests;
            const scope = shard.group !== undefined && shard.group !== "" ? `"${shard.group}" ` : "";
            const label = shard.shardKey === "" ? "the root shard" : `shard "${shard.shardKey}"`;
            const percent = Math.round(share * 100);

            return emit(lint, {
                cacheKey: `hot_shard:${groupKey}:${shard.shardKey}`,
                detail: `${scope}${label} handled ${shard.requests.toString()} of ${totalRequests.toString()} requests (${percent.toString()}%) across ${groupShards.length.toString()} shards — a hot-key skew. Re-shard on a more evenly-distributed key.`,
                metadata: {
                    group: shard.group,
                    requests: shard.requests,
                    shardCount: groupShards.length,
                    shardKey: shard.shardKey,
                    share,
                    totalRequests,
                },
            });
        });
};

const hotShard: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "One shard is taking a disproportionate share of a sharded function's traffic, so the busy shard becomes a single-DO bottleneck while its siblings sit idle — the hot-key skew sharding is meant to avoid.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "hot_shard",
    remediation:
        "Re-shard on a higher-cardinality / more evenly-distributed key, or split the hot entity's state, so request volume spreads across shards instead of concentrating on one.",
    run: (context) => {
        // Only positive-traffic shards count: a zero-request shard can't be hot
        // and shouldn't dilute the total.
        const active = (context.shardTraffic ?? []).filter((shard) => shard.requests > 0);

        // Partition by shard group BEFORE computing shares. Each `.shardBy(...)`
        // function's shards are their own distribution, so a shard's share must be
        // measured against ITS group's total — not the combined traffic of every
        // group. On a multi-group feed (the whole deployment's shard set), summing
        // across groups dilutes a genuinely hot shard below the threshold (three
        // single-shard groups each look like ~33%) and lets the active-count gate
        // be met by shards from unrelated groups. `undefined` and `""` (both
        // "ungrouped / whole deployment") collapse to one bucket so they neither
        // split nor collide on the `hot_shard:<group>:<shardKey>` cacheKey.
        return [...groupByShardGroup(active)].flatMap(([groupKey, groupShards]) => hotShardsInGroup(hotShard, groupKey, groupShards));
    },
    source: "runtime",
    title: "Hot shard",
};

export default hotShard;
