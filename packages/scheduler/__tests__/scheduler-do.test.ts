import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

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

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "a", scheduledFor: later }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "b", scheduledFor: sooner }));

        expect(state.alarm).toBe(sooner);
    });

    it("/cancel removes a record and reschedules the alarm", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const later = Date.now() + 60_000;
        const sooner = Date.now() + 1000;

        const soonerResponse = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "b", scheduledFor: sooner }));
        const soonerBody = await readSchedule(soonerResponse);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "a", scheduledFor: later }));

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

        await scheduler.fetch(post("/schedule", { args: { x: 1 }, functionPath: "due", scheduledFor: now - 1000 }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "later", scheduledFor: now + 60_000 }));

        await scheduler.alarm();

        expect(scheduler.dispatched.map((d) => d.functionPath)).toEqual(["due"]);
        expect(scheduler.dispatched[0]?.args).toEqual({ x: 1 });
        // The "later" record stays pending and the alarm is rescheduled to its time.
        expect(state.alarm).toBe(now + 60_000);
    });

    it("/schedule accepts a workflow target (no functionPath) and alarm() dispatches it", async () => {
        expect.assertions(4);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const now = Date.now();

        // A workflow/agent schedule carries a `workflow` binding instead of a functionPath.
        const response = await scheduler.fetch(post("/schedule", { args: { prompt: "digest" }, scheduledFor: now - 1000, workflow: "AGENT_SUPPORT" }));

        expect(response.status).toBe(200);

        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(1);
        expect(scheduler.dispatched[0]?.workflow).toBe("AGENT_SUPPORT");
        // The stored record carries no functionPath — the two targets are exclusive.
        expect(scheduler.dispatched[0]?.functionPath).toBeUndefined();
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

    it("/schedule stores the record under a caller-supplied id", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const scheduledFor = Date.now() + 60_000;

        // `@lunora/server`'s deferred-schedule facade hands a mutation handler the
        // id synchronously and only makes the call after the transaction commits,
        // so the id it answered has to be the one the record ends up under.
        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "messages.send", id: "pre-minted_1-A", scheduledFor })));

        expect(id).toBe("pre-minted_1-A");

        const hit = await scheduler.fetch(get("/get?id=pre-minted_1-A"));
        const hitBody = await hit.json<{ record?: ScheduleRecord }>();

        expect(hitBody.record?.functionPath).toBe("messages.send");

        // An id that could corrupt the `id:` / `t:<padded>:<id>` storage keys is
        // ignored rather than trusted, and the DO mints its own.
        const rejected = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "messages.send", id: "bad:id", scheduledFor })));

        expect(rejected).not.toBe("bad:id");
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

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "a", scheduledFor: Date.now() + 10_000 }));

        const pushed = state.sockets[0]?.sent ?? [];

        expect(pushed.length).toBeGreaterThan(0);
        expect(latestJobs(pushed).map((record) => record.functionPath)).toEqual(["a"]);
    });

    it("pushes the updated list when a job is cancelled", async () => {
        expect.assertions(1);

        const state = createFakeStateWithSockets();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const scheduled = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "a", scheduledFor: Date.now() + 10_000 }));
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
        const response = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "a", scheduledFor: Date.now() + 10_000 }));

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

describe("schedulerDO — bounded listing", () => {
    /** Directly seed `id:<prefix>-NNNN` headers, bypassing /schedule for speed with large counts. */
    const seedHeaders = (state: ReturnType<typeof createFakeState>, count: number, options: { pool?: string; prefix?: string } = {}): void => {
        const prefix = options.prefix ?? "job";

        for (let index = 0; index < count; index += 1) {
            const id = `${prefix}-${String(index).padStart(4, "0")}`;
            const record: ScheduleRecord = {
                args: {},
                enqueuedAt: Date.now(),
                functionPath: "f",
                id,
                scheduledFor: Date.now() + 60_000,
                ...(options.pool === undefined ? {} : { pool: options.pool }),
            };

            state.storageMap.set(`id:${id}`, record);
        }
    };

    it("gET /list returns at most 100 records with truncated: true when more are pending", async () => {
        expect.assertions(3);

        const state = createFakeState();

        seedHeaders(state, 150);

        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const response = await scheduler.fetch(get("/list"));
        const body = await response.json<{ records: ScheduleRecord[]; truncated: boolean }>();

        expect(body.records).toHaveLength(100);
        expect(body.truncated).toBe(true);
        expect(new Set(body.records.map((record) => record.id)).size).toBe(100);
    });

    it("gET /list returns truncated: false when the backlog is at or under the page size", async () => {
        expect.assertions(2);

        const state = createFakeState();

        seedHeaders(state, 42);

        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const response = await scheduler.fetch(get("/list"));
        const body = await response.json<{ records: ScheduleRecord[]; truncated: boolean }>();

        expect(body.records).toHaveLength(42);
        expect(body.truncated).toBe(false);
    });

    it("a broadcastChange-triggering mutation carries the bounded { records, truncated } shape", async () => {
        expect.assertions(3);

        const state = createFakeStateWithSockets();

        seedHeaders(state, 150);

        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // Simulate an already-connected subscriber (as the sibling live-subscription
        // tests do above — the real `/ws` upgrade needs a runtime `WebSocketPair`,
        // which the node-mock test environment doesn't provide; that path is only
        // exercisable under the opt-in `workerd` project. handleWebSocketUpgrade()'s
        // seed message is built from the same listRecords() call and put through the
        // same JSON.stringify shape as broadcastChange() below, so this still covers
        // the wire format both paths emit.)
        state.acceptWebSocket?.(createFakeSocket() as never);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "new", scheduledFor: Date.now() + 10_000 }));

        const changeMessage = JSON.parse(state.sockets[0]?.sent.at(-1) ?? "{}") as { records: ScheduleRecord[]; truncated: boolean; type: string };

        expect(changeMessage.type).toBe("jobs");
        expect(changeMessage.truncated).toBe(true);
        expect(changeMessage.records).toHaveLength(100);
    });

    it("gET /status and GET /pool report EXACT counts (not capped) across >100 headers in two pools", async () => {
        expect.assertions(3);

        const state = createFakeState();

        seedHeaders(state, 60, { pool: "a", prefix: "a-job" });
        seedHeaders(state, 70, { pool: "b", prefix: "b-job" });
        // handleStatus()'s poolRows scan needs a durable `pool:<name>` row per pool.
        state.storageMap.set("pool:a", { inFlight: 0, maxConcurrency: 5 });
        state.storageMap.set("pool:b", { inFlight: 0, maxConcurrency: 5 });

        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const statusResponse = await scheduler.fetch(get("/status"));
        const status = await statusResponse.json<{ backlog: number; pools: { name: string; queued: number }[] }>();

        expect(status.backlog).toBe(130);

        const poolAResponse = await scheduler.fetch(get("/pool?name=a"));
        const poolA = await poolAResponse.json<{ queued: number }>();

        expect(poolA.queued).toBe(60);

        const poolBResponse = await scheduler.fetch(get("/pool?name=b"));
        const poolB = await poolBResponse.json<{ queued: number }>();

        expect(poolB.queued).toBe(70);
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

    it("does not requeue a job whose dead-letter row is already durable", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, Number.POSITIVE_INFINITY);
        const realDelete = state.storage.delete.bind(state.storage);

        // `parkDead` writes `dead:<id>` and THEN clears the pending rows. Fail
        // that clear: the park is durable, the error reaches
        // `drainRecordGuarded`, and re-asserting the time index there dispatched
        // a job that already has a terminal record — a duplicate run of a
        // workflow or any other non-idempotent job.
        state.storage.delete = async (keyOrKeys: string | string[]) => {
            if (Array.isArray(keyOrKeys) && keyOrKeys.some((key) => key.startsWith("id:"))) {
                throw new Error("storage unavailable");
            }

            return realDelete(keyOrKeys);
        };

        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 })));

        // Force the re-armed job due, moving the HEADER's `scheduledFor` with the
        // index key: `alarm()` reads the record off the header, so a rewrite that
        // touches only the index leaves the claim delete pointing at a key that
        // no longer exists and the forced entry survives every pass.
        const forceDue = (): void => {
            const indexKey = [...state.storageMap.keys()].find((key) => key.startsWith("t:"));

            if (indexKey === undefined) {
                return;
            }

            const recordId = String(state.storageMap.get(indexKey));
            const header = state.storageMap.get(`id:${recordId}`) as ScheduleRecord | undefined;

            state.storageMap.delete(indexKey);

            if (header !== undefined) {
                state.storageMap.set(`id:${recordId}`, { ...header, scheduledFor: 0 });
            }

            state.storageMap.set(`t:${"0".padStart(15, "0")}:${recordId}`, recordId);
        };

        for (let index = 0; index < 7; index += 1) {
            forceDue();

            // eslint-disable-next-line no-await-in-loop -- sequential alarm fires
            await scheduler.alarm();
        }

        const dispatchedByPark = scheduler.attempts;

        await scheduler.alarm();

        expect(state.storageMap.has(`dead:${id}`)).toBe(true);
        expect(keysWithPrefix(state, "t:")).toHaveLength(0);
        expect(scheduler.attempts).toBe(dispatchedByPark);
    });

    it("logs a warning when a job is parked in the dead-letter store", async () => {
        expect.assertions(2);

        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
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

            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0]?.[0]).toContain(id);
        } finally {
            warnSpy.mockRestore();
        }
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

    it("deletes a dangling time-index entry whose id: header is missing instead of busy-looping", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const now = Date.now();

        // A stale index entry (past time) pointing at an id: header that no
        // longer exists — the orphan a partial-failure path can leave behind.
        const danglingKey = `t:${String(now - 5000).padStart(15, "0")}:ghost`;

        state.storageMap.set(danglingKey, "ghost");

        // A real future job so rescheduleAlarm() has a legitimate next time.
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "real", scheduledFor: now + 60_000 }));

        await scheduler.alarm();

        // The orphan is cleaned up, nothing was dispatched for it, and the alarm
        // is armed to the real future job — NOT stuck re-arming the past dangling
        // time (which would fire, find no record, and busy-loop forever).
        expect(state.storageMap.has(danglingKey)).toBe(false);
        expect(scheduler.dispatched).toHaveLength(0);
        expect(state.alarm).toBe(now + 60_000);
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

describe("schedulerDO — dead-letter admin endpoints", () => {
    /** Schedule a job and drive the alarm until it exhausts its retries and parks under `dead:`. */
    const parkDeadJob = async (state: ReturnType<typeof createFakeState>, functionPath = "f", requestedId?: string): Promise<string> => {
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, Number.POSITIVE_INFINITY);
        const id = await scheduledId(
            await scheduler.fetch(
                post("/schedule", {
                    args: { n: 1 },
                    functionPath,
                    ...(requestedId === undefined ? {} : { id: requestedId }),
                    scheduledFor: Date.now() - 1000,
                }),
            ),
        );

        for (let index = 0; index < 7; index += 1) {
            const indexKey = [...state.storageMap.keys()].find((key) => key.startsWith("t:"));

            if (indexKey) {
                const recordId = state.storageMap.get(indexKey);

                state.storageMap.delete(indexKey);
                state.storageMap.set(`t:${"0".padStart(15, "0")}:${String(recordId)}`, recordId);
            }

            // eslint-disable-next-line no-await-in-loop -- sequential alarm fires to exhaust the retry budget
            await scheduler.alarm();
        }

        // The loop force-creates `t:0:<id>` index rows whose key doesn't match
        // the record's real `scheduledFor`, so alarm()'s indexKey-based delete
        // can't clear them. Strip those test artifacts so the parked state
        // matches reality: a dead-lettered job has no pending index entry and
        // (with nothing else queued) no armed alarm.
        for (const key of [...state.storageMap.keys()].filter((candidate) => candidate.startsWith("t:"))) {
            state.storageMap.delete(key);
        }

        // eslint-disable-next-line no-param-reassign -- resetting the mutable fake DurableObjectState double this helper is handed
        state.alarm = null;

        return id;
    };

    it("gET /dead lists parked records that never appear in /list", async () => {
        expect.assertions(4);

        const state = createFakeState();
        const id = await parkDeadJob(state);
        // A fresh DO instance over the same storage — the admin reader is separate from the failing dispatcher.
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const deadResponse = await scheduler.fetch(get("/dead"));
        const listResponse = await scheduler.fetch(get("/list"));
        const dead = await deadResponse.json<{ records: { attempts?: number; id?: string }[] }>();
        const list = await listResponse.json<{ records: unknown[] }>();

        expect(dead.records).toHaveLength(1);
        expect(dead.records[0]?.id).toBe(id);
        expect(dead.records[0]?.attempts ?? 0).toBeGreaterThan(5);
        expect(list.records).toHaveLength(0);
    });

    it("pOST /dead/retry resurrects a job with a fresh retry budget and re-arms the alarm", async () => {
        expect.assertions(5);

        const state = createFakeState();
        const id = await parkDeadJob(state);
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const response = await scheduler.fetch(post("/dead/retry", { id }));
        const result = await response.json<{ retried: boolean; scheduledFor: number }>();

        expect(result.retried).toBe(true);
        // The dead row is gone, a live header is back, and the alarm is armed for the resurrected job.
        expect(state.storageMap.has(`dead:${id}`)).toBe(false);

        const header = state.storageMap.get(`id:${id}`) as ScheduleRecord | undefined;

        expect(header?.attempts).toBe(0);
        // A fresh time-index entry re-arms the resurrected job at its new due time.
        expect(state.storageMap.has(`t:${String(result.scheduledFor).padStart(15, "0")}:${id}`)).toBe(true);
        expect(state.alarm).toBe(result.scheduledFor);
    });

    it("refuses a caller-supplied id the workflow engine would reject", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // Minting over it stored the job under an id the caller never sees, so a
        // repeated call scheduled a SECOND job rather than answering 409.
        const response = await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "jobs.charge", id: "-daily-2026-09-06", scheduledFor: Date.now() + 60_000 }),
        );

        expect(response.status).toBe(400);
        await expect(response.json<{ error: { code: string } }>()).resolves.toMatchObject({ error: { code: "INVALID_SCHEDULE_ID" } });
        expect([...state.storageMap.keys()]).toStrictEqual([]);
    });

    it("refuses a caller-supplied id a dead-letter record still holds, so /dead/retry cannot overwrite the new job", async () => {
        expect.assertions(4);

        const state = createFakeState();
        const id = await parkDeadJob(state, "f", "invoice-42");
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        expect(id).toBe("invoice-42");

        // A dead record keeps no `id:` header, so a pending-only conflict check
        // let the id be reused. `/dead/retry` then wrote the revived corpse over
        // the new job's header and added a second `t:` index under the same id:
        // the new job was gone and the dead one fired in its place.
        const reused = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.charge", id: "invoice-42", scheduledFor: Date.now() + 60_000 }));

        expect(reused.status).toBe(409);
        await expect(reused.json<{ error: { code: string } }>()).resolves.toMatchObject({ error: { code: "DUPLICATE_SCHEDULE_ID" } });

        // The dead record is the only thing that answers to the id — nothing new
        // was written under it.
        const listResponse = await scheduler.fetch(get("/list"));
        const listed = await listResponse.json<{ records: unknown[] }>();

        expect(listed.records).toHaveLength(0);
    });

    it("pOST /dead/retry is a no-op for an unknown id", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const response = await scheduler.fetch(post("/dead/retry", { id: "nope" }));
        const result = await response.json<{ retried: boolean }>();

        expect(result.retried).toBe(false);
    });

    it("pOST /dead/cancel purges a parked record and is idempotent", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const id = await parkDeadJob(state);
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const firstResponse = await scheduler.fetch(post("/dead/cancel", { id }));
        const first = await firstResponse.json<{ removed: boolean }>();
        const secondResponse = await scheduler.fetch(post("/dead/cancel", { id }));
        const second = await secondResponse.json<{ removed: boolean }>();

        expect(first.removed).toBe(true);
        expect(second.removed).toBe(false);
        expect(state.storageMap.has(`dead:${id}`)).toBe(false);
    });

    it("pOST /dead/retry and /dead/cancel reject a missing id", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const retryResponse = await scheduler.fetch(post("/dead/retry", {}));
        const cancelResponse = await scheduler.fetch(post("/dead/cancel", {}));

        expect(retryResponse.status).toBe(400);
        expect(cancelResponse.status).toBe(400);
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
        await scheduler.fetch(post("/schedule", { args: { text: "hi" }, functionPath: "messages.send", scheduledFor: now + 60_000 }));

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

    it("refuses a caller-supplied id that is already scheduled, instead of firing the newer job at the older time", async () => {
        expect.assertions(4);

        const now = 1_700_000_000_000;
        const { scheduler, fastForwardToAlarm, currentAlarm } = harness((state, env) => new TestScheduler(state, env), now);

        const first = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.remind", id: "reminder-42", scheduledFor: now + 1000 }));
        // Same id, five seconds later. Accepting it overwrites the `id:` header
        // while BOTH `t:` index entries survive, so the drain dispatches the
        // t+5000 record at t+1000 and then deletes the entry it should have
        // fired at — the job runs four seconds early and never runs again.
        const second = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.remind", id: "reminder-42", scheduledFor: now + 5000 }));

        expect(first.status).toBe(200);
        expect(second.status).toBe(409);

        await fastForwardToAlarm();

        // The record that fired is the one that was actually scheduled, at its
        // own time — and the queue is drained, not left holding a phantom entry.
        expect(scheduler.dispatched.map((record) => record.scheduledFor)).toStrictEqual([now + 1000]);
        expect(currentAlarm()).toBeNull();
    });

    it("fires only the due job and re-arms setAlarm to the next pending entry", async () => {
        expect.assertions(4);

        const now = 1_700_000_000_000;
        const { scheduler, setAlarmCalls, fastForwardToAlarm, currentAlarm } = harness((state, env) => new TestScheduler(state, env), now);

        await scheduler.fetch(post("/schedule", { args: { x: 1 }, functionPath: "due", scheduledFor: now + 1000 }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "later", scheduledFor: now + 60_000 }));

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

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "first", scheduledFor: now + 1000 }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "second", scheduledFor: now + 2000 }));

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

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: now + 1000 }));

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

/**
 * Drive the REAL `dispatch()` (the production fetch path the unit suites stub
 * out) against a fake `globalThis.fetch`, so the 2xx-only success contract and
 * the outbound auth header are actually exercised. The other suites override
 * `dispatch()` and never see this code.
 */
describe("schedulerDO — real dispatch() fetch contract", () => {
    let restoreFetch: (() => void) | undefined;

    afterEach(() => {
        restoreFetch?.();
        restoreFetch = undefined;
    });

    /** Stub global fetch with a fixed status; capture every request it sees. */
    const stubFetch = (status: number): { calls: { headers: Headers; url: string }[] } => {
        const calls: { headers: Headers; url: string }[] = [];
        const stub = vi.fn<typeof fetch>(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = input instanceof Request ? input.url : String(input);

            calls.push({ headers: new Headers(init?.headers), url });

            return new Response(null, { status });
        });
        const original = globalThis.fetch;

        globalThis.fetch = stub;
        restoreFetch = () => {
            globalThis.fetch = original;
        };

        return { calls };
    };

    it("clears the job on a 2xx dispatch (success)", async () => {
        expect.assertions(2);

        stubFetch(200);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 })));

        await scheduler.alarm();

        // A 2xx is the only success: the header is gone and nothing was parked.
        expect(state.storageMap.has(`id:${id}`)).toBe(false);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("dead:"))).toHaveLength(0);
    });

    it("retries (does NOT delete) when the receiver route is missing (404)", async () => {
        expect.assertions(2);

        stubFetch(404);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 })));

        await scheduler.alarm();

        // 404 is a transient/route-missing failure, not success: the job is kept
        // for retry rather than silently dropped.
        expect(state.storageMap.has(`id:${id}`)).toBe(true);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("retry:"))).toHaveLength(1);
    });

    it("retries on a 400 application rejection rather than deleting", async () => {
        expect.assertions(1);

        stubFetch(400);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 })));

        await scheduler.alarm();

        // Any non-2xx (incl. a permanent 400) is preserved — never silently deleted.
        expect(state.storageMap.has(`id:${id}`)).toBe(true);
    });

    it("routes a thrown dispatch (network error / crypto failure) to retry rather than orphaning the job", async () => {
        expect.assertions(3);

        // A throw inside dispatch() (e.g. fetch rejects, or crypto.subtle fails
        // while signing) must NOT escape alarm(): the time-index entry is already
        // claimed/deleted before dispatch runs, so an un-retried throw would leave
        // a header with no index that can never re-fire. dispatch() must catch it
        // and return false so alarm() re-arms the job via recordRetry().
        const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            throw new Error("connect ECONNREFUSED");
        });

        restoreFetch = () => {
            spy.mockRestore();
        };

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 })));

        await expect(scheduler.alarm()).resolves.toBeUndefined();

        // The job survives: a live header, a retry row, and a re-armed time index.
        expect(state.storageMap.has(`id:${id}`)).toBe(true);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("retry:"))).toHaveLength(1);
    });

    it("posts to /_lunora/scheduler/dispatch with an HMAC signature header when a secret is set", async () => {
        expect.assertions(3);

        const { calls } = stubFetch(200);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, {
            LUNORA_ORIGIN_URL: "https://app.test",
            LUNORA_SCHEDULER_SECRET: "s3cr3t",
        });

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 }));
        await scheduler.alarm();

        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe("https://app.test/_lunora/scheduler/dispatch");
        // The body is HMAC-signed so the receiver can reject anonymous callers.
        expect((calls[0]?.headers.get("x-lunora-scheduler-signature") ?? "").length).toBeGreaterThan(0);
    });

    it("falls back to a bearer admin token when no HMAC secret is configured", async () => {
        expect.assertions(2);

        const { calls } = stubFetch(200);

        const state = createFakeState();
        const scheduler = new SchedulerDO(state, {
            LUNORA_ADMIN_TOKEN: "admin-token",
            LUNORA_ORIGIN_URL: "https://app.test",
        });

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 }));
        await scheduler.alarm();

        expect(calls[0]?.headers.get("x-lunora-scheduler-signature")).toBeNull();
        expect(calls[0]?.headers.get("authorization")).toBe("Bearer admin-token");
    });
});

describe("schedulerDO — scheduledFor validation", () => {
    it("rejects an out-of-range scheduledFor (>= 1e21) that would corrupt the time index", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // String(1e21) === "1e+21": padStart can't zero-pad it and parseInt
        // recovery stops at the 'e', so such a job would mis-sort and fire at
        // epoch ≈ 0. It must be rejected up front.
        const response = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: 1e21 }));

        expect(response.status).toBe(400);
        // Nothing was persisted for the rejected schedule.
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("id:"))).toHaveLength(0);
    });

    it("rejects a non-integer / non-finite scheduledFor", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const nonIntegerResponse = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: 1.5 }));
        const nonFiniteResponse = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Number.POSITIVE_INFINITY }));

        expect(nonIntegerResponse.status).toBe(400);
        expect(nonFiniteResponse.status).toBe(400);
    });

    it("accepts the largest scheduledFor that still pads to a uniform width", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // 999_999_999_999_999 (1e15 - 1) is the largest accepted value: it fits
        // in exactly TIME_PAD (15) digits, so its time-index key keeps the
        // lexical-order == numeric-order invariant.
        const response = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: 999_999_999_999_999 }));

        expect(response.status).toBe(200);
    });

    it("rejects a scheduledFor one digit wider than the pad width (would break the index sort)", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // 1e15 is 16 digits — one wider than TIME_PAD (15) — so it would zero-pad
        // to a 16-char key that sorts BEFORE shorter 15-char keys (e.g.
        // "1000000000000000" < "200000000000000"), mis-ordering the alarm. It
        // must be rejected up front and nothing persisted.
        const response = await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: 1_000_000_000_000_000 }));

        expect(response.status).toBe(400);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("id:"))).toHaveLength(0);
    });
});

describe("schedulerDO — per-record drain isolation (storage throw)", () => {
    /**
     * A scheduler that fails `dispatch()` only for records whose `functionPath`
     * is in `poison`, and succeeds for everything else. Failing dispatch routes a
     * record through `recordRetry()`, whose storage writes the test then makes
     * throw — exercising the per-record error guard in `alarm()`.
     */
    class SelectiveScheduler extends SchedulerDO {
        public dispatched: ScheduleRecord[] = [];

        public constructor(
            state: ConstructorParameters<typeof SchedulerDO>[0],
            env: ConstructorParameters<typeof SchedulerDO>[1],
            private readonly poison: ReadonlySet<string>,
        ) {
            super(state, env);
        }

        protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
            if (this.poison.has(record.functionPath ?? "")) {
                return false;
            }

            this.dispatched.push(record);

            return true;
        }
    }

    /**
     * Wrap `state.storage.put` so any write touching a key that contains
     * `needle` throws, simulating a transient storage failure for exactly one
     * record's drain. All other writes pass through.
     */
    const makePutThrowFor = (state: ReturnType<typeof createFakeState>, needle: string): void => {
        const innerPut = state.storage.put.bind(state.storage);

        // eslint-disable-next-line no-param-reassign -- intentionally instrumenting the fake storage
        state.storage.put = async <T = unknown>(entries: Record<string, T> | string, value?: T): Promise<void> => {
            const keys = typeof entries === "string" ? [entries] : Object.keys(entries);

            if (keys.some((key) => key.includes(needle))) {
                throw new Error(`simulated storage failure for ${needle}`);
            }

            await innerPut(entries, value);
        };
    };

    it("drains the other due records and still re-arms the alarm when one record's storage op throws", async () => {
        expect.assertions(5);

        const state = createFakeState();
        // "poison" fails dispatch → recordRetry → retry:<id> put, which we make throw.
        const scheduler = new SelectiveScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, new Set(["poison"]));
        const now = Date.now();

        const poisonId = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "poison", scheduledFor: now - 2000 })));

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "ok-a", scheduledFor: now - 1500 }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "ok-b", scheduledFor: now - 1000 }));
        // A still-pending future job so rescheduleAlarm() has a next time to arm.
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "later", scheduledFor: now + 60_000 }));

        // Only the poison record's recordRetry() write throws.
        makePutThrowFor(state, `retry:${poisonId}`);

        // Must NOT throw out of alarm() — the per-record guard contains it.
        await expect(scheduler.alarm()).resolves.toBeUndefined();

        // The two healthy due records still dispatched despite the poison throw.
        expect(scheduler.dispatched.map((record) => record.functionPath ?? "").toSorted((left, right) => left.localeCompare(right))).toEqual(["ok-a", "ok-b"]);

        // rescheduleAlarm() still ran (finally) and armed the next pending time.
        // The poison record was re-claimed (re-fireable) at its original time
        // (now - 2000), which is the earliest pending index, so the alarm arms there.
        expect(state.alarm).toBe(now - 2000);

        // The poison record remains re-fireable: its time-index claim was
        // restored by the per-record catch (recordRetry never committed).
        const poisonIndexKeys = [...state.storageMap.keys()].filter((key) => key.startsWith("t:") && key.endsWith(`:${poisonId}`));

        expect(poisonIndexKeys).toHaveLength(1);
        // Its header survives too, so a later alarm can re-attempt it.
        expect(state.storageMap.has(`id:${poisonId}`)).toBe(true);
    });

    it("a later alarm successfully re-fires the record that previously threw (at-least-once)", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new SelectiveScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, new Set(["poison"]));
        const now = Date.now();

        const poisonId = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "poison", scheduledFor: now - 1000 })));

        makePutThrowFor(state, `retry:${poisonId}`);
        await scheduler.alarm();

        // First pass: the record threw mid-retry and was re-claimed, never dispatched.
        expect(scheduler.dispatched).toHaveLength(0);

        // Heal storage and let dispatch succeed this time, then re-fire.
        const healed = new SelectiveScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, new Set());

        await healed.alarm();

        // The previously-failed record fired exactly once on the recovery pass.
        expect(healed.dispatched.map((record) => record.functionPath)).toEqual(["poison"]);
    });

    it("a successfully-dispatched record is NOT re-fired even if its cleanup delete throws", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const now = Date.now();

        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "ok", scheduledFor: now - 1000 })));

        // Make the post-dispatch cleanup delete (header + retry rows) throw.
        const innerDelete = state.storage.delete.bind(state.storage);

        state.storage.delete = async (keyOrKeys: string | string[]): Promise<number> => {
            const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];

            if (keys.includes(`id:${id}`)) {
                throw new Error("simulated cleanup failure");
            }

            return (await innerDelete(keyOrKeys)) as number;
        };

        await expect(scheduler.alarm()).resolves.toBeUndefined();

        // The job was dispatched, so its time-index claim must stay deleted — a
        // re-fire would double-dispatch an already-run job. (Its header may
        // linger from the failed cleanup, which is a harmless idempotent residue.)
        const indexKeys = [...state.storageMap.keys()].filter((key) => key.startsWith("t:") && key.endsWith(`:${id}`));

        expect(indexKeys).toHaveLength(0);
    });

    it("re-fires a job whose time-index claim was deleted by a dispatch its instance did not survive", async () => {
        expect.assertions(5);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "messages.send", scheduledFor: Date.now() - 1000 })));

        // The eviction. `drainRecordGuarded` deletes the `t:` claim and AWAITS
        // it — the output gate holds the outbound fetch until that delete is
        // durable — so a Durable Object lost during the dispatch leaves the
        // `id:` header behind with no index entry. Nothing re-indexes it:
        // `rescheduleAlarm` derives the clock from `t:` alone and `alarm()`
        // reconciles only the inverse orphan.
        const claimKey = [...state.storageMap.keys()].find((key) => key.startsWith("t:"));

        state.storageMap.delete(claimKey ?? "");

        expect([...state.storageMap.keys()].filter((key) => key.startsWith("t:"))).toHaveLength(0);
        expect(state.storageMap.has(`id:${id}`)).toBe(true);

        // A FRESH instance: the crash ended the one that minted the orphan.
        const revived = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await revived.alarm();

        expect(revived.dispatched.map((record) => record.id)).toEqual([id]);
        // Settled, so both the header and the re-put claim are gone again.
        expect(state.storageMap.has(`id:${id}`)).toBe(false);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("t:"))).toHaveLength(0);
    });

    it("recovers that orphan from the fetch entry point too — the crash left no alarm to recover from", async () => {
        expect.assertions(5);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "messages.send", scheduledFor: Date.now() - 1000 })));

        // The same eviction as above — but the death happens BEFORE the trailing
        // `rescheduleAlarm()`, so the alarm the DO would have re-armed was never
        // written. Recovery reachable only from `alarm()` is therefore recovery
        // that never runs: nothing will ever deliver one.
        const claimKey = [...state.storageMap.keys()].find((key) => key.startsWith("t:"));

        state.storageMap.delete(claimKey ?? "");
        await state.storage.deleteAlarm();

        // A FRESH instance, woken the only way anything can still wake it: a
        // request. `/status` is a plain read — it schedules nothing.
        const revived = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const status = await revived.fetch(get("/status"));

        expect(status.status).toBe(200);
        // The claim is back and an alarm is armed for it, so the runtime will
        // deliver `alarm()` again on its own.
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("t:"))).toHaveLength(1);
        await expect(state.storage.getAlarm()).resolves.not.toBeNull();

        await revived.alarm();

        expect(revived.dispatched.map((record) => record.id)).toEqual([id]);
        expect(state.storageMap.has(`id:${id}`)).toBe(false);
    });
});
