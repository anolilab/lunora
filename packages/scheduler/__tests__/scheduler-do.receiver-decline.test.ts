/**
 * What the scheduler does with a receiver that DECLINES a re-delivery (#803).
 *
 * `scheduler-do.lease.test.ts` covers the dispatcher's half: a claimed record is
 * leased rather than unindexed, so a successor does not re-fire it on sight.
 * The residual that lease cannot bound is a receiver still executing after the
 * dispatcher's side of the fetch is gone — `@lunora/do` now answers that at the
 * shard, with a `409 DISPATCH_IN_PROGRESS` instead of a second concurrent run.
 *
 * This file drives the REAL `dispatch()` (a stubbed `globalThis.fetch`, the way
 * the "real dispatch() fetch contract" suite does) through the whole race —
 * abandon a drain, build a successor over the same storage, let the lease lapse,
 * re-dispatch — and pins what the decline does to the record.
 *
 * **The seam, stated rather than smoothed over.** `@lunora/scheduler` does not
 * depend on `@lunora/do`, so the receiver here is a stub: it answers the way the
 * shard answers, it is not the shard. That the shard actually produces the 409
 * — and actually refuses to run the handler twice — is proven in
 * `packages/do/__tests__/shard-do.dispatch-claim.test.ts` and, on a real Durable
 * Object, `packages/do/__tests__/workerd/shard-do-dispatch-claim.workerd.test.ts`.
 * What is proven HERE is the other half: that a decline leaves the job
 * re-fireable instead of clearing it, which is the difference between
 * at-least-once and at-most-once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DISPATCH_LEASE_MS, SchedulerDO } from "../src/scheduler-do";
import { indexKeysFor, post, settle } from "./blocking-scheduler";
import { createFakeState } from "./fake-state";

const env = { LUNORA_ORIGIN_URL: "https://app.test" };

/** Pin `Date.now()` so lease arithmetic is exact. `setTimeout` is left real, so `settle()` still works. */
const pinClock = (at: number): ((to: number) => void) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(at);

    return (to: number) => {
        now.mockReturnValue(to);
    };
};

/**
 * A receiver that models the shard's in-flight claim: the first delivery of an
 * id parks (its dispatcher dies holding it open), and a second delivery of the
 * SAME id while the first is still running is declined with the shard's
 * `409 DISPATCH_IN_PROGRESS`. Once the first attempt settles, the same id is
 * served from the replay cache — a 2xx.
 */
const stubReceiver = (): { calls: string[]; finishFirstAttempt: () => void; restore: () => void } => {
    const calls: string[] = [];
    const inFlight = new Set<string>();
    const settled = new Set<string>();
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        // `SchedulerDO.dispatch` always sends a JSON string body (see its
        // `JSON.stringify`), so this is the real payload, not a coerced object.
        const { id } = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { id: string };

        calls.push(id);

        if (settled.has(id)) {
            // The replay cache answers: the handler is not re-run.
            return Response.json({ result: undefined }, { status: 200 });
        }

        if (inFlight.has(id)) {
            return Response.json({ error: { code: "DISPATCH_IN_PROGRESS", message: "already running" } }, { status: 409 });
        }

        inFlight.add(id);

        // Never resolves: this dispatcher is the one that dies mid-fetch.
        return new Promise<Response>(() => {});
    });

    return {
        calls,
        finishFirstAttempt: () => {
            for (const id of inFlight) {
                settled.add(id);
            }

            inFlight.clear();
        },
        restore: () => {
            spy.mockRestore();
        },
    };
};

const scheduleDueJob = async (scheduler: SchedulerDO, at: number): Promise<void> => {
    await scheduler.fetch(post("/schedule", { args: {}, functionPath: "jobs.slow", id: "job-0", scheduledFor: at - 1000 }));
};

describe("schedulerDO — a receiver that declines a re-delivery", () => {
    let receiver: ReturnType<typeof stubReceiver> | undefined;

    afterEach(() => {
        receiver?.restore();
        receiver = undefined;
        vi.restoreAllMocks();
    });

    it("keeps the record re-fireable when the shard declines: no clear, no dead-letter, one index entry", async () => {
        expect.hasAssertions();

        const at = Date.now();
        const advanceTo = pinClock(at);

        receiver = stubReceiver();

        const state = createFakeState();
        const lost = new SchedulerDO(state, env);

        await scheduleDueJob(lost, at);

        // Abandon the drain mid-dispatch, the way an eviction abandons an alarm
        // invocation whose fetch is still open. The runtime clears the alarm
        // BEFORE invoking the handler, so the abandoned instance leaves no clock.
        state.alarm = null;
        // Deliberately unawaited: this drain is abandoned mid-dispatch.
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- the abandoned drain is the fixture; awaiting it would hang the test
        lost.alarm();
        await settle();

        expect(receiver.calls).toStrictEqual(["job-0"]);

        // The successor, over the SAME storage, once the lease has lapsed. Its
        // first attempt is STILL running at the origin — which is exactly what
        // no lease length can see.
        const successor = new SchedulerDO(state, env);

        advanceTo(at + DISPATCH_LEASE_MS + 1);
        await successor.alarm();

        // COUNT, not presence: two deliveries reached the receiver, and the
        // second was declined rather than run alongside the first.
        expect(receiver.calls).toStrictEqual(["job-0", "job-0"]);

        // NOT at-most-once. A 2xx would have `drainRecord` delete the header and
        // the job would be gone for good if the first attempt then died.
        expect(state.storageMap.has("id:job-0")).toBe(true);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("dead:"))).toStrictEqual([]);

        // Re-armed on the ordinary retry ladder, with EXACTLY one index entry —
        // two would fire the job twice, which is the defect the lease closed.
        expect(indexKeysFor(state.storageMap, "job-0")).toHaveLength(1);
        expect(state.storageMap.has("retry:job-0")).toBe(true);
    });

    it("clears the record once the first attempt has settled and its result is replayed", async () => {
        expect.hasAssertions();

        const at = Date.now();
        const advanceTo = pinClock(at);

        receiver = stubReceiver();

        const state = createFakeState();
        const lost = new SchedulerDO(state, env);

        await scheduleDueJob(lost, at);

        state.alarm = null;
        // Deliberately unawaited: this drain is abandoned mid-dispatch.
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- the abandoned drain is the fixture; awaiting it would hang the test
        lost.alarm();
        await settle();

        const successor = new SchedulerDO(state, env);

        advanceTo(at + DISPATCH_LEASE_MS + 1);
        await successor.alarm();

        // The first attempt finishes at the origin and writes its dedup row, so
        // the next delivery of the same id is served that result.
        receiver.finishFirstAttempt();

        // Far enough forward for the retry backoff to be due.
        advanceTo(at + DISPATCH_LEASE_MS + 60_000);
        await successor.alarm();

        expect(receiver.calls).toStrictEqual(["job-0", "job-0", "job-0"]);

        // Dispatched (2xx): the record is cleared and nothing is left indexed.
        expect(state.storageMap.has("id:job-0")).toBe(false);
        expect(indexKeysFor(state.storageMap, "job-0")).toStrictEqual([]);
        expect([...state.storageMap.keys()].filter((key) => key.startsWith("dead:"))).toStrictEqual([]);
    });
});
