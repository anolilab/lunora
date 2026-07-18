import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lunoraTest } from "../src/index";

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

const functions = {
    "log:appendLog": appendLog,
    "log:appendOrThrow": appendOrThrow,
    "log:appendThenThrow": appendThenThrow,
    "log:cancelPendingAppends": cancelPendingAppends,
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
        // it should warn+drop, not throw.
        const t = lunoraTest(schema);

        open.push(t);

        // runAfter itself should succeed (enqueue) and return a job id string; only dispatch will warn+drop.
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

    it("a scheduled mutation runs in its own transaction — a mid-batch throw rolls back everything (matching production)", async () => {
        expect.assertions(2);

        const t = start();

        await t.mutation(scheduleThrow, {});

        // The job throws mid-batch; runPending surfaces the throw, but the partial
        // insertMany must NOT persist (the scheduled mutation gets its own
        // BEGIN/COMMIT span, exactly like a top-level t.mutation(...) call).
        await expect(t.scheduler.runPending()).rejects.toThrow("scheduled boom");

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

    it("isolates a failing scheduled job — the remaining jobs still run and the failure is observable", async () => {
        expect.assertions(4);

        const t = start();

        // Schedule three jobs: ok, fail, ok. The middle one throws.
        await t.run(async (ctx) => {
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: false, message: "first" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "middle" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: false, message: "last" });
        });

        // Default surfacing re-throws after every job has run.
        await expect(t.scheduler.runPending()).rejects.toThrow("boom:middle");

        // Both non-failing jobs ran despite the middle one throwing.
        const log = await t.query(readLog, {});

        expect((log as { message: string }[]).map((r) => r.message).toSorted((a, b) => a.localeCompare(b))).toEqual(["first", "last"]);

        // The failure is recorded and observable.
        const failures = t.scheduler.failures();

        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ functionPath: "log:appendOrThrow" });
    });

    it("aggregates multiple scheduled-job failures into an AggregateError while running the survivors", async () => {
        expect.assertions(4);

        const t = start();

        await t.run(async (ctx) => {
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "boom-a" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: false, message: "survivor" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "boom-b" });
        });

        await expect(t.scheduler.runPending()).rejects.toBeInstanceOf(AggregateError);

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

    it("with throwOnError: false the sweep resolves and failures are observable via failures()", async () => {
        expect.assertions(3);

        const t = start();

        await t.run(async (ctx) => {
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: false, message: "kept" });
            await ctx.scheduler.runAfter(0, "log:appendOrThrow", { fail: true, message: "swallowed" });
        });

        // No throw — the count of executed jobs (including the failed one) is returned.
        const executed = await t.scheduler.runPending({ throwOnError: false });

        expect(executed).toBe(2);

        const log = await t.query(readLog, {});

        expect((log as { message: string }[]).map((r) => r.message)).toEqual(["kept"]);

        expect(t.scheduler.failures()).toHaveLength(1);
    });
});
