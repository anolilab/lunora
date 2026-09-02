/**
 * `withDeferredSchedules` / `beginDeferredSchedules` — the buffer that makes
 * `ctx.scheduler.runAfter(0, …)` behave like the `afterCommit` hook the docs
 * describe.
 *
 * The unit under test is ordering: a job must reach the scheduler strictly after
 * the commit, never before, and never at all when the span rolled back. The
 * harness suite (`@lunora/testing`) pins the same guarantees end to end; this
 * suite pins the ordering itself, which a row count cannot see.
 */
import { describe, expect, it } from "vitest";

import { beginDeferredSchedules, withDeferredSchedules } from "../src/index";

interface RecordedCall {
    id?: string;
    target: string;
    when: number;
}

/** A scheduler that records the calls it receives, in the order it receives them. */
const recordingScheduler = (
    log: string[],
): { calls: RecordedCall[]; scheduler: { cancel: (id: string) => Promise<unknown>; runAfter: unknown; runAt: unknown } } => {
    const calls: RecordedCall[] = [];
    let next = 0;

    const record = (when: number, target: string, _args: unknown, options?: { id?: string }): Promise<string> => {
        next += 1;

        const id = options?.id ?? `minted-${String(next)}`;

        calls.push({ id: options?.id, target, when });
        log.push(`schedule:${target}`);

        return Promise.resolve(id);
    };

    return {
        calls,
        scheduler: {
            cancel: (id: string) => Promise.resolve({ cancelled: true, id }),
            runAfter: record,
            runAt: record,
        },
    };
};

type DeferrableScheduler = {
    cancel: (id: string) => Promise<unknown>;
    runAfter: (delayMs: number, target: string, args?: unknown) => Promise<string>;
    runAt: (timestampMs: number, target: string, args?: unknown) => Promise<string>;
};

describe("withDeferredSchedules", () => {
    it("passes calls straight through when no window is open", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler) as DeferrableScheduler;

        await facade.runAfter(0, "mail:send");

        // An action has no transaction to wait for, so its schedules are immediate.
        expect(calls).toHaveLength(1);
        expect(calls[0]?.id).toBeUndefined();
    });

    it("holds a call until the window settles, then dispatches it after the commit", async () => {
        expect.assertions(3);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler) as DeferrableScheduler;
        const settle = beginDeferredSchedules({ scheduler: facade });

        await facade.runAfter(0, "mail:send");

        expect(calls).toHaveLength(0);

        log.push("COMMIT");
        await settle(true);

        expect(calls).toHaveLength(1);
        // The ordering IS the guarantee: with a zero delay the job can otherwise
        // dispatch while the transaction is still open.
        expect(log).toStrictEqual(["COMMIT", "schedule:mail:send"]);
    });

    it("drops every buffered call when the window settles as rolled back", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler) as DeferrableScheduler;
        const settle = beginDeferredSchedules({ scheduler: facade });

        await facade.runAfter(0, "mail:send");
        await facade.runAt(1000, "mail:digest");
        await settle(false);

        expect(calls).toHaveLength(0);

        // Drained, not merely skipped: a later window must not resurrect them.
        const second = beginDeferredSchedules({ scheduler: facade });

        await second(true);

        expect(calls).toHaveLength(0);
    });

    it("hands the caller the id the job is finally stored under", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler) as DeferrableScheduler;
        const settle = beginDeferredSchedules({ scheduler: facade });

        // A handler routinely stores this on the row it just wrote so it can
        // `cancel` later, so it has to be the real id and it has to be synchronous.
        const id = await facade.runAfter(0, "mail:send");

        await settle(true);

        expect(id).toMatch(/\S/u);
        expect(calls[0]?.id).toBe(id);
    });

    it("preserves declaration order across the flush", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const { scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler) as DeferrableScheduler;
        const settle = beginDeferredSchedules({ scheduler: facade });

        await facade.runAfter(0, "a");
        await facade.runAfter(0, "b");
        await facade.runAfter(0, "c");
        await settle(true);

        expect(log).toStrictEqual(["schedule:a", "schedule:b", "schedule:c"]);
    });

    it("lets only the outermost window settle, so a nested runMutation rides the enclosing commit", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler) as DeferrableScheduler;
        const outer = beginDeferredSchedules({ scheduler: facade });
        const inner = beginDeferredSchedules({ scheduler: facade });

        await facade.runAfter(0, "inner:job");
        await inner(true);

        // SQLite-in-DO has no savepoints: the inner dispatch shares the outer
        // BEGIN/COMMIT span, so it cannot commit — and must not schedule — alone.
        expect(calls).toHaveLength(0);

        await outer(true);

        expect(calls).toHaveLength(1);
    });

    it("rejects a negative delay at the call site rather than at the flush", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler) as DeferrableScheduler;
        const settle = beginDeferredSchedules({ scheduler: facade });

        // Buffered, the underlying guard would not fire until after the commit —
        // turning a caller's bad argument into a failure on a write that succeeded.
        expect(() => facade.runAfter(-1, "mail:send")).toThrow("non-negative finite number");

        await settle(true);

        expect(calls).toHaveLength(0);
    });

    it("keeps the rest of the scheduler surface reachable", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const { scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler) as DeferrableScheduler;

        await expect(facade.cancel("job-1")).resolves.toStrictEqual({ cancelled: true, id: "job-1" });
    });

    it("is inert for a context whose scheduler was never wrapped", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const settle = beginDeferredSchedules({ scheduler });

        await (scheduler.runAfter as (delayMs: number, target: string) => Promise<string>)(0, "mail:send");
        await settle(true);

        // A query ctx (or an admin dispatch) gets the bare scheduler; the settle a
        // caller holds must be a no-op rather than a crash.
        expect(calls).toHaveLength(1);
    });
});
