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
 * `namespace` is required by the type, but a JS caller can omit it (exercised
 * by `createScheduler({} as never)` in the tests).
 */
const assertSchedulerOptions = (options: LunoraSchedulerOptions): void => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
    if (!options.namespace) {
        throw new LunoraError("INTERNAL", "@lunora/scheduler: `namespace` (SchedulerDO binding) is required");
    }
};

const schedulerStub = (options: LunoraSchedulerOptions): ReturnType<DurableObjectNamespaceLike["get"]> => {
    const namespace = applyJurisdiction(options.namespace, options.jurisdiction);

    return namespace.get(namespace.idFromName(options.instanceName ?? "default"));
};

/**
 * Re-raise a non-2xx SchedulerDO response as the error the DO actually answered.
 *
 * The DO refuses with a coded envelope — `{ error: { code, message } }`, the
 * shape `SchedulerDO.error` writes — and every one of those codes is a sentence
 * the caller can act on: `DUPLICATE_SCHEDULE_ID` says cancel the existing job
 * first, `ORIGIN_NOT_CONFIGURED` names a missing binding. Re-wrapping the lot as
 * `INTERNAL` destroyed exactly that: `toErrorBody` replaces an internal-coded
 * message with "Internal error", so a developer who named a job id twice was
 * told nothing at all.
 *
 * A response that is not that envelope — a transport failure, an HTML error page
 * from something in front of the DO, a truncated body — has no code to carry, so
 * it stays `INTERNAL` with the status and body text attached.
 */
const raiseDOFailure = (path: string, status: number, text: string): never => {
    let code: unknown;
    let message: unknown;

    try {
        ({ code, message } = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error ?? {});
    } catch {
        // Not JSON: falls through to the INTERNAL wrap below.
    }

    if (typeof code === "string" && code.length > 0) {
        throw new LunoraError(code, typeof message === "string" && message.length > 0 ? message : `@lunora/scheduler: SchedulerDO ${path} failed`, { status });
    }

    throw new LunoraError("INTERNAL", `@lunora/scheduler: SchedulerDO ${path} failed (${String(status)}): ${text}`);
};

const requestDO = async <T>(options: LunoraSchedulerOptions, path: string, init: RequestInit): Promise<T> => {
    const stub = schedulerStub(options);
    const response = await stub.fetch(`https://scheduler.internal${path}`, init);

    if (!response.ok) {
        raiseDOFailure(path, response.status, await response.text());
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
