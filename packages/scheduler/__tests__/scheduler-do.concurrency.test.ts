/**
 * Concurrency of one alarm drain.
 *
 * `SchedulerDO.dispatch()` awaits an outbound fetch that the runtime's
 * `/_lunora/scheduler/dispatch` receiver only answers once the dispatched
 * function has FINISHED running. A drain that awaits each record in turn
 * therefore serialises whole jobs, not just their kicks — one slow job delays
 * every other due job in the app, and a workpool's `maxConcurrency` can never
 * be reached because only one job is ever in flight.
 *
 * These tests hold dispatches open deliberately (a promise the test resolves,
 * never a timer) so "did these overlap?" is a deterministic question about how
 * many dispatches have STARTED while none has finished.
 */
import { describe, expect, it } from "vitest";

import { MAX_CONCURRENT_DISPATCHES } from "../src/scheduler-do";
import type { ScheduleRecord } from "../src/types";
import { BlockingScheduler, isIndexed, scheduleDue, settle } from "./blocking-scheduler";
import { createFakeState } from "./fake-state";

describe("schedulerDO alarm drain concurrency", () => {
    it("dispatches several due jobs at once instead of awaiting each in turn", async () => {
        expect.hasAssertions();

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduleDue(scheduler, 4);

        // Deliberately not awaited: every dispatch blocks until released, so the
        // alarm only settles at the end of the test.
        const drain = scheduler.alarm();

        await settle();

        // The defect: with a sequential drain exactly one dispatch has started
        // and the other three wait behind a job that has not finished running.
        expect(scheduler.started).toStrictEqual(["job-0", "job-1", "job-2", "job-3"]);
        expect(scheduler.finished).toStrictEqual([]);

        scheduler.releaseAll();
        await drain;

        expect(scheduler.finished).toHaveLength(4);
    });

    it("bounds in-flight dispatches to MAX_CONCURRENT_DISPATCHES", async () => {
        expect.hasAssertions();

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduleDue(scheduler, MAX_CONCURRENT_DISPATCHES + 4);

        const drain = scheduler.alarm();

        await settle();

        expect(scheduler.started).toHaveLength(MAX_CONCURRENT_DISPATCHES);

        // Releasing one admits exactly one more — the lanes refill from the head
        // of the due slice, so the drain never exceeds the cap.
        scheduler.release("job-0");
        await settle();

        expect(scheduler.started).toHaveLength(MAX_CONCURRENT_DISPATCHES + 1);

        for (let round = 0; round < 4; round += 1) {
            scheduler.releaseAll();
            // eslint-disable-next-line no-await-in-loop -- each round must settle before the next release
            await settle();
        }

        await drain;

        expect(scheduler.started).toHaveLength(MAX_CONCURRENT_DISPATCHES + 4);
    });

    it("holds maxConcurrency of a pool's jobs in flight at once, queueing the rest", async () => {
        expect.hasAssertions();

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduleDue(scheduler, 5, { maxConcurrency: 3, pool: "p" });

        const drain = scheduler.alarm();

        await settle();

        // What `createWorkpool`'s docs promise: three at once, not one.
        expect(scheduler.started).toStrictEqual(["job-0", "job-1", "job-2"]);

        // And the pool row must account for all three holders — a concurrent
        // read-modify-write that lost an update would show fewer.
        const pool = state.storageMap.get("pool:p") as { inFlight: number; inFlightIds: string[] };

        expect(pool.inFlightIds).toStrictEqual(["job-0", "job-1", "job-2"]);
        expect(pool.inFlight).toBe(3);

        scheduler.releaseAll();
        await drain;

        // The two over the cap were re-armed as backpressure, not dispatched.
        expect(scheduler.started).toStrictEqual(["job-0", "job-1", "job-2"]);
        expect(state.storageMap.has("id:job-3")).toBe(true);
        expect(state.storageMap.has("id:job-4")).toBe(true);
    });

    it("keeps draining when one job's dispatch throws", async () => {
        expect.hasAssertions();

        const state = createFakeState();

        class ThrowingScheduler extends BlockingScheduler {
            protected override async dispatch(record: ScheduleRecord): Promise<boolean> {
                if (record.id === "job-1") {
                    throw new Error("boom");
                }

                return super.dispatch(record);
            }
        }

        const scheduler = new ThrowingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduleDue(scheduler, 3);

        const drain = scheduler.alarm();

        await settle();

        expect(scheduler.started).toStrictEqual(["job-0", "job-2"]);

        scheduler.releaseAll();
        await drain;

        // The thrower stays re-fireable (its time-index claim was re-asserted)
        // and its siblings completed.
        expect(scheduler.finished).toStrictEqual(["job-0", "job-2"]);
        expect(state.storageMap.has("id:job-1")).toBe(true);
        expect(isIndexed(state.storageMap, "job-1")).toBe(true);
    });

    it("lets a fast job settle while a never-answering dispatch is still open", async () => {
        expect.hasAssertions();

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduleDue(scheduler, 2);

        const drain = scheduler.alarm();

        await settle();

        // `job-0` never answers; `job-1` does. The hung one must not hold up the
        // other's settlement.
        scheduler.release("job-1");
        await settle();

        expect(state.storageMap.has("id:job-1")).toBe(false);
        expect(state.storageMap.has("id:job-0")).toBe(true);

        scheduler.releaseAll();
        await drain;
    });

    it("leaves a job the drain never reached re-fireable when the alarm is cut off", async () => {
        expect.hasAssertions();

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, { LUNORA_ORIGIN_URL: "https://app.test" });

        await scheduleDue(scheduler, MAX_CONCURRENT_DISPATCHES + 2);

        // Start the drain and abandon it, the way the runtime abandons an alarm
        // invocation that hits its 15-minute wall clock mid-drain. The promise
        // is deliberately never awaited — its lanes stay parked forever.
        const abandoned = scheduler.alarm();

        expect(abandoned).toBeInstanceOf(Promise);

        await settle();

        // Records the drain never reached keep BOTH rows, so the next alarm
        // fires them normally — the ceiling costs latency, not the job.
        expect(isIndexed(state.storageMap, `job-${String(MAX_CONCURRENT_DISPATCHES)}`)).toBe(true);
        expect(isIndexed(state.storageMap, `job-${String(MAX_CONCURRENT_DISPATCHES + 1)}`)).toBe(true);

        // A record the drain DID reach is claimed, not unindexed: the claim is a
        // lease, so it keeps a `t:` entry the whole time its dispatch is open.
        // What that lease does for a successor instance is
        // `scheduler-do.lease.test.ts`'s subject.
        expect(isIndexed(state.storageMap, "job-0")).toBe(true);
        expect(state.storageMap.has("id:job-0")).toBe(true);

        // The abandoned lanes are deliberately never released: an evicted
        // instance's in-flight dispatches simply stop existing.
        scheduler.releaseAll();
    });
});
