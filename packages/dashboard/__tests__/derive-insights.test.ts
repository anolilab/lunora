import { describe, expect, it } from "vitest";

import type { FunctionCallStat, ShardMetrics } from "../src/admin.js";
import { deriveInsights } from "../src/derive-insights.js";

const metrics = (cache: ShardMetrics["cache"]): ShardMetrics => {return {
    cache,
    databaseSize: 1024,
    errors: 0,
    requests: 100,
    shard: "__root__",
    sinceMs: 1_700_000_000_000,
    uptimeMs: 1000,
}};

const fn = (overrides: Partial<FunctionCallStat>): FunctionCallStat => {return {
    calls: 1,
    errors: 0,
    lastCalledAt: 1000,
    lastErrorAt: null,
    lastErrorMessage: null,
    maxDurationMs: 0,
    path: "messages:list",
    totalDurationMs: 0,
    ...overrides,
}};

describe(deriveInsights, () => {
    it("returns nothing for healthy snapshots", () => {
        expect.assertions(1);

        const healthy = metrics({ bytes: 0, entries: 4, evictions: 0, hits: 90, misses: 10 });

        expect(deriveInsights(healthy, [fn({ calls: 100, errors: 0, maxDurationMs: 20 })])).toStrictEqual([]);
    });

    it("flags a low cache hit rate only once enough samples exist", () => {
        expect.assertions(2);

        // 3 of 9 samples is below the 10-sample floor → no insight (cold cache).
        const cold = metrics({ bytes: 0, entries: 1, evictions: 0, hits: 3, misses: 6 });

        expect(deriveInsights(cold, [])).toStrictEqual([]);

        // 10 of 50 = 20% hit rate, over the sample floor → flagged.
        const warm = metrics({ bytes: 0, entries: 5, evictions: 0, hits: 10, misses: 40 });
        const [insight] = deriveInsights(warm, []);

        expect(insight).toMatchObject({ kind: "low-cache-hit-rate", severity: "warning", value: 0.2 });
    });

    it("flags high eviction when evictions outpace hits", () => {
        expect.assertions(1);

        const churning = metrics({ bytes: 0, entries: 2, evictions: 30, hits: 10, misses: 5 });

        expect(deriveInsights(churning, []).some((insight) => insight.kind === "high-evictions")).toBe(true);
    });

    it("flags a slow function from its max duration", () => {
        expect.assertions(1);

        const [insight] = deriveInsights(null, [fn({ calls: 3, maxDurationMs: 2500, path: "reports:build" })]);

        expect(insight).toMatchObject({ fn: "reports:build", kind: "slow-function", severity: "info", value: 2500 });
    });

    it("flags a high error rate over a meaningful call count, carrying the last error", () => {
        expect.assertions(2);

        // 1 error of 3 calls trips the 5% ratio but not the 5-call floor → ignored.
        const tooFew = deriveInsights(null, [fn({ calls: 3, errors: 1 })]);

        expect(tooFew).toStrictEqual([]);

        const [insight] = deriveInsights(null, [fn({ calls: 20, errors: 4, lastErrorMessage: "boom", path: "messages:send" })]);

        expect(insight).toMatchObject({ fn: "messages:send", kind: "high-error-rate", message: "boom", severity: "error", value: 0.2 });
    });

    it("sorts errors before warnings before info", () => {
        expect.assertions(1);

        const noisy = metrics({ bytes: 0, entries: 5, evictions: 0, hits: 10, misses: 40 });
        const functions = [fn({ calls: 5, maxDurationMs: 3000, path: "a:slow" }), fn({ calls: 20, errors: 5, path: "b:flaky" })];

        const severities = deriveInsights(noisy, functions).map((insight) => insight.severity);

        // error (b:flaky) → warning (cache) → info (a:slow)
        expect(severities).toStrictEqual(["error", "warning", "info"]);
    });
});
