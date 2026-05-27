import { CirrusError, toErrorResponse } from "./errors.js";
import type { FanOutSpec, QueryCoordinator } from "./queryCoordinator.js";
import type { ShardNamespaceLike } from "./resolveShard.js";
import { resolveShard } from "./resolveShard.js";

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

            if (envelope.fanOut) {
                if (!options.queryCoordinator) {
                    throw new CirrusError("RPC envelope set `fanOut` but no `queryCoordinator` is configured on the worker", {
                        code: "BAD_REQUEST",
                        status: 400,
                    });
                }

                const result = await options.queryCoordinator.fanOut(options.shardDO, {
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
