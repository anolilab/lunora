import type { ScheduledJob, Scheduler } from "@lunora/server";

/** A pending job entry in the fake scheduler queue. */
interface FakeScheduledJob extends ScheduledJob {
    /** The args the job was scheduled with. */
    args: Record<string, unknown>;
}

/**
 * A single scheduled-job failure captured during an `advance()` / `runPending()`
 * sweep. Production's scheduler isolates per-job failures (one bad job does not
 * abort the rest), so the fake scheduler does the same — but, being a test
 * harness, it never swallows the error: every failure is recorded here so tests
 * can still assert on it.
 */
interface ScheduledJobFailure {
    /** The args the job was dispatched with. */
    args: Record<string, unknown>;
    /** The error the job's handler threw (or that dispatch produced). */
    error: unknown;
    /** The function path the job targeted (e.g. `"messages:send"`). */
    functionPath: string;
    /** The id of the job that failed. */
    id: string;
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
     * Per-job failures are isolated (matching production): a job that throws does
     * NOT prevent the remaining due jobs from running. After every due job has
     * run, the failures are surfaced — they are recorded on
     * {@link FakeSchedulerControls.failures} and, by default, re-thrown so a test
     * still sees the error. A single failure is re-thrown verbatim; multiple
     * failures are aggregated into an `AggregateError`. Pass
     * `{ throwOnError: false }` to suppress the re-throw and inspect
     * {@link FakeSchedulerControls.failures} (and the returned count) instead.
     *
     * Returns the number of jobs that were executed (including failed ones).
     */
    advance: (ms: number, options?: SweepOptions) => Promise<number>;

    /**
     * All scheduled-job failures captured so far, in execution order, across
     * every `advance()` / `runPending()` call on this harness. Always available,
     * even when `throwOnError: false` suppressed the re-throw. The list is a
     * snapshot — mutating it does not affect the scheduler.
     */
    failures: () => ScheduledJobFailure[];

    /**
     * List all pending jobs (those not yet executed or cancelled) in the order
     * they were enqueued.
     */
    list: () => FakeScheduledJob[];

    /**
     * Execute all currently pending jobs regardless of their `scheduledFor`
     * time. Equivalent to advancing to `Infinity`. Returns the number of jobs
     * executed (including failed ones).
     *
     * Failure isolation and surfacing match {@link FakeSchedulerControls.advance}:
     * one failing job does not abort the rest, and failures are recorded on
     * {@link FakeSchedulerControls.failures} and re-thrown unless
     * `{ throwOnError: false }` is passed.
     */
    runPending: (options?: SweepOptions) => Promise<number>;
}

/** Options controlling how an `advance()` / `runPending()` sweep surfaces failures. */
interface SweepOptions {
    /**
     * When `true` (the default), failures encountered during the sweep are
     * re-thrown after every due job has run — a single failure verbatim, multiple
     * as an `AggregateError`. When `false`, the sweep resolves normally and
     * failures are observable only via {@link FakeSchedulerControls.failures}.
     */
    throwOnError?: boolean;
}

/**
 * Top-level dispatch for a scheduled job — wired by the harness. Unlike the
 * `runInternal` closure used by `ctx.run*` composition (which rides whatever
 * transaction span is already open), a scheduled job is a fresh top-level entry:
 * production dispatches it back to the Worker as its own RPC, so a scheduled
 * `mutation` runs inside its own BEGIN/COMMIT span and notifies subscription
 * listeners on success. The harness supplies a callback that reproduces those
 * semantics (mutations wrapped + notified; actions run unwrapped).
 */
type ScheduledDispatch = (kind: "action" | "mutation", reference: unknown, context: unknown, args: unknown) => Promise<unknown>;

/**
 * Create a fake in-memory `Scheduler` implementation for use in
 * `lunoraTest`. The virtual clock is isolated to this instance, so
 * multiple harnesses cannot interfere with each other.
 *
 * The `ctx.scheduler` value returned as part of the pair is wired onto
 * `mutationContext` and `actionContext`. The controls half is exposed as
 * `harness.scheduler`.
 *
 * Jobs hit real handlers and share the same in-memory SQLite database. A
 * scheduled `mutation` runs through the harness's top-level mutation dispatch —
 * the same BEGIN/COMMIT span + subscription notification a `t.mutation(...)`
 * call gets — so a mid-batch throw rolls back exactly as production does.
 *
 * The dispatch callback and per-context objects are only available after the
 * harness is fully constructed. Because `createFakeScheduler` is called once at
 * construction time, we take thunks so the references are resolved lazily at
 * dispatch time.
 */
const createFakeScheduler = (
    getDispatch: () => ScheduledDispatch,
    getMutationContext: () => unknown,
    getActionContext: () => unknown,
    getFunctionRegistry: () => Map<string, { handler: unknown; kind: string }>,
    now: number,
): { controls: FakeSchedulerControls; scheduler: Scheduler } => {
    // Seed the virtual clock from the harness's `now` (which honours
    // `options.now`) so `ctx.scheduler.runAt(ctx.now + delay, …)` schedules
    // relative to the same instant `ctx.now` reports. Seeding from `Date.now()`
    // here would desync the two and fire (or strand) delayed jobs.
    let nowMs = now;
    let nextId = 1;

    /** All pending (not yet executed or cancelled) jobs, in enqueue order. */
    const pending = new Map<string, FakeScheduledJob>();

    /** Every captured job failure, in execution order, across all sweeps. */
    const recordedFailures: ScheduledJobFailure[] = [];

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

    // A schedule target is a function-path string or a generated workflow/agent
    // ref (`workflows.<name>` / `agents.<name>`); reduce it to the string key the
    // fake registry dispatches on. A string passes through unchanged, so existing
    // function-scheduling tests are untouched.
    const targetPath = (target: Parameters<Scheduler["runAfter"]>[1]): string => (typeof target === "string" ? target : (target.name ?? target.binding ?? ""));

    const scheduler: Scheduler = {
        cancel: (id: string) => {
            const existed = pending.has(id);

            pending.delete(id);

            return Promise.resolve({ cancelled: existed });
        },

        // eslint-disable-next-line unicorn/no-null -- Scheduler.get returns null when absent (public API contract)
        get: (id: string) => Promise.resolve(pending.get(id) ?? null),

        list: () => Promise.resolve([...pending.values()]),

        runAfter: (delayMs: number, target: Parameters<Scheduler["runAfter"]>[1], args?: Record<string, unknown>) => {
            const id = enqueue(nowMs + delayMs, targetPath(target), args);

            return Promise.resolve(id);
        },

        runAt: (timestampMs: number, target: Parameters<Scheduler["runAt"]>[1], args?: Record<string, unknown>) => {
            const id = enqueue(timestampMs, targetPath(target), args);

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
            const dispatch = getDispatch();
            const context = entry.kind === "action" ? getActionContext() : getMutationContext();

            await dispatch(entry.kind, entry, context, job.args);
        } else {
            // eslint-disable-next-line no-console -- deliberate test-time warning
            console.warn(
                `[fake-scheduler] functionPath "${job.functionPath}" is a ${entry.kind} — only mutations and actions can be scheduled; job ${job.id} dropped`,
            );
        }
    };

    /**
     * Execute all jobs whose `scheduledFor` is at or before `cutoff`, in scheduled order.
     * Returns the count of jobs dispatched (including any that failed).
     *
     * Per-job failures are isolated — a throwing job is recorded on
     * `recordedFailures` and the sweep continues to the remaining jobs (matching
     * production, which routes a failed dispatch to retry rather than aborting the
     * drain). Captured failures are then surfaced by `runSweep` below.
     *
     * Jobs run sequentially (each job may itself enqueue new jobs, but those
     * are not included in the current sweep — the due list is snapshotted before
     * the first dispatch).
     */
    const executeDue = async (cutoff: number): Promise<{ executed: number; failed: ScheduledJobFailure[] }> => {
        // Snapshot due jobs before executing (avoids processing newly-scheduled
        // jobs that the executed handlers enqueue during this same sweep).
        const due = [...pending.values()].filter((j) => j.scheduledFor <= cutoff).toSorted((a, b) => a.scheduledFor - b.scheduledFor);

        const failed: ScheduledJobFailure[] = [];
        let executed = 0;

        // Sequential dispatch: jobs must run in order as each may mutate shared state.
        for (const job of due) {
            // A job earlier in this same sweep may have cancelled this one
            // (`ctx.scheduler.cancel(id)`). Honour that: `cancel` reported
            // `{ cancelled: true }`, so the handler must not still run — and a
            // skipped job is not counted as executed.
            if (!pending.has(job.id)) {
                continue;
            }

            executed += 1;

            try {
                // eslint-disable-next-line no-await-in-loop -- intentional sequential dispatch; jobs must run in order and may mutate shared state
                await dispatchJob(job);
            } catch (error) {
                // Isolate the failure (prod does not abort the rest of the drain),
                // but never swallow it: record so the sweep can surface it.
                const failure: ScheduledJobFailure = { args: job.args, error, functionPath: job.functionPath, id: job.id };

                failed.push(failure);
                recordedFailures.push(failure);
            }
        }

        return { executed, failed };
    };

    /**
     * Run a sweep up to `cutoff`, then surface any captured failures. With
     * `throwOnError` (the default) a single failure is re-thrown verbatim and
     * multiple are aggregated into an `AggregateError`; otherwise the sweep
     * resolves normally and failures remain observable via `controls.failures()`.
     */
    const runSweep = async (cutoff: number, options?: SweepOptions): Promise<number> => {
        const { executed, failed } = await executeDue(cutoff);

        if (failed.length > 0 && (options?.throwOnError ?? true)) {
            const [first] = failed;

            if (failed.length === 1 && first !== undefined) {
                // Re-throw the original error verbatim so existing `rejects.toThrow(...)`
                // assertions on a single scheduled failure keep working.
                throw first.error;
            }

            throw new AggregateError(
                failed.map((f) => f.error),
                `${String(failed.length)} scheduled jobs failed: ${failed.map((f) => f.functionPath).join(", ")}`,
            );
        }

        return executed;
    };

    const controls: FakeSchedulerControls = {
        advance: (ms: number, options?: SweepOptions) => {
            nowMs += ms;

            return runSweep(nowMs, options);
        },

        failures: () => [...recordedFailures],

        list: () => [...pending.values()],

        runPending: (options?: SweepOptions) => runSweep(Number.POSITIVE_INFINITY, options),
    };

    return { controls, scheduler };
};

export { createFakeScheduler };
export type { FakeScheduledJob, FakeSchedulerControls, ScheduledJobFailure, SweepOptions };
