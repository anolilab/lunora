/**
 * Call a Lunora Worker from another Worker over a Cloudflare **service binding**,
 * with the types the generated `api` already carries.
 *
 * # Why this exists
 *
 * `ctx.run*` covers calls WITHIN one Lunora app. A sibling Worker in the same
 * account had nothing: the only documented path was the public HTTPS route, so
 * teams reached for a plain `fetch` at the callee's public URL and hand-rolled an HMAC
 * to authenticate it — paying per-request fees, a public-internet round trip, and
 * the upkeep of a shared secret, for a call between two Workers on one account.
 * And because the call went out untyped, a renamed function or a changed argument
 * surfaced as a runtime 404 rather than a compile error.
 *
 * A service binding is free, never leaves the edge, and is authenticated by
 * construction — the binding IS the capability, so the callee needs no public
 * route at all. What was missing was only the typed call.
 *
 * ```ts
 * import { createServiceClient } from "@lunora/client/service";
 * import { api } from "../../backend/lunora/_generated/api";
 *
 * const backend = createServiceClient(env.BACKEND);
 * const threads = await backend.query(api.threads.list, { userId });
 * ```
 *
 * # Why it takes the binding rather than a URL
 *
 * The `fetch` on a service binding is not the global one: it dispatches
 * in-process to the other Worker. Accepting `{ fetch }` structurally keeps this
 * module free of `@cloudflare/workers-types` and makes it trivially testable —
 * a fake with one method is a complete stand-in.
 *
 * # Why the hostname is a constant
 *
 * A service binding ignores the origin entirely; only the path and method are
 * routed. The URL still has to parse, so one fixed internal hostname is used and
 * never configurable — a knob there would imply it means something.
 */
import { LunoraError } from "@lunora/errors";

import { decodeWire, encodeArgsOrThrow } from "../../../shared/wire-codec";
import type { ArgsOf, FunctionReference, ReturnOf, RpcResponseBody } from "./types";

/**
 * The wire endpoint every Lunora Worker serves. Matches `createWorker`'s RPC
 * route; the envelope shape below is that route's documented contract.
 */
const RPC_PATH = "/_lunora/rpc";

/**
 * Ignored by the service-binding dispatcher — see the module docblock. Present
 * only because `new Request(...)` requires an absolute URL.
 */
const INTERNAL_ORIGIN = "https://lunora.internal";

/**
 * The slice of a Cloudflare service binding this module uses.
 *
 * Structural on purpose: `env.BACKEND` satisfies it, and so does a one-method
 * fake in a test. Declaring the full `Fetcher` would drag
 * `@cloudflare/workers-types` into every consumer for a single method.
 */
interface ServiceBindingLike {
    fetch: (request: Request) => Promise<Response>;
}

interface ServiceCallOptions {
    /**
     * Route to a specific shard. Omitted, the callee routes to its default shard
     * — the same rule the HTTP path follows, so a sharded app must pass the key
     * it would have passed there.
     */
    shardKey?: string;
}

/**
 * A typed caller bound to one Lunora Worker.
 *
 * The three methods are separate rather than one `call` so a reader can tell a
 * read from a write at the call site, and so the reference's `Kind` is checked:
 * passing a mutation reference to `query` is a compile error, matching how
 * `ctx.runQuery`/`ctx.runMutation` behave inside an app.
 */
interface LunoraServiceClient {
    action: <F extends FunctionReference<"action">>(reference: F, args?: ArgsOf<F>, options?: ServiceCallOptions) => Promise<ReturnOf<F>>;
    mutation: <F extends FunctionReference<"mutation">>(reference: F, args?: ArgsOf<F>, options?: ServiceCallOptions) => Promise<ReturnOf<F>>;
    query: <F extends FunctionReference<"query">>(reference: F, args?: ArgsOf<F>, options?: ServiceCallOptions) => Promise<ReturnOf<F>>;
}

/**
 * Rebuild a thrown `Error` from the worker's `{ code, message, data? }` envelope
 * so a caller across a service binding sees the same `.code`/`.data` it would
 * see calling the same function in-process. `data` is wire-decoded, so a
 * `bigint` or byte array inside a thrown `LunoraError` survives the hop.
 */
type ServiceCallError = Error & { code?: string; data?: unknown; docsUrl?: string; hint?: string | string[] };

const reconstructError = (errorBody: { code?: string; data?: unknown; docsUrl?: string; hint?: string | string[]; message?: string }): ServiceCallError => {
    const error = new Error(errorBody.message ?? "request failed") as ServiceCallError;

    error.code = errorBody.code;

    // `hint` and `docsUrl` come from the error catalog and are what make a
    // failure actionable. Restoring only `code`/`data` would give a
    // service-binding caller a weaker error than the same function throws over
    // HTTP, for no reason a caller could see.
    if (errorBody.data !== undefined) {
        error.data = decodeWire(errorBody.data);
    }

    if (errorBody.hint !== undefined) {
        error.hint = errorBody.hint;
    }

    if (errorBody.docsUrl !== undefined) {
        error.docsUrl = errorBody.docsUrl;
    }

    return error;
};

const callBinding = async (
    binding: ServiceBindingLike,
    kind: string,
    reference: FunctionReference,
    args?: unknown,
    options?: ServiceCallOptions,
): Promise<unknown> => {
    const path = reference.__lunoraRef;

    // Wire-encoded, exactly as `LunoraClient` encodes its own RPC args: a service
    // binding is the same wire as the HTTP path, so skipping this would let a
    // `bigint` argument arrive silently wrong.
    const body = JSON.stringify({
        args: encodeArgsOrThrow("@lunora/client/service", path, args ?? {}),
        functionPath: path,
        ...(options?.shardKey === undefined ? {} : { shardKey: options.shardKey }),
    });

    // Deliberately only `content-type`. The HTTP client also sends
    // `x-lunora-mutation-id`, `x-lunora-client-id`, a bearer token and a D1
    // bookmark — every one of which describes a BROWSER client's session. A
    // service-binding caller is a server: it has no client id, and inventing a
    // mutation id would fabricate an idempotency key that dedups unrelated
    // writes against each other. The worker reads all of them conditionally, so
    // their absence changes nothing but the client-replay behaviour that does not
    // apply here. (Read-your-writes across the binding would need a bookmark the
    // caller owns; that is a stateful client, and not this.)
    const response = await binding.fetch(
        new Request(`${INTERNAL_ORIGIN}${RPC_PATH}`, { body, headers: { "content-type": "application/json" }, method: "POST" }),
    );

    let parsed: unknown;

    try {
        parsed = await response.json();
    } catch {
        // Not the JSON envelope: a platform-level failure, or — far more likely
        // the first time — a binding wired to a Worker that is not this Lunora
        // app. Say so, because the status alone sends people hunting in the
        // callee's handler code.
        throw new LunoraError(
            "INTERNAL",
            `@lunora/client/service: ${kind} "${path}" got a non-JSON response (status ${response.status.toString()}). Check the service binding points at the Lunora Worker that declares this function.`,
            { status: response.status },
        );
    }

    // `response.json()` resolves `null` for the body `null` and a scalar for `4`
    // or `"ok"`, on either of which `"error" in parsed` throws
    // `TypeError: Cannot use 'in' operator` — hiding the real cause behind an
    // unrelated crash. The declared shape is an assumption about a remote Worker,
    // so it is checked rather than trusted.
    if (parsed === null || typeof parsed !== "object") {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/client/service: ${kind} "${path}" returned a JSON body that is not an object (status ${response.status.toString()}). Check the service binding points at the Lunora Worker that declares this function.`,
            { status: response.status },
        );
    }

    const envelope = parsed as RpcResponseBody;

    if ("error" in envelope) {
        throw reconstructError(envelope.error);
    }

    if (!response.ok) {
        throw new LunoraError("INTERNAL", `@lunora/client/service: ${kind} "${path}" failed with status ${response.status.toString()} and no error envelope.`, {
            status: response.status,
        });
    }

    return decodeWire(envelope.result);
};

/**
 * Build a typed caller for the Lunora Worker behind `binding`.
 *
 * Only PUBLIC functions are reachable. An `internal*` procedure is deliberately
 * absent from the generated `api` object and rejected by the callee, because a
 * service binding is a trust boundary between deployments, not the intra-app
 * `ctx.run*` seam.
 * @param binding The service binding, e.g. `env.BACKEND`.
 * @returns a client whose methods type-check against the generated `api`.
 */
const createServiceClient = (binding: ServiceBindingLike): LunoraServiceClient => {
    return {
        action: async (reference, args, options) => (await callBinding(binding, "action", reference, args, options)) as never,
        mutation: async (reference, args, options) => (await callBinding(binding, "mutation", reference, args, options)) as never,
        query: async (reference, args, options) => (await callBinding(binding, "query", reference, args, options)) as never,
    };
};

export { createServiceClient, RPC_PATH };
export type { LunoraServiceClient, ServiceBindingLike, ServiceCallOptions };
