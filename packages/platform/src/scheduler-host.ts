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
     * Schedule a function call for later execution. The `functionPath` and
     * `args` are serialized and delivered back to the worker at dispatch time.
     */
    schedule: (functionPath: string, args: Record<string, unknown>, options?: ScheduleOptions) => Promise<ScheduledJob>;
}
