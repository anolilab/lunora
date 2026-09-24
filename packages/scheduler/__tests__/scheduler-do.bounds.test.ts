import { afterEach, describe, expect, it, vi } from "vitest";

import createScheduler from "../src/create-scheduler";
import { SchedulerDO } from "../src/scheduler-do";
import type { DurableObjectNamespaceLike, ScheduleRecord } from "../src/types";
import { createFakeState } from "./fake-state";

const post = (path: string, body: unknown): Request =>
    new Request(`https://scheduler.internal${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const get = (path: string): Request => new Request(`https://scheduler.internal${path}`, { method: "GET" });

/**
 * The ONLY shape a `t:` index key may ever take: exactly TIME_PAD (15) digits.
 * A 16-digit key sorts above every `end` bound `alarm()` computes (so the job is
 * never listed again), and a key carrying `.` or `e+` additionally breaks the
 * `Number.parseInt()` time recovery in `alarm()`/`rescheduleAlarm()`.
 */
const WELL_FORMED_INDEX_KEY = /^t:\d{15}:/;

const timeKeys = (state: ReturnType<typeof createFakeState>): string[] => [...state.storageMap.keys()].filter((key) => key.startsWith("t:"));

/** Dispatch always fails the kick, so every alarm drives one step of the retry ladder. */
class FailingScheduler extends SchedulerDO {
    public attempts = 0;

    protected override async dispatch(): Promise<boolean> {
        this.attempts += 1;

        return false;
    }
}

const scheduledId = async (response: Response): Promise<string> => {
    const body = await response.json<{ id: string }>();

    return body.id;
};

/**
 * Replay what the Workers runtime actually does with the armed alarm: fire it,
 * jump the clock to whatever time the DO armed next, repeat. Returns every armed
 * time so a test can assert the DO never arms the alarm in the past — the
 * failure mode a bare attempt counter cannot see.
 */
const followAlarm = async (scheduler: SchedulerDO, state: ReturnType<typeof createFakeState>, fires: number): Promise<number[]> => {
    const armed: number[] = [];

    for (let index = 0; index < fires; index += 1) {
        const at = state.alarm;

        if (at === null) {
            break;
        }

        armed.push(at);
        vi.setSystemTime(Math.max(Date.now(), at));
        // eslint-disable-next-line no-await-in-loop -- sequential by design: each fire's armed time decides the next clock jump
        await scheduler.alarm();
    }

    return armed;
};

/** A namespace whose stub is a real in-process `SchedulerDO`, so the client seam is tested end to end. */
const doNamespace = (scheduler: SchedulerDO): DurableObjectNamespaceLike => {
    return {
        get: () => {
            return {
                fetch: async (input: Request | string, init?: RequestInit) => scheduler.fetch(new Request(typeof input === "string" ? input : input.url, init)),
            };
        },
        idFromName: (name: string) => {
            return { toString: () => name };
        },
    };
};

describe("schedulerDO — time-index bounds", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps the armed alarm in the future when a single retry backoff overflows the index", async () => {
        expect.assertions(3);

        vi.useFakeTimers({ toFake: ["Date"] });

        const start = 1_788_291_844_615;

        vi.setSystemTime(start);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        // normalizeRetry() accepts ANY finite non-negative baseMs. At 1e21 the
        // first retry time is >= 1e21, where `String()` switches to exponential
        // notation ('1e+21') — `rescheduleAlarm()`'s Number.parseInt() then reads
        // that back as 1 and arms the alarm at epoch millisecond 1, which the
        // runtime re-delivers immediately, forever.
        const id = await scheduledId(
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", retry: { baseMs: 1e21, maxAttempts: 5 }, scheduledFor: start })),
        );

        const armed = await followAlarm(scheduler, state, 5);

        expect(armed.filter((at) => at < start)).toStrictEqual([]);
        expect(timeKeys(state).filter((key) => !WELL_FORMED_INDEX_KEY.test(key))).toStrictEqual([]);
        expect(state.storageMap.has(`dead:${id}`)).toBe(true);
    });

    it("dead-letters instead of writing an unindexable time when the retry ladder overflows", async () => {
        expect.assertions(3);

        vi.useFakeTimers({ toFake: ["Date"] });

        const start = 1_788_291_844_615;

        vi.setSystemTime(start);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        // maxAttempts is validated as "any positive integer": 60 doublings of the
        // 30s default base runs the backoff past MAX_SCHEDULED_FOR_MS long before
        // the budget is spent.
        const id = await scheduledId(
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", retry: { baseMs: 30_000, maxAttempts: 60 }, scheduledFor: start })),
        );

        const armed = await followAlarm(scheduler, state, 80);

        // The clock only ever moves forward here, so an armed time before `start`
        // can only come from a parseInt() over a corrupted key — assert the ARMED
        // ALARM, not just an attempt counter: an alarm pinned in the past is
        // re-delivered by the runtime immediately, forever.
        expect(armed.filter((at) => at < start)).toStrictEqual([]);
        expect(timeKeys(state).filter((key) => !WELL_FORMED_INDEX_KEY.test(key))).toStrictEqual([]);
        expect(state.storageMap.has(`dead:${id}`)).toBe(true);
    });

    it("dead-letters instead of writing a fractional index key when the backoff is fractional", async () => {
        expect.assertions(2);

        vi.useFakeTimers({ toFake: ["Date"] });

        const start = 1_788_291_844_615;

        vi.setSystemTime(start);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        // A non-integer baseMs is accepted by normalizeRetry() today; the retry
        // time it produces carries a '.', which does not pad to TIME_PAD digits.
        const id = await scheduledId(
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", retry: { baseMs: 0.5, maxAttempts: 3 }, scheduledFor: start })),
        );

        await followAlarm(scheduler, state, 20);

        expect(timeKeys(state).filter((key) => !WELL_FORMED_INDEX_KEY.test(key))).toStrictEqual([]);
        expect(state.storageMap.has(`dead:${id}`)).toBe(true);
    });
});

describe("schedulerDO — bounded reads", () => {
    it("never issues an unbounded storage.list() for /list, /dead or /status", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const seen: { limit?: number; prefix?: string }[] = [];
        const inner = state.storage.list;

        state.storage.list = async <T = unknown>(options: { end?: string; limit?: number; prefix?: string; startAfter?: string } = {}) => {
            seen.push(options);

            return inner<T>(options);
        };

        for (let index = 0; index < 250; index += 1) {
            const key = String(index).padStart(4, "0");

            state.storageMap.set(`dead:d${key}`, { args: {}, attempts: 6, enqueuedAt: 1, functionPath: "f", id: `d${key}`, scheduledFor: 1 });
            state.storageMap.set(`id:j${key}`, { args: {}, enqueuedAt: 1, functionPath: "f", id: `j${key}`, pool: "mail", scheduledFor: 1 });
        }

        state.storageMap.set("pool:mail", { inFlight: 1, inFlightIds: ["j0000"], maxConcurrency: 2 });

        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduler.fetch(get("/list"));

        const deadResponse = await scheduler.fetch(get("/dead"));
        const deadBody = await deadResponse.json<{ records: unknown[]; truncated?: boolean }>();

        await scheduler.fetch(get("/status"));

        expect(deadBody.records).toHaveLength(100);
        expect(deadBody.truncated).toBe(true);
        expect(seen.filter((options) => typeof options.limit !== "number")).toStrictEqual([]);
    });
});

describe("createScheduler — paging over the DO's bounded pages", () => {
    it("list() returns every pending job, not just the DO's first page", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const client = createScheduler({ namespace: doNamespace(scheduler) });

        for (let index = 0; index < 150; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- 150 sequential enqueues against one in-process DO
            await client.runAt(Date.now() + 60_000, "jobs:tick" as never, {} as never);
        }

        const listed = await client.list();

        expect(listed).toHaveLength(150);
    });

    it("dead() returns every parked record, not just the DO's first page", async () => {
        expect.assertions(1);

        const state = createFakeState();

        for (let index = 0; index < 250; index += 1) {
            const key = String(index).padStart(4, "0");
            const record: ScheduleRecord = { args: {}, attempts: 6, enqueuedAt: 1, functionPath: "f", id: `d${key}`, scheduledFor: 1 };

            state.storageMap.set(`dead:d${key}`, record);
        }

        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const client = createScheduler({ namespace: doNamespace(scheduler) });

        await expect(client.dead()).resolves.toHaveLength(250);
    });
});
