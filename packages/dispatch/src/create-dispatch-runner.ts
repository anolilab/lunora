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
import { LunoraError } from "@lunora/errors";

import type { ArgsOf, DispatchRunFunction, FunctionReference, RunFunctionOptions } from "./types";

/** The reserved worker endpoint that re-dispatches a server-initiated function call to its shard. */
const SCHEDULER_DISPATCH_PATH = "/_lunora/scheduler/dispatch";

/** Strip trailing slashes from an origin so the dispatch path joins cleanly. */
const trimTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

/**
 * Turn a non-ok dispatch response into a {@link LunoraError}. The runtime
 * serializes a dispatch failure via `@lunora/errors`' `toErrorBody`, wrapped as
 * `{ error: { code, message, data?, ... } }` with the HTTP status carrying the
 * error's status. Reconstruct a `LunoraError` from that shape so the original
 * `code`/`status`/`data` survive and a consumer (`@lunora/workflow`'s
 * `createRunStep`, `@lunora/queue`'s consumer) can distinguish a deterministic
 * 4xx (map to a non-retryable failure / ack-without-retry) from a transient
 * one. An unparseable or unrecognized body falls back to a generic `INTERNAL`
 * carrying the HTTP status and the raw text.
 */
const toDispatchError = (label: string, status: number, rawBody: string): LunoraError => {
    try {
        const parsed = JSON.parse(rawBody) as { error?: unknown } | null;
        const errorBody = parsed?.error;

        if (typeof errorBody === "object" && errorBody !== null && typeof (errorBody as { code?: unknown }).code === "string") {
            const { code, data, message } = errorBody as { code: string; data?: unknown; message?: unknown };

            return new LunoraError(code, typeof message === "string" ? message : undefined, { data, status });
        }
    } catch {
        // Not JSON / not the expected envelope — fall through to the generic error.
    }

    return new LunoraError("INTERNAL", `${label}: function dispatch failed (${String(status)}): ${rawBody}`, { status });
};

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
 * `INTERNAL` {@link LunoraError} rather than resolving to the raw text.
 */
// eslint-disable-next-line import/prefer-default-export -- named export by package convention; index.ts re-exports it
export const createDispatchRunner = (options: DispatchRunnerOptions): DispatchRunFunction => {
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
            headers["x-lunora-userid"] = options.identity.userId;
        }

        if (options.identity?.claims !== undefined) {
            headers["x-lunora-identity"] = JSON.stringify(options.identity.claims);
        }

        const response = await fetchImpl(url, {
            body: JSON.stringify({ args: args ?? {}, functionPath: function_.__lunoraRef, shardKey: runOptions.shardKey }),
            headers,
            method: "POST",
        });

        if (!response.ok) {
            throw toDispatchError(label, response.status, await response.text());
        }

        const text = await response.text();

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
