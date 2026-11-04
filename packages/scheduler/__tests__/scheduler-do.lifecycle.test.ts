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

/**
 * Makes every storage `put` and `delete` take a macrotask to settle and records whether a put and a
 * delete were ever in flight together. Durable Object storage commits writes issued in the same
 * synchronous run together or not at all, so a delete awaited AFTER a put is a separate commit.
 */
const watchWriteOrder = (state: ReturnType<typeof createFakeState>): { overlapped: () => boolean } => {
    const put = state.storage.put.bind(state.storage) as (...arguments_: unknown[]) => Promise<void>;
    const remove = state.storage.delete.bind(state.storage);
    const pending = { delete: 0, put: 0 };
    let overlapped = false;
    const slow = async (kind: "delete" | "put"): Promise<void> => {
        pending[kind] += 1;
        overlapped ||= pending.delete > 0 && pending.put > 0;
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
        pending[kind] -= 1;
    };

    vi.spyOn(state.storage, "put").mockImplementation(async (...arguments_: unknown[]) => {
        await slow("put");

        return put(...arguments_);
    });
    vi.spyOn(state.storage, "delete").mockImplementation(async (keys: string | string[]) => {
        await slow("delete");

        return remove(keys);
    });

    return { overlapped: () => overlapped };
};

/** Succeeds every dispatch, counting them. */
class AlwaysSucceeding extends SchedulerDO {
    public dispatched = 0;

    protected override async dispatch(): Promise<boolean> {
        this.dispatched += 1;

        return true;
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

    it("lists a dead-lettered job in history from the moment it is parked, keeps its failure time through a purge, and drops it on requeue", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const scheduler = new AlwaysFailing(createFakeState(), env);

        await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "jobs.run", id: "doomed", retry: { baseMs: 0, maxAttempts: 1 }, scheduledFor: Date.now() }),
        );
        await scheduler.alarm();
        setNow(1_700_000_000_001);
        await scheduler.alarm();

        await expect(getJob(scheduler, "doomed")).resolves.toMatchObject({ completedAt: 1_700_000_000_001, state: "failed" });
        await expect(history(scheduler)).resolves.toMatchObject({ records: [{ completedAt: 1_700_000_000_001, id: "doomed", state: "failed" }] });

        setNow(1_700_000_000_500);
        await scheduler.fetch(post("/dead/retry", { id: "doomed" }));

        await expect(history(scheduler)).resolves.toMatchObject({ records: [] });

        await scheduler.alarm();
        setNow(1_700_000_000_600);
        await scheduler.alarm();
        setNow(1_700_000_000_900);
        await scheduler.fetch(post("/dead/cancel", { id: "doomed" }));

        const page = await history(scheduler);

        expect(page.records).toHaveLength(1);
        expect(page.records[0]).toMatchObject({ completedAt: 1_700_000_000_600, state: "failed" });
    });

    it("drops the history index entry of a dead job when it is requeued", async () => {
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

        await expect(state.storage.list({ prefix: "dt:" })).resolves.toHaveProperty("size", 1);

        await scheduler.fetch(post("/dead/retry", { id: "doomed" }));

        await expect(state.storage.list({ prefix: "dt:" })).resolves.toHaveProperty("size", 0);
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

    it("restores the history row of a job whose outcome write failed, without running it again", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const state = createFakeState();
        const first = new AlwaysSucceeding(state, env);
        const put = state.storage.put.bind(state.storage);

        await first.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "ran", scheduledFor: Date.now() }));

        // The outcome write fails; everything else (the marker included) lands.
        vi.spyOn(state.storage, "put").mockImplementation(async (entries: unknown, ...rest: unknown[]) => {
            if (typeof entries === "object" && entries !== null && Object.keys(entries).some((key) => key.startsWith("done:"))) {
                throw new Error("storage unavailable");
            }

            return (put as (...arguments_: unknown[]) => Promise<void>)(entries, ...rest);
        });
        await first.alarm();
        vi.restoreAllMocks();
        pinClock(1_700_000_000_000);

        expect(first.dispatched).toBe(1);
        await expect(getJob(first, "ran")).resolves.toBeUndefined();

        // The instance is evicted; its successor walks the store.
        setNow(1_700_000_005_000);

        const second = new AlwaysSucceeding(state, env);

        await second.alarm();

        // Never run again, and the outcome is back with its original time.
        expect(second.dispatched).toBe(0);
        await expect(getJob(second, "ran")).resolves.toMatchObject({ completedAt: 1_700_000_000_000, state: "succeeded" });
        await expect(history(second)).resolves.toMatchObject({ records: [{ id: "ran", state: "succeeded" }] });
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("repair:"))).toStrictEqual([]);
    });

    it("restores the outcome instead of re-running a job whose header also outlived its failed outcome write", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const state = createFakeState();
        const first = new AlwaysSucceeding(state, env);
        const put = state.storage.put.bind(state.storage);
        const remove = state.storage.delete.bind(state.storage);

        await first.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "ran", scheduledFor: Date.now() }));
        vi.spyOn(state.storage, "put").mockImplementation(async (entries: unknown, ...rest: unknown[]) => {
            if (typeof entries === "object" && entries !== null && Object.keys(entries).some((key) => key.startsWith("done:"))) {
                throw new Error("storage unavailable");
            }

            return (put as (...arguments_: unknown[]) => Promise<void>)(entries, ...rest);
        });
        vi.spyOn(state.storage, "delete").mockImplementation(async (keys: string | string[]) => {
            if ([keys].flat().includes("id:ran")) {
                throw new Error("storage unavailable");
            }

            return remove(keys);
        });
        await first.alarm();
        vi.restoreAllMocks();
        pinClock(1_700_000_000_000);

        // The header is still there, unindexed: exactly what the walk re-arms.
        expect(state.storageMap.has("id:ran")).toBe(true);

        setNow(1_700_000_005_000);

        const second = new AlwaysSucceeding(state, env);

        await second.alarm();

        expect(second.dispatched).toBe(0);
        expect(state.storageMap.has("id:ran")).toBe(false);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("t:"))).toStrictEqual([]);
        await expect(getJob(second, "ran")).resolves.toMatchObject({ completedAt: 1_700_000_000_000, state: "succeeded" });
    });

    it("leaves a rescheduled job alone when a stale repair marker names the same id", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const state = createFakeState();
        const first = new AlwaysSucceeding(state, env);

        await first.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "ran", scheduledFor: Date.now() + 60_000 }));

        // A marker left for an earlier job of the same id.
        const header = state.storageMap.get("id:ran") as Record<string, unknown>;

        state.storageMap.set("repair:ran", { ...header, completedAt: 1_699_999_000_000, enqueuedAt: 1, state: "succeeded" });
        setNow(1_700_000_005_000);
        // The previous instance died dirty: no clean marker, so the successor walks.
        state.storageMap.delete("meta:clean");

        const second = new AlwaysSucceeding(state, env);

        await second.fetch(new Request("https://scheduler.internal/list"));

        // The new job keeps its rows and has no outcome yet.
        expect(state.storageMap.has("id:ran")).toBe(true);
        expect(state.storageMap.has("done:ran")).toBe(false);
        expect(state.storageMap.has("repair:ran")).toBe(false);
        await expect(getJob(second, "ran")).resolves.toMatchObject({ state: "pending" });
    });

    it("answers cancelled when the job was removed even if writing its outcome fails", async () => {
        expect.hasAssertions();

        pinClock(1_700_000_000_000);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "later", scheduledFor: Date.now() + 60_000 }));
        vi.spyOn(state.storage, "put").mockRejectedValueOnce(new Error("storage unavailable"));

        const response = await scheduler.fetch(post("/cancel", { id: "later" }));

        await expect(response.json()).resolves.toStrictEqual({ cancelled: true });
        expect(state.storageMap.has("id:later")).toBe(false);
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

    it("drops the old outcome of a reused id in the same commit as the replacement job", async () => {
        expect.hasAssertions();

        pinClock(1_700_000_000_000);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "again", scheduledFor: Date.now() + 60_000 }));
        await scheduler.fetch(post("/cancel", { id: "again" }));

        const order = watchWriteOrder(state);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "again", scheduledFor: Date.now() + 60_000 }));

        expect(order.overlapped()).toBe(true);
    });

    it("drops the dead row of a requeued job in the same commit as its revived header", async () => {
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

        const order = watchWriteOrder(state);

        await scheduler.fetch(post("/dead/retry", { id: "doomed" }));

        expect(order.overlapped()).toBe(true);
    });

    it("moves a corrected outcome's history entry in one commit", async () => {
        expect.hasAssertions();

        pinClock(1_700_000_000_000);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1);

        const drain = scheduler.alarm();

        await scheduler.entered("job-0");
        await scheduler.fetch(post("/cancel", { id: "job-0" }));

        const order = watchWriteOrder(state);

        scheduler.release("job-0", true);
        await drain;

        expect(order.overlapped()).toBe(true);
    });

    it("skips stale index entries instead of returning an empty page with a cursor", async () => {
        expect.hasAssertions();

        const setNow = pinClock(1_700_000_000_000);
        const scheduler = new BlockingScheduler(createFakeState(), env);
        const later = Date.now() + 60_000;

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: "real", scheduledFor: later }));
        await scheduler.fetch(post("/cancel", { id: "real" }));

        // A page's worth of newer index entries whose ids were scheduled again afterwards.
        for (let index = 0; index < 120; index += 1) {
            setNow(1_700_000_000_001 + index);
            // eslint-disable-next-line no-await-in-loop -- each cancel must land at its own instant
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: `reused-${String(index)}`, scheduledFor: later }));
            // eslint-disable-next-line no-await-in-loop -- same
            await scheduler.fetch(post("/cancel", { id: `reused-${String(index)}` }));
            // eslint-disable-next-line no-await-in-loop -- same
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.run", id: `reused-${String(index)}`, scheduledFor: later }));
        }

        const page = await history(scheduler);

        expect(page.records.map((record) => record.id)).toStrictEqual(["real"]);
        expect(page.truncated).toBe(false);
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
