import { LunoraError } from "@lunora/errors";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
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

/**
 * The single owner of what this package puts on, and takes off, the SchedulerDO
 * wire — as it already is of the URL, the headers, and the response checks.
 *
 * A job's `args` can hold a `bigint`, a `Date` or bytes, none of which survive
 * raw JSON: the first throws inside `JSON.stringify` before the job is ever
 * recorded, the second silently arrives as an ISO string. Bracketing the codec
 * here rather than at each caller is what keeps the two directions in step —
 * encoding at the producers alone left `list`/`get`/`dead` handing back the
 * tagged `["$lunora.wire$", …]` form, and every future route would have had to
 * remember both halves. Both codecs are the identity on pure JSON, so
 * `functionPath`, `scheduledFor`, `cursor` and friends are unchanged byte for
 * byte.
 */
const requestDO = async <T>(options: LunoraSchedulerOptions, path: string, init: RequestInit): Promise<T> => {
    const stub = schedulerStub(options);
    const response = await stub.fetch(`https://scheduler.internal${path}`, init);

    if (!response.ok) {
        raiseDOFailure(path, response.status, await response.text());
    }

    return decodeWire(await response.json()) as T;
};

/** POST `body` to the SchedulerDO `path`, throwing a shaped `LunoraError` on any non-2xx. */
const callDO = async <T>(options: LunoraSchedulerOptions, path: string, body: unknown): Promise<T> =>
    requestDO<T>(options, path, {
        body: JSON.stringify(encodeWire(body)),
        headers: { "content-type": "application/json" },
        method: "POST",
    });

/** GET the SchedulerDO `path`, throwing a shaped `LunoraError` on any non-2xx. */
const getDO = async <T>(options: LunoraSchedulerOptions, path: string): Promise<T> => requestDO<T>(options, path, { method: "GET" });

export { assertSchedulerOptions, callDO, getDO, schedulerStub };
