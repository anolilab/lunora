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

import { abortDeadline } from "../../../shared/abort-deadline";
import { encodeIdentityHeader, encodeUserIdHeader } from "../../../shared/identity-header";
import { decodeWire, encodeArgsOrThrow } from "../../../shared/wire-codec";
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
 * Non-enumerable brand stamped on an error {@link toDispatchError} reconstructed
 * from a well-formed `{ error: { code, … } }` dispatch envelope.
 *
 * Two things are gated on it. First, a step body can throw an unrelated
 * `LunoraError` that happens to share one of
 * {@link DETERMINISTIC_DISPATCH_STATUSES} (e.g. a genuine 404 from a storage
 * lookup) — the brand lets {@link isDeterministicDispatchFailure} tell "this
 * came from a dispatch response" from "this merely has a matching status".
 *
 * Second, and the reason it is stamped on the parsed path ONLY: an unparseable
 * body means the status did not come from the dispatch endpoint at all. An edge
 * challenge, a WAF block or a misrouted error page answers 403/404 with HTML,
 * and that failure is transient — the caller retries once the rule or the route
 * is fixed. Branding it too would make {@link isDeterministicDispatchFailure}
 * classify it on status alone and permanently dead-letter the queue batch /
 * burn the workflow step.
 */
const DISPATCH_FAILURE_BRAND = Symbol("lunoraDispatchFailure");

/**
 * Non-enumerable slot carrying {@link RunFunctionOptions.messageId} onto a
 * dispatch-failure error, when the caller supplied one. Read back via
 * {@link getDispatchMessageId} — a batching consumer (`@lunora/queue`) uses it
 * to attribute a deterministic failure to the one item that caused it.
 */
// eslint-disable-next-line no-secrets/no-secrets -- false positive: a Symbol description identifying this slot, not a credential
const DISPATCH_MESSAGE_ID = Symbol("lunoraDispatchMessageId");

/** Stamp `error` with {@link DISPATCH_MESSAGE_ID} when the caller scoped the call to one, and return it. */
const attachMessageId = (error: LunoraError, messageId: string | undefined): LunoraError => {
    if (messageId !== undefined) {
        Object.defineProperty(error, DISPATCH_MESSAGE_ID, { value: messageId });
    }

    return error;
};

/** Stamp `error` with {@link DISPATCH_FAILURE_BRAND} (and {@link DISPATCH_MESSAGE_ID}, when given) and return it. */
const markAsDispatchFailure = (error: LunoraError, messageId?: string): LunoraError => {
    Object.defineProperty(error, DISPATCH_FAILURE_BRAND, { value: true });

    return attachMessageId(error, messageId);
};

/**
 * Read back the {@link RunFunctionOptions.messageId} a dispatch call was
 * scoped to, if any. `undefined` for an error not built by
 * {@link toDispatchError}, or for one whose caller never supplied a
 * `messageId` — both are treated identically by a consumer: unattributed.
 */
const getDispatchMessageId = (error: unknown): string | undefined =>
    isLunoraError(error) ? (error as { [DISPATCH_MESSAGE_ID]?: string })[DISPATCH_MESSAGE_ID] : undefined;

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
 * on a call that can never succeed. `@lunora/queue`'s consumer acks the one
 * attributed message (via {@link getDispatchMessageId}) instead of retrying the
 * whole batch, when the handler scoped its `ctx.run` call with a `messageId`.
 * An unparseable or unrecognized body falls back to a generic `INTERNAL`
 * carrying the HTTP status and the raw text, deliberately left UNBRANDED so it
 * is never deterministic: a 4xx that did not carry a dispatch envelope did not
 * come from the dispatch endpoint (an edge challenge, a WAF block, a proxy's
 * 404 page), and those clear. `messageId`, when the caller
 * supplied one via {@link RunFunctionOptions.messageId}, is stamped on either
 * way for {@link getDispatchMessageId} to read back.
 */
const toDispatchError = (label: string, status: number, rawBody: string, messageId: string | undefined): LunoraError => {
    try {
        const parsed = JSON.parse(rawBody) as { error?: unknown } | null;
        const errorBody = parsed?.error;

        if (typeof errorBody === "object" && errorBody !== null && typeof (errorBody as { code?: unknown }).code === "string") {
            const { code, data, message } = errorBody as { code: string; data?: unknown; message?: unknown };

            return markAsDispatchFailure(new LunoraError(code, typeof message === "string" ? message : undefined, { data, status }), messageId);
        }
    } catch {
        // Not JSON / not the expected envelope — fall through to the generic error.
    }

    return attachMessageId(new LunoraError("INTERNAL", `${label}: function dispatch failed (${String(status)}): ${rawBody}`, { status }), messageId);
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
 * Codes that share a deterministic STATUS but describe the dispatch
 * INFRASTRUCTURE rather than the call. `DISPATCH_UNAUTHENTICATED` is the
 * dispatch endpoint refusing our own signature/bearer — a missing, wrong, or
 * rotated `LUNORA_SCHEDULER_SECRET`/`LUNORA_ADMIN_TOKEN`. It is a 403 like an
 * RLS `FORBIDDEN`, but it says nothing about the message: retrying after the
 * secret is fixed succeeds, so classifying it as deterministic would ack every
 * queued message one delivery at a time and drain the queue while the operator
 * is still fixing the credential.
 */
const INFRASTRUCTURE_DISPATCH_CODES: ReadonlySet<string> = new Set(["DISPATCH_UNAUTHENTICATED"]);

/**
 * True when `error` is a {@link LunoraError} {@link toDispatchError} rebuilt
 * from a real dispatch error envelope (carrying its
 * {@link DISPATCH_FAILURE_BRAND}) whose
 * `status` is in {@link DETERMINISTIC_DISPATCH_STATUSES} and whose `code` is not
 * one of {@link INFRASTRUCTURE_DISPATCH_CODES} — i.e. a dispatch
 * failure a consumer (`@lunora/workflow`'s `createRunStep`, `@lunora/queue`'s
 * consumer) should treat as non-retryable rather than rethrowing for the
 * platform's default retry-on-throw. The brand check is what keeps this
 * scoped to dispatch failures specifically: without it, an unrelated
 * `LunoraError` a step body throws (e.g. a genuine `STORAGE_OBJECT_NOT_FOUND`)
 * would be misclassified as non-retryable merely for sharing a status.
 */
const isDeterministicDispatchFailure = (error: unknown): error is LunoraError =>
    isLunoraError(error) &&
    (error as { [DISPATCH_FAILURE_BRAND]?: unknown })[DISPATCH_FAILURE_BRAND] === true &&
    DETERMINISTIC_DISPATCH_STATUSES.has(error.status) &&
    !INFRASTRUCTURE_DISPATCH_CODES.has(error.code);

/**
 * Build the error a timed-out dispatch rejects with. Deliberately a 5xx-class
 * status (503, not one of {@link DETERMINISTIC_DISPATCH_STATUSES}) — a timeout is
 * transient by definition, so a consumer classifying on status must keep it
 * retryable.
 */
const toDispatchTimeoutError = (label: string, functionPath: string, timeoutMs: number): LunoraError =>
    new LunoraError("INTERNAL", `${label}: function dispatch to "${functionPath}" timed out after ${String(timeoutMs)}ms`, { status: 503 });

interface DispatchRunnerOptions {
    /**
     * Declare that this producer has ALREADY wire-encoded `args`, so the runner
     * forwards them verbatim instead of encoding again.
     *
     * Exactly one producer needs it: `createQueueWorkpool` must encode before the
     * job enters a Cloudflare Queue, because that is its own JSON-serialising hop
     * — a `bigint` throws at `queue.send`, long before this runner is reached. The
     * runner then encodes a second time, and the shard decodes ONCE, so the
     * handler receives a still-tagged array: `{ n: ["$lunora.wire$","bigint","7"] }`
     * instead of `7n`, and a `Date` that is no longer a `Date`.
     *
     * Leave it unset everywhere else. A producer with no serialising hop of its
     * own must NOT encode, or it hits the same asymmetry from the other side.
     */
    argsAlreadyEncoded?: boolean;
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

    /**
     * W3C `traceparent` of the work that is dispatching, forwarded so the callee
     * JOINS this trace instead of minting a fresh one.
     *
     * The trigger tiers are where this matters: a queue batch or a cron fire opens
     * its own trace (there is no inbound `traceparent` on a queue message or a cron
     * controller), and without forwarding it every function the handler invokes was
     * a separate, unrelated trace — the trigger span a childless root and its work
     * a set of orphans. Absent → the callee mints its own trace, the prior
     * behaviour and the right answer for a dispatch that belongs to nothing.
     */
    traceparent?: string;
}

/**
 * Build a {@link DispatchRunFunction} that invokes a Lunora function by POSTing
 * to `/_lunora/scheduler/dispatch` with the admin bearer. The hop is
 * wire-bracketed in both directions (see the `encodeArgsOrThrow` call below); an
 * empty body resolves to `undefined`. A non-ok response is rethrown as a
 * {@link LunoraError} carrying the dispatch endpoint's original
 * `code`/`status`/`data` (so consumers can map
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

        /**
         * The args exactly as they belong on the wire: encoded here, unless the
         * producer declared it already encoded them before its own serialising
         * hop. See {@link DispatchRunnerOptions.argsAlreadyEncoded}.
         */
        const wireArgs = (): Record<string, unknown> =>
            options.argsAlreadyEncoded === true ? (args ?? {}) : (encodeArgsOrThrow(label, function_.__lunoraRef, args ?? {}) as Record<string, unknown>);

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

        // Joins the caller's trace rather than starting a new one. Read per call
        // (not captured at construction) so a runner built once per invocation
        // still reflects the trace it was given.
        if (options.traceparent !== undefined && options.traceparent.length > 0) {
            headers.traceparent = options.traceparent;
        }

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
        // reset a fresh window for it. `shared/abort-deadline.ts` (explicit
        // controller + timer, strongly held) rather than the weakly-held
        // `AbortSignal.timeout` — see its docstring for why the built-in can
        // silently never fire. Disposed in the `finally` below, AFTER the body
        // reads, so a fast response leaves no pending timer.
        const deadline = abortDeadline(undefined, timeoutMs, () => new DOMException(`dispatch timed out after ${String(timeoutMs)}ms`, "TimeoutError"));

        // A fired deadline rejects (or, for a body read, makes the stream
        // reject) with the signal's `reason` — a `DOMException` named
        // `TimeoutError` (not `AbortError`, reserved for an explicit
        // caller-triggered abort) — map that to the same
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

        // One `finally` around the ENTIRE fetch + body-read region: the signal
        // (and its timer) must stay live for the `response.text()` calls below,
        // not just the initial fetch — disposing after headers alone would
        // reset the deadline for the body, the half most likely to stall.
        try {
            try {
                response = await fetchImpl(url, {
                    // `id` is the receiver's at-least-once dedup key: the worker's
                    // dispatch endpoint forwards it to the shard as the replay-dedup
                    // `mutationId`, so a redelivered dispatch of the same call is
                    // applied once. Deliberately `dedupId`, never `messageId` — the
                    // shard keys dedup on `(identity, mutationId)` with no function
                    // path, so a per-MESSAGE id reused across a handler's several
                    // calls would make the second call return the first's cached
                    // result. `JSON.stringify` omits the key when unset.
                    //
                    // CANONICAL NOTE on wire-bracketing a dispatch hop — the
                    // scheduler, the workpool and `ctx.scheduler` on an httpAction
                    // point here rather than restate it. Plain JSON cannot carry a
                    // `bigint` (`JSON.stringify` throws), and it flattens a
                    // `Uint8Array` to `{"0":1,…}` and a `Date` to an ISO string. The
                    // far end — `ShardDO` — `decodeWire`s `payload.args` and answers
                    // `encodeWire(result)`, so BOTH ends of the hop must be bracketed
                    // or the two halves disagree. `encodeWire`/`decodeWire` are
                    // identity for pure-JSON values, so nothing else changes.
                    body: JSON.stringify({
                        args: wireArgs(),
                        functionPath: function_.__lunoraRef,
                        id: runOptions.dedupId,
                        shardKey: runOptions.shardKey,
                    }),
                    headers,
                    method: "POST",
                    signal: deadline.signal,
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

                throw toDispatchError(label, response.status, errorBody, runOptions.messageId);
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

            let parsed: unknown;

            try {
                parsed = JSON.parse(text);
            } catch {
                // A non-empty body that isn't valid JSON can't be a function's
                // JSON-encoded return value — it's a malformed response (an
                // intermediary's HTML error page, a misconfigured proxy). Surface it
                // instead of handing the raw text back as the "return value".
                throw new LunoraError("INTERNAL", `${label}: function dispatch returned a non-JSON body (${String(response.status)}): ${text}`, {
                    status: response.status,
                });
            }

            // The shard answers an ENVELOPE — `{ result }`, or `{ commitCursor,
            // result }` / `{ lastMutationId, result }` for a mutation (built by the
            // shard's `buildDispatchResponse`) — never the bare return value, which
            // is why an unwrapped `parsed` handed every `ctx.run` caller
            // `{ result: … }` where a workflow's `order.status` belonged.
            //
            // Insist on the envelope SHAPE before reading it: `null` and a bare
            // scalar are not objects, `typeof [] === "object"` lets an array past,
            // and an object missing the key reads `undefined` as "returned
            // nothing". Requiring `result` costs nothing — a genuine `undefined`
            // return is emitted as `{"result":["$lunora.wire$","undefined"]}`, with
            // the key always present.
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || !("result" in parsed)) {
                throw new LunoraError(
                    "INTERNAL",
                    `${label}: function dispatch returned a JSON body that is not a { result } envelope (${String(response.status)}): ${text}`,
                    {
                        status: response.status,
                    },
                );
            }

            return decodeWire((parsed as { result?: unknown }).result);
        } finally {
            deadline.dispose();
        }
    };
};

export { createDispatchRunner, getDispatchMessageId, isDeterministicDispatchFailure };
