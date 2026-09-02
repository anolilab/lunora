import { LunoraError } from "@lunora/errors";
import { assertScheduleDelay, MAX_RETRY_ATTEMPTS, RETRY_BASE_DELAY_MS } from "@lunora/scheduler";
import type { ScheduledJob, Scheduler } from "@lunora/server";

/** A pending job entry in the fake scheduler queue. */
interface FakeScheduledJob extends ScheduledJob {
    /** The args the job was scheduled with. */
    args: Record<string, unknown>;
}

/**
 * A single scheduled-job failure that exhausted its retry budget, captured
 * during an `advance()` / `runPending()` sweep. Mirrors `SchedulerDO`'s
 * dead-letter park (`recordRetry()`, `packages/scheduler/src/scheduler-do.ts:875-909`):
 * a job that fails while it still has retries left is silently re-enqueued
 * with backoff and is NOT recorded here. Only once a job's `attempts` exceeds
 * `@lunora/scheduler`'s `MAX_RETRY_ATTEMPTS` does it land here — being a test
 * harness, the fake scheduler never swallows a terminal failure, so tests can
 * still assert on it.
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
     * (scheduled by an executed job, or re-enqueued as a retry, during the
     * advance) are NOT re-evaluated in the same advance call — callers should
     * advance again if needed.
     *
     * Per-job failures are isolated (matching production): a job that throws does
     * NOT prevent the remaining due jobs from running. A failure with retries
     * left is silently re-enqueued with exponential backoff on the virtual clock
     * — mirroring `SchedulerDO`'s default retry policy (`MAX_RETRY_ATTEMPTS`
     * retries, `RETRY_BASE_DELAY_MS` base delay, doubling; both imported from
     * `@lunora/scheduler`) — rather than surfaced. Advancing far enough to
     * observe a terminal failure therefore costs the WHOLE backoff schedule
     * (30s + 60s + 120s + 240s + 480s = 930s of virtual clock at today's
     * defaults), not a single tick.
     * Only once a job's retry budget is exhausted is the failure surfaced: it is
     * recorded on {@link FakeSchedulerControls.failures} and, by default,
     * re-thrown so a test still sees the error. A single such failure is
     * re-thrown verbatim; multiple are aggregated into an `AggregateError`. Pass
     * `{ throwOnError: false }` to suppress the re-throw and inspect
     * {@link FakeSchedulerControls.failures} (and the returned count) instead.
     *
     * Returns the number of jobs dispatched this sweep, including ones that
     * failed and were silently retried, and ones that failed terminally.
     */
    advance: (ms: number, options?: SweepOptions) => Promise<number>;

    /**
     * All scheduled-job failures that exhausted their retry budget, in
     * execution order, across every `advance()` / `runPending()` call on this
     * harness. A failure with retries remaining is NOT recorded here — see
     * {@link ScheduledJobFailure}. Always available, even when
     * `throwOnError: false` suppressed the re-throw. The list is a snapshot —
     * mutating it does not affect the scheduler.
     */
    failures: () => ScheduledJobFailure[];

    /**
     * List all pending jobs (those not yet executed or cancelled) in the order
     * they were enqueued. A job currently waiting out its retry backoff is
     * still pending (visible here with its `attempts` count incremented and
     * `scheduledFor` pushed out) until its budget is exhausted.
     */
    list: () => FakeScheduledJob[];

    /**
     * Execute all currently pending jobs regardless of their `scheduledFor`
     * time. Equivalent to advancing to `Infinity`. Returns the number of jobs
     * dispatched this sweep (including failed ones, retried or terminal).
     *
     * Failure isolation, retry, and surfacing match
     * {@link FakeSchedulerControls.advance}: one failing job does not abort the
     * rest, a failure under the retry budget is silently re-enqueued rather
     * than surfaced, and only a terminal failure is recorded on
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
 *
 * The retry budget is not configurable: it is `@lunora/scheduler`'s
 * `MAX_RETRY_ATTEMPTS` / `RETRY_BASE_DELAY_MS` verbatim, so a harness retries
 * exactly the way production does.
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

    /** Every captured TERMINAL job failure (retry budget exhausted), in execution order, across all sweeps. */
    const recordedFailures: ScheduledJobFailure[] = [];

    const enqueue = (scheduledFor: number, functionPath: string, args: Record<string, unknown> = {}, requestedId?: string): string => {
        // Production posts the job to the SchedulerDO as a JSON body
        // (`@lunora/scheduler`'s `callDO` → `JSON.stringify`), so an arg it cannot
        // serialize — a `bigint`, a cycle — throws at SCHEDULE time. Do the same
        // work here rather than accepting the job and failing only in production.
        JSON.stringify(args);

        // A caller-supplied id is honoured exactly as the SchedulerDO honours
        // `RunOptions.id`: `@lunora/server`'s deferred-schedule facade decides the
        // id up front so a mutation handler gets it synchronously, then replays the
        // call after the transaction commits.
        const id = requestedId ?? `fake-job-${String(nextId)}`;

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

    // A schedule target is a function-path string, a generated `internal.<file>.<fn>`
    // / `api.<file>.<fn>` reference (which carries its `<file>:<fn>` id in
    // `__lunoraRef`, exactly as `@lunora/scheduler` reads it), or a generated
    // workflow/agent ref (`workflows.<name>` / `agents.<name>`); reduce it to the
    // string key the fake registry dispatches on. A string passes through
    // unchanged, so existing function-scheduling tests are untouched.
    const targetPath = (target: Parameters<Scheduler["runAfter"]>[1]): string => {
        if (typeof target === "string") {
            return target;
        }

        if ("__lunoraRef" in target) {
            return target.__lunoraRef;
        }

        return target.name ?? target.binding ?? "";
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

        // The fourth parameter is `@lunora/scheduler`'s `RunOptions`; only `id` is
        // meaningful to this fake. It is not on the public `Scheduler` ctx type and
        // deliberately stays off it — the only caller is `@lunora/server`'s
        // deferred-schedule facade, which needs the id decided before the call is
        // made so a mutation handler can be handed it synchronously.
        runAfter: (delayMs: number, target: Parameters<Scheduler["runAfter"]>[1], args?: Record<string, unknown>, options?: { id?: string }) => {
            // The same guard `@lunora/scheduler`'s `createScheduler().runAfter`
            // runs before the call reaches the DO — imported, not restated, so a
            // test cannot pass on a delay production refuses.
            assertScheduleDelay(delayMs, "ctx.scheduler.runAfter");

            const id = enqueue(nowMs + delayMs, targetPath(target), args, options?.id);

            return Promise.resolve(id);
        },

        runAt: (timestampMs: number, target: Parameters<Scheduler["runAt"]>[1], args?: Record<string, unknown>, options?: { id?: string }) => {
            const id = enqueue(timestampMs, targetPath(target), args, options?.id);

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
        // `functionPath` is absent when the job targets a durable workflow/agent
        // (exactly one of `functionPath` / `workflow` is set). This fake dispatches
        // registered functions only, so a workflow-targeted job has nothing to look
        // up — treat it as unknown and warn, rather than indexing the registry with
        // `undefined`.
        const entry = job.functionPath === undefined ? undefined : registry.get(job.functionPath);

        // A path the app does not export is a job FAILURE in production: the DO
        // fires it back at the Worker, which answers `FUNCTION_NOT_FOUND`, and the
        // job then walks its retry budget into the dead-letter queue. Throwing
        // routes it through this fake's mirror of that path (`executeDue` below)
        // instead of dropping it with a `console.warn` no assertion can see.
        if (entry === undefined) {
            throw new LunoraError("FUNCTION_NOT_FOUND", `unknown functionPath "${job.functionPath ?? "(workflow-targeted)"}"`, { status: 404 });
        }

        if (entry.kind !== "mutation" && entry.kind !== "action") {
            throw new LunoraError(
                "FUNCTION_NOT_FOUND",
                `functionPath "${job.functionPath ?? "(workflow-targeted)"}" is a ${entry.kind} — only mutations and actions can be scheduled`,
                { status: 404 },
            );
        }

        const dispatch = getDispatch();
        const context = entry.kind === "action" ? getActionContext() : getMutationContext();

        // `ctx.now` is the VIRTUAL clock at fire time, not the harness's construction
        // instant: production dispatches the job as its own RPC and captures `Date.now()`
        // then, so a TTL handler that woke after `advance(3_600_000)` must see an hour
        // of elapsed time rather than zero.
        await dispatch(entry.kind, entry, { ...(context as Record<string, unknown>), now: nowMs }, job.args);
    };

    /**
     * Execute all jobs whose `scheduledFor` is at or before `cutoff`, in scheduled order.
     * Returns the count of jobs dispatched this sweep, including ones that failed
     * (whether silently retried or terminal).
     *
     * Per-job failures are isolated — a throwing job never aborts the sweep,
     * matching production. Unlike production's HTTP round-trip, the fake
     * scheduler runs the retry decision synchronously right here, mirroring
     * `SchedulerDO.recordRetry()` (`packages/scheduler/src/scheduler-do.ts:875-909`):
     * a failure whose `attempts` is still within `MAX_RETRY_ATTEMPTS` is
     * silently re-enqueued with exponential backoff — `RETRY_BASE_DELAY_MS *
     * 2 ** (attempts - 1)` on the virtual clock — and is NOT added to
     * `failed`/`recordedFailures`.
     * Only once the budget is exhausted does the failure get recorded, mirroring
     * production's dead-letter park; captured (terminal) failures are then
     * surfaced by `runSweep` below.
     *
     * Jobs run sequentially (each job may itself enqueue new jobs, but those
     * are not included in the current sweep — the due list is snapshotted before
     * the first dispatch). A job re-enqueued as a retry mid-sweep is likewise
     * not picked up in the same sweep even if its new `scheduledFor` still falls
     * within `cutoff` — it waits for the next `advance()` / `runPending()` call,
     * exactly like any other newly-scheduled job.
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
                // Mirrors SchedulerDO.recordRetry(): `attempts` counts THIS
                // failure, so the very first failure sets it to 1 (not 0-indexed).
                const attempts = (job.attempts ?? 0) + 1;

                if (attempts > MAX_RETRY_ATTEMPTS) {
                    // Retry budget exhausted — terminal, matching the DO's
                    // dead-letter park. Isolate the failure (the sweep continues
                    // to the remaining jobs) but never swallow it: record so the
                    // sweep can surface it.
                    const failure: ScheduledJobFailure = { args: job.args, error, functionPath: job.functionPath ?? "", id: job.id };

                    failed.push(failure);
                    recordedFailures.push(failure);
                } else {
                    // Still within budget — re-enqueue with exponential backoff on
                    // the virtual clock (SchedulerDO's default "exponential"
                    // policy; the fake scheduler does not model a per-job
                    // `RetryPolicy`). Silent: production does not surface a
                    // mid-retry failure either.
                    const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempts - 1);

                    pending.set(job.id, { ...job, attempts, scheduledFor: nowMs + delayMs });
                }
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
