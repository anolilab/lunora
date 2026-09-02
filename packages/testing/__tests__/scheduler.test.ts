import { MAX_RETRY_ATTEMPTS, RETRY_BASE_DELAY_MS } from "@lunora/scheduler";
import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraTest } from "../src/index";

/**
 * The virtual-clock backoff each retry waits out, derived from the SAME
 * constants `SchedulerDO` and the fake scheduler use — never hard-coded here, so
 * a change to production's retry budget shows up as a failing assertion instead
 * of a silently-wrong test. `RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)` for
 * attempts 1..MAX_RETRY_ATTEMPTS; today `[30s, 60s, 120s, 240s, 480s]`.
 */
const RETRY_BACKOFFS_MS = Array.from({ length: MAX_RETRY_ATTEMPTS }, (_, index) => RETRY_BASE_DELAY_MS * 2 ** index);

/** Total virtual clock a job must be advanced through before a terminal failure is observable. */
const TOTAL_RETRY_BACKOFF_MS = RETRY_BACKOFFS_MS.reduce((sum, ms) => sum + ms, 0);

const { internalAction, internalMutation, mutation, query } = initLunora.dataModel().create();

const schema = defineSchema({
    log: defineTable({
        message: v.string(),
    }),
});

/** Mutation that appends a log entry — used as a scheduled target. */
const appendLog = internalMutation.input({ message: v.string() }).mutation(async ({ args, ctx }) => ctx.db.insert("log", { message: args.message }));

/** Mutation that schedules `appendLog` via ctx.scheduler.runAfter. */
const scheduleAppend = mutation
    .input({ delayMs: v.number(), message: v.string() })
    .mutation(({ args, ctx }) => ctx.scheduler.runAfter(args.delayMs, "log:appendLog", { message: args.message }));

/** Mutation that schedules `appendLog` via ctx.scheduler.runAt. */
const scheduleAppendAt = mutation
    .input({ atMs: v.number(), message: v.string() })
    .mutation(({ args, ctx }) => ctx.scheduler.runAt(args.atMs, "log:appendLog", { message: args.message }));

/** Mutation that schedules `appendLog` relative to `ctx.now` (the harness's virtual clock). */
const scheduleRelativeToNow = mutation
    .input({ delayMs: v.number(), message: v.string() })
    .mutation(({ args, ctx }) => ctx.scheduler.runAt(ctx.now + args.delayMs, "log:appendLog", { message: args.message }));

/**
 * Internal mutation that cancels every pending `log:appendLog` job — used as a
 * scheduled job that cancels a sibling job due in the same sweep.
 */
const cancelPendingAppends = internalMutation.mutation(async ({ ctx }) => {
    const jobs = await ctx.scheduler.list();

    for (const job of jobs) {
        if (job.functionPath === "log:appendLog") {
            // eslint-disable-next-line no-await-in-loop -- sequential cancels over a small snapshot; ordering is irrelevant
            await ctx.scheduler.cancel(job.id);
        }
    }
});

/** Mutation that schedules the throwing batch via ctx.scheduler.runAfter. */
const scheduleThrow = mutation.mutation(({ ctx }) => ctx.scheduler.runAfter(0, "log:appendThenThrow", {}));

/**
 * Internal action that calls `ctx.fetch` and then writes the response status via
 * `ctx.runMutation` — used as a scheduled target to prove the fake scheduler
 * dispatches a scheduled **action** with a real `ActionCtx` (`ctx.fetch` and
 * `ctx.runMutation` both available), not the `MutationCtx` it used to hand every
 * scheduled job regardless of kind.
 */
const pingViaFetch = internalAction.input({ url: v.string() }).action(async ({ args, ctx }) => {
    const response = await ctx.fetch(args.url);

    await ctx.runMutation(appendLog, { message: `status:${String(response.status)}` });
});

/** Mutation that schedules `pingViaFetch` via ctx.scheduler.runAfter. */
const scheduleFetchPing = mutation
    .input({ delayMs: v.number(), url: v.string() })
    .mutation(({ args, ctx }) => ctx.scheduler.runAfter(args.delayMs, "log:pingViaFetch", { url: args.url }));

/** Mutation that cancels a job by id. */
const cancelJob = mutation.input({ id: v.string() }).mutation(({ args, ctx }) => ctx.scheduler.cancel(args.id));

/** Mutation that lists pending jobs. */
const listJobs = mutation.mutation(({ ctx }) => ctx.scheduler.list());

/** Mutation that gets a single job. */
const getJob = mutation.input({ id: v.string() }).mutation(({ args, ctx }) => ctx.scheduler.get(args.id));

/**
 * Internal mutation that writes a batch and then throws — used to prove a
 * scheduled mutation gets its own BEGIN/COMMIT span (the partial batch must
 * roll back, matching production where the job is re-dispatched as its own RPC).
 */
const appendThenThrow = internalMutation.mutation(async ({ ctx }) => {
    await ctx.db.insertMany("log", [{ message: "partial-a" }, { message: "partial-b" }]);

    throw new Error("scheduled boom");
});

/**
 * Internal mutation that either appends a log entry or throws, depending on its
 * `fail` arg — used to interleave failing and succeeding scheduled jobs in one
 * sweep and prove per-job failure isolation.
 */
const appendOrThrow = internalMutation.input({ fail: v.boolean(), message: v.string() }).mutation(async ({ args, ctx }) => {
    if (args.fail) {
        throw new Error(`boom:${args.message}`);
    }

    return ctx.db.insert("log", { message: args.message });
});

/** Query that reads the log table. */
const readLog = query.query(({ ctx }) => ctx.db.query("log").collect());

/**
 * Per-key invocation counter for {@link flakyThenSucceed}, keyed by `args.key`
 * so concurrent tests scheduling their own flaky job don't interfere with each
 * other. Module-level (rather than DB-backed) because it is pure test
 * scaffolding, not something a handler under test would ever read.
 */
const flakyInvocationCounts = new Map<string, number>();

/**
 * Internal mutation that throws on its first `args.failTimes` invocations for a
 * given `args.key`, then succeeds and appends a log entry — used to prove the
 * fake scheduler's retry re-dispatches a job that transiently fails until it
 * succeeds.
 */
const flakyThenSucceed = internalMutation.input({ failTimes: v.number(), key: v.string() }).mutation(async ({ args, ctx }) => {
    const invocation = (flakyInvocationCounts.get(args.key) ?? 0) + 1;

    flakyInvocationCounts.set(args.key, invocation);

    if (invocation <= args.failTimes) {
        throw new Error(`flaky:${args.key}:${String(invocation)}`);
    }

    await ctx.db.insert("log", { message: `succeeded:${args.key}` });
});

/** Internal mutation that records the `ctx.now` it observed — used to pin the clock a scheduled job sees. */
const recordNow = internalMutation.mutation(async ({ ctx }) => ctx.db.insert("log", { message: `now:${String(ctx.now)}` }));

const functions = {
    "log:appendLog": appendLog,
    "log:recordNow": recordNow,
    "log:appendOrThrow": appendOrThrow,
    "log:appendThenThrow": appendThenThrow,
    "log:cancelPendingAppends": cancelPendingAppends,
    "log:flakyThenSucceed": flakyThenSucceed,
    "log:pingViaFetch": pingViaFetch,
};

const open: ReturnType<typeof lunoraTest>[] = [];

const start = (): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema, { functions });

    open.push(t);

    return t;
};

/** Same as {@link start}, but injects `options.fetch` for scheduled-action tests. */
const startWithFetch = (fetchImpl: typeof globalThis.fetch): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema, { fetch: fetchImpl, functions });

    open.push(t);

    return t;
};

describe("fake scheduler", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("queues a job via runAfter and does not execute it immediately", async () => {
        expect.assertions(2);

        const t = start();

        await t.mutation(scheduleAppend, { delayMs: 1000, message: "delayed" });

        const log = await t.query(readLog, {});

        expect(log).toHaveLength(0);
        expect(t.scheduler.list()).toHaveLength(1);
    });

    it("executes due jobs after advance(ms) ticks the virtual clock past dueAt", async () => {
        expect.assertions(2);

        const t = start();

        await t.mutation(scheduleAppend, { delayMs: 500, message: "after advance" });

        const executed = await t.scheduler.advance(1000);

        expect(executed).toBe(1);

        const log = await t.query(readLog, {});

        expect(log[0]).toMatchObject({ message: "after advance" });
    });

    it("does not execute a job whose dueAt is still in the future after advance", async () => {
        expect.assertions(2);

        const t = start();

        await t.mutation(scheduleAppend, { delayMs: 2000, message: "future" });

        const executed = await t.scheduler.advance(500);

        expect(executed).toBe(0);

        const log = await t.query(readLog, {});

        expect(log).toHaveLength(0);
    });

    it("executes all pending jobs via runPending regardless of scheduled time", async () => {
        expect.assertions(3);

        const t = start();

        await t.mutation(scheduleAppend, { delayMs: 999_999, message: "far future" });
        await t.mutation(scheduleAppend, { delayMs: 0, message: "now" });

        const executed = await t.scheduler.runPending();

        expect(executed).toBe(2);

        const log = await t.query(readLog, {});

        expect(log).toHaveLength(2);
        expect((log as { message: string }[]).map((r) => r.message).toSorted((a, b) => a.localeCompare(b))).toEqual(["far future", "now"]);
    });

    it("list() reflects the pending queue before and after execution", async () => {
        expect.assertions(3);

        const t = start();

        await t.mutation(scheduleAppend, { delayMs: 100, message: "a" });
        await t.mutation(scheduleAppend, { delayMs: 200, message: "b" });

        expect(t.scheduler.list()).toHaveLength(2);

        await t.scheduler.runPending();

        expect(t.scheduler.list()).toHaveLength(0);

        const log = await t.query(readLog, {});

        expect(log).toHaveLength(2);
    });

    it("cancel removes the job from the queue and returns cancelled: true", async () => {
        expect.assertions(3);

        const t = start();

        const jobId = await t.mutation(scheduleAppend, { delayMs: 1000, message: "cancelled" });

        const cancelResult = await t.mutation(cancelJob, { id: jobId });

        expect(cancelResult.cancelled).toBe(true);
        expect(t.scheduler.list()).toHaveLength(0);

        await t.scheduler.advance(2000);

        const log = await t.query(readLog, {});

        expect(log).toHaveLength(0);
    });

    it("does not execute a job cancelled by an earlier job in the same sweep", async () => {
        expect.assertions(3);

        const t = start();

        // Enqueue the canceller FIRST so it dispatches before the target within the
        // sweep, then the appendLog target. Both are due at 0.
        await t.run(async (ctx) => {
            await ctx.scheduler.runAfter(0, "log:cancelPendingAppends", {});
            await ctx.scheduler.runAfter(0, "log:appendLog", { message: "should-not-run" });
        });

        const executed = await t.scheduler.runPending();

        // Only the canceller ran; the appendLog job was removed mid-sweep and skipped
        // (its handler must not run, honouring cancel's `{ cancelled: true }`), so it
        // is not counted as executed either.
        expect(executed).toBe(1);
        expect(t.scheduler.list()).toHaveLength(0);

        await expect(t.query(readLog, {})).resolves.toHaveLength(0);
    });

    it("seeds the virtual clock from options.now so ctx.now-relative scheduling is deterministic", async () => {
        expect.assertions(3);

        // A fixed `now` far below the wall clock. Before the fix the scheduler seeded
        // its virtual clock from Date.now() (~2026) while ctx.now was this value
        // (~2023), so a `runAt(ctx.now + delay)` job sat far below virtual now and
        // advance(1) fired it immediately.
        const fixedNow = 1_700_000_000_000;
        const t = lunoraTest(schema, { functions, now: fixedNow });

        open.push(t);

        await t.mutation(scheduleRelativeToNow, { delayMs: 60_000, message: "relative" });

        // Advancing less than the delay must NOT fire it.
        const early = await t.scheduler.advance(1);

        expect(early).toBe(0);

        // Advancing past the delay fires it.
        const late = await t.scheduler.advance(60_000);

        expect(late).toBe(1);

        await expect(t.query(readLog, {})).resolves.toHaveLength(1);
    });

    it("cancel returns cancelled: false for an unknown id", async () => {
        expect.assertions(1);

        const t = start();

        const result = await t.mutation(cancelJob, { id: "no-such-job" });

        expect(result.cancelled).toBe(false);
    });

    it("get returns the job when pending and null after it executes", async () => {
        expect.assertions(2);

        const t = start();

        const jobId = await t.mutation(scheduleAppend, { delayMs: 500, message: "getable" });

        const job = await t.mutation(getJob, { id: jobId });

        expect(job).toMatchObject({ functionPath: "log:appendLog", id: jobId });

        await t.scheduler.advance(1000);

        const afterExec = await t.mutation(getJob, { id: jobId });

        expect(afterExec).toBeNull();
    });

    it("runAt schedules a job at an absolute timestamp", async () => {
        expect.assertions(2);

        const t = start();

        // Use a fixed future timestamp; advance() uses a relative offset so we
        // just need to advance beyond it.
        await t.mutation(scheduleAppendAt, { atMs: Date.now() + 5000, message: "absolute" });

        const beforeAdvance = await t.query(readLog, {});

        expect(beforeAdvance).toHaveLength(0);

        await t.scheduler.advance(10_000);

        const afterAdvance = await t.query(readLog, {});

        expect(afterAdvance).toHaveLength(1);
    });

    it("executed jobs share the same in-memory SQLite database as the harness", async () => {
        expect.assertions(1);

        const t = start();

        // Write directly, then schedule a job that also writes — both should
        // be visible in the same query.
        await t.run(async (ctx) => ctx.db.insert("log", { message: "direct" }));
        await t.mutation(scheduleAppend, { delayMs: 0, message: "scheduled" });
        await t.scheduler.runPending();

        const log = await t.query(readLog, {});

        expect((log as { message: string }[]).map((r) => r.message).toSorted((a, b) => a.localeCompare(b))).toEqual(["direct", "scheduled"]);
    });

    it("ctx.scheduler stub still throws when no functions option is provided and handler schedules", async () => {
        expect.assertions(1);

        // Create a harness without functions — scheduler should still be a real
        // fake scheduler (not a throwing stub). Schedule a job with an unknown path;
        // enqueueing succeeds, and the first dispatch failure is retried silently
        // (production does not surface a mid-retry failure either).
        const t = lunoraTest(schema);

        open.push(t);

        // runAfter itself should succeed (enqueue) and return a job id string.
        const jobId = await t.mutation(scheduleAppend, { delayMs: 0, message: "unknown path" });

        expect(typeof jobId).toBe("string");

        // Running pending should warn but not throw.
        await t.scheduler.runPending();
    });

    it("list() from ctx.scheduler.list() also returns pending jobs", async () => {
        expect.assertions(1);

        const t = start();

        await t.mutation(scheduleAppend, { delayMs: 100, message: "listed" });

        const ctxJobs = await t.mutation(listJobs, {});

        expect(ctxJobs as unknown[]).toHaveLength(1);
    });

    it("a scheduled mutation runs in its own transaction — a mid-batch throw rolls back every attempt, including the terminal one (matching production)", async () => {
        expect.assertions(4);

        const t = start();

        await t.mutation(scheduleThrow, {});

        // Attempt 1: the job throws mid-batch. It is still within the default
        // 5-retry budget, so it is silently retried rather than surfacing —
        // matching SchedulerDO, which routes a failed dispatch to retry rather
        // than dead-lettering it on the first failure. The partial insertMany
        // must NOT persist regardless (the scheduled mutation gets its own
        // BEGIN/COMMIT span on every attempt, exactly like a top-level
        // t.mutation(...) call).
        await expect(t.scheduler.runPending()).resolves.toBe(1);
        await expect(t.query(readLog, {})).resolves.toHaveLength(0);

        // Exhaust the remaining retry budget (MAX_RETRY_ATTEMPTS retries,
        // exponential backoff from RETRY_BASE_DELAY_MS) so the job reaches its
        // terminal attempt.
        for (const delay of RETRY_BACKOFFS_MS) {
            // eslint-disable-next-line no-await-in-loop -- sequential virtual-clock advances; each depends on the last
            await t.scheduler.advance(delay, { throwOnError: false });
        }

        // Terminal attempt: still rolls back, and the failure is now surfaced.
        expect(t.scheduler.failures()).toHaveLength(1);
        await expect(t.query(readLog, {})).resolves.toHaveLength(0);
    });

    it("a scheduled mutation re-emits to active subscriptions, like a top-level mutation", async () => {
        expect.assertions(2);

        const t = start();

        const sub = t.subscribe(readLog, {});

        // Initial snapshot — empty.
        const first = await sub.next();

        expect(first.value).toHaveLength(0);

        // Schedule + run a mutation that writes; the subscription must observe it.
        await t.mutation(scheduleAppend, { delayMs: 0, message: "scheduled-emit" });
        await t.scheduler.runPending();

        const second = await sub.next();

        await sub.return();

        expect(second.value).toHaveLength(1);
    });

    it("isolates a failing scheduled job — the remaining jobs still run while the failed one is retried", async () => {
        expect.assertions(5);

        const t = start();

        // Schedule three jobs: ok, fail, ok. The middle one throws.
        await t.run(async (ctx) => {
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: false, message: "first" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "middle" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: false, message: "last" });
        });

        // The middle job throws but is still within the default retry budget, so
        // it is silently retried rather than surfaced — matching SchedulerDO,
        // which routes a failed dispatch to retry rather than aborting the drain
        // or dead-lettering it on the first failure.
        const executed = await t.scheduler.runPending();

        expect(executed).toBe(3);

        // Both non-failing jobs ran despite the middle one throwing.
        const log = await t.query(readLog, {});

        expect((log as { message: string }[]).map((r) => r.message).toSorted((a, b) => a.localeCompare(b))).toEqual(["first", "last"]);

        // Not yet a terminal failure — the retry budget has not been exhausted.
        expect(t.scheduler.failures()).toHaveLength(0);

        // The failing job is still pending, waiting out its backoff for a retry.
        const stillPending = t.scheduler.list();

        expect(stillPending).toHaveLength(1);
        expect(stillPending[0]).toMatchObject({ attempts: 1, functionPath: "log:appendOrThrow" });
    });

    it("aggregates multiple scheduled-job failures into an AggregateError once each exhausts its retry budget, while running the survivor", async () => {
        expect.assertions(4);

        const t = start();

        await t.run(async (ctx) => {
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "boom-a" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: false, message: "survivor" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "boom-b" });
        });

        // Attempt 1 for both failing jobs — within budget, silently retried.
        await t.scheduler.runPending({ throwOnError: false });

        // Both failing jobs share the same schedule (enqueued together, same
        // default backoff), so they exhaust their retry budget in the same sweep.
        for (const delay of RETRY_BACKOFFS_MS.slice(0, -1)) {
            // eslint-disable-next-line no-await-in-loop -- sequential virtual-clock advances; each depends on the last
            await t.scheduler.advance(delay, { throwOnError: false });
        }

        // Final attempt: both exceed the retry budget in this sweep — surfaced
        // together as an AggregateError.
        await expect(t.scheduler.advance(RETRY_BACKOFFS_MS.at(-1) ?? 0)).rejects.toBeInstanceOf(AggregateError);

        // The surviving job persisted.
        const log = await t.query(readLog, {});

        expect((log as { message: string }[]).map((r) => r.message)).toEqual(["survivor"]);

        const failures = t.scheduler.failures();

        expect(failures).toHaveLength(2);
        expect(failures.map((f) => (f.error as Error).message).toSorted((a, b) => a.localeCompare(b))).toEqual(["boom:boom-a", "boom:boom-b"]);
    });

    it("dispatches a scheduled action with a real ActionCtx — ctx.fetch (injected via options.fetch) is reachable, not a MutationCtx", async () => {
        expect.assertions(3);

        const fakeFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ ok: true }, { status: 200 }));

        const t = startWithFetch(fakeFetch);

        await t.mutation(scheduleFetchPing, { delayMs: 0, url: "https://example.test/scheduled-ping" });

        // Before the fix, dispatchJob always handed the fake scheduler's
        // mutationContext to the handler — a scheduled action calling ctx.fetch
        // would throw `ctx.fetch is not a function` here.
        const executed = await t.scheduler.runPending();

        expect(executed).toBe(1);
        expect(fakeFetch).toHaveBeenCalledWith("https://example.test/scheduled-ping");

        const log = await t.query(readLog, {});

        expect(log).toMatchObject([{ message: "status:200" }]);
    });

    it("with throwOnError: false the sweep resolves and failures are observable via failures() once the retry budget is exhausted", async () => {
        expect.assertions(4);

        const t = start();

        await t.run(async (ctx) => {
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: false, message: "kept" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "swallowed" });
        });

        // No throw on any attempt — the count of jobs dispatched this sweep
        // (including the retried/failed one) is returned every time.
        await expect(t.scheduler.runPending({ throwOnError: false })).resolves.toBe(2);
        expect(t.scheduler.failures()).toHaveLength(0);

        for (const delay of RETRY_BACKOFFS_MS) {
            // eslint-disable-next-line no-await-in-loop -- sequential virtual-clock advances; each depends on the last
            await t.scheduler.advance(delay, { throwOnError: false });
        }

        const log = await t.query(readLog, {});

        expect((log as { message: string }[]).map((r) => r.message)).toEqual(["kept"]);

        expect(t.scheduler.failures()).toHaveLength(1);
    });

    describe("retry parity with SchedulerDO", () => {
        it("a job that fails twice then succeeds is retried to success and records no terminal failure", async () => {
            expect.assertions(6);

            const t = start();

            await t.run(async (ctx) => ctx.scheduler.runAfter(0, "log:flakyThenSucceed", { failTimes: 2, key: "flaky-1" }));

            // Attempt 1: fails, retried 30s out — not yet terminal.
            await expect(t.scheduler.runPending()).resolves.toBe(1);
            expect(t.scheduler.failures()).toHaveLength(0);

            // Attempt 2 (after the first base backoff): fails again, retried at double.
            await expect(t.scheduler.advance(RETRY_BASE_DELAY_MS)).resolves.toBe(1);

            // Attempt 3 (after the doubled backoff): succeeds.
            await expect(t.scheduler.advance(RETRY_BASE_DELAY_MS * 2)).resolves.toBe(1);

            await expect(t.query(readLog, {})).resolves.toMatchObject([{ message: "succeeded:flaky-1" }]);
            expect(t.scheduler.failures()).toHaveLength(0);
        });

        it("a job that fails every time is retried MAX_RETRY_ATTEMPTS times before landing in recordedFailures", async () => {
            // 7 fixed assertions + one per non-final retry (MAX_RETRY_ATTEMPTS - 1).
            // A change to the retry budget breaks this count loudly rather than
            // quietly asserting fewer things.
            expect.assertions(11);

            const t = start();

            await t.run(async (ctx) => ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "always" }));

            // Attempt 1 (the original dispatch): fails. attempts=1 is within the
            // retry budget, so it is silently retried rather than surfaced.
            await expect(t.scheduler.runPending()).resolves.toBe(1);
            expect(t.scheduler.failures()).toHaveLength(0);

            // Backoff is honoured: advancing short of the first cutoff does not fire the retry.
            await expect(t.scheduler.advance(RETRY_BASE_DELAY_MS - 1)).resolves.toBe(0);

            // Every retry but the last: still within budget. Each waits out a
            // delay double the one before it. The clock already sits 1ms short of
            // the first cutoff, so that one costs a single millisecond here.
            for (const [index, delay] of RETRY_BACKOFFS_MS.slice(0, -1).entries()) {
                // eslint-disable-next-line no-await-in-loop -- sequential virtual-clock advances; each depends on the last
                await expect(t.scheduler.advance(index === 0 ? 1 : delay)).resolves.toBe(1);
            }

            expect(t.scheduler.failures()).toHaveLength(0);

            // The final retry pushes `attempts` past MAX_RETRY_ATTEMPTS — terminal,
            // matching SchedulerDO's dead-letter park.
            await expect(t.scheduler.advance(RETRY_BACKOFFS_MS.at(-1) ?? 0)).rejects.toThrow("boom:always");

            expect(t.scheduler.failures()).toHaveLength(1);
            expect(t.scheduler.list()).toHaveLength(0);
        });

        it("pins the virtual clock a terminal failure costs: the whole backoff schedule, not one tick", async () => {
            expect.assertions(5);

            const t = start();

            // The contract, stated as a number: observing `failures()` needs the
            // ENTIRE backoff schedule advanced. Change MAX_RETRY_ATTEMPTS or
            // RETRY_BASE_DELAY_MS in @lunora/scheduler and this assertion moves
            // with it — so the cost is never changed silently.
            expect(RETRY_BACKOFFS_MS).toStrictEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
            expect(TOTAL_RETRY_BACKOFF_MS).toBe(930_000);

            await t.run(async (ctx) => ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "budgeted" }));

            // A single small advance after the first dispatch is NOT enough — the
            // regression this pins: `advance(1000)` used to surface the failure.
            await t.scheduler.runPending({ throwOnError: false });
            await t.scheduler.advance(1000, { throwOnError: false });

            expect(t.scheduler.failures()).toStrictEqual([]);

            // Walk the whole schedule: the fake scheduler re-evaluates one retry
            // per sweep, so each backoff needs its own advance — one advance of
            // the total would fire only the first retry.
            for (const delay of RETRY_BACKOFFS_MS) {
                // eslint-disable-next-line no-await-in-loop -- sequential virtual-clock advances; each depends on the last
                await t.scheduler.advance(delay, { throwOnError: false });
            }

            expect(t.scheduler.failures()).toHaveLength(1);
            expect(t.scheduler.list()).toStrictEqual([]);
        });

        it("honours the backoff cutoff — a retried job does not re-run until the virtual clock passes it", async () => {
            expect.assertions(4);

            const t = start();

            await t.run(async (ctx) => ctx.scheduler.runAfter(0, "log:flakyThenSucceed", { failTimes: 1, key: "backoff-cutoff" }));

            // Attempt 1: fails, retried RETRY_BASE_DELAY_MS out.
            await expect(t.scheduler.runPending()).resolves.toBe(1);

            // Short of the cutoff: the retry does not fire.
            await expect(t.scheduler.advance(RETRY_BASE_DELAY_MS - 1)).resolves.toBe(0);
            await expect(t.query(readLog, {})).resolves.toHaveLength(0);

            // At the cutoff: the retry fires and succeeds.
            await expect(t.scheduler.advance(1)).resolves.toBe(1);
        });

        it("an unknown functionPath retries then dead-letters, as production does", async () => {
            expect.assertions(3);

            const t = start();

            await t.run(async (ctx) => ctx.scheduler.runAfter(0, "log:doesNotExist", {}));

            // Production fires the job at the Worker, which answers FUNCTION_NOT_FOUND;
            // the job then walks its retry budget into the dead-letter queue. It is a
            // job failure, not a silent drop.
            await expect(t.scheduler.runPending()).resolves.toBe(1);
            expect(t.scheduler.list()).toHaveLength(1);

            // One advance per retry — a job re-enqueued mid-sweep waits for the next one.
            for (const delay of RETRY_BACKOFFS_MS) {
                // eslint-disable-next-line no-await-in-loop -- sequential virtual-clock advances; each depends on the last
                await t.scheduler.advance(delay, { throwOnError: false });
            }

            expect(t.scheduler.failures().map((failure) => (failure.error as Error).message)).toStrictEqual([
                expect.stringContaining('unknown functionPath "log:doesNotExist"'),
            ]);
        });

        it("a successful job runs exactly once and is never retried", async () => {
            expect.assertions(3);

            const t = start();

            await t.mutation(scheduleAppend, { delayMs: 0, message: "once" });

            await expect(t.scheduler.runPending()).resolves.toBe(1);

            // Advancing far past what would have been a retry backoff must not
            // re-run the (already succeeded) job.
            await expect(t.scheduler.advance(10_000_000)).resolves.toBe(0);

            await expect(t.query(readLog, {})).resolves.toHaveLength(1);
        });
    });
});

/**
 * The fake scheduler must reject what production rejects and fail what production
 * fails — a divergence here is a test suite that passes on a job the deploy will
 * refuse to schedule or never run.
 */
describe("fake scheduler production parity", () => {
    afterEach(() => {
        while (open.length > 0) {
            open.pop()?.close();
        }
    });

    it("rejects a negative or non-finite runAfter delay", async () => {
        expect.assertions(2);

        const t = start();

        await expect(t.run(async (ctx) => ctx.scheduler.runAfter(-5, "log:appendLog", { message: "x" }))).rejects.toThrow(
            "`delayMs` must be a non-negative finite number",
        );
        await expect(t.run(async (ctx) => ctx.scheduler.runAfter(Number.NaN, "log:appendLog", { message: "x" }))).rejects.toThrow(
            "`delayMs` must be a non-negative finite number",
        );
    });

    it("rejects a non-finite runAt instant, and accepts an overdue one", async () => {
        expect.assertions(2);

        const t = start();

        // The fake is a THIRD `runAt` alongside `createScheduler` and the deferral
        // facade; a harness that took a value production refuses would tell a test
        // the opposite of what ships.
        await expect(t.run(async (ctx) => ctx.scheduler.runAt(Number.NaN, "log:appendLog", { message: "x" }))).rejects.toThrow(
            "`date` must be a non-negative finite number",
        );
        // An instant that has already passed is an overdue job, not a bad argument.
        await expect(t.run(async (ctx) => ctx.scheduler.runAt(1, "log:appendLog", { message: "x" }))).resolves.toMatch(/\S/u);
    });

    it("rejects args the scheduler cannot serialize", async () => {
        expect.assertions(1);

        const t = start();

        // Production posts the job as JSON, so a bigint arg throws at schedule time.
        await expect(t.run(async (ctx) => ctx.scheduler.runAfter(0, "log:appendLog", { message: 1n as unknown as string }))).rejects.toThrow(/BigInt/u);
    });

    it("gives a scheduled job the advanced clock as ctx.now", async () => {
        expect.assertions(1);

        const t = lunoraTest(schema, { functions, now: 1_000_000 });

        open.push(t);

        await t.run(async (ctx) => ctx.scheduler.runAfter(0, "log:recordNow", {}));
        await t.scheduler.advance(3_600_000);

        // The job fired an hour into the virtual clock, so it must see that instant —
        // not the harness's construction time.
        await expect(t.query(readLog, {})).resolves.toStrictEqual([expect.objectContaining({ message: `now:${String(1_000_000 + 3_600_000)}` })]);
    });
});
