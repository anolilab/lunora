import { beforeAll, bench, describe } from "vitest";

import type { RateLimitConfigMap } from "../src/index";
import { RateLimiter } from "../src/index";

/**
 * `getValue()` returns the units admittable right now for a `(name, key)`
 * pair — projected forward to the current clock (token-bucket refill, etc.):
 * one store lookup plus the projection.
 *
 * Memory store so the bench measures the projection overhead, not store IO.
 * The limiter is primed against the key so getValue() hits the real "with
 * prior value" projection path users see in production.
 */

const PERIOD_MS = 1000;
const RATE_PER_PERIOD = 1024;

const config = {
    hits: { kind: "token bucket", period: PERIOD_MS, rate: RATE_PER_PERIOD },
} satisfies RateLimitConfigMap<"hits">;

const NOW = 1_700_000_000_000;

const limiter = new RateLimiter({ config, now: () => NOW });

// Prime in a file-level beforeAll. CodSpeed's instrumented runner does not pick up module-top-level await state, and
// vitest's own bench runner skips hooks registered inside a `describe` (its `runBenchmarkSuite` recurses into
// sub-suites without running their hooks), which left getValue() projecting from "no prior". A file-level hook
// runs under both.
beforeAll(async () => {
    for (let index = 0; index < 100; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- ordered stateful calls
        await limiter.limit("hits", { key: "user-42" });
    }
});

describe("RateLimiter.getValue", () => {
    bench("1 lookup + projection", async () => {
        await limiter.getValue("hits", { key: "user-42" });
    });
});
