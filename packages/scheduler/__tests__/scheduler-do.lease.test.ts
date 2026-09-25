/**
 * The dispatch claim is a LEASE, not a deletion.
 *
 * `drainRecordGuarded` claims a due record before `dispatch()`'s outbound
 * fetch. When that claim simply deleted the `t:` index entry, an instance lost
 * mid-dispatch left an `id:` header with no index — and the successor's
 * `reindexOrphanedRecords` re-armed it and dispatched it again IMMEDIATELY,
 * while the first attempt may still have been running at the origin. For a
 * mutation or workflow target the receiver's dedup absorbed that; for an ACTION
 * it did not, because `@lunora/do` writes the dedup row only after the handler
 * returns (and deliberately takes no single-writer gate for a non-mutation), so
 * a long action re-fired mid-flight ran a second time CONCURRENTLY with the
 * first. (The receiver now declines such a delivery outright — see
 * `packages/do/__tests__/shard-do.dispatch-claim.test.ts` — but the lease is still what keeps
 * the two from being minted in the first place, which is what this file pins.)
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
import { BlockingScheduler, indexedAt, indexKeysFor, isIndexed, post, scheduleDue, settle } from "./blocking-scheduler";
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

/**
 * Claiming a record that is ALREADY leased — the expiry path.
 *
 * A lease moves a record's `t:` entry without touching the `scheduledFor` on its
 * header, so from the second claim onward the two disagree: the live key carries
 * the lease time, the header still carries the original due time. A claim that
 * reconstructs its key from `record.scheduledFor` therefore deletes a key that no
 * longer exists and ADDS a second one — leaving the record indexed twice and
 * dispatched twice, which is the exact double-run the lease exists to close.
 *
 * Every assertion here COUNTS index entries. Asking whether the record has "an"
 * entry is satisfied by two, which is why the original lease suite went green
 * while the expiry path double-indexed.
 */
describe("schedulerDO dispatch lease — claiming an already-leased record", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    /**
     * Take a lease on `job-0`, then abandon the drain so the record is left
     * claimed by an instance that never comes back — the state whose recovery is
     * this block's subject. Returns fresh storage plus a successor over it,
     * already past its orphan recovery.
     */
    const leaseThenLoseInstance = async (
        extra: Record<string, unknown> = {},
    ): Promise<{ state: ReturnType<typeof createFakeState>; successor: BlockingScheduler }> => {
        const state = createFakeState();
        const lost = new BlockingScheduler(state, env);

        await scheduleDue(lost, 1, extra);

        // The runtime clears an alarm before invoking the handler, so an
        // abandoned drain leaves the DO with no clock.
        state.alarm = null;

        // Deliberately never awaited and never released: a lost instance's
        // in-flight dispatches simply stop existing.
        const abandoned = lost.alarm();

        expect(abandoned).toBeInstanceOf(Promise);

        await settle();

        expect(lost.started).toStrictEqual(["job-0"]);
        expect(indexKeysFor(state.storageMap, "job-0")).toHaveLength(1);

        const successor = new BlockingScheduler(state, env);

        await successor.fetch(new Request("https://scheduler.internal/list", { method: "GET" }));

        return { state, successor };
    };

    it("re-claims an expired lease at the key it is actually indexed under", async () => {
        expect.hasAssertions();

        const at = Date.now();
        const advanceTo = pinClock(at);
        const { state, successor } = await leaseThenLoseInstance();

        advanceTo(at + DISPATCH_LEASE_MS + 1);

        const redrain = successor.alarm();

        await settle();

        expect(successor.started).toStrictEqual(["job-0"]);
        // THE DEFECT: the second claim reconstructed its key from the header's
        // untouched `scheduledFor`, so the delete was a no-op and the new lease
        // was a SECOND entry. One record, two index rows, two future dispatches.
        expect(indexKeysFor(state.storageMap, "job-0")).toHaveLength(1);

        successor.releaseAll();
        await redrain;
    });

    it("dispatches a re-leased record once across the expiry boundary, not once per stale key", async () => {
        expect.hasAssertions();

        const at = Date.now();
        const advanceTo = pinClock(at);
        // A 1 ms backoff so the retry lands next to the stale lease key and both
        // come due in the SAME later alarm — which is what turns two index rows
        // into two concurrent dispatches of one record.
        const { state, successor } = await leaseThenLoseInstance({ retry: { baseMs: 1 } });

        advanceTo(at + DISPATCH_LEASE_MS + 1);

        const redrain = successor.alarm();

        await settle();
        // Fail the kick so the record is re-armed for retry and KEEPS its header
        // — a record that dispatches cleanly deletes its header and hides the
        // stale key as a harmless dangling row.
        successor.release("job-0", false);
        await redrain;

        expect(indexKeysFor(state.storageMap, "job-0")).toHaveLength(1);
        expect(state.storageMap.has("id:job-0")).toBe(true);

        advanceTo(at + DISPATCH_LEASE_MS + 10);

        const retryDrain = successor.alarm();

        await settle();

        // One dispatch for the retry, not one per index row.
        expect(successor.started).toStrictEqual(["job-0", "job-0"]);

        successor.releaseAll();
        await retryDrain;
    });

    it("re-claims an expired lease exactly once when the pool declines the job", async () => {
        expect.hasAssertions();

        const at = Date.now();
        const advanceTo = pinClock(at);
        const { state, successor } = await leaseThenLoseInstance({ maxConcurrency: 1, pool: "p" });

        // The lost instance's reservation is still held — nothing released it —
        // so the re-claim meets a saturated pool and is re-armed as backpressure
        // without dispatching. The stale lease key must not survive that either.
        advanceTo(at + DISPATCH_LEASE_MS + 1);

        await successor.alarm();

        expect(successor.started).toStrictEqual([]);
        expect(indexKeysFor(state.storageMap, "job-0")).toHaveLength(1);
        expect(state.storageMap.has("id:job-0")).toBe(true);
    });

    it("drains a record carrying two due index entries once, and reconciles the extra away", async () => {
        expect.hasAssertions();

        const at = Date.now();

        pinClock(at);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1);

        // Seed the residue directly: a second due entry for the same record, of
        // the kind a swallowed post-settle lease delete leaves behind. One
        // record is one job however many rows point at it — draining both would
        // hand two lanes the same record and dispatch it twice.
        await state.storage.put(`t:${String(at - 500).padStart(15, "0")}:job-0`, "job-0");

        expect(indexKeysFor(state.storageMap, "job-0")).toHaveLength(2);

        const drain = scheduler.alarm();

        await settle();

        expect(scheduler.started).toStrictEqual(["job-0"]);

        scheduler.releaseAll();
        await drain;

        expect(indexKeysFor(state.storageMap, "job-0")).toStrictEqual([]);
    });

    it("clears a leased record's index entry when it is cancelled mid-dispatch", async () => {
        expect.hasAssertions();

        const at = Date.now();

        pinClock(at);

        const state = createFakeState();
        const scheduler = new BlockingScheduler(state, env);

        await scheduleDue(scheduler, 1);

        const drain = scheduler.alarm();

        await settle();

        expect(indexKeysFor(state.storageMap, "job-0")).toHaveLength(1);

        // Cancel WHILE the dispatch is open. The header still exists (it is
        // deleted only once the kick returns), so the cancel takes effect — and
        // it must take the live lease key with it, not the one it can derive
        // from the record's untouched `scheduledFor`.
        const cancelled = await scheduler.fetch(post("/cancel", { id: "job-0" }));

        expect(cancelled.status).toBe(200);
        expect(state.storageMap.has("id:job-0")).toBe(false);
        expect(indexKeysFor(state.storageMap, "job-0")).toStrictEqual([]);

        scheduler.releaseAll();
        await drain;
    });
});
