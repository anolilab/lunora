import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulerDO } from "../src/scheduler-do";
import type { ScheduleRecord } from "../src/types";
import { BlockingScheduler, indexKeysFor, post, scheduleDue } from "./blocking-scheduler";
import { createFakeState } from "./fake-state";

const env = { LUNORA_ORIGIN_URL: "https://app.test" };

class RecordingScheduler extends SchedulerDO {
    public readonly dispatched: string[] = [];

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.dispatched.push(record.id);

        return true;
    }
}

const pauseState = async (scheduler: SchedulerDO): Promise<unknown> => {
    const response = await scheduler.fetch(new Request("https://scheduler.internal/pause"));

    return response.json();
};

describe("schedulerDO deployment pause", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("holds due jobs while paused — no dispatch, no attempt charged, no clock — and runs them on resume", async () => {
        expect.hasAssertions();

        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

        const state = createFakeState();
        const scheduler = new RecordingScheduler(state, env);

        await scheduler.fetch(post("/pause", { paused: true, reason: "incident 42" }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "held", scheduledFor: Date.now() - 1000 }));

        await expect(pauseState(scheduler)).resolves.toStrictEqual({ paused: true, pausedAt: 1_700_000_000_000, reason: "incident 42" });

        await scheduler.alarm();

        expect(scheduler.dispatched).toStrictEqual([]);
        expect(state.alarm).toBeNull();
        expect(state.storageMap.get("id:held")).not.toHaveProperty("attempts");

        await scheduler.fetch(post("/pause", { paused: false }));

        await expect(pauseState(scheduler)).resolves.toStrictEqual({ paused: false });
        expect(state.alarm).toBe(1_700_000_000_000 - 1000);

        await scheduler.alarm();

        expect(scheduler.dispatched).toStrictEqual(["held"]);
    });

    it("stops a running drain from starting more jobs once paused, and keeps their claims for resume", async () => {
        expect.hasAssertions();

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);
        // More than the six drain lanes, so two records wait behind in-flight dispatches.
        const ids = await scheduleDue(scheduler, 8);
        const drain = scheduler.alarm();

        await Promise.all(ids.slice(0, 6).map(async (id) => scheduler.entered(id)));

        expect(scheduler.started).toHaveLength(6);

        await scheduler.fetch(post("/pause", { paused: true }));
        scheduler.releaseAll();
        await drain;

        expect(scheduler.started).toHaveLength(6);
        expect(state.alarm).toBeNull();

        for (const id of ids.slice(6)) {
            expect(indexKeysFor(state.storageMap, id)).toHaveLength(1);
        }
    });

    it("stays paused when resuming cannot re-arm the clock, so the resume can be retried", async () => {
        expect.hasAssertions();

        vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

        const state = createFakeState();
        const scheduler = new RecordingScheduler(state, env);

        await scheduler.fetch(post("/pause", { paused: true }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "held", scheduledFor: Date.now() - 1000 }));

        const setAlarm = vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(new Error("storage unavailable"));

        await scheduler.fetch(post("/pause", { paused: false })).catch(() => undefined);

        await expect(pauseState(scheduler)).resolves.toMatchObject({ paused: true });

        setAlarm.mockRestore();
        await scheduler.fetch(post("/pause", { paused: false }));

        expect(state.alarm).toBe(1_700_000_000_000 - 1000);

        await scheduler.alarm();

        expect(scheduler.dispatched).toStrictEqual(["held"]);
    });

    it("keeps the original pausedAt when paused again", async () => {
        expect.hasAssertions();

        const now = vi.spyOn(Date, "now").mockReturnValue(1000);
        const scheduler = new SchedulerDO(createFakeState(), env);

        await scheduler.fetch(post("/pause", { paused: true }));
        now.mockReturnValue(2000);
        await scheduler.fetch(post("/pause", { paused: true, reason: "still down" }));

        await expect(pauseState(scheduler)).resolves.toStrictEqual({ paused: true, pausedAt: 1000, reason: "still down" });
    });

    it("skips and records a cron tick while paused", async () => {
        expect.hasAssertions();

        const scheduler = new SchedulerDO(createFakeState(), env);

        await scheduler.fetch(post("/pause", { paused: true }));

        const begin = await scheduler.fetch(post("/cron/begin", { name: "digest" }));

        await expect(begin.json()).resolves.toStrictEqual({ acquired: false, reason: "paused" });

        const runs = await scheduler.fetch(new Request("https://scheduler.internal/cron/runs"));

        await expect(runs.json()).resolves.toMatchObject({ inFlight: [], runs: [{ name: "digest", reason: "paused", status: "skipped" }] });
    });

    it("refuses a pause request without a boolean", async () => {
        expect.hasAssertions();

        const response = await new SchedulerDO(createFakeState(), env).fetch(post("/pause", { paused: "yes" }));

        expect(response.status).toBe(400);
    });
});
