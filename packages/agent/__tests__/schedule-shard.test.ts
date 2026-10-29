import { describe, expect, it } from "vitest";

import withAgentScheduleShard from "../src/schedule-shard";

interface ScheduledCall {
    method: string;
    options: Record<string, unknown> | undefined;
    target: unknown;
}

const recordingScheduler = (calls: ScheduledCall[]) => {
    return {
        cancel: async (id: string) => {
            return { cancelled: id === "job-1" };
        },
        runAfter: async (_delay: number, target: unknown, _args?: unknown, options?: Record<string, unknown>) => {
            calls.push({ method: "runAfter", options, target });

            return "job-1";
        },
        runAt: async (_at: number, target: unknown, _args?: unknown, options?: Record<string, unknown>) => {
            calls.push({ method: "runAt", options, target });

            return "job-2";
        },
    };
};

describe(withAgentScheduleShard, () => {
    it("stamps the scheduling shard on agent targets only, keeping a shard the app named", async () => {
        expect.assertions(2);

        const calls: ScheduledCall[] = [];
        const scheduler = withAgentScheduleShard(recordingScheduler(calls), [{ className: "SupportAgentWorkflow", exportName: "support" }], "org-a");
        const agent = { className: "SupportAgentWorkflow", isLunoraWorkflow: true };

        await scheduler.runAfter(1000, agent, { input: "follow up", threadKey: "t-1" });
        await scheduler.runAt(Date.now() + 1000, agent, { input: "follow up", threadKey: "t-1" }, { retry: { maxAttempts: 2 } });
        await scheduler.runAfter(1000, agent, { input: "follow up", threadKey: "t-1" }, { shardKey: "org-c" });
        await scheduler.runAfter(1000, { className: "ReportWorkflow", isLunoraWorkflow: true }, {});
        await scheduler.runAfter(1000, "reports:build", {});

        expect(calls.map((call) => call.options)).toStrictEqual([
            { shardKey: "org-a" },
            { retry: { maxAttempts: 2 }, shardKey: "org-a" },
            { shardKey: "org-c" },
            undefined,
            undefined,
        ]);
        // Everything else on the scheduler is the scheduler's own.
        await expect(scheduler.cancel("job-1")).resolves.toStrictEqual({ cancelled: true });
    });
});
