import { bench, describe } from "vitest";

import type { RateLimitConfigMap } from "../src/index.js";
import { RateLimiter } from "../src/index.js";

/**
 * `getValue()` returns the units admittable right now for a `(name, key)`
 * pair — projected forward to the current clock (token-bucket refill, etc.).
 * For a sharded limit it reads only the **single** shard `limit()` would route
 * this key to (summing siblings would over-report, since this key only ever
 * consumes from one of them). So the read is one store lookup regardless of
 * shard count; the extra per-shard work is just the `hashToShard` route step.
 *
 * - **unsharded** — one bucket; one lookup, no routing hash.
 * - **shards=8** — one lookup + a route hash over the storage key.
 * - **shards=32** — same single lookup; `% shards` is the only difference.
 *
 * Memory store so the bench measures the routing/projection overhead, not
 * store IO. Each limiter is primed against the routed key so getValue() hits
 * the real "with prior value" projection path users see in production.
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

// Prime each limiter so the routed shard has data — getValue() projecting
// from "no prior" is the cheap case; with a prior value we hit the real
// projection path users see in production.
const prime = async <Names extends string>(limiter: RateLimiter<Names>, name: Names, hits: number): Promise<void> => {
    for (let index = 0; index < hits; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- ordered stateful calls
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
    bench("unsharded: 1 lookup, no routing hash", async () => {
        await unsharded.getValue("hits", { key: "user-42" });
    });

    bench("shards=8: 1 lookup + route hash", async () => {
        await sharded8.getValue("hits", { key: "user-42" });
    });

    bench("shards=32: 1 lookup + route hash", async () => {
        await sharded32.getValue("hits", { key: "user-42" });
    });
});
