import { describe, expect, it } from "vitest";

import { dispatchMethods } from "../src/emit/shard-dispatch";

/**
 * The schedule outbox retries a buffered call through `scheduleOutboxScheduler`, with the options the call was recorded
 * with. The live scheduler stamps an agent run with its shard; the retry has to be stamped the same way, or a retried
 * agent run loses the tenant shard it started on.
 */
describe(dispatchMethods, () => {
    it("retries the outbox through a scheduler stamped with the run's shard when the app declares agents", () => {
        expect.assertions(2);

        const source = dispatchMethods(false, false, true);

        expect(source).toContain("withAgentScheduleShard(configured, LUNORA_AGENTS, this.currentShardKey())");
        expect(source).not.toContain("__OUTBOX_SCHEDULER__");
    });

    it("keeps the configured scheduler unstamped for an app without agents", () => {
        expect.assertions(3);

        const source = dispatchMethods(false, false, false);

        expect(source).toContain("return config.scheduler?.((this.env ?? {}) as Record<string, unknown>) as SchedulerLike | undefined;");
        expect(source).not.toContain("withAgentScheduleShard");
        expect(source).not.toContain("__OUTBOX_SCHEDULER__");
    });
});
