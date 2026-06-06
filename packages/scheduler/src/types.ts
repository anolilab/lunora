/**
 * Opaque reference to a Cirrus function. Mirrors the `FunctionReference` shape
 * emitted by `@cirrus/codegen` (and consumed by `@cirrus/client`). We avoid a
 * direct dependency to keep this package usable from the codegen pipeline
 * itself.
 *
 * The runtime identifier lives in `__cirrusRef` — this MUST stay in lockstep
 * with the codegen emit + `@cirrus/client`'s `FunctionReference`.
 */
export interface FunctionReference {
    readonly __cirrusRef: string;
    /** Marker phantom type — discriminates queries / mutations / actions. */
    readonly _kind?: "query" | "mutation" | "action";
}

export type ArgsOf<F extends FunctionReference> = F extends { _args?: infer A } ? A : Record<string, unknown>;

/**
 * Per-job retry policy. Wired into the SchedulerDO's existing attempts/backoff
 * machinery. When omitted, the DO falls back to its built-in defaults
 * (`maxAttempts: 5`, `backoff: "exponential"`, `baseMs: 30_000`) so existing
 * `runAfter`/`runAt` callers keep today's behaviour unchanged.
 *
 * On exhaustion (attempts > `maxAttempts`) the record is parked under the
 * `dead:` dead-letter key for inspection — never silently dropped.
 */
export interface RetryPolicy {
    /**
     * Backoff growth across attempts. `"exponential"` doubles the delay each
     * attempt (`baseMs * 2 ** (attempt - 1)`); `"linear"` grows it linearly
     * (`baseMs * attempt`). Default `"exponential"`.
     */
    backoff?: "exponential" | "linear";
    /** Base delay in milliseconds for the first retry. Default `30_000`. */
    baseMs?: number;
    /** Maximum number of dispatch attempts before dead-lettering. Default `5`. */
    maxAttempts?: number;
    /** Optional ceiling clamping the computed backoff delay. */
    maxMs?: number;
}

export interface RunOptions {
    /**
     * Logical workpool this job belongs to. When set, the SchedulerDO gates the
     * job behind the pool's `maxConcurrency` (see {@link WorkpoolOptions}).
     * Usually populated by {@link Workpool.enqueue}; callers rarely set it on a
     * bare `runAfter`/`runAt`.
     */
    pool?: string;
    /** Per-job retry policy. Falls back to the DO's built-in defaults when omitted. */
    retry?: RetryPolicy;
    /** Routing hint — forwarded to the Worker so the call lands on the right shard. */
    shardKey?: string;
}

export interface ScheduleRecord {
    args: Record<string, unknown>;

    /**
     * Number of dispatch attempts already made. Absent (treated as 0) until the
     * first failure, after which `recordRetry()` persists it on both the
     * `retry:` row and the `id:` header. Surfaced here so `/list` consumers and
     * the dashboard see the field the storage layer actually writes.
     */
    attempts?: number;
    enqueuedAt: number;
    functionPath: string;
    id: string;

    /**
     * Scheduler/workpool instance name the job was enqueued through. Echoed in
     * the dispatch payload so the runtime can call back the SAME DO instance's
     * `/complete` to release a pooled slot. Absent for the default instance.
     */
    instanceName?: string;

    /**
     * Logical workpool this job belongs to (set by {@link Workpool.enqueue}).
     * When present, the SchedulerDO only dispatches the job while the pool's
     * in-flight count is below its `maxConcurrency`; otherwise it stays queued
     * and drains as slots free. Absent for plain `runAfter`/`runAt` jobs, which
     * are never concurrency-gated.
     */
    pool?: string;
    /** Per-job retry policy (see {@link RetryPolicy}); absent means DO defaults. */
    retry?: RetryPolicy;
    scheduledFor: number;
    shardKey?: string;
}

export interface Scheduler {
    cancel: (id: string) => Promise<{ cancelled: boolean }>;
    /** Resolve a single pending job by id, or `null` when absent (derived from {@link Scheduler.list}). */
    get: (id: string) => Promise<ScheduleRecord | null>;
    /** All pending scheduled jobs (the DO's `/list` view). */
    list: () => Promise<ScheduleRecord[]>;
    runAfter: <F extends FunctionReference>(
        delayMs: number,
        function_: F,
        args: ArgsOf<F>,
        options?: RunOptions,
    ) => Promise<{ id: string; scheduledFor: number }>;
    runAt: <F extends FunctionReference>(
        date: Date | number,
        function_: F,
        args: ArgsOf<F>,
        options?: RunOptions,
    ) => Promise<{ id: string; scheduledFor: number }>;
}

/** Subset of `DurableObjectNamespace` the package consumes. */
export interface DurableObjectNamespaceLike {
    get: (id: DurableObjectIdLike) => DurableObjectStubLike;
    idFromName: (name: string) => DurableObjectIdLike;
}

export interface DurableObjectIdLike {
    toString: () => string;
}

export interface DurableObjectStubLike {
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

export interface CirrusSchedulerOptions {
    /** Optional named instance — useful for tenant isolation. Default `default`. */
    instanceName?: string;
    /** Binding to the `SchedulerDO` durable object namespace. */
    namespace: DurableObjectNamespaceLike;

    /**
     * Origin where the Worker is mounted. SchedulerDO uses this base URL when
     * dispatching scheduled functions back to the Worker on alarm fire.
     */
    originUrl: string;
}

/** Per-enqueue options for a {@link Workpool}. Extends {@link RunOptions} minus the implicit `pool` (the pool sets that). */
export interface EnqueueOptions {
    /** Run the job no sooner than this delay (ms) from now. Default `0` (next drain). */
    delayMs?: number;
    /** Per-job retry policy. Falls back to the DO's built-in defaults when omitted. */
    retry?: RetryPolicy;
    /** Routing hint — forwarded to the Worker so the call lands on the right shard. */
    shardKey?: string;
}

/**
 * Options for `createWorkpool`. Mirrors {@link CirrusSchedulerOptions}
 * (same `namespace` / `originUrl` / `instanceName`) plus the bounded-concurrency
 * controls. A workpool is a NAMED logical pool inside the existing SchedulerDO —
 * it needs no extra Durable Object or wrangler binding beyond the SchedulerDO
 * the scheduler already uses.
 */
export interface WorkpoolOptions extends CirrusSchedulerOptions {
    /**
     * Maximum number of jobs from this pool that may be in flight at once.
     * Excess enqueues are persisted and drain as slots free. Must be a positive
     * integer.
     */
    maxConcurrency: number;

    /**
     * Pool name — the concurrency counter is keyed by this inside the
     * SchedulerDO storage (`pool:&lt;name>`). Default `default`.
     */
    name?: string;
}

/**
 * Bounded-concurrency action queue (Cirrus equivalent of `@convex-dev/workpool`).
 * Built on the existing SchedulerDO: `enqueue` schedules a job tagged with this
 * pool's name; the DO caps simultaneous dispatch at `maxConcurrency` and queues
 * the rest durably.
 */
export interface Workpool {
    /** Cancel a queued/in-flight pool job by id. */
    cancel: (id: string) => Promise<{ cancelled: boolean }>;

    /**
     * Enqueue `function_(args)` into the pool. Resolves with the durable job id
     * and the time it was scheduled for (it may not run immediately if the pool
     * is at capacity).
     */
    enqueue: <F extends FunctionReference>(function_: F, args: ArgsOf<F>, options?: EnqueueOptions) => Promise<{ id: string; scheduledFor: number }>;
    /** The pool's name (the `pool:&lt;name>` storage key suffix). */
    readonly name: string;
    /** Inspect the pool's current state — `inFlight` slots used and the configured `maxConcurrency`. */
    status: () => Promise<{ inFlight: number; maxConcurrency: number; queued: number }>;
}
