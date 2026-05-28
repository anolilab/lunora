import type { ArgsOf, CirrusSchedulerOptions, FunctionReference, RunOptions, Scheduler } from "./types.js";

const callDO = async <T>(options: CirrusSchedulerOptions, path: string, body: unknown): Promise<T> => {
    const stub = options.namespace.get(options.namespace.idFromName(options.instanceName ?? "default"));
    const response = await stub.fetch(`https://scheduler.internal${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const text = await response.text();

        throw new Error(`@cirrus/scheduler: SchedulerDO ${path} failed (${response.status}): ${text}`);
    }

    return (await response.json()) as T;
};

/**
 * Client-side scheduler — forwards `runAfter` / `runAt` / `cancel` calls to a
 * `SchedulerDO` over HTTP. The DO owns the alarm and the storage; this is a
 * thin RPC wrapper.
 */
export const createScheduler = (options: CirrusSchedulerOptions): Scheduler => {
    if (!options.namespace) {
        throw new Error("@cirrus/scheduler: `namespace` (SchedulerDO binding) is required");
    }

    if (!options.originUrl) {
        throw new Error("@cirrus/scheduler: `originUrl` is required so the DO can dispatch back to the Worker");
    }

    const runAt = async <F extends FunctionReference>(
        date: Date | number,
        fn: F,
        args: ArgsOf<F>,
        opts: RunOptions = {},
    ): Promise<{ id: string; scheduledFor: number }> => {
        const scheduledFor = date instanceof Date ? date.getTime() : date;

        return callDO<{ id: string; scheduledFor: number }>(options, "/schedule", {
            functionPath: fn.__cirrusRef,
            args,
            scheduledFor,
            shardKey: opts.shardKey,
            originUrl: options.originUrl,
        });
    };

    const runAfter = async <F extends FunctionReference>(
        delayMs: number,
        fn: F,
        args: ArgsOf<F>,
        opts: RunOptions = {},
    ): Promise<{ id: string; scheduledFor: number }> => {
        if (!Number.isFinite(delayMs) || delayMs < 0) {
            throw new Error("@cirrus/scheduler: `delayMs` must be a non-negative finite number");
        }

        return runAt(Date.now() + delayMs, fn, args, opts);
    };

    const cancel = async (id: string): Promise<{ cancelled: boolean }> => callDO<{ cancelled: boolean }>(options, "/cancel", { id });

    return { runAfter, runAt, cancel };
};
