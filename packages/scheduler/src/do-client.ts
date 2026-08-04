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

/**
 * Defensive runtime guard shared by `createScheduler` and `createWorkpool`:
 * `namespace` / `originUrl` are required by the type, but JS callers can omit
 * them (exercised by `createScheduler({} as never)` in the tests).
 */
const assertSchedulerOptions = (options: LunoraSchedulerOptions): void => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
    if (!options.namespace) {
        throw new LunoraError("INTERNAL", "@lunora/scheduler: `namespace` (SchedulerDO binding) is required");
    }

    if (!options.originUrl) {
        throw new LunoraError("INTERNAL", "@lunora/scheduler: `originUrl` is required so the DO can dispatch back to the Worker");
    }
};

const schedulerStub = (options: LunoraSchedulerOptions): ReturnType<DurableObjectNamespaceLike["get"]> => {
    const namespace = applyJurisdiction(options.namespace, options.jurisdiction);

    return namespace.get(namespace.idFromName(options.instanceName ?? "default"));
};

const requestDO = async <T>(options: LunoraSchedulerOptions, path: string, init: RequestInit): Promise<T> => {
    const stub = schedulerStub(options);
    const response = await stub.fetch(`https://scheduler.internal${path}`, init);

    if (!response.ok) {
        const text = await response.text();

        throw new LunoraError("INTERNAL", `@lunora/scheduler: SchedulerDO ${path} failed (${String(response.status)}): ${text}`);
    }

    return await response.json();
};

/** POST `body` to the SchedulerDO `path`, throwing a shaped `LunoraError` on any non-2xx. */
const callDO = async <T>(options: LunoraSchedulerOptions, path: string, body: unknown): Promise<T> =>
    requestDO<T>(options, path, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

/** GET the SchedulerDO `path`, throwing a shaped `LunoraError` on any non-2xx. */
const getDO = async <T>(options: LunoraSchedulerOptions, path: string): Promise<T> => requestDO<T>(options, path, { method: "GET" });

export { assertSchedulerOptions, callDO, getDO, schedulerStub };
