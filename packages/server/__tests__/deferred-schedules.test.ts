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
import { describe, expect, expectTypeOf, it } from "vitest";

import { beginDeferredSchedules, withDeferredSchedules } from "../src/index";

interface RecordedCall {
    id?: string;
    target: string;
    when: number;
}

/** The signature `runAfter`/`runAt` share here; the 4th parameter is `RunOptions`, of which only `id` matters to this fake. */
type RecordCall = (when: number, target: string, args?: unknown, options?: { id?: string }) => Promise<string>;

/** A scheduler that records the calls it receives, in the order it receives them. */
const recordingScheduler = (
    log: string[],
): { calls: RecordedCall[]; scheduler: { cancel: (id: string) => Promise<unknown>; runAfter: RecordCall; runAt: RecordCall } } => {
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

/** The same recording scheduler, with the named targets refused the way an unreachable SchedulerDO refuses them. */
const rejecting = <S extends { runAfter: RecordCall }>(scheduler: S, refuse: ReadonlyArray<string>): S => {
    return {
        ...scheduler,
        runAfter: async (when: number, target: string, args?: unknown, options?: { id?: string }): Promise<string> => {
            if (refuse.includes(target)) {
                throw new Error(`unreachable: ${target}`);
            }

            return await scheduler.runAfter(when, target, args, options);
        },
    };
};

describe("withDeferredSchedules — types", () => {
    it("hands back the scheduler type it was given", () => {
        expect.assertions(1);

        const scheduler = {
            cancel: (id: string): Promise<{ cancelled: boolean; id: string }> => Promise.resolve({ cancelled: true, id }),
            runAfter: (_delayMs: number, _target: string): Promise<string> => Promise.resolve("job-1"),
            runAt: (_timestampMs: number, _target: string): Promise<string> => Promise.resolve("job-1"),
        };

        // `unknown` in / `unknown` out discarded the contract the docblock
        // explains and forced every caller to cast the facade back — including
        // the generated shard, where the cast is emitted as source.
        expectTypeOf(withDeferredSchedules(scheduler)).toEqualTypeOf<typeof scheduler>();
        expectTypeOf(beginDeferredSchedules({ scheduler })).toEqualTypeOf<(committed: boolean) => Promise<void>>();

        expect(withDeferredSchedules(scheduler)).toHaveProperty("runAfter");
    });

    it("accepts a scheduler whose `args` is required — the shape `createScheduler()` actually returns", () => {
        expect.assertions(1);

        // `@lunora/scheduler`'s `Scheduler.runAfter`/`runAt` take `args` as a
        // REQUIRED third parameter. `SchedulerLike` declared it optional, which
        // widens the constraint's parameter to `undefined` — not assignable to a
        // required `args` — so the one scheduler this facade exists to wrap was
        // the one scheduler it would not accept, and every real call site had to
        // cast around the guard.
        const scheduler = {
            runAfter: (_delayMs: number, _target: string, _args: Record<string, unknown>, _options?: { id?: string }): Promise<string> =>
                Promise.resolve("job-1"),
            runAt: (_timestampMs: number, _target: string, _args: Record<string, unknown>, _options?: { id?: string }): Promise<string> =>
                Promise.resolve("job-1"),
        };

        expectTypeOf(withDeferredSchedules(scheduler)).toEqualTypeOf<typeof scheduler>();

        expect(withDeferredSchedules(scheduler)).toHaveProperty("runAt");
    });
});

describe("withDeferredSchedules", () => {
    it("passes calls straight through when no window is open", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler);

        await facade.runAfter(0, "mail:send");

        // An action has no transaction to wait for, so its schedules are immediate.
        expect(calls).toHaveLength(1);
        expect(calls[0]?.id).toBeUndefined();
    });

    it("holds a call until the window settles, then dispatches it after the commit", async () => {
        expect.assertions(3);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler);
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
        const facade = withDeferredSchedules(scheduler);
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
        const facade = withDeferredSchedules(scheduler);
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
        const facade = withDeferredSchedules(scheduler);
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
        const facade = withDeferredSchedules(scheduler);
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
        const facade = withDeferredSchedules(scheduler);
        const settle = beginDeferredSchedules({ scheduler: facade });

        // Buffered, the underlying guard would not fire until after the commit —
        // turning a caller's bad argument into a failure on a write that succeeded.
        expect(() => facade.runAfter(-1, "mail:send")).toThrow("non-negative finite number");

        await settle(true);

        expect(calls).toHaveLength(0);
    });

    it("keeps a committed window's jobs when another window rolls back", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler);

        // One ctx, two transactions. An action need not await the mutation it
        // composes, so the windows opened on a shared context do not have to settle
        // in the order they opened.
        const first = beginDeferredSchedules({ scheduler: facade });

        await facade.runAfter(0, "first:job");

        const second = beginDeferredSchedules({ scheduler: facade });

        await facade.runAfter(0, "second:job");
        await first(true);
        await second(false);

        // `second` rolled back; `first` committed. A single shared buffer with a
        // depth counter answered that by discarding both.
        expect(calls.map((entry) => entry.target)).toStrictEqual(["first:job"]);
        expect(log).toStrictEqual(["schedule:first:job"]);
    });

    it("never lets a sibling's commit dispatch a rolled-back window's jobs", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler);
        const survivor = beginDeferredSchedules({ scheduler: facade });
        const doomed = beginDeferredSchedules({ scheduler: facade });

        await facade.runAfter(0, "doomed:job");
        // Rolled back while another window is open: the writes this job was to act
        // on are gone, so the job must go with them whoever settles next.
        await doomed(false);
        await survivor(true);

        expect(calls).toHaveLength(0);
    });

    it("attempts every buffered job even when the first dispatch throws", async () => {
        expect.assertions(3);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(rejecting(scheduler, ["a"]));
        const settle = beginDeferredSchedules({ scheduler: facade });

        await facade.runAfter(0, "a");
        await facade.runAfter(0, "b");
        await facade.runAfter(0, "c");

        // The flush runs AFTER the commit, so stopping at the first failure strands
        // jobs the handler was already handed ids for — and skips the post-commit
        // work behind the settle. One failure is rethrown as itself, so the DO's
        // coded refusal still decides the status and survives redaction.
        await expect(settle(true)).rejects.toThrow("unreachable: a");

        expect(calls.map((entry) => entry.target)).toStrictEqual(["b", "c"]);
        expect(log).toStrictEqual(["schedule:b", "schedule:c"]);
    });

    it("reports several failed dispatches together", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(rejecting(scheduler, ["a", "c"]));
        const settle = beginDeferredSchedules({ scheduler: facade });

        await facade.runAfter(0, "a");
        await facade.runAfter(0, "b");
        await facade.runAfter(0, "c");

        await expect(settle(true)).rejects.toThrow(AggregateError);

        expect(calls.map((entry) => entry.target)).toStrictEqual(["b"]);
    });

    it("honours a caller-supplied job id instead of replacing it", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler);
        const settle = beginDeferredSchedules({ scheduler: facade });

        // Outside a mutation the same argument reaches the SchedulerDO untouched.
        // Replacing it inside one makes the id the caller chose — and stored, and
        // deduped on — belong to no job, and hides the DO's duplicate-id refusal.
        const id = await facade.runAfter(0, "mail:send", undefined, { id: "invoice-42" });

        await settle(true);

        expect(id).toBe("invoice-42");
        expect(calls[0]?.id).toBe("invoice-42");
    });

    it("rejects a non-finite runAt instant at the call site rather than at the flush", async () => {
        expect.assertions(3);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler);
        const settle = beginDeferredSchedules({ scheduler: facade });

        // `runAfter` has always refused this; `runAt` took the same value through
        // the other door and stored a `scheduledFor` that JSON renders as `null`.
        expect(() => facade.runAt(Number.NaN, "mail:send")).toThrow("must be a non-negative finite number");
        // An instant already in the past is an OVERDUE job, not a bad argument.
        expect(() => facade.runAt(1000, "mail:digest")).not.toThrow();

        await settle(true);

        expect(calls).toHaveLength(1);
    });

    it("keeps the rest of the scheduler surface reachable", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const { scheduler } = recordingScheduler(log);
        const facade = withDeferredSchedules(scheduler);

        await expect(facade.cancel("job-1")).resolves.toStrictEqual({ cancelled: true, id: "job-1" });
    });

    it("is inert for a context whose scheduler was never wrapped", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const { calls, scheduler } = recordingScheduler(log);
        const settle = beginDeferredSchedules({ scheduler });

        await scheduler.runAfter(0, "mail:send");
        await settle(true);

        // A query ctx (or an admin dispatch) gets the bare scheduler; the settle a
        // caller holds must be a no-op rather than a crash.
        expect(calls).toHaveLength(1);
    });
});
