import { afterEach, describe, expect, expectTypeOf, it } from "vitest";

import { SchedulerDO } from "../src/scheduler-do";
import type { ScheduleRecord } from "../src/types";
import { createAlarmHarness } from "./alarm-harness";
import { createFakeSocket, createFakeState, createFakeStateWithSockets } from "./fake-state";

interface ScheduleResponseBody {
    id: string;
    scheduledFor: number;
}

interface CancelResponseBody {
    cancelled: boolean;
}

const readSchedule = async (response: Response): Promise<ScheduleResponseBody> => response.json<ScheduleResponseBody>();

const readCancel = async (response: Response): Promise<CancelResponseBody> => response.json<CancelResponseBody>();

class TestScheduler extends SchedulerDO {
    public dispatched: ScheduleRecord[] = [];

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.dispatched.push(record);

        return true;
    }
}

/**
 * A scheduler whose dispatch fails the first `failuresBeforeSuccess` times,
 * then succeeds. With a large value it never succeeds, exercising the
 * dead-letter park path.
 */
class FailingScheduler extends SchedulerDO {
    public attempts = 0;

    public constructor(
        state: ConstructorParameters<typeof SchedulerDO>[0],
        env: ConstructorParameters<typeof SchedulerDO>[1],
        private readonly failuresBeforeSuccess: number,
    ) {
        super(state, env);
    }

    protected override async dispatch(): Promise<boolean> {
        this.attempts += 1;

        return this.attempts > this.failuresBeforeSuccess;
    }
}

const post = (path: string, body: unknown): Request =>
    new Request(`https://scheduler.internal${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const get = (path: string): Request => new Request(`https://scheduler.internal${path}`, { method: "GET" });

/** Read a /schedule response and return the typed id. */
const scheduledId = async (response: Response): Promise<string> => {
    const body = await response.json<ScheduleResponseBody>();

    return body.id;
};

describe("schedulerDO", () => {
    it("/schedule persists a record and sets the alarm to the earliest pending task", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const scheduledFor = Date.now() + 60_000;

        const response = await scheduler.fetch(
            post("/schedule", {
                args: { text: "hi" },
                functionPath: "messages.send",
                originUrl: "https://app.test",
                scheduledFor,
            }),
        );

        const body = await readSchedule(response);

        expect(response.status).toBe(200);
        expect(body.scheduledFor).toBe(scheduledFor);

        expectTypeOf(body.id).toBeString();

        expect(state.alarm).toBe(scheduledFor);
    });

    it("/schedule picks the earliest of two pending records for the alarm", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const later = Date.now() + 60_000;
        const sooner = Date.now() + 1000;

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "a", originUrl: "https://x.test", scheduledFor: later }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "b", originUrl: "https://x.test", scheduledFor: sooner }));

        expect(state.alarm).toBe(sooner);
    });

    it("/cancel removes a record and reschedules the alarm", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const later = Date.now() + 60_000;
        const sooner = Date.now() + 1000;

        const soonerResponse = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "b", originUrl: "https://x.test", scheduledFor: sooner }));
        const soonerBody = await readSchedule(soonerResponse);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "a", originUrl: "https://x.test", scheduledFor: later }));

        expect(state.alarm).toBe(sooner);

        const cancelResponse = await scheduler.fetch(post("/cancel", { id: soonerBody.id }));
        const cancelBody = await readCancel(cancelResponse);

        expect(cancelBody.cancelled).toBe(true);
        expect(state.alarm).toBe(later);
    });

    it("/cancel returns cancelled=false for an unknown id", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const response = await scheduler.fetch(post("/cancel", { id: "missing" }));
        const body = await readCancel(response);

        expect(body.cancelled).toBe(false);
    });

    it("alarm() dispatches due records and clears them from storage", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const now = Date.now();

        await scheduler.fetch(post("/schedule", { args: { x: 1 }, functionPath: "due", originUrl: "https://x.test", scheduledFor: now - 1000 }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "later", originUrl: "https://x.test", scheduledFor: now + 60_000 }));

        await scheduler.alarm();

        expect(scheduler.dispatched.map((d) => d.functionPath)).toEqual(["due"]);
        expect(scheduler.dispatched[0]?.args).toEqual({ x: 1 });
        // The "later" record stays pending and the alarm is rescheduled to its time.
        expect(state.alarm).toBe(now + 60_000);
    });

    it("/get returns a single record by id (direct O(1) read), or {} when absent", async () => {
        expect.assertions(4);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const scheduledFor = Date.now() + 60_000;

        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: { text: "hi" }, functionPath: "messages.send", scheduledFor })));

        const hit = await scheduler.fetch(get(`/get?id=${id}`));
        const hitBody = await hit.json<{ record?: ScheduleRecord }>();

        expect(hit.status).toBe(200);
        expect(hitBody.record?.functionPath).toBe("messages.send");

        const miss = await scheduler.fetch(get("/get?id=nope"));
        const missBody = await miss.json<{ record?: ScheduleRecord }>();

        expect(miss.status).toBe(200);
        expect(missBody.record).toBeUndefined();
    });

    it("/get requires an id", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const response = await scheduler.fetch(get("/get"));

        expect(response.status).toBe(400);
    });

    it("returns 404 for unknown routes", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const response = await scheduler.fetch(new Request("https://scheduler.internal/nope", { method: "POST" }));

        expect(response.status).toBe(404);
    });

    it("/schedule validates required fields", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const response = await scheduler.fetch(post("/schedule", { args: {} }));

        expect(response.status).toBe(400);
    });
});

describe("schedulerDO — live subscriptions", () => {
    /** Parse the records out of the latest `{type:"jobs"}` message a socket received. */
    const latestJobs = (sent: string[]): ScheduleRecord[] => {
        const last = sent.at(-1);

        return last === undefined ? [] : (JSON.parse(last) as { records: ScheduleRecord[] }).records;
    };

    it("pushes the job list to subscribers when a job is scheduled", async () => {
        expect.assertions(2);

        const state = createFakeStateWithSockets();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // Simulate an already-connected subscriber.
        state.acceptWebSocket?.(createFakeSocket() as never);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "a", originUrl: "https://x.test", scheduledFor: Date.now() + 10_000 }));

        const pushed = state.sockets[0]?.sent ?? [];

        expect(pushed.length).toBeGreaterThan(0);
        expect(latestJobs(pushed).map((record) => record.functionPath)).toEqual(["a"]);
    });

    it("pushes the updated list when a job is cancelled", async () => {
        expect.assertions(1);

        const state = createFakeStateWithSockets();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const scheduled = await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "a", originUrl: "https://x.test", scheduledFor: Date.now() + 10_000 }),
        );
        const { id } = await readSchedule(scheduled);

        // Connect after scheduling, then cancel — the cancel should push an empty list.
        state.sockets.length = 0;
        state.acceptWebSocket?.(createFakeSocket() as never);

        await scheduler.fetch(post("/cancel", { id }));

        expect(latestJobs(state.sockets[0]?.sent ?? [])).toEqual([]);
    });

    it("does not throw when broadcasting with no live sockets", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // No WS hooks on the plain fake — broadcast must be a silent no-op.
        const response = await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "a", originUrl: "https://x.test", scheduledFor: Date.now() + 10_000 }),
        );

        expect(response.status).toBe(200);
    });

    it("rejects a /ws upgrade when the runtime can't accept sockets", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const response = await scheduler.fetch(new Request("https://scheduler.internal/ws", { headers: { Upgrade: "websocket" } }));

        expect(response.status).toBe(501);
    });
});

describe("schedulerDO — retry / dead-letter pipeline", () => {
    /** Keys in the fake storage matching a prefix. */
    const keysWithPrefix = (state: ReturnType<typeof createFakeState>, prefix: string): string[] =>
        [...state.storageMap.keys()].filter((key) => key.startsWith(prefix));

    it("re-arms the index with exponential backoff on a failed dispatch", async () => {
        expect.assertions(4);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, Number.POSITIVE_INFINITY);
        const now = Date.now();

        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: now - 1000 })));

        await scheduler.alarm();

        // Header survives with attempts=1, a retry row exists, and a fresh time
        // index entry re-arms the alarm in the future (>= base backoff).
        const header = state.storageMap.get(`id:${id}`) as ScheduleRecord;

        expect(header.attempts).toBe(1);
        expect(keysWithPrefix(state, "retry:")).toHaveLength(1);
        expect(keysWithPrefix(state, "t:")).toHaveLength(1);
        // First backoff is RETRY_BASE_DELAY_MS (30s); alarm should be ~30s out.
        expect(state.alarm).toBeGreaterThan(now + 20_000);
    });

    it("grows the backoff delay across successive failures", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, Number.POSITIVE_INFINITY);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 }));

        const delays: number[] = [];

        // Drive 3 alarm fires; each time force the re-armed job due, capture the
        // attempts-scaled backoff (relative to the fire time) and re-fire.
        for (let index = 0; index < 3; index += 1) {
            const before = Date.now();

            // eslint-disable-next-line no-await-in-loop -- sequential alarm fires
            await scheduler.alarm();

            const retry = [...state.storageMap.entries()].find(([key]) => key.startsWith("retry:"))?.[1] as ScheduleRecord | undefined;

            if (retry) {
                delays.push(retry.scheduledFor - before);
                // Force it due again for the next iteration by rewriting the index.
                const indexKey = [...state.storageMap.keys()].find((key) => key.startsWith("t:"));

                if (indexKey !== undefined) {
                    state.storageMap.delete(indexKey);
                    state.storageMap.set(`t:${String(before - 1000).padStart(15, "0")}:${retry.id}`, retry.id);
                }
            }
        }

        // Each backoff is roughly double the previous (30s, 60s, 120s).
        expect(delays).toHaveLength(3);
        expect(delays[1] ?? 0).toBeGreaterThan(delays[0] ?? 0);
    });

    it("parks a job under dead: after MAX_RETRY_ATTEMPTS and clears id:/retry:", async () => {
        expect.assertions(4);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, Number.POSITIVE_INFINITY);

        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 })));

        // Fire the alarm enough times to exhaust MAX_RETRY_ATTEMPTS (5). Each
        // fire we force the re-armed entry due again.
        for (let index = 0; index < 7; index += 1) {
            const indexKey = [...state.storageMap.keys()].find((key) => key.startsWith("t:"));

            if (indexKey) {
                const recordId = state.storageMap.get(indexKey);

                state.storageMap.delete(indexKey);
                state.storageMap.set(`t:${"0".padStart(15, "0")}:${String(recordId)}`, recordId);
            }

            // eslint-disable-next-line no-await-in-loop -- sequential alarm fires
            await scheduler.alarm();
        }

        expect(keysWithPrefix(state, "dead:")).toEqual([`dead:${id}`]);
        expect(state.storageMap.has(`id:${id}`)).toBe(false);
        expect(keysWithPrefix(state, "retry:")).toHaveLength(0);

        const dead = state.storageMap.get(`dead:${id}`) as ScheduleRecord;

        expect(dead.attempts).toBeGreaterThan(5);
    });

    it("does not leave a dangling dispatched: marker (claim is index-only)", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 }));
        await scheduler.alarm();

        // The old crash-recovery marker protocol is gone: idempotency comes from
        // the time-index deletion alone, so no `dispatched:` key should ever
        // appear, and a successful fire leaves nothing behind.
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("dispatched:"))).toHaveLength(0);
        expect(state.storageMap.size).toBe(0);
    });

    it("preserves the job for retry when LUNORA_ORIGIN_URL is unset at fire time", async () => {
        expect.assertions(3);

        // Schedule with origin configured, then remove it before the alarm
        // (simulates a deploy/binding regression). The job must be retried, not
        // silently deleted.
        const state = createFakeState();
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 })));

        // Drop the origin and fire — real dispatch() returns false, routing to retry.
        (scheduler as unknown as { env: Record<string, unknown> }).env = {};
        await scheduler.alarm();

        expect(state.storageMap.has(`id:${id}`)).toBe(true);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("retry:"))).toHaveLength(1);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("dead:"))).toHaveLength(0);
    });
});

/**
 * These tests exercise the real Cloudflare alarm contract — `setAlarm(ts)` is
 * armed, the wall clock advances *to* that time, and only then does the runtime
 * deliver `alarm()`. The harness records every armed time and clears the alarm
 * before firing, so each test asserts the full schedule→fire wiring (the right
 * alarm time was set, advancing time fires it, re-scheduling sets the next
 * alarm) rather than calling `alarm()` directly with no scheduled-time check.
 */
describe("schedulerDO — alarm contract (fake clock)", () => {
    let dispose: (() => void) | undefined;

    afterEach(() => {
        dispose?.();
        dispose = undefined;
    });

    const harness = <T extends SchedulerDO>(
        factory: (state: ConstructorParameters<typeof SchedulerDO>[0], env: ConstructorParameters<typeof SchedulerDO>[1]) => T,
        now: number,
    ) => {
        const created = createAlarmHarness(factory, { env: { LUNORA_ORIGIN_URL: "https://app.test" }, now });

        dispose = created.dispose;

        return created;
    };

    it("arms the alarm for a runAfter-style schedule, then fires it when time reaches it", async () => {
        expect.assertions(5);

        const now = 1_700_000_000_000;
        const { scheduler, setAlarmCalls, currentAlarm, fastForwardToAlarm } = harness((state, env) => new TestScheduler(state, env), now);

        // runAt posts /schedule with an absolute time; runAfter is the same path
        // with `Date.now() + delayMs`. Schedule 60s out.
        await scheduler.fetch(
            post("/schedule", { args: { text: "hi" }, functionPath: "messages.send", originUrl: "https://app.test", scheduledFor: now + 60_000 }),
        );

        // The DO armed the alarm for exactly the scheduled time.
        expect(setAlarmCalls).toEqual([now + 60_000]);
        expect(currentAlarm()).toBe(now + 60_000);
        // Nothing has dispatched yet — the clock has not advanced.
        expect(scheduler.dispatched).toHaveLength(0);

        // Advancing time to the armed alarm fires it.
        const { firedAt } = await fastForwardToAlarm();

        expect(firedAt).toBe(now + 60_000);
        expect(scheduler.dispatched.map((record) => record.functionPath)).toEqual(["messages.send"]);
    });

    it("fires only the due job and re-arms setAlarm to the next pending entry", async () => {
        expect.assertions(4);

        const now = 1_700_000_000_000;
        const { scheduler, setAlarmCalls, fastForwardToAlarm, currentAlarm } = harness((state, env) => new TestScheduler(state, env), now);

        await scheduler.fetch(post("/schedule", { args: { x: 1 }, functionPath: "due", originUrl: "https://app.test", scheduledFor: now + 1000 }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "later", originUrl: "https://app.test", scheduledFor: now + 60_000 }));

        // Earliest-pending wins the alarm (armed to the sooner of the two).
        expect(currentAlarm()).toBe(now + 1000);

        const { firedAt } = await fastForwardToAlarm();

        // Only the record whose time has actually arrived dispatched.
        expect(firedAt).toBe(now + 1000);
        expect(scheduler.dispatched.map((record) => record.functionPath)).toEqual(["due"]);
        // alarm() re-armed setAlarm to the still-pending "later" job.
        expect(setAlarmCalls.at(-1)).toBe(now + 60_000);
    });

    it("fires both jobs across two alarm cycles, then clears the alarm when the queue drains", async () => {
        expect.assertions(3);

        const now = 1_700_000_000_000;
        const { scheduler, setAlarmCalls, fastForwardToAlarm, currentAlarm } = harness((state, env) => new TestScheduler(state, env), now);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "first", originUrl: "https://app.test", scheduledFor: now + 1000 }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "second", originUrl: "https://app.test", scheduledFor: now + 2000 }));

        await fastForwardToAlarm();
        await fastForwardToAlarm();

        expect(scheduler.dispatched.map((record) => record.functionPath)).toEqual(["first", "second"]);
        // Queue drained: the last alarm op was a deleteAlarm() (recorded as null).
        expect(currentAlarm()).toBeNull();
        expect(setAlarmCalls.at(-1)).toBeNull();
    });

    it("re-arms the alarm into the future on a failed dispatch (backoff fires on the next cycle)", async () => {
        expect.assertions(4);

        const now = 1_700_000_000_000;
        const { scheduler, setAlarmCalls, fastForwardToAlarm } = harness((state, env) => new FailingScheduler(state, env, Number.POSITIVE_INFINITY), now);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", originUrl: "https://app.test", scheduledFor: now + 1000 }));

        const { firedAt } = await fastForwardToAlarm();

        // The first attempt ran at the scheduled time and failed.
        expect(scheduler.attempts).toBe(1);

        // The DO re-armed the alarm ~RETRY_BASE_DELAY_MS (30s) past the fire time.
        const rearmed = setAlarmCalls.at(-1) ?? 0;

        expect(rearmed).toBeGreaterThan(firedAt + 20_000);

        // Advancing to the backoff alarm fires the retry — a second attempt.
        await fastForwardToAlarm();

        expect(scheduler.attempts).toBe(2);
        // Each failure pushes the next alarm further out (growing backoff).
        expect(setAlarmCalls.at(-1) ?? 0).toBeGreaterThan(rearmed);
    });
});
