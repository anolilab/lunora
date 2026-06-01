import { describe, expect, expectTypeOf, test } from "vitest";

import { SchedulerDO } from "../src/scheduler-do.js";
import type { ScheduleRecord } from "../src/types.js";
import { createFakeSocket, createFakeState, createFakeStateWithSockets } from "./fake-state.js";

interface ScheduleResponseBody {
    id: string;
    scheduledFor: number;
}

interface CancelResponseBody {
    cancelled: boolean;
}

class TestScheduler extends SchedulerDO {
    public dispatched: ScheduleRecord[] = [];

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.dispatched.push(record);

        return true;
    }
}

const post = (path: string, body: unknown): Request =>
    new Request(`https://scheduler.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

describe("schedulerDO", () => {
    test("/schedule persists a record and sets the alarm to the earliest pending task", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });
        const scheduledFor = Date.now() + 60_000;

        const response = await scheduler.fetch(
            post("/schedule", {
                functionPath: "messages.send",
                args: { text: "hi" },
                scheduledFor,
                originUrl: "https://app.test",
            }),
        );

        const body = (await response.json()) as ScheduleResponseBody;

        expect(response.status).toBe(200);
        expect(body.scheduledFor).toBe(scheduledFor);

        expectTypeOf(body.id).toBeString();

        expect(state.alarm).toBe(scheduledFor);
    });

    test("/schedule picks the earliest of two pending records for the alarm", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });
        const later = Date.now() + 60_000;
        const sooner = Date.now() + 1000;

        await scheduler.fetch(post("/schedule", { functionPath: "a", args: {}, scheduledFor: later, originUrl: "https://x.test" }));
        await scheduler.fetch(post("/schedule", { functionPath: "b", args: {}, scheduledFor: sooner, originUrl: "https://x.test" }));

        expect(state.alarm).toBe(sooner);
    });

    test("/cancel removes a record and reschedules the alarm", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });
        const later = Date.now() + 60_000;
        const sooner = Date.now() + 1000;

        const soonerResponse = await scheduler.fetch(post("/schedule", { functionPath: "b", args: {}, scheduledFor: sooner, originUrl: "https://x.test" }));
        const soonerBody = (await soonerResponse.json()) as { id: string };

        await scheduler.fetch(post("/schedule", { functionPath: "a", args: {}, scheduledFor: later, originUrl: "https://x.test" }));

        expect(state.alarm).toBe(sooner);

        const cancelResponse = await scheduler.fetch(post("/cancel", { id: soonerBody.id }));
        const cancelBody = (await cancelResponse.json()) as CancelResponseBody;

        expect(cancelBody.cancelled).toBe(true);
        expect(state.alarm).toBe(later);
    });

    test("/cancel returns cancelled=false for an unknown id", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });
        const response = await scheduler.fetch(post("/cancel", { id: "missing" }));
        const body = (await response.json()) as CancelResponseBody;

        expect(body.cancelled).toBe(false);
    });

    test("alarm() dispatches due records and clears them from storage", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });
        const now = Date.now();

        await scheduler.fetch(post("/schedule", { functionPath: "due", args: { x: 1 }, scheduledFor: now - 1000, originUrl: "https://x.test" }));
        await scheduler.fetch(post("/schedule", { functionPath: "later", args: {}, scheduledFor: now + 60_000, originUrl: "https://x.test" }));

        await scheduler.alarm();

        expect(scheduler.dispatched.map((d) => d.functionPath)).toEqual(["due"]);
        expect(scheduler.dispatched[0]?.args).toEqual({ x: 1 });
        // The "later" record stays pending and the alarm is rescheduled to its time.
        expect(state.alarm).toBe(now + 60_000);
    });

    test("returns 404 for unknown routes", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });
        const response = await scheduler.fetch(new Request("https://scheduler.internal/nope", { method: "POST" }));

        expect(response.status).toBe(404);
    });

    test("/schedule validates required fields", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });
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

    test("pushes the job list to subscribers when a job is scheduled", async () => {
        expect.assertions(2);

        const state = createFakeStateWithSockets();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });

        // Simulate an already-connected subscriber.
        state.acceptWebSocket?.(createFakeSocket() as never);

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "a", originUrl: "https://x.test", scheduledFor: Date.now() + 10_000 }));

        const pushed = state.sockets[0]?.sent ?? [];

        expect(pushed.length).toBeGreaterThan(0);
        expect(latestJobs(pushed).map((record) => record.functionPath)).toEqual(["a"]);
    });

    test("pushes the updated list when a job is cancelled", async () => {
        expect.assertions(1);

        const state = createFakeStateWithSockets();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });

        const scheduled = await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "a", originUrl: "https://x.test", scheduledFor: Date.now() + 10_000 }),
        );
        const { id } = (await scheduled.json()) as ScheduleResponseBody;

        // Connect after scheduling, then cancel — the cancel should push an empty list.
        state.sockets.length = 0;
        state.acceptWebSocket?.(createFakeSocket() as never);

        await scheduler.fetch(post("/cancel", { id }));

        expect(latestJobs(state.sockets[0]?.sent ?? [])).toEqual([]);
    });

    test("does not throw when broadcasting with no live sockets", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });

        // No WS hooks on the plain fake — broadcast must be a silent no-op.
        const response = await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "a", originUrl: "https://x.test", scheduledFor: Date.now() + 10_000 }),
        );

        expect(response.status).toBe(200);
    });

    test("rejects a /ws upgrade when the runtime can't accept sockets", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { CIRRUS_ORIGIN_URL: "https://app.test" });

        const response = await scheduler.fetch(new Request("https://scheduler.internal/ws", { headers: { Upgrade: "websocket" } }));

        expect(response.status).toBe(501);
    });
});
