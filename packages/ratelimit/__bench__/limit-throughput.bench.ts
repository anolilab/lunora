import { bench, describe } from "vitest";

import type { RateLimitConfigMap } from "../src/index";
import { RateLimiter } from "../src/index";

/**
 * `limit()` is the consumer side — every request a procedure gates pays
 * this cost: read prior, run the algorithm (`evaluate`), write the new
 * value. `getValue` (the sibling bench) only does the read; this bench
 * measures the read+write path that's actually on the hot path.
 *
 * - **token bucket, unsharded** — single bucket; cheapest mode.
 * - **token bucket, shards=8** — one bucket lookup chosen by a
 * deterministic hash of the key; the write still touches one shard.
 * Sharding is a read cost, not a write cost — the bench documents that.
 * - **fixed window** — different algorithm, same store IO shape.
 * - **sliding window** — algorithm with the most arithmetic.
 * - **deny-list hit** — short-circuits before the algorithm runs.
 */

const PERIOD_MS = 1000;
const RATE_PER_PERIOD = 10_000;
const NOW = 1_700_000_000_000;

const tokenBucketConfig = {
    hits: { kind: "token bucket", period: PERIOD_MS, rate: RATE_PER_PERIOD },
} satisfies RateLimitConfigMap<"hits">;

const tokenBucketSharded = {
    hits: { kind: "token bucket", period: PERIOD_MS, rate: RATE_PER_PERIOD, shards: 8 },
} satisfies RateLimitConfigMap<"hits">;

const fixedWindowConfig = {
    hits: { kind: "fixed window", period: PERIOD_MS, rate: RATE_PER_PERIOD },
} satisfies RateLimitConfigMap<"hits">;

const slidingWindowConfig = {
    hits: { kind: "sliding window", period: PERIOD_MS, rate: RATE_PER_PERIOD },
} satisfies RateLimitConfigMap<"hits">;

let clock = NOW;

const tokenBucket = new RateLimiter({ config: tokenBucketConfig, now: () => clock });
const tokenBucketSharded8 = new RateLimiter({ config: tokenBucketSharded, now: () => clock });
const fixedWindow = new RateLimiter({ config: fixedWindowConfig, now: () => clock });
const slidingWindow = new RateLimiter({ config: slidingWindowConfig, now: () => clock });
const withDenyList = new RateLimiter({ config: tokenBucketConfig, denyList: ["banned-key"], now: () => clock });

describe("RateLimiter.limit() — algorithm + store-write throughput", () => {
    bench("token bucket, unsharded", async () => {
        clock += 1;
        await tokenBucket.limit("hits", { key: "user-42" });
    });

    bench("token bucket, shards=8 (hashed shard select per call)", async () => {
        clock += 1;
        await tokenBucketSharded8.limit("hits", { key: "user-42" });
    });

    bench("fixed window", async () => {
        clock += 1;
        await fixedWindow.limit("hits", { key: "user-42" });
    });

    bench("sliding window (most arithmetic)", async () => {
        clock += 1;
        await slidingWindow.limit("hits", { key: "user-42" });
    });

    bench("deny-list hit (short-circuit before algorithm)", async () => {
        await withDenyList.limit("hits", { key: "banned-key" });
    });
});
