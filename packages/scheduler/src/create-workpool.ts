import { LunoraError } from "@lunora/errors";

import { assertSchedulerOptions, callDO, getDO } from "./do-client";
import type { ArgsOf, EnqueueOptions, FunctionReference, Workpool, WorkpoolOptions } from "./types";
import assertScheduleDelay from "./validate-delay";

/**
 * Bounded-concurrency action queue — the Lunora equivalent of
 * `@convex-dev/workpool`. Mirrors `createScheduler`'s `namespace` /
 * `originUrl` / `instanceName` options and is built on the SAME `SchedulerDO`:
 * a workpool is just a NAMED logical pool inside that DO (concurrency counter
 * keyed by {@link WorkpoolOptions.name} under the `pool:<name>` storage key).
 * It needs no extra Durable Object or wrangler binding beyond the SchedulerDO
 * the scheduler already uses.
 *
 * `enqueue` schedules a job tagged with this pool; the DO dispatches at most
 * `maxConcurrency` of the pool's jobs at once and queues the rest durably,
 * draining them as the runtime reports completions (`POST /complete`).
 *
 * ```ts
 * const pool = createWorkpool({ namespace: env.SCHEDULER, originUrl, maxConcurrency: 5 });
 * await pool.enqueue(internal.stripe.sync, { invoiceId }, { retry: { maxAttempts: 3 } });
 * ```
 *
 * Why not Cloudflare Queues? Queues natively cover concurrency-capped, retried,
 * dead-lettered, delayed dispatch (`max_concurrency`, `max_retries`,
 * `retry({ delaySeconds })`, `dead_letter_queue`), and are the right tool when
 * you just want to rate-limit fire-and-forget background work. This workpool
 * deliberately stays on `SchedulerDO` because it offers what a queue can't: a
 * hard concurrency cap (the DO is the single serialization point — no
 * cross-consumer overshoot), per-job cancellation, and per-job status
 * introspection, all keyed by a stable job id. Reach for Queues when you don't
 * need those; reach for this when you do. Either way, do NOT grow multi-step
 * orchestration on top of this — that's Cloudflare **Workflows** (`step.do` /
 * `step.sleep` / `step.waitForEvent`).
 */
const createWorkpool = (options: WorkpoolOptions): Workpool => {
    assertSchedulerOptions(options);

    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency <= 0) {
        throw new LunoraError("INTERNAL", "@lunora/scheduler: `maxConcurrency` must be a positive integer");
    }

    const name = typeof options.name === "string" && options.name.length > 0 ? options.name : "default";

    const enqueue = async <F extends FunctionReference>(
        function_: F,
        args: ArgsOf<F>,
        options_: EnqueueOptions = {},
    ): Promise<{ id: string; scheduledFor: number }> => {
        const delayMs = options_.delayMs ?? 0;

        assertScheduleDelay(delayMs, "workpool.enqueue");

        return callDO<{ id: string; scheduledFor: number }>(options, "/schedule", {
            // Wire-encoded by `callDO`, same as `createScheduler.runAt` — a pooled
            // job takes the identical `/schedule` route to the identical
            // shard-side `decodeWire`.
            args,
            functionPath: function_.__lunoraRef,
            instanceName: options.instanceName ?? "default",
            maxConcurrency: options.maxConcurrency,
            originUrl: options.originUrl,
            pool: name,
            retry: options_.retry,
            scheduledFor: Date.now() + delayMs,
            shardKey: options_.shardKey,
        });
    };

    const cancel = async (id: string): Promise<{ cancelled: boolean }> => callDO<{ cancelled: boolean }>(options, "/cancel", { id });

    const status = async (): Promise<{ inFlight: number; maxConcurrency: number; queued: number }> =>
        getDO<{ inFlight: number; maxConcurrency: number; queued: number }>(options, `/pool?name=${encodeURIComponent(name)}`);

    return { cancel, enqueue, name, status };
};

export default createWorkpool;
