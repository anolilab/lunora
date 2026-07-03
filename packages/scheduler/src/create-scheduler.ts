import { LunoraError } from "@lunora/errors";

import applyJurisdiction from "./jurisdiction";
import type { ArgsOf, FunctionReference, LunoraSchedulerOptions, RunOptions, Scheduler, ScheduleRecord } from "./types";

const schedulerStub = (options: LunoraSchedulerOptions) => {
    const namespace = applyJurisdiction(options.namespace, options.jurisdiction);

    return namespace.get(namespace.idFromName(options.instanceName ?? "default"));
};

const callDO = async <T>(options: LunoraSchedulerOptions, path: string, body: unknown): Promise<T> => {
    const stub = schedulerStub(options);
    const response = await stub.fetch(`https://scheduler.internal${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        const text = await response.text();

        throw new LunoraError("INTERNAL", `@lunora/scheduler: SchedulerDO ${path} failed (${String(response.status)}): ${text}`);
    }

    return await response.json();
};

const getDO = async <T>(options: LunoraSchedulerOptions, path: string): Promise<T> => {
    const stub = schedulerStub(options);
    const response = await stub.fetch(`https://scheduler.internal${path}`, { method: "GET" });

    if (!response.ok) {
        const text = await response.text();

        throw new LunoraError("INTERNAL", `@lunora/scheduler: SchedulerDO ${path} failed (${String(response.status)}): ${text}`);
    }

    return await response.json();
};

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

    const runAt = async <F extends FunctionReference>(
        date: Date | number,
        function_: F,
        args: ArgsOf<F>,
        options_: RunOptions = {},
    ): Promise<{ id: string; scheduledFor: number }> => {
        const scheduledFor = date instanceof Date ? date.getTime() : date;

        return callDO<{ id: string; scheduledFor: number }>(options, "/schedule", {
            args,
            functionPath: function_.__lunoraRef,
            originUrl: options.originUrl,
            // Optional workpool / retry-policy passthrough. Absent for ordinary
            // `runAfter`/`runAt` calls, which keeps the wire payload (and the
            // DO's behaviour) identical to before this feature.
            pool: options_.pool,
            retry: options_.retry,
            scheduledFor,
            shardKey: options_.shardKey,
        });
    };

    const runAfter = async <F extends FunctionReference>(
        delayMs: number,
        function_: F,
        args: ArgsOf<F>,
        options_: RunOptions = {},
    ): Promise<{ id: string; scheduledFor: number }> => {
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            throw new LunoraError("INTERNAL", "@lunora/scheduler: `delayMs` must be a non-negative finite number");
        }

        return runAt(Date.now() + delayMs, function_, args, options_);
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

    return { cancel, get, list, runAfter, runAt };
};

export default createScheduler;
