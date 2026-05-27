import { describe, expect, test } from "vitest";

import { SchedulerDO } from "../src/scheduler-do.js";
import type { ScheduleRecord } from "../src/types.js";
import { createFakeState } from "./fake-state.js";

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

describe("SchedulerDO", () => {
    test("/schedule persists a record and sets the alarm to the earliest pending task", async () => {
        const state = createFakeState();
        const scheduler = new TestScheduler(state, {});
        const scheduledFor = Date.now() + 60_000;

        const response = await scheduler.fetch(
            post("/schedule", {
                functionPath: "messages.send",
                args: { text: "hi" },
                scheduledFor,
                originUrl: "https://app.test",
            }),
        );

        const body = (await response.json()) as { id: string; scheduledFor: number };

        expect(response.status).toBe(200);
        expect(body.scheduledFor).toBe(scheduledFor);
        expect(typeof body.id).toBe("string");
        expect(state.alarm).toBe(scheduledFor);
    });

    test("/schedule picks the earliest of two pending records for the alarm", async () => {
        const state = createFakeState();
        const scheduler = new TestScheduler(state, {});
        const later = Date.now() + 60_000;
        const sooner = Date.now() + 1_000;

        await scheduler.fetch(post("/schedule", { functionPath: "a", args: {}, scheduledFor: later, originUrl: "https://x.test" }));
        await scheduler.fetch(post("/schedule", { functionPath: "b", args: {}, scheduledFor: sooner, originUrl: "https://x.test" }));

        expect(state.alarm).toBe(sooner);
    });

    test("/cancel removes a record and reschedules the alarm", async () => {
        const state = createFakeState();
        const scheduler = new TestScheduler(state, {});
        const later = Date.now() + 60_000;
        const sooner = Date.now() + 1_000;

        const soonerResponse = await scheduler.fetch(
            post("/schedule", { functionPath: "b", args: {}, scheduledFor: sooner, originUrl: "https://x.test" }),
        );
        const soonerBody = (await soonerResponse.json()) as { id: string };

        await scheduler.fetch(post("/schedule", { functionPath: "a", args: {}, scheduledFor: later, originUrl: "https://x.test" }));

        expect(state.alarm).toBe(sooner);

        const cancelResponse = await scheduler.fetch(post("/cancel", { id: soonerBody.id }));
        const cancelBody = (await cancelResponse.json()) as { cancelled: boolean };

        expect(cancelBody.cancelled).toBe(true);
        expect(state.alarm).toBe(later);
    });

    test("/cancel returns cancelled=false for an unknown id", async () => {
        const state = createFakeState();
        const scheduler = new TestScheduler(state, {});
        const response = await scheduler.fetch(post("/cancel", { id: "missing" }));
        const body = (await response.json()) as { cancelled: boolean };

        expect(body.cancelled).toBe(false);
    });

    test("alarm() dispatches due records and clears them from storage", async () => {
        const state = createFakeState();
        const scheduler = new TestScheduler(state, {});
        const now = Date.now();

        await scheduler.fetch(post("/schedule", { functionPath: "due", args: { x: 1 }, scheduledFor: now - 1_000, originUrl: "https://x.test" }));
        await scheduler.fetch(post("/schedule", { functionPath: "later", args: {}, scheduledFor: now + 60_000, originUrl: "https://x.test" }));

        await scheduler.alarm();

        expect(scheduler.dispatched.map((d) => d.functionPath)).toEqual(["due"]);
        expect(scheduler.dispatched[0]?.args).toEqual({ x: 1 });
        // The "later" record stays pending and the alarm is rescheduled to its time.
        expect(state.alarm).toBe(now + 60_000);
    });

    test("returns 404 for unknown routes", async () => {
        const state = createFakeState();
        const scheduler = new TestScheduler(state, {});
        const response = await scheduler.fetch(new Request("https://scheduler.internal/nope", { method: "POST" }));

        expect(response.status).toBe(404);
    });

    test("/schedule validates required fields", async () => {
        const state = createFakeState();
        const scheduler = new TestScheduler(state, {});
        const response = await scheduler.fetch(post("/schedule", { args: {} }));

        expect(response.status).toBe(400);
    });
});
