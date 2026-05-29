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
 * Context handed to HTTP-action handlers. Built per request by the worker; its
 * `run*` methods forward an RPC envelope to the shard, so handlers reach
 * queries/mutations/actions without a direct DB binding.
 *
 * `reference` is typed `unknown` so this structural contract stays free of a
 * `@cirrus/server` dependency while remaining assignable from the fully-typed
 * `HttpActionCtx` on the server side (`{ __cirrusRef }` is read at runtime).
 */
export interface HttpActionContext {
    auth: { getIdentity: () => Promise<Record<string, unknown> | null>; userId: null | string };
    fetch: typeof globalThis.fetch;
    runAction: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runMutation: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runQuery: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
}

export interface HttpActionLike {
    handler: (ctx: HttpActionContext, request: Request) => Promise<Response> | Response;
}

/**
 * Structural view of `@cirrus/server`'s `httpRouter()`. The worker dispatches by
 * calling `fetch` — the same shape as a hono app's `app.fetch` — so the runtime
 * stays free of a hard dependency on the server package (and on hono). The
 * per-request {@link HttpActionContext} is injected on the `__cirrusCtx` env
 * binding; the router lifts it into the handler's context.
 */
export interface HttpRouterLike {
    // A method signature (not an arrow property) so parameters are compared
    // bivariantly — this lets a real hono app, whose `fetch` is typed against its
    // own `Bindings`/`ExecutionContext` (which carries a required `props`), assign
    // structurally here; an arrow property would reject it under strict variance.
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- bivariant params are load-bearing for hono compatibility
    fetch(request: Request, env?: unknown, ctx?: ExecutionContextLike): Promise<Response> | Response;
}

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
     * Router for HTTP actions (`httpRouter()` from `@cirrus/server`, a hono app).
     * Consulted for requests that miss the explicit {@link WorkerOptions.routes}
     * map and the internal `/_cirrus/*` endpoints. The runtime builds the action
     * context, injects it on the `__cirrusCtx` env binding, and dispatches via
     * `httpRouter.fetch`; matched handlers reach the data layer through
     * `ctx.run*`, which forward to the shard. An unmatched request returns hono's
     * own 404 (a path-match with the wrong verb is a 404, not a 405).
     */
    httpRouter?: HttpRouterLike;
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
const MIGRATE_PATH = "/_cirrus/migrate";

/**
 * Admin RPCs the migration endpoint is allowed to orchestrate. Spelled out
 * inline (rather than importing `@cirrus/do`) to keep the runtime free of a
 * hard dependency on the DO package.
 */
const MIGRATION_ADMIN_OPS = new Set<string>(["__cirrus_admin__:migrationStatus", "__cirrus_admin__:runMigration"]);

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
            const { headers: forwardedHeaders } = await resolveForwardContext(request, env, options.resolveIdentity);

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

        if (url.pathname === MIGRATE_PATH) {
            return handleMigrate(request, env);
        }

        // HTTP actions are the lowest-priority matcher: explicit routes and the
        // internal `/_cirrus/*` endpoints above always win. Once the request
        // reaches the router, hono owns routing — its 404 is the terminal 404.
        const httpRouteResponse = await dispatchHttpRoute(request, env, ctx);

        if (httpRouteResponse) {
            return httpRouteResponse;
        }

        return new Response("Not found", { status: 404 });
    };

    const handleMigrate = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Migration endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!options.queryCoordinator) {
            throw new CirrusError("Migration endpoint requires a `queryCoordinator` on the worker", { code: "BAD_REQUEST", status: 400 });
        }

        const migrate = await parseMigrateRequest(request);

        // Forward the inbound `Authorization` bearer so each shard's admin gate
        // accepts the fanned-out RPC.
        const { headers: forwardedHeaders } = await resolveForwardContext(request, env, options.resolveIdentity);

        const result = await options.queryCoordinator.orchestrateMigration(options.shardDO, {
            args: migrate.args,
            functionPath: migrate.functionPath,
            headers: forwardedHeaders,
            table: migrate.table,
        });

        return Response.json(result, {
            headers: { "content-type": "application/json" },
            status: 200,
        });
    };

    const dispatchHttpRoute = async (request: Request, env: unknown, ctx: ExecutionContextLike): Promise<null | Response> => {
        if (!options.httpRouter) {
            return null;
        }

        // Build the action context up front and inject it on a private env
        // binding; the router's middleware lifts it into the handler's context.
        // hono then matches/dispatches and returns its own response (incl. 404).
        const httpCtx = await buildHttpActionCtx(request, env);

        return options.httpRouter.fetch(request, { ...(env as object), __cirrusCtx: httpCtx }, ctx);
    };

    const buildHttpActionCtx = async (request: Request, env: unknown): Promise<HttpActionContext> => {
        const { claims, headers, userId } = await resolveForwardContext(request, env, options.resolveIdentity);

        const run = async <R>(reference: unknown, args: Record<string, unknown> = {}): Promise<R> => {
            const functionPath = (reference as { __cirrusRef?: unknown }).__cirrusRef;

            if (typeof functionPath !== "string") {
                throw new CirrusError("ctx.run*: expected a function reference from the generated `api`", { code: "BAD_REQUEST", status: 400 });
            }

            const forwarded = new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args, functionPath }),
                headers,
                method: "POST",
            });

            const response = await forwardToShard(options.shardDO, defaultShard, forwarded);
            const payload = (await response.json()) as { error?: { code?: string; message?: string }; result?: unknown };

            if (payload.error) {
                throw new CirrusError(payload.error.message ?? "shard RPC failed", {
                    code: payload.error.code ?? "INTERNAL",
                    status: response.status,
                });
            }

            return payload.result as R;
        };

        return {
            auth: {
                getIdentity: async () => claims,
                userId,
            },
            fetch: globalThis.fetch.bind(globalThis),
            runAction: run,
            runMutation: run,
            runQuery: run,
        };
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

interface ForwardContext {
    /** Identity claims minus `userId`, or `null` when anonymous / no extra claims. */
    claims: Record<string, unknown> | null;
    /** Headers to forward to the shard (`content-type` + auth/cookie/bookmark/identity). */
    headers: Record<string, string>;
    /** Resolved stable user id, or `null` when anonymous. */
    userId: null | string;
}

/**
 * Build the headers forwarded to the shard and the resolved identity, shared by
 * the RPC path and HTTP-action context. `userId` and `claims` mirror what the
 * DO reconstructs from the `x-cirrus-userid` / `x-cirrus-identity` headers.
 */
const resolveForwardContext = async (request: Request, env: unknown, resolveIdentity: WorkerOptions["resolveIdentity"]): Promise<ForwardContext> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const authorization = request.headers.get("authorization");
    const cookie = request.headers.get("cookie");
    const bookmark = request.headers.get("x-d1-bookmark");

    if (authorization) {
        headers["authorization"] = authorization;
    }

    if (cookie) {
        headers["cookie"] = cookie;
    }

    if (bookmark) {
        headers["x-d1-bookmark"] = bookmark;
    }

    if (!resolveIdentity) {
        return { claims: null, headers, userId: null };
    }

    const identity = await resolveIdentity(request, env);

    if (!identity || typeof identity.userId !== "string" || identity.userId.length === 0) {
        return { claims: null, headers, userId: null };
    }

    headers["x-cirrus-userid"] = identity.userId;

    // Strip `userId` so the DO doesn't see it twice. The rest of the identity
    // (claims like email/name/roles) is JSON-encoded so handlers can read it
    // via `ctx.auth.getIdentity()`.
    const { userId, ...extra } = identity;
    const claims = Object.keys(extra).length > 0 ? extra : null;

    if (claims) {
        headers["x-cirrus-identity"] = JSON.stringify(claims);
    }

    return { claims, headers, userId };
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

interface MigrateRequest {
    args: Record<string, unknown>;
    functionPath: string;
    table: string;
}

/**
 * Parse and validate a `POST /_cirrus/migrate` body. `functionPath` is
 * restricted to the migration admin ops so the endpoint can't be used to
 * fan arbitrary RPCs across every shard.
 */
const parseMigrateRequest = async (request: Request): Promise<MigrateRequest> => {
    let body: unknown;

    try {
        body = await request.json();
    } catch {
        throw new CirrusError("Migration body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
    }

    const candidate = (body ?? {}) as { args?: unknown; functionPath?: unknown; table?: unknown };

    if (typeof candidate.table !== "string" || candidate.table.length === 0) {
        throw new CirrusError("Migration request is missing `table`", { code: "BAD_REQUEST", status: 400 });
    }

    if (typeof candidate.functionPath !== "string" || !MIGRATION_ADMIN_OPS.has(candidate.functionPath)) {
        throw new CirrusError("Migration request `functionPath` must be a migration admin op", { code: "BAD_REQUEST", status: 400 });
    }

    return {
        args: (candidate.args ?? {}) as Record<string, unknown>,
        functionPath: candidate.functionPath,
        table: candidate.table,
    };
};

const forwardToShard = async (namespace: ShardNamespaceLike, shardKey: string, request: Request): Promise<Response> => {
    const stub = resolveShard(namespace, shardKey);

    return stub.fetch(request);
};

/** Re-exported helper so callers can roundtrip envelopes in tests. */
export const defineRpcEnvelope = (envelope: RpcEnvelope): RpcEnvelope => envelope;
