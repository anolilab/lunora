/**
 * Cloudflare's {@link SchedulerHost}: durable delayed jobs backed by
 * `SchedulerDO`.
 *
 * This is an adapter, not a reimplementation. `@lunora/scheduler`'s
 * `createScheduler` already owns the RPC to `SchedulerDO` — stub resolution,
 * jurisdiction pinning, origin validation, error shaping — so this maps the
 * neutral contract onto that client rather than talking to the DO directly.
 * Duplicating the RPC would fork two copies of the schedule wire format.
 *
 * **`cron` is deliberately absent.** Cloudflare cron triggers live in
 * `wrangler.jsonc`'s `triggers.crons` and are reconciled at build time by
 * `@lunora/config`; no runtime call can add one. `SchedulerHost.cron` is
 * therefore optional, and omitting it is the honest signal — the same
 * convention `SocketHost.setTag` uses for tagging a host cannot do. A caller
 * that finds it absent must declare the schedule in `lunora/crons.ts` instead,
 * which is where it belongs on this target anyway.
 */

import type { ScheduledJob, ScheduledJobStatus, ScheduleOptions, SchedulerHost } from "@lunora/platform";

import createScheduler from "./create-scheduler";
import type { ScheduleRecord } from "./types";

/** What the Cloudflare scheduler host needs from the Worker's environment. */
interface SchedulerHostOptions {
    /**
     * Named scheduler instance — one `SchedulerDO` per name, useful for tenant
     * isolation. Defaults to `"default"`.
     */
    instanceName?: string;

    /**
     * Data-residency jurisdiction for the `SchedulerDO`. Pass the same value as
     * the worker's own jurisdiction so scheduled state co-resides with app data.
     */
    jurisdiction?: "eu" | "fedramp" | "us";

    /**
     * The `SchedulerDO` namespace binding.
     *
     * The origin the DO dispatches back to is not configured here — it reads
     * `env.LUNORA_ORIGIN_URL` off its own binding at fire time, so a wrong value
     * there (or none) is what makes jobs fire into nothing.
     */
    namespace: Parameters<typeof createScheduler>[0]["namespace"];
}

/**
 * Resolve the absolute epoch-millisecond instant a job should fire at.
 *
 * `at` wins over `delayMs` per the contract, and an absent pair means "as soon
 * as possible" — expressed as now, since `SchedulerDO` indexes by timestamp and
 * has no separate immediate queue.
 */
const resolveScheduledFor = (options: ScheduleOptions | undefined): number => {
    if (options?.at !== undefined) {
        return typeof options.at === "number" ? options.at : options.at.getTime();
    }

    return Date.now() + (options?.delayMs ?? 0);
};

/**
 * Build the Cloudflare {@link SchedulerHost}.
 *
 * The returned host has no `cron` member — see the module docstring.
 */
const createSchedulerHost = (options: SchedulerHostOptions): SchedulerHost => {
    const scheduler = createScheduler({
        instanceName: options.instanceName,
        jurisdiction: options.jurisdiction,
        namespace: options.namespace,
    });

    /**
     * Project a `ScheduleRecord` onto the neutral status shape.
     *
     * `attempts` is absent until the first failure — the DO only writes it in
     * `recordRetry()` — so it reads as `0`, which is what "not yet retried"
     * means to a caller. A record targeting a workflow has no `functionPath`;
     * its `workflow` name is the dispatch target and is reported as such rather
     * than as an empty string.
     */
    const toStatus = (record: ScheduleRecord): ScheduledJobStatus => {
        return {
            attempts: record.attempts ?? 0,
            functionPath: record.functionPath ?? record.workflow ?? "",
            id: record.id,
            scheduledFor: record.scheduledFor,
        };
    };

    return {
        cancel: async (id) => {
            const { cancelled } = await scheduler.cancel(id);

            return cancelled;
        },

        deadLetter: {
            list: async () => {
                const records = await scheduler.dead();

                return records.map((record) => toStatus(record));
            },
            requeue: async (id) => scheduler.deadRetry(id),
        },

        list: async () => {
            const records = await scheduler.list();

            return records.map((record) => toStatus(record));
        },

        schedule: async (functionPath, args, scheduleOptions): Promise<ScheduledJob> => {
            // `runAt` is generic over its target so it can infer the arg shape
            // from a typed `FunctionReference` / `WorkflowReference`. The neutral
            // contract deals in an opaque path plus a `Record`, which is that
            // generic already erased — so it is bypassed once, here at the
            // boundary, rather than leaking an `as never` onto every argument.
            const runAt = scheduler.runAt as (
                date: number,
                target: string,
                args: Record<string, unknown>,
                options?: { retry?: ScheduleOptions["retry"]; shardKey?: string },
            ) => Promise<string>;

            // A single absolute instant, which is how the contract reads once
            // `at`/`delayMs` are collapsed — one path, not a branch per shape.
            const scheduledFor = resolveScheduledFor(scheduleOptions);
            // `runAt` resolves the id (the `ctx.scheduler` contract); the
            // instant it fires at is the one we just handed it, so the
            // contract's `ScheduledJob` is assembled here rather than read back.
            const id = await runAt(scheduledFor, functionPath, args, {
                retry: scheduleOptions?.retry,
                shardKey: scheduleOptions?.shardKey,
            });

            return { id, scheduledFor };
        },
    };
};

export type { SchedulerHostOptions };
export { createSchedulerHost };
