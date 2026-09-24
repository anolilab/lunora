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

import type { TestSchedulerDO } from "./test-worker";

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

/**
 * Write `count` already-due records straight into the DO's storage, in the
 * layout `SchedulerDO` uses: an `id:<id>` header plus a `t:<paddedTime>:<id>`
 * index entry (15-digit zero pad, so lexical order matches numeric order).
 * Bypasses `/schedule` so no alarm is armed — the caller drives `alarm()`.
 */
const seedDue = async (stub: DurableObjectStub<TestSchedulerDO>, count: number, prefix: string, extra: Record<string, unknown> = {}): Promise<void> => {
    const scheduledFor = Date.now() - 1000;
    const padded = String(scheduledFor).padStart(15, "0");

    await runInDurableObject(stub, async (_instance, state) => {
        for (let index = 0; index < count; index += 1) {
            const id = `${prefix}-${String(index)}`;

            // eslint-disable-next-line no-await-in-loop -- seeding one DO's storage in a deterministic order
            await state.storage.put(`id:${id}`, { args: {}, enqueuedAt: scheduledFor, functionPath: `${prefix}${String(index)}`, id, scheduledFor, ...extra });
            // eslint-disable-next-line no-await-in-loop -- see above
            await state.storage.put(`t:${padded}:${id}`, id);
        }

        if (typeof extra.pool === "string") {
            await state.storage.put(`pool:${extra.pool}`, { inFlight: 0, inFlightIds: [], maxConcurrency: extra.maxConcurrency ?? 1 });
        }
    });
};

describe("schedulerDO (workerd)", () => {
    it("/schedule arms the runtime alarm for the earliest pending task", async () => {
        expect.hasAssertions();

        const stub = newStub("alarm-arm");
        const scheduledFor = Date.now() + 60_000;

        const response = await post(stub, "/schedule", {
            args: { text: "hi" },
            functionPath: "messages.send",
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
        await post(stub, "/schedule", { args: { x: 1 }, functionPath: "due", scheduledFor: now - 1000 });
        await post(stub, "/schedule", { args: {}, functionPath: "later", scheduledFor: now + 60_000 });

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
            scheduledFor: sooner,
        });
        const soonerBody = await soonerResponse.json<ScheduleResponseBody>();

        await post(stub, "/schedule", { args: {}, functionPath: "a", scheduledFor: later });

        await runInDurableObject(stub, async (_instance, state) => {
            await expect(state.storage.getAlarm()).resolves.toBe(sooner);
        });

        const cancelResponse = await post(stub, "/cancel", { id: soonerBody.id });

        await expect(cancelResponse.json()).resolves.toEqual({ cancelled: true });

        await runInDurableObject(stub, async (_instance, state) => {
            await expect(state.storage.getAlarm()).resolves.toBe(later);
        });
    });

    it("storage.list({ end }) is an EXCLUSIVE upper bound — the semantics the unit fake models", async () => {
        expect.hasAssertions();

        const stub = newStub("end-bound");

        // The alarm path bounds its due-slice with `end: t:<paddedNow>:~`, and
        // `../fake-state` models that as `key < end`. Pin the real runtime's
        // behaviour here so the fake cannot silently drift from it: a fake that
        // is wrong about `end` makes every mis-sorted-key bug invisible to the
        // whole mock suite.
        await runInDurableObject(stub, async (_instance, state) => {
            await state.storage.put({
                "t:000000000001000:a": "a",
                "t:000000000002000:b": "b",
                "t:000000000003000:c": "c",
            });

            const bounded = await state.storage.list<string>({ end: "t:000000000002000:b", prefix: "t:" });

            // `end` itself is excluded; everything below it is returned.
            expect([...bounded.keys()]).toEqual(["t:000000000001000:a"]);
        });
    });

    it("drains several due jobs concurrently on the real runtime", async () => {
        expect.hasAssertions();

        const stub = newStub("concurrent-drain");

        // Seeded straight into storage rather than through `/schedule`: an
        // already-due `/schedule` arms the alarm in the past and the runtime
        // delivers it immediately, so the drain would race the test's barrier
        // setup. This still exercises real Durable Object storage and real
        // gating — only the alarm's delivery is driven by hand.
        await seedDue(stub, 4, "job");

        // Every dispatch parks until four are in flight together. A drain that
        // awaits each job in turn can never reach that, so it falls through the
        // bounded spin one job at a time and `peakInFlight` stays at 1.
        await runInDurableObject(stub, async (instance) => {
            instance.setBarrier(4);

            await instance.alarm();

            expect(instance.dispatched).toHaveLength(4);
            expect(instance.peakInFlight).toBe(4);
        });
    });

    it("never oversubscribes a pool past maxConcurrency under a concurrent drain", async () => {
        expect.hasAssertions();

        const stub = newStub("pool-concurrency");

        await seedDue(stub, 5, "pooled", { maxConcurrency: 3, pool: "p" });

        await runInDurableObject(stub, async (instance, state) => {
            instance.setBarrier(3);

            await instance.alarm();

            // Exactly the cap in flight at the peak — not one (the old
            // sequential drain) and not five (a drain whose pool reservations
            // lose updates to each other across the real storage round trip).
            expect(instance.peakInFlight).toBe(3);
            expect(instance.dispatched).toHaveLength(3);

            const pool = await state.storage.get<{ inFlight: number; inFlightIds: string[] }>("pool:p");

            expect(pool?.inFlightIds).toHaveLength(3);

            // The two over the cap were re-armed as backpressure and still hold
            // both of their rows.
            const headers = await state.storage.list({ prefix: "id:" });

            expect(headers.size).toBe(2);
        });
    });

    it("holds a lease on a claimed record's time index for the whole dispatch", async () => {
        expect.hasAssertions();

        const stub = newStub("lease-held");

        await seedDue(stub, 2, "leased");

        await runInDurableObject(stub, async (instance, state) => {
            const startedAt = Date.now();

            await instance.alarm();

            // Sampled from REAL Durable Object storage from inside each open
            // dispatch — the instant an eviction would strike. Before the lease
            // the claim deleted the entry outright, so this was `[]` and the
            // record was an orphan a successor re-fired on sight.
            expect(instance.indexDuringDispatch).toHaveLength(2);

            for (const sample of instance.indexDuringDispatch) {
                expect(sample.keys).toHaveLength(1);

                const armedFor = Number.parseInt((sample.keys[0] as string).slice(2, 17), 10);

                // Comfortably in the future: a successor cannot pick the record
                // up until the horizon passes.
                expect(armedFor).toBeGreaterThan(startedAt + 60_000);
            }

            // And a dispatched record leaves nothing behind once the drain settles.
            const rows = await state.storage.list({ prefix: "t:" });

            expect(rows.size).toBe(0);

            const alarm = await state.storage.getAlarm();

            expect(alarm).toBeNull();
        });
    });

    it("drops the lease on a failed dispatch so the retry backoff owns the clock", async () => {
        expect.hasAssertions();

        const stub = newStub("lease-released");

        await seedDue(stub, 1, "failing");

        await runInDurableObject(stub, async (instance, state) => {
            instance.setDispatchOk(false);

            const startedAt = Date.now();

            await instance.alarm();

            const rows = await state.storage.list<string>({ prefix: "t:" });

            // Exactly one entry, and it is the retry's, not the lease's — a
            // surviving lease would give every failed job a second index row and
            // fire it again at the horizon.
            expect(rows.size).toBe(1);

            const armedFor = Number.parseInt([...rows.keys()][0]!.slice(2, 17), 10);

            expect(armedFor).toBeLessThan(startedAt + 60_000);
            await expect(state.storage.get("retry:failing-0")).resolves.toBeDefined();
        });
    });

    it("/dead answers a bounded page and its cursor walks the rest", async () => {
        expect.hasAssertions();

        const stub = newStub("dead-paging");

        // Nothing prunes `dead:`, so this set grows without limit in a real app;
        // 250 rows is enough to prove the response is paged rather than dumping
        // the whole prefix into one JSON body.
        await runInDurableObject(stub, async (_instance, state) => {
            for (let index = 0; index < 250; index += 1) {
                const key = String(index).padStart(4, "0");

                // eslint-disable-next-line no-await-in-loop -- sequential seeding against one DO's storage
                await state.storage.put(`dead:d${key}`, { args: {}, attempts: 6, enqueuedAt: 1, functionPath: "f", id: `d${key}`, scheduledFor: 1 });
            }
        });

        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;

        for (;;) {
            const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
            // eslint-disable-next-line no-await-in-loop -- each page's cursor comes from the previous page
            const response = await stub.fetch(`https://scheduler.internal/dead${query}`, { method: "GET" });
            // eslint-disable-next-line no-await-in-loop -- see above
            const body = await response.json<{ cursor?: string; records: { id: string }[]; truncated: boolean }>();

            pages += 1;
            seen.push(...body.records.map((record) => record.id));

            expect(body.records.length).toBeLessThanOrEqual(100);

            if (!body.truncated || typeof body.cursor !== "string") {
                break;
            }

            cursor = body.cursor;
        }

        expect(pages).toBe(3);
        expect(new Set(seen).size).toBe(250);
    });
});
