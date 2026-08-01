/**
 * Node adapter: an in-process job table satisfying the provider-neutral
 * `@lunora/platform` `SchedulerHost` contract.
 *
 * **This is the one contract this package cannot honestly hold as "hardened
 * toward a real implementation."** `SchedulerHost`'s docstring promises
 * "durable persistence — scheduled jobs survive host recycling." On
 * Cloudflare, `SchedulerDO` backs this with alarms on Durable Object storage:
 * the platform re-delivers an alarm to a freshly-woken DO even after the
 * process that scheduled it is long gone. A plain Node process has no
 * equivalent — nothing re-arms a `setTimeout` after `node` restarts, and there
 * is no host-level daemon to hand that job to. Persisting the job row to
 * SQLite without something to re-arm it on process start would be *worse* than
 * this in-memory implementation: it would report a job as "pending" forever
 * after a restart that will in fact never fire. This is filed as a finding,
 * not silently worked around — see `plans/234-node-host-findings.md`.
 *
 * `cron` is omitted, matching Cloudflare (whose crons are declared in
 * `wrangler.jsonc`, not registered at runtime) — but for the opposite reason:
 * Cloudflare could not add dynamic registration even if it wanted to, while a
 * Node host technically could (a real cron parser + `setInterval`), and this
 * spike deliberately does not build one. Wiring a dev-time cron runner is a
 * `lunora dev` concern, out of this plan's scope.
 */

import type { ScheduledJobStatus, ScheduleOptions, SchedulerHost } from "@lunora/platform";

interface NodeJob {
    args: Record<string, unknown>;
    attempts: number;
    functionPath: string;
    options: ScheduleOptions;
    scheduledFor: number;
    timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Test-only hook the TCK's dead-letter legs need: force a pending job straight
 * to "exhausted its retry budget" without waiting out a real retry schedule.
 */
export interface NodeSchedulerHost {
    /**
     * Clear every `setTimeout` this host has armed (every job still in
     * `pending`). Dead-lettered jobs never carry a live timer — their `timer`
     * is always `undefined` by the time they land in `dead` — so this only
     * needs to walk `pending`. Call it on teardown: an armed job timer is a
     * handle that keeps the event loop (and, transitively, the process) alive
     * until it fires, so leaving it uncleared on shutdown is what produces the
     * "worker process failed to exit gracefully" delay.
     */
    dispose: () => void;
    scheduler: SchedulerHost;
    simulateDeadLetter: (id: string) => Promise<boolean>;
}

/** Build the in-process scheduler. */
export const createNodeSchedulerHost = (): NodeSchedulerHost => {
    const pending = new Map<string, NodeJob>();
    const dead = new Map<string, NodeJob>();
    let counter = 0;

    const nextId = (): string => {
        counter += 1;

        return `node-job-${String(counter)}`;
    };

    const toStatus = (id: string, job: NodeJob): ScheduledJobStatus => {
        return {
            attempts: job.attempts,
            functionPath: job.functionPath,
            id,
            scheduledFor: job.scheduledFor,
        };
    };

    const scheduler: SchedulerHost = {
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract's cancel is async so a real host can await I/O; this one is synchronous state
        cancel: async (id) => {
            const job = pending.get(id);

            if (job === undefined) {
                return false;
            }

            clearTimeout(job.timer);
            pending.delete(id);

            return true;
        },
        deadLetter: {
            // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
            list: async () => [...dead].map(([id, job]) => toStatus(id, job)),
            // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
            requeue: async (id) => {
                const job = dead.get(id);

                if (job === undefined) {
                    return false;
                }

                dead.delete(id);
                // A fresh attempt budget is the point of a requeue — see the
                // `SchedulerHost.deadLetter` docstring. Note the job is NOT
                // re-armed with a live `setTimeout` here: it re-enters `pending`
                // with its original `scheduledFor`, which is almost certainly in
                // the past by the time an operator requeues it. That mirrors "due
                // immediately" rather than firing an already-elapsed timer.
                pending.set(id, { ...job, attempts: 0, timer: undefined });

                return true;
            },
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
        list: async () => [...pending].map(([id, job]) => toStatus(id, job)),
        // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
        schedule: async (functionPath, args, options) => {
            const id = nextId();
            let scheduledFor: number;

            if (options?.at === undefined) {
                scheduledFor = Date.now() + (options?.delayMs ?? 0);
            } else {
                scheduledFor = typeof options.at === "number" ? options.at : options.at.getTime();
            }

            const delay = Math.max(0, scheduledFor - Date.now());
            const timer = setTimeout(() => {
                pending.delete(id);
            }, delay);

            pending.set(id, { args, attempts: 0, functionPath, options: options ?? {}, scheduledFor, timer });

            return { id, scheduledFor };
        },
    };

    return {
        dispose: () => {
            for (const job of pending.values()) {
                clearTimeout(job.timer);
            }
        },
        scheduler,
        // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
        simulateDeadLetter: async (id) => {
            const job = pending.get(id);

            if (job === undefined) {
                return false;
            }

            clearTimeout(job.timer);
            pending.delete(id);
            dead.set(id, { ...job, attempts: (job.options.retry?.maxAttempts ?? 5) + 1, timer: undefined });

            return true;
        },
    };
};
