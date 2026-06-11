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
 * shards and reads each shard's recorded `__cirrus_metrics` call total. The lint
 * is pure over that distribution, so it only fires once the window has more than
 * one shard and enough total requests (`MIN_TOTAL_REQUESTS`) for the proportion
 * to be trustworthy.
 */
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
        const totalRequests = active.reduce((sum, shard) => sum + shard.requests, 0);

        // A single shard can't be "disproportionately" busy relative to peers,
        // and a sparse window's proportions aren't trustworthy.
        if (active.length < 2 || totalRequests < MIN_TOTAL_REQUESTS) {
            return [];
        }

        const findings = [];

        for (const shard of active) {
            const share = shard.requests / totalRequests;

            if (share < HOT_SHARE_THRESHOLD) {
                continue;
            }

            const scope = shard.group !== undefined && shard.group !== "" ? `"${shard.group}" ` : "";
            const label = shard.shardKey === "" ? "the root shard" : `shard "${shard.shardKey}"`;
            const percent = Math.round(share * 100);

            findings.push(
                emit(hotShard, {
                    cacheKey: `hot_shard:${shard.group ?? ""}:${shard.shardKey}`,
                    detail: `${scope}${label} handled ${shard.requests.toString()} of ${totalRequests.toString()} requests (${percent.toString()}%) across ${active.length.toString()} shards — a hot-key skew. Re-shard on a more evenly-distributed key.`,
                    metadata: {
                        group: shard.group,
                        requests: shard.requests,
                        shardCount: active.length,
                        shardKey: shard.shardKey,
                        share,
                        totalRequests,
                    },
                }),
            );
        }

        return findings;
    },
    source: "runtime",
    title: "Hot shard",
};

export default hotShard;
