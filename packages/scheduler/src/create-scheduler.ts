import { LunoraError } from "@lunora/errors";

import { callDO, getDO } from "./do-client";
import type { CronTarget, LunoraSchedulerOptions, RunOptions, Scheduler, ScheduleRecord, ScheduleTargetArgs } from "./types";
import { isWorkflowReference } from "./types";

/**
 * Client-side scheduler — forwards `runAfter` / `runAt` / `cancel` calls to a
 * `SchedulerDO` over HTTP. The DO owns the alarm and the storage; this is a
 * thin RPC wrapper.
 */
const createScheduler = (options: LunoraSchedulerOptions): Scheduler => {
    // Defensive runtime guard: required by the type, but JS callers can omit it
    // (exercised by createScheduler({} as never) in the tests).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
    if (!options.namespace) {
        throw new LunoraError("INTERNAL", "@lunora/scheduler: `namespace` (SchedulerDO binding) is required");
    }

    if (!options.originUrl) {
        throw new LunoraError("INTERNAL", "@lunora/scheduler: `originUrl` is required so the DO can dispatch back to the Worker");
    }

    const runAt = async <T extends CronTarget>(
        date: Date | number,
        target: T,
        args: ScheduleTargetArgs<T>,
        options_: RunOptions = {},
    ): Promise<{ id: string; scheduledFor: number }> => {
        const scheduledFor = date instanceof Date ? date.getTime() : date;

        // Shared envelope; the target-specific field (`functionPath` xor
        // `workflow`) is merged in below. Optional workpool / retry-policy
        // passthrough is absent for ordinary calls, keeping the wire payload (and
        // the DO's behaviour) identical to before this feature.
        const base = {
            args,
            originUrl: options.originUrl,
            pool: options_.pool,
            retry: options_.retry,
            scheduledFor,
            shardKey: options_.shardKey,
        };

        if (isWorkflowReference(target)) {
            // A workflow/agent target starts a fresh durable instance on fire; carry
            // its `WORKFLOW_*`/`AGENT_*` binding so the runtime can `create()` it.
            if (typeof target.binding !== "string" || target.binding.length === 0) {
                throw new LunoraError(
                    "INTERNAL",
                    "@lunora/scheduler: workflow/agent schedule target is missing its `binding` — pass the generated `workflows.<name>` / `agents.<name>` reference",
                );
            }

            return callDO<{ id: string; scheduledFor: number }>(options, "/schedule", { ...base, workflow: target.binding });
        }

        // A bare string reaches here via the public string-typed `ctx.scheduler`
        // surface (`createScheduler(...) as SchedulerLike`); a FunctionReference
        // carries the path under `__lunoraRef`.
        const functionPath = typeof (target as unknown) === "string" ? (target as unknown as string) : target.__lunoraRef;

        return callDO<{ id: string; scheduledFor: number }>(options, "/schedule", { ...base, functionPath });
    };

    const runAfter = async <T extends CronTarget>(
        delayMs: number,
        target: T,
        args: ScheduleTargetArgs<T>,
        options_: RunOptions = {},
    ): Promise<{ id: string; scheduledFor: number }> => {
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            throw new LunoraError("INTERNAL", "@lunora/scheduler: `delayMs` must be a non-negative finite number");
        }

        return runAt(Date.now() + delayMs, target, args, options_);
    };

    const cancel = async (id: string): Promise<{ cancelled: boolean }> => callDO<{ cancelled: boolean }>(options, "/cancel", { id });

    // The DO's `/list` returns `{ records: ScheduleRecord[] }` (the pending
    // `id:` headers). Surface the array directly to callers.
    const list = async (): Promise<ScheduleRecord[]> => {
        const body = await getDO<{ records?: ScheduleRecord[] }>(options, "/list");

        // Keep the return type honest (never `undefined`) if the DO ever responds
        // 200 without a `records` array.
        return Array.isArray(body.records) ? body.records : [];
    };

    // Direct single-record lookup against the DO's `GET /get?id=` route, which
    // reads the `id:<id>` storage key in O(1) — instead of scanning the whole
    // `/list` view. The DO omits `record` on a miss, which becomes `null` here.
    const get = async (id: string): Promise<ScheduleRecord | null> => {
        const body = await getDO<{ record?: ScheduleRecord }>(options, `/get?id=${encodeURIComponent(id)}`);

        // eslint-disable-next-line unicorn/no-null -- public contract returns `ScheduleRecord | null` (Convex `get` convention), not undefined
        return body.record ?? null;
    };

    // The DO's `/dead` returns the records parked by `recordRetry()` after their
    // retry budget was exhausted. They are deliberately absent from `/list` (the
    // park deletes the `id:` header), so this is the only view of a job that
    // failed permanently rather than being silently dropped.
    const dead = async (): Promise<ScheduleRecord[]> => {
        const body = await getDO<{ records?: ScheduleRecord[] }>(options, "/dead");

        return Array.isArray(body.records) ? body.records : [];
    };

    // `POST /dead/retry` resurrects a parked record with a fresh attempt budget.
    // A miss answers `{ retried: false }` rather than erroring, so a racing
    // double-recover is a no-op rather than a failure.
    const deadRetry = async (id: string): Promise<boolean> => {
        const { retried } = await callDO<{ retried?: boolean }>(options, "/dead/retry", { id });

        return retried === true;
    };

    return { cancel, dead, deadRetry, get, list, runAfter, runAt };
};

export default createScheduler;
