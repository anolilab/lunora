/**
 * The scheduler dispatch route, served in-process on the Node host.
 *
 * `@lunora/dispatch` (the queue and topic `ctx.run` / `message.run` path) and
 * `@lunora/scheduler` both deliver work by POSTing a JSON body to the scheduler
 * dispatch path on the app origin. On Cloudflare the Worker
 * answers that path; on Node nothing did, so a delivered handler's call failed
 * and retried until it parked. This factory is the Node answer: a
 * `(Request) => Promise<Response>` that authenticates the caller and hands the
 * function call to `invoke`, which the platform wires onto the shard directory.
 *
 * It is NOT an HTTP listener. The caller decides how the request arrives: a
 * `fetchImpl` for in-process delivery (see `createNodePlatform`'s `dispatch`), or
 * a server the app runs itself. Nothing here binds a port.
 *
 * The auth and body rules mirror `handleSchedulerDispatch` in
 * `@lunora/runtime`'s `create-worker.ts`. They are copied rather than imported,
 * because that handler is private to the Worker composition and this package
 * must not depend on the runtime for it. The HMAC primitive is the one shared
 * `shared/hmac-url` already used by this package, so the signature is computed
 * the same way the scheduler computes it.
 *
 * Wire format: a 2xx response means done; a 409 with the `DISPATCH_DECLINED`
 * header means come back later. Both pass through from `invoke` untouched, so a
 * retryable answer stays retryable. Errors are a `{ error: { code, message } }`
 * envelope, as in the runtime.
 */

import { LunoraError, toErrorBody } from "@lunora/errors";
import { RELATION_FUNCTION_PREFIX } from "@lunora/shard-engine";

import { constantTimeEqual } from "../../../shared/constant-time-equal";
import { signCanonical } from "../../../shared/hmac-url";
import { ORIGIN_PAYWALL_APPLIED, ORIGIN_PAYWALL_HEADER } from "../../../shared/origin-paywall";

/** The path `@lunora/dispatch` and `@lunora/scheduler` POST to. */
const NODE_SCHEDULER_DISPATCH_PATH = "/_lunora/scheduler/dispatch";

/** Upper bound on a dispatch body, matching the runtime's default body budget. */
const MAX_DISPATCH_BODY_BYTES = 1_048_576;

/** One function call the route has authenticated and parsed. */
interface NodeDispatchInvocation {
    args: Record<string, unknown>;
    functionPath: string;
    /** The scheduler record or delivery id, used as the shard's idempotency key. */
    id: string | undefined;
    /** Identity the trusted caller forwarded, if any. */
    identity: { identity?: string; userId?: string } | undefined;
    shardKey: string;
    traceparent: string | undefined;
}

interface NodeDispatchRouteOptions {
    /** `LUNORA_ADMIN_TOKEN`. Used as the bearer when no HMAC signature is presented. */
    adminToken?: string;
    /** The shard a body without `shardKey` is sent to. */
    defaultShardKey: string;
    /** Runs the call in-process and returns the shard's response, unchanged. */
    invoke: (call: NodeDispatchInvocation) => Promise<Response>;
    /** `LUNORA_SCHEDULER_SECRET`. When set, a signed request is verified against it. */
    schedulerSecret?: string;
}

const errorResponse = (error: unknown): Response => {
    const { body, status } = toErrorBody(error, { fallbackCode: "INTERNAL", redactedMessage: "Internal error" });

    return Response.json({ error: body }, { headers: { "content-type": "application/json" }, status });
};

const checkBearer = (request: Request, expected: string | undefined): boolean => {
    if (expected === undefined || expected.length === 0) {
        return false;
    }

    const [scheme, ...rest] = (request.headers.get("authorization") ?? "").split(" ");

    if (scheme?.toLowerCase() !== "bearer") {
        return false;
    }

    return constantTimeEqual(expected, rest.join(" ").trim());
};

const readForwardedIdentity = (request: Request): { identity?: string; userId?: string } | undefined => {
    const userId = request.headers.get("x-lunora-userid");
    const identity = request.headers.get("x-lunora-identity");

    if (userId === null && identity === null) {
        return undefined;
    }

    return {
        ...(identity === null ? {} : { identity }),
        ...(userId === null ? {} : { userId }),
    };
};

const readRawBody = async (request: Request): Promise<string> => {
    const bytes = await request.arrayBuffer();

    if (bytes.byteLength > MAX_DISPATCH_BODY_BYTES) {
        throw new LunoraError("PAYLOAD_TOO_LARGE", "Scheduler dispatch body is too large");
    }

    return new TextDecoder().decode(bytes);
};

/**
 * A signature the scheduler computed over the exact body wins when the scheduler
 * secret is set. Otherwise the admin bearer is the credential, as the runtime does.
 */
const authenticate = async (request: Request, rawBody: string, options: NodeDispatchRouteOptions): Promise<boolean> => {
    const signature = request.headers.get("x-lunora-scheduler-signature");
    const secret = options.schedulerSecret;

    if (signature !== null && signature.length > 0 && secret !== undefined && secret.length > 0) {
        return constantTimeEqual(await signCanonical(secret, rawBody), signature);
    }

    return checkBearer(request, options.adminToken);
};

const handle = async (request: Request, options: NodeDispatchRouteOptions): Promise<Response> => {
    if (request.method !== "POST") {
        throw new LunoraError("METHOD_NOT_ALLOWED", "Scheduler dispatch endpoint requires POST", { status: 405 });
    }

    // The HMAC covers the exact bytes the caller sent, so verify before parsing.
    const rawBody = await readRawBody(request);
    const authenticated = await authenticate(request, rawBody, options);

    if (!authenticated) {
        // DISPATCH_UNAUTHENTICATED, not FORBIDDEN: consumers treat a 403 as final and
        // ack the message. This code is the one the caller retries on.
        throw new LunoraError("DISPATCH_UNAUTHENTICATED", "Scheduler dispatch requires a valid signature or admin bearer");
    }

    let body: unknown;

    try {
        body = JSON.parse(rawBody);
    } catch {
        throw new LunoraError("BAD_REQUEST", "Scheduler dispatch body must be valid JSON");
    }

    const candidate = (body ?? {}) as Record<string, unknown>;

    // Workflow and pool targets need a durable-instance store and a pool-slot
    // release that this route does not have. Refuse them explicitly rather than
    // run the function and leave the slot held.
    // 503 rather than 400 on purpose: a 400 is deterministic to the consumer, which
    // would ack the message and drop the work. A 503 retries and parks at maxRetries.
    if (typeof candidate["workflow"] === "string" || candidate["pool"] !== undefined) {
        throw new LunoraError("SERVICE_UNAVAILABLE", "Scheduler dispatch for a workflow or pool target is not served by the Node dispatch route");
    }

    if (typeof candidate["functionPath"] !== "string" || candidate["functionPath"].length === 0) {
        throw new LunoraError("BAD_REQUEST", "Scheduler dispatch is missing `functionPath`");
    }

    if (candidate["functionPath"].startsWith(RELATION_FUNCTION_PREFIX)) {
        throw new LunoraError("FORBIDDEN", "`__lunora_relation__:*` is a fan-out-only reserved RPC and cannot be dispatched to a single shard");
    }

    const shardKey = typeof candidate["shardKey"] === "string" && candidate["shardKey"].length > 0 ? candidate["shardKey"] : options.defaultShardKey;

    return options.invoke({
        args: (candidate["args"] ?? {}) as Record<string, unknown>,
        functionPath: candidate["functionPath"],
        id: typeof candidate["id"] === "string" && candidate["id"].length > 0 ? candidate["id"] : undefined,
        identity: readForwardedIdentity(request),
        shardKey,
        traceparent: request.headers.get("traceparent") ?? undefined,
    });
};

/**
 * The in-process `invoke`: forwards one authenticated call to the shard the
 * directory resolves for its key, as the runtime's shard forward does. It refuses
 * when `handlerWired` is false, since no shard handler exists to run the call. The
 * `x-lunora-system` marker is what lets the shard run `internal` functions for a
 * server-initiated dispatch, and the identity and idempotency headers match the
 * runtime's `dispatchToShard`.
 */
const createShardInvoke =
    (directory: { getByName: (name: string) => { fetch: (request: Request) => Promise<Response> } }, handlerWired: boolean) =>
    (call: NodeDispatchInvocation): Promise<Response> => {
        // Without the registry's `onFetch` a resolved stub only echoes its key, and a
        // dispatch answered that way would ack a message whose function never ran.
        if (!handlerWired) {
            throw new LunoraError(
                "SERVICE_UNAVAILABLE",
                "@lunora/platform-node: the dispatch route needs `onFetch` to run a function; without it a shard only echoes its key",
            );
        }

        // The paywall marker: a scheduled `.x402` procedure has no HTTP caller to
        // charge, so running it unpaid is deliberate here, as in the runtime.
        const headers: Record<string, string> = {
            "content-type": "application/json",
            [ORIGIN_PAYWALL_HEADER]: ORIGIN_PAYWALL_APPLIED,
            "x-lunora-system": "1",
        };

        if (call.identity?.userId !== undefined && call.identity.userId.length > 0) {
            headers["x-lunora-userid"] = call.identity.userId;
        }

        if (call.identity?.identity !== undefined && call.identity.identity.length > 0) {
            headers["x-lunora-identity"] = call.identity.identity;
        }

        if (call.id !== undefined) {
            headers["x-lunora-mutation-id"] = call.id;
        }

        if (call.traceparent !== undefined && call.traceparent.length > 0) {
            headers.traceparent = call.traceparent;
        }

        const request = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: call.args, functionPath: call.functionPath }),
            headers,
            method: "POST",
        });

        return directory.getByName(call.shardKey).fetch(request);
    };

/**
 * Build the dispatch route. The returned function answers any request it is
 * handed; mounting it at {@link NODE_SCHEDULER_DISPATCH_PATH} is the caller's job.
 * With neither secret configured every request is refused, so an unconfigured
 * route fails closed.
 */
const createNodeDispatchRoute =
    (options: NodeDispatchRouteOptions): ((request: Request) => Promise<Response>) =>
    async (request: Request): Promise<Response> => {
        try {
            return await handle(request, options);
        } catch (error) {
            return errorResponse(error);
        }
    };

export type { NodeDispatchInvocation, NodeDispatchRouteOptions };
export { createNodeDispatchRoute, createShardInvoke, NODE_SCHEDULER_DISPATCH_PATH };
