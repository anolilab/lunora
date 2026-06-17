import type { ScheduledJob, Scheduler } from "@lunora/server";

/** A pending job entry in the fake scheduler queue. */
interface FakeScheduledJob extends ScheduledJob {
    /** The args the job was scheduled with. */
    args: Record<string, unknown>;
}

/**
 * Controls exposed on the test harness for the fake in-memory scheduler.
 * Access via `harness.scheduler`.
 */
interface FakeSchedulerControls {
    /**
     * Advance the virtual clock by `ms` milliseconds, executing all jobs whose
     * `scheduledFor` timestamp is now at or before the new virtual "now". Jobs
     * are dispatched in `scheduledFor` order (oldest first). Newly queued jobs
     * (scheduled by an executed job during the advance) are NOT re-evaluated in
     * the same advance call — callers should advance again if needed.
     *
     * Returns the number of jobs that were executed.
     */
    advance: (ms: number) => Promise<number>;

    /**
     * List all pending jobs (those not yet executed or cancelled) in the order
     * they were enqueued.
     */
    list: () => FakeScheduledJob[];

    /**
     * Execute all currently pending jobs regardless of their `scheduledFor`
     * time. Equivalent to advancing to `Infinity`. Returns the number of jobs
     * executed.
     */
    runPending: () => Promise<number>;
}

/** Internal dispatch signature — matching the `runInternal` closure in harness.ts. */
type InternalDispatch = (kind: "action" | "mutation" | "query", reference: unknown, context: unknown, args: unknown) => Promise<unknown>;

/**
 * Create a fake in-memory `Scheduler` implementation for use in
 * `lunoraTest`. The virtual clock is isolated to this instance, so
 * multiple harnesses cannot interfere with each other.
 *
 * The `ctx.scheduler` value returned as part of the pair is wired onto
 * `mutationContext` and `actionContext`. The controls half is exposed as
 * `harness.scheduler`.
 *
 * Jobs are executed via the same `runInternal` dispatch as `ctx.runMutation`
 * / `ctx.runQuery` — so scheduled work hits real handlers and shares the same
 * in-memory SQLite database.
 *
 * `runInternal` and the per-context objects are only available
 * after the harness is fully constructed. Because `createFakeScheduler` is
 * called once at construction time, and `runInternal` is a closure that
 * references objects defined after this call, we take a `getRunInternal`
 * thunk so the reference is resolved lazily at dispatch time.
 */
const createFakeScheduler = (
    getRunInternal: () => InternalDispatch,
    getMutationContext: () => unknown,
    getFunctionRegistry: () => Map<string, { handler: unknown; kind: string }>,
): { controls: FakeSchedulerControls; scheduler: Scheduler } => {
    let nowMs = Date.now();
    let nextId = 1;

    /** All pending (not yet executed or cancelled) jobs, in enqueue order. */
    const pending = new Map<string, FakeScheduledJob>();

    const enqueue = (scheduledFor: number, functionPath: string, args: Record<string, unknown> = {}): string => {
        const id = `fake-job-${String(nextId)}`;

        nextId += 1;

        pending.set(id, {
            args,
            enqueuedAt: nowMs,
            functionPath,
            id,
            scheduledFor,
        });

        return id;
    };

    const scheduler: Scheduler = {
        cancel: (id: string) => {
            const existed = pending.has(id);

            pending.delete(id);

            return Promise.resolve({ cancelled: existed });
        },

        // eslint-disable-next-line unicorn/no-null -- Scheduler.get returns null when absent (public API contract)
        get: (id: string) => Promise.resolve(pending.get(id) ?? null),

        list: () => Promise.resolve([...pending.values()]),

        runAfter: (delayMs: number, functionPath: string, args?: Record<string, unknown>) => {
            const id = enqueue(nowMs + delayMs, functionPath, args);

            return Promise.resolve(id);
        },

        runAt: (timestampMs: number, functionPath: string, args?: Record<string, unknown>) => {
            const id = enqueue(timestampMs, functionPath, args);

            return Promise.resolve(id);
        },
    };

    /**
     * Dispatch a single job. Returns a promise that resolves when the job
     * completes (or is silently dropped for an unknown/invalid function path).
     */
    const dispatchJob = async (job: FakeScheduledJob): Promise<void> => {
        pending.delete(job.id);

        const registry = getFunctionRegistry();
        const entry = registry.get(job.functionPath);

        if (entry === undefined) {
            // Unknown function path — match prod behaviour (silently no-op rather
            // than crashing the test), but surface a warning so devs notice typos.
            // eslint-disable-next-line no-console -- deliberate test-time warning; no logger on this surface
            console.warn(`[fake-scheduler] unknown functionPath "${job.functionPath}" — job ${job.id} dropped`);

            return;
        }

        if (entry.kind === "mutation" || entry.kind === "action") {
            const runInternal = getRunInternal();
            const mutationContext = getMutationContext();

            await runInternal(entry.kind, entry, mutationContext, job.args);
        } else {
            // eslint-disable-next-line no-console -- deliberate test-time warning
            console.warn(
                `[fake-scheduler] functionPath "${job.functionPath}" is a ${entry.kind} — only mutations and actions can be scheduled; job ${job.id} dropped`,
            );
        }
    };

    /**
     * Execute all jobs whose `scheduledFor` is at or before `cutoff`, in scheduled order.
     * Returns the count of jobs dispatched.
     *
     * Jobs run sequentially (each job may itself enqueue new jobs, but those
     * are not included in the current sweep — the due list is snapshotted before
     * the first dispatch).
     */
    const executeDue = async (cutoff: number): Promise<number> => {
        // Snapshot due jobs before executing (avoids processing newly-scheduled
        // jobs that the executed handlers enqueue during this same sweep).
        const due = [...pending.values()].filter((j) => j.scheduledFor <= cutoff).toSorted((a, b) => a.scheduledFor - b.scheduledFor);

        // Sequential dispatch: jobs must run in order as each may mutate shared state.
        for (const job of due) {
            // eslint-disable-next-line no-await-in-loop -- intentional sequential dispatch; jobs must run in order and may mutate shared state
            await dispatchJob(job);
        }

        return due.length;
    };

    const controls: FakeSchedulerControls = {
        advance: async (ms: number) => {
            nowMs += ms;

            return executeDue(nowMs);
        },

        list: () => [...pending.values()],

        runPending: () => executeDue(Number.POSITIVE_INFINITY),
    };

    return { controls, scheduler };
};

export { createFakeScheduler };
export type { FakeScheduledJob, FakeSchedulerControls };
