import { LunoraError } from "@lunora/errors";

import applyJurisdiction from "./jurisdiction";
import type { DurableObjectNamespaceLike, LunoraSchedulerOptions } from "./types";

/**
 * Resolve the `SchedulerDO` stub for a scheduler/workpool instance, applying any
 * configured data-residency jurisdiction. Shared verbatim by `createScheduler`
 * and `createWorkpool` — a workpool is just a named pool inside the SAME DO — so
 * the stub resolution, internal origin, and error shaping live here once instead
 * of drifting between two byte-identical copies. Typed on the common base
 * {@link LunoraSchedulerOptions}; `WorkpoolOptions` extends it, so both factories
 * pass their options straight through.
 */
const schedulerStub = (options: LunoraSchedulerOptions): ReturnType<DurableObjectNamespaceLike["get"]> => {
    const namespace = applyJurisdiction(options.namespace, options.jurisdiction);

    return namespace.get(namespace.idFromName(options.instanceName ?? "default"));
};

/** POST `body` to the SchedulerDO `path`, throwing a shaped `LunoraError` on any non-2xx. */
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

/** GET the SchedulerDO `path`, throwing a shaped `LunoraError` on any non-2xx. */
const getDO = async <T>(options: LunoraSchedulerOptions, path: string): Promise<T> => {
    const stub = schedulerStub(options);
    const response = await stub.fetch(`https://scheduler.internal${path}`, { method: "GET" });

    if (!response.ok) {
        const text = await response.text();

        throw new LunoraError("INTERNAL", `@lunora/scheduler: SchedulerDO ${path} failed (${String(response.status)}): ${text}`);
    }

    return await response.json();
};

export { callDO, getDO, schedulerStub };
