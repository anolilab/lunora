import { CirrusError, toErrorResponse } from "./errors.js";
import type { ObservabilityEvent, ObservabilitySink } from "./observability.js";
import { emitRpcEvent } from "./observability.js";
import type { FanOutSpec, QueryCoordinator } from "./query-coordinator.js";
import type { ResolvedShard, ShardNamespaceLike } from "./resolve-shard.js";
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

/**
 * Per-table sharding metadata the admin import endpoint needs to route rows.
 * Structural so this package stays free of `@cirrus/server`. The codegen-
 * generated worker entry passes a thin projection of the user's schema.
 */
export interface ShardingInfo {
    /** `global` when the table lives in D1; `shardBy` when keyed by a field; `root` (or absent) otherwise. */
    mode: { field?: string; kind: "global" | "root" | "shardBy" };
}

/**
 * Lookup the runtime uses to bucket an import row to its owning shard. Returns
 * `undefined` for unknown tables — the row is reported as a hard error.
 */
export type AdminTableResolver = (table: string) => ShardingInfo | undefined;

/**
 * Streamed bulk export of `.global()` tables, materialised as an async iterable
 * of `{table, doc}` rows. The runtime concatenates this stream after the
 * shard-local stream so the receiver sees a single NDJSON body.
 */
export type GlobalExportFn = (request: { tables: ReadonlyArray<string> }) => AsyncIterable<{ doc: Record<string, unknown>; table: string }>;

/** Bulk import of `.global()` rows. Returns insert counts + errors merged across tables. */
export type GlobalImportFn = (request: { rows: ReadonlyArray<{ doc: Record<string, unknown>; table: string }>; startLine?: number }) => Promise<{
    conflicts: number;
    errors: ReadonlyArray<{ code: string; line: number; message: string; table: string }>;
    inserted: Record<string, number>;
}>;

/** One R2 object as the storage browser surfaces it. Mirrors `@cirrus/storage`'s `R2ObjectLike`. */
export interface StorageObject {
    customMetadata?: Record<string, string>;
    etag: string;
    httpMetadata?: { contentType?: string };
    key: string;
    size: number;
}

/**
 * One registered function, as the discovery endpoint surfaces it. Structurally
 * a subset of codegen's `RegisteredCirrusFunction` — only `kind` and
 * `visibility` matter here, so the generated `CIRRUS_FUNCTIONS` map satisfies
 * the {@link FunctionRegistryLike} value shape.
 */
export interface FunctionDescriptor {
    kind: "action" | "mutation" | "query";
    /** The `<file>:<function>` identifier, e.g. `messages:list`. */
    path: string;
    /** `"internal"` functions are never exposed by the discovery endpoint; absence === public. */
    visibility?: "internal" | "public";
}

/** One value in {@link FunctionRegistryLike} — the bits of a registered function the discovery endpoint reads. */
export interface FunctionRegistryEntry {
    kind: "action" | "mutation" | "query";
    visibility?: "internal" | "public";
}

/**
 * The generated `CIRRUS_FUNCTIONS` dispatch table, narrowed to what the
 * discovery endpoint reads. Pass the map straight from `_generated/server.ts`.
 */
export type FunctionRegistryLike = Record<string, FunctionRegistryEntry>;

/**
 * Lists objects in the storage bucket for the admin file browser. Structurally
 * compatible with `@cirrus/storage`'s `Storage["list"]` — the runtime stays free
 * of a hard dependency on the storage package.
 */
export type StorageListFn = (prefix?: string, opts?: { cursor?: string; limit?: number }) => Promise<{ cursor?: string; objects: StorageObject[] }>;

/** One `.global()` table plus its row count. Mirrors `@cirrus/d1`'s `GlobalTableInfo`. */
export interface GlobalTableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one global table. Mirrors `@cirrus/d1`'s `GlobalTablePage`. */
export interface GlobalTablePage {
    columns: string[];
    rows: Record<string, unknown>[];
    total: number;
}

/**
 * Introspect `.global()` (D1-backed) tables for the data browser. Structurally
 * compatible with `@cirrus/d1`'s `listGlobalTables` / `readGlobalTablePage`
 * (curried with the D1 exec + schema) — the runtime stays free of a hard
 * dependency on the D1 package.
 */
export interface GlobalIntrospector {
    listTables: () => Promise<GlobalTableInfo[]>;
    readTablePage: (options: { limit?: number; offset?: number; table: string }) => Promise<GlobalTablePage>;
}

/** A timestamp as better-auth stores it: epoch-ms, an ISO string, or absent. */
export type AuthTimestamp = null | number | string;

/** One authenticated user, as the auth browser surfaces it. Mirrors better-auth's `user` row. */
export interface AuthUser {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    email?: null | string;
    emailVerified?: boolean | null;
    id: string;
    image?: null | string;
    name?: null | string;
}

/** One auth session, as the auth browser surfaces it. Mirrors better-auth's `session` row. */
export interface AuthSession {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    expiresAt?: AuthTimestamp;
    id: string;
    ipAddress?: null | string;
    userAgent?: null | string;
    userId: string;
}

/** A page of users or sessions plus the total count, for paginated browsing. */
export interface AuthPage<T> {
    rows: T[];
    total: number;
}

/**
 * Read-only introspector for the auth store's users and sessions, backing the
 * dashboard's users panel via `GET /_cirrus/admin/auth/users` and
 * `/_cirrus/admin/auth/sessions`. The host wires this to better-auth's tables;
 * the runtime stays free of a hard dependency on `@cirrus/auth`. Omit it and
 * those endpoints respond `AUTH_NOT_CONFIGURED`.
 */
export interface AuthIntrospector {
    listSessions: (options: { limit?: number; offset?: number; userId?: string }) => Promise<AuthPage<AuthSession>>;
    listUsers: (options: { limit?: number; offset?: number }) => Promise<AuthPage<AuthUser>>;
}

export interface WorkerOptions {
    /**
     * Admin bearer token expected by the export/import endpoints. When unset,
     * the endpoints respond with `ADMIN_FORBIDDEN` — the same posture the
     * per-shard admin gate uses.
     */
    adminToken?: string;
    /**
     * Read-only introspector for the auth store's users and sessions, backing
     * the dashboard's users panel via `GET /_cirrus/admin/auth/users` and
     * `/_cirrus/admin/auth/sessions`. Omit it and those endpoints respond
     * `AUTH_NOT_CONFIGURED`.
     */
    authIntrospector?: AuthIntrospector;
    /**
     * D1 binding for `.global()` tables. Currently unused by the routing
     * layer; downstream packages will read it from `env.DB` directly.
     */
    d1?: unknown;
    /** Default shard key used when an envelope omits one. */
    defaultShardKey?: string;
    /**
     * Stream `.global()` rows for the admin export endpoint. When omitted,
     * the export endpoint covers only shard-local tables.
     */
    exportGlobals?: GlobalExportFn;
    /**
     * The generated `CIRRUS_FUNCTIONS` map (from `_generated/server.ts`). When
     * set, the worker exposes the admin-gated `GET /_cirrus/admin/functions`
     * endpoint the dashboard uses to auto-discover queries/mutations/actions
     * (internal functions are filtered out). Omit it and the endpoint responds
     * `FUNCTIONS_NOT_CONFIGURED`.
     */
    functions?: FunctionRegistryLike;
    /**
     * Read-only introspector for `.global()` (D1) tables, backing the data
     * browser's global mode via `GET /_cirrus/admin/global/tables` and
     * `/_cirrus/admin/global/table`. Build it from `@cirrus/d1`'s
     * `listGlobalTables` / `readGlobalTablePage`. Omit it and those endpoints
     * respond `GLOBALS_NOT_CONFIGURED`.
     */
    globalIntrospector?: GlobalIntrospector;
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
     * Insert `.global()` rows for the admin import endpoint. When omitted,
     * rows targeting global tables are reported as hard errors.
     */
    importGlobals?: GlobalImportFn;
    /**
     * Optional telemetry sink. When supplied, the worker emits one
     * `onRpc` event per dispatched RPC (single-shard forward or fan-out)
     * with duration / ok / error / shardKey or fanOut metadata. Sink
     * throws are swallowed so a faulty adapter cannot break user-facing
     * dispatch. See {@link ObservabilitySink}.
     */
    observability?: ObservabilitySink;
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
     * Resolve a table's sharding metadata. Required by the import endpoint to
     * bucket rows; when omitted, every row routes to the default shard.
     */
    resolveTableSharding?: AdminTableResolver;
    /**
     * Map of routes for custom HTTP handlers (auth callbacks etc.). Keys can
     * be either `"METHOD path"` (e.g. `"GET /healthz"`) or just `"path"`
     * (e.g. `"/healthz"`) — the runtime will match the more specific form
     * first.
     */
    routes?: Record<string, Route>;
    /**
     * Namespace binding for the `SchedulerDO` (typically `env.SCHEDULER`). When
     * set, the worker exposes the admin-gated `/_cirrus/admin/scheduled`
     * endpoints used by the dashboard to list and cancel `runAfter` / `runAt`
     * jobs. Omit it and those endpoints respond `SCHEDULER_NOT_CONFIGURED`.
     */
    schedulerDO?: ShardNamespaceLike;
    /**
     * Named `SchedulerDO` instance the admin endpoints target. Must match the
     * `instanceName` passed to `createScheduler` (both default to `default`).
     */
    schedulerInstanceName?: string;
    /** Namespace binding for the shard Durable Object (typically `env.SHARD`). */
    shardDO: ShardNamespaceLike;
    /**
     * Storage lister backing the admin-gated `GET /_cirrus/admin/storage`
     * endpoint the dashboard's file browser calls. The structural shape matches
     * `@cirrus/storage`'s `Storage["list"]`, so passing `createStorage(...).list`
     * (or the raw R2 bucket's `list`) satisfies it. Omit it and the endpoint
     * responds `STORAGE_NOT_CONFIGURED`.
     */
    storageList?: StorageListFn;
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
const EXPORT_PATH = "/_cirrus/admin/export";
const IMPORT_PATH = "/_cirrus/admin/import";
const SCHEDULED_PATH = "/_cirrus/admin/scheduled";
const SCHEDULED_CANCEL_PATH = "/_cirrus/admin/scheduled/cancel";
const STORAGE_PATH = "/_cirrus/admin/storage";
const FUNCTIONS_PATH = "/_cirrus/admin/functions";
const GLOBAL_TABLES_PATH = "/_cirrus/admin/global/tables";
const GLOBAL_TABLE_PATH = "/_cirrus/admin/global/table";
const AUTH_USERS_PATH = "/_cirrus/admin/auth/users";
const AUTH_SESSIONS_PATH = "/_cirrus/admin/auth/sessions";

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

            // Timing wraps the dispatch only — envelope parse + coordinator
            // gate + identity resolution happen above and are not part of
            // the user-observable RPC duration we report.
            const rpcStartedAt = Date.now();
            const { observability } = options;

            if (envelope.fanOut) {
                // Coordinator presence was checked above.
                const coordinator = options.queryCoordinator!;

                try {
                    const result = await coordinator.fanOut(options.shardDO, {
                        args: envelope.args ?? {},
                        fanOut: envelope.fanOut,
                        functionPath: envelope.functionPath,
                        headers: forwardedHeaders,
                    });

                    emitRpcEvent(observability, {
                        durationMs: Date.now() - rpcStartedAt,
                        fanOut: {
                            failed: result.failed,
                            shards: result.ok + result.failed,
                            table: envelope.fanOut.table,
                        },
                        functionPath: envelope.functionPath,
                        ok: true,
                    });

                    return Response.json(result, {
                        headers: { "content-type": "application/json" },
                        status: 200,
                    });
                } catch (error) {
                    emitRpcEvent(
                        observability,
                        buildErrorEvent(envelope.functionPath, Date.now() - rpcStartedAt, error, { fanOut: { table: envelope.fanOut.table } }),
                    );
                    throw error;
                }
            }

            const shardKey = envelope.shardKey ?? defaultShard;

            // Re-emit the RPC body to the shard at its `/rpc` route.
            const forwarded = new Request(`https://shard.internal/rpc`, {
                body: JSON.stringify({ args: envelope.args ?? {}, functionPath: envelope.functionPath }),
                headers: forwardedHeaders,
                method: "POST",
            });

            try {
                const response = await forwardToShard(options.shardDO, shardKey, forwarded);

                // A non-2xx from the shard is reported as ok=false even though no
                // exception was thrown — the user-visible result is still an error
                // surface, just one the shard chose to encode in the status code.
                emitRpcEvent(observability, {
                    durationMs: Date.now() - rpcStartedAt,
                    functionPath: envelope.functionPath,
                    ok: response.ok,
                    shardKey,
                    ...response.ok ? {} : { error: { code: "SHARD_ERROR", message: `shard returned ${response.status}`, status: response.status } },
                });

                // Propagate the DO's bookmark header so the client can pin reads
                // after a write.
                const responseBookmark = response.headers.get("x-d1-bookmark");

                if (responseBookmark) {
                    const headers = new Headers(response.headers);

                    headers.set("x-d1-bookmark", responseBookmark);

                    return new Response(response.body, { status: response.status, headers });
                }

                return response;
            } catch (error) {
                emitRpcEvent(observability, buildErrorEvent(envelope.functionPath, Date.now() - rpcStartedAt, error, { shardKey }));
                throw error;
            }
        }

        if (url.pathname === MIGRATE_PATH) {
            return handleMigrate(request, env);
        }

        if (url.pathname === EXPORT_PATH) {
            return handleExport(request, env);
        }

        if (url.pathname === IMPORT_PATH) {
            return handleImport(request, env);
        }

        if (url.pathname === SCHEDULED_CANCEL_PATH) {
            return handleScheduledCancel(request);
        }

        if (url.pathname === SCHEDULED_PATH) {
            return handleScheduledList(request);
        }

        if (url.pathname === STORAGE_PATH) {
            return handleStorageList(request);
        }

        if (url.pathname === FUNCTIONS_PATH) {
            return handleFunctionsList(request);
        }

        if (url.pathname === GLOBAL_TABLES_PATH) {
            return handleGlobalTables(request);
        }

        if (url.pathname === GLOBAL_TABLE_PATH) {
            return handleGlobalTablePage(request);
        }

        if (url.pathname === AUTH_USERS_PATH) {
            return handleAuthUsers(request);
        }

        if (url.pathname === AUTH_SESSIONS_PATH) {
            return handleAuthSessions(request);
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

    const handleExport = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Export endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!checkAdminAuth(request, options.adminToken)) {
            throw new CirrusError("admin export endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        if (!options.queryCoordinator) {
            throw new CirrusError("Export endpoint requires a `queryCoordinator` on the worker", { code: "BAD_REQUEST", status: 400 });
        }

        const body = await parseExportBody(request);

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env, options.resolveIdentity);

        // Partition the requested tables into shard-local vs global. `null`
        // tables means "every table" — we let the per-shard exporter decide.
        const shardLocalTables: string[] = [];
        const globalTables: string[] = [];

        if (body.tables && body.tables.length > 0) {
            for (const table of body.tables) {
                const info = options.resolveTableSharding?.(table);

                if (info?.mode.kind === "global") {
                    globalTables.push(table);
                } else {
                    shardLocalTables.push(table);
                }
            }
        }

        const wantGlobals = body.tables === undefined || globalTables.length > 0;
        const exportGlobalsFn = options.exportGlobals;

        // Stream NDJSON: shard-local rows first (from `orchestrateExport`'s
        // collected envelopes), then global rows (from the D1 helper). The
        // shard fan-out is materialised because each shard returns a single
        // envelope; we still write the response incrementally so a slow
        // consumer never inflates worker memory.
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                const encoder = new TextEncoder();
                const writeRow = (row: { doc: Record<string, unknown>; table: string }): void => {
                    controller.enqueue(encoder.encode(`${JSON.stringify(row)}\n`));
                };

                try {
                    // Shard-local: only fan out when caller wants any of them.
                    if (body.tables === undefined || shardLocalTables.length > 0) {
                        const coordinator = options.queryCoordinator!;
                        const exportTables = body.tables === undefined ? [] : shardLocalTables;
                        // When tables is undefined the per-shard exporter
                        // visits every shard-local table, but we still need a
                        // table list to seed the registry probe. Fall back to
                        // `resolveTableSharding`'s keys if the caller passed
                        // none — best effort; a project without the resolver
                        // will simply not fan out automatically.
                        const probeTables =
                            exportTables.length > 0 ? exportTables : body.tables === undefined ? collectKnownTables(options.resolveTableSharding) : [];

                        const result = await coordinator.orchestrateExport(options.shardDO, {
                            args: { tables: exportTables },
                            headers: forwardedHeaders,
                            tables: probeTables,
                        });

                        for (const shard of result.shards) {
                            if (shard.error) {
                                continue;
                            }

                            for (const row of shard.rows ?? []) {
                                writeRow(row);
                            }
                        }
                    }

                    // Globals: stream rows from the D1 helper when configured.
                    if (wantGlobals && exportGlobalsFn) {
                        const tablesArg = body.tables === undefined ? [] : globalTables;
                        const iter = exportGlobalsFn({ tables: tablesArg });

                        for await (const row of iter) {
                            writeRow(row);
                        }
                    }

                    controller.close();
                } catch (error: unknown) {
                    controller.error(error);
                }
            },
        });

        return new Response(stream, { headers: { "content-type": "application/x-ndjson" }, status: 200 });
    };

    const handleImport = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Import endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!checkAdminAuth(request, options.adminToken)) {
            throw new CirrusError("admin import endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        if (!options.queryCoordinator) {
            throw new CirrusError("Import endpoint requires a `queryCoordinator` on the worker", { code: "BAD_REQUEST", status: 400 });
        }

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env, options.resolveIdentity);

        const result = await streamingImport(request, options, forwardedHeaders);

        return Response.json(result, {
            headers: { "content-type": "application/json" },
            status: 200,
        });
    };

    /**
     * Resolve the configured `SchedulerDO` stub, asserting the binding is
     * present and the caller is an admin. Shared by the list/cancel handlers so
     * both enforce the same gate before touching the scheduler.
     */
    /** The `<CODE>_NOT_CONFIGURED` 400 a guarded admin route throws when its backing option is absent. */
    interface NotConfiguredError {
        code: string;
        message: string;
    }

    // --- Shared admin-endpoint helpers --------------------------------------
    // Every admin route shares the same "valid bearer, else 403; required option
    // configured, else <CODE>_NOT_CONFIGURED 400" preamble. Centralizing it keeps
    // the gate uniform — a change to the auth posture touches one place.

    /** Throw 403 unless the request carries a valid admin bearer. */
    const assertAdminAuthorized = (request: Request): void => {
        if (!checkAdminAuth(request, options.adminToken)) {
            throw new CirrusError("admin endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }
    };

    /** Assert admin auth, then assert a worker option is configured; return it (narrowed non-undefined). */
    const requireAdminOption = <T>(request: Request, value: T | undefined, notConfigured: NotConfiguredError): T => {
        assertAdminAuthorized(request);

        if (value === undefined) {
            throw new CirrusError(notConfigured.message, { code: notConfigured.code, status: 400 });
        }

        return value;
    };

    /** Read a query param, collapsing missing (`null`) and empty (`""`) to `undefined`. */
    const queryParam = (url: URL, name: string): string | undefined => {
        const value = url.searchParams.get(name);

        return value === null || value === "" ? undefined : value;
    };

    /** Parse the shared `limit` / `offset` paging params off an admin GET request. */
    const parsePaging = (request: Request): { limit?: number; offset?: number } => {
        const url = new URL(request.url);
        const limitParam = url.searchParams.get("limit");
        const offsetParam = url.searchParams.get("offset");
        const limit = limitParam === null ? undefined : Number.parseInt(limitParam, 10);
        const offset = offsetParam === null ? undefined : Number.parseInt(offsetParam, 10);

        return {
            limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
            offset: offset !== undefined && Number.isFinite(offset) ? offset : undefined,
        };
    };

    const resolveSchedulerStub = (request: Request): ResolvedShard => {
        const namespace = requireAdminOption(request, options.schedulerDO, {
            code: "SCHEDULER_NOT_CONFIGURED",
            message: "scheduled endpoints require a `schedulerDO` namespace on the worker",
        });

        return resolveShard(namespace, options.schedulerInstanceName ?? "default");
    };

    const handleScheduledList = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new CirrusError("Scheduled-list endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const stub = resolveSchedulerStub(request);

        return stub.fetch(new Request("https://scheduler.internal/list", { method: "GET" }));
    };

    const handleScheduledCancel = async (request: Request): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Scheduled-cancel endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const stub = resolveSchedulerStub(request);
        const body = (await request.json().catch(() => null)) as { id?: unknown } | null;

        if (typeof body?.id !== "string" || body.id === "") {
            throw new CirrusError("Scheduled-cancel requires a string `id`", { code: "BAD_REQUEST", status: 400 });
        }

        return stub.fetch(
            new Request("https://scheduler.internal/cancel", {
                body: JSON.stringify({ id: body.id }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    };

    const handleStorageList = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new CirrusError("Storage endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const storageList = requireAdminOption(request, options.storageList, {
            code: "STORAGE_NOT_CONFIGURED",
            message: "storage endpoint requires a `storageList` function on the worker",
        });

        const url = new URL(request.url);
        const result = await storageList(queryParam(url, "prefix"), {
            cursor: queryParam(url, "cursor"),
            ...parsePaging(request),
        });

        return Response.json(result, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleFunctionsList = (request: Request): Response => {
        if (request.method !== "GET") {
            throw new CirrusError("Functions endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const registry = requireAdminOption(request, options.functions, {
            code: "FUNCTIONS_NOT_CONFIGURED",
            message: "functions endpoint requires a `functions` registry on the worker",
        });

        // Internal functions are never exposed — they're unreachable from the
        // client RPC path, so surfacing them in the runner would only mislead.
        const functions: FunctionDescriptor[] = Object.entries(registry)
            .filter(([, entry]) => entry.visibility !== "internal")
            .map(([path, entry]) => ({ kind: entry.kind, path }))
            .sort((a, b) => a.path.localeCompare(b.path));

        return Response.json({ functions }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleGlobalTables = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new CirrusError("Global-tables endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const introspector = requireAdminOption(request, options.globalIntrospector, {
            code: "GLOBALS_NOT_CONFIGURED",
            message: "global endpoints require a `globalIntrospector` on the worker",
        });

        return Response.json(await introspector.listTables(), { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleGlobalTablePage = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new CirrusError("Global-table endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const introspector = requireAdminOption(request, options.globalIntrospector, {
            code: "GLOBALS_NOT_CONFIGURED",
            message: "global endpoints require a `globalIntrospector` on the worker",
        });

        const table = queryParam(new URL(request.url), "table");

        if (table === undefined) {
            throw new CirrusError("Global-table endpoint requires a `table` query param", { code: "BAD_REQUEST", status: 400 });
        }

        const page = await introspector.readTablePage({ ...parsePaging(request), table });

        return Response.json(page, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleAuthUsers = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new CirrusError("Auth-users endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const introspector = requireAdminOption(request, options.authIntrospector, {
            code: "AUTH_NOT_CONFIGURED",
            message: "auth endpoints require an `authIntrospector` on the worker",
        });

        return Response.json(await introspector.listUsers(parsePaging(request)), { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleAuthSessions = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new CirrusError("Auth-sessions endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const introspector = requireAdminOption(request, options.authIntrospector, {
            code: "AUTH_NOT_CONFIGURED",
            message: "auth endpoints require an `authIntrospector` on the worker",
        });

        const userId = queryParam(new URL(request.url), "userId");
        const page = await introspector.listSessions({ ...parsePaging(request), userId });

        return Response.json(page, { headers: { "content-type": "application/json" }, status: 200 });
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
 * Build an `ObservabilityEvent` for a failed RPC dispatch. Extracts code /
 * status / message from a {@link CirrusError} when present; otherwise reports
 * `INTERNAL_SERVER_ERROR` / 500 with the thrown value's message. Used by
 * both the single-shard and fan-out error branches so they emit a uniform
 * shape.
 */
const buildErrorEvent = (
    functionPath: string,
    durationMs: number,
    error: unknown,
    extra: { fanOut?: { table: string }; shardKey?: string },
): ObservabilityEvent => {
    const isCirrus = error instanceof Error && error.name === "CirrusError";
    const errorRecord = error as unknown as Record<string, unknown>;
    const code = isCirrus && typeof errorRecord["code"] === "string" ? (errorRecord["code"] as string) : "INTERNAL_SERVER_ERROR";
    const status = isCirrus && typeof errorRecord["status"] === "number" ? (errorRecord["status"] as number) : 500;
    const message = error instanceof Error ? error.message : String(error);

    return {
        durationMs,
        error: { code, message, status },
        functionPath,
        ok: false,
        ...extra.fanOut ? { fanOut: { failed: 0, shards: 0, table: extra.fanOut.table } } : {},
        ...extra.shardKey ? { shardKey: extra.shardKey } : {},
    };
};

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

interface ExportBody {
    tables: ReadonlyArray<string> | undefined;
}

const parseExportBody = async (request: Request): Promise<ExportBody> => {
    let body: unknown;

    try {
        const text = await request.text();

        body = text === "" ? {} : JSON.parse(text);
    } catch {
        throw new CirrusError("Export body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
    }

    const candidate = (body ?? {}) as { tables?: unknown };

    if (candidate.tables === undefined) {
        return { tables: undefined };
    }

    if (!Array.isArray(candidate.tables)) {
        throw new CirrusError("Export `tables` must be a string array", { code: "BAD_REQUEST", status: 400 });
    }

    const tables: string[] = [];

    for (const entry of candidate.tables) {
        if (typeof entry !== "string" || entry.length === 0) {
            throw new CirrusError("Export `tables` entries must be non-empty strings", { code: "BAD_REQUEST", status: 400 });
        }

        tables.push(entry);
    }

    return { tables };
};

/**
 * Best-effort enumeration of known tables for the auto-export path. The
 * runtime doesn't carry the schema, so we ask the resolver for a sentinel set
 * by probing common conventions; in practice the codegen-generated worker
 * wraps `resolveTableSharding` with `Object.keys(schema.tables)` and returns
 * via a side channel. For now this falls through to an empty list — the CLI
 * always passes explicit `--tables` so this path is mainly defensive.
 */
const collectKnownTables = (resolver: AdminTableResolver | undefined): string[] => {
    void resolver;

    return [];
};

interface AdminBatch {
    rows: { doc: Record<string, unknown>; table: string }[];
    shardKey: string;
    startLine: number;
}

/**
 * Stream the inbound NDJSON body, bucket rows per shard, and forward them to
 * the coordinator's import fan-out. Globals are siphoned off and handed to the
 * `importGlobals` callback (if present) so the two storage planes can run in
 * parallel.
 */
const streamingImport = async (
    request: Request,
    options: WorkerOptions,
    forwardedHeaders: Record<string, string>,
): Promise<{
    conflicts: number;
    errors: { code: string; line: number; message: string; table: string }[];
    inserted: Record<string, number>;
}> => {
    const defaultShard = options.defaultShardKey ?? "__root__";

    if (!request.body) {
        throw new CirrusError("Import endpoint requires a request body", { code: "BAD_REQUEST", status: 400 });
    }

    const errors: { code: string; line: number; message: string; table: string }[] = [];
    const globalRows: { doc: Record<string, unknown>; table: string }[] = [];
    const globalLineMap: number[] = [];
    const perShard = new Map<string, AdminBatch>();
    let lineNumber = 0;

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handleLine = (line: string): void => {
        const trimmed = line.trim();

        if (trimmed.length === 0) {
            return;
        }

        lineNumber += 1;

        let parsed: unknown;

        try {
            parsed = JSON.parse(trimmed);
        } catch {
            errors.push({ code: "BAD_ROW", line: lineNumber, message: "line is not valid JSON", table: "" });

            return;
        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            errors.push({ code: "BAD_ROW", line: lineNumber, message: "row must be a JSON object", table: "" });

            return;
        }

        const candidate = parsed as { doc?: unknown; table?: unknown };

        if (typeof candidate.table !== "string" || candidate.table.length === 0) {
            errors.push({ code: "BAD_ROW", line: lineNumber, message: "row is missing `table`", table: "" });

            return;
        }

        if (!candidate.doc || typeof candidate.doc !== "object" || Array.isArray(candidate.doc)) {
            errors.push({ code: "BAD_ROW", line: lineNumber, message: "row is missing or malformed `doc`", table: candidate.table });

            return;
        }

        const { table } = candidate;
        const doc = candidate.doc as Record<string, unknown>;
        const info = options.resolveTableSharding?.(table);

        if (info?.mode.kind === "global") {
            globalRows.push({ doc, table });
            globalLineMap.push(lineNumber);

            return;
        }

        // Shard-local routing: shardBy(field) picks the value of `doc[field]`;
        // root/undefined modes route to the default shard.
        let shardKey = defaultShard;

        if (info?.mode.kind === "shardBy" && typeof info.mode.field === "string") {
            const raw = doc[info.mode.field];

            if (raw === undefined || raw === null) {
                errors.push({
                    code: "BAD_ROW",
                    line: lineNumber,
                    message: `row missing shard field "${info.mode.field}" for table "${table}"`,
                    table,
                });

                return;
            }

            shardKey = String(raw);
        }

        const existing = perShard.get(shardKey);

        if (existing) {
            existing.rows.push({ doc, table });
        } else {
            perShard.set(shardKey, { rows: [{ doc, table }], shardKey, startLine: lineNumber });
        }
    };

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex);

            buffer = buffer.slice(newlineIndex + 1);
            handleLine(line);
            newlineIndex = buffer.indexOf("\n");
        }
    }

    if (buffer.length > 0) {
        handleLine(buffer);
    }

    const inserted: Record<string, number> = {};
    let conflicts = 0;

    // Fan shard-local batches out via the coordinator. The order of batches
    // is insertion order so error line numbers reflect the source NDJSON.
    if (perShard.size > 0) {
        const coordinator = options.queryCoordinator!;
        const result = await coordinator.orchestrateImport(options.shardDO, {
            batches: [...perShard.values()],
            headers: forwardedHeaders,
        });

        for (const [table, count] of Object.entries(result.inserted)) {
            inserted[table] = (inserted[table] ?? 0) + count;
        }

        for (const e of result.errors) {
            errors.push({ ...e });
        }

        conflicts += result.conflicts;
    }

    // Run global imports through the user-supplied helper.
    if (globalRows.length > 0) {
        if (options.importGlobals) {
            const startLine = globalLineMap[0] ?? 1;
            const result = await options.importGlobals({ rows: globalRows, startLine });

            for (const [table, count] of Object.entries(result.inserted)) {
                inserted[table] = (inserted[table] ?? 0) + count;
            }

            for (const e of result.errors) {
                errors.push({ ...e });
            }

            conflicts += result.conflicts;
        } else {
            for (const [index, globalRow] of globalRows.entries()) {
                errors.push({
                    code: "GLOBAL_NOT_CONFIGURED",
                    line: globalLineMap[index]!,
                    message: `row targets global table "${globalRow!.table}" but no \`importGlobals\` is configured`,
                    table: globalRow!.table,
                });
            }
        }
    }

    return { conflicts, errors, inserted };
};

/**
 * Constant-time-ish bearer check used by the admin endpoints. We accept the
 * token as a verbatim string match because the worker's existing
 * `Authorization` header handling is also plain — the per-shard gate is what
 * provides the constant-time check downstream.
 */
const checkAdminAuth = (request: Request, expected: string | undefined): boolean => {
    if (!expected || expected.length === 0) {
        return false;
    }

    const authorization = request.headers.get("authorization");

    if (!authorization) {
        return false;
    }

    const [scheme, ...rest] = authorization.split(" ");

    if (scheme?.toLowerCase() !== "bearer") {
        return false;
    }

    const supplied = rest.join(" ").trim();
    const max = Math.max(expected.length, supplied.length);
    let diff = expected.length ^ supplied.length;

    for (let index = 0; index < max; index += 1) {
        const ca = index < expected.length ? expected.charCodeAt(index) : 0;
        const cb = index < supplied.length ? supplied.charCodeAt(index) : 0;

        diff |= ca ^ cb;
    }

    return diff === 0;
};

/** Re-exported helper so callers can roundtrip envelopes in tests. */
export const defineRpcEnvelope = (envelope: RpcEnvelope): RpcEnvelope => envelope;
