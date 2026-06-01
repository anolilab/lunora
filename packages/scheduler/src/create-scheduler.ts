import type { ArgsOf, CirrusSchedulerOptions, FunctionReference, RunOptions, Scheduler } from "./types.js";

const callDO = async <T>(options: CirrusSchedulerOptions, path: string, body: unknown): Promise<T> => {
    const stub = options.namespace.get(options.namespace.idFromName(options.instanceName ?? "default"));
    const response = await stub.fetch(`https://scheduler.internal${path}`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

    if (!response.ok) {
        const text = await response.text();

        throw new Error(`@cirrus/scheduler: SchedulerDO ${path} failed (${String(response.status)}): ${text}`);
    }

    return await response.json();
};

/**
 * Client-side scheduler — forwards `runAfter` / `runAt` / `cancel` calls to a
 * `SchedulerDO` over HTTP. The DO owns the alarm and the storage; this is a
 * thin RPC wrapper.
 */
const createScheduler = (options: CirrusSchedulerOptions): Scheduler => {
    // Defensive runtime guard: required by the type, but JS callers can omit it
    // (exercised by createScheduler({} as never) in the tests).
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
    if (!options.namespace) {
        throw new Error("@cirrus/scheduler: `namespace` (SchedulerDO binding) is required");
    }

    if (!options.originUrl) {
        throw new Error("@cirrus/scheduler: `originUrl` is required so the DO can dispatch back to the Worker");
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
            functionPath: function_.__cirrusRef,
            originUrl: options.originUrl,
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
            throw new Error("@cirrus/scheduler: `delayMs` must be a non-negative finite number");
        }

        return runAt(Date.now() + delayMs, function_, args, options_);
    };

    const cancel = async (id: string): Promise<{ cancelled: boolean }> => callDO<{ cancelled: boolean }>(options, "/cancel", { id });

    return { cancel, runAfter, runAt };
};

export default createScheduler;
