import { bench, describe } from "vitest";

import type { RateLimitConfigMap } from "../src/index.js";
import { RateLimiter } from "../src/index.js";

/**
 * `getValue()` returns the units admittable right now for a `(name, key)`
 * pair — projected forward to the current clock (token-bucket refill, etc.)
 * and **aggregated across shards** when a limit is sharded. Sharding splits
 * a hot key across N independent sub-buckets to avoid contention; the read
 * cost grows linearly with N because we have to sum every shard.
 *
 *  - **unsharded** — one bucket; one store lookup.
 *  - **shards=8** — eight buckets; eight store lookups + sum.
 *  - **shards=32** — same scaling pushed harder.
 *
 * Memory store so the bench measures the aggregation overhead, not store IO.
 * `limit()` uses random routing so warmth across shards is uneven; we prime
 * a synthetic value into every shard via direct store access to keep the
 * compare apples-to-apples.
 */

const PERIOD_MS = 1000;
const RATE_PER_PERIOD = 1024;

const unshardedConfig = {
    hits: { kind: "token bucket", period: PERIOD_MS, rate: RATE_PER_PERIOD },
} satisfies RateLimitConfigMap<"hits">;

const sharded8Config = {
    hits: { kind: "token bucket", period: PERIOD_MS, rate: RATE_PER_PERIOD, shards: 8 },
} satisfies RateLimitConfigMap<"hits">;

const sharded32Config = {
    hits: { kind: "token bucket", period: PERIOD_MS, rate: RATE_PER_PERIOD, shards: 32 },
} satisfies RateLimitConfigMap<"hits">;

const NOW = 1_700_000_000_000;

const buildLimiter = <Names extends string>(config: RateLimitConfigMap<Names>) => new RateLimiter({ config, now: () => NOW });

// Prime each limiter so the shards have data — getValue() projecting from
// "no prior" is the cheap case; with prior values we hit the real
// aggregation path users see in production.
const prime = async <Names extends string>(limiter: RateLimiter<Names>, name: Names, hits: number): Promise<void> => {
    for (let index = 0; index < hits; index += 1) {
        await limiter.limit(name, { key: "user-42" });
    }
};

const unsharded = buildLimiter(unshardedConfig);
const sharded8 = buildLimiter(sharded8Config);
const sharded32 = buildLimiter(sharded32Config);

await prime(unsharded, "hits", 100);
await prime(sharded8, "hits", 100);
await prime(sharded32, "hits", 100);

describe("RateLimiter.getValue — sharded vs unsharded", () => {
    bench("unsharded: 1 bucket → 1 store lookup", async () => {
        await unsharded.getValue("hits", { key: "user-42" });
    });

    bench("shards=8: 8 buckets → 8 lookups + sum", async () => {
        await sharded8.getValue("hits", { key: "user-42" });
    });

    bench("shards=32: 32 buckets → 32 lookups + sum", async () => {
        await sharded32.getValue("hits", { key: "user-42" });
    });
});
