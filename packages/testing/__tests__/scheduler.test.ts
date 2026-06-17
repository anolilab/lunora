import { defineSchema, defineTable, initLunora, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";

const { internalMutation, mutation, query } = initLunora.dataModel().create();

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

/** Mutation that cancels a job by id. */
const cancelJob = mutation.input({ id: v.string() }).mutation(({ args, ctx }) => ctx.scheduler.cancel(args.id));

/** Mutation that lists pending jobs. */
const listJobs = mutation.mutation(({ ctx }) => ctx.scheduler.list());

/** Mutation that gets a single job. */
const getJob = mutation.input({ id: v.string() }).mutation(({ args, ctx }) => ctx.scheduler.get(args.id));

/** Query that reads the log table. */
const readLog = query.query(({ ctx }) => ctx.db.query("log").collect());

const functions = {
    "log:appendLog": appendLog,
};

const open: ReturnType<typeof lunoraTest>[] = [];

const start = (): ReturnType<typeof lunoraTest> => {
    const t = lunoraTest(schema, { functions });

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
});
