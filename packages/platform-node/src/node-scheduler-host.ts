/**
 * Node adapter: a SQLite-backed job table satisfying the provider-neutral
 * `@lunora/platform` `SchedulerHost` contract.
 *
 * `SchedulerHost`'s docstring promises three things: at-least-once delivery,
 * durable persistence across host recycling, and time-based dispatch. On
 * Cloudflare all three come from `SchedulerDO` — Durable Object storage holds
 * the job rows and workerd re-delivers the alarm that drains them, even after
 * the process that scheduled a job is long gone.
 *
 * A Node process has no runtime to hand that job to, so this host owns the
 * whole loop itself: rows live in `_lunora_scheduler_jobs` on the same
 * `better-sqlite3` connection as the rest of the shard, and **construction
 * re-arms every pending row**. That last part is what turns persistence into
 * durability. An earlier revision of this file persisted nothing and said so,
 * on the grounds that "persisting the job row without something to re-arm it
 * would be worse than this in-memory implementation" — correct as far as it
 * went, and the missing half was simply the re-arm.
 *
 * A job whose `scheduled_for` elapsed while nothing was running fires on the
 * next construction rather than being dropped: late, but delivered, which is
 * what at-least-once owes a caller.
 *
 * The contract's optional `deadLetter` member is declared again here. Plan 267
 * removed it, correctly: it is the documented at-least-once claim, and this
 * host's timer body used to delete a row rather than deliver it, so nothing
 * could ever exhaust a retry budget and "parked" was a state no job could
 * reach. Delivery now exists (`onDispatch`), failures increment `attempts`,
 * and a job that burns its budget lands in `state = 'dead'` — so the member
 * describes something real rather than being re-declared on the same evidence
 * that justified dropping it.
 *
 * `cron` **is** implemented here, and this is the first host in the repo to
 * populate it. Its optionality on the contract is Cloudflare-shaped — crons
 * live in `wrangler.jsonc` and are reconciled at build time, so there is no
 * runtime call that could add one — and `SchedulerHost.cron`'s docstring is
 * explicit that presence is a host's declaration that dynamic cron works. On
 * Node it does: expressions are parsed by `cron-parser` (the same dependency
 * `@lunora/scheduler` validates with, so one grammar stays authoritative across
 * the repo) and re-armed from the durable table on construction exactly like
 * one-shot jobs.
 */

import { randomUUID } from "node:crypto";
import { deserialize, serialize } from "node:v8";

import type { ScheduledJob, ScheduledJobStatus, ScheduleOptions, SchedulerHost } from "@lunora/platform";
import type Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";

/**
 * Retry policy applied when a caller supplies none. `ScheduleOptions.retry`
 * documents each field as falling back to "the host's defaults"; these are this
 * host's, and they are deliberately modest — a Node host is usually a dev
 * server or a single-node deployment, where a job retrying for ten minutes is
 * noise rather than resilience.
 */
const DEFAULT_RETRY = {
    backoffMultiplier: 2,
    initialDelayMs: 1000,
    maxAttempts: 5,
    maxDelayMs: 60_000,
} as const;

/**
 * Largest delay `setTimeout` accepts as a 32-bit signed integer. Any delay
 * above this (~24.8 days) is clamped to 1 ms with a `TimeoutOverflowWarning`,
 * which would fire a job or cron tick far ahead of its target timestamp.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Row shape of `_lunora_scheduler_jobs`. */
interface JobRow {
    args: Buffer;
    attempts: number;
    function_path: string;
    id: string;
    retry: Buffer | null;
    scheduled_for: number;
    state: "dead" | "pending";
}

/** Row shape of `_lunora_scheduler_crons`. */
interface CronRow {
    args: Buffer;
    expression: string;
    function_path: string;
    key: string;
}

/** Options for {@link createNodeSchedulerHost}. */
interface NodeSchedulerHostOptions {
    /**
     * Called when a job or cron tick comes due — this host's stand-in for the
     * Worker fetch `SchedulerDO` makes when its alarm drains the queue.
     *
     * A handler that **throws** marks the delivery failed, which is what drives
     * the retry/dead-letter machinery: the job's `attempts` increments and it is
     * either re-armed with backoff or parked. A handler that resolves marks the
     * job delivered and removes it.
     *
     * Omitting it makes every delivery trivially succeed, which means a caller
     * who forgets to pass one gets a scheduler that quietly drops work — the
     * precise failure plan 267 caught. Supply one in anything real; the
     * conformance host supplies one purely so the TCK can tell a delivery apart
     * from an expired timer.
     */
    onDispatch?: (functionPath: string, args: Record<string, unknown>, job: { attempts: number; id: string }) => Promise<void> | void;
}

/**
 * The scheduler half of a Node platform instance, plus the test-only hook the
 * TCK's dead-letter legs need.
 */
interface NodeSchedulerHost {
    /**
     * Clear every armed `setTimeout` (one-shot jobs and cron ticks alike) and
     * put the host into a terminal, closed state: afterwards `schedule()` and
     * `cron()` throw rather than arm a fresh timer nothing would ever clear.
     *
     * Rows are left in place on purpose: `dispose()` is shutdown, not deletion,
     * and the next construction over the same database re-arms exactly what was
     * still pending. An armed timer is also a handle that keeps the event loop —
     * and transitively the process — alive until it fires, which is what
     * produces the "worker process failed to exit gracefully" delay if it is
     * left uncleared.
     */
    dispose: () => void;
    scheduler: SchedulerHost;

    /**
     * Drive a pending job straight to its dead-letter state without waiting out
     * a real retry budget. Exactly the hook `ConformanceHost.simulateDeadLetter`
     * describes: the observable invariants of dead-lettering are contract-level,
     * while how many failures it takes to get there is host policy.
     */
    simulateDeadLetter: (id: string) => Promise<boolean>;
}

/**
 * Delay before attempt number `attempts` (1-based), capped at `maxDelayMs`.
 * Exponential on the multiplier, the shape `ScheduleOptions.retry` describes.
 */
const backoffFor = (attempts: number, retry: ScheduleOptions["retry"]): number => {
    const initial = retry?.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs;
    const multiplier = retry?.backoffMultiplier ?? DEFAULT_RETRY.backoffMultiplier;
    const max = retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;

    return Math.min(max, initial * multiplier ** Math.max(0, attempts - 1));
};

/** Build a durable, SQLite-backed scheduler over `database`. */
const createNodeSchedulerHost = (database: Database.Database, options: NodeSchedulerHostOptions = {}): NodeSchedulerHost => {
    database.exec(
        `CREATE TABLE IF NOT EXISTS _lunora_scheduler_jobs (
            id TEXT PRIMARY KEY,
            function_path TEXT NOT NULL,
            args BLOB NOT NULL,
            scheduled_for INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            retry BLOB,
            state TEXT NOT NULL DEFAULT 'pending'
        )`,
    );
    database.exec(
        `CREATE TABLE IF NOT EXISTS _lunora_scheduler_crons (
            key TEXT PRIMARY KEY,
            expression TEXT NOT NULL,
            function_path TEXT NOT NULL,
            args BLOB NOT NULL
        )`,
    );

    const insertJob = database.prepare<[string, string, Buffer, number, Buffer | null]>(
        "INSERT INTO _lunora_scheduler_jobs (id, function_path, args, scheduled_for, retry) VALUES (?, ?, ?, ?, ?)",
    );
    const selectJob = database.prepare<[string], JobRow>("SELECT * FROM _lunora_scheduler_jobs WHERE id = ?");
    const selectByState = database.prepare<[string], JobRow>("SELECT * FROM _lunora_scheduler_jobs WHERE state = ? ORDER BY scheduled_for");
    const deleteJob = database.prepare<[string]>("DELETE FROM _lunora_scheduler_jobs WHERE id = ?");
    const deletePendingJob = database.prepare<[string]>("DELETE FROM _lunora_scheduler_jobs WHERE id = ? AND state = 'pending'");
    const updateAttempt = database.prepare<[number, number, string]>("UPDATE _lunora_scheduler_jobs SET attempts = ?, scheduled_for = ? WHERE id = ?");
    const parkJob = database.prepare<[number, string]>("UPDATE _lunora_scheduler_jobs SET state = 'dead', attempts = ? WHERE id = ?");
    const requeueJob = database.prepare<[number, string]>(
        "UPDATE _lunora_scheduler_jobs SET state = 'pending', attempts = 0, scheduled_for = ? WHERE id = ? AND state = 'dead'",
    );
    const upsertCron = database.prepare<[string, string, string, Buffer]>(
        `INSERT INTO _lunora_scheduler_crons (key, expression, function_path, args) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET expression = excluded.expression, args = excluded.args`,
    );
    const selectCrons = database.prepare<[], CronRow>("SELECT * FROM _lunora_scheduler_crons");

    /**
     * Read the connection's open/closed state *now*.
     *
     * Called through a function rather than as `database.open` directly because
     * TypeScript narrows the property after an early `if (!database.open)
     * return`, and then treats every later check in the same function as
     * redundant — which is exactly wrong here, since an `await` sits in
     * between and the caller may have closed the connection during it. The
     * indirection keeps each check a real runtime read.
     */
    const isOpen = (): boolean => database.open;

    /**
     * Decode a job's stored retry policy. `null` is SQLite's own NULL arriving
     * through better-sqlite3's nullable-column mapping, not a value this
     * package's API ever produces.
     */

    const decodeRetry = (value: Buffer | null): ScheduleOptions["retry"] => (value === null ? undefined : (deserialize(value) as ScheduleOptions["retry"]));

    /**
     * Terminal-shutdown flag, kept alongside the connection's own open state.
     *
     * `dispose()` is one-way: after it runs, `schedule()`/`cron()` throw rather
     * than arm a fresh timer nothing would ever clear — the handle-leak class
     * the disposer exists to eliminate. Tracked separately from
     * `database.open` because the scheduler can be disposed while the caller
     * keeps the connection open for other work.
     */
    let closed = false;

    /** Armed one-shot job timers, keyed by job id. */
    const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /** Armed cron tick timers, keyed by cron key. */
    const cronTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const toStatus = (row: JobRow): ScheduledJobStatus => {
        return {
            attempts: row.attempts,
            functionPath: row.function_path,
            id: row.id,
            scheduledFor: row.scheduled_for,
        };
    };

    const clearJobTimer = (id: string): void => {
        const timer = jobTimers.get(id);

        if (timer !== undefined) {
            clearTimeout(timer);
            jobTimers.delete(id);
        }
    };

    const armJob = (id: string, scheduledFor: number): void => {
        clearJobTimer(id);

        const delay = Math.max(0, scheduledFor - Date.now());

        // `setTimeout` clamps any delay above 2^31 - 1 ms (~24.8 days) down to
        // 1 ms and warns (`TimeoutOverflowWarning`), so a long-delay job would
        // fire immediately — deleted, with its retry budget unspent. Re-arm in
        // maximum-sized chunks until the target is close enough to pass whole.
        if (delay > MAX_TIMEOUT_MS) {
            const timer = setTimeout(() => {
                armJob(id, scheduledFor);
            }, MAX_TIMEOUT_MS);

            jobTimers.set(id, timer);

            return;
        }

        const timer = setTimeout(() => {
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- `armJob` and `deliver` are mutually recursive by nature (a retry re-arms, an arm delivers), so one of the two references has to precede its definition
            deliver(id).catch(() => {
                // `deliver` settles its own failures into the retry /
                // dead-letter machinery; this only keeps the promise from
                // floating.
            });
        }, delay);

        jobTimers.set(id, timer);
    };

    /**
     * Deliver one job, then settle its row: removed on success, re-armed with
     * backoff while attempts remain, parked in `dead` once they are exhausted.
     *
     * Every database touch is guarded on `database.open`, because a timer can
     * outlive a `close()` the caller made in between (shutdown, test cleanup)
     * and a statement against a closed better-sqlite3 connection throws
     * synchronously inside the timer callback, where no caller's try/catch can
     * reach it.
     */
    const deliver = async (id: string): Promise<void> => {
        jobTimers.delete(id);

        if (!isOpen()) {
            return;
        }

        const row = selectJob.get(id);

        if (row?.state !== "pending") {
            return;
        }

        const attempts = row.attempts + 1;
        const retry = decodeRetry(row.retry);

        try {
            await options.onDispatch?.(row.function_path, deserialize(row.args) as Record<string, unknown>, { attempts, id });

            if (isOpen()) {
                deleteJob.run(id);
            }
        } catch {
            // Delivery failed. The catch is bare because *why* it failed is the
            // handler's business; all this loop decides is whether any budget is
            // left. `closed` is checked too: `dispose()` cleared `jobTimers` and
            // may have run while this dispatch was in flight, and a re-arm after
            // that would mint a fresh timer nothing would ever clear.
            if (closed || !isOpen()) {
                return;
            }

            const maxAttempts = retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts;

            if (attempts >= maxAttempts) {
                parkJob.run(attempts, id);

                return;
            }

            const nextAt = Date.now() + backoffFor(attempts, retry);

            updateAttempt.run(attempts, nextAt, id);
            armJob(id, nextAt);
        }
    };

    /**
     * Arm the next tick for a cron row, and keep arming after each one.
     *
     * Unlike a one-shot job a cron has no row to delete on success and no retry
     * budget to exhaust — a tick that throws is dropped and the next tick is
     * armed regardless, which is how a recurring schedule has to behave: a
     * failed 09:00 run must not cancel 10:00.
     */
    const armCron = (row: CronRow): void => {
        const existing = cronTimers.get(row.key);

        if (existing !== undefined) {
            clearTimeout(existing);
        }

        let nextAt: number;

        try {
            nextAt = CronExpressionParser.parse(row.expression).next().getTime();
        } catch {
            // An unparseable expression is a permanent condition, not a transient
            // one — re-arming would spin. `cron()` validates before it ever
            // writes a row, so reaching here means the row predates this process
            // (a database written by an older build).
            return;
        }

        const timer = setTimeout(
            () => {
                cronTimers.delete(row.key);

                (async (): Promise<void> => {
                    try {
                        await options.onDispatch?.(row.function_path, deserialize(row.args) as Record<string, unknown>, { attempts: 0, id: row.key });
                    } catch {
                        // See the docstring: a dropped tick must not stop the schedule.
                    }

                    // `closed` checked alongside `isOpen()`: a tick that lands
                    // during `dispose()` must not arm the next one, since that
                    // timer would be minted after `cronTimers` was cleared.
                    if (!closed && isOpen()) {
                        armCron(row);
                    }
                })().catch(() => {
                    // Unreachable — the body catches its own dispatch failure —
                    // but an unhandled rejection here would take the process down.
                });
            },
            Math.max(0, nextAt - Date.now()),
        );

        cronTimers.set(row.key, timer);
    };

    const scheduler: SchedulerHost = {
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract's cancel is async so a real host can await I/O; better-sqlite3 is synchronous
        cancel: async (id) => {
            if (closed) {
                // Answers `false` for the same reason cancelling an unknown id
                // does — there is nothing on its way that this call stopped.
                // Not a throw, so teardown-order races stay benign (see
                // `NodePlatform.close()`, which disposes the scheduler first).
                return false;
            }

            clearJobTimer(id);

            // Scoped to `state = 'pending'` so cancelling a *parked* job reports
            // `false`. A dead-lettered job is no longer on its way — answering
            // `true` would tell a caller it stopped a delivery that had already
            // permanently failed.
            return deletePendingJob.run(id).changes > 0;
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
        cron: async (expression, functionPath, args) => {
            if (closed) {
                throw new Error("platform closed: cannot register a cron");
            }

            // Parse before writing: an invalid expression must fail the caller's
            // await rather than land a row that can never be armed.
            CronExpressionParser.parse(expression);

            const row: CronRow = {
                args: serialize(args ?? {}),
                expression,
                function_path: functionPath,
                key: `${expression} ${functionPath}`,
            };

            upsertCron.run(row.key, row.expression, row.function_path, row.args);
            armCron(row);
        },

        deadLetter: {
            // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
            list: async () => (closed || !isOpen() ? [] : selectByState.all("dead").map((row) => toStatus(row))),
            // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
            requeue: async (id) => {
                if (closed || !isOpen()) {
                    // Same answer the `list` guard above gives for a closed or
                    // closed-over connection: nothing was moved, and teardown
                    // code must not receive a `TypeError` from better-sqlite3.
                    return false;
                }

                // "Due immediately" rather than the original `scheduled_for`,
                // which is by definition in the past by the time an operator
                // requeues it: recovering a parked job means trying it now, and
                // re-arming an elapsed timestamp is the same thing said less
                // clearly.
                const dueAt = Date.now();

                if (requeueJob.run(dueAt, id).changes === 0) {
                    return false;
                }

                armJob(id, dueAt);

                return true;
            },
        },

        // Empty after `dispose()` rather than a query against a possibly-closed
        // connection: a disposed host has nothing on its way, and teardown code
        // that lists during shutdown must not get a `TypeError` from better-sqlite3.
        // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
        list: async () => (closed || !isOpen() ? [] : selectByState.all("pending").map((row) => toStatus(row))),

        // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
        schedule: async (functionPath, args, scheduleOptions) => {
            if (closed) {
                throw new Error("platform closed: cannot schedule a job");
            }

            // A UUID rather than a per-process counter: the counter restarted
            // at 0 on every construction, and rows persist in
            // `_lunora_scheduler_jobs` — so a second host over the same
            // database re-minted `node-job-1` and blew the PRIMARY KEY on the
            // INSERT. A UUID cannot collide with a persisted row.
            const id = `node-job-${randomUUID()}`;
            let scheduledFor: number;

            if (scheduleOptions?.at === undefined) {
                scheduledFor = Date.now() + (scheduleOptions?.delayMs ?? 0);
            } else {
                scheduledFor = typeof scheduleOptions.at === "number" ? scheduleOptions.at : scheduleOptions.at.getTime();
            }

            // eslint-disable-next-line unicorn/no-null -- writing SQL NULL into the nullable `retry` BLOB column; better-sqlite3 has no other spelling for it
            insertJob.run(id, functionPath, serialize(args), scheduledFor, scheduleOptions?.retry === undefined ? null : serialize(scheduleOptions.retry));
            armJob(id, scheduledFor);

            const job: ScheduledJob = { id, scheduledFor };

            return job;
        },
    };

    // Re-arm everything the last process left behind. This is the loop that
    // makes the durability claim true rather than aspirational — without it the
    // rows above are a log of work nobody will ever do.
    for (const row of selectByState.all("pending")) {
        armJob(row.id, row.scheduled_for);
    }

    for (const row of selectCrons.all()) {
        armCron(row);
    }

    return {
        dispose: () => {
            for (const timer of jobTimers.values()) {
                clearTimeout(timer);
            }

            for (const timer of cronTimers.values()) {
                clearTimeout(timer);
            }

            jobTimers.clear();
            cronTimers.clear();
            closed = true;
        },
        scheduler,
        // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
        simulateDeadLetter: async (id) => {
            const row = selectJob.get(id);

            if (row?.state !== "pending") {
                return false;
            }

            clearJobTimer(id);

            const retry = decodeRetry(row.retry);

            parkJob.run((retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts) + 1, id);

            return true;
        },
    };
};

export type { NodeSchedulerHost, NodeSchedulerHostOptions };
export { createNodeSchedulerHost };
