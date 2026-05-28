import { CirrusError, toErrorResponse } from "./errors.js";
import type { FanOutSpec, QueryCoordinator } from "./query-coordinator.js";
import type { ShardNamespaceLike } from "./resolve-shard.js";
import { resolveShard } from "./resolve-shard.js";

/**
 * Wire-format RPC envelope. Posted to `POST /_cirrus/rpc`.
 *
 * `functionPath` is the `<file>:<function>` identifier emitted by codegen,
 * e.g. `"messages:list"`. `shardKey` is optional — when omitted the runtime
 * routes to {@link WorkerOptions.defaultShardKey} (default `"__root__"`).
 *
 * `fanOut` opts the envelope into cross-shard routing via the
 * {@link WorkerOptions.queryCoordinator}; mutually exclusive with
 * `shardKey` (specifying both is a 400 — fan-out *is* the shard choice).
 */
export interface RpcEnvelope {
    args?: Record<string, unknown>;
    fanOut?: FanOutSpec;
    functionPath: string;
    shardKey?: string;
}

export interface ExecutionContextLike {
    passThroughOnException: () => void;
    waitUntil: (promise: Promise<unknown>) => void;
}

export type Route = (request: Request, env: unknown, ctx: ExecutionContextLike) => Promise<Response> | Response;

/**
 * Identity resolved from the inbound request by {@link WorkerOptions.resolveIdentity}.
 *
 * The `userId` field is special — it becomes `ctx.auth.userId` inside the
 * Durable Object. Any other keys (`email`, `name`, custom roles, etc.) are
 * forwarded verbatim as `ctx.auth.getIdentity()`'s return value.
 *
 * Return `null` to signal that the request is anonymous; the runtime will
 * skip both `x-cirrus-userid` and `x-cirrus-identity` headers, and
 * `ctx.auth.userId` will be `undefined` on the shard side.
 */
export interface ResolvedIdentity {
    /** Arbitrary additional claims. Must be JSON-serialisable. */
    [key: string]: unknown;
    /** Stable user identifier (e.g. `"user_2k3..."` or `"u_42"`). */
    userId: string;
}

export interface WorkerOptions {
    /**
     * D1 binding for `.global()` tables. Currently unused by the routing
     * layer; downstream packages will read it from `env.DB` directly.
     */
    d1?: unknown;
    /** Default shard key used when an envelope omits one. */
    defaultShardKey?: string;
    /**
     * When true, the runtime calls `ctx.passThroughOnException()` at the top
     * of the fetch handler. Forwards uncaught exceptions to the origin
     * instead of returning a synthetic 500.
     */
    passThroughOnException?: boolean;
    /**
     * Coordinator for cross-shard RPCs. When absent, envelopes with
     * `fanOut` set are rejected with a 400. Construct via
     * `createQueryCoordinator({ registry })`.
     */
    queryCoordinator?: QueryCoordinator;
    /**
     * Resolve the calling identity from the inbound RPC request. Called once
     * per RPC (and per fan-out) before the request is forwarded to the
     * shard. The returned `userId` becomes `ctx.auth.userId` on the shard
     * side; remaining keys (`email`, role flags, etc.) are JSON-encoded and
     * forwarded as `x-cirrus-identity` so `ctx.auth.getIdentity()` can
     * return them. Returning `null` (or omitting this option) means
     * anonymous — no identity headers are injected.
     */
    resolveIdentity?: (request: Request, env: unknown) => Promise<ResolvedIdentity | null> | ResolvedIdentity | null;
    /**
     * Map of routes for custom HTTP handlers (auth callbacks etc.). Keys can
     * be either `"METHOD path"` (e.g. `"GET /healthz"`) or just `"path"`
     * (e.g. `"/healthz"`) — the runtime will match the more specific form
     * first.
     */
    routes?: Record<string, Route>;
    /** Namespace binding for the shard Durable Object (typically `env.SHARD`). */
    shardDO: ShardNamespaceLike;
}

export interface RpcContext {
    ctx: ExecutionContextLike;
    env: unknown;
    request: Request;
    shardKey: string;
}

const RPC_PATH = "/_cirrus/rpc";
const WS_PATH = "/_cirrus/ws";

/**
 * Build a Cloudflare Worker entry. Returns an object with `fetch` so it can
 * be re-exported directly as `export default createWorker(...)`.
 */
export const createWorker = (options: WorkerOptions): { fetch: (request: Request, env: unknown, ctx: ExecutionContextLike) => Promise<Response> } => {
    const defaultShard = options.defaultShardKey ?? "__root__";

    const handle = async (request: Request, env: unknown, ctx: ExecutionContextLike): Promise<Response> => {
        const url = new URL(request.url);

        // Auth providers register routes as `"METHOD path"` (e.g. `"GET /auth/signin"`).
        // We also accept legacy pathname-only keys for ad-hoc handlers.
        const methodAndPath = `${request.method} ${url.pathname}`;
        const route = options.routes?.[methodAndPath] ?? options.routes?.[url.pathname];

        if (route) {
            return route(request, env, ctx);
        }

        if (url.pathname === WS_PATH) {
            if (request.headers.get("Upgrade") !== "websocket") {
                throw new CirrusError("WebSocket upgrade header missing", { code: "BAD_REQUEST", status: 426 });
            }

            const shardKey = url.searchParams.get("shard") ?? defaultShard;

            return forwardToShard(options.shardDO, shardKey, request);
        }

        if (url.pathname === RPC_PATH) {
            if (request.method !== "POST") {
                throw new CirrusError("RPC endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
            }

            const envelope = await parseEnvelope(request);

            if (envelope.fanOut && envelope.shardKey) {
                throw new CirrusError("RPC envelope cannot set both `shardKey` and `fanOut`", { code: "BAD_REQUEST", status: 400 });
            }

            // Refuse fan-out envelopes that arrive without a coordinator
            // configured BEFORE we invoke `resolveIdentity` — otherwise the
            // hook would be called for a request that's already destined for
            // a 400, wasting any DB/IO it performs to look up the user.
            if (envelope.fanOut && !options.queryCoordinator) {
                throw new CirrusError("RPC envelope set `fanOut` but no `queryCoordinator` is configured on the worker", {
                    code: "BAD_REQUEST",
                    status: 400,
                });
            }

            // Forward selected headers from the inbound request so the DO can
            // honour auth, sessions, and D1 read-your-writes consistency.
            const forwardedHeaders: Record<string, string> = { "content-type": "application/json" };
            const authorization = request.headers.get("authorization");
            const cookie = request.headers.get("cookie");
            const bookmark = request.headers.get("x-d1-bookmark");

            if (authorization) {
                forwardedHeaders["authorization"] = authorization;
            }

            if (cookie) {
                forwardedHeaders["cookie"] = cookie;
            }

            if (bookmark) {
                forwardedHeaders["x-d1-bookmark"] = bookmark;
            }

            if (options.resolveIdentity) {
                const identity = await options.resolveIdentity(request, env);

                if (identity && typeof identity.userId === "string" && identity.userId.length > 0) {
                    forwardedHeaders["x-cirrus-userid"] = identity.userId;

                    // Strip `userId` from the envelope so the DO doesn't see it
                    // twice. The rest of the identity (claims like email/name
                    // /roles) is JSON-encoded so handlers can read it via
                    // `ctx.auth.getIdentity()`.
                    const { userId: _userId, ...extra } = identity;

                    if (Object.keys(extra).length > 0) {
                        forwardedHeaders["x-cirrus-identity"] = JSON.stringify(extra);
                    }
                }
            }

            if (envelope.fanOut) {
                // Coordinator presence was checked above.
                const coordinator = options.queryCoordinator!;
                const result = await coordinator.fanOut(options.shardDO, {
                    args: envelope.args ?? {},
                    fanOut: envelope.fanOut,
                    functionPath: envelope.functionPath,
                    headers: forwardedHeaders,
                });

                return Response.json(result, {
                    headers: { "content-type": "application/json" },
                    status: 200,
                });
            }

            const shardKey = envelope.shardKey ?? defaultShard;

            // Re-emit the RPC body to the shard at its `/rpc` route.
            const forwarded = new Request(`https://shard.internal/rpc`, {
                body: JSON.stringify({ args: envelope.args ?? {}, functionPath: envelope.functionPath }),
                headers: forwardedHeaders,
                method: "POST",
            });

            const response = await forwardToShard(options.shardDO, shardKey, forwarded);

            // Propagate the DO's bookmark header so the client can pin reads
            // after a write.
            const responseBookmark = response.headers.get("x-d1-bookmark");

            if (responseBookmark) {
                const headers = new Headers(response.headers);

                headers.set("x-d1-bookmark", responseBookmark);

                return new Response(response.body, { status: response.status, headers });
            }

            return response;
        }

        return new Response("Not found", { status: 404 });
    };

    return {
        async fetch(request, env, ctx) {
            if (options.passThroughOnException) {
                ctx.passThroughOnException();
            }

            try {
                return await handle(request, env, ctx);
            } catch (error: unknown) {
                return toErrorResponse(error);
            }
        },
    };
};

const parseEnvelope = async (request: Request): Promise<RpcEnvelope> => {
    let body: unknown;

    try {
        body = await request.json();
    } catch {
        throw new CirrusError("RPC body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
    }

    if (!body || typeof body !== "object" || typeof (body as { functionPath?: unknown }).functionPath !== "string") {
        throw new CirrusError("RPC envelope is missing `functionPath`", { code: "BAD_REQUEST", status: 400 });
    }

    const envelope = body as RpcEnvelope;

    return {
        args: envelope.args ?? {},
        fanOut: envelope.fanOut,
        functionPath: envelope.functionPath,
        shardKey: envelope.shardKey,
    };
};

const forwardToShard = async (namespace: ShardNamespaceLike, shardKey: string, request: Request): Promise<Response> => {
    const stub = resolveShard(namespace, shardKey);

    return stub.fetch(request);
};

/** Re-exported helper so callers can roundtrip envelopes in tests. */
export const defineRpcEnvelope = (envelope: RpcEnvelope): RpcEnvelope => envelope;
