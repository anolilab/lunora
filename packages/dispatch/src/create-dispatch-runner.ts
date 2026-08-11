/**
 * `createDispatchRunner` — the single source of truth for calling a Lunora
 * function from a server-initiated context (workflow body / queue handler /
 * scheduled job). It POSTs to the worker's `/_lunora/scheduler/dispatch`
 * endpoint, authenticated with the admin bearer, and resolves the function's
 * return value. Previously each consumer (`@lunora/workflow`, `@lunora/queue`)
 * carried a byte-identical copy of this logic; they now share this one.
 *
 * Node-safe (structural types, injectable `fetch`) so it's unit-testable.
 */
import { isLunoraError, LunoraError } from "@lunora/errors";

import { encodeIdentityHeader, encodeUserIdHeader } from "../../../shared/identity-header";
import type { ArgsOf, DispatchRunFunction, FunctionReference, RunFunctionOptions } from "./types";

/** The reserved worker endpoint that re-dispatches a server-initiated function call to its shard. */
const SCHEDULER_DISPATCH_PATH = "/_lunora/scheduler/dispatch";

/**
 * Default cap on the dispatch fetch, overridable per call via
 * {@link RunFunctionOptions.timeoutMs}. `ctx.run` is the load-bearing path every
 * workflow step / queue handler / scheduled job takes back into a Lunora
 * function — without a bound, an unresponsive origin holds the caller (a queue
 * consumer, a scheduled invocation) open until the platform kills it. 30s is
 * generous relative to `queue/src/capture.ts`'s 5s best-effort cap: that budget
 * is for a side-channel write, this is a real function call.
 */
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

/** Strip trailing slashes from an origin so the dispatch path joins cleanly. */
const trimTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

/**
 * Non-enumerable brand stamped on every error {@link toDispatchError} builds.
 * A step body can throw an unrelated `LunoraError` that happens to share one
 * of {@link DETERMINISTIC_DISPATCH_STATUSES} (e.g. a genuine 404 from a
 * storage lookup) — the brand is what lets {@link isDeterministicDispatchFailure}
 * tell "this specific error came from a dispatch response" from "this error
 * merely has a matching status", so classification stays scoped to actual
 * dispatch failures instead of every step-body error in the allowlisted range.
 */
const DISPATCH_FAILURE_BRAND = Symbol("lunoraDispatchFailure");

/** Stamp `error` with {@link DISPATCH_FAILURE_BRAND} and return it. */
const markAsDispatchFailure = (error: LunoraError): LunoraError => {
    Object.defineProperty(error, DISPATCH_FAILURE_BRAND, { value: true });

    return error;
};

/**
 * Turn a non-ok dispatch response into a {@link LunoraError}. The runtime
 * serializes a dispatch failure via `@lunora/errors`' `toErrorBody`, wrapped as
 * `{ error: { code, message, data?, ... } }` with the HTTP status carrying the
 * error's status. Reconstruct a `LunoraError` from that shape so the original
 * `code`/`status`/`data` survive: {@link isDeterministicDispatchFailure} keys off
 * the {@link DISPATCH_FAILURE_BRAND} stamped here plus `status` to tell a
 * deterministic failure (`400`/`403`/`404`/`422` — see
 * `DETERMINISTIC_DISPATCH_STATUSES`) from a transient one.
 * `@lunora/workflow`'s `createRunStep` consumes this to convert a deterministic
 * failure into a non-retryable step failure instead of burning its retry budget
 * on a call that can never succeed. `@lunora/queue`'s consumer does not yet act
 * on it — `dispatchQueueBatch`'s retry unit is the whole batch, and turning a
 * deterministic per-message failure into an ack-without-retry needs its own
 * redelivery-semantics change. An unparseable or unrecognized body falls back to
 * a generic `INTERNAL` carrying the HTTP status and the raw text (never
 * deterministic, since it isn't in the allowlist).
 */
const toDispatchError = (label: string, status: number, rawBody: string): LunoraError => {
    try {
        const parsed = JSON.parse(rawBody) as { error?: unknown } | null;
        const errorBody = parsed?.error;

        if (typeof errorBody === "object" && errorBody !== null && typeof (errorBody as { code?: unknown }).code === "string") {
            const { code, data, message } = errorBody as { code: string; data?: unknown; message?: unknown };

            return markAsDispatchFailure(new LunoraError(code, typeof message === "string" ? message : undefined, { data, status }));
        }
    } catch {
        // Not JSON / not the expected envelope — fall through to the generic error.
    }

    return markAsDispatchFailure(new LunoraError("INTERNAL", `${label}: function dispatch failed (${String(status)}): ${rawBody}`, { status }));
};

/**
 * Statuses a dispatch will fail on identically every time — retrying re-runs
 * the caller's side effects for nothing. `408` (timeout) and `429` (rate limit)
 * are deliberately absent: both are transient, and an intermediary can emit
 * either, so treating them as permanent would turn a recoverable failure into a
 * dead-lettered batch / a burned workflow retry budget.
 */
const DETERMINISTIC_DISPATCH_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 422]);

/**
 * True when `error` is a {@link LunoraError} actually built by
 * {@link toDispatchError} (carrying its {@link DISPATCH_FAILURE_BRAND}) whose
 * `status` is in {@link DETERMINISTIC_DISPATCH_STATUSES} — i.e. a dispatch
 * failure a consumer (`@lunora/workflow`'s `createRunStep`, `@lunora/queue`'s
 * consumer) should treat as non-retryable rather than rethrowing for the
 * platform's default retry-on-throw. The brand check is what keeps this
 * scoped to dispatch failures specifically: without it, an unrelated
 * `LunoraError` a step body throws (e.g. a genuine `STORAGE_OBJECT_NOT_FOUND`)
 * would be misclassified as non-retryable merely for sharing a status.
 */
const isDeterministicDispatchFailure = (error: unknown): error is LunoraError =>
    isLunoraError(error) && (error as { [DISPATCH_FAILURE_BRAND]?: unknown })[DISPATCH_FAILURE_BRAND] === true && DETERMINISTIC_DISPATCH_STATUSES.has(error.status);

/**
 * Build the error a timed-out dispatch rejects with. Deliberately a 5xx-class
 * status (503, not one of {@link DETERMINISTIC_DISPATCH_STATUSES}) — a timeout is
 * transient by definition, so a consumer classifying on status must keep it
 * retryable.
 */
const toDispatchTimeoutError = (label: string, functionPath: string, timeoutMs: number): LunoraError =>
    new LunoraError("INTERNAL", `${label}: function dispatch to "${functionPath}" timed out after ${String(timeoutMs)}ms`, { status: 503 });

interface DispatchRunnerOptions {
    /** Worker `env` — read `LUNORA_ORIGIN_URL` + `LUNORA_ADMIN_TOKEN` at call time. */
    env: Record<string, unknown>;
    /** Injectable fetch (tests); defaults to the global. */
    fetchImpl?: typeof fetch;

    /**
     * Optional caller identity to attribute the dispatched call to (RLS / row
     * ownership). When set, the runner forwards `x-lunora-userid` /
     * `x-lunora-identity` alongside the admin bearer, so the shard reconstructs
     * the caller's identity even though this is a server-initiated dispatch. The
     * server-minted headers are trusted verbatim by the DO, so only pass a value
     * derived from an already-verified identity (e.g. a voice socket's claims).
     */
    identity?: { claims?: Record<string, unknown>; userId?: string };
    /** Package label for directed error messages, e.g. `@lunora/queue`. */
    label: string;
}

/**
 * Build a {@link DispatchRunFunction} that invokes a Lunora function by POSTing
 * to `/_lunora/scheduler/dispatch` with the admin bearer. The parsed JSON body
 * (the function's return value) is resolved; an empty body resolves to
 * `undefined`. A non-ok response is rethrown as a {@link LunoraError} carrying
 * the dispatch endpoint's original `code`/`status`/`data` (so consumers can map
 * a deterministic 4xx to a non-retryable failure); an unparseable error body
 * falls back to `INTERNAL`. A non-empty body that is not valid JSON is a
 * malformed response (e.g. an intermediary's HTML error page) and throws an
 * `INTERNAL` {@link LunoraError} rather than resolving to the raw text. The
 * fetch itself is bounded by {@link DEFAULT_DISPATCH_TIMEOUT_MS} (overridable
 * via {@link RunFunctionOptions.timeoutMs}); an abort rejects with a retryable
 * (5xx-status) {@link LunoraError}.
 */
const createDispatchRunner = (options: DispatchRunnerOptions): DispatchRunFunction => {
    const { label } = options;
    const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
    // Bind the global `fetch` to `globalThis` so calling it through a captured
    // reference cannot trip "Illegal invocation" in receiver-strict runtimes.
    const fetchImpl = options.fetchImpl ?? (typeof globalFetch === "function" ? globalFetch.bind(globalThis) : undefined);

    return async <F extends FunctionReference>(function_: F, args?: ArgsOf<F>, runOptions: RunFunctionOptions = {}): Promise<unknown> => {
        if (typeof fetchImpl !== "function") {
            throw new TypeError(`${label}: no fetch implementation available — pass fetchImpl or run on a platform with global fetch`);
        }

        const origin = options.env.LUNORA_ORIGIN_URL;

        if (typeof origin !== "string" || origin.length === 0) {
            throw new LunoraError("INTERNAL", `${label}: \`LUNORA_ORIGIN_URL\` must be set on the Worker env so a handler can call back into Lunora functions`);
        }

        const token = options.env.LUNORA_ADMIN_TOKEN;

        if (typeof token !== "string" || token.length === 0) {
            throw new LunoraError("INTERNAL", `${label}: \`LUNORA_ADMIN_TOKEN\` must be set on the Worker env to authenticate function dispatch`);
        }

        const url = `${trimTrailingSlashes(origin)}${SCHEDULER_DISPATCH_PATH}`;
        const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };

        // Attribute the dispatch to a verified caller when one is supplied — the
        // shard reconstructs identity from these headers independently of the
        // system flag, so a server dispatch can still carry a userId for RLS.
        if (options.identity?.userId !== undefined) {
            // Base64url-encoded when non-Latin-1 (HTTP header values are WebIDL
            // `ByteString`s); see shared/identity-header.ts.
            headers["x-lunora-userid"] = encodeUserIdHeader(options.identity.userId);
        }

        if (options.identity?.claims !== undefined) {
            headers["x-lunora-identity"] = encodeIdentityHeader(options.identity.claims);
        }

        const timeoutMs = runOptions.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
        // Bound the WHOLE dispatch — response headers AND body. One signal,
        // held in scope for the initial fetch below AND the response.text()
        // body reads further down: a slow/hanging origin can stall AFTER
        // headers arrive (so the outer `await fetchImpl` already resolved),
        // and the deadline must still fire on the pending body read, not
        // reset a fresh window for it.
        const timeoutSignal = AbortSignal.timeout(timeoutMs);

        // A timed-out `AbortSignal.timeout` rejects (or, for a body read,
        // makes the stream reject) with the signal's `reason` — a
        // `DOMException` named `TimeoutError` (not `AbortError`, reserved for
        // an explicit caller-triggered abort) — map that to the same
        // retryable 503 `LunoraError` regardless of which await it hit.
        // Anything else (network failure, DNS, a malformed body) rethrows
        // as-is. `never` return, called as `return rethrowAsTimeoutOrOriginal(error)`
        // at each site — `throw` of a non-Error-typed expression trips
        // `@typescript-eslint/only-throw-error`, and a bare call-as-statement
        // doesn't satisfy TS's definite-assignment analysis on the `let` it
        // guards the way `return` does.
        const rethrowAsTimeoutOrOriginal = (error: unknown): never => {
            if (error instanceof Error && error.name === "TimeoutError") {
                throw toDispatchTimeoutError(label, function_.__lunoraRef, timeoutMs);
            }

            throw error;
        };

        let response: Response;

        try {
            response = await fetchImpl(url, {
                body: JSON.stringify({ args: args ?? {}, functionPath: function_.__lunoraRef, shardKey: runOptions.shardKey }),
                headers,
                method: "POST",
                // `AbortSignal.timeout`'s internal timer is unref'd, so it never
                // keeps the process alive on its own — no manual
                // AbortController/setTimeout/clearTimeout needed (mirrors
                // container/src/otel.ts's OTLP send and the CLI's fetch-timeout
                // call sites).
                signal: timeoutSignal,
            });
        } catch (error: unknown) {
            return rethrowAsTimeoutOrOriginal(error);
        }

        if (!response.ok) {
            let errorBody: string;

            try {
                errorBody = await response.text();
            } catch (error: unknown) {
                return rethrowAsTimeoutOrOriginal(error);
            }

            throw toDispatchError(label, response.status, errorBody);
        }

        let text: string;

        try {
            text = await response.text();
        } catch (error: unknown) {
            return rethrowAsTimeoutOrOriginal(error);
        }

        if (text.length === 0) {
            return undefined;
        }

        try {
            return JSON.parse(text);
        } catch {
            // A non-empty body that isn't valid JSON can't be a function's
            // JSON-encoded return value — it's a malformed response (an
            // intermediary's HTML error page, a misconfigured proxy). Surface it
            // instead of handing the raw text back as the "return value".
            throw new LunoraError("INTERNAL", `${label}: function dispatch returned a non-JSON body (${String(response.status)}): ${text}`, {
                status: response.status,
            });
        }
    };
};

export { createDispatchRunner, isDeterministicDispatchFailure };
