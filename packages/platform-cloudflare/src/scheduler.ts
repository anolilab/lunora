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

import type { ScheduledJob, ScheduleOptions, SchedulerHost } from "@lunora/platform";
import { createScheduler } from "@lunora/scheduler";

/** What the Cloudflare scheduler host needs from the Worker's environment. */
interface CloudflareSchedulerOptions {
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

    /** The `SchedulerDO` namespace binding. */
    namespace: Parameters<typeof createScheduler>[0]["namespace"];

    /**
     * Public origin the Worker is mounted at. `SchedulerDO` dispatches back to
     * this base URL when an alarm fires, so a wrong value means jobs fire into
     * nothing.
     */
    originUrl: string;
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
const createCloudflareScheduler = (options: CloudflareSchedulerOptions): SchedulerHost => {
    const scheduler = createScheduler({
        instanceName: options.instanceName,
        jurisdiction: options.jurisdiction,
        namespace: options.namespace,
        originUrl: options.originUrl,
    });

    return {
        cancel: async (id) => {
            const { cancelled } = await scheduler.cancel(id);

            return cancelled;
        },

        schedule: async (functionPath, args, scheduleOptions) => {
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
            ) => Promise<ScheduledJob>;

            // A single absolute instant, which is how the contract reads once
            // `at`/`delayMs` are collapsed — one path, not a branch per shape.
            return runAt(resolveScheduledFor(scheduleOptions), functionPath, args, {
                retry: scheduleOptions?.retry,
                shardKey: scheduleOptions?.shardKey,
            });
        },
    };
};

export type { CloudflareSchedulerOptions };
export { createCloudflareScheduler };
