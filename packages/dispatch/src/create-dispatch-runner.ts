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
 * (the function's return value) is resolved; an empty/non-JSON body resolves to
 * `undefined`.
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
            throw new LunoraError("INTERNAL", `${label}: function dispatch failed (${String(response.status)}): ${await response.text()}`);
        }

        const text = await response.text();

        if (text.length === 0) {
            return undefined;
        }

        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    };
};
