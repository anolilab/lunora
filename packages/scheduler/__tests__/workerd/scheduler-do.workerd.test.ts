/**
 * Real-workerd integration tests for `SchedulerDO`.
 *
 * The mock-based suite ships a hand-rolled fake state and a synchronous
 * `alarm()` call — it does not exercise the runtime's actual alarm scheduler,
 * which is a primary source of integration bugs in production. These tests
 * boot a real `SchedulerDO` and drive its alarm via `runDurableObjectAlarm`.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { TestSchedulerDO } from "./test-worker.js";

interface ScheduleResponseBody {
    id: string;
    scheduledFor: number;
}

// `env` is typed via the `Cloudflare.Env` augmentation in `./env.d.ts`.

const newStub = (name = "scheduler-tests"): DurableObjectStub<TestSchedulerDO> => env.SCHEDULER.get(env.SCHEDULER.idFromName(name));

const post = async (stub: DurableObjectStub<TestSchedulerDO>, path: string, body: unknown): Promise<Response> =>
    stub.fetch(`https://scheduler.internal${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

describe("schedulerDO (workerd)", () => {
    it("/schedule arms the runtime alarm for the earliest pending task", async () => {
        expect.hasAssertions();

        const stub = newStub("alarm-arm");
        const scheduledFor = Date.now() + 60_000;

        const response = await post(stub, "/schedule", {
            args: { text: "hi" },
            functionPath: "messages.send",
            originUrl: "https://app.test",
            scheduledFor,
        });

        expect(response.status).toBe(200);

        // The runtime exposes the live alarm via `state.storage.getAlarm()`.
        await runInDurableObject(stub, async (_instance, state) => {
            const alarm = await state.storage.getAlarm();

            expect(alarm).toBe(scheduledFor);
        });
    });

    it("runDurableObjectAlarm() fires due records and reschedules to the next", async () => {
        expect.hasAssertions();

        const stub = newStub("alarm-fire");
        const now = Date.now();

        // Two records: one already due (so alarm() should pick it up), one in
        // the future (so the post-fire alarm should be re-armed to that time).
        await post(stub, "/schedule", { args: { x: 1 }, functionPath: "due", originUrl: "https://app.test", scheduledFor: now - 1000 });
        await post(stub, "/schedule", { args: {}, functionPath: "later", originUrl: "https://app.test", scheduledFor: now + 60_000 });

        // `runDurableObjectAlarm()` short-circuits the wall clock — it fires
        // the pending alarm synchronously.
        const ran = await runDurableObjectAlarm(stub);

        expect(ran).toBe(true);

        await runInDurableObject(stub, async (instance, state) => {
            expect(instance.dispatched.map((d) => d.functionPath)).toEqual(["due"]);

            const remainingAlarm = await state.storage.getAlarm();

            expect(remainingAlarm).toBe(now + 60_000);
        });
    });

    it("/cancel removes the record and re-arms the alarm to the next pending entry", async () => {
        expect.hasAssertions();

        const stub = newStub("alarm-cancel");
        const later = Date.now() + 60_000;
        const sooner = Date.now() + 1000;

        const soonerResponse = await post(stub, "/schedule", {
            args: {},
            functionPath: "b",
            originUrl: "https://app.test",
            scheduledFor: sooner,
        });
        const soonerBody = await soonerResponse.json<ScheduleResponseBody>();

        await post(stub, "/schedule", { args: {}, functionPath: "a", originUrl: "https://app.test", scheduledFor: later });

        await runInDurableObject(stub, async (_instance, state) => {
            await expect(state.storage.getAlarm()).resolves.toBe(sooner);
        });

        const cancelResponse = await post(stub, "/cancel", { id: soonerBody.id });

        await expect(cancelResponse.json()).resolves.toEqual({ cancelled: true });

        await runInDurableObject(stub, async (_instance, state) => {
            await expect(state.storage.getAlarm()).resolves.toBe(later);
        });
    });
});
