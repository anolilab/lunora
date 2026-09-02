import { LunoraError } from "@lunora/errors";

import { collectPages } from "../../../shared/collect-pages";
import { assertSchedulerOptions, callDO, getDO } from "./do-client";
import type { CronTarget, LunoraSchedulerOptions, RunOptions, Scheduler, ScheduleRecord, ScheduleTargetArgs } from "./types";
import { isWorkflowReference } from "./types";
import assertScheduleDelay from "./validate-delay";

/**
 * Client-side scheduler — forwards `runAfter` / `runAt` / `cancel` calls to a
 * `SchedulerDO` over HTTP. The DO owns the alarm and the storage; this is a
 * thin RPC wrapper.
 */
const createScheduler = (options: LunoraSchedulerOptions): Scheduler => {
    assertSchedulerOptions(options);

    // Resolves the job id, not the `{ id, scheduledFor }` record the DO answers
    // with: this object is installed as `ctx.scheduler`, whose contract
    // (`SchedulerLike` in @lunora/shard-engine, `Scheduler` in @lunora/server,
    // `ctx.scheduler` in @lunora/runtime, and the docs) is `Promise<string>`.
    // The DO's `scheduledFor` echoes what the caller passed, so nothing is lost;
    // `get(id)` returns the full record for a caller that wants it back.
    const runAt = async <T extends CronTarget>(date: Date | number, target: T, args: ScheduleTargetArgs<T>, options_: RunOptions = {}): Promise<string> => {
        const scheduledFor = date instanceof Date ? date.getTime() : date;

        // Shared envelope; the target-specific field (`functionPath` xor
        // `workflow`) is merged in below.
        //
        // `instanceName` travels on EVERY call, pooled or not: the DO resolves
        // the pool's reserved slot against it, so omitting it made a job
        // scheduled on `tenant-a` release its slot on `default` — a slot leaked
        // per job (fatal at a cap of 1) plus a phantom pool row on the wrong
        // instance. `maxConcurrency` only means anything for a pooled job, so it
        // rides along only when `pool` is set (mirroring `createWorkpool`).
        const base = {
            args,
            // Pre-minted id, when the caller decided it before the call could be
            // made (see `RunOptions.id`). Absent for an ordinary schedule, and the
            // DO mints one.
            id: options_.id,
            instanceName: options.instanceName ?? "default",
            maxConcurrency: options_.pool === undefined ? undefined : options_.maxConcurrency,
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

            const scheduled = await callDO<{ id: string }>(options, "/schedule", { ...base, workflow: target.binding });

            return scheduled.id;
        }

        // A bare string reaches here via the public string-typed `ctx.scheduler`
        // surface (`createScheduler(...) as SchedulerLike`); a FunctionReference
        // carries the path under `__lunoraRef`.
        const functionPath = typeof (target as unknown) === "string" ? (target as unknown as string) : target.__lunoraRef;

        const scheduled = await callDO<{ id: string }>(options, "/schedule", { ...base, functionPath });

        return scheduled.id;
    };

    const runAfter = async <T extends CronTarget>(delayMs: number, target: T, args: ScheduleTargetArgs<T>, options_: RunOptions = {}): Promise<string> => {
        assertScheduleDelay(delayMs, "ctx.scheduler.runAfter");

        return runAt(Date.now() + delayMs, target, args, options_);
    };

    const cancel = async (id: string): Promise<{ cancelled: boolean }> => callDO<{ cancelled: boolean }>(options, "/cancel", { id });

    /**
     * Walk every page of a cursored DO list route (`/list`, `/dead`) and return
     * the whole set.
     *
     * The DO answers a BOUNDED page (`{ records, truncated, cursor }`) so a large
     * backlog is never serialized into one response. Returning just the first
     * page here — and dropping `truncated` on the floor — is a silent wrong
     * answer: `list()` backs `ctx.db.system.query("_scheduled_functions")
     * .collect()`, whose contract is "the full list of rows", so an app deduping
     * against its pending jobs reads clean past the page size and schedules
     * unbounded duplicates. Paging keeps that promise while each individual
     * response stays bounded.
     */
    const listAll = async (path: string): Promise<ScheduleRecord[]> =>
        await collectPages<ScheduleRecord>(async (cursor) =>
            getDO<{ cursor?: string; records?: ScheduleRecord[]; truncated?: boolean }>(
                options,
                cursor === undefined ? path : `${path}?cursor=${encodeURIComponent(cursor)}`,
            ),
        );

    // The DO's `/list` returns one bounded page of the pending `id:` headers;
    // `listAll` walks them all so callers see every pending job.
    const list = async (): Promise<ScheduleRecord[]> => listAll("/list");

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
    const dead = async (): Promise<ScheduleRecord[]> => listAll("/dead");

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
