import { describe, expect, it, vi } from "vitest";

import { encodeWire } from "../../../shared/wire-codec";
import createWorkpool from "../src/create-workpool";
import { SchedulerDO } from "../src/scheduler-do";
import type { DurableObjectNamespaceLike, DurableObjectStubLike, FunctionReference, ScheduleRecord } from "../src/types";
import { createFakeState } from "./fake-state";

interface ScheduleResponseBody {
    id: string;
    scheduledFor: number;
}

const post = (path: string, body: unknown): Request =>
    new Request(`https://scheduler.internal${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

const get = (path: string): Request => new Request(`https://scheduler.internal${path}`, { method: "GET" });

/** A scheduler that records dispatches and always succeeds the kick (slot held until /complete). */
class TestScheduler extends SchedulerDO {
    public dispatched: ScheduleRecord[] = [];

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.dispatched.push(record);

        return true;
    }
}

/** Dispatch always fails the kick — exercises immediate slot release + retry. */
class FailingScheduler extends SchedulerDO {
    public attempts = 0;

    protected override async dispatch(): Promise<boolean> {
        this.attempts += 1;

        return false;
    }
}

/**
 * On the FIRST dispatch it re-enters the DO with a `/complete` for a DIFFERENT
 * in-flight job before returning — simulating an at-least-once completion
 * callback that lands mid-dispatch (the DO input gate is open across the fetch
 * await). Used to prove reservePoolSlot() re-reads the pool row fresh and does
 * not clobber that concurrent release.
 */
class CompletingScheduler extends SchedulerDO {
    public dispatched: string[] = [];

    private completedOnce = false;

    public constructor(
        state: ConstructorParameters<typeof SchedulerDO>[0],
        env: ConstructorParameters<typeof SchedulerDO>[1],
        private readonly completeId: string,
        private readonly pool: string,
    ) {
        super(state, env);
    }

    protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
        this.dispatched.push(record.id);

        if (!this.completedOnce) {
            this.completedOnce = true;

            await this.fetch(
                new Request("https://scheduler.internal/complete", {
                    body: JSON.stringify({ id: this.completeId, pool: this.pool }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );
        }

        return true;
    }
}

const scheduledId = async (response: Response): Promise<string> => {
    const body = await response.json<ScheduleResponseBody>();

    return body.id;
};

/** Enqueue `count` jobs into the named pool with the given maxConcurrency. */
const enqueuePool = async (scheduler: SchedulerDO, pool: string, maxConcurrency: number, count: number): Promise<string[]> => {
    const ids: string[] = [];

    /* eslint-disable no-await-in-loop -- sequential enqueue keeps ids ordered */
    for (let index = 0; index < count; index += 1) {
        const response = await scheduler.fetch(
            post("/schedule", { args: { n: index }, functionPath: "job", maxConcurrency, pool, scheduledFor: Date.now() - 1000 }),
        );

        ids.push(await scheduledId(response));
    }
    /* eslint-enable no-await-in-loop */

    return ids;
};

describe("schedulerDO — workpool concurrency", () => {
    it("dispatches at most maxConcurrency jobs at once and queues the rest", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await enqueuePool(scheduler, "p", 2, 5);
        await scheduler.alarm();

        // Only 2 of the 5 were dispatched; the slots stay held (no /complete yet).
        expect(scheduler.dispatched).toHaveLength(2);

        const poolRow = state.storageMap.get("pool:p") as { inFlight: number; maxConcurrency: number };

        expect(poolRow.inFlight).toBe(2);
        // 2 kicked jobs had their id: headers cleared; the 3 deferred jobs stay queued.
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("id:"))).toHaveLength(3);
    });

    it("drains queued jobs as slots free via /complete", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await enqueuePool(scheduler, "p", 1, 3);
        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(1);

        // Report the in-flight job complete -> frees the single slot.
        await scheduler.fetch(post("/complete", { id: scheduler.dispatched[0]?.id, pool: "p" }));

        // Force the queued jobs due again (requeue pushed them ~1s out) and re-fire.
        for (const key of [...state.storageMap.keys()].filter((k) => k.startsWith("t:"))) {
            const recordId = state.storageMap.get(key);

            state.storageMap.delete(key);
            state.storageMap.set(`t:${"0".padStart(15, "0")}:${String(recordId)}`, recordId);
        }

        await scheduler.alarm();

        // A second job drained (one slot, one at a time).
        expect(scheduler.dispatched).toHaveLength(2);

        const poolRow = state.storageMap.get("pool:p") as { inFlight: number };

        expect(poolRow.inFlight).toBe(1);
    });

    it("releases the slot immediately when the dispatch kick fails", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await enqueuePool(scheduler, "p", 1, 1);
        await scheduler.alarm();

        // Failed kick -> slot freed (no /complete will arrive) and job re-armed for retry.
        const poolRow = state.storageMap.get("pool:p") as { inFlight: number };

        expect(poolRow.inFlight).toBe(0);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("retry:"))).toHaveLength(1);
    });

    it("ignores a duplicate /complete for the same job (no slot over-release)", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // Two slots; dispatch two jobs so both hold a slot, queue one more.
        await enqueuePool(scheduler, "p", 2, 3);
        await scheduler.alarm();

        const before = state.storageMap.get("pool:p") as { inFlight: number };

        expect(before.inFlight).toBe(2);

        const completedId = scheduler.dispatched[0]?.id;

        // The runtime completion callback is at-least-once: the SAME job
        // reports complete twice. Only one slot must be released.
        await scheduler.fetch(post("/complete", { id: completedId, pool: "p" }));
        await scheduler.fetch(post("/complete", { id: completedId, pool: "p" }));

        const after = state.storageMap.get("pool:p") as { inFlight: number; inFlightIds: string[] };

        // Without id-based dedup this would be 0, oversubscribing the pool.
        expect(after.inFlight).toBe(1);
        expect(after.inFlightIds).not.toContain(completedId);
    });

    it("does not resurrect a completed job's slot when /complete lands during a dispatch await", async () => {
        expect.assertions(3);

        const state = createFakeState();
        // Pool "p", cap 3, with one job (job-A) already in flight.
        state.storageMap.set("pool:p", { inFlight: 1, inFlightIds: ["job-A"], maxConcurrency: 3 });

        const now = Date.now();
        const scheduler = new CompletingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, "job-A", "p");

        // Two due pooled jobs, B then C (B sorts earlier so it dispatches first).
        const bId = await scheduledId(
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "b", maxConcurrency: 3, pool: "p", scheduledFor: now - 2000 })),
        );
        const cId = await scheduledId(
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "c", maxConcurrency: 3, pool: "p", scheduledFor: now - 1000 })),
        );

        // During B's dispatch, a /complete for job-A lands (storage -> [B]).
        // Reserving C must read that fresh state, not a stale cached [job-A, B].
        await scheduler.alarm();

        const poolRow = state.storageMap.get("pool:p") as { inFlight: number; inFlightIds: string[] };

        // job-A completed and must NOT be resurrected; only B and C hold slots.
        expect(poolRow.inFlightIds).not.toContain("job-A");
        expect(poolRow.inFlightIds.toSorted((a, b) => a.localeCompare(b))).toEqual([bId, cId].toSorted((a, b) => a.localeCompare(b)));
        expect(poolRow.inFlight).toBe(2);
    });

    it("cancelling a still-queued pooled job leaves the in-flight count intact", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // 1 slot, 2 jobs: one dispatched (holds the slot), one stays queued.
        const ids = await enqueuePool(scheduler, "p", 1, 2);

        await scheduler.alarm();

        const queuedId = ids.find((id) => id !== scheduler.dispatched[0]?.id) ?? "";

        expect((state.storageMap.get("pool:p") as { inFlight: number }).inFlight).toBe(1);

        // Cancelling the queued (never-dispatched) job must NOT touch the slot
        // held by the dispatched one — releaseSlot is a no-op for an id that
        // isn't in flight.
        await scheduler.fetch(post("/cancel", { id: queuedId }));

        expect((state.storageMap.get("pool:p") as { inFlight: number }).inFlight).toBe(1);
    });

    it("reports inFlight/maxConcurrency/queued via GET /pool", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await enqueuePool(scheduler, "p", 2, 4);
        await scheduler.alarm();

        const poolResponse = await scheduler.fetch(get("/pool?name=p"));
        const status = await poolResponse.json<{ inFlight: number; maxConcurrency: number; queued: number }>();

        expect(status.maxConcurrency).toBe(2);
        expect(status.inFlight).toBe(2);
        // 2 of the 4 were kicked (their id: headers cleared); the other 2 stay queued.
        expect(status.queued).toBe(2);
    });

    it("aggregates every pool's backlog via GET /status", async () => {
        expect.assertions(5);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        // Pool "a": cap 2, 4 jobs -> 2 kicked (inFlight 2), 2 queued.
        await enqueuePool(scheduler, "a", 2, 4);
        // Pool "b": cap 1, 3 jobs -> 1 kicked (inFlight 1), 2 queued.
        await enqueuePool(scheduler, "b", 1, 3);
        await scheduler.alarm();

        const response = await scheduler.fetch(get("/status"));
        const status = await response.json<{
            backlog: number;
            inFlight: number;
            pools: { inFlight: number; maxConcurrency: number; name: string; queued: number }[];
        }>();

        // Sort for a stable assertion regardless of storage iteration order.
        const pools = [...status.pools].toSorted((left, right) => left.name.localeCompare(right.name));

        expect(pools).toEqual([
            { inFlight: 2, maxConcurrency: 2, name: "a", queued: 2 },
            { inFlight: 1, maxConcurrency: 1, name: "b", queued: 2 },
        ]);
        // App-wide totals are the sums across both pools.
        expect(status.backlog).toBe(4);
        expect(status.inFlight).toBe(3);

        // Each pool's per-pool /pool view stays consistent with the rollup.
        const poolAResponse = await scheduler.fetch(get("/pool?name=a"));
        const poolA = await poolAResponse.json<{ queued: number }>();

        expect(poolA.queued).toBe(2);

        const poolBResponse = await scheduler.fetch(get("/pool?name=b"));
        const poolB = await poolBResponse.json<{ inFlight: number }>();

        expect(poolB.inFlight).toBe(1);
    });

    it("reports an empty backlog when no pools exist", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        const statusResponse = await scheduler.fetch(get("/status"));
        const status = await statusResponse.json<{ backlog: number; inFlight: number; pools: unknown[] }>();

        expect(status.pools).toEqual([]);
        expect(status.backlog).toBe(0);
        expect(status.inFlight).toBe(0);
    });
});

describe("schedulerDO — configurable retry policy", () => {
    /** Fails the first N kicks, then succeeds — to count attempts before success. */
    class CountingScheduler extends SchedulerDO {
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

    /** Drive the alarm `fires` times, forcing the (re-armed) job due each time. */
    const drive = async (scheduler: SchedulerDO, state: ReturnType<typeof createFakeState>, fires: number): Promise<void> => {
        for (let index = 0; index < fires; index += 1) {
            for (const key of [...state.storageMap.keys()].filter((k) => k.startsWith("t:"))) {
                const recordId = state.storageMap.get(key);

                state.storageMap.delete(key);
                state.storageMap.set(`t:${"0".padStart(15, "0")}:${String(recordId)}`, recordId);
            }

            // eslint-disable-next-line no-await-in-loop -- sequential alarm fires
            await scheduler.alarm();
        }
    };

    it("dead-letters after a custom maxAttempts (lower than the default 5)", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const id = await scheduledId(
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", retry: { maxAttempts: 2 }, scheduledFor: Date.now() - 1000 })),
        );

        // 4 fires is more than enough to exhaust maxAttempts=2.
        await drive(scheduler, state, 4);

        expect(state.storageMap.has(`dead:${id}`)).toBe(true);

        const dead = state.storageMap.get(`dead:${id}`) as ScheduleRecord;

        // Parked at maxAttempts+1 (attempts counter passes the budget).
        expect(dead.attempts).toBe(3);
    });

    it("honors a linear backoff with custom baseMs", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "f", retry: { backoff: "linear", baseMs: 1000, maxAttempts: 10 }, scheduledFor: Date.now() - 1000 }),
        );

        const before = Date.now();

        await scheduler.alarm();

        const retryRow = [...state.storageMap.entries()].find(([key]) => key.startsWith("retry:"))?.[1] as ScheduleRecord;

        // First linear attempt: baseMs * 1 = 1000ms out.
        expect(retryRow.scheduledFor - before).toBeGreaterThanOrEqual(900);
        expect(retryRow.scheduledFor - before).toBeLessThan(2000);
    });

    it("clamps backoff to maxMs", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduler.fetch(
            post("/schedule", {
                args: {},
                functionPath: "f",
                retry: { backoff: "exponential", baseMs: 1000, maxAttempts: 10, maxMs: 1500 },
                scheduledFor: Date.now() - 1000,
            }),
        );

        const before = Date.now();

        // Drive several fires; exponential would blow past 1500ms but maxMs caps it.
        await drive(scheduler, state, 4);

        const retryRow = [...state.storageMap.entries()].find(([key]) => key.startsWith("retry:"))?.[1] as ScheduleRecord;

        expect(retryRow.scheduledFor - before).toBeLessThanOrEqual(1500 + 50);
    });

    it("defaults match the built-in 5-attempt behaviour when no policy is given", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new CountingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, Number.POSITIVE_INFINITY);
        const id = await scheduledId(await scheduler.fetch(post("/schedule", { args: {}, functionPath: "f", scheduledFor: Date.now() - 1000 })));

        // Exhaust the default budget.
        await drive(scheduler, state, 8);

        const dead = state.storageMap.get(`dead:${id}`) as ScheduleRecord;

        expect(dead.attempts).toBeGreaterThan(5);
    });
});

const fnRef: FunctionReference<"mutation"> = { __lunoraRef: "stripe.sync" };

const fakeNamespace = (
    responses: Record<string, unknown> = {},
): { calls: { body: Record<string, unknown>; url: string }[]; namespace: DurableObjectNamespaceLike } => {
    const calls: { body: Record<string, unknown>; url: string }[] = [];
    const stub = {
        fetch: vi.fn<DurableObjectStubLike["fetch"]>(async (input: Request | string, init?: RequestInit) => {
            const url = typeof input === "string" ? input : input.url;
            const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};

            calls.push({ body, url });

            const path = new URL(url).pathname;
            const responseBody = responses[path] ?? (path === "/schedule" ? { id: "id-1", scheduledFor: 1 } : { ok: true });

            return Response.json(responseBody, { headers: { "content-type": "application/json" }, status: 200 });
        }),
    };

    return {
        calls,
        namespace: {
            get: vi.fn<DurableObjectNamespaceLike["get"]>(() => stub),
            idFromName: vi.fn<DurableObjectNamespaceLike["idFromName"]>((name: string) => {
                return { toString: () => name };
            }),
        },
    };
};

describe("createWorkpool", () => {
    it("requires a namespace and a positive maxConcurrency", () => {
        expect.assertions(2);

        expect(() => createWorkpool({} as never)).toThrow(/namespace/);
        expect(() => createWorkpool({ maxConcurrency: 0, namespace: fakeNamespace().namespace })).toThrow(/maxConcurrency/);
    });

    it("enqueue() forwards pool, maxConcurrency, and retry to /schedule", async () => {
        expect.assertions(5);

        const { calls, namespace } = fakeNamespace();
        const pool = createWorkpool({ maxConcurrency: 3, name: "stripe", namespace });

        const result = await pool.enqueue(fnRef, { invoiceId: "in_1" }, { retry: { maxAttempts: 2 } });

        expect(result).toEqual({ id: "id-1", scheduledFor: 1 });
        expect(calls[0]?.body.pool).toBe("stripe");
        expect(calls[0]?.body.maxConcurrency).toBe(3);
        expect(calls[0]?.body.retry).toEqual({ maxAttempts: 2 });
        expect(calls[0]?.body.functionPath).toBe("stripe.sync");
    });

    it("status() reads GET /pool?name=", async () => {
        expect.assertions(2);

        const { calls, namespace } = fakeNamespace({ "/pool": { inFlight: 1, maxConcurrency: 3, queued: 4 } });
        const pool = createWorkpool({ maxConcurrency: 3, name: "stripe", namespace });

        const status = await pool.status();

        expect(status).toEqual({ inFlight: 1, maxConcurrency: 3, queued: 4 });
        expect(new URL(calls[0]!.url).searchParams.get("name")).toBe("stripe");
    });

    it("wire-encodes enqueued args so a bigint/bytes argument survives to the shard", async () => {
        expect.assertions(1);

        const { calls, namespace } = fakeNamespace();
        const pool = createWorkpool({ maxConcurrency: 1, namespace });
        const args = { amount: 5n, blob: new Uint8Array([1, 2]) };

        // Same hop as `ctx.scheduler.runAt`: `callDO` JSON.stringifies the body
        // and the shard `decodeWire`s `payload.args` at the far end.
        await pool.enqueue(fnRef, args);

        expect(calls[0]?.body.args).toStrictEqual(encodeWire(args));
    });

    // Same unattributable-TypeError problem as `ctx.scheduler.runAt`; same label.
    it("labels an unencodable argument with the pool surface and the function path", async () => {
        expect.assertions(1);

        const { namespace } = fakeNamespace();
        const pool = createWorkpool({ maxConcurrency: 1, namespace });

        await expect(pool.enqueue(fnRef, { pattern: /nope/u })).rejects.toThrow(/workpool\.enqueue: cannot encode args for 'stripe\.sync' — /);
    });

    it("rejects a negative delayMs", async () => {
        expect.assertions(1);

        const { namespace } = fakeNamespace();
        const pool = createWorkpool({ maxConcurrency: 1, namespace });

        await expect(pool.enqueue(fnRef, {}, { delayMs: -1 })).rejects.toThrow(/delayMs/);
    });
});
