import { afterEach, describe, expect, it, vi } from "vitest";

import { DISPATCH_LEASE_MS, SchedulerDO } from "../src/scheduler-do";
import type { CronRunInFlight, CronRunRecord } from "../src/types";
import { post } from "./blocking-scheduler";
import { createFakeState } from "./fake-state";

const env = { LUNORA_ORIGIN_URL: "https://app.test" };

const pinClock = (at: number): ((to: number) => void) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(at);

    return (to: number) => {
        now.mockReturnValue(to);
    };
};

type Begin = { acquired: false; reason: string; runningSince: number } | { acquired: true; runId: string };

const begin = async (scheduler: SchedulerDO, name: string): Promise<Begin> => {
    const response = await scheduler.fetch(post("/cron/begin", { name }));

    return response.json();
};

const end = async (scheduler: SchedulerDO, body: Record<string, unknown>): Promise<{ recorded: boolean }> => {
    const response = await scheduler.fetch(post("/cron/end", body));

    return response.json();
};

const runs = async (scheduler: SchedulerDO): Promise<{ inFlight: CronRunInFlight[]; runs: CronRunRecord[] }> => {
    const response = await scheduler.fetch(new Request("https://scheduler.internal/cron/runs"));

    return response.json();
};

const acquire = async (scheduler: SchedulerDO, name: string): Promise<string> => {
    const lease = await begin(scheduler, name);

    if (!lease.acquired) {
        throw new Error(`expected to acquire ${name}`);
    }

    return lease.runId;
};

describe("schedulerDO cron runs", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("skips a tick while the previous run of the same cron is in flight, and counts it on that run", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const scheduler = new SchedulerDO(createFakeState(), env);
        const runId = await acquire(scheduler, "digest");

        setNow(1_700_000_060_000);

        await expect(begin(scheduler, "digest")).resolves.toMatchObject({ acquired: false, reason: "in-flight", runningSince: 1_700_000_000_000 });

        // A different cron is not held up by it.
        await expect(begin(scheduler, "digest:eu")).resolves.toMatchObject({ acquired: true });

        await expect(runs(scheduler)).resolves.toMatchObject({ inFlight: expect.arrayContaining([expect.objectContaining({ name: "digest", skipped: 1 })]) });

        setNow(1_700_000_090_000);

        await expect(end(scheduler, { name: "digest", runId, status: "succeeded" })).resolves.toStrictEqual({ recorded: true });

        const { inFlight, runs: recorded } = await runs(scheduler);

        expect(inFlight.map((lease) => lease.name)).toStrictEqual(["digest:eu"]);
        // Newest end first: the run finished after the tick it caused to be skipped.
        expect(recorded.filter((run) => run.name === "digest")).toStrictEqual([
            { durationMs: 90_000, endedAt: 1_700_000_090_000, name: "digest", runId, skipped: 1, startedAt: 1_700_000_000_000, status: "succeeded" },
            expect.objectContaining({ durationMs: 0, reason: "in-flight", skipped: 1, startedAt: 1_700_000_060_000, status: "skipped" }),
        ]);

        // The lease is free again.
        await expect(begin(scheduler, "digest")).resolves.toMatchObject({ acquired: true });
    });

    it("records a failed run with its error", async () => {
        expect.hasAssertions();

        pinClock(1_700_000_000_000);

        const scheduler = new SchedulerDO(createFakeState(), env);
        const runId = await acquire(scheduler, "digest");

        await end(scheduler, { error: "shard status 500", name: "digest", runId, status: "failed" });

        await expect(runs(scheduler)).resolves.toMatchObject({ inFlight: [], runs: [{ error: "shard status 500", runId, status: "failed" }] });
    });

    it("treats a lease past the fifteen-minute ceiling as lost: records it failed and lets the next tick run", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const scheduler = new SchedulerDO(createFakeState(), env);
        const lost = await acquire(scheduler, "digest");

        setNow(1_700_000_000_000 + DISPATCH_LEASE_MS - 1);

        await expect(begin(scheduler, "digest")).resolves.toMatchObject({ acquired: false });

        setNow(1_700_000_000_000 + DISPATCH_LEASE_MS);

        const next = await acquire(scheduler, "digest");

        // The lost run's late report neither records twice nor frees its successor's lease.
        await expect(end(scheduler, { name: "digest", runId: lost, status: "succeeded" })).resolves.toStrictEqual({ recorded: false });

        const state = await runs(scheduler);

        expect(state.inFlight).toMatchObject([{ runId: next }]);
        expect(state.runs.find((run) => run.runId === lost)).toMatchObject({ skipped: 1, status: "failed" });
    });

    it("keeps the newest fifty runs per cron job", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const scheduler = new SchedulerDO(createFakeState(), env);

        for (let index = 0; index < 55; index += 1) {
            setNow(1_700_000_000_000 + index * 1000);
            // eslint-disable-next-line no-await-in-loop -- each run must begin and end before the next tick
            const runId = await acquire(scheduler, "digest");
            // eslint-disable-next-line no-await-in-loop -- same
            await end(scheduler, { name: "digest", runId, status: "succeeded" });
        }

        const { runs: recorded } = await runs(scheduler);

        expect(recorded).toHaveLength(50);
        expect(recorded[0]?.startedAt).toBe(1_700_000_054_000);
        expect(recorded.at(-1)?.startedAt).toBe(1_700_000_005_000);
    });

    it("keeps a long run's record and earlier runs when many ticks are skipped", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const scheduler = new SchedulerDO(createFakeState(), env);
        const earlier = await acquire(scheduler, "digest");

        await end(scheduler, { name: "digest", runId: earlier, status: "succeeded" });

        const long = await acquire(scheduler, "digest");

        for (let tick = 1; tick <= 60; tick += 1) {
            setNow(1_700_000_000_000 + tick * 1000);
            // eslint-disable-next-line no-await-in-loop -- each tick lands at its own instant
            await begin(scheduler, "digest");
        }

        setNow(1_700_000_061_000);
        await end(scheduler, { name: "digest", runId: long, status: "succeeded" });

        const { runs: recorded } = await runs(scheduler);

        expect(recorded.map((run) => `${run.status}:${String(run.skipped)}`)).toStrictEqual(["succeeded:60", "skipped:60", "succeeded:0"]);
        expect(recorded[0]?.runId).toBe(long);
        expect(recorded[1]).toMatchObject({ endedAt: 1_700_000_060_000, startedAt: 1_700_000_001_000 });
    });

    it("keeps earlier runs through a long run of paused ticks", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const scheduler = new SchedulerDO(createFakeState(), env);
        const before = await acquire(scheduler, "digest");

        await end(scheduler, { name: "digest", runId: before, status: "failed" });
        await scheduler.fetch(post("/pause", { paused: true }));

        for (let tick = 1; tick <= 60; tick += 1) {
            setNow(1_700_000_000_000 + tick * 1000);
            // eslint-disable-next-line no-await-in-loop -- each tick lands at its own instant
            await begin(scheduler, "digest");
        }

        const { runs: recorded } = await runs(scheduler);

        expect(recorded).toMatchObject([
            { reason: "paused", skipped: 60, status: "skipped" },
            { runId: before, status: "failed" },
        ]);
    });

    it("reports a lease that lapsed with no later tick as a failed run, not in flight", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const scheduler = new SchedulerDO(createFakeState(), env);
        const lost = await acquire(scheduler, "digest");

        setNow(1_700_000_000_000 + DISPATCH_LEASE_MS);

        const state = await runs(scheduler);

        expect(state.inFlight).toStrictEqual([]);
        expect(state.runs).toMatchObject([{ runId: lost, status: "failed" }]);

        // A late report is still ignored.
        await expect(end(scheduler, { name: "digest", runId: lost, status: "succeeded" })).resolves.toStrictEqual({ recorded: false });
    });

    it("still answers skip when recording the skipped tick fails", async () => {
        expect.hasAssertions();

        pinClock(1_700_000_000_000);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, env);

        await acquire(scheduler, "digest");

        const put = state.storage.put.bind(state.storage);

        vi.spyOn(state.storage, "put").mockImplementation(async (key: unknown, value?: unknown) => {
            if (typeof key === "string") {
                throw new TypeError("storage unavailable");
            }

            return put(key as never, value as never);
        });

        await expect(begin(scheduler, "digest")).resolves.toMatchObject({ acquired: false, reason: "in-flight" });
    });

    it("keeps the lease when recording a finished run fails, so the run is not lost", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const state = createFakeState();
        const scheduler = new SchedulerDO(state, env);
        const runId = await acquire(scheduler, "digest");
        const put = vi.spyOn(state.storage, "put").mockRejectedValueOnce(new Error("storage unavailable"));

        await scheduler.fetch(post("/cron/end", { name: "digest", runId, status: "succeeded" })).catch(() => undefined);
        put.mockRestore();

        setNow(1_700_000_000_000 + DISPATCH_LEASE_MS);

        await expect(runs(scheduler)).resolves.toMatchObject({ inFlight: [], runs: [{ runId, status: "failed" }] });
    });

    it("refuses a begin without a name and an end without a valid status", async () => {
        expect.hasAssertions();

        const scheduler = new SchedulerDO(createFakeState(), env);

        const noName = await scheduler.fetch(post("/cron/begin", {}));
        const badStatus = await scheduler.fetch(post("/cron/end", { name: "digest", runId: "r", status: "skipped" }));

        expect(noName.status).toBe(400);
        expect(badStatus.status).toBe(400);
    });
});
