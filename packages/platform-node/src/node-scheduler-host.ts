/**
 * Node adapter: an in-process job table satisfying the provider-neutral
 * `@lunora/platform` `SchedulerHost` contract.
 *
 * **This is the one contract this package cannot honestly hold as "hardened
 * toward a real implementation."** `SchedulerHost`'s docstring promises
 * "durable persistence — scheduled jobs survive host recycling" and, through
 * its optional dead-letter member, at-least-once delivery. On Cloudflare,
 * `SchedulerDO` backs both with alarms on Durable Object storage: the
 * platform re-delivers an alarm to a freshly-woken DO even after the process
 * that scheduled it is long gone. This host has neither: nothing re-arms a
 * `setTimeout` after `node` restarts and there is no host-level daemon to hand
 * that job to, AND its armed timer never dispatches the scheduled function at
 * all — the timer body is bookkeeping deletion, not delivery. Persisting the
 * job row to SQLite without something to re-arm it on process start would be
 * worse than this in-memory implementation: it would report a job as
 * "pending" forever after a restart that will in fact never fire. Per plan
 * 267, this host's `scheduler` entry in the Node capability matrix is rated
 * `"unsupported"` (not `"emulated"`) precisely because jobs are never
 * dispatched, and the contract's dead-letter member — the documented
 * at-least-once claim — is omitted below rather than declared falsely. This
 * is filed as a finding, not silently worked around — see
 * `plans/234-node-host-findings.md`.
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

export interface NodeSchedulerHost {
    /**
     * Clear every `setTimeout` this host has armed (every job still in
     * `pending`), and put the host into a terminal, closed state: after this
     * runs, `schedule()` throws instead of arming a fresh timer nothing would
     * ever clear (the exact handle-leak class this disposer exists to
     * eliminate). Call it on teardown: an armed job timer is a handle that
     * keeps the event loop (and, transitively, the process) alive until it
     * fires, so leaving it uncleared on shutdown is what produces the "worker
     * process failed to exit gracefully" delay.
     */
    dispose: () => void;
    scheduler: SchedulerHost;
}

/** Build the in-process scheduler. */
export const createNodeSchedulerHost = (): NodeSchedulerHost => {
    const pending = new Map<string, NodeJob>();
    let closed = false;
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
                // Also covers "closed": `dispose()` empties `pending`, so a
                // cancel after close answers `false` for the same reason a
                // cancel of an unknown id does — no throw needed, since this
                // keeps teardown-order races benign (see `NodePlatform.close()`).
                return false;
            }

            clearTimeout(job.timer);
            pending.delete(id);

            return true;
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
        list: async () => [...pending].map(([id, job]) => toStatus(id, job)),
        // eslint-disable-next-line @typescript-eslint/require-await -- see `cancel`
        schedule: async (functionPath, args, options) => {
            if (closed) {
                throw new Error("platform closed: cannot schedule a job");
            }

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

            pending.clear();
            closed = true;
        },
        scheduler,
    };
};
