/**
 * The dispatch claim is a LEASE, not a deletion.
 *
 * `drainRecordGuarded` claims a due record before `dispatch()`'s outbound
 * fetch. When that claim simply deleted the `t:` index entry, an instance lost
 * mid-dispatch left an `id:` header with no index — and the successor's
 * `reindexOrphanedRecords` re-armed it and dispatched it again IMMEDIATELY,
 * while the first attempt may still have been running at the origin. For a
 * mutation or workflow target the receiver's dedup absorbs that; for an ACTION
 * it does not, because `@lunora/do` writes the dedup row only after the handler
 * returns (and deliberately takes no single-writer gate for a non-mutation), so
 * a long action re-fired mid-flight runs a second time CONCURRENTLY with the
 * first.
 *
 * The claim now re-arms the record at `now + DISPATCH_LEASE_MS` instead. The
 * record is never unindexed, so it is never an orphan, so a successor does not
 * re-fire it on sight — it re-fires it when the lease expires, by which point
 * no dispatch this scheduler started can still be open (the 15-minute alarm
 * wall clock bounds the invocation that owns the fetch).
 *
 * These tests drive the real race: abandon a drain mid-dispatch and build a
 * successor over the SAME storage, exactly as an eviction does.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DISPATCH_LEASE_MS } from "../src/scheduler-do";
import { BlockingScheduler, indexedAt, isIndexed, post, scheduleDue, settle } from "./blocking-scheduler";
import { createFakeState } from "./fake-state";

const env = { LUNORA_ORIGIN_URL: "https://app.test" };

/** Pin `Date.now()` so lease arithmetic is exact. `setTimeout` is left real, so `settle()` still works. */
const pinClock = (at: number): ((to: number) => void) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(at);

    return (to: number) => {
        now.mockReturnValue(to);
    };
};

describe("schedulerDO dispatch lease", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("keeps a claimed record indexed at the lease horizon while its dispatch is open", async () => {
        expect.hasAssertions();

        const at = Date.now();

        pinClock(at);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1);

        const drain = scheduler.alarm();

        await settle();

        expect(scheduler.started).toStrictEqual(["job-0"]);
        // The record is claimed but NOT unindexed: its `t:` entry moved to the
        // lease horizon. That is what stops a successor treating it as an orphan.
        expect(indexedAt(state.storageMap, "job-0")).toBe(at + DISPATCH_LEASE_MS);
        expect(state.storageMap.has("id:job-0")).toBe(true);

        scheduler.releaseAll();
        await drain;
    });

    it("does not re-dispatch a record a lost instance left mid-dispatch until the lease expires", async () => {
        expect.hasAssertions();

        const at = Date.now();
        const advanceTo = pinClock(at);

        const state = createFakeState();
        const lost = new BlockingScheduler(state, env);

        await scheduleDue(lost, 1);

        // Start the drain and abandon it — the way an eviction abandons an alarm
        // invocation whose dispatch is still open. The lanes are never released:
        // a lost instance's in-flight dispatches simply stop existing, and
        // whatever the origin is still running is beyond this DO's knowledge.
        //
        // The alarm is cleared first because that is the runtime's contract: it
        // clears an alarm BEFORE invoking the handler, so an abandoned drain
        // leaves the DO with no clock at all.
        state.alarm = null;

        const abandoned = lost.alarm();

        expect(abandoned).toBeInstanceOf(Promise);

        await settle();

        expect(lost.started).toStrictEqual(["job-0"]);

        // A successor over the SAME storage. `fetch` runs the orphan recovery.
        const successor = new BlockingScheduler(state, env);

        await successor.fetch(new Request("https://scheduler.internal/list", { method: "GET" }));

        // The abandoned drain never reached its `rescheduleAlarm()`, so this
        // instance woke with pending rows and no clock. Recovery re-derives one
        // from the lease — without it the horizon would never come due and the
        // job would be stranded, which is the shape the old orphan re-index
        // happened to mask.
        expect(state.alarm).toBe(at + DISPATCH_LEASE_MS);

        const redrain = successor.alarm();

        await settle();

        // THE DEFECT, before the lease: the successor re-armed the orphan and
        // dispatched it on sight, concurrently with the attempt still running at
        // the origin. Now it waits — the claim is still live.
        expect(successor.started).toStrictEqual([]);
        expect(indexedAt(state.storageMap, "job-0")).toBe(at + DISPATCH_LEASE_MS);

        await redrain;

        // …and the alarm is armed for the lease horizon, so the successor
        // actually wakes to re-fire rather than waiting for unrelated traffic.
        expect(state.alarm).toBe(at + DISPATCH_LEASE_MS);

        // At expiry the record fires again. At-least-once is preserved: an
        // instance genuinely lost mid-dispatch costs the job the lease, not the job.
        advanceTo(at + DISPATCH_LEASE_MS + 1);

        const expired = successor.alarm();

        await settle();

        expect(successor.started).toStrictEqual(["job-0"]);

        successor.releaseAll();
        await expired;

        lost.releaseAll();
    });

    it("clears the lease when a dispatch succeeds, so a successor fires nothing", async () => {
        expect.hasAssertions();

        const at = Date.now();

        pinClock(at);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1);

        const drain = scheduler.alarm();

        await settle();
        scheduler.release("job-0", true);
        await drain;

        // Nothing is left: no header, no lease entry, no alarm pinned at the horizon.
        expect(state.storageMap.has("id:job-0")).toBe(false);
        expect(isIndexed(state.storageMap, "job-0")).toBe(false);
        expect(state.alarm).toBeNull();

        const successor = new BlockingScheduler(state, env);

        await successor.fetch(new Request("https://scheduler.internal/list", { method: "GET" }));
        await successor.alarm();

        expect(successor.started).toStrictEqual([]);
    });

    it("drops the lease when a dispatch fails, so the retry backoff is what re-arms the job", async () => {
        expect.hasAssertions();

        const at = Date.now();

        pinClock(at);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1);

        const drain = scheduler.alarm();

        await settle();
        // A non-2xx kick. The instance SURVIVED, so nothing is in flight and the
        // lease must not outlive the attempt — otherwise every failed job would
        // carry a second, 15-minute-out index entry and fire twice.
        scheduler.release("job-0", false);
        await drain;

        const armedAt = indexedAt(state.storageMap, "job-0");

        expect(armedAt).toBeDefined();
        expect(armedAt).toBeLessThan(at + DISPATCH_LEASE_MS);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("t:") && key.endsWith(":job-0"))).toHaveLength(1);
        expect(state.storageMap.has("retry:job-0")).toBe(true);
    });

    it("re-fires a leased record only once when several lanes were claimed at once", async () => {
        expect.hasAssertions();

        const at = Date.now();
        const advanceTo = pinClock(at);

        const state = createFakeState();
        const lost = new BlockingScheduler(state, env);

        await scheduleDue(lost, 3);

        const abandoned = lost.alarm();

        expect(abandoned).toBeInstanceOf(Promise);

        await settle();

        expect(lost.started).toStrictEqual(["job-0", "job-1", "job-2"]);

        // Every claimed record carries exactly one lease entry — a drain that
        // orphaned three records must not leave six index rows behind.
        const leaseKeys = [...state.storageMap.keys()].filter((key) => key.startsWith("t:"));

        expect(leaseKeys).toHaveLength(3);

        const successor = new BlockingScheduler(state, env);

        await successor.fetch(new Request("https://scheduler.internal/list", { method: "GET" }));

        advanceTo(at + DISPATCH_LEASE_MS + 1);

        const redrain = successor.alarm();

        await settle();

        expect(successor.started).toStrictEqual(["job-0", "job-1", "job-2"]);

        successor.releaseAll();
        await redrain;

        lost.releaseAll();
    });

    it("cleans up a lease entry whose record already completed instead of re-firing it", async () => {
        expect.hasAssertions();

        const at = Date.now();
        const advanceTo = pinClock(at);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1);

        const drain = scheduler.alarm();

        await settle();

        const leaseKey = [...state.storageMap.keys()].find((key) => key.startsWith("t:") && key.endsWith(":job-0"));

        expect(leaseKey).toBeDefined();

        scheduler.release("job-0", true);
        await drain;

        // Re-assert the lease row the way a swallowed post-success delete would
        // leave it: an index entry whose `id:` header is long gone.
        await state.storage.put(leaseKey as string, "job-0");
        advanceTo(at + DISPATCH_LEASE_MS + 1);

        await scheduler.alarm();

        // The dangling-index reconciliation drops it. A lease is a claim on a
        // record, so a lease without a record is garbage, not a job.
        expect(scheduler.started).toStrictEqual(["job-0"]);
        expect(isIndexed(state.storageMap, "job-0")).toBe(false);
    });

    it("does not resurrect a record the drain already parked in the dead-letter", async () => {
        expect.hasAssertions();

        const at = Date.now();
        const advanceTo = pinClock(at);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        // One attempt, then one retry, then the park.
        await scheduleDue(scheduler, 1, { retry: { baseMs: 1, maxAttempts: 1 } });

        for (let round = 0; round < 2; round += 1) {
            advanceTo(at + round);

            const drain = scheduler.alarm();

            // eslint-disable-next-line no-await-in-loop -- each round must dispatch and settle before the next alarm
            await settle();
            scheduler.release("job-0", false);
            // eslint-disable-next-line no-await-in-loop -- see above
            await drain;
        }

        expect(state.storageMap.has("dead:job-0")).toBe(true);
        // No lease survives the park: a terminal record must not carry an index
        // entry that would fire it again at the horizon.
        expect(isIndexed(state.storageMap, "job-0")).toBe(false);

        advanceTo(at + DISPATCH_LEASE_MS + 1);

        const successor = new BlockingScheduler(state, env);

        await successor.fetch(new Request("https://scheduler.internal/list", { method: "GET" }));
        await successor.alarm();

        expect(successor.started).toStrictEqual([]);
    });

    it("releases a pooled job's slot on completion even though its claim was leased", async () => {
        expect.hasAssertions();

        const at = Date.now();

        pinClock(at);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1, { maxConcurrency: 1, pool: "p" });

        const drain = scheduler.alarm();

        await settle();
        scheduler.release("job-0", true);
        await drain;

        expect(state.storageMap.get("pool:p")).toMatchObject({ inFlight: 1 });

        await scheduler.fetch(post("/complete", { id: "job-0", pool: "p" }));

        expect(state.storageMap.get("pool:p")).toMatchObject({ inFlight: 0 });
        expect(isIndexed(state.storageMap, "job-0")).toBe(false);
    });
});
