import type { AuthAdmin, AuthIntrospector } from "./auth-admin-routes";
import { buildAuthAdminRoutes } from "./auth-admin-routes";
import { MAX_BODY_BYTES, readBodyBytesWithLimit, readBodyTextWithLimit, readJsonBodyWithLimit } from "./body-readers";
import { buildDataMovementAdminRoutes } from "./data-movement-admin-routes";
import type { FunctionArgumentDescriptor } from "./describe-args";
import { isStructuralConflictError, isStructuralLunoraError, LunoraError, toErrorResponse } from "./errors";
import type { ExportRow } from "./export-stream";
import { collectKnownTables, streamExportRows } from "./export-stream";
import { streamingImport } from "./import-stream";
import { buildIntrospectionAdminRoutes } from "./introspection-admin-routes";
import type { ObservabilityEvent, ObservabilitySink } from "./observability";
import { emitRpcEvent } from "./observability";
import { buildOrchestrationAdminRoutes } from "./orchestration-admin-routes";
import type { FanOutSpec, QueryCoordinator } from "./query-coordinator";
import type { ResolvedShard, ShardNamespaceLike } from "./resolve-shard";
import { resolveShard } from "./resolve-shard";
import { buildScheduledAdminRoutes } from "./scheduled-admin-routes";
import { buildStorageAdminRoutes } from "./storage-admin-routes";
import { buildVectorAdminRoutes } from "./vector-admin-routes";

/**
 * Wire-format RPC envelope. Posted to `POST /_lunora/rpc`.
 *
 * `functionPath` is the `&lt;file>:&lt;function>` identifier emitted by codegen,
 * e.g. `"messages:list"`. `shardKey` is optional — when omitted the runtime
 * routes to {@link WorkerOptions.defaultShardKey} (default `"__root__"`).
 *
 * `fanOut` opts the envelope into cross-shard routing via the
 * {@link WorkerOptions.queryCoordinator}; mutually exclusive with
 * `shardKey` (specifying both is a 400 — fan-out *is* the shard choice).
 */
interface RpcEnvelope {
    args?: Record<string, unknown>;
    fanOut?: FanOutSpec;
    functionPath: string;
    shardKey?: string;
}

interface ExecutionContextLike {
    passThroughOnException: () => void;
    waitUntil: (promise: Promise<unknown>) => void;
}

type Route = (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response> | Response;

/**
 * Context handed to HTTP-action handlers. Built per request by the worker; its
 * `run*` methods forward an RPC envelope to the shard, so handlers reach
 * queries/mutations/actions without a direct DB binding.
 *
 * `reference` is typed `unknown` so this structural contract stays free of a
 * `@lunora/server` dependency while remaining assignable from the fully-typed
 * `HttpActionCtx` on the server side (`{ __lunoraRef }` is read at runtime).
 */
interface HttpActionContext {
    auth: { getIdentity: () => Promise<Record<string, unknown> | null>; userId: null | string };
    fetch: typeof globalThis.fetch;
    runAction: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runMutation: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runQuery: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
}

interface HttpActionLike {
    handler: (context: HttpActionContext, request: Request) => Promise<Response> | Response;
}

/**
 * Structural view of `@lunora/server`'s `httpRouter()`. The worker dispatches by
 * calling `fetch` — the same shape as a hono app's `app.fetch` — so the runtime
 * stays free of a hard dependency on the server package (and on hono). The
 * per-request {@link HttpActionContext} is injected on the `__lunoraCtx` env
 * binding; the router lifts it into the handler's context.
 */
interface HttpRouterLike {
    // A method signature (not an arrow property) so parameters are compared
    // bivariantly — this lets a real hono app, whose `fetch` is typed against its
    // own `Bindings`/`ExecutionContext` (which carries a required `props`), assign
    // structurally here; an arrow property would reject it under strict variance.
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- bivariant params are load-bearing for hono compatibility
    fetch(request: Request, env?: unknown, context?: ExecutionContextLike): Promise<Response> | Response;
}

/**
 * Identity resolved from the inbound request by {@link WorkerOptions.resolveIdentity}.
 *
 * The `userId` field is special — it becomes `ctx.auth.userId` inside the
 * Durable Object. Any other keys (`email`, `name`, custom roles, etc.) are
 * forwarded verbatim as `ctx.auth.getIdentity()`'s return value.
 *
 * Return `null` to signal that the request is anonymous; the runtime will
 * skip both `x-lunora-userid` and `x-lunora-identity` headers, and
 * `ctx.auth.userId` will be `undefined` on the shard side.
 */
interface ResolvedIdentity {
    /** Arbitrary additional claims. Must be JSON-serialisable. */
    [key: string]: unknown;
    /** Stable user identifier (e.g. `"user_2k3..."` or `"u_42"`). */
    userId: string;
}

/**
 * Per-table sharding metadata the admin import endpoint needs to route rows.
 * Structural so this package stays free of `@lunora/server`. The codegen-
 * generated worker entry passes a thin projection of the user's schema.
 */
interface ShardingInfo {
    /** `global` when the table lives in D1; `shardBy` when keyed by a field; `root` (or absent) otherwise. */
    mode: { field?: string; kind: "global" | "root" | "shardBy" };
}

/**
 * Lookup the runtime uses to bucket an import row to its owning shard. Returns
 * `undefined` for unknown tables — the row is reported as a hard error.
 */
type AdminTableResolver = (table: string) => ShardingInfo | undefined;

/**
 * Streamed bulk export of `.global()` tables, materialised as an async iterable
 * of `{table, doc}` rows. The runtime concatenates this stream after the
 * shard-local stream so the receiver sees a single NDJSON body.
 */
type GlobalExportFunction = (request: { tables: ReadonlyArray<string> }) => AsyncIterable<{ doc: Record<string, unknown>; table: string }>;

/**
 * Read a page of the `.global()` (D1) change-data-capture log past `sinceSeq`
 * for the admin sync endpoint. Wire it to `@lunora/d1`'s `readD1CdcChanges`.
 * When omitted, the sync endpoint returns only shard-local changes.
 */
type GlobalCdcSyncFunction = (request: { limit?: number; sinceSeq: number }) => Promise<{ changes: ReadonlyArray<Record<string, unknown>>; cursor: number }>;

/**
 * Replay a batch of `.global()` (D1) CDC changes for the admin apply endpoint
 * (point-in-time recovery). Wire it to `applyCdcChanges` on a D1 writer;
 * returns the number applied. When omitted, the apply endpoint replays only
 * shard-local changes.
 */
type GlobalCdcApplyFunction = (request: { changes: ReadonlyArray<Record<string, unknown>> }) => Promise<number>;

/** Bulk import of `.global()` rows. Returns insert counts + errors merged across tables. */
type GlobalImportFunction = (request: { rows: ReadonlyArray<{ doc: Record<string, unknown>; table: string }>; startLine?: number }) => Promise<{
    conflicts: number;
    errors: ReadonlyArray<{ code: string; line: number; message: string; table: string }>;
    inserted: Record<string, number>;
}>;

/** One R2 object as the storage browser surfaces it. Mirrors `@lunora/storage`'s `R2ObjectLike`. */
interface StorageObject {
    customMetadata?: Record<string, string>;
    etag: string;
    httpMetadata?: { contentType?: string };
    key: string;
    size: number;
}

/**
 * One registered function, as the discovery endpoint surfaces it. Structurally
 * a subset of codegen's `RegisteredLunoraFunction` — only `kind` and
 * `visibility` matter here, so the generated `LUNORA_FUNCTIONS` map satisfies
 * the {@link FunctionRegistryLike} value shape.
 */
interface FunctionDescriptor {
    /** The function's declared argument schema, derived from its `v.*` validators. */
    args: FunctionArgumentDescriptor[];
    kind: "action" | "mutation" | "query";
    /** The `&lt;file>:&lt;function>` identifier, e.g. `messages:list`. */
    path: string;
    /** `"internal"` functions are never exposed by the discovery endpoint; absence === public. */
    visibility?: "internal" | "public";
}

/** One value in {@link FunctionRegistryLike} — the bits of a registered function the discovery endpoint reads. */
interface FunctionRegistryEntry {
    /** The function's `v.*` args validator map; read structurally for the signature view. */
    args?: unknown;

    /**
     * The generated registry carries `"stream"` alongside query/mutation/action;
     * the discovery endpoint surfaces the latter three only (a `stream` function
     * isn't runnable from the function runner), but accepting the kind here lets
     * callers pass the generated `LUNORA_FUNCTIONS` map without a cast.
     */
    kind: "action" | "mutation" | "query" | "stream";
    visibility?: "internal" | "public";
}

/**
 * The generated `LUNORA_FUNCTIONS` dispatch table, narrowed to what the
 * discovery endpoint reads. Pass the map straight from `_generated/functions.ts`.
 */
type FunctionRegistryLike = Record<string, FunctionRegistryEntry>;

/**
 * Lists objects in the storage bucket for the admin file browser. Structurally
 * compatible with `@lunora/storage`'s `Storage["list"]` — the runtime stays free
 * of a hard dependency on the storage package.
 */
type StorageListFunction = (
    prefix?: string,
    options?: { bucket?: string; cursor?: string; limit?: number },
) => Promise<{ cursor?: string; objects: StorageObject[] }>;

/**
 * Deletes one object from a storage bucket for the admin file browser.
 * Structurally compatible with `@lunora/storage`'s `Storage["delete"]`, so
 * passing `createStorage(...).delete` satisfies it. The optional `bucket` selects
 * a named bucket for a multi-bucket deployment (ignored by single-bucket hosts).
 */
type StorageDeleteFunction = (key: string, options?: { bucket?: string }) => Promise<void> | void;

/**
 * Uploads one object to a storage bucket for the admin file browser. Mirrors
 * `@lunora/storage`'s `Storage["upload"]` (only the bits the admin endpoint
 * needs): the key, the raw bytes, an optional content-type, and an optional
 * target `bucket` for multi-bucket deployments.
 */
type StorageUploadFunction = (
    key: string,
    body: ArrayBuffer,
    options?: { bucket?: string; contentType?: string },
) => Promise<{ etag?: string; key: string }> | { etag?: string; key: string };

/**
 * Mints a (signed or public) URL for one object so the admin file browser can
 * offer a "copy URL" action. The optional `expiresInSeconds` lets the caller pick
 * a share-link lifetime (the host clamps it); `bucket` selects a named bucket.
 * Structurally compatible with `@lunora/storage`'s `Storage["getSignedUrl"]`.
 */
type StorageSignedUrlFunction = (key: string, options?: { bucket?: string; expiresInSeconds?: number }) => Promise<string> | string;

/** One `.global()` table plus its row count. Mirrors `@lunora/d1`'s `GlobalTableInfo`. */
interface GlobalTableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one global table. Mirrors `@lunora/d1`'s `GlobalTablePage`. */
interface GlobalTablePage {
    columns: string[];
    /** FK columns (local column → referenced table) for external tables with real `REFERENCES` constraints. */
    refs?: Record<string, string>;
    rows: Record<string, unknown>[];
    total: number;
}

/** One eq constraint a facet-value click adds to the global browser's view. Mirrors `@lunora/d1`'s `GlobalFilterClause`. */
interface GlobalFilterClause {
    column: string;
    value: unknown;
}

/** Per-column distinct-value summary for the global browser. Mirrors `@lunora/d1`'s `GlobalFacetResult`. */
interface GlobalFacetResult {
    truncated: boolean;
    values: { count: number; value: unknown }[];
}

/**
 * Introspect `.global()` (D1-backed) tables for the data browser. Structurally
 * compatible with `@lunora/d1`'s `listGlobalTables` / `readGlobalTablePage` /
 * `facetGlobalColumn` (curried with the D1 exec + schema) — the runtime stays
 * free of a hard dependency on the D1 package.
 */
interface GlobalIntrospector {
    facetColumn: (options: { column: string; filters?: GlobalFilterClause[]; limit?: number; table: string }) => Promise<GlobalFacetResult>;
    listTables: () => Promise<GlobalTableInfo[]>;
    readTablePage: (options: { filters?: GlobalFilterClause[]; limit?: number; offset?: number; table: string }) => Promise<GlobalTablePage>;
}

/**
 * One vector index as the studio's vector browser lists it: the static schema
 * metadata (name/table/field/dimensions/metric/metadata) merged with the live
 * Vectorize `describe()` stats (`vectorsCount`, processing watermark) when the
 * binding is reachable. The live fields are optional so a never-bound index
 * still lists with its declared shape.
 */
interface VectorIndexSummary {
    dimensions?: number;
    field?: string;
    metadata?: ReadonlyArray<string>;
    metric?: "cosine" | "dot-product" | "euclidean";
    name: string;
    /** Most recent mutation Vectorize has finished indexing, from `describe()`. */
    processedUpToMutation?: string;
    table: string;
    /** Live vector count from `describe()`; absent when the binding is unreachable. */
    vectorsCount?: number;
}

/** One nearest-neighbour hit from a vector-index similarity query. */
interface VectorQueryMatch {
    id: string;
    metadata?: Record<string, unknown>;
    score: number;
}

/**
 * Introspect Vectorize indexes for the studio's vector browser. Built in the
 * worker entry from the generated `LUNORA_VECTOR_INDEXES` registry (Vectorize
 * cannot enumerate indexes at runtime) paired with the env bindings + the
 * schema's per-index embedders. `queryIndex` is optional: an index with no
 * embedder (a `select`-derived Shape B index, or a deployment that withholds the
 * embedder) lists but cannot be similarity-queried from the studio.
 */
interface VectorIntrospector {
    listIndexes: () => Promise<VectorIndexSummary[]>;
    queryIndex?: (options: { name: string; text: string; topK?: number }) => Promise<{ matches: VectorQueryMatch[] }>;
}

// The auth-admin contract (`AuthAdmin`, the wire-shape rows, capabilities) and
// its `/_lunora/admin/auth/*` routes live in `./auth-admin-routes`, keeping the
// whole user-management plane out of this file. Types are imported at the top
// and re-exported from the module's export block below.

/**
 * Cron controller handed to the worker's `scheduled()` entry by the Workers
 * runtime. `cron` is the exact trigger expression that fired (matched against
 * {@link WorkerOptions.crons} keys and {@link WorkerOptions.backupCron});
 * `scheduledTime` is the firing time in epoch-ms, used as the backup id so the
 * snapshot is named after the moment it represents rather than wall-clock skew.
 */
interface ScheduledControllerLike {
    cron: string;
    noRetry?: () => void;
    scheduledTime: number;
}

/**
 * A cron-trigger handler registered on {@link WorkerOptions.crons}. The worker's
 * `scheduled()` entry invokes the handler whose map key equals the firing
 * trigger's `cron` expression. Runs server-side with no end-user identity.
 */
type CronHandler = (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike) => Promise<void> | void;

/**
 * A single code-defined cron job, shaped like an entry of the generated
 * `LUNORA_CRONS` map. `functionPath` is the `"namespace:fn"` to run, `args` its
 * bound arguments, and `name` the human label from the `cronJobs()` builder.
 * Pass the whole `LUNORA_CRONS` map as {@link WorkerOptions.cronJobs}; the worker
 * dispatches each job on its firing trigger via the same authorized shard path
 * as the scheduler.
 */
interface CronJobDispatch {
    args?: Record<string, unknown>;
    functionPath: string;
    name: string;
    shardKey?: string;
}

/**
 * One scheduled cron invocation as the discovery endpoint surfaces it: a
 * {@link CronJobDispatch} flattened together with the `cron` expression that
 * fires it. Cloudflare exposes no runtime cron introspection, so the injected
 * `cronJobs` map is the only source of truth; the studio renders these read-only.
 */
interface CronJobInfo {
    args?: Record<string, unknown>;
    /** The compiled cron expression, e.g. `"0 9 * * *"`. */
    cron: string;
    functionPath: string;
    name: string;
    shardKey?: string;
}

/**
 * R2-like sink for scheduled backups. Structurally a subset of `@lunora/storage`'s
 * `R2BucketLike` (and of the raw R2 binding), so passing `env.BACKUPS` straight
 * through satisfies it. `put` writes the NDJSON snapshot and its manifest
 * sidecar; `list`/`delete` drive retention pruning when
 * {@link WorkerOptions.backupRetain} is set.
 */
interface BackupStore {
    delete: (key: string) => Promise<unknown>;
    list: (options?: { cursor?: string; limit?: number; prefix?: string }) => Promise<{
        cursor?: string;
        objects: ReadonlyArray<{ key: string }>;
        truncated?: boolean;
    }>;
    put: (
        key: string,
        body: ArrayBuffer | Blob | null | ReadableStream | string,
        options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
    ) => Promise<unknown>;
}

/**
 * Manifest sidecar written next to each scheduled backup's NDJSON object (at
 * `&lt;file>.manifest.json`). Mirrors the manifest entry the CLI records for local
 * backups so both backup planes describe a snapshot the same way;
 * `cron`/`scheduledTime` additionally record which trigger produced it.
 */
interface BackupManifest {
    bytes: number;
    createdAt: string;
    cron: string;
    file: string;
    id: string;
    rows: number;
    scheduledTime: number;
    tables?: string;
}

interface WorkerOptions {
    /**
     * Admin bearer token expected by the export/import endpoints. When unset,
     * the endpoints respond with `ADMIN_FORBIDDEN` — the same posture the
     * per-shard admin gate uses.
     */
    adminToken?: string;

    /**
     * Acknowledge — explicitly — that sharded and fan-out access may be
     * exercised by any caller (including unauthenticated ones) because no
     * authorization callback is configured. When neither {@link WorkerOptions.authorizeShard}
     * nor {@link WorkerOptions.authorizeFanOut} is set, naming a non-default shard or sending
     * a fan-out envelope is authorization-open: this is the historical posture,
     * preserved for backward compatibility. The runtime emits a single loud
     * `console.warn` the first time such a request is seen so the gap is
     * visible in logs. Set this to `true` to assert the posture is intentional
     * and silence that warning. It does NOT change behaviour — it is purely an
     * acknowledgement flag — and has no effect once an `authorize*` callback is
     * configured.
     */
    allowUnauthenticatedShardAccess?: boolean;

    /**
     * Replay `.global()` (D1) CDC changes for the admin apply endpoint
     * (point-in-time recovery). When omitted, apply covers only shard-local tables.
     */
    applyGlobals?: GlobalCdcApplyFunction;

    /**
     * The auth user-management plane backing the studio's users dashboard:
     * browse via `GET /_lunora/admin/auth/users` + `/sessions`, and (when the
     * implementation provides the optional mutations) create/ban/role/revoke/
     * delete/impersonate via the matching admin-gated `POST /_lunora/admin/auth/*`
     * routes. Wire it with `@lunora/auth`'s `createAuthAdmin(auth)`. Omit it and
     * every `/auth/*` endpoint responds `AUTH_NOT_CONFIGURED`.
     */
    authAdmin?: AuthAdmin;

    /**
     * Base path the auth routes are mounted under (default `/api/auth`). Used
     * to classify which inbound paths are auth ATTEMPTS for the app-level
     * auth-failure SLO signal (PLAN3 §2.3) — see {@link WorkerOptions.authHandler}.
     * Only meaningful alongside `authHandler`.
     */
    authBasePath?: string;

    /**
     * Optional prebound `@lunora/auth` handler (`handleAuthRequest(auth, …)`
     * with its `auth` argument already bound) the worker dispatches BEFORE its
     * own routing — auth runs as a top-level `/api/auth/*` route, not through
     * lunora functions. It returns a `Response` for an auth route and
     * `undefined` to let the request fall through to the worker.
     *
     * Wiring it here (rather than in the host entry) lets the runtime instrument
     * it for the app-level auth-failure SLO (PLAN3 §2.3): after the handler
     * answers a genuine auth ATTEMPT route (sign-in / sign-up / callback under
     * {@link WorkerOptions.authBasePath}), the worker fires a fire-and-forget
     * `recordAuthEvent` against the root shard via `ctx.waitUntil` — classifying
     * the outcome by status (`≥ 400` ⇒ `fail`). The recording never blocks or
     * fails the auth response, and is skipped silently when no admin token or
     * shard namespace is configured (the SLO signal is simply absent).
     *
     * Omit it and the host keeps calling `handleAuthRequest` itself; the SLO
     * signal is then absent but auth behaves identically.
     */
    authHandler?: (request: Request) => Promise<Response | undefined>;

    /**
     * @deprecated Use {@link WorkerOptions.authAdmin} (an {@link AuthAdmin}),
     * which also lights up the user-management mutation endpoints. Still honored
     * as a read-only fallback for the browse endpoints.
     */

    authIntrospector?: AuthIntrospector;

    /**
     * Optional table-level authorization callback for fan-out RPC envelopes.
     * Called after `resolveIdentity` and before `coordinator.fanOut` walks
     * the registry. Returning `false` rejects the request with 403
     * `FORBIDDEN_FANOUT`. When unset, fan-out is denied by default
     * whenever {@link WorkerOptions.authorizeShard} is configured — fan-out is a
     * privileged operation (it dispatches the caller's function across
     * every live shard for the table) and a per-shard gate is not
     * sufficient to authorize it. Apps that need client-driven fan-out
     * must opt in explicitly via this callback.
     */
    authorizeFanOut?: (identity: ResolvedIdentity | null, table: string, functionPath: string) => boolean | Promise<boolean>;

    /**
     * Optional per-shard authorization callback. Called from both the RPC
     * dispatch path and the WebSocket upgrade path after `resolveIdentity`
     * has produced an identity but before the request is forwarded to the
     * named shard. Returning `false` (or a promise resolving to `false`)
     * causes the runtime to reject the request with a 403
     * `FORBIDDEN_SHARD` error. When unset, the runtime allows the
     * request — preserving the historical "any client may name any
     * shard" posture.
     *
     * Note: this callback does NOT gate fan-out envelopes — fan-out
     * targets every live shard for a table and must be authorized at the
     * table level via {@link WorkerOptions.authorizeFanOut}. Configuring this callback
     * without `authorizeFanOut` causes fan-out envelopes to be denied by
     * default.
     */
    authorizeShard?: (identity: ResolvedIdentity | null, shardKey: string) => boolean | Promise<boolean>;

    /**
     * Cron expression that triggers the built-in backup. When set alongside
     * {@link WorkerOptions.backupStore} and {@link WorkerOptions.adminToken}, the
     * worker's `scheduled()` entry runs a full export and writes an NDJSON
     * snapshot + manifest sidecar to the backup store whenever a cron trigger
     * with this exact expression fires. Must match an entry in the worker's
     * wrangler `triggers.crons` (and the string is compared verbatim). Omit it
     * and no automatic backup runs.
     */
    backupCron?: string;

    /**
     * Key prefix the scheduled backup writes under (default `"backups/"`). The
     * NDJSON object lands at `&lt;prefix>lunora-backup-&lt;id>.ndjson` and its manifest
     * at the same key plus `.manifest.json`.
     */
    backupPrefix?: string;

    /**
     * Retention bound for scheduled backups: keep only the newest N snapshots
     * under {@link WorkerOptions.backupPrefix}, pruning older NDJSON objects and
     * their manifests after each run. Omit (or `0`) to keep every backup.
     */
    backupRetain?: number;

    /**
     * R2-like store the scheduled backup writes snapshots to. Pass the bound R2
     * bucket (`env.BACKUPS`) directly — its shape satisfies {@link BackupStore}.
     * Without it (or without {@link WorkerOptions.backupCron}) no automatic
     * backup runs.
     */
    backupStore?: BackupStore;

    /**
     * Table allowlist for the scheduled backup. Omit to back up every table
     * (shard-local + `.global()`). Mirrors the export endpoint's `tables`.
     */
    backupTables?: ReadonlyArray<string>;

    /**
     * Code-defined cron jobs keyed by cron expression — pass the generated
     * `LUNORA_CRONS` map directly. On a firing trigger the worker runs every job
     * listed under the matching expression by dispatching its `functionPath`/`args`
     * to the shard, server-side, through the same authorization as the scheduler.
     * Runs alongside any {@link WorkerOptions.crons} handler and the backup.
     */
    cronJobs?: Record<string, ReadonlyArray<CronJobDispatch>>;

    /**
     * Cron-trigger handlers keyed by their exact cron expression. The worker's
     * `scheduled()` entry dispatches the handler whose key equals the firing
     * trigger's `cron`. Independent of the built-in backup — a handler keyed on
     * the same expression as {@link WorkerOptions.backupCron} runs alongside it.
     */
    crons?: Record<string, CronHandler>;

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
    exportGlobals?: GlobalExportFunction;

    /**
     * The generated `LUNORA_FUNCTIONS` map (from `_generated/functions.ts`). When
     * set, the worker exposes the admin-gated `GET /_lunora/admin/functions`
     * endpoint the studio uses to auto-discover queries/mutations/actions
     * (internal functions are filtered out). Omit it and the endpoint responds
     * `FUNCTIONS_NOT_CONFIGURED`.
     */
    functions?: FunctionRegistryLike;

    /**
     * Read-only introspector for `.global()` (D1) tables, backing the data
     * browser's global mode via `GET /_lunora/admin/global/tables` and
     * `/_lunora/admin/global/table`. Build it from `@lunora/d1`'s
     * `listGlobalTables` / `readGlobalTablePage`. Omit it and those endpoints
     * respond `GLOBALS_NOT_CONFIGURED`.
     */
    globalIntrospector?: GlobalIntrospector;

    /**
     * Router for HTTP actions (`httpRouter()` from `@lunora/server`, a hono app).
     * Consulted for requests that miss the explicit {@link WorkerOptions.routes}
     * map and the internal `/_lunora/*` endpoints. The runtime builds the action
     * context, injects it on the `__lunoraCtx` env binding, and dispatches via
     * `httpRouter.fetch`; matched handlers reach the data layer through
     * `ctx.run*`, which forward to the shard. An unmatched request returns hono's
     * own 404 (a path-match with the wrong verb is a 404, not a 405).
     */
    httpRouter?: HttpRouterLike;

    /**
     * Insert `.global()` rows for the admin import endpoint. When omitted,
     * rows targeting global tables are reported as hard errors.
     */
    importGlobals?: GlobalImportFunction;

    /**
     * Optional telemetry sink. When supplied, the worker emits one
     * `onRpc` event per dispatched RPC (single-shard forward or fan-out)
     * with duration / ok / error / shardKey or fanOut metadata. Sink
     * throws are swallowed so a faulty adapter cannot break user-facing
     * dispatch. See {@link ObservabilitySink}.
     */
    observability?: ObservabilitySink;

    /**
     * The generated OpenAPI 3.1 document. Import it from the codegen-emitted
     * module and pass it through:
     * `import { openApiSpec } from "./lunora/_generated/openapi"`. A Worker can't
     * read the `_generated/openapi.json` file at runtime, so codegen also emits
     * `openapi.ts` (the same document inlined as `export const openApiSpec`) for
     * exactly this wiring — it regenerates on every `lunora/` change so the spec
     * stays live.
     *
     * When set, the worker exposes the admin-gated `GET /_lunora/admin/openapi`
     * endpoint the studio's API-reference view renders. The runtime does
     * NOT assemble or validate the spec — it serves what the host injects verbatim.
     * Omit it and the endpoint returns an empty-but-valid OpenAPI 3.1 document
     * (no paths), so the studio shows a "not configured" state rather than erroring.
     */
    openApiSpec?: unknown;

    /**
     * The generated OpenRPC 1.x document. Import it from the codegen-emitted
     * module and pass it through:
     * `import { openRpcSpec } from "./lunora/_generated/openrpc"` (only emitted
     * when the project opts into `apiSpec: "openrpc"` or `"both"`). Like
     * `openApiSpec`, codegen inlines the document into `openrpc.ts` because a
     * Worker can't read the `.json` at runtime; both regenerate together.
     *
     * When set, the worker exposes the admin-gated `GET /_lunora/admin/openrpc`
     * endpoint the studio's API-reference view can render. OpenRPC is the
     * RPC-native spec (a `methods` array over the JSON-RPC-shaped
     * `POST /_lunora/rpc` transport); it covers only the RPC functions, not
     * `httpRouter()` REST routes. The runtime does NOT assemble or validate the
     * spec — it serves what the host injects verbatim. Omit it and the endpoint
     * returns an empty-but-valid OpenRPC 1.x document (no methods), so the studio
     * shows a "not configured" state rather than erroring.
     */
    openRpcSpec?: unknown;

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
     * forwarded as `x-lunora-identity` so `ctx.auth.getIdentity()` can
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
     * set, the worker exposes the admin-gated `/_lunora/admin/scheduled`
     * endpoints used by the studio to list and cancel `runAfter` / `runAt`
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
     * Names of the storage buckets the studio's file browser offers in its bucket
     * picker, backing `GET /_lunora/admin/storage/buckets`. Supply the keys of a
     * multi-bucket `createBucketStorage({...})` so the operator can switch buckets;
     * the selected name is forwarded to the storage ops as `options.bucket`. Omit
     * it (single-bucket deployments) and the picker is hidden — the ops target the
     * default bucket.
     */
    storageBuckets?: string[];

    /**
     * Deletes one object, backing the admin-gated `DELETE /_lunora/admin/storage`
     * endpoint the studio's file browser calls. Passing
     * `createStorage(...).delete` satisfies it. Omit it and the endpoint responds
     * `STORAGE_DELETE_NOT_CONFIGURED` — the studio surfaces a clear inline error.
     */
    storageDelete?: StorageDeleteFunction;

    /**
     * Storage lister backing the admin-gated `GET /_lunora/admin/storage`
     * endpoint the studio's file browser calls. The structural shape matches
     * `@lunora/storage`'s `Storage["list"]`, so passing `createStorage(...).list`
     * (or the raw R2 bucket's `list`) satisfies it. Omit it and the endpoint
     * responds `STORAGE_NOT_CONFIGURED`.
     */
    storageList?: StorageListFunction;

    /**
     * Mints a (signed or public) URL for one object, backing the admin-gated
     * `GET /_lunora/admin/storage/url` endpoint the studio's "copy URL" action
     * calls. Passing `createStorage(...).getSignedUrl` (or `.getUrl`) satisfies
     * it. Omit it and the endpoint responds `STORAGE_URL_NOT_CONFIGURED` — the
     * studio surfaces a clear inline error.
     */
    storageSignedUrl?: StorageSignedUrlFunction;

    /**
     * Uploads one object, backing the admin-gated `PUT /_lunora/admin/storage`
     * endpoint the studio's file browser calls. Passing `createStorage(...).upload`
     * satisfies it. Omit it and the endpoint responds
     * `STORAGE_UPLOAD_NOT_CONFIGURED` — the studio surfaces a clear inline error.
     */
    storageUpload?: StorageUploadFunction;

    /**
     * Page the `.global()` (D1) change-data-capture log for the admin sync
     * endpoint. When omitted, the sync feed covers only shard-local tables.
     */
    syncGlobals?: GlobalCdcSyncFunction;

    /**
     * Read-only introspector for Vectorize indexes, backing the studio's vector
     * browser via `GET /_lunora/admin/vector/indexes` and
     * `POST /_lunora/admin/vector/query`. Build it from the generated
     * `LUNORA_VECTOR_INDEXES` registry plus the env Vectorize bindings (and the
     * schema's embedders, to enable similarity queries). Omit it and those
     * endpoints respond `VECTORS_NOT_CONFIGURED`.
     */
    vectorIntrospector?: VectorIntrospector;
}

interface RpcContext {
    ctx: ExecutionContextLike;
    env: unknown;
    request: Request;
    shardKey: string;
}

/**
 * Shared, stateless `TextEncoder` for NDJSON export/backup streaming. `encode()`
 * is reusable across calls, so a single module-scope instance avoids allocating
 * a fresh encoder per export/backup stream.
 */
const NDJSON_ENCODER = new TextEncoder();

const RPC_PATH = "/_lunora/rpc";
const WS_PATH = "/_lunora/ws";
const SCHEDULER_DISPATCH_PATH = "/_lunora/scheduler/dispatch";
// The cross-shard orchestration (`migrate` / `rank` / `rankpage` / `shard-traffic`)
// + `pitr`, data-movement (`export` / `import` / `sync` / `connector/sync` /
// `apply`), static-introspection (`functions` / `cron-jobs` / `openapi` /
// `openrpc` / `global/*`), `/_lunora/admin/storage/*`, `/_lunora/admin/vector/*`,
// `/_lunora/admin/scheduled*`, and `/_lunora/admin/auth/*` paths + handlers live
// in their sibling route modules.

/**
 * Default base path the `@lunora/auth` handler mounts under, mirroring
 * `@lunora/auth`'s `DEFAULT_AUTH_BASE_PATH`. Inlined (not imported) so the
 * runtime stays free of a hard dependency on `@lunora/auth`.
 */
const DEFAULT_AUTH_BASE_PATH = "/api/auth";

/**
 * Reserved admin RPC the worker fires (fire-and-forget) to record one auth
 * attempt for the app-level auth-failure SLO (PLAN3 §2.3). Spelled out inline,
 * like the other admin-op sets, to avoid importing `@lunora/do`.
 */
const RECORD_AUTH_EVENT_OP = "__lunora_admin__:recordAuthEvent";

/**
 * Sub-paths under the auth basePath that represent a genuine auth ATTEMPT — a
 * sign-in / sign-up / OAuth-callback exchange whose success or failure is the
 * SLO signal. Reads (`get-session`, `list-sessions`), sign-out, and other
 * better-auth endpoints are deliberately excluded: they aren't attempts, so
 * counting them would skew the failure rate. Matched as a substring of the
 * pathname suffix after the basePath (better-auth nests, e.g.
 * `/api/auth/sign-in/email`, `/api/auth/callback/github`).
 */
const AUTH_ATTEMPT_SEGMENTS = ["/sign-in", "/sign-up", "/callback"] as const;

/**
 * Classify whether `pathname` (under `basePath`) is an auth ATTEMPT route worth
 * recording for the SLO. Returns `false` for the basePath root and any non-
 * attempt endpoint. The match is on the leading segment after the basePath so a
 * nested route like `/api/auth/sign-in/email` counts while `/api/auth/get-session`
 * does not.
 */
const isAuthAttemptPath = (pathname: string, basePath: string): boolean => {
    const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;

    if (!pathname.startsWith(`${base}/`)) {
        return false;
    }

    const suffix = pathname.slice(base.length);

    return AUTH_ATTEMPT_SEGMENTS.some((segment) => suffix === segment || suffix.startsWith(`${segment}/`));
};

interface ForwardContext {
    /** Identity claims minus `userId`, or `null` when anonymous / no extra claims. */
    claims: Record<string, unknown> | null;
    /** Headers to forward to the shard (`content-type` + auth/cookie/bookmark/identity). */
    headers: Record<string, string>;
    /** Full identity object returned by `resolveIdentity`, or `null` when anonymous. */
    identity: ResolvedIdentity | null;
    /** Resolved stable user id, or `null` when anonymous. */
    userId: null | string;
}

/**
 * Build an `ObservabilityEvent` for a failed RPC dispatch. Extracts code /
 * status / message from any transport-mappable error (a {@link LunoraError} or
 * a structural `LunoraError`/`ConflictError` from a downstream package, the
 * same set `toErrorResponse` maps); otherwise reports `INTERNAL_SERVER_ERROR` /
 * 500 with the thrown value's message. Used by both the single-shard and
 * fan-out error branches so they emit a uniform shape — and so a `ConflictError`
 * is reported with its real code/status instead of a generic 500.
 */
const buildErrorEvent = (
    functionPath: string,
    durationMs: number,
    error: unknown,
    extra: { fanOut?: { table: string }; shardKey?: string },
): ObservabilityEvent => {
    const mappable = error instanceof LunoraError || isStructuralLunoraError(error) || isStructuralConflictError(error);
    const code = mappable ? (error as { code: string }).code : "INTERNAL_SERVER_ERROR";
    const status = mappable ? (error as { status: number }).status : 500;
    const message = error instanceof Error ? error.message : String(error);

    return {
        durationMs,
        error: { code, message, status },
        functionPath,
        ok: false,
        ...(extra.fanOut ? { fanOut: { failed: 0, shards: 0, table: extra.fanOut.table } } : {}),
        ...(extra.shardKey ? { shardKey: extra.shardKey } : {}),
    };
};

/**
 * Build the headers forwarded to the shard and the resolved identity, shared by
 * the RPC path and HTTP-action context. `userId` and `claims` mirror what the
 * DO reconstructs from the `x-lunora-userid` / `x-lunora-identity` headers.
 */
const resolveForwardContext = async (request: Request, env: unknown, resolveIdentity: WorkerOptions["resolveIdentity"]): Promise<ForwardContext> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const authorization = request.headers.get("authorization");
    const cookie = request.headers.get("cookie");
    const bookmark = request.headers.get("x-d1-bookmark");
    // Client-supplied mutation-replay idempotency key. Safe to forward verbatim:
    // the DO namespaces the dedup record by the server-minted identity, so a
    // forged id can only ever collide with the same caller's own mutations.
    const mutationId = request.headers.get("x-lunora-mutation-id");

    if (authorization) {
        headers["authorization"] = authorization;
    }

    if (cookie) {
        headers["cookie"] = cookie;
    }

    if (bookmark) {
        headers["x-d1-bookmark"] = bookmark;
    }

    if (mutationId) {
        headers["x-lunora-mutation-id"] = mutationId;
    }

    if (!resolveIdentity) {
        // eslint-disable-next-line unicorn/no-null -- `claims`/`identity`/`userId` feed the public HttpActionContext + authorize* callback contracts, whose anonymous sentinel is `null`
        return { claims: null, headers, identity: null, userId: null };
    }

    const identity = await resolveIdentity(request, env);

    if (!identity || typeof identity.userId !== "string" || identity.userId.length === 0) {
        // eslint-disable-next-line unicorn/no-null -- `claims`/`identity`/`userId` feed the public HttpActionContext + authorize* callback contracts, whose anonymous sentinel is `null`
        return { claims: null, headers, identity: null, userId: null };
    }

    headers["x-lunora-userid"] = identity.userId;

    // Strip `userId` so the DO doesn't see it twice. The rest of the identity
    // (claims like email/name/roles) is JSON-encoded so handlers can read it
    // via `ctx.auth.getIdentity()`.
    const { userId, ...extra } = identity;
    // eslint-disable-next-line unicorn/no-null -- `claims` is surfaced via the public HttpActionContext `getIdentity()` whose empty sentinel is `null`
    const claims = Object.keys(extra).length > 0 ? extra : null;

    if (claims) {
        headers["x-lunora-identity"] = JSON.stringify(claims);
    }

    return { claims, headers, identity, userId };
};

/** Merge `kind`s the coordinator understands; anything else is rejected at the edge. */
const KNOWN_MERGE_KINDS = new Set(["concat", "first", "groupBy", "max", "min", "rank", "sum", "topK"]);

/**
 * Validate the client-supplied fan-out spec on the public RPC path. `fanOut`
 * arrives fully untrusted and flows to `coordinator.fanOut`; `authorizeFanOut`
 * only gates `table` + `functionPath`, not the merge shape. Unvalidated, a
 * missing/negative `topK.k` reaches `collected.slice(0, k)` (returning every
 * row across all shards, or dropping the tail) and an unknown `kind` falls
 * through to the raw per-shard values — both untrusted-input footguns.
 */
const validateFanOut = (fanOut: unknown): FanOutSpec | undefined => {
    if (fanOut === undefined) {
        return undefined;
    }

    if (!fanOut || typeof fanOut !== "object") {
        throw new LunoraError("RPC `fanOut` must be an object", { code: "BAD_REQUEST", status: 400 });
    }

    const spec = fanOut as { merge?: unknown; table?: unknown };

    if (typeof spec.table !== "string" || spec.table.length === 0) {
        throw new LunoraError("RPC `fanOut.table` must be a non-empty string", { code: "BAD_REQUEST", status: 400 });
    }

    if (!spec.merge || typeof spec.merge !== "object") {
        throw new LunoraError("RPC `fanOut.merge` must be an object", { code: "BAD_REQUEST", status: 400 });
    }

    const merge = spec.merge as { by?: unknown; k?: unknown; kind?: unknown };

    if (typeof merge.kind !== "string" || !KNOWN_MERGE_KINDS.has(merge.kind)) {
        throw new LunoraError("RPC `fanOut.merge.kind` is not a recognized merge strategy", { code: "BAD_REQUEST", status: 400 });
    }

    if (merge.kind === "topK") {
        if (typeof merge.k !== "number" || !Number.isInteger(merge.k) || merge.k < 0) {
            throw new LunoraError("RPC `fanOut.merge.k` must be a non-negative integer", { code: "BAD_REQUEST", status: 400 });
        }

        if (typeof merge.by !== "string" || merge.by.length === 0) {
            throw new LunoraError("RPC `fanOut.merge.by` must be a non-empty string", { code: "BAD_REQUEST", status: 400 });
        }
    }

    return spec as FanOutSpec;
};

const parseEnvelope = async (request: Request): Promise<RpcEnvelope> => {
    // Read with a byte budget so a chunked / Content-Length-stripped body can't
    // bypass the size cap the header fast-path only loosely enforces.
    const text = await readBodyTextWithLimit(request);

    let body: unknown;

    try {
        body = JSON.parse(text);
    } catch {
        throw new LunoraError("RPC body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
    }

    if (!body || typeof body !== "object" || typeof (body as { functionPath?: unknown }).functionPath !== "string") {
        throw new LunoraError("RPC envelope is missing `functionPath`", { code: "BAD_REQUEST", status: 400 });
    }

    const envelope = body as RpcEnvelope;

    return {
        args: envelope.args ?? {},
        fanOut: validateFanOut(envelope.fanOut),
        functionPath: envelope.functionPath,
        shardKey: envelope.shardKey,
    };
};

const forwardToShard = async (namespace: ShardNamespaceLike, shardKey: string, request: Request): Promise<Response> => {
    const stub = resolveShard(namespace, shardKey);

    return stub.fetch(request);
};

/**
 * Constant-time-ish bearer check used by the admin endpoints. We accept the
 * token as a verbatim string match because the worker's existing
 * `Authorization` header handling is also plain — the per-shard gate is what
 * provides the constant-time check downstream.
 */

/**
 * Length-independent constant-time string compare for token checks.
 *
 * Keep in sync with `packages/do/src/shard-do.ts` constantTimeEqual — the
 * two packages don't import from each other to avoid a circular dep.
 */
const constantTimeEqual = (expected: string, supplied: string): boolean => {
    const max = Math.max(expected.length, supplied.length);
    // Bitwise XOR/OR are load-bearing for the branch-free constant-time
    // comparison that protects token/HMAC checks from timing side channels.
    // eslint-disable-next-line no-bitwise
    let diff = expected.length ^ supplied.length;

    for (let index = 0; index < max; index += 1) {
        const expectedCode = index < expected.length ? (expected.codePointAt(index) ?? 0) : 0;
        const suppliedCode = index < supplied.length ? (supplied.codePointAt(index) ?? 0) : 0;

        // eslint-disable-next-line no-bitwise
        diff |= expectedCode ^ suppliedCode;
    }

    return diff === 0;
};

/**
 * Verify an HMAC-SHA-256 (base64url, unpadded) signature over `body` against
 * `secret`. Mirrors `@lunora/scheduler`'s `signDispatch` and `@lunora/storage`'s
 * signed-URL HMAC pattern (WebCrypto `crypto.subtle`). We re-derive the expected
 * signature and constant-time compare the encoded strings so a forged or absent
 * signature can never authenticate a dispatch.
 */
const verifyHmacSignature = async (secret: string, body: string, suppliedSignature: string): Promise<boolean> => {
    if (secret.length === 0 || suppliedSignature.length === 0) {
        return false;
    }

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const bytes = new Uint8Array(signature);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    const expected = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

    return constantTimeEqual(expected, suppliedSignature);
};

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

    return constantTimeEqual(expected, rest.join(" ").trim());
};

/**
 * Admin check for a browser WebSocket upgrade, which can't set an
 * `Authorization` header — so the token rides in the `?token=` query parameter
 * instead (the studio sends it there as the client's `wsToken`). It ends up
 * in server logs, so a short-lived rotating token is preferable in production.
 */
const checkAdminWsToken = (request: Request, expected: string | undefined): boolean => {
    if (!expected || expected.length === 0) {
        return false;
    }

    const supplied = new URL(request.url).searchParams.get("token");

    return supplied !== null && constantTimeEqual(expected, supplied);
};

/**
 * The composed Lunora worker. `fetch` / `scheduled` are the standard Cloudflare
 * module-worker entrypoints (so the object can be re-exported directly as
 * `export default createWorker(...)`). `serverQuery` is the in-process fast-path
 * (PLAN4 §2.2) an SSR loader running inside the same worker calls to reach a
 * Lunora query without a self-`fetch` to `/_lunora/rpc`, with identity / RLS /
 * auth semantics identical to the HTTP path.
 */
interface LunoraWorker {
    fetch: (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response>;
    scheduled: (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike) => Promise<void>;

    /**
     * In-process query/mutation dispatch for SSR loaders co-located in this
     * worker. Resolves identity off `request` (cookies / bearer / bookmark) and
     * runs the per-shard authorization gate exactly like `POST /_lunora/rpc`,
     * then dispatches to the owning shard — no network self-fetch. Returns the
     * raw shard {@link Response}, byte-identical to the HTTP path's, so callers
     * can `.json()` it (`{ result }` / `{ error }`) or forward it verbatim. Like
     * the worker's `fetch`, it never throws on a request fault: a denied auth
     * gate, a bad reference, or a downstream error comes back as the SAME JSON
     * error `Response` (`toErrorResponse`) the HTTP path returns.
     * @param request The inbound SSR request — its `cookie` / `authorization`
     * / `x-d1-bookmark` headers drive identity, exactly as the
     * HTTP RPC path reads them.
     * @param env The worker `env`, forwarded to `resolveIdentity`.
     * @param reference A generated function reference (`api.foo.bar`); its
     * `__lunoraRef` is the `"namespace:fn"` dispatched.
     * @param args The function arguments.
     * @param options Call options mirroring the RPC envelope.
     * @param options.shardKey Routes to a specific shard (omitted → the worker's
     * `defaultShardKey`).
     */
    serverQuery: (request: Request, env: unknown, reference: unknown, args?: Record<string, unknown>, options?: { shardKey?: string }) => Promise<Response>;
}

/**
 * Build a Cloudflare Worker entry. Returns an object with `fetch` so it can
 * be re-exported directly as `export default createWorker(...)`.
 */
const createWorker = (options: WorkerOptions): LunoraWorker => {
    const defaultShard = options.defaultShardKey ?? "__root__";

    // Fan-out and non-default shard routing are authorization-open when neither
    // `authorizeShard` nor `authorizeFanOut` is configured — any caller can name
    // any shard or fan a function across every shard for a table. That's the
    // historical posture, kept for backward compatibility, but it's a footgun in
    // production. Warn loudly exactly once (per worker instance) when such a
    // request is actually seen, unless the operator has acknowledged the posture
    // via `allowUnauthenticatedShardAccess`.
    const hasAnyShardAuth = Boolean(options.authorizeShard) || Boolean(options.authorizeFanOut);
    let warnedUnauthenticatedShardAccess = false;

    const warnUnauthenticatedShardAccessOnce = (kind: "fan-out" | "shard"): void => {
        if (hasAnyShardAuth || options.allowUnauthenticatedShardAccess || warnedUnauthenticatedShardAccess) {
            return;
        }

        warnedUnauthenticatedShardAccess = true;

        // eslint-disable-next-line no-console -- surface the open authorization posture in logs
        console.warn(
            [
                `[lunora] SECURITY: received ${kind} access but neither \`authorizeShard\` nor \`authorizeFanOut\` is configured — `,
                `any caller (including unauthenticated ones) can target any shard / fan out across the table. `,
                `Configure \`authorizeShard\`/\`authorizeFanOut\`, or set \`allowUnauthenticatedShardAccess: true\` to acknowledge this posture and silence this warning.`,
            ].join(""),
        );
    };

    // The cross-shard orchestration (`migrate` / `rank` / `rankpage` /
    // `shard-traffic`) + single-shard `pitr` handlers live in a sibling module;
    // they reach the admin gate, coordinator, shard namespace, and forward
    // helpers through injected deps (mirroring the other extracted clusters).
    const orchestrationAdminRoutes = buildOrchestrationAdminRoutes({
        defaultShard,
        forwardToShard,
        isAdmin: (request) => checkAdminAuth(request, options.adminToken),
        queryCoordinator: options.queryCoordinator,
        resolveForwardContext: (request, env) => resolveForwardContext(request, env, options.resolveIdentity),
        shardDO: options.shardDO,
    });

    /**
     * Forward a server-initiated function call (a scheduler dispatch or a firing
     * cron job) to its shard. Re-applies per-shard authorization with a `null`
     * (system) identity so a server job can't reach a shard a same-shard end-user
     * RPC would be denied, then POSTs `{ functionPath, args }` to the shard's RPC.
     */
    const dispatchToShard = async (functionPath: string, args: Record<string, unknown>, shardKey: string): Promise<Response> => {
        if (options.authorizeShard) {
            // eslint-disable-next-line unicorn/no-null -- the public authorizeShard callback's anonymous-identity sentinel is `null`; system dispatch has no end-user identity
            const allowed = await options.authorizeShard(null, shardKey);

            if (!allowed) {
                throw new LunoraError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
            }
        }

        const forwarded = new Request("https://shard.internal/rpc", {
            // `x-lunora-system` marks this as a trusted server-initiated dispatch
            // so the shard may run `internal` functions (scheduled/cron jobs are
            // typically internal). Authorization was already enforced above; this
            // header is set only here, never on the client RPC path.
            body: JSON.stringify({ args, functionPath }),
            headers: { "content-type": "application/json", "x-lunora-system": "1" },
            method: "POST",
        });

        return forwardToShard(options.shardDO, shardKey, forwarded);
    };

    /**
     * Dispatch every code-defined cron job declared under the firing expression,
     * collecting per-job failures into `errors` so one failing job neither aborts
     * the others nor is swallowed. A non-2xx shard response is itself a failure.
     */
    const runCronJobs = async (cron: string, errors: Error[], toError: (error: unknown) => Error): Promise<void> => {
        const cronJobs = options.cronJobs?.[cron];

        if (!cronJobs) {
            return;
        }

        for (const job of cronJobs) {
            try {
                // eslint-disable-next-line no-await-in-loop -- intentional: jobs on one expression dispatch sequentially for deterministic order and to avoid a concurrent-RPC herd against a single shard
                const response = await dispatchToShard(job.functionPath, job.args ?? {}, job.shardKey ?? defaultShard);

                if (!response.ok) {
                    // A failed background job is operationally a 500-class "didn't
                    // run", not a client error — keep the shard's transport status
                    // in the message rather than overloading the error `status`.
                    throw new LunoraError(`cron job "${job.name}" (${job.functionPath}) failed with shard status ${String(response.status)}`, {
                        code: "CRON_JOB_FAILED",
                        status: 500,
                    });
                }
            } catch (error: unknown) {
                errors.push(toError(error));
            }
        }
    };

    /**
     * Release a workpool job's concurrency slot after its action settles, by
     * calling the SAME SchedulerDO instance's `/complete` (routed via the echoed
     * `instanceName`). No-op for non-pooled jobs. Best-effort: a failure must not
     * fail the dispatch the scheduler awaits — the pool's next drain reconciles.
     */
    const releasePoolSlot = async (candidate: { id?: unknown; instanceName?: unknown; pool?: unknown }): Promise<void> => {
        const pool = typeof candidate.pool === "string" && candidate.pool.length > 0 ? candidate.pool : undefined;

        if (!pool || !options.schedulerDO || typeof candidate.id !== "string") {
            return;
        }

        const instanceName = typeof candidate.instanceName === "string" && candidate.instanceName.length > 0 ? candidate.instanceName : "default";

        try {
            await options.schedulerDO.get(options.schedulerDO.idFromName(instanceName)).fetch(
                new Request("https://scheduler.internal/complete", {
                    body: JSON.stringify({ id: candidate.id, pool }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );
        } catch {
            // best-effort — reconciled by the pool's next drain pass
        }
    };

    /**
     * Receiver for the `SchedulerDO`'s scheduled-job dispatch. The scheduler DO
     * POSTs `{ functionPath, args, shardKey, scheduledFor, id }` as raw JSON,
     * authenticated by an HMAC-SHA-256 (base64url) signature over the exact body
     * in the `x-lunora-scheduler-signature` header (secret in
     * `env.LUNORA_SCHEDULER_SECRET`), or — when no HMAC secret is configured on
     * the scheduler — an `authorization: Bearer &lt;admin token>` fallback. An
     * unsigned/forged request is rejected with 403; we never run a job we can't
     * authenticate.
     *
     * On success the job is dispatched through the SAME shard-forward path as
     * `/_lunora/rpc` (re-applying `authorizeShard` for the named shard so the
     * scheduler cannot bypass per-shard auth), and the shard's response is
     * propagated.
     */
    const handleSchedulerDispatch = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new LunoraError("Scheduler dispatch endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        // Read the raw body verbatim (byte-budgeted) — the HMAC is computed over
        // these exact bytes, so we must verify before re-encoding/parsing.
        const rawBody = await readBodyTextWithLimit(request);

        const envRecord = (env ?? {}) as Record<string, unknown>;
        const schedulerSecret = typeof envRecord["LUNORA_SCHEDULER_SECRET"] === "string" ? envRecord["LUNORA_SCHEDULER_SECRET"] : undefined;
        const adminBearer = options.adminToken ?? (typeof envRecord["LUNORA_ADMIN_TOKEN"] === "string" ? envRecord["LUNORA_ADMIN_TOKEN"] : undefined);

        const signatureHeader = request.headers.get("x-lunora-scheduler-signature");

        let authenticated = false;

        if (signatureHeader && schedulerSecret) {
            authenticated = await verifyHmacSignature(schedulerSecret, rawBody, signatureHeader);
        } else if (adminBearer) {
            // Fallback bearer path — the scheduler uses this only when no HMAC
            // secret is configured on its side.
            authenticated = checkAdminAuth(request, adminBearer);
        }

        if (!authenticated) {
            throw new LunoraError("Scheduler dispatch requires a valid signature or admin bearer", { code: "FORBIDDEN", status: 403 });
        }

        let body: unknown;

        try {
            body = JSON.parse(rawBody);
        } catch {
            throw new LunoraError("Scheduler dispatch body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
        }

        const candidate = (body ?? {}) as { args?: unknown; functionPath?: unknown; id?: unknown; instanceName?: unknown; pool?: unknown; shardKey?: unknown };

        if (typeof candidate.functionPath !== "string" || candidate.functionPath.length === 0) {
            throw new LunoraError("Scheduler dispatch is missing `functionPath`", { code: "BAD_REQUEST", status: 400 });
        }

        const args = (candidate.args ?? {}) as Record<string, unknown>;
        const shardKey = typeof candidate.shardKey === "string" && candidate.shardKey.length > 0 ? candidate.shardKey : defaultShard;

        // Re-apply per-shard authorization (inside `dispatchToShard`) so a
        // scheduled job cannot reach a shard a direct RPC for the same shard
        // would be denied — the scheduler runs jobs with no end-user identity.
        const response = await dispatchToShard(candidate.functionPath, args, shardKey);

        // Workpool jobs hold a concurrency slot until the action settles; release
        // it best-effort (a missed release is reconciled by the pool's next drain).
        await releasePoolSlot(candidate);

        return response;
    };

    // The data-movement admin routes (export / sync / connector-sync / apply /
    // import) live in a sibling module; the export/import row producers are
    // injected because they close over the worker options and are shared with
    // the scheduled R2 backup (mirroring the other extracted clusters).
    const dataMovementAdminRoutes = buildDataMovementAdminRoutes({
        applyGlobals: options.applyGlobals,
        isAdmin: (request) => checkAdminAuth(request, options.adminToken),
        knownTables: () => collectKnownTables(options.resolveTableSharding),
        queryCoordinator: options.queryCoordinator,
        resolveForwardContext: (request, env) => resolveForwardContext(request, env, options.resolveIdentity),
        shardDO: options.shardDO,
        streamExportRows: (coordinator, headers, tables, writeRow) => streamExportRows(options, coordinator, headers, tables, writeRow),
        streamingImport: (request, headers) => streamingImport(request, options, headers),
        syncGlobals: options.syncGlobals,
    });

    /** The `&lt;CODE>_NOT_CONFIGURED` 400 a guarded admin route throws when its backing option is absent. */
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
            throw new LunoraError("admin endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }
    };

    /** Assert admin auth, then assert a worker option is configured; return it (narrowed non-undefined). */
    const requireAdminOption = <T>(request: Request, value: T | undefined, notConfigured: NotConfiguredError): T => {
        assertAdminAuthorized(request);

        if (value === undefined) {
            throw new LunoraError(notConfigured.message, { code: notConfigured.code, status: 400 });
        }

        return value;
    };

    /** Read a query param, collapsing missing (`null`) and empty (`""`) to `undefined`. */
    const queryParameter = (url: URL, name: string): string | undefined => {
        const value = url.searchParams.get(name);

        return value === null || value === "" ? undefined : value;
    };

    /**
     * Parse the shared `limit` / `offset` paging params off an admin GET request.
     * Negative values are clamped to `undefined` (limit) / `0` (offset) so a
     * `?limit=-5` or `?offset=-1` never reaches the introspectors as a malformed
     * SQL `LIMIT`/`OFFSET`.
     */
    const parsePaging = (request: Request): { limit?: number; offset?: number } => {
        const url = new URL(request.url);
        const limitParameter = url.searchParams.get("limit");
        const offsetParameter = url.searchParams.get("offset");
        const limit = limitParameter === null ? undefined : Number.parseInt(limitParameter, 10);
        const offset = offsetParameter === null ? undefined : Number.parseInt(offsetParameter, 10);

        return {
            limit: limit !== undefined && Number.isFinite(limit) && limit >= 0 ? limit : undefined,
            offset: offset !== undefined && Number.isFinite(offset) && offset >= 0 ? offset : undefined,
        };
    };

    const requireSchedulerNamespace = (): ShardNamespaceLike => {
        if (options.schedulerDO === undefined) {
            throw new LunoraError("scheduled endpoints require a `schedulerDO` namespace on the worker", { code: "SCHEDULER_NOT_CONFIGURED", status: 400 });
        }

        return options.schedulerDO;
    };

    const resolveSchedulerStub = (request: Request): ResolvedShard => {
        assertAdminAuthorized(request);

        return resolveShard(requireSchedulerNamespace(), options.schedulerInstanceName ?? "default");
    };

    // The `/_lunora/admin/scheduled*` handlers live in a sibling module; they reach
    // the admin gate, scheduler-namespace requirement, and resolved stub through
    // injected deps (mirroring the other extracted clusters below).
    const scheduledAdminRoutes = buildScheduledAdminRoutes({
        checkWsAdmin: (request) => checkAdminAuth(request, options.adminToken) || checkAdminWsToken(request, options.adminToken),
        requireSchedulerNamespace,
        resolveSchedulerStub,
        schedulerInstanceName: options.schedulerInstanceName ?? "default",
    });

    // The `/_lunora/admin/storage/*` + `/_lunora/admin/vector/*` handlers live in
    // sibling modules (mirroring `./auth-admin-routes`); they reach the admin gate,
    // option registry, and request helpers through injected deps.
    const storageAdminRoutes = buildStorageAdminRoutes({
        assertAdmin: assertAdminAuthorized,
        parsePaging,
        queryParameter,
        readBodyBytes: readBodyBytesWithLimit,
        requireAdminOption,
        storage: {
            storageBuckets: options.storageBuckets,
            storageDelete: options.storageDelete,
            storageList: options.storageList,
            storageSignedUrl: options.storageSignedUrl,
            storageUpload: options.storageUpload,
        },
    });

    const vectorAdminRoutes = buildVectorAdminRoutes({
        readJsonBody: readJsonBodyWithLimit,
        requireAdminOption,
        vectorIntrospector: options.vectorIntrospector,
    });

    const introspectionAdminRoutes = buildIntrospectionAdminRoutes({
        assertAdmin: assertAdminAuthorized,
        options: {
            cronJobs: options.cronJobs,
            functions: options.functions,
            globalIntrospector: options.globalIntrospector,
            openApiSpec: options.openApiSpec,
            openRpcSpec: options.openRpcSpec,
        },
        parsePaging,
        queryParameter,
        requireAdminOption,
    });

    const buildHttpActionContext = async (request: Request, env: unknown): Promise<HttpActionContext> => {
        const { claims, headers, userId } = await resolveForwardContext(request, env, options.resolveIdentity);

        const run = async <R>(reference: unknown, args: Record<string, unknown> = {}): Promise<R> => {
            const functionPath = (reference as { __lunoraRef?: unknown }).__lunoraRef;

            if (typeof functionPath !== "string") {
                throw new LunoraError("ctx.run*: expected a function reference from the generated `api`", { code: "BAD_REQUEST", status: 400 });
            }

            const forwarded = new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args, functionPath }),
                headers,
                method: "POST",
            });

            const response = await forwardToShard(options.shardDO, defaultShard, forwarded);
            const payload: { error?: { code?: string; message?: string }; result?: unknown } = await response.json();

            if (payload.error) {
                throw new LunoraError(payload.error.message ?? "shard RPC failed", {
                    code: payload.error.code ?? "INTERNAL",
                    status: response.status,
                });
            }

            return payload.result as R;
        };

        return {
            auth: {
                getIdentity: () => Promise.resolve(claims),
                userId,
            },
            fetch: globalThis.fetch.bind(globalThis),
            runAction: run,
            runMutation: run,
            runQuery: run,
        };
    };

    const dispatchHttpRoute = async (request: Request, env: unknown, context: ExecutionContextLike): Promise<Response | undefined> => {
        if (!options.httpRouter) {
            return undefined;
        }

        // Build the action context up front and inject it on a private env
        // binding; the router's middleware lifts it into the handler's context.
        // hono then matches/dispatches and returns its own response (incl. 404).
        const httpContext = await buildHttpActionContext(request, env);

        // In-process serverQuery fast-path (PLAN4 §2.2 / §5.3): an SSR loader
        // running inside this worker can call `worker.serverQuery(request, env,
        // api.foo.bar, args, { shardKey })` to reach a Lunora query without a
        // self-`fetch` to `/_lunora/rpc`. It resolves identity + runs the
        // per-shard authorization gate identically to `handleRpc`, then
        // dispatches to the owning shard (the worker→DO hop is itself in-process
        // — not a network self-fetch). `ctx.runQuery`/`runMutation` below keep
        // the loopback-shaped `run` helper for back-compat; `serverQuery` is the
        // identity-parity-guaranteed, shard-routable entrypoint for loaders.

        // Error isolation (PLAN4 §1, §2.2): the `httpRouter` is the meta-framework
        // SSR handler, the LOWEST-priority matcher — it only runs after auth,
        // explicit routes, and the reserved `/_lunora/*` endpoints have all
        // declined. A framework SSR render that THROWS must not propagate past
        // this seam: containing it here (rather than letting it bubble to the
        // top-level fetch catch) keeps a render fault framed as a plain 500 from
        // the SSR plane and guarantees it can never interfere with the realtime
        // plane. Reserved `/_lunora/*` requests are dispatched ahead of this call
        // and on independent fetch invocations, so a single failed SSR render
        // leaves queries / mutations / subscriptions (`/_lunora/rpc`, `/_lunora/ws`)
        // fully serviceable.
        try {
            return await options.httpRouter.fetch(request, { ...(env as object), __lunoraCtx: httpContext }, context);
        } catch (error: unknown) {
            // eslint-disable-next-line no-console -- surface the SSR render fault server-side; the client gets a generic 500, never the raw message
            console.error("[lunora] httpRouter (SSR) handler threw:", error);

            return new Response("Internal Server Error", { status: 500 });
        }
    };

    const handleWebSocketUpgrade = async (request: Request, env: unknown, url: URL): Promise<Response> => {
        if (request.headers.get("Upgrade") !== "websocket") {
            throw new LunoraError("WebSocket upgrade header missing", { code: "BAD_REQUEST", status: 426 });
        }

        const shardKey = url.searchParams.get("shard") ?? defaultShard;

        // Resolve the calling identity once: it both gates the shard and is
        // forwarded to the DO so the socket carries a verified userId (the basis
        // for trusted `onConnect`/`onDisconnect` lifecycle hooks). Mirrors the
        // RPC path's `resolveForwardContext` → `authorize*` ordering.
        const { headers: forwardedHeaders, identity } = await resolveForwardContext(request, env, options.resolveIdentity);

        if (options.authorizeShard) {
            const allowed = await options.authorizeShard(identity, shardKey);

            if (!allowed) {
                throw new LunoraError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
            }
        } else if (shardKey !== defaultShard) {
            warnUnauthenticatedShardAccessOnce("shard");
        }

        // Clone the upgrade request, attaching only the resolved identity headers.
        // The original headers — crucially `Upgrade: websocket` — are preserved so
        // the DO still performs the handshake; the DO reads `x-lunora-userid` /
        // `x-lunora-identity` at upgrade and stashes them on the socket attachment.
        //
        // SECURITY: `x-lunora-userid` / `x-lunora-identity` are server-minted and
        // trusted verbatim by the DO. Strip any client-supplied copies from the
        // clone *unconditionally* before re-setting the resolved values — otherwise
        // an anonymous caller could forge `x-lunora-userid` and, because the
        // resolved-anonymous path never overwrites it, spoof a verified identity on
        // the socket. Only an authenticated `resolveForwardContext` result may set them.
        const upgradeHeaders = new Headers(request.headers);
        upgradeHeaders.delete("x-lunora-userid");
        upgradeHeaders.delete("x-lunora-identity");
        const forwardedUserId = forwardedHeaders["x-lunora-userid"];
        const forwardedIdentity = forwardedHeaders["x-lunora-identity"];

        if (forwardedUserId !== undefined) {
            upgradeHeaders.set("x-lunora-userid", forwardedUserId);
        }

        if (forwardedIdentity !== undefined) {
            upgradeHeaders.set("x-lunora-identity", forwardedIdentity);
        }

        return forwardToShard(options.shardDO, shardKey, new Request(request, { headers: upgradeHeaders }));
    };

    /**
     * Run the per-shard / fan-out authorization gate for an RPC envelope. Throws
     * a 403 `LunoraError` when the caller is not authorized. Fan-out is a
     * privileged op: when `authorizeShard` is set but `authorizeFanOut` is not,
     * fan-out is default-denied rather than silently allowed.
     */
    const authorizeRpcEnvelope = async (envelope: RpcEnvelope, identity: ResolvedIdentity | null): Promise<void> => {
        // Per-shard authorization runs after identity resolution and before
        // the request is forwarded. Fan-out envelopes target every
        // live shard for the table (no client-named shardKey), so the
        // per-shard gate cannot authorize them — `authorizeFanOut`
        // gates fan-out at the table level. Single-shard dispatch
        // goes through `authorizeShard`.
        if (envelope.fanOut) {
            if (options.authorizeFanOut) {
                const allowed = await options.authorizeFanOut(identity, envelope.fanOut.table, envelope.functionPath);

                if (!allowed) {
                    throw new LunoraError("Forbidden fan-out", { code: "FORBIDDEN_FANOUT", status: 403 });
                }
            } else if (envelope.functionPath.startsWith("__lunora_relation__:")) {
                // SECURITY: the reserved `__lunora_relation__:*` fan-out reads RAW,
                // RLS-blind rows from every shard (reverse cross-backend relations)
                // and — unlike `__lunora_admin__:*` — carries no DO-level token
                // backstop. So it must NEVER fall into the warn-and-allow
                // open-posture branch below: that would hand any caller a
                // function-less full-table dump across all shards. Default-deny it
                // whenever `authorizeFanOut` is absent, independent of
                // `authorizeShard` (enabling reverse cross-backend relations
                // REQUIRES configuring `authorizeFanOut`).
                throw new LunoraError(
                    "reverse cross-backend relation reads (`__lunora_relation__:*`) require `authorizeFanOut` to be configured on the worker",
                    {
                        code: "FORBIDDEN_FANOUT",
                        status: 403,
                    },
                );
            } else if (options.authorizeShard) {
                // `authorizeShard` is configured but `authorizeFanOut`
                // is not. Fan-out is a privileged op (it bypasses the
                // per-shard gate by design), so default-deny instead
                // of silently letting any authenticated caller
                // enumerate every shard for the table.
                throw new LunoraError("Fan-out requires `authorizeFanOut` to be configured on the worker when `authorizeShard` is set", {
                    code: "FORBIDDEN_FANOUT",
                    status: 403,
                });
            } else {
                // Neither callback configured: fan-out is authorization-open.
                warnUnauthenticatedShardAccessOnce("fan-out");
            }

            return;
        }

        if (options.authorizeShard) {
            const shardKeyForAuth = envelope.shardKey ?? defaultShard;
            const allowed = await options.authorizeShard(identity, shardKeyForAuth);

            if (!allowed) {
                throw new LunoraError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
            }
        } else if (envelope.shardKey !== undefined && envelope.shardKey !== defaultShard) {
            // No per-shard gate and the caller named a non-default shard.
            warnUnauthenticatedShardAccessOnce("shard");
        }
    };

    /**
     * Dispatch a single-shard RPC envelope to its owning shard and return the
     * shard's `Response` (with the `x-d1-bookmark` propagated). Extracted from
     * {@link handleRpc} so the in-process `serverQuery` fast-path (PLAN4 §2.2 /
     * §5.3) runs the IDENTICAL shard dispatch + observability + bookmark logic
     * as the HTTP `/_lunora/rpc` path — same `forwardToShard`, same shard
     * routing, same error shape. The caller is responsible for having already
     * resolved identity (`resolveForwardContext`) and run the authorization gate
     * (`authorizeRpcEnvelope`); this helper performs neither, so both call sites
     * keep those security steps explicit and in the same order.
     */
    const dispatchSingleShard = async (
        functionPath: string,
        args: Record<string, unknown>,
        shardKey: string,
        forwardedHeaders: Record<string, string>,
    ): Promise<Response> => {
        const rpcStartedAt = Date.now();
        const { observability } = options;

        // Re-emit the RPC body to the shard at its `/rpc` route.
        const forwarded = new Request(`https://shard.internal/rpc`, {
            body: JSON.stringify({ args, functionPath }),
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
                functionPath,
                ok: response.ok,
                shardKey,
                ...(response.ok ? {} : { error: { code: "SHARD_ERROR", message: `shard returned ${String(response.status)}`, status: response.status } }),
            });

            // Propagate the DO's bookmark header so the client can pin reads
            // after a write.
            const responseBookmark = response.headers.get("x-d1-bookmark");

            if (responseBookmark) {
                const headers = new Headers(response.headers);

                headers.set("x-d1-bookmark", responseBookmark);

                return new Response(response.body, { headers, status: response.status });
            }

            return response;
        } catch (error) {
            emitRpcEvent(observability, buildErrorEvent(functionPath, Date.now() - rpcStartedAt, error, { shardKey }));
            throw error;
        }
    };

    const handleRpc = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new LunoraError("RPC endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const envelope = await parseEnvelope(request);

        if (envelope.fanOut && envelope.shardKey) {
            throw new LunoraError("RPC envelope cannot set both `shardKey` and `fanOut`", { code: "BAD_REQUEST", status: 400 });
        }

        // Reserved cross-shard relation reads (reverse cross-backend relations)
        // are fan-out-only. A single-shard envelope naming the
        // `__lunora_relation__:` prefix would bypass the `authorizeFanOut` gate
        // and read one shard's raw rows directly, so refuse it — the only
        // legitimate caller is the coordinator's fan-out, which carries a
        // `fanOut` spec and is authorized through `authorizeRpcEnvelope`. The
        // literal prefix is inlined (not imported from `@lunora/do`) to keep the
        // runtime free of a hard `@lunora/do` dependency.
        if (!envelope.fanOut && envelope.functionPath.startsWith("__lunora_relation__:")) {
            throw new LunoraError("`__lunora_relation__:*` is a fan-out-only reserved RPC and cannot be dispatched to a single shard", {
                code: "FORBIDDEN",
                status: 403,
            });
        }

        // Refuse fan-out envelopes that arrive without a coordinator
        // configured BEFORE we invoke `resolveIdentity` — otherwise the
        // hook would be called for a request that's already destined for
        // a 400, wasting any DB/IO it performs to look up the user.
        if (envelope.fanOut && !options.queryCoordinator) {
            throw new LunoraError("RPC envelope set `fanOut` but no `queryCoordinator` is configured on the worker", {
                code: "BAD_REQUEST",
                status: 400,
            });
        }

        // Forward selected headers from the inbound request so the DO can
        // honour auth, sessions, and D1 read-your-writes consistency.
        const { headers: forwardedHeaders, identity } = await resolveForwardContext(request, env, options.resolveIdentity);

        await authorizeRpcEnvelope(envelope, identity);

        {
            // Timing wraps the dispatch only — envelope parse + coordinator
            // gate + identity resolution happen above and are not part of
            // the user-observable RPC duration we report.
            const rpcStartedAt = Date.now();
            const { observability } = options;

            if (envelope.fanOut) {
                // Coordinator presence was checked above; re-assert for the
                // type system without a non-null assertion.
                const coordinator = options.queryCoordinator;

                if (!coordinator) {
                    throw new LunoraError("RPC envelope set `fanOut` but no `queryCoordinator` is configured on the worker", {
                        code: "BAD_REQUEST",
                        status: 400,
                    });
                }

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

            return dispatchSingleShard(envelope.functionPath, envelope.args ?? {}, shardKey, forwardedHeaders);
        }
    };

    /**
     * In-process server-query fast-path (PLAN4 §2.2 bullet 3 / §5.3 / risk #3).
     *
     * An SSR loader running INSIDE this same worker (the `httpRouter` seam) can
     * call a Lunora query without a self-`fetch` to `/_lunora/rpc`. Skipping the
     * loopback avoids re-entering `fetch()` — URL parse, the route table, and the
     * `/api/auth/*` dispatch chain — for a request whose destination is already
     * known. The worker→ShardDO hop (`forwardToShard` → `stub.fetch`) is *not* a
     * network self-fetch; it is the same in-process Durable Object dispatch the
     * HTTP path performs, and is unavoidable because the data lives in the DO and
     * the worker holds no DB handle.
     *
     * IDENTITY / RLS / AUTH PARITY (the load-bearing contract). This runs the
     * EXACT same security steps as {@link handleRpc}, in the same order, off the
     * SAME inbound `request`:
     *
     * 1. `resolveForwardContext(request, env, options.resolveIdentity)` — the
     * identical identity resolution (`resolveIdentity`, cookie / authorization /
     * `x-d1-bookmark` forwarding, `x-lunora-userid` / `x-lunora-identity` header
     * derivation). Same per-request auth context, byte-for-byte.
     * 2. `authorizeRpcEnvelope({ functionPath, shardKey }, identity)` — the
     * identical per-shard authorization gate (`authorizeShard`), so an
     * unauthenticated / unauthorized call to an auth-gated function is rejected
     * here exactly as it is on `/_lunora/rpc` (same `FORBIDDEN_SHARD` 403).
     * 3. `dispatchSingleShard(...)` — the identical shard routing, observability
     * event, bookmark propagation, and `Response` shape.
     *
     * Result: byte-identical to what `POST /_lunora/rpc` returns for the same
     * function reference, args, `shardKey`, and inbound request. It returns the
     * raw shard {@link Response} (the same object `handleRpc` returns) so callers
     * and tests can compare it byte-for-byte against the HTTP path.
     *
     * Fan-out is intentionally NOT reachable here: it is the cross-shard,
     * coordinator-gated, privileged path. An SSR loader that needs fan-out uses
     * the HTTP `/_lunora/rpc` envelope (with `authorizeFanOut`); this fast-path
     * stays single-shard so the simpler, stricter `authorizeShard` parity holds.
     */
    const serverQuery = async (
        request: Request,
        env: unknown,
        reference: unknown,
        args: Record<string, unknown> = {},
        callOptions: { shardKey?: string } = {},
    ): Promise<Response> => {
        // Error mapping mirrors the top-level `fetch` catch (`toErrorResponse`)
        // EXACTLY: a thrown `LunoraError` (bad reference, a denied `authorizeShard`
        // gate, a 404 from the shard) becomes the same JSON error `Response` the
        // HTTP `/_lunora/rpc` path returns — so an auth-gated rejection is
        // byte-identical on both paths rather than surfacing as a thrown value on
        // one and a 403 `Response` on the other.
        try {
            const functionPath = (reference as { __lunoraRef?: unknown }).__lunoraRef;

            if (typeof functionPath !== "string") {
                throw new LunoraError("serverQuery: expected a function reference from the generated `api`", { code: "BAD_REQUEST", status: 400 });
            }

            // Resolve identity off the SAME inbound request the HTTP path uses, so
            // cookies / bearer / bookmark and the derived `x-lunora-*` headers are
            // byte-identical to `handleRpc`'s.
            const { headers: forwardedHeaders, identity } = await resolveForwardContext(request, env, options.resolveIdentity);

            // Run the IDENTICAL per-shard authorization gate. A `shardKey` of
            // `undefined` resolves to `defaultShard` for both the gate and the
            // dispatch, mirroring `handleRpc` exactly.
            await authorizeRpcEnvelope({ args, functionPath, shardKey: callOptions.shardKey }, identity);

            const shardKey = callOptions.shardKey ?? defaultShard;

            return await dispatchSingleShard(functionPath, args, shardKey, forwardedHeaders);
        } catch (error: unknown) {
            return toErrorResponse(error);
        }
    };

    /** Safety bound on the retention list loop — far above any realistic backup count. */
    const MAX_PRUNE_PAGES = 1000;

    /**
     * Enforce {@link WorkerOptions.backupRetain} by keeping only the newest N
     * snapshots under `prefix` and deleting the older NDJSON objects + their
     * manifests. Backup keys embed an ISO timestamp (colons swapped for dashes),
     * which sorts lexicographically by recency, so a descending key sort is a
     * recency sort. A no-op when retention is unset or non-positive.
     */
    const pruneBackups = async (store: BackupStore, prefix: string): Promise<void> => {
        const retain = options.backupRetain;

        if (retain === undefined || retain <= 0) {
            return;
        }

        const manifestKeys: string[] = [];
        let cursor: string | undefined;

        for (let page = 0; page < MAX_PRUNE_PAGES; page += 1) {
            // eslint-disable-next-line no-await-in-loop -- R2 list is paged; each request resumes from the prior page's cursor.
            const listing = await store.list({ cursor, prefix });

            for (const object of listing.objects) {
                if (object.key.endsWith(".manifest.json")) {
                    manifestKeys.push(object.key);
                }
            }

            if (!listing.truncated || listing.cursor === undefined) {
                break;
            }

            cursor = listing.cursor;
        }

        // Newest first; everything past the retention window is pruned.
        const stale = manifestKeys.toSorted((a, b) => b.localeCompare(a)).slice(retain);

        await Promise.all(
            stale.flatMap((manifestKey) => {
                const ndjsonKey = manifestKey.slice(0, -".manifest.json".length);

                return [store.delete(manifestKey), store.delete(ndjsonKey)];
            }),
        );
    };

    /**
     * Run the built-in backup: export every selected table to NDJSON and write
     * it (plus a manifest sidecar) to {@link WorkerOptions.backupStore}. The
     * snapshot is keyed by the trigger's `scheduledTime` so it's named after the
     * moment it represents. Requires `backupStore`, `queryCoordinator`, and
     * `adminToken` — the export fans out to each shard's admin gate, which the
     * bearer authenticates. Missing prerequisites throw so the platform records
     * the failed cron invocation rather than silently skipping the backup.
     */
    const runScheduledBackup = async (controller: ScheduledControllerLike): Promise<void> => {
        const store = options.backupStore;
        const coordinator = options.queryCoordinator;

        if (!store) {
            throw new LunoraError("scheduled backup requires a `backupStore` on the worker", { code: "BACKUP_NOT_CONFIGURED", status: 500 });
        }

        if (!coordinator) {
            throw new LunoraError("scheduled backup requires a `queryCoordinator` on the worker", { code: "BACKUP_NOT_CONFIGURED", status: 500 });
        }

        if (!options.adminToken || options.adminToken.length === 0) {
            throw new LunoraError("scheduled backup requires an `adminToken` to authenticate the per-shard export gate", {
                code: "BACKUP_NOT_CONFIGURED",
                status: 500,
            });
        }

        // The export fans out to each shard's `/rpc` admin op; the shard gate
        // checks this bearer. No end-user identity is involved.
        const forwardedHeaders: Record<string, string> = { authorization: `Bearer ${options.adminToken}`, "content-type": "application/json" };
        const tables = options.backupTables;

        // Stream the NDJSON straight into R2 so the concatenated body is never
        // held in worker memory at once. `put` resolves after the stream is
        // fully consumed, so the row/byte counters are final by the time we
        // write the manifest. Caveat: the shard fan-out is materialised per
        // shard (one envelope each) and collected before the stream drains, so
        // peak memory still scales with the total shard-local row count — the
        // streaming bounds the response bytes, not the source data.
        let rows = 0;
        let bytes = 0;
        let streamError: Error | undefined;

        const stream = new ReadableStream<Uint8Array>({
            async pull(streamController) {
                const writeRow = (row: ExportRow): void => {
                    const encoded = NDJSON_ENCODER.encode(`${JSON.stringify(row)}\n`);

                    rows += 1;
                    bytes += encoded.byteLength;
                    streamController.enqueue(encoded);
                };

                try {
                    await streamExportRows(options, coordinator, forwardedHeaders, tables, writeRow);
                    streamController.close();
                } catch (error: unknown) {
                    // Capture the failure so it propagates past `put` — a stream
                    // error alone would leave a truncated object with no signal.
                    streamError = error instanceof Error ? error : new Error(String(error));
                    streamController.error(error);
                }
            },
        });

        const prefix = options.backupPrefix ?? "backups/";
        const timestamp = new Date(controller.scheduledTime).toISOString();
        // Colons/periods are awkward in object keys; keep the raw id for the manifest.
        const fileKey = `${prefix}lunora-backup-${timestamp.replaceAll(/[.:]/gu, "-")}.ndjson`;
        const manifestKey = `${fileKey}.manifest.json`;

        await store.put(fileKey, stream, { httpMetadata: { contentType: "application/x-ndjson" } });

        if (streamError !== undefined) {
            throw streamError;
        }

        const manifest: BackupManifest = {
            bytes,
            createdAt: timestamp,
            cron: controller.cron,
            file: fileKey,
            id: timestamp,
            rows,
            scheduledTime: controller.scheduledTime,
            ...(tables ? { tables: tables.join(",") } : {}),
        };

        await store.put(manifestKey, `${JSON.stringify(manifest, undefined, 2)}\n`, { httpMetadata: { contentType: "application/json" } });

        await pruneBackups(store, prefix);
    };

    /**
     * The worker's `scheduled()` entry: dispatch the firing cron trigger to the
     * matching {@link WorkerOptions.crons} handler (if any) and run the built-in
     * backup when the trigger matches {@link WorkerOptions.backupCron}. Both run
     * when a user handler shares the backup's expression. Errors from each are
     * collected and rethrown together so one failure neither masks the other nor
     * is silently swallowed — the platform sees the cron invocation fail.
     */
    const handleScheduled = async (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike): Promise<void> => {
        const errors: Error[] = [];
        const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

        const userHandler = options.crons?.[controller.cron];

        if (userHandler) {
            try {
                await userHandler(controller, env, context);
            } catch (error: unknown) {
                errors.push(toError(error));
            }
        }

        // Code-defined crons: run every job declared under the firing expression.
        // Failures join `errors` for the combined rethrow below.
        await runCronJobs(controller.cron, errors, toError);

        if (options.backupStore && options.backupCron !== undefined && options.backupCron === controller.cron) {
            try {
                await runScheduledBackup(controller);
            } catch (error: unknown) {
                errors.push(toError(error));
            }
        }

        const [first] = errors;

        if (errors.length === 1 && first) {
            throw first;
        }

        if (errors.length > 1) {
            throw new AggregateError(errors, `scheduled("${controller.cron}") had ${String(errors.length)} failure(s)`);
        }
    };

    // Internal endpoint dispatch table. Keyed by pathname; each handler takes
    // the request (and, where needed, env/url) and returns the response.
    type InternalRoute = (request: Request, env: unknown, url: URL) => Promise<Response> | Response;

    /**
     * Record one app-level auth attempt for the auth-failure SLO (PLAN3 §2.3).
     * Fire-and-forget against the ROOT shard — the same namespace + default
     * shard key function dispatch uses — via its `/rpc` endpoint with the
     * reserved `recordAuthEvent` admin op and the admin bearer.
     *
     * Best-effort end to end: resolves the admin token from
     * `options.adminToken` / `LUNORA_ADMIN_TOKEN`, skips silently when no token
     * (or, implicitly, no shard namespace) is configured, and swallows any error
     * so a recording failure NEVER surfaces. Designed to be handed to
     * `ctx.waitUntil`, so it can't block or fail the auth response it follows.
     */
    const recordAuthAttempt = async (env: unknown, outcome: "fail" | "ok"): Promise<void> => {
        try {
            const envRecord = (env ?? {}) as Record<string, unknown>;
            const adminBearer = options.adminToken ?? (typeof envRecord["LUNORA_ADMIN_TOKEN"] === "string" ? envRecord["LUNORA_ADMIN_TOKEN"] : undefined);

            // No admin token ⇒ the per-shard admin gate would reject the write;
            // skip silently so the SLO signal is simply absent.
            if (!adminBearer || adminBearer.length === 0) {
                return;
            }

            const recordRequest = new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: { outcome }, functionPath: RECORD_AUTH_EVENT_OP }),
                headers: { authorization: `Bearer ${adminBearer}`, "content-type": "application/json" },
                method: "POST",
            });

            await forwardToShard(options.shardDO, defaultShard, recordRequest);
        } catch {
            // Best-effort: a recording failure must be silent and must never
            // affect the auth response that already went out.
        }
    };

    /**
     * Run the top-level `@lunora/auth` handler (when configured) ahead of the
     * worker's own routing, and instrument it for the app-level auth-failure SLO
     * (PLAN3 §2.3). When the handler answers a genuine auth ATTEMPT route
     * (sign-in / sign-up / callback under {@link WorkerOptions.authBasePath}),
     * classify the outcome by status (`≥ 400` ⇒ `fail`) and record it
     * fire-and-forget via `ctx.waitUntil`, so the recording never blocks or
     * fails the auth response. Returns the auth `Response`, or `undefined` when
     * no handler is configured or the path isn't an auth route (fall through).
     */
    const dispatchAuth = async (request: Request, env: unknown, url: URL, context: ExecutionContextLike): Promise<Response | undefined> => {
        if (!options.authHandler) {
            return undefined;
        }

        const authResponse = await options.authHandler(request);

        if (!authResponse) {
            return undefined;
        }

        const basePath = options.authBasePath ?? DEFAULT_AUTH_BASE_PATH;

        if (isAuthAttemptPath(url.pathname, basePath)) {
            context.waitUntil(recordAuthAttempt(env, authResponse.status >= 400 ? "fail" : "ok"));
        }

        return authResponse;
    };

    const internalRoutes: Record<string, InternalRoute> = {
        [WS_PATH]: (request, env, url) => handleWebSocketUpgrade(request, env, url),
        [RPC_PATH]: (request, env) => handleRpc(request, env),
        [SCHEDULER_DISPATCH_PATH]: (request, env) => handleSchedulerDispatch(request, env),
        // Extracted handler clusters built above, merged in (mirroring the auth
        // plane below): orchestration (migrate / rank / rankpage / shard-traffic /
        // pitr), data-movement (export / import / sync / connector-sync / apply),
        // scheduled, storage, vector, and the static-introspection reads
        // (functions / cron-jobs / openapi / openrpc / global tables).
        ...orchestrationAdminRoutes,
        ...dataMovementAdminRoutes,
        ...scheduledAdminRoutes,
        ...storageAdminRoutes,
        ...vectorAdminRoutes,
        ...introspectionAdminRoutes,
        // `/_lunora/admin/auth/*` — the whole user-management plane, one route per
        // `AuthAdmin` op, dispatched by the descriptor table in `./auth-admin-routes`.
        ...buildAuthAdminRoutes({
            assertAdmin: assertAdminAuthorized,
            // eslint-disable-next-line sonarjs/deprecation -- `authIntrospector` is the intentional read-only fallback
            getAuthAdmin: () => options.authAdmin ?? options.authIntrospector,
            parsePaging,
            queryParameter,
            readJsonBody: readJsonBodyWithLimit,
        }),
    };

    const handle = async (request: Request, env: unknown, context: ExecutionContextLike): Promise<Response> => {
        const url = new URL(request.url);

        // Fast-path reject on a declared `Content-Length` over the cap — cheap
        // (a header read, no body materialization) but NOT authoritative:
        // `Content-Length` is forgeable. A chunked body omits it and a
        // non-numeric value parses to `NaN`, so a missing/unparseable length is
        // treated as "unknown" (let the request through here) — the real
        // enforcement happens in `readBodyTextWithLimit` / the streaming import
        // reader, which abort with 413 once cumulative bytes exceed the cap.
        if (request.method === "POST" || request.method === "PUT") {
            const contentLength = Number(request.headers.get("content-length") ?? "");

            if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
                throw new LunoraError("Body too large", { code: "PAYLOAD_TOO_LARGE", status: 413 });
            }
        }

        // Top-level `@lunora/auth` dispatch (+ SLO instrumentation). Auth runs as
        // a `/api/auth/*` route, ahead of the worker's own routing, so a sign-in
        // never reaches function dispatch. Returns the auth `Response` when the
        // handler owns the path, else `undefined` to fall through.
        const authResponse = await dispatchAuth(request, env, url, context);

        if (authResponse) {
            return authResponse;
        }

        // Auth providers register routes as `"METHOD path"` (e.g. `"GET /auth/signin"`).
        // We also accept legacy pathname-only keys for ad-hoc handlers.
        const methodAndPath = `${request.method} ${url.pathname}`;
        const route = options.routes?.[methodAndPath] ?? options.routes?.[url.pathname];

        if (route) {
            return route(request, env, context);
        }

        // Internal `/_lunora/*` endpoints, keyed by pathname. Each entry adapts
        // to the shared `(request, env, url) => Promise<Response>` shape so the
        // dispatch stays a single table lookup rather than a long if-chain.
        const internalRoute = internalRoutes[url.pathname];

        if (internalRoute) {
            return internalRoute(request, env, url);
        }

        // HTTP actions are the lowest-priority matcher: explicit routes and the
        // internal `/_lunora/*` endpoints above always win. Once the request
        // reaches the router, hono owns routing — its 404 is the terminal 404.
        const httpRouteResponse = await dispatchHttpRoute(request, env, context);

        if (httpRouteResponse) {
            return httpRouteResponse;
        }

        return new Response("Not found", { status: 404 });
    };

    return {
        async fetch(request, env, context) {
            if (options.passThroughOnException) {
                context.passThroughOnException();
            }

            try {
                return await handle(request, env, context);
            } catch (error: unknown) {
                return toErrorResponse(error);
            }
        },
        async scheduled(controller, env, context) {
            await handleScheduled(controller, env, context);
        },
        serverQuery,
    };
};

/**
 * Compose a meta-framework SSR handler and Lunora into a single Cloudflare
 * Worker (PLAN4 §1, §2.2). Thin sugar over {@link createWorker} — a
 * near-pass-through whose value is naming and a documented, framework-neutral
 * entrypoint, so a template reads cleanly:
 *
 * ```ts
 * import { composeWorker } from "@lunora/runtime";
 *
 * export default composeWorker({
 *   httpRouter: ssrHandler, // TanStack Start / React Router / SolidStart / …
 *   shardDO: env.SHARD,
 *   auth,
 * });
 * ```
 *
 * `httpRouter` is *any* meta-framework SSR handler — structurally an
 * {@link HttpRouterLike} (`{ fetch(request, env?, ctx?) }`). It is the
 * lowest-priority matcher: the worker dispatches auth (`/api/auth/*`), explicit
 * {@link WorkerOptions.routes}, and the reserved realtime endpoints
 * (`/_lunora/rpc`, `/_lunora/ws`, `/_lunora/admin/*`) first, then falls through
 * to `httpRouter.fetch` for everything else. An SSR render that throws is
 * contained at that seam and surfaced as a plain 500 — it can never take down
 * the realtime plane (see `dispatchHttpRoute`). The two flows share one worker
 * but never collide.
 *
 * The signature is identical to {@link createWorker}; pass exactly the same
 * options. Prefer this name in framework templates to make the composition
 * intent explicit.
 */
const composeWorker = (options: WorkerOptions): LunoraWorker => createWorker(options);

/**
 * A meta-framework's emitted Cloudflare handler: either a bare `fetch` function
 * or a `{ fetch }` module object (optionally carrying its own `scheduled`). Every
 * class-B adapter output (`@sveltejs/adapter-cloudflare`, Nitro's
 * `cloudflare-module`, `@astrojs/cloudflare`) is structurally one of these.
 */
type FrameworkHostHandler =
    | ((request: Request, env?: unknown, context?: ExecutionContextLike) => Promise<Response> | Response)
    | (HttpRouterLike & { scheduled?: (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike) => Promise<void> | void });

/** Lunora worker options for {@link withFrameworkWorker} — everything except `httpRouter` (supplied from the framework host). */
type FrameworkWorkerOptions = Omit<WorkerOptions, "httpRouter">;

/**
 * Either fixed {@link FrameworkWorkerOptions}, or a factory deriving them from the
 * per-request `env` — for bindings (like `env.SHARD` → `shardDO`) that only exist
 * at request time.
 */
type FrameworkWorkerOptionsInput = ((env: unknown) => FrameworkWorkerOptions) | FrameworkWorkerOptions;

const toHttpRouter = (handler: FrameworkHostHandler): HttpRouterLike => (typeof handler === "function" ? { fetch: handler } : handler);

/** Whether the Lunora options configure any cron surface (so Lunora owns `scheduled` rather than the framework host). */
const hasLunoraCrons = (options: FrameworkWorkerOptions): boolean => Boolean(options.crons ?? options.cronJobs ?? options.backupCron);

/**
 * Compose a meta-framework's Cloudflare Worker handler with Lunora's realtime
 * plane into one `{ fetch, scheduled }` Worker — the **single, shared** class-B
 * (own-CF-adapter, hook-injection) composer behind `@lunora/svelte/worker`,
 * `@lunora/vue/worker`, and `@lunora/astro`'s `withLunora` (PLAN4 §3). It wraps
 * the framework handler as {@link composeWorker}'s `httpRouter`, so the reserved
 * realtime endpoints (`/_lunora/rpc`, `/_lunora/ws`, `/_lunora/admin/*`) plus
 * auth/explicit `routes` go to Lunora and **everything else** delegates to the
 * framework. A framework render that throws is contained at the seam and
 * surfaced as a plain 500 — it can never take down the realtime plane.
 *
 * Owns the three behaviors the adapters otherwise each re-implemented (and
 * diverged on): (1) the host may be a bare `fetch` fn or a `{ fetch }` object;
 * (2) options may be a fixed object or an `(env) => options` factory, rebuilt per
 * request so per-request bindings wire in; (3) **`scheduled` preservation** — when
 * Lunora configures no cron surface, the framework host's own `scheduled` (if any)
 * is preserved rather than silently dropped; otherwise Lunora owns it (crons /
 * backup).
 * @param host The framework's emitted Cloudflare handler.
 * @param optionsInput Lunora options minus `httpRouter`, or an `(env) => options` factory.
 */
const withFrameworkWorker = (host: FrameworkHostHandler, optionsInput: FrameworkWorkerOptionsInput): LunoraWorker => {
    const httpRouter = toHttpRouter(host);
    const hostScheduled = typeof host === "object" && typeof host.scheduled === "function" ? host.scheduled : undefined;

    const build = (options: FrameworkWorkerOptions): LunoraWorker => {
        const lunora = composeWorker({ ...options, httpRouter });

        // Preserve the framework host's own `scheduled` when Lunora configures no
        // cron surface (so a host with cron tasks isn't silently dropped). Spread
        // `lunora` so `fetch`/`serverQuery` are kept and only `scheduled` is
        // overridden.
        if (hostScheduled !== undefined && !hasLunoraCrons(options)) {
            return {
                ...lunora,
                scheduled: async (controller, env, context): Promise<void> => {
                    await hostScheduled(controller, env, context);
                },
            };
        }

        return lunora;
    };

    if (typeof optionsInput !== "function") {
        return build(optionsInput);
    }

    // Factory form: options depend on per-request `env`, so (re)build per call.
    const optionsFactory = optionsInput;

    return {
        fetch: (request, env, context) => build(optionsFactory(env)).fetch(request, env, context),
        scheduled: (controller, env, context) => build(optionsFactory(env)).scheduled(controller, env, context),
        serverQuery: (request, env, reference, args, options) => build(optionsFactory(env)).serverQuery(request, env, reference, args, options),
    };
};

/** Re-exported helper so callers can roundtrip envelopes in tests. */
const defineRpcEnvelope = (envelope: RpcEnvelope): RpcEnvelope => envelope;

export { composeWorker, createWorker, defineRpcEnvelope, withFrameworkWorker };
export type {
    AdminTableResolver,
    BackupManifest,
    BackupStore,
    CronHandler,
    CronJobDispatch,
    CronJobInfo,
    ExecutionContextLike,
    FrameworkHostHandler,
    FrameworkWorkerOptions,
    FrameworkWorkerOptionsInput,
    FunctionDescriptor,
    FunctionRegistryEntry,
    FunctionRegistryLike,
    GlobalExportFunction as GlobalExportFn,
    GlobalFacetResult,
    GlobalFilterClause,
    GlobalImportFunction as GlobalImportFn,
    GlobalIntrospector,
    GlobalTableInfo,
    GlobalTablePage,
    HttpActionContext,
    HttpActionLike,
    HttpRouterLike,
    LunoraWorker,
    ResolvedIdentity,
    Route,
    RpcContext,
    RpcEnvelope,
    ScheduledControllerLike,
    ShardingInfo,
    StorageDeleteFunction as StorageDeleteFn,
    StorageListFunction as StorageListFn,
    StorageObject,
    StorageSignedUrlFunction as StorageSignedUrlFn,
    StorageUploadFunction as StorageUploadFn,
    VectorIndexSummary,
    VectorIntrospector,
    VectorQueryMatch,
    WorkerOptions,
};

export type {
    AuthAdmin,
    AuthCapabilities,
    AuthImpersonation,
    AuthIntrospector,
    AuthPage,
    AuthSession,
    AuthTimestamp,
    AuthUser,
    ListAuthUsersOptions,
} from "./auth-admin-routes";
