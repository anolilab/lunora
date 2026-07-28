/**
 * `SchedulerHost` — the provider-neutral contract for durable scheduling
 * (delayed jobs, cron triggers, at-least-once dispatch). On Cloudflare this is
 * backed by `SchedulerDO` (a Durable Object with alarms) plus Cron Triggers.
 * On another provider it may be a job scheduler (SQS + EventBridge, Temporal,
 * a database-backed polling loop, or a managed cron service).
 *
 * The contract encodes the guarantees Lunora's `runAfter` / `runAt` / cron
 * features rely on:
 * 1. **At-least-once delivery** — a scheduled job is dispatched at least once;
 * retries and dead-lettering are host-managed.
 * 2. **Durable persistence** — scheduled jobs survive host recycling.
 * 3. **Time-based dispatch** — jobs can be scheduled for an absolute time or
 * after a delay.
 */

/** Options accepted when scheduling a job. */
export interface ScheduleOptions {
    /** Run the job at this absolute timestamp (ms since epoch). Overrides `delayMs`. */
    at?: number | Date;
    /** Run the job no sooner than this delay (ms) from now. */
    delayMs?: number;
    /** Per-job retry policy. Falls back to the host's defaults when omitted. */
    retry?: {
        /** Backoff multiplier. */
        backoffMultiplier?: number;
        /** Initial backoff delay (ms). */
        initialDelayMs?: number;
        /** Maximum number of delivery attempts. */
        maxAttempts?: number;
        /** Maximum backoff delay (ms). */
        maxDelayMs?: number;
    };
    /** Routing hint forwarded to the worker so the call lands on the right shard. */
    shardKey?: string;
}

/** A scheduled job descriptor returned by the host. */
export interface ScheduledJob {
    /** Unique job identifier. */
    id: string;
    /** Timestamp (ms since epoch) the job is scheduled for. */
    scheduledFor: number;
}

/**
 * A scheduled job as the host currently sees it — {@link ScheduledJob} plus the
 * delivery state that only the host knows.
 *
 * `attempts` is what makes at-least-once observable rather than merely
 * promised: a job that failed to deliver and is waiting to be retried is still
 * pending, with a higher count. A host reporting `0` forever is either not
 * retrying or not counting, and both are worth knowing.
 */
export interface ScheduledJobStatus extends ScheduledJob {
    /** Delivery attempts made so far. `0` for a job that has not been dispatched yet. */
    attempts: number;
    /** The function path the job dispatches to. */
    functionPath: string;
}

/**
 * The scheduler host contract. One instance per scheduler namespace.
 */
export interface SchedulerHost {
    /**
     * Cancel a previously scheduled job. Returns `true` if the job was found
     * and cancelled; `false` if it was already dispatched or never existed.
     */
    cancel: (id: string) => Promise<boolean>;

    /**
     * Register a cron schedule at runtime. The `cron` expression uses standard
     * cron syntax; the `functionPath` is dispatched on each tick.
     *
     * **Optional, and omitted by hosts whose crons are declared rather than
     * registered.** Cloudflare is one: `triggers.crons` lives in
     * `wrangler.jsonc` and is reconciled at build time by the config layer, so
     * there is no runtime call that could add one. Such a host omits this
     * method rather than supplying one that throws or silently no-ops —
     * presence is the host's declaration that dynamic cron works, exactly as
     * with `SocketHost.setTag`. A caller that finds it absent must fall
     * back to the target's declarative configuration.
     */
    cron?: (cron: string, functionPath: string, args?: Record<string, unknown>) => Promise<void>;

    /**
     * List jobs that exhausted their retry budget and were parked instead of
     * dropped, plus return one to the pending set.
     *
     * **Optional, and its absence is a real statement:** a host without it
     * cannot promise at-least-once, only at-most-once. Once retries are
     * exhausted the job either survives somewhere an operator can find it, or
     * it is gone — and "gone" is indistinguishable from "delivered" to every
     * caller. Guarantee 1 in this module's header is exactly what this member
     * makes checkable.
     *
     * `list` MUST be disjoint from {@link SchedulerHost.list}: a parked job is
     * no longer scheduled, and a host reporting it in both shows a permanently
     * failed job as still on its way.
     *
     * `requeue` returns `false` for an id that is not parked, and on `true`
     * returns the job to the pending set with a fresh attempt budget.
     */
    deadLetter?: {
        list: () => Promise<ScheduledJobStatus[]>;
        requeue: (id: string) => Promise<boolean>;
    };

    /**
     * List the jobs currently pending — scheduled and not yet delivered,
     * including those waiting between retries.
     *
     * Optional: a fire-and-forget host with no queryable queue omits it, and
     * the suite reports the gap rather than asserting against a stub.
     */
    list?: () => Promise<ScheduledJobStatus[]>;

    /**
     * Schedule a function call for later execution. The `functionPath` and
     * `args` are serialized and delivered back to the worker at dispatch time.
     */
    schedule: (functionPath: string, args: Record<string, unknown>, options?: ScheduleOptions) => Promise<ScheduledJob>;
}
