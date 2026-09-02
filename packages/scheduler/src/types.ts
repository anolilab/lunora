/**
 * The registered function kinds a {@link FunctionReference} can describe.
 * Mirrors `@lunora/client`'s `FunctionKind`.
 */

import type { ArgsOf, FunctionKind, FunctionReference } from "../../../shared/function-reference";

// Re-exported so consumers keep naming these through this package.
export type { ArgsOf, FunctionKind, FunctionReference } from "../../../shared/function-reference";

/**
 * Typed reference to a Lunora durable workflow — either the generated
 * `workflows.<name>` reference object (`_generated/api.ts`, which carries the
 * `WORKFLOW_*` binding + export name) or, structurally, a `defineWorkflow()`
 * result imported directly. Both are matched by the `isLunoraWorkflow` brand and
 * carry the workflow's `params` in the phantom `__params`, so a `cronJobs()`
 * registration infers them.
 *
 * Declared structurally here so `@lunora/scheduler` can let a `cronJobs()`
 * builder target a workflow without depending on `@lunora/workflow` (and so the
 * generated `workflows.*` object needs no `@lunora/scheduler` import — it
 * matches structurally). A cron whose target is a {@link WorkflowReference}
 * starts a new workflow INSTANCE on each fire (the args become its `params`)
 * instead of dispatching a one-shot function. `@lunora/codegen` resolves the
 * concrete `lunora/workflows.ts` export statically; the runtime brand here is
 * the authoring-time guard.
 */
export interface WorkflowReference<Params = Record<string, unknown>> {
    /** Phantom carrier for the workflow's `params` type — drives `cronJobs()` arg inference. Never read at runtime. */
    readonly __params?: Params;
    /** The `WORKFLOW_*` binding name (present on a generated `workflows.<name>` ref). */
    readonly binding?: string;
    readonly isLunoraWorkflow: true;
    /** The workflow's export/stable name (present on a generated ref; a `defineWorkflow({ name })` override otherwise). */
    readonly name?: string;
}

/**
 * A function reference a scheduler or workpool may target.
 *
 * `stream` is excluded deliberately, and the exclusion is load-bearing rather
 * than tidiness: a scheduled job is dispatched as an ordinary `/rpc` call, and
 * the function runner cannot execute a stream function (see
 * `create-worker.ts`'s registry note). Accepting one compiles a job that is
 * guaranteed to fail when its alarm fires, long after the call site that
 * scheduled it.
 */
export type SchedulableReference<Args = unknown, Return = unknown> = FunctionReference<Exclude<FunctionKind, "stream">, Args, Return>;

/** A cron job's target: either a one-shot function dispatch or a durable workflow start. */
export type CronTarget = SchedulableReference | WorkflowReference;

/** The arguments a cron's target accepts: a workflow's inferred `params`, else an open record (function args aren't inferred). */
export type CronTargetArgs<T extends CronTarget> = T extends WorkflowReference<infer Params> ? Params : Record<string, unknown>;

/**
 * The arguments a one-shot schedule target ({@link Scheduler.runAfter} /
 * {@link Scheduler.runAt}) accepts. Unlike {@link CronTargetArgs} it resolves a
 * {@link FunctionReference}'s `args` through {@link ArgsOf} as well as a
 * {@link WorkflowReference}'s `params`, so scheduling a generated function
 * reference is arg-checked against that function's validator while scheduling a
 * workflow/agent is checked against its `params`.
 */
export type ScheduleTargetArgs<T extends CronTarget> =
    T extends WorkflowReference<infer Params> ? Params : T extends SchedulableReference ? ArgsOf<T> : Record<string, unknown>;

/** Narrow a {@link CronTarget} to a {@link WorkflowReference} by its runtime brand. */
export const isWorkflowReference = (target: unknown): target is WorkflowReference =>
    typeof target === "object" && target !== null && (target as { isLunoraWorkflow?: unknown }).isLunoraWorkflow === true;

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

    /**
     * Maximum number of **retries** after the initial dispatch. Default `5`, so
     * a job that keeps failing is dispatched 6 times in total before it is
     * dead-lettered (the park happens once `attempts > maxAttempts`).
     */
    maxAttempts?: number;
    /** Optional ceiling clamping the computed backoff delay. */
    maxMs?: number;
}

export interface RunOptions {
    /**
     * Job id to store the record under, instead of one the SchedulerDO mints.
     *
     * Exists for `@lunora/server`'s deferred-schedule facade: inside a mutation a
     * `runAfter`/`runAt` is buffered until the transaction commits, but the
     * handler is handed the id synchronously, so the id has to be decided before
     * the call is made. Callers that are not deferring should leave it unset and
     * take the minted id from the return value. The DO ignores anything that is
     * not a plain `[A-Za-z0-9_-]` id.
     *
     * **Not an idempotency key.** An id that is already scheduled is REFUSED
     * (`409 DUPLICATE_SCHEDULE_ID`), not replaced or de-duplicated: the time
     * index is keyed by time as well as id, so an overwrite would fire the new
     * job at the old job's instant and drop the slot it was actually scheduled
     * for. Cancel the existing job first if you mean to reschedule it. The id
     * is free again once the job has fired or been cancelled.
     */
    id?: string;

    /**
     * Cap for the {@link RunOptions.pool} this job joins, applied when the pool
     * is first created and refreshed on every enqueue that carries one. Ignored
     * without `pool`. A pool created by a `runAfter`/`runAt` that omits it caps
     * at 1 — {@link Workpool} is the usual way to set it.
     */
    maxConcurrency?: number;

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
     * the studio see the field the storage layer actually writes.
     */
    attempts?: number;
    enqueuedAt: number;

    /**
     * The `ns:fn` path of the function to dispatch on fire. Absent when the job
     * targets a durable workflow/agent instead — see {@link ScheduleRecord.workflow}.
     * Exactly one of `functionPath` / `workflow` is set.
     */
    functionPath?: string;
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

    /**
     * The `WORKFLOW_*`/`AGENT_*` binding name to start a fresh durable instance
     * of on fire (the {@link ScheduleRecord.args} become its `params`). Set
     * instead of {@link ScheduleRecord.functionPath} when the job targets a
     * workflow/agent {@link WorkflowReference}. The runtime — not the DO — owns
     * the binding, so the dispatch payload carries this through to the Worker.
     */
    workflow?: string;
}

export interface Scheduler {
    cancel: (id: string) => Promise<{ cancelled: boolean }>;

    /**
     * Jobs that exhausted their retry budget and were parked under `dead:`
     * (the DO's `/dead` view). Deliberately absent from {@link Scheduler.list} —
     * the park deletes the `id:` header — so this is the only view of a job
     * that failed permanently rather than being silently dropped.
     */
    dead: () => Promise<ScheduleRecord[]>;

    /**
     * Resurrect a parked job with a fresh attempt budget (the DO's
     * `POST /dead/retry`). `false` when the id is not parked; a racing double
     * recover is a no-op rather than an error.
     */
    deadRetry: (id: string) => Promise<boolean>;
    /** Resolve a single pending job by id, or `null` when absent (derived from {@link Scheduler.list}). */
    get: (id: string) => Promise<ScheduleRecord | null>;
    /** All pending scheduled jobs (the DO's `/list` view). */
    list: () => Promise<ScheduleRecord[]>;

    /**
     * Schedule `target` to run once, `delayMs` from now. `target` is a function
     * {@link FunctionReference} (dispatched as a one-shot) or a durable
     * {@link WorkflowReference} — the generated `workflows.<name>` /
     * `agents.<name>` ref — which starts a fresh instance on fire (args become
     * its `params`). {@link ScheduleTargetArgs} infers the accepted args from
     * whichever target was passed.
     *
     * **Resolves the job id, a bare string** — the same value `cancel`/`get`
     * take, and the same value the `ctx.scheduler` surface promises. This object
     * IS `ctx.scheduler` on the shard side (codegen installs it behind
     * `SchedulerLike`, whose `runAfter`/`runAt` are declared `Promise<string>`),
     * so resolving a `{ id, scheduledFor }` record here handed mutations an
     * object where every other gate — `@lunora/server`'s `Scheduler`,
     * `@lunora/shard-engine`'s `SchedulerLike`, `@lunora/runtime`'s httpAction
     * ctx, and the docs — said string. Nothing caught it, because the install is
     * a cast: apps wrote the object into a string column and `cancel(id)`
     * answered `{ cancelled: false }` with no error anywhere.
     *
     * The fire instant is not lost: `runAt` was handed it, and a caller that
     * needs it back reads `scheduledFor` off {@link Scheduler.get}.
     */
    runAfter: <T extends CronTarget>(delayMs: number, target: T, args: ScheduleTargetArgs<T>, options?: RunOptions) => Promise<string>;
    /** Like {@link Scheduler.runAfter} but fires at an absolute `date`/timestamp. Resolves the job id. */
    runAt: <T extends CronTarget>(date: Date | number, target: T, args: ScheduleTargetArgs<T>, options?: RunOptions) => Promise<string>;
}

/**
 * Cloudflare Durable Object data-residency jurisdiction. Widening union —
 * Cloudflare adds values over time.
 * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
 */
export type DurableObjectJurisdiction = "eu" | "fedramp" | "us";

/** Subset of `DurableObjectNamespace` the package consumes. */
export interface DurableObjectNamespaceLike {
    get: (id: DurableObjectIdLike) => DurableObjectStubLike;
    idFromName: (name: string) => DurableObjectIdLike;

    /**
     * Derive a jurisdiction-restricted subnamespace. Optional because older
     * workers-types releases (and test doubles) may not expose it.
     */
    jurisdiction?: (jurisdiction: DurableObjectJurisdiction) => DurableObjectNamespaceLike;
}

export interface DurableObjectIdLike {
    toString: () => string;
}

export interface DurableObjectStubLike {
    fetch: (input: Request | string, init?: RequestInit) => Promise<Response>;
}

export interface LunoraSchedulerOptions {
    /** Optional named instance — useful for tenant isolation. Default `default`. */
    instanceName?: string;

    /**
     * Pin the SchedulerDO (durable timers + cron state) to a Cloudflare
     * data-residency jurisdiction. Pass the same value as the worker's
     * `jurisdiction` so scheduled state co-resides with app data. Omit for the
     * un-pinned global namespace.
     */
    jurisdiction?: DurableObjectJurisdiction;
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
 * Options for `createWorkpool`. Mirrors {@link LunoraSchedulerOptions}
 * (same `namespace` / `originUrl` / `instanceName`) plus the bounded-concurrency
 * controls. A workpool is a NAMED logical pool inside the existing SchedulerDO —
 * it needs no extra Durable Object or wrangler binding beyond the SchedulerDO
 * the scheduler already uses.
 */
export interface WorkpoolOptions extends LunoraSchedulerOptions {
    /**
     * Maximum number of jobs from this pool that may be in flight at once.
     * Excess enqueues are persisted and drain as slots free. Must be a positive
     * integer.
     */
    maxConcurrency: number;

    /**
     * Pool name — the concurrency counter is keyed by this inside the
     * SchedulerDO storage (`pool:<name>`). Default `default`.
     */
    name?: string;
}

/**
 * Bounded-concurrency action queue (Lunora equivalent of `@convex-dev/workpool`).
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
    enqueue: <F extends SchedulableReference>(function_: F, args: ArgsOf<F>, options?: EnqueueOptions) => Promise<{ id: string; scheduledFor: number }>;
    /** The pool's name (the `pool:<name>` storage key suffix). */
    readonly name: string;
    /** Inspect the pool's current state — `inFlight` slots used and the configured `maxConcurrency`. */
    status: () => Promise<{ inFlight: number; maxConcurrency: number; queued: number }>;
}

// --- Cloudflare Queues-backed workpool ------------------------------------
//
// A second, lighter workpool that leans on Cloudflare Queues for concurrency,
// retries, and dead-lettering (configured in `wrangler.jsonc`, not code). It
// has NO hard concurrency cap, per-job cancel, or per-job status — reach for
// the SchedulerDO-based {@link Workpool} when you need those. All binding types
// are declared structurally so the package needs no `@cloudflare/workers-types`.

/** Per-message options for {@link QueueLike.send} — the subset Lunora uses. */
export interface QueueSendOptionsLike {
    /** Delay delivery to the consumer by this many seconds. */
    delaySeconds?: number;
}

/** One message in a `sendBatch` call. */
export interface QueueSendRequestLike<Body = unknown> {
    body: Body;
    delaySeconds?: number;
}

/** Producer side of a Cloudflare Queue binding (the `env` queue binding). */
export interface QueueLike<Body = unknown> {
    send: (body: Body, options?: QueueSendOptionsLike) => Promise<void>;
    sendBatch: (messages: Iterable<QueueSendRequestLike<Body>>, options?: QueueSendOptionsLike) => Promise<void>;
}

/** One delivered Cloudflare Queue message (consumer side). */
export interface QueueMessageLike<Body = unknown> {
    /** Marks the message delivered (won't be retried). */
    ack: () => void;
    /** 1-based count of delivery attempts so far. */
    readonly attempts: number;
    readonly body: Body;
    readonly id: string;
    /** Marks the message for retry on a later batch (→ dead-letter after `max_retries`). */
    retry: (options?: { delaySeconds?: number }) => void;
    readonly timestamp: Date;
}

/** A batch of messages handed to a `queue()` consumer handler. */
export interface MessageBatchLike<Body = unknown> {
    /** Mark every message delivered. */
    ackAll: () => void;
    readonly messages: ReadonlyArray<QueueMessageLike<Body>>;
    readonly queue: string;
    /** Mark every message for retry. */
    retryAll: (options?: { delaySeconds?: number }) => void;
}

/** The wire payload Lunora puts on the queue: a function dispatch. */
export interface QueueJob {
    args?: Record<string, unknown>;
    functionPath: string;
    /** Routing hint forwarded to the Worker so the call lands on the right shard. */
    shardKey?: string;
}

/** Per-enqueue options for a {@link QueueWorkpool}. */
export interface QueueEnqueueOptions {
    /** Delay delivery by this many seconds (Queues-native). Default: immediate. */
    delaySeconds?: number;
    /** Routing hint — which shard the job should run against. */
    shardKey?: string;
}

/** Options for `createQueueWorkpool`. */
export interface QueueWorkpoolOptions {
    /** The Cloudflare Queue producer binding to enqueue onto. */
    queue: QueueLike<QueueJob>;
}

/**
 * Queues-backed producer: enqueue function dispatches onto a Cloudflare Queue.
 * Concurrency, retries, and dead-lettering are configured on the queue consumer
 * in `wrangler.jsonc` (`max_concurrency` / `max_retries` / `dead_letter_queue`),
 * not here — that's the whole point of using Queues over the DO workpool.
 */
export interface QueueWorkpool {
    /** Enqueue a single `fn(args)` dispatch. */
    enqueue: <F extends SchedulableReference>(function_: F, args: ArgsOf<F>, options?: QueueEnqueueOptions) => Promise<void>;
    /** Enqueue many dispatches in one `sendBatch`. Each job names its function `ref`. */
    enqueueBatch: (
        jobs: ReadonlyArray<{ args?: Record<string, unknown>; ref: FunctionReference; shardKey?: string }>,
        options?: QueueSendOptionsLike,
    ) => Promise<void>;
}

/**
 * Dispatches a single {@link QueueJob} — the consumer's per-message worker.
 * `messageId` is the queue message's native id, threaded through so the
 * dispatcher can attribute a failure to the exact message that caused it.
 */
export type QueueDispatch = (job: QueueJob, messageId?: string) => Promise<void>;

/** Options for `createQueueConsumer`. */
export interface QueueConsumerOptions {
    /** How each job is executed; e.g. the `httpDispatcher`. */
    dispatch: QueueDispatch;
}

/** Options for the `httpDispatcher` — the default HTTP dispatcher. */
export interface HttpDispatcherOptions {
    /** Admin bearer token the dispatch endpoint accepts (`LUNORA_ADMIN_TOKEN`). */
    adminToken: string;
    /** Injectable fetch (tests); defaults to the global. */
    fetchImpl?: typeof fetch;
    /** Origin where the Worker is mounted (the `/_lunora/scheduler/dispatch` endpoint). */
    originUrl: string;

    /**
     * Abort a job's dispatch after this many ms; the abort is retryable, so the
     * consumer retries the message. Defaults to 5 minutes — raise it for a
     * workpool running jobs that legitimately run longer, lower it to fail a
     * stuck origin faster.
     */
    timeoutMs?: number;
}
