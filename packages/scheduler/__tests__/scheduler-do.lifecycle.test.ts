import { afterEach, describe, expect, it, vi } from "vitest";

import { SchedulerDO, TERMINAL_RETENTION_MS } from "../src/scheduler-do";
import type { ScheduledJobView } from "../src/types";
import { BlockingScheduler, post, scheduleDue } from "./blocking-scheduler";
import { createFakeState } from "./fake-state";

const env = { LUNORA_ORIGIN_URL: "https://app.test" };

/** Pin `Date.now()` only; timers and promises run for real. */
const pinClock = (at: number): ((to: number) => void) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(at);

    return (to: number) => {
        now.mockReturnValue(to);
    };
};

const getJob = async (scheduler: SchedulerDO, id: string): Promise<ScheduledJobView | undefined> => {
    const response = await scheduler.fetch(new Request(`https://scheduler.internal/get?id=${id}`));
    const body = await response.json<{ record?: ScheduledJobView }>();

    return body.record;
};

const history = async (scheduler: SchedulerDO, cursor?: string): Promise<{ cursor?: string; records: ScheduledJobView[]; truncated: boolean }> => {
    const response = await scheduler.fetch(new Request(`https://scheduler.internal/history${cursor === undefined ? "" : `?cursor=${cursor}`}`));

    return response.json();
};

/** Fails every dispatch, so the job walks its whole budget into the dead-letter. */
class AlwaysFailing extends SchedulerDO {
    public attempts = 0;

    protected override async dispatch(): Promise<boolean> {
        this.attempts += 1;

        return false;
    }
}

describe("schedulerDO job lifecycle", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("reports pending, then running while dispatching, then succeeded once it settles", async () => {
        expect.hasAssertions();

        const at = 1_700_000_000_000;

        pinClock(at);

        const scheduler = new BlockingScheduler(createFakeState(), env);

        await scheduleDue(scheduler, 1);

        await expect(getJob(scheduler, "job-0")).resolves.toMatchObject({ state: "pending" });

        const drain = scheduler.alarm();

        await scheduler.entered("job-0");

        await expect(getJob(scheduler, "job-0")).resolves.toMatchObject({ state: "running" });

        scheduler.release("job-0", true);
        await drain;

        await expect(getJob(scheduler, "job-0")).resolves.toMatchObject({ completedAt: at, functionPath: "jobs.run0", id: "job-0", state: "succeeded" });
    });

    it("reports a dead-lettered job as failed with its reason, through a purge, and pending again after a requeue", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const state = createFakeState();
        const scheduler = new AlwaysFailing(state, env);

        await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "jobs.run", id: "doomed", retry: { baseMs: 0, maxAttempts: 1 }, scheduledFor: Date.now() }),
        );

        await scheduler.alarm();
        setNow(1_700_000_000_001);
        await scheduler.alarm();

        expect(state.storageMap.has("dead:doomed")).toBe(true);

        const failed = await getJob(scheduler, "doomed");

        expect(failed).toMatchObject({ state: "failed" });
        expect(failed?.error).toContain("after 2 attempts");

        await scheduler.fetch(post("/dead/retry", { id: "doomed" }));

        const requeued = await getJob(scheduler, "doomed");

        expect(requeued).toMatchObject({ attempts: 0, state: "pending" });
        expect(requeued?.error).toBeUndefined();

        await scheduler.alarm();
        setNow(1_700_000_000_002);
        await scheduler.alarm();
        await scheduler.fetch(post("/dead/cancel", { id: "doomed" }));

        expect(state.storageMap.has("dead:doomed")).toBe(false);
        await expect(getJob(scheduler, "doomed")).resolves.toMatchObject({ state: "failed" });
    });

    it("reads a requeued dead job as pending even when a half-finished purge left its failed outcome", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const state = createFakeState();
        const scheduler = new AlwaysFailing(state, env);

        await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "jobs.run", id: "doomed", retry: { baseMs: 0, maxAttempts: 1 }, scheduledFor: Date.now() }),
        );
        await scheduler.alarm();
        setNow(1_700_000_000_001);
        await scheduler.alarm();

        const dead = state.storageMap.get("dead:doomed");

        expect(dead).toBeDefined();

        await scheduler.fetch(post("/dead/cancel", { id: "doomed" }));
        // The purge's dead-row delete is what failed.
        state.storageMap.set("dead:doomed", dead);
        await scheduler.fetch(post("/dead/retry", { id: "doomed" }));

        await expect(getJob(scheduler, "doomed")).resolves.toMatchObject({ state: "pending" });
    });

    it("reports a cancelled pending job as canceled", async () => {
        expect.hasAssertions();

        pinClock(1_700_000_000_000);

        const scheduler = new BlockingScheduler(createFakeState(), env);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "later", scheduledFor: Date.now() + 60_000 }));
        await scheduler.fetch(post("/cancel", { id: "later" }));

        await expect(getJob(scheduler, "later")).resolves.toMatchObject({ completedAt: 1_700_000_000_000, state: "canceled" });
    });

    it("records a job cancelled mid-dispatch as succeeded when the kick went through, and canceled when it failed", async () => {
        expect.hasAssertions();

        pinClock(1_700_000_000_000);

        const scheduler = new BlockingScheduler(createFakeState(), env);

        await scheduleDue(scheduler, 2);

        const drain = scheduler.alarm();

        await Promise.all([scheduler.entered("job-0"), scheduler.entered("job-1")]);
        await scheduler.fetch(post("/cancel", { id: "job-0" }));
        await scheduler.fetch(post("/cancel", { id: "job-1" }));
        scheduler.release("job-0", true);
        scheduler.release("job-1", false);
        await drain;

        await expect(getJob(scheduler, "job-0")).resolves.toMatchObject({ state: "succeeded" });
        await expect(getJob(scheduler, "job-1")).resolves.toMatchObject({ state: "canceled" });

        const page = await history(scheduler);

        expect(page.records.map((record) => `${record.id}:${record.state}`).toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
            "job-0:succeeded",
            "job-1:canceled",
        ]);
    });

    it("does not turn a settled job into canceled when a header outlived its cleanup", async () => {
        expect.hasAssertions();

        pinClock(1_700_000_000_000);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1);

        const header = state.storageMap.get("id:job-0");
        const drain = scheduler.alarm();

        await scheduler.entered("job-0");
        scheduler.release("job-0", true);
        await drain;
        // What a swallowed post-dispatch delete leaves behind.
        state.storageMap.set("id:job-0", header);

        const response = await scheduler.fetch(post("/cancel", { id: "job-0" }));

        await expect(response.json()).resolves.toStrictEqual({ cancelled: false });
        await expect(getJob(scheduler, "job-0")).resolves.toMatchObject({ state: "succeeded" });
        expect(state.storageMap.has("id:job-0")).toBe(false);
    });

    it("forgets a terminal job after the retention window and sweeps its rows on a later alarm", async () => {
        expect.hasAssertions();

        const at = 1_700_000_000_000;
        const setNow = pinClock(at);
        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1);

        const drain = scheduler.alarm();

        await scheduler.entered("job-0");
        scheduler.release("job-0", true);
        await drain;

        setNow(at + TERMINAL_RETENTION_MS - 1);

        await expect(getJob(scheduler, "job-0")).resolves.toMatchObject({ state: "succeeded" });

        setNow(at + TERMINAL_RETENTION_MS);

        await expect(getJob(scheduler, "job-0")).resolves.toBeUndefined();

        // Any later drain reclaims the expired rows.
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.next", id: "next", scheduledFor: Date.now() }));

        const next = scheduler.alarm();

        await scheduler.entered("next");
        scheduler.release("next", true);
        await next;

        expect(state.storageMap.has("done:job-0")).toBe(false);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("dt:") && key.endsWith(":job-0"))).toStrictEqual([]);
        expect(state.storageMap.has("done:next")).toBe(true);
    });

    it("reclaims more than one batch of expired rows in a pass, from a cancel alone", async () => {
        expect.hasAssertions();

        const at = 1_700_000_000_000;
        const setNow = pinClock(at);
        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        for (let index = 0; index < 100; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- outcomes written one after another
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: `old-${String(index)}`, scheduledFor: at + 60_000 }));
            // eslint-disable-next-line no-await-in-loop -- same
            await scheduler.fetch(post("/cancel", { id: `old-${String(index)}` }));
        }

        setNow(at + TERMINAL_RETENTION_MS);
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "fresh", scheduledFor: Date.now() + 60_000 }));
        await scheduler.fetch(post("/cancel", { id: "fresh" }));

        expect([...state.storageMap.keys()].filter((key) => key.startsWith("done:") || key.startsWith("dt:"))).toHaveLength(2);
    });

    it("answers pending, not the old outcome, for a caller id reused after its job finished", async () => {
        expect.hasAssertions();

        pinClock(1_700_000_000_000);

        const scheduler = new BlockingScheduler(createFakeState(), env);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "reused", scheduledFor: Date.now() + 60_000 }));
        await scheduler.fetch(post("/cancel", { id: "reused" }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.again", id: "reused", scheduledFor: Date.now() + 60_000 }));

        await expect(getJob(scheduler, "reused")).resolves.toMatchObject({ functionPath: "jobs.again", state: "pending" });

        // The first outcome's index entry is stale, so history does not show it.
        await expect(history(scheduler)).resolves.toMatchObject({ records: [], truncated: false });
    });

    it("pages /history newest first", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const scheduler = new BlockingScheduler(createFakeState(), env);

        for (const [offset, id] of ["first", "second", "third"].entries()) {
            setNow(1_700_000_000_000 + offset);
            // eslint-disable-next-line no-await-in-loop -- each cancel must land at its own instant
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id, scheduledFor: Date.now() + 60_000 }));
            // eslint-disable-next-line no-await-in-loop -- same
            await scheduler.fetch(post("/cancel", { id }));
        }

        const page = await history(scheduler);

        expect(page.records.map((record) => record.id)).toStrictEqual(["third", "second", "first"]);
        expect(page.truncated).toBe(false);
    });
});
