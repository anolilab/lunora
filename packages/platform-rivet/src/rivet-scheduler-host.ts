/**
 * Rivet adapter: the provider-neutral `@lunora/platform` `SchedulerHost` over
 * Rivet's own durable schedules (`c.schedule`) and crons (`c.cron`).
 *
 * This is the contract Rivet fits most comfortably, and the first host in the
 * repo to get the whole of it from the platform rather than from machinery
 * Lunora maintains itself:
 *
 * - **Timing and durability are Rivet's.** A schedule survives sleep, restart,
 * upgrade and crash, and Rivet wakes the actor to deliver it. There is no
 * `setTimeout` here, no re-arm-on-construction, and no window in which a
 * process that was down eats a job — the three things `@lunora/platform-node`
 * has to build by hand.
 * - **Runtime cron registration is Rivet's.** `SchedulerHost.cron` is optional
 * precisely because Cloudflare cannot offer it (its crons live in
 * `wrangler.jsonc` and are reconciled at build time). `c.cron.set` registers
 * one at runtime, so this host declares the member.
 *
 * What is **not** Rivet's, and is therefore this file's own bookkeeping:
 *
 * - **Payloads.** A Rivet schedule invokes an action on the same actor. Lunora
 * needs to dispatch an arbitrary `functionPath` with arbitrary args, so the
 * job record lives in a table here and the Rivet schedule carries only its
 * id.
 * - **Retries and dead-lettering.** Rivet explicitly does not retry a failed
 * run. `SchedulerHost` promises at-least-once, and `deadLetter` is the member
 * that makes the promise checkable, so exponential backoff and the parked
 * set are implemented over the job table.
 */

import type { ScheduledJob, ScheduledJobStatus, ScheduleOptions, SchedulerHost } from "@lunora/platform";

import type { RivetActorLike } from "./rivet-context";

/**
 * The Rivet action a due job is delivered to. The actor definition carries a
 * handler under this name that calls
 * {@link RivetSchedulerHost.deliverScheduledJob} with the job id it is passed.
 */
// eslint-disable-next-line no-secrets/no-secrets -- a fixed action name, not a credential; the entropy is just camelCase
const RIVET_SCHEDULER_ACTION = "__lunoraSchedulerDispatch";

/**
 * The Rivet action a cron tick is delivered to. Distinct from
 * {@link RIVET_SCHEDULER_ACTION} because a cron tick carries its function path
 * and args inline — there is no job row to look up, since a recurring job is
 * not consumed by firing.
 */
const RIVET_CRON_ACTION = "__lunoraCronDispatch";

/** Prefix for the Rivet cron job names this host owns, so it never collides with an app's own crons. */
const CRON_NAME_PREFIX = "lunora:";

const JOBS_TABLE = "_lunora_scheduler_jobs";

/**
 * Retry policy applied when a caller supplies none. Identical to
 * `@lunora/platform-node`'s, deliberately: two hosts disagreeing on how many
 * times "at-least-once" tries is a portability trap, not a tuning opportunity.
 */
const DEFAULT_RETRY = {
    backoffMultiplier: 2,
    initialDelayMs: 1000,
    maxAttempts: 5,
    maxDelayMs: 60_000,
} as const;

/** Row shape of the job table. */
interface JobRow extends Record<string, unknown> {
    args: string;
    attempts: number;
    backoff_multiplier: number;
    function_path: string;
    id: string;
    initial_delay_ms: number;
    max_attempts: number;
    max_delay_ms: number;
    parked: number;
    schedule_id: string | null;
    scheduled_for: number;
}

/** Delay before attempt number `attempts` (1-based), capped at `maxDelayMs`. */
const backoffFor = (attempts: number, row: Pick<JobRow, "backoff_multiplier" | "initial_delay_ms" | "max_delay_ms">): number =>
    Math.min(row.max_delay_ms, row.initial_delay_ms * row.backoff_multiplier ** Math.max(0, attempts - 1));

const toStatus = (row: JobRow): ScheduledJobStatus => {
    return {
        attempts: row.attempts,
        functionPath: row.function_path,
        id: row.id,
        scheduledFor: row.scheduled_for,
    };
};

/** Options for {@link createRivetSchedulerHost}. */
interface RivetSchedulerHostOptions {
    /**
     * Deliver one due job. Wire this to whatever calls a Lunora function from a
     * server-initiated context.
     *
     * A handler that **throws** is what drives the retry ladder: the attempt is
     * counted, the job is re-armed with backoff, and once the attempt budget is
     * spent it is parked in the dead-letter set rather than dropped. A host
     * given no `onDispatch` still stores, arms and cancels jobs correctly —
     * they simply have nowhere to land, which is the same bargain
     * `ShardHost.onAlarm` makes.
     */
    onDispatch?: (functionPath: string, args: Record<string, unknown>, job: ScheduledJob) => Promise<void> | void;
}

/** The scheduler host plus the delivery entry points its Rivet actions need. */
interface RivetSchedulerHost {
    /** Deliver a cron tick. Called from the actor's {@link RIVET_CRON_ACTION} handler. */
    deliverCronTick: (functionPath: string, args: Record<string, unknown>) => Promise<void>;

    /**
     * Deliver one due job by id. Called from the actor's
     * {@link RIVET_SCHEDULER_ACTION} handler.
     * @returns `true` when a pending job was found and dispatched (successfully
     * or not); `false` for an id that was already cancelled or consumed.
     */
    deliverScheduledJob: (id: string) => Promise<boolean>;

    /**
     * Park a pending job in the dead-letter set without waiting out its retry
     * budget. Test-only — it is how `@lunora/platform/conformance` asserts the
     * parked/pending invariants without burning five real backoff delays.
     */
    parkJob: (id: string) => Promise<boolean>;
    /** The `SchedulerHost` contract implementation. */
    scheduler: SchedulerHost;
}

/** Build a `SchedulerHost` over one Rivet actor's schedules, crons and SQLite. */
const createRivetSchedulerHost = (actor: Pick<RivetActorLike, "cron" | "db" | "schedule">, options: RivetSchedulerHostOptions = {}): RivetSchedulerHost => {
    const { cron, db, schedule } = actor;

    /**
     * Table creation, kicked off eagerly and awaited by every member.
     *
     * Construction stays synchronous so a composition root can build all the
     * contracts in one pass and await their `ready` promises together; the
     * alternative — an async factory per contract — serializes four round trips
     * on every actor wake.
     */
    const ready = db
        .execute(
            `CREATE TABLE IF NOT EXISTS ${JOBS_TABLE} (
                id TEXT PRIMARY KEY,
                function_path TEXT NOT NULL,
                args TEXT NOT NULL,
                scheduled_for INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL,
                initial_delay_ms INTEGER NOT NULL,
                backoff_multiplier REAL NOT NULL,
                max_delay_ms INTEGER NOT NULL,
                shard_key TEXT,
                schedule_id TEXT,
                parked INTEGER NOT NULL DEFAULT 0
            )`,
        )
        .then(() => undefined);

    const loadJob = async (id: string): Promise<JobRow | undefined> => {
        await ready;

        const rows = await db.execute<JobRow>(`SELECT * FROM ${JOBS_TABLE} WHERE id = ?`, id);

        return rows[0];
    };

    /** Arm (or re-arm) a job's Rivet schedule and record the id it came back with. */
    const arm = async (id: string, scheduledFor: number): Promise<void> => {
        const scheduleId = await schedule.at(scheduledFor, RIVET_SCHEDULER_ACTION, id);

        await db.execute(`UPDATE ${JOBS_TABLE} SET schedule_id = ?, scheduled_for = ? WHERE id = ?`, scheduleId, scheduledFor, id);
    };

    const scheduler: SchedulerHost = {
        cancel: async (id) => {
            const row = await loadJob(id);

            // A parked job is not pending, so there is nothing to cancel — the
            // same disjointness `deadLetter` documents. Answering `true` here
            // would tell an operator they stopped a delivery that had already
            // permanently failed.
            if (row === undefined || row.parked === 1) {
                return false;
            }

            await db.execute(`DELETE FROM ${JOBS_TABLE} WHERE id = ?`, id);

            if (row.schedule_id !== null) {
                await schedule.cancel(row.schedule_id);
            }

            return true;
        },

        // Declared, unlike on Cloudflare, because Rivet registers crons at
        // runtime. The name is namespaced by function path so re-registering
        // the same path updates the job in place (Rivet's documented
        // same-name-updates behaviour) instead of accumulating duplicates.
        cron: async (expression, functionPath, args) => {
            await cron.set({
                action: RIVET_CRON_ACTION,
                args: [functionPath, JSON.stringify(args ?? {})],
                expression,
                name: `${CRON_NAME_PREFIX}${functionPath}`,
            });
        },

        deadLetter: {
            list: async () => {
                await ready;

                const rows = await db.execute<JobRow>(`SELECT * FROM ${JOBS_TABLE} WHERE parked = 1 ORDER BY scheduled_for`);

                return rows.map((row) => toStatus(row));
            },
            requeue: async (id) => {
                const row = await loadJob(id);

                if (row === undefined || row.parked === 0) {
                    return false;
                }

                // A fresh budget, or the job parks again on its next failure
                // without ever retrying — the requeue would look successful and
                // change nothing.
                await db.execute(`UPDATE ${JOBS_TABLE} SET parked = 0, attempts = 0 WHERE id = ?`, id);
                await arm(id, Date.now());

                return true;
            },
        },

        list: async () => {
            await ready;

            const rows = await db.execute<JobRow>(`SELECT * FROM ${JOBS_TABLE} WHERE parked = 0 ORDER BY scheduled_for`);

            return rows.map((row) => toStatus(row));
        },

        schedule: async (functionPath, args, scheduleOptions?: ScheduleOptions) => {
            await ready;

            const at = scheduleOptions?.at;
            let scheduledFor = Date.now() + (scheduleOptions?.delayMs ?? 0);

            if (at !== undefined) {
                scheduledFor = typeof at === "number" ? at : at.getTime();
            }

            const retry = scheduleOptions?.retry;
            const id = crypto.randomUUID();

            await db.execute(
                `INSERT INTO ${JOBS_TABLE}
                   (id, function_path, args, scheduled_for, attempts, max_attempts, initial_delay_ms, backoff_multiplier, max_delay_ms, shard_key, schedule_id, parked)
                 VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, 0)`,
                id,
                functionPath,
                JSON.stringify(args),
                scheduledFor,
                retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
                retry?.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs,
                retry?.backoffMultiplier ?? DEFAULT_RETRY.backoffMultiplier,
                retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
                // eslint-disable-next-line unicorn/no-null -- SQL NULL for an absent routing hint; the column is nullable and `undefined` is not bindable
                scheduleOptions?.shardKey ?? null,
            );

            await arm(id, scheduledFor);

            return { id, scheduledFor };
        },
    };

    const park = async (id: string): Promise<boolean> => {
        const row = await loadJob(id);

        if (row === undefined || row.parked === 1) {
            return false;
        }

        await db.execute(`UPDATE ${JOBS_TABLE} SET parked = 1, schedule_id = NULL WHERE id = ?`, id);

        if (row.schedule_id !== null) {
            await schedule.cancel(row.schedule_id);
        }

        return true;
    };

    return {
        deliverCronTick: async (functionPath, args) => {
            // A cron tick has no job row: a recurring job is not consumed by
            // firing, and Rivet keeps its own run history. Retries are
            // deliberately absent for the same reason Rivet omits them — the
            // next tick is the retry, and stacking backoff behind a schedule
            // that is about to fire again produces overlapping runs.
            await options.onDispatch?.(functionPath, args, { id: `${CRON_NAME_PREFIX}${functionPath}`, scheduledFor: Date.now() });
        },
        deliverScheduledJob: async (id) => {
            const row = await loadJob(id);

            if (row === undefined || row.parked === 1) {
                return false;
            }

            const attempts = row.attempts + 1;

            await db.execute(`UPDATE ${JOBS_TABLE} SET attempts = ?, schedule_id = NULL WHERE id = ?`, attempts, id);

            try {
                await options.onDispatch?.(row.function_path, JSON.parse(row.args) as Record<string, unknown>, {
                    id,
                    scheduledFor: row.scheduled_for,
                });
            } catch {
                // Delivery failed. Retry with backoff while the budget lasts,
                // then park — never drop, because a dropped job is
                // indistinguishable from a delivered one to every caller, which
                // is the whole reason `deadLetter` exists.
                await (attempts >= row.max_attempts
                    ? db.execute(`UPDATE ${JOBS_TABLE} SET parked = 1 WHERE id = ?`, id)
                    : arm(id, Date.now() + backoffFor(attempts, row)));

                return true;
            }

            await db.execute(`DELETE FROM ${JOBS_TABLE} WHERE id = ?`, id);

            return true;
        },
        parkJob: park,
        scheduler,
    } satisfies RivetSchedulerHost;
};

export type { RivetSchedulerHost, RivetSchedulerHostOptions };
export { createRivetSchedulerHost, RIVET_CRON_ACTION, RIVET_SCHEDULER_ACTION };
