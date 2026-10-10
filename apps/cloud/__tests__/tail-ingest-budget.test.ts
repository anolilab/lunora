import { createMemoryStore, RateLimiter } from "@lunora/ratelimit";
import { describe, expect, it } from "vitest";

import { admitTailLines, TAIL_LOG_LIMITS, TAIL_LOG_LINES_PER_MINUTE } from "../src/tail/ingest-budget";

/**
 * The per-organization ceiling on runtime log lines the tail ingest stores
 * (`src/tail/ingest-budget.ts`): a chatty plain Worker cannot write rows into the
 * control plane's database without end, and what it loses is counted, not silent.
 */

const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => {
        return { level: "log" as const, message: `line ${String(index)}` };
    });

describe(admitTailLines, () => {
    it("stores an organization's lines within its ceiling, then one notice per batch dropped, then nothing", async () => {
        expect.assertions(4);

        const limiter = new RateLimiter({ config: TAIL_LOG_LIMITS, store: createMemoryStore() });
        let stored = 0;

        // 12 full batches: the ceiling holds 12 of them in a minute.
        for (let batch = 0; batch < TAIL_LOG_LINES_PER_MINUTE / 500; batch += 1) {
            // eslint-disable-next-line no-await-in-loop -- one minute's batches, in order
            const admitted = await admitTailLines(lines(500), limiter, "org_a");

            stored += admitted.length;
        }

        const over = await admitTailLines(lines(500), limiter, "org_a");

        expect(stored).toBe(TAIL_LOG_LINES_PER_MINUTE);
        expect(over).toStrictEqual([{ level: "warn", message: "500 log line(s) dropped: this organization's runtime logs are over 6000 lines a minute" }]);

        // The notices are bounded too.
        for (let batch = 0; batch < 10; batch += 1) {
            // eslint-disable-next-line no-await-in-loop -- see above
            await admitTailLines(lines(1), limiter, "org_a");
        }

        await expect(admitTailLines(lines(1), limiter, "org_a")).resolves.toStrictEqual([]);
        // Another organization's budget is its own.
        await expect(admitTailLines(lines(2), limiter, "org_b")).resolves.toHaveLength(2);
    });
});
