import { encodeWire } from "@lunora/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createWorkpool from "../src/create-workpool";
import { DISPATCH_LEASE_MS, SchedulerDO } from "../src/scheduler-do";
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
        private readonly completeOwner: string,
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
                    body: JSON.stringify({ dedupKey: this.completeOwner, pool: this.pool }),
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

/** `GET /pool?name=` → its `queued` count. */
const queuedInPool = async (scheduler: SchedulerDO, pool: string): Promise<number> => {
    const response = await scheduler.fetch(get(`/pool?name=${encodeURIComponent(pool)}`));
    const status = await response.json<{ queued: number }>();

    return status.queued;
};

interface PoolRow {
    inFlight: number;
    slots: { id: string; kicked?: true; owner: string }[];
}

const poolRow = (state: ReturnType<typeof createFakeState>, pool: string): PoolRow | undefined => state.storageMap.get(`pool:${pool}`) as PoolRow | undefined;

const poolIds = (state: ReturnType<typeof createFakeState>, pool: string): string[] | undefined => poolRow(state, pool)?.slots.map((slot) => slot.id);

/** A pool row in which each of `ids` holds a slot for its own scheduling, as a reservation writes it. */
const holding = (state: ReturnType<typeof createFakeState>, maxConcurrency: number, ids: string[]): PoolRow & { maxConcurrency: number } => {
    return {
        inFlight: ids.length,
        maxConcurrency,
        slots: ids.map((id) => {
            return { at: Date.now(), id, owner: (state.storageMap.get(`id:${id}`) as ScheduleRecord | undefined)?.dedupKey ?? id };
        }),
    };
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

        const row = state.storageMap.get("pool:p") as { inFlight: number; maxConcurrency: number };

        expect(row.inFlight).toBe(2);
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

        const row = state.storageMap.get("pool:p") as { inFlight: number };

        expect(row.inFlight).toBe(1);
    });

    it("keeps a queued job's first due time across backpressure re-arms", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const dueAt = Date.now() - 1000;

        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "job", maxConcurrency: 1, pool: "p", scheduledFor: dueAt }));
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "job", maxConcurrency: 1, pool: "p", scheduledFor: dueAt }));

        await scheduler.alarm();
        await scheduler.fetch(post("/complete", { id: scheduler.dispatched[0]?.id, pool: "p" }));

        for (const key of [...state.storageMap.keys()].filter((k) => k.startsWith("t:"))) {
            const recordId = state.storageMap.get(key);

            state.storageMap.delete(key);
            state.storageMap.set(`t:${"0".padStart(15, "0")}:${String(recordId)}`, recordId);
        }

        await scheduler.alarm();

        // The job the full pool turned away carries its original due time; the first never waited.
        expect(scheduler.dispatched.map((record) => record.firstDueAt)).toStrictEqual([undefined, dueAt]);
    });

    it("releases the slot immediately when the dispatch kick fails", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await enqueuePool(scheduler, "p", 1, 1);
        await scheduler.alarm();

        // Failed kick -> slot freed (no /complete will arrive) and job re-armed for retry.
        const row = state.storageMap.get("pool:p") as { inFlight: number };

        expect(row.inFlight).toBe(0);
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

        const completed = scheduler.dispatched[0];
        const callback = { dedupKey: completed?.dedupKey, id: completed?.id, pool: "p" };

        // The runtime completion callback is at-least-once: the SAME job
        // reports complete twice. Only one slot must be released.
        await scheduler.fetch(post("/complete", callback));
        await scheduler.fetch(post("/complete", callback));

        const after = poolRow(state, "p");

        // Without owner-based release this would be 0, oversubscribing the pool.
        expect(after?.inFlight).toBe(1);
        expect(after?.slots.map((slot) => slot.id)).not.toContain(completed?.id);
    });

    it("does not resurrect a completed job's slot when /complete lands during a dispatch await", async () => {
        expect.assertions(3);

        const state = createFakeState();
        // Pool "p", cap 3, with one job (job-A) already in flight.
        state.storageMap.set("pool:p", { inFlight: 1, maxConcurrency: 3, slots: [{ id: "job-A", kicked: true, owner: "job-A-key" }] });

        const now = Date.now();
        const scheduler = new CompletingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" }, "job-A-key", "p");

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

        const ids = poolIds(state, "p") ?? [];

        // job-A completed and must NOT be resurrected; only B and C hold slots.
        expect(ids).not.toContain("job-A");
        expect(ids.toSorted((a, b) => a.localeCompare(b))).toEqual([bId, cId].toSorted((a, b) => a.localeCompare(b)));
        expect(poolRow(state, "p")?.inFlight).toBe(2);
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
        // held by the dispatched one.
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

    it("counts a pool whose name is not well-formed Unicode, as its own pool", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const lone = "\uD800";

        await enqueuePool(scheduler, lone, 1, 2);

        const response = await scheduler.fetch(get("/status"));
        const status = await response.json<{ pools: { name: string; queued: number }[] }>();

        expect(status.pools.find((pool) => pool.name === lone)?.queued).toBe(2);
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

    it("counts one pool's queue across schedule, dispatch and cancel while other pools hold jobs", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const queuedIn = async (pool: string): Promise<number> => queuedInPool(scheduler, pool);

        // `a:b` shares a textual prefix with `a`; a non-pooled job sits alongside both.
        const idsA = await enqueuePool(scheduler, "a", 1, 3);

        await enqueuePool(scheduler, "a:b", 5, 2);
        await scheduler.fetch(post("/schedule", { args: {}, functionPath: "job", scheduledFor: Date.now() + 60_000 }));

        expect([await queuedIn("a"), await queuedIn("a:b")]).toEqual([3, 2]);

        // Pool `a` (cap 1) dispatches one job; pool `a:b` (cap 5) dispatches both.
        await scheduler.alarm();

        expect([await queuedIn("a"), await queuedIn("a:b")]).toEqual([2, 0]);

        const queuedId = idsA.find((id) => !scheduler.dispatched.some((record) => record.id === id)) ?? "";

        await scheduler.fetch(post("/cancel", { id: queuedId }));

        expect([await queuedIn("a"), await queuedIn("a:b")]).toEqual([1, 0]);
    });

    it("counts a pooled job out when it is dead-lettered and back in when it is retried", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const response = await scheduler.fetch(
            post("/schedule", { args: {}, functionPath: "job", pool: "p", retry: { baseMs: 0, maxAttempts: 1 }, scheduledFor: Date.now() - 1000 }),
        );
        const id = await scheduledId(response);

        // First failure re-arms (still queued), the second exhausts the budget.
        await scheduler.alarm();

        await expect(queuedInPool(scheduler, "p")).resolves.toBe(1);

        await scheduler.alarm();

        await expect(queuedInPool(scheduler, "p")).resolves.toBe(0);

        await scheduler.fetch(post("/dead/retry", { id }));

        await expect(queuedInPool(scheduler, "p")).resolves.toBe(1);
    });

    it("backfills the queue count for pooled jobs stored before it was tracked", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const legacy: ScheduleRecord = { args: {}, enqueuedAt: 1, functionPath: "job", id: "legacy1", pool: "p", scheduledFor: Date.now() + 60_000 };

        state.storageMap.set("id:legacy1", legacy);
        state.storageMap.set(`t:${String(legacy.scheduledFor).padStart(15, "0")}:legacy1`, "legacy1");
        state.storageMap.set("pool:p", { inFlight: 0, maxConcurrency: 1, slots: [] });

        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await expect(queuedInPool(scheduler, "p")).resolves.toBe(1);
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

/** Every kick is declined `in-progress`: the record's first attempt is still running on the shard. */
class DecliningScheduler extends SchedulerDO {
    public dispatched: string[] = [];

    public dispatchedKeys: (string | undefined)[] = [];

    /** When set, `/cancel` lands for the record while its declined attempt is settling. */
    public cancelMidAttempt = false;

    protected override async dispatch(record: ScheduleRecord): Promise<"in-progress"> {
        this.dispatched.push(record.id);
        this.dispatchedKeys.push(record.dedupKey);

        if (this.cancelMidAttempt) {
            await this.fetch(post("/cancel", { id: record.id }));
        }

        return "in-progress";
    }
}

describe("schedulerDO — a slot held by a still-running attempt", () => {
    it("lets a record that already holds a slot re-fire on a full pool without taking a second one", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const [id] = await enqueuePool(scheduler, "p", 1, 1);

        // Its earlier attempt still holds the only slot (declined, first attempt's receiver gone).
        state.storageMap.set("pool:p", holding(state, 1, [id ?? ""]));

        await scheduler.alarm();

        // Backpressured by its own slot it could not re-fire until the claim ceiling reclaimed it.
        expect(scheduler.dispatched.map((record) => record.id)).toStrictEqual([id]);
        expect(poolIds(state, "p")).toStrictEqual([id]);
    });

    it("backpressures a new job that reuses the id of a kicked job still holding its slot", async () => {
        expect.assertions(4);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const schedule = async (): Promise<Response> =>
            scheduler.fetch(post("/schedule", { args: {}, functionPath: "job", id: "reused", maxConcurrency: 1, pool: "p", scheduledFor: Date.now() - 1000 }));

        await schedule();
        await scheduler.alarm();

        // The first job's kick went through: it runs on the only slot until /complete, and its id is free.
        expect(poolIds(state, "p")).toStrictEqual(["reused"]);

        await schedule();
        await scheduler.alarm();

        expect(scheduler.dispatched.map((record) => record.id)).toStrictEqual(["reused"]);
        expect(poolIds(state, "p")).toStrictEqual(["reused"]);

        // Cancelling the queued job must not free the running one's slot.
        await scheduler.fetch(post("/cancel", { id: "reused" }));

        expect(poolIds(state, "p")).toStrictEqual(["reused"]);
    });

    it("leaves every held slot alone when a pending record is cancelled", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new TestScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const held = await scheduledId(
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "job", maxConcurrency: 2, pool: "p", scheduledFor: Date.now() + 60_000 })),
        );
        const queued = await scheduledId(
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "job", maxConcurrency: 2, pool: "p", scheduledFor: Date.now() + 60_000 })),
        );

        state.storageMap.set("pool:p", holding(state, 2, [held, "running-elsewhere"]));

        // A job that holds no slot frees nothing. One that does may still have its attempt running:
        // that attempt's /complete or the claim ceiling frees it.
        await scheduler.fetch(post("/cancel", { id: queued }));

        expect(poolIds(state, "p")).toStrictEqual([held, "running-elsewhere"]);

        await scheduler.fetch(post("/cancel", { id: held }));

        expect(poolIds(state, "p")).toStrictEqual([held, "running-elsewhere"]);
    });

    it("keeps the slot when the kick is declined in-progress, and re-arms the job", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new DecliningScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const [id] = await enqueuePool(scheduler, "p", 2, 1);

        await scheduler.alarm();

        expect(scheduler.dispatched).toStrictEqual([id]);
        // The first attempt is still running and its completion is still coming: the slot stays counted,
        // held for that attempt.
        expect(poolRow(state, "p")?.slots).toStrictEqual([{ at: expect.any(Number), id, kicked: true, owner: scheduler.dispatchedKeys[0] }]);
        expect(state.storageMap.has(`id:${String(id)}`)).toBe(true);
    });

    it("keeps a declined attempt's slot when the job is cancelled while it settles, for that attempt to free", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new DecliningScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const [id] = await enqueuePool(scheduler, "p", 2, 1);

        scheduler.cancelMidAttempt = true;
        await scheduler.alarm();

        // The attempt the shard declined for still runs, and its /complete frees the slot.
        expect(scheduler.dispatched).toStrictEqual([id]);
        expect(poolIds(state, "p")).toStrictEqual([id]);
    });
});

describe("schedulerDO — a failed re-fire through a slot it already holds", () => {
    const scheduleHeld = async (scheduler: SchedulerDO, state: ReturnType<typeof createFakeState>): Promise<string> => {
        const id = await scheduledId(
            await scheduler.fetch(
                post("/schedule", {
                    args: {},
                    functionPath: "job",
                    maxConcurrency: 1,
                    pool: "p",
                    retry: { baseMs: 0, maxAttempts: 1 },
                    scheduledFor: Date.now() - 1000,
                }),
            ),
        );

        // An earlier attempt was declined in-progress (or lost with its instance): the record still holds the slot.
        state.storageMap.set("pool:p", holding(state, 1, [id]));

        return id;
    };

    it("keeps the slot when the re-fire's kick fails, and re-arms the job", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const id = await scheduleHeld(scheduler, state);

        await scheduler.alarm();

        // A failed kick says nothing about whether the earlier attempt ended; another job must not take its slot.
        expect(scheduler.attempts).toBe(1);
        expect(poolIds(state, "p")).toStrictEqual([id]);
        expect(state.storageMap.has(`id:${id}`)).toBe(true);
    });

    it("keeps the kept slot when the job is dead-lettered, for the attempt holding it", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new FailingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });
        const id = await scheduleHeld(scheduler, state);

        await scheduler.alarm();
        await scheduler.alarm();

        // The earlier attempt may still be running; its /complete or the claim ceiling frees the slot.
        expect(scheduler.attempts).toBe(2);
        expect(state.storageMap.has(`dead:${id}`)).toBe(true);
        expect(poolIds(state, "p")).toStrictEqual([id]);
    });
});

/**
 * Each kick takes the next scripted outcome (a kick that goes through when none is left). A `"hold"`
 * kick stays open until {@link ScriptedScheduler.settleHeld}.
 */
class ScriptedScheduler extends SchedulerDO {
    public dispatched: ScheduleRecord[] = [];

    public outcomes: (boolean | "hold" | "in-progress")[] = [];

    /** Runs once a kick has gone out, before its outcome is seen. */
    public onKick: (() => void) | undefined;

    public settleHeld: ((ok: boolean) => void) | undefined;

    protected override async dispatch(record: ScheduleRecord): Promise<boolean | "in-progress"> {
        this.dispatched.push(record);

        const outcome = this.outcomes.shift() ?? true;

        this.onKick?.();

        if (outcome === "hold") {
            return new Promise<boolean>((resolve) => {
                this.settleHeld = resolve;
            });
        }

        return outcome;
    }
}

describe("schedulerDO — a pool slot belongs to one scheduling, not to its id", () => {
    const origin = { LUNORA_ORIGIN_URL: "https://app.test" };

    const schedule = async (scheduler: SchedulerDO, maxConcurrency: number, id?: string): Promise<string> =>
        scheduledId(
            await scheduler.fetch(
                post("/schedule", {
                    args: {},
                    functionPath: "job",
                    ...(id === undefined ? {} : { id }),
                    maxConcurrency,
                    pool: "p",
                    scheduledFor: Date.now() - 1000,
                }),
            ),
        );

    const inFlight = async (scheduler: SchedulerDO): Promise<number> => {
        const response = await scheduler.fetch(get("/pool?name=p"));
        const body = await response.json<{ inFlight: number }>();

        return body.inFlight;
    };

    /** What the runtime sends once the attempt dispatched as `record` settles. */
    const complete = async (scheduler: SchedulerDO, record: ScheduleRecord | undefined): Promise<void> => {
        await scheduler.fetch(post("/complete", { dedupKey: record?.dedupKey, id: record?.id, pool: "p" }));
    };

    /** Past the backpressure delay, so a job re-armed for want of a slot is due again. */
    const afterBackpressure = (): void => {
        vi.setSystemTime(Date.now() + 60_000);
    };

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("frees only its own slot when a job reusing a running job's id fails its kick", async () => {
        expect.assertions(2);

        const scheduler = new ScriptedScheduler(createFakeState(), origin);

        await schedule(scheduler, 2, "reused");
        await scheduler.alarm();
        await schedule(scheduler, 2, "reused");
        scheduler.outcomes = [false];
        await scheduler.alarm();

        // The first job still runs on its slot.
        await expect(inFlight(scheduler)).resolves.toBe(1);

        await complete(scheduler, scheduler.dispatched[0]);

        await expect(inFlight(scheduler)).resolves.toBe(0);
    });

    it("holds a kicked job's slot when recording the kick fails, until that job completes", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new ScriptedScheduler(state, origin);
        const { put } = state.storage;
        let failPoolWrite = false;

        state.storage.put = async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
            if (failPoolWrite && keyOrEntries === "pool:p") {
                failPoolWrite = false;

                throw new Error("storage unavailable");
            }

            return put(keyOrEntries as string, value);
        };

        await schedule(scheduler, 1, "reused");
        scheduler.onKick = () => {
            failPoolWrite = true;
        };
        await scheduler.alarm();
        scheduler.onKick = undefined;

        // The id is free again, but the job that ran under it still holds the only slot.
        await schedule(scheduler, 1, "reused");
        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(1);

        await complete(scheduler, scheduler.dispatched[0]);
        afterBackpressure();
        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(2);
        await expect(inFlight(scheduler)).resolves.toBe(1);
    });

    it("never re-dispatches a kicked job whose kick marker cannot be written at all, and holds its slot until it completes", async () => {
        expect.assertions(5);

        const state = createFakeState();
        const scheduler = new ScriptedScheduler(state, origin);
        const { put } = state.storage;
        let refused = 0;

        // Every write that marks a slot kicked fails, however often it is retried.
        state.storage.put = async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
            if (keyOrEntries === "pool:p" && (value as { slots?: { kicked?: true }[] } | undefined)?.slots?.some((slot) => slot.kicked === true) === true) {
                refused += 1;

                throw new Error("storage unavailable");
            }

            return put(keyOrEntries as string, value);
        };

        await schedule(scheduler, 1, "reused");
        await scheduler.alarm();
        afterBackpressure();
        await scheduler.alarm();

        expect(refused).toBeGreaterThan(0);
        expect(scheduler.dispatched).toHaveLength(1);

        // A new job under the id still queues behind the unmarked slot.
        await schedule(scheduler, 1, "reused");
        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(1);
        await expect(inFlight(scheduler)).resolves.toBe(1);

        await complete(scheduler, scheduler.dispatched[0]);
        afterBackpressure();
        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(2);
    });

    it("keeps a declined job's slot when it is cancelled, for the attempt still running to free", async () => {
        expect.assertions(3);

        const scheduler = new ScriptedScheduler(createFakeState(), origin);
        const declined = await schedule(scheduler, 1);

        scheduler.outcomes = ["in-progress"];
        await scheduler.alarm();

        const running = scheduler.dispatched[0];

        await scheduler.fetch(post("/cancel", { id: declined }));
        await schedule(scheduler, 1);
        afterBackpressure();
        await scheduler.alarm();

        // The attempt the shard declined for is still running on the only slot.
        expect(scheduler.dispatched).toHaveLength(1);

        await complete(scheduler, running);
        afterBackpressure();
        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(2);
        await expect(inFlight(scheduler)).resolves.toBe(1);
    });

    it("does not hand a cancelled job's held slot to a new job reusing its id", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const evicted = new ScriptedScheduler(state, origin);

        await schedule(evicted, 1, "reused");
        evicted.outcomes = ["hold"];

        const kicked = new Promise<void>((resolve) => {
            evicted.onKick = resolve;
        });
        const firstDrain = evicted.alarm();

        await kicked;
        await evicted.fetch(post("/cancel", { id: "reused" }));

        // The instance is replaced while the cancelled job's kick is still open.
        const successor = new ScriptedScheduler(state, origin);

        await schedule(successor, 1, "reused");
        await successor.alarm();

        // That kick may still reach the origin: its slot is not the new job's.
        expect(successor.dispatched).toHaveLength(0);

        // It fails, and frees only its own slot.
        evicted.settleHeld?.(false);
        await firstDrain;
        afterBackpressure();
        await successor.alarm();

        expect(successor.dispatched).toHaveLength(1);
    });

    it("frees nothing for a /complete naming an owner the pool does not hold", async () => {
        expect.assertions(1);

        const scheduler = new ScriptedScheduler(createFakeState(), origin);

        await schedule(scheduler, 1);
        await scheduler.alarm();
        await scheduler.fetch(post("/complete", { dedupKey: "someone-else", id: scheduler.dispatched[0]?.id, pool: "p" }));

        await expect(inFlight(scheduler)).resolves.toBe(1);
    });

    it("frees by id only the slots held at the origin when the operator names no owner", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new ScriptedScheduler(state, origin);

        state.storageMap.set("pool:p", {
            inFlight: 3,
            maxConcurrency: 3,
            slots: [
                { at: Date.now(), id: "reused", kicked: true, owner: "first" },
                { at: Date.now(), id: "reused", owner: "second" },
                { at: Date.now(), id: "other", kicked: true, owner: "third" },
            ],
        });

        // `POST /pool/release { pool, id }`: the job under that id whose kick is still settling keeps its slot.
        await scheduler.fetch(post("/complete", { id: "reused", pool: "p" }));

        expect(poolRow(state, "p")?.slots.map((slot) => slot.owner)).toStrictEqual(["second", "third"]);

        // With no id it drops one slot, the operator's way out of a leaked one.
        await scheduler.fetch(post("/complete", { pool: "p" }));

        await expect(inFlight(scheduler)).resolves.toBe(1);
    });

    it("drops the oldest slot whose kick went through when the operator names no job", async () => {
        expect.assertions(1);

        const state = createFakeState();
        const scheduler = new ScriptedScheduler(state, origin);
        const now = Date.now();

        state.storageMap.set("pool:p", {
            inFlight: 3,
            maxConcurrency: 3,
            slots: [
                { at: now - 2000, id: "a", kicked: true, owner: "newer" },
                { at: now - 5000, id: "b", kicked: true, owner: "stuck" },
                { at: now, id: "c", owner: "settling" },
            ],
        });

        await scheduler.fetch(post("/complete", { pool: "p" }));

        expect(poolRow(state, "p")?.slots.map((slot) => slot.owner)).toStrictEqual(["newer", "settling"]);
    });

    it("gives two jobs sharing a fixed dedup key a slot each", async () => {
        expect.assertions(2);

        const scheduler = new ScriptedScheduler(createFakeState(), origin);

        for (const shardKey of ["one", "two"]) {
            // eslint-disable-next-line no-await-in-loop -- sequential enqueue keeps the dispatch order fixed
            await scheduler.fetch(
                post("/schedule", {
                    args: {},
                    dedupKey: "shared",
                    functionPath: "job",
                    maxConcurrency: 1,
                    pool: "p",
                    scheduledFor: Date.now() - 1000,
                    shardKey,
                }),
            );
        }

        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(1);

        await complete(scheduler, scheduler.dispatched[0]);
        afterBackpressure();
        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(2);
    });

    it("reads a pool row stored before slots had owners as empty, so its jobs are not held forever", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new ScriptedScheduler(state, origin);

        state.storageMap.set("pool:p", { inFlight: 1, inFlightIds: ["old"], kickedIds: ["old"], maxConcurrency: 1 });
        await schedule(scheduler, 1);
        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(1);
        expect(poolRow(state, "p")?.slots.map((slot) => slot.owner)).toStrictEqual([scheduler.dispatched[0]?.dedupKey]);
    });
});

describe("schedulerDO — a slot whose attempt may still be running", () => {
    const origin = { LUNORA_ORIGIN_URL: "https://app.test" };

    const schedule = async (scheduler: SchedulerDO, body: Record<string, unknown> = {}): Promise<string> =>
        scheduledId(
            await scheduler.fetch(post("/schedule", { args: {}, functionPath: "job", maxConcurrency: 1, pool: "p", scheduledFor: Date.now() - 1000, ...body })),
        );

    /** The row as a reservation writes it: `id`'s scheduling holds the only slot for an attempt started now. */
    const heldByEarlierAttempt = (state: ReturnType<typeof createFakeState>, id: string): void => {
        const owner = (state.storageMap.get(`id:${id}`) as ScheduleRecord).dedupKey ?? id;

        state.storageMap.set("pool:p", { inFlight: 1, maxConcurrency: 1, slots: [{ at: Date.now(), id, owner }] });
    };

    const advance = (ms: number): void => {
        vi.setSystemTime(Date.now() + ms);
    };

    /** Past the backpressure delay, so a job re-armed for want of a slot is due again. */
    const afterBackpressure = (): void => {
        advance(60_000);
    };

    const dispatchedIds = (scheduler: ScriptedScheduler): string[] => scheduler.dispatched.map((record) => record.id);

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["Date"] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps the slot when re-fires exhaust the retries before the attempt holding it can have ended", async () => {
        expect.assertions(3);

        const state = createFakeState();
        const scheduler = new ScriptedScheduler(state, origin);
        const parked = await schedule(scheduler, { retry: { baseMs: 0, maxAttempts: 1 } });

        // Its first attempt was lost with its instance and may still be running at the origin.
        heldByEarlierAttempt(state, parked);
        scheduler.outcomes = [false, false];
        await scheduler.alarm();
        await scheduler.alarm();

        expect(state.storageMap.has(`dead:${parked}`)).toBe(true);

        const waiting = await schedule(scheduler);

        await scheduler.alarm();

        expect(dispatchedIds(scheduler)).not.toContain(waiting);

        // Past the claim ceiling no attempt this scheduler started can still be running.
        advance(DISPATCH_LEASE_MS);
        await scheduler.alarm();

        expect(dispatchedIds(scheduler)).toContain(waiting);
    });

    it("keeps a declined attempt's slot through a cancel when marking it failed, so a job reusing the id waits", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new ScriptedScheduler(state, origin);
        const { put } = state.storage;

        state.storage.put = async (keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
            if (keyOrEntries === "pool:p" && (value as { slots?: { kicked?: true }[] } | undefined)?.slots?.some((slot) => slot.kicked === true) === true) {
                throw new Error("storage unavailable");
            }

            return put(keyOrEntries as string, value);
        };

        await schedule(scheduler, { id: "reused" });
        scheduler.outcomes = ["in-progress"];
        await scheduler.alarm();

        const running = scheduler.dispatched[0];

        await scheduler.fetch(post("/cancel", { id: "reused" }));
        await schedule(scheduler, { id: "reused" });
        afterBackpressure();
        await scheduler.alarm();

        // The attempt the shard declined for still runs on the only slot.
        expect(scheduler.dispatched).toHaveLength(1);

        await scheduler.fetch(post("/complete", { dedupKey: running?.dedupKey, id: running?.id, pool: "p" }));
        afterBackpressure();
        await scheduler.alarm();

        expect(scheduler.dispatched).toHaveLength(2);
    });

    it("reclaims a kicked slot whose completion never arrives once the claim ceiling has passed", async () => {
        expect.assertions(2);

        const scheduler = new ScriptedScheduler(createFakeState(), origin);

        await schedule(scheduler);
        await scheduler.alarm();

        const waiting = await schedule(scheduler);

        // The attempt's /complete is lost: the slot stays counted while it may still run.
        advance(DISPATCH_LEASE_MS - 1);
        await scheduler.alarm();

        expect(dispatchedIds(scheduler)).not.toContain(waiting);

        afterBackpressure();
        await scheduler.alarm();

        expect(dispatchedIds(scheduler)).toContain(waiting);
    });

    it("does not let a retry.forever job whose re-fires never reach a receiver hold its slot past the claim ceiling", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new ScriptedScheduler(state, origin);
        const failing = await schedule(scheduler, { retry: { baseMs: 0, forever: true } });

        heldByEarlierAttempt(state, failing);
        scheduler.outcomes = Array.from<boolean>({ length: 40 }).fill(false);

        const waiting = await schedule(scheduler);

        // Every re-fire fails before reaching a receiver; none of them started anything.
        for (let elapsed = 0; elapsed < DISPATCH_LEASE_MS - 120_000; elapsed += 60_000) {
            // eslint-disable-next-line no-await-in-loop -- one alarm per minute of fake time
            await scheduler.alarm();
            afterBackpressure();
        }

        expect(dispatchedIds(scheduler)).not.toContain(waiting);

        advance(120_000);
        await scheduler.alarm();
        afterBackpressure();
        await scheduler.alarm();

        expect(dispatchedIds(scheduler)).toContain(waiting);
    });

    it("leaves the slot to a dispatch that claims the record while a cancel is under way", async () => {
        expect.assertions(2);

        const state = createFakeState();
        const scheduler = new ScriptedScheduler(state, origin);
        const cancelled = await schedule(scheduler);
        const { get: read } = state.storage;
        let resumeCancel: () => void = () => {};
        const resumed = new Promise<void>((resolve) => {
            resumeCancel = resolve;
        });
        let reachOutcomeRead: () => void = () => {};
        const cancelPaused = new Promise<void>((resolve) => {
            reachOutcomeRead = resolve;
        });

        // `/cancel` reads the job's outcome row after its header; hold it there.
        state.storage.get = async <T = unknown>(key: string): Promise<T | undefined> => {
            if (key === `done:${cancelled}`) {
                reachOutcomeRead();
                await resumed;
            }

            return read<T>(key);
        };

        const cancelling = scheduler.fetch(post("/cancel", { id: cancelled }));

        await cancelPaused;

        scheduler.outcomes = ["hold"];

        const kicked = new Promise<void>((resolve) => {
            scheduler.onKick = resolve;
        });
        const drain = scheduler.alarm();

        await kicked;
        resumeCancel();
        await cancelling;

        const waiting = await schedule(scheduler);

        afterBackpressure();
        await scheduler.alarm();

        // The claimed dispatch still holds the only slot.
        expect(dispatchedIds(scheduler)).toStrictEqual([cancelled]);

        scheduler.settleHeld?.(true);
        await drain;

        expect(dispatchedIds(scheduler)).not.toContain(waiting);
    });

    it("keeps a third job waiting while a job reusing a cancelled job's id is in flight", async () => {
        expect.assertions(3);

        const scheduler = new ScriptedScheduler(createFakeState(), origin);

        await schedule(scheduler, { id: "reused" });
        scheduler.outcomes = ["hold"];

        let kicked = new Promise<void>((resolve) => {
            scheduler.onKick = resolve;
        });
        const firstDrain = scheduler.alarm();

        await kicked;
        await scheduler.fetch(post("/cancel", { id: "reused" }));
        await schedule(scheduler, { id: "reused" });

        // The cancelled job's attempt fails and frees its own slot.
        scheduler.settleHeld?.(false);
        await firstDrain;

        scheduler.outcomes = ["hold"];
        kicked = new Promise<void>((resolve) => {
            scheduler.onKick = resolve;
        });
        afterBackpressure();

        const replacementDrain = scheduler.alarm();

        await kicked;

        expect(dispatchedIds(scheduler)).toStrictEqual(["reused", "reused"]);

        const third = await schedule(scheduler);

        afterBackpressure();
        await scheduler.alarm();

        // The replacement is in flight on the only slot.
        expect(dispatchedIds(scheduler)).not.toContain(third);

        scheduler.settleHeld?.(true);
        await replacementDrain;

        expect(dispatchedIds(scheduler)).not.toContain(third);
    });
});
