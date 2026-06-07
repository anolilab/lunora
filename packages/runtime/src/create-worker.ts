import type { ConnectorChange, ConnectorSyncPage } from "./connector-format.js";
import type { FunctionArgumentDescriptor } from "./describe-args.js";
import { describeArguments } from "./describe-args.js";
import { CirrusError, isStructuralCirrusError, isStructuralConflictError, toErrorResponse } from "./errors.js";
import type { ObservabilityEvent, ObservabilitySink } from "./observability.js";
import { emitRpcEvent } from "./observability.js";
import type { FanOutSpec, QueryCoordinator } from "./query-coordinator.js";
import type { ResolvedShard, ShardNamespaceLike } from "./resolve-shard.js";
import { resolveShard } from "./resolve-shard.js";

/**
 * Wire-format RPC envelope. Posted to `POST /_cirrus/rpc`.
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
 * `@cirrus/server` dependency while remaining assignable from the fully-typed
 * `HttpActionCtx` on the server side (`{ __cirrusRef }` is read at runtime).
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
 * Structural view of `@cirrus/server`'s `httpRouter()`. The worker dispatches by
 * calling `fetch` — the same shape as a hono app's `app.fetch` — so the runtime
 * stays free of a hard dependency on the server package (and on hono). The
 * per-request {@link HttpActionContext} is injected on the `__cirrusCtx` env
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
 * skip both `x-cirrus-userid` and `x-cirrus-identity` headers, and
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
 * Structural so this package stays free of `@cirrus/server`. The codegen-
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
 * for the admin sync endpoint. Wire it to `@cirrus/d1`'s `readD1CdcChanges`.
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

/** One R2 object as the storage browser surfaces it. Mirrors `@cirrus/storage`'s `R2ObjectLike`. */
interface StorageObject {
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
    kind: "action" | "mutation" | "query";
    visibility?: "internal" | "public";
}

/**
 * The generated `CIRRUS_FUNCTIONS` dispatch table, narrowed to what the
 * discovery endpoint reads. Pass the map straight from `_generated/server.ts`.
 */
type FunctionRegistryLike = Record<string, FunctionRegistryEntry>;

/**
 * Lists objects in the storage bucket for the admin file browser. Structurally
 * compatible with `@cirrus/storage`'s `Storage["list"]` — the runtime stays free
 * of a hard dependency on the storage package.
 */
type StorageListFunction = (prefix?: string, options?: { cursor?: string; limit?: number }) => Promise<{ cursor?: string; objects: StorageObject[] }>;

/** One `.global()` table plus its row count. Mirrors `@cirrus/d1`'s `GlobalTableInfo`. */
interface GlobalTableInfo {
    name: string;
    rowCount: number;
}

/** A window of rows from one global table. Mirrors `@cirrus/d1`'s `GlobalTablePage`. */
interface GlobalTablePage {
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
interface GlobalIntrospector {
    listTables: () => Promise<GlobalTableInfo[]>;
    readTablePage: (options: { limit?: number; offset?: number; table: string }) => Promise<GlobalTablePage>;
}

/** A timestamp as better-auth stores it: epoch-ms, an ISO string, or absent. */
type AuthTimestamp = null | number | string;

/** One authenticated user, as the auth browser surfaces it. Mirrors better-auth's `user` row. */
interface AuthUser {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    email?: null | string;
    emailVerified?: boolean | null;
    id: string;
    image?: null | string;
    name?: null | string;
}

/** One auth session, as the auth browser surfaces it. Mirrors better-auth's `session` row. */
interface AuthSession {
    [key: string]: unknown;
    createdAt?: AuthTimestamp;
    expiresAt?: AuthTimestamp;
    id: string;
    ipAddress?: null | string;
    userAgent?: null | string;
    userId: string;
}

/** A page of users or sessions plus the total count, for paginated browsing. */
interface AuthPage<T> {
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
interface AuthIntrospector {
    listSessions: (options: { limit?: number; offset?: number; userId?: string }) => Promise<AuthPage<AuthSession>>;
    listUsers: (options: { limit?: number; offset?: number }) => Promise<AuthPage<AuthUser>>;
}

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
 * `CIRRUS_CRONS` map. `functionPath` is the `"namespace:fn"` to run, `args` its
 * bound arguments, and `name` the human label from the `cronJobs()` builder.
 * Pass the whole `CIRRUS_CRONS` map as {@link WorkerOptions.cronJobs}; the worker
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
 * R2-like sink for scheduled backups. Structurally a subset of `@cirrus/storage`'s
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
     * Read-only introspector for the auth store's users and sessions, backing
     * the dashboard's users panel via `GET /_cirrus/admin/auth/users` and
     * `/_cirrus/admin/auth/sessions`. Omit it and those endpoints respond
     * `AUTH_NOT_CONFIGURED`.
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
     * NDJSON object lands at `&lt;prefix>cirrus-backup-&lt;id>.ndjson` and its manifest
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
     * `CIRRUS_CRONS` map directly. On a firing trigger the worker runs every job
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
    storageList?: StorageListFunction;

    /**
     * Page the `.global()` (D1) change-data-capture log for the admin sync
     * endpoint. When omitted, the sync feed covers only shard-local tables.
     */
    syncGlobals?: GlobalCdcSyncFunction;
}

interface RpcContext {
    ctx: ExecutionContextLike;
    env: unknown;
    request: Request;
    shardKey: string;
}

/**
 * Maximum body size (in bytes) accepted by any POST/PUT path the worker
 * exposes. Enforced in two layers: a cheap (forgeable) `Content-Length`
 * fast-path at the entry point, and an authoritative byte budget applied while
 * reading the body — `parseEnvelope`, `parseMigrateRequest`, `parseExportBody`,
 * and `streamingImport` all abort with a 413 once cumulative bytes exceed this
 * cap, so a chunked or length-stripped payload can't slip past.
 */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Shared, stateless `TextEncoder` for NDJSON export/backup streaming. `encode()`
 * is reusable across calls, so a single module-scope instance avoids allocating
 * a fresh encoder per export/backup stream.
 */
const NDJSON_ENCODER = new TextEncoder();

/**
 * Read a request body fully into text while enforcing a hard byte budget as the
 * bytes arrive. `Content-Length` is forgeable — a chunked request omits it
 * (so the header guard sees `0`) and a non-numeric value makes the header guard
 * `NaN` (so the guard is skipped) — therefore the cap MUST be re-checked while
 * reading, not only from the header. Aborts with a 413 the moment cumulative
 * bytes exceed {@link MAX_BODY_BYTES}, before the oversized payload is buffered.
 *
 * A `null` body (GET-style request with no body) decodes to `""`.
 */
const readBodyTextWithLimit = async (request: Request, limit: number = MAX_BODY_BYTES): Promise<string> => {
    if (!request.body) {
        return "";
    }

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let text = "";

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- drain the body stream until the reader signals `done`
    while (true) {
        // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential; each chunk depends on the prior read
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a stream read can yield `done: false` with an undefined `value`; guard before reading byteLength
        if (value) {
            total += value.byteLength;

            if (total > limit) {
                // Stop pulling more bytes; release the underlying stream.
                // eslint-disable-next-line no-await-in-loop -- one-shot cleanup on the over-budget abort path before throwing
                await reader.cancel().catch(() => {});

                throw new CirrusError("Body too large", { code: "PAYLOAD_TOO_LARGE", status: 413 });
            }

            text += decoder.decode(value, { stream: true });
        }
    }

    text += decoder.decode();

    return text;
};

const RPC_PATH = "/_cirrus/rpc";
const WS_PATH = "/_cirrus/ws";
const MIGRATE_PATH = "/_cirrus/migrate";
const PITR_PATH = "/_cirrus/admin/pitr";
const SCHEDULER_DISPATCH_PATH = "/_cirrus/scheduler/dispatch";
const EXPORT_PATH = "/_cirrus/admin/export";
const IMPORT_PATH = "/_cirrus/admin/import";
const SYNC_PATH = "/_cirrus/admin/sync";
const CONNECTOR_SYNC_PATH = "/_cirrus/admin/connector/sync";
const APPLY_PATH = "/_cirrus/admin/apply";
const SCHEDULED_PATH = "/_cirrus/admin/scheduled";
const SCHEDULED_WS_PATH = "/_cirrus/admin/scheduled/ws";
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
 * Per-shard admin RPCs the PITR endpoint is allowed to forward. Like
 * {@link MIGRATION_ADMIN_OPS}, spelled out inline to keep the runtime free of a
 * hard dependency on `@cirrus/do`. Unlike migration, PITR targets a single
 * shard (a Durable Object's change log is per-object), so the endpoint forwards
 * to one shard rather than fanning out.
 */
const PITR_ADMIN_OPS = new Set<string>(["__cirrus_admin__:getPitrBookmark", "__cirrus_admin__:pitrRestore"]);

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
 * status / message from any transport-mappable error (a {@link CirrusError} or
 * a structural `CirrusError`/`ConflictError` from a downstream package, the
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
    const mappable = error instanceof CirrusError || isStructuralCirrusError(error) || isStructuralConflictError(error);
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
        // eslint-disable-next-line unicorn/no-null -- `claims`/`identity`/`userId` feed the public HttpActionContext + authorize* callback contracts, whose anonymous sentinel is `null`
        return { claims: null, headers, identity: null, userId: null };
    }

    const identity = await resolveIdentity(request, env);

    if (!identity || typeof identity.userId !== "string" || identity.userId.length === 0) {
        // eslint-disable-next-line unicorn/no-null -- `claims`/`identity`/`userId` feed the public HttpActionContext + authorize* callback contracts, whose anonymous sentinel is `null`
        return { claims: null, headers, identity: null, userId: null };
    }

    headers["x-cirrus-userid"] = identity.userId;

    // Strip `userId` so the DO doesn't see it twice. The rest of the identity
    // (claims like email/name/roles) is JSON-encoded so handlers can read it
    // via `ctx.auth.getIdentity()`.
    const { userId, ...extra } = identity;
    // eslint-disable-next-line unicorn/no-null -- `claims` is surfaced via the public HttpActionContext `getIdentity()` whose empty sentinel is `null`
    const claims = Object.keys(extra).length > 0 ? extra : null;

    if (claims) {
        headers["x-cirrus-identity"] = JSON.stringify(claims);
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
        throw new CirrusError("RPC `fanOut` must be an object", { code: "BAD_REQUEST", status: 400 });
    }

    const spec = fanOut as { merge?: unknown; table?: unknown };

    if (typeof spec.table !== "string" || spec.table.length === 0) {
        throw new CirrusError("RPC `fanOut.table` must be a non-empty string", { code: "BAD_REQUEST", status: 400 });
    }

    if (!spec.merge || typeof spec.merge !== "object") {
        throw new CirrusError("RPC `fanOut.merge` must be an object", { code: "BAD_REQUEST", status: 400 });
    }

    const merge = spec.merge as { by?: unknown; k?: unknown; kind?: unknown };

    if (typeof merge.kind !== "string" || !KNOWN_MERGE_KINDS.has(merge.kind)) {
        throw new CirrusError("RPC `fanOut.merge.kind` is not a recognized merge strategy", { code: "BAD_REQUEST", status: 400 });
    }

    if (merge.kind === "topK") {
        if (typeof merge.k !== "number" || !Number.isInteger(merge.k) || merge.k < 0) {
            throw new CirrusError("RPC `fanOut.merge.k` must be a non-negative integer", { code: "BAD_REQUEST", status: 400 });
        }

        if (typeof merge.by !== "string" || merge.by.length === 0) {
            throw new CirrusError("RPC `fanOut.merge.by` must be a non-empty string", { code: "BAD_REQUEST", status: 400 });
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
        throw new CirrusError("RPC body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
    }

    if (!body || typeof body !== "object" || typeof (body as { functionPath?: unknown }).functionPath !== "string") {
        throw new CirrusError("RPC envelope is missing `functionPath`", { code: "BAD_REQUEST", status: 400 });
    }

    const envelope = body as RpcEnvelope;

    return {
        args: envelope.args ?? {},
        fanOut: validateFanOut(envelope.fanOut),
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
        const text = await readBodyTextWithLimit(request);

        body = text === "" ? {} : JSON.parse(text);
    } catch (error) {
        if (error instanceof CirrusError) {
            throw error;
        }

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
        const text = await readBodyTextWithLimit(request);

        body = text === "" ? {} : JSON.parse(text);
    } catch (error) {
        if (error instanceof CirrusError) {
            throw error;
        }

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
 * Read a JSON request body under the authoritative `MAX_BODY_BYTES` cap.
 *
 * Mirrors `parseExportBody`/`parseMigrateRequest`: drains the body through the
 * byte-budgeted reader (so a chunked / Content-Length-stripped payload can't
 * slip past the cap) and maps a 413 through unchanged while turning any other
 * parse failure into a 400. Returns `{}` for an empty body.
 */
const readJsonBodyWithLimit = async (request: Request): Promise<Record<string, unknown>> => {
    try {
        const text = await readBodyTextWithLimit(request);

        return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch (error) {
        if (error instanceof CirrusError) {
            throw error;
        }

        throw new CirrusError("Request body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
    }
};

interface PitrRequest {
    args: Record<string, unknown>;
    functionPath: string;
    /** Target shard; omitted means the default (root) shard. */
    shardKey: string | undefined;
}

/**
 * Parse and validate a `POST /_cirrus/admin/pitr` body. `functionPath` is
 * restricted to the PITR admin ops so the endpoint can't be turned into a
 * general per-shard RPC bypass of the user-facing authorization callbacks.
 */
const parsePitrRequest = async (request: Request): Promise<PitrRequest> => {
    const body = await readJsonBodyWithLimit(request);
    const candidate = body as { args?: unknown; functionPath?: unknown; shardKey?: unknown };

    if (typeof candidate.functionPath !== "string" || !PITR_ADMIN_OPS.has(candidate.functionPath)) {
        throw new CirrusError("PITR request `functionPath` must be a PITR admin op", { code: "BAD_REQUEST", status: 400 });
    }

    if (candidate.shardKey !== undefined && typeof candidate.shardKey !== "string") {
        throw new CirrusError("PITR `shardKey` must be a string", { code: "BAD_REQUEST", status: 400 });
    }

    return {
        args: (candidate.args ?? {}) as Record<string, unknown>,
        functionPath: candidate.functionPath,
        shardKey: candidate.shardKey,
    };
};

/**
 * Decoded shape of the connector sync endpoint's opaque cursor token. Encodes
 * the per-shard CDC cursor map plus the global (D1) cursor behind a single
 * base64url string so a warehouse connector treats the whole multi-source
 * position as one black-box `state` value (the contract Fivetran/Airbyte expect).
 */
interface ConnectorCursorState {
    /** Global (D1) CDC `seq` last read through. */
    g: number;
    /** Per-shard CDC `seq` last read through, keyed by shard key. */
    s: Record<string, number>;
    /** Token format version, so the shape can evolve without breaking old cursors. */
    v: 1;
}

/**
 * Encode a {@link ConnectorCursorState} as an opaque base64url token. The
 * consumer stores it verbatim and re-posts it to resume — it never parses it,
 * so the internal shape stays free to change behind the version tag.
 */
const encodeConnectorCursor = (state: ConnectorCursorState): string => {
    const json = JSON.stringify(state);
    const bytes = NDJSON_ENCODER.encode(json);
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/**
 * Decode an opaque connector cursor token back to its {@link ConnectorCursorState}.
 * A missing / empty / malformed token decodes to the zero state (sync from the
 * beginning) so a fresh consumer can omit the cursor and a corrupt one can't
 * crash the endpoint — the worst case is a full re-sync, which is safe (upsert).
 */
const decodeConnectorCursor = (token: unknown): ConnectorCursorState => {
    const empty: ConnectorCursorState = { g: 0, s: {}, v: 1 };

    if (typeof token !== "string" || token.length === 0) {
        return empty;
    }

    try {
        const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
        const bytes = new Uint8Array(binary.length);

        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.codePointAt(index) ?? 0;
        }

        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ConnectorCursorState>;
        const shards = parsed.s && typeof parsed.s === "object" ? parsed.s : {};
        const sanitized: Record<string, number> = {};

        for (const [key, value] of Object.entries(shards)) {
            if (typeof value === "number" && Number.isFinite(value)) {
                sanitized[key] = value;
            }
        }

        return { g: typeof parsed.g === "number" && Number.isFinite(parsed.g) ? parsed.g : 0, s: sanitized, v: 1 };
    } catch {
        return empty;
    }
};

/**
 * Flatten one raw CDC change record (the `{ id, op, seq, table, ts, doc? }` shape
 * both the shard and D1 change feeds emit) into a {@link ConnectorChange} the
 * connector-format helpers consume. A delete carries no post-image `doc`, so the
 * row is reduced to its primary key (`_id`) from the change's `id`; an unknown
 * `op` collapses to `"upsert"`.
 */
const flattenCdcChange = (change: Record<string, unknown>): ConnectorChange => {
    const table = typeof change["table"] === "string" ? change["table"] : "";
    const rawOp = typeof change["op"] === "string" ? change["op"] : "";
    const op: ConnectorChange["op"] = rawOp === "delete" || rawOp === "insert" || rawOp === "update" ? rawOp : "upsert";
    const id = typeof change["id"] === "string" ? change["id"] : undefined;
    const postImage = change["doc"] && typeof change["doc"] === "object" ? (change["doc"] as Record<string, unknown>) : undefined;
    // A delete has no post-image; surface the primary key so the consumer can
    // tombstone the row. Insert/update carry the full post-image.
    const documentRow: Record<string, unknown> = postImage ?? (id === undefined ? {} : { _id: id });

    return { doc: documentRow, op, table };
};

/**
 * Fold one source's CDC page (a shard's or the global plane's) into the
 * accumulating connector page: flatten its changes onto `changes` and report
 * whether it filled the requested `limit` (a full page signals more rows likely
 * remain past this cursor). Pure routing — the caller owns cursor bookkeeping.
 */
const foldCdcPage = (changes: ConnectorChange[], pageChanges: ReadonlyArray<Record<string, unknown>>, limit: number | undefined): boolean => {
    for (const change of pageChanges) {
        changes.push(flattenCdcChange(change));
    }

    return limit !== undefined && pageChanges.length >= limit;
};

/**
 * Best-effort enumeration of known tables for the auto-export path. The
 * runtime doesn't carry the schema, so we ask the resolver for a sentinel set
 * by probing common conventions; in practice the codegen-generated worker
 * wraps `resolveTableSharding` with `Object.keys(schema.tables)` and returns
 * via a side channel. For now this falls through to an empty list — the CLI
 * always passes explicit `--tables` so this path is mainly defensive.
 */
const collectKnownTables = (_resolver: AdminTableResolver | undefined): string[] => [];

interface AdminBatch {
    rows: { doc: Record<string, unknown>; table: string }[];
    shardKey: string;
    startLine: number;
}

type ImportRowError = { code: string; line: number; message: string; table: string };

type ParsedImportRow = { error: ImportRowError; ok: false } | { doc: Record<string, unknown>; ok: true; table: string };

/**
 * Validate one NDJSON import line into a `{ table, doc }` row, or an
 * `ImportRowError` describing why the line was rejected. Pure — the caller
 * owns line numbering and accumulation.
 */
const parseImportRow = (trimmed: string, lineNumber: number): ParsedImportRow => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return { error: { code: "BAD_ROW", line: lineNumber, message: "line is not valid JSON", table: "" }, ok: false };
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { error: { code: "BAD_ROW", line: lineNumber, message: "row must be a JSON object", table: "" }, ok: false };
    }

    const candidate = parsed as { doc?: unknown; table?: unknown };

    if (typeof candidate.table !== "string" || candidate.table.length === 0) {
        return { error: { code: "BAD_ROW", line: lineNumber, message: "row is missing `table`", table: "" }, ok: false };
    }

    if (!candidate.doc || typeof candidate.doc !== "object" || Array.isArray(candidate.doc)) {
        return { error: { code: "BAD_ROW", line: lineNumber, message: "row is missing or malformed `doc`", table: candidate.table }, ok: false };
    }

    return { doc: candidate.doc as Record<string, unknown>, ok: true, table: candidate.table };
};

type ResolvedImportShardKey = { error: ImportRowError; ok: false } | { ok: true; shardKey: string };

/**
 * Resolve the shard key a shard-local import row routes to. Returns the key, or
 * an `ImportRowError` when a `shardBy` table is missing its shard field.
 */
const resolveImportShardKey = (
    documentRow: Record<string, unknown>,
    table: string,
    info: ShardingInfo | undefined,
    defaultShard: string,
    lineNumber: number,
): ResolvedImportShardKey => {
    if (info?.mode.kind === "shardBy" && typeof info.mode.field === "string") {
        const raw = documentRow[info.mode.field];

        if (raw === undefined || raw === null) {
            return {
                error: { code: "BAD_ROW", line: lineNumber, message: `row missing shard field "${info.mode.field}" for table "${table}"`, table },
                ok: false,
            };
        }

        return { ok: true, shardKey: typeof raw === "string" ? raw : JSON.stringify(raw) };
    }

    return { ok: true, shardKey: defaultShard };
};

interface BucketedImport {
    errors: ImportRowError[];
    globalLineMap: number[];
    globalRows: { doc: Record<string, unknown>; table: string }[];
    perShard: Map<string, AdminBatch>;
}

/**
 * Drain the inbound NDJSON body line-by-line (enforcing the byte budget as
 * bytes arrive), validating + bucketing each row into the per-shard batches,
 * the global-rows list, or the per-row error list. Pure routing — the caller
 * fans the buckets out to their storage planes.
 */
const bucketImportStream = async (request: Request, options: WorkerOptions, defaultShard: string): Promise<BucketedImport> => {
    if (!request.body) {
        throw new CirrusError("Import endpoint requires a request body", { code: "BAD_REQUEST", status: 400 });
    }

    const errors: ImportRowError[] = [];
    const globalRows: { doc: Record<string, unknown>; table: string }[] = [];
    const globalLineMap: number[] = [];
    const perShard = new Map<string, AdminBatch>();
    // Physical 1-based source line index. Incremented for EVERY line handled,
    // including blank ones, so `error.line` / `startLine` always point at the
    // user's actual source line. Counting only non-blank lines (the old bug)
    // mis-attributed errors whenever the NDJSON had a leading/interior blank line.
    let physicalLine = 0;

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // Enforce the body-size cap as bytes arrive — `Content-Length` is forgeable
    // and an NDJSON import is exactly the streaming/chunked shape that bypasses
    // the header fast-path. Abort with 413 once cumulative bytes exceed the cap.
    let totalBytes = 0;

    const handleLine = (line: string): void => {
        // Advance the physical line counter first so blank lines still consume a
        // line number — keeps `error.line` aligned with the source file.
        physicalLine += 1;

        const trimmed = line.trim();

        if (trimmed.length === 0) {
            return;
        }

        const row = parseImportRow(trimmed, physicalLine);

        if (!row.ok) {
            errors.push(row.error);

            return;
        }

        const { doc: documentRow, table } = row;
        const info = options.resolveTableSharding?.(table);

        if (info?.mode.kind === "global") {
            globalRows.push({ doc: documentRow, table });
            globalLineMap.push(physicalLine);

            return;
        }

        // Shard-local routing: shardBy(field) picks the value of `doc[field]`;
        // root/undefined modes route to the default shard.
        const resolved = resolveImportShardKey(documentRow, table, info, defaultShard, physicalLine);

        if (!resolved.ok) {
            errors.push(resolved.error);

            return;
        }

        const existing = perShard.get(resolved.shardKey);

        if (existing) {
            existing.rows.push({ doc: documentRow, table });
        } else {
            perShard.set(resolved.shardKey, { rows: [{ doc: documentRow, table }], shardKey: resolved.shardKey, startLine: physicalLine });
        }
    };

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- drain the NDJSON body stream until the reader signals `done`
    while (true) {
        // eslint-disable-next-line no-await-in-loop -- stream reads are inherently sequential; each chunk depends on the prior read
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a stream read can yield `done: false` with an undefined `value`; guard before reading byteLength
        if (value) {
            totalBytes += value.byteLength;

            if (totalBytes > MAX_BODY_BYTES) {
                // eslint-disable-next-line no-await-in-loop -- one-shot cleanup on the over-budget abort path before throwing
                await reader.cancel().catch(() => {});

                throw new CirrusError("Body too large", { code: "PAYLOAD_TOO_LARGE", status: 413 });
            }
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

    return { errors, globalLineMap, globalRows, perShard };
};

interface ImportTotals {
    conflicts: number;
    errors: ImportRowError[];
    inserted: Record<string, number>;
}

/**
 * Fold a per-plane insert result (`{ inserted, errors, conflicts }`) into the
 * running totals, mutating them in place. `totals` is an accumulator the caller
 * owns — by design it threads one mutable record through both storage planes.
 */
const mergeImportResult = (
    totals: ImportTotals,
    result: { conflicts: number; errors: ReadonlyArray<ImportRowError>; inserted: Record<string, number> },
): void => {
    for (const [table, count] of Object.entries(result.inserted)) {
        // eslint-disable-next-line no-param-reassign -- `totals` is the caller-owned accumulator threaded through both import planes
        totals.inserted[table] = (totals.inserted[table] ?? 0) + count;
    }

    for (const rowError of result.errors) {
        totals.errors.push({ ...rowError });
    }

    // eslint-disable-next-line no-param-reassign -- `totals` is the caller-owned accumulator threaded through both import planes
    totals.conflicts += result.conflicts;
};

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
    errors: ImportRowError[];
    inserted: Record<string, number>;
}> => {
    const defaultShard = options.defaultShardKey ?? "__root__";

    const { errors, globalLineMap, globalRows, perShard } = await bucketImportStream(request, options, defaultShard);

    const totals: ImportTotals = { conflicts: 0, errors, inserted: {} };

    // Fan shard-local batches out via the coordinator. The order of batches
    // is insertion order so error line numbers reflect the source NDJSON.
    if (perShard.size > 0) {
        const coordinator = options.queryCoordinator;

        if (!coordinator) {
            throw new CirrusError("Import endpoint requires a `queryCoordinator` on the worker", { code: "BAD_REQUEST", status: 400 });
        }

        const result = await coordinator.orchestrateImport(options.shardDO, {
            batches: [...perShard.values()],
            headers: forwardedHeaders,
        });

        mergeImportResult(totals, result);
    }

    // Run global imports through the user-supplied helper.
    if (globalRows.length > 0) {
        if (options.importGlobals) {
            const startLine = globalLineMap[0] ?? 1;
            const result = await options.importGlobals({ rows: globalRows, startLine });

            mergeImportResult(totals, result);
        } else {
            for (const [index, globalRow] of globalRows.entries()) {
                totals.errors.push({
                    code: "GLOBAL_NOT_CONFIGURED",
                    line: globalLineMap[index] ?? 1,
                    message: `row targets global table "${globalRow.table}" but no \`importGlobals\` is configured`,
                    table: globalRow.table,
                });
            }
        }
    }

    return { conflicts: totals.conflicts, errors: totals.errors, inserted: totals.inserted };
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
 * `secret`. Mirrors `@cirrus/scheduler`'s `signDispatch` and `@cirrus/storage`'s
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
 * instead (the dashboard sends it there as the client's `wsToken`). It ends up
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
 * Build a Cloudflare Worker entry. Returns an object with `fetch` so it can
 * be re-exported directly as `export default createWorker(...)`.
 */
const createWorker = (
    options: WorkerOptions,
): {
    fetch: (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response>;
    scheduled: (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike) => Promise<void>;
} => {
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
                `[cirrus] SECURITY: received ${kind} access but neither \`authorizeShard\` nor \`authorizeFanOut\` is configured — `,
                `any caller (including unauthenticated ones) can target any shard / fan out across the table. `,
                `Configure \`authorizeShard\`/\`authorizeFanOut\`, or set \`allowUnauthenticatedShardAccess: true\` to acknowledge this posture and silence this warning.`,
            ].join(""),
        );
    };

    const handleMigrate = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Migration endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!checkAdminAuth(request, options.adminToken)) {
            throw new CirrusError("Admin auth required", { code: "FORBIDDEN", status: 403 });
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

    /**
     * `POST /_cirrus/admin/pitr` — drive native Durable-Object point-in-time
     * recovery on a single shard. Admin-gated (its own bearer check), so it is
     * NOT subject to the user-facing `authorizeShard`/`authorizeFunction`
     * callbacks the public RPC path enforces; the forwarded `Authorization`
     * header then satisfies the shard's own admin gate in `handleAdminRpc`.
     * Forwards `getPitrBookmark` (read the current / for-a-time bookmark) or
     * `pitrRestore` (`{ time | bookmark, restart? }`) to the chosen shard.
     */
    const handlePitr = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("PITR endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!checkAdminAuth(request, options.adminToken)) {
            throw new CirrusError("admin PITR endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        const pitr = await parsePitrRequest(request);

        // Forward the inbound admin bearer so the shard's `handleAdminRpc` gate
        // accepts the `__cirrus_admin__:*` op.
        const { headers: forwardedHeaders } = await resolveForwardContext(request, env, options.resolveIdentity);

        const forwarded = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: pitr.args, functionPath: pitr.functionPath }),
            headers: forwardedHeaders,
            method: "POST",
        });

        return forwardToShard(options.shardDO, pitr.shardKey ?? defaultShard, forwarded);
    };

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
                throw new CirrusError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
            }
        }

        const forwarded = new Request("https://shard.internal/rpc", {
            // `x-cirrus-system` marks this as a trusted server-initiated dispatch
            // so the shard may run `internal` functions (scheduled/cron jobs are
            // typically internal). Authorization was already enforced above; this
            // header is set only here, never on the client RPC path.
            body: JSON.stringify({ args, functionPath }),
            headers: { "content-type": "application/json", "x-cirrus-system": "1" },
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
                    throw new CirrusError(`cron job "${job.name}" (${job.functionPath}) failed with shard status ${String(response.status)}`, {
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
     * in the `x-cirrus-scheduler-signature` header (secret in
     * `env.CIRRUS_SCHEDULER_SECRET`), or — when no HMAC secret is configured on
     * the scheduler — an `authorization: Bearer &lt;admin token>` fallback. An
     * unsigned/forged request is rejected with 403; we never run a job we can't
     * authenticate.
     *
     * On success the job is dispatched through the SAME shard-forward path as
     * `/_cirrus/rpc` (re-applying `authorizeShard` for the named shard so the
     * scheduler cannot bypass per-shard auth), and the shard's response is
     * propagated.
     */
    const handleSchedulerDispatch = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Scheduler dispatch endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        // Read the raw body verbatim (byte-budgeted) — the HMAC is computed over
        // these exact bytes, so we must verify before re-encoding/parsing.
        const rawBody = await readBodyTextWithLimit(request);

        const envRecord = (env ?? {}) as Record<string, unknown>;
        const schedulerSecret = typeof envRecord["CIRRUS_SCHEDULER_SECRET"] === "string" ? envRecord["CIRRUS_SCHEDULER_SECRET"] : undefined;
        const adminBearer = options.adminToken ?? (typeof envRecord["CIRRUS_ADMIN_TOKEN"] === "string" ? envRecord["CIRRUS_ADMIN_TOKEN"] : undefined);

        const signatureHeader = request.headers.get("x-cirrus-scheduler-signature");

        let authenticated = false;

        if (signatureHeader && schedulerSecret) {
            authenticated = await verifyHmacSignature(schedulerSecret, rawBody, signatureHeader);
        } else if (adminBearer) {
            // Fallback bearer path — the scheduler uses this only when no HMAC
            // secret is configured on its side.
            authenticated = checkAdminAuth(request, adminBearer);
        }

        if (!authenticated) {
            throw new CirrusError("Scheduler dispatch requires a valid signature or admin bearer", { code: "FORBIDDEN", status: 403 });
        }

        let body: unknown;

        try {
            body = JSON.parse(rawBody);
        } catch {
            throw new CirrusError("Scheduler dispatch body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
        }

        const candidate = (body ?? {}) as { args?: unknown; functionPath?: unknown; id?: unknown; instanceName?: unknown; pool?: unknown; shardKey?: unknown };

        if (typeof candidate.functionPath !== "string" || candidate.functionPath.length === 0) {
            throw new CirrusError("Scheduler dispatch is missing `functionPath`", { code: "BAD_REQUEST", status: 400 });
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

    type ExportRow = { doc: Record<string, unknown>; table: string };

    /**
     * Split a requested table list into shard-local vs `.global()` buckets.
     * `tables === undefined` (every table) yields two empty lists — the callers
     * treat that case specially.
     */
    const partitionExportTables = (tables: ReadonlyArray<string> | undefined): { globalTables: string[]; shardLocalTables: string[] } => {
        const shardLocalTables: string[] = [];
        const globalTables: string[] = [];

        if (tables && tables.length > 0) {
            for (const table of tables) {
                const info = options.resolveTableSharding?.(table);

                if (info?.mode.kind === "global") {
                    globalTables.push(table);
                } else {
                    shardLocalTables.push(table);
                }
            }
        }

        return { globalTables, shardLocalTables };
    };

    /**
     * Fan the shard-local export out via the coordinator and write each
     * successful shard's rows. A failed shard is skipped (its error was already
     * surfaced through the fan-out roll-up).
     */
    const exportShardLocalRows = async (
        coordinator: QueryCoordinator,
        forwardedHeaders: Record<string, string>,
        tables: ReadonlyArray<string> | undefined,
        shardLocalTables: ReadonlyArray<string>,
        writeRow: (row: ExportRow) => void,
    ): Promise<void> => {
        // Skip only when the caller named tables and none are shard-local. When
        // tables is undefined the per-shard exporter visits every shard-local table.
        if (tables !== undefined && shardLocalTables.length === 0) {
            return;
        }

        const exportTables = tables === undefined ? [] : shardLocalTables;
        // We still need a table list to seed the registry probe. Fall back to
        // `resolveTableSharding`'s keys if the caller passed none — best effort;
        // a project without the resolver will simply not fan out automatically.
        const probeFallback = tables === undefined ? collectKnownTables(options.resolveTableSharding) : [];
        const probeTables = exportTables.length > 0 ? exportTables : probeFallback;

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
    };

    /**
     * Produce export rows — shard-local first (from `orchestrateExport`'s
     * collected per-shard envelopes), then `.global()` rows (streamed from the
     * `exportGlobals` helper) — invoking `writeRow` for each. `tables ===
     * undefined` means "every table". Shared by the admin export endpoint (which
     * streams the rows back as NDJSON) and the scheduled R2 backup (which writes
     * them to the backup store).
     */
    const streamExportRows = async (
        coordinator: QueryCoordinator,
        forwardedHeaders: Record<string, string>,
        tables: ReadonlyArray<string> | undefined,
        writeRow: (row: ExportRow) => void,
    ): Promise<void> => {
        const { globalTables, shardLocalTables } = partitionExportTables(tables);

        await exportShardLocalRows(coordinator, forwardedHeaders, tables, shardLocalTables, writeRow);

        // Globals: stream rows from the D1 helper when configured.
        const exportGlobalsFunction = options.exportGlobals;
        const wantGlobals = tables === undefined || globalTables.length > 0;

        if (wantGlobals && exportGlobalsFunction) {
            const tablesArgument = tables === undefined ? [] : globalTables;

            for await (const row of exportGlobalsFunction({ tables: tablesArgument })) {
                writeRow(row);
            }
        }
    };

    const handleExport = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Export endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!checkAdminAuth(request, options.adminToken)) {
            throw new CirrusError("admin export endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        const coordinator = options.queryCoordinator;

        if (!coordinator) {
            throw new CirrusError("Export endpoint requires a `queryCoordinator` on the worker", { code: "BAD_REQUEST", status: 400 });
        }

        const body = await parseExportBody(request);

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env, options.resolveIdentity);

        // Stream NDJSON: shard-local rows first, then global rows. Caveat: each
        // shard returns a single materialised envelope, and the whole fan-out is
        // collected before the stream drains, so peak worker memory still scales
        // with the total shard-local row count — the streaming only keeps the
        // *response* from being buffered, it does not bound the source data.
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                const writeRow = (row: ExportRow): void => {
                    controller.enqueue(NDJSON_ENCODER.encode(`${JSON.stringify(row)}\n`));
                };

                try {
                    await streamExportRows(coordinator, forwardedHeaders, body.tables, writeRow);
                    controller.close();
                } catch (error: unknown) {
                    controller.error(error);
                }
            },
        });

        return new Response(stream, { headers: { "content-type": "application/x-ndjson" }, status: 200 });
    };

    /**
     * Streaming-export feed (Fivetran/Airbyte-style). The caller posts a
     * per-shard cursor map (`{ cursors: { shardKey: seq }, globalCursor }`) and
     * gets back each shard's change page plus its new cursor, and the global
     * (D1) page when `syncGlobals` is configured. Stateless: the consumer owns
     * the cursors and re-posts them to resume, so the worker holds no offsets.
     */
    const handleCdcSync = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Sync endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!checkAdminAuth(request, options.adminToken)) {
            throw new CirrusError("admin sync endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        const coordinator = options.queryCoordinator;

        if (!coordinator) {
            throw new CirrusError("Sync endpoint requires a `queryCoordinator` on the worker", { code: "BAD_REQUEST", status: 400 });
        }

        const raw = await readJsonBodyWithLimit(request);
        const cursors = typeof raw["cursors"] === "object" && raw["cursors"] !== null ? (raw["cursors"] as Record<string, number>) : {};
        const limit = typeof raw["limit"] === "number" ? raw["limit"] : undefined;
        const globalCursor = typeof raw["globalCursor"] === "number" ? raw["globalCursor"] : 0;
        const requestedTables = Array.isArray(raw["tables"]) ? raw["tables"].filter((table): table is string => typeof table === "string") : undefined;

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env, options.resolveIdentity);

        // Shard discovery mirrors export: explicit tables, else every known table.
        const probeTables = requestedTables ?? collectKnownTables(options.resolveTableSharding);

        const shardResult = await coordinator.orchestrateCdcSync(options.shardDO, {
            cursors,
            headers: forwardedHeaders,
            limit,
            tables: probeTables,
        });

        const global = options.syncGlobals ? await options.syncGlobals({ limit, sinceSeq: globalCursor }) : undefined;

        return Response.json({ global, shards: shardResult.shards }, { status: 200 });
    };

    /**
     * Turn-key incremental-sync source for warehouse connectors (Fivetran custom
     * functions, Airbyte incremental sources). Wraps the same CDC machinery as
     * {@link handleCdcSync} but exposes the standard connector contract:
     *
     * Request: `{ cursor?: string, limit?: number, tables?: string[] }` — `cursor`
     * is the opaque token from the previous page (omit / empty for a fresh sync).
     *
     * Response ({@link ConnectorSyncPage}): `{ changes, nextCursor, hasMore }`.
     * `changes` is a flat list of `{ table, op, doc }` rows across every shard and
     * the global plane, ordered shard-local first then global. `nextCursor` is the
     * opaque token to resume from; `hasMore` is `true` while any shard or the
     * global plane returned a full page (more changes likely remain) — page until
     * it is `false` (caught up). Stateless: the consumer owns the cursor.
     *
     * Incremental semantics are real CDC: the change feed records insert / update /
     * delete with a monotonic per-source `seq`, so deletes ARE captured (a delete
     * surfaces as `{ op: "delete", doc: { _id } }`). A consumer maps the response
     * onto Fivetran/Airbyte via `toFivetranResponse` / `toAirbyteMessages`.
     */
    const handleConnectorSync = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Connector sync endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!checkAdminAuth(request, options.adminToken)) {
            throw new CirrusError("admin connector sync endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        const coordinator = options.queryCoordinator;

        if (!coordinator) {
            throw new CirrusError("Connector sync endpoint requires a `queryCoordinator` on the worker", { code: "BAD_REQUEST", status: 400 });
        }

        const raw = await readJsonBodyWithLimit(request);
        const state = decodeConnectorCursor(raw["cursor"]);
        const limit = typeof raw["limit"] === "number" && raw["limit"] > 0 ? raw["limit"] : undefined;
        const requestedTables = Array.isArray(raw["tables"]) ? raw["tables"].filter((table): table is string => typeof table === "string") : undefined;

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env, options.resolveIdentity);

        // Shard discovery mirrors export/sync: explicit tables, else every known table.
        const probeTables = requestedTables ?? collectKnownTables(options.resolveTableSharding);

        const shardResult = await coordinator.orchestrateCdcSync(options.shardDO, {
            cursors: state.s,
            headers: forwardedHeaders,
            limit,
            tables: probeTables,
        });

        const changes: ConnectorChange[] = [];
        const nextShardCursors: Record<string, number> = { ...state.s };
        let hasMore = false;

        for (const shard of shardResult.shards) {
            // A full page signals more rows likely remain past this cursor.
            hasMore = foldCdcPage(changes, shard.changes ?? [], limit) || hasMore;
            nextShardCursors[shard.shardKey] = shard.cursor;
        }

        // Global (D1) plane: same CDC contract, paged from the global cursor.
        let nextGlobalCursor = state.g;

        if (options.syncGlobals) {
            const global = await options.syncGlobals({ limit, sinceSeq: state.g });

            hasMore = foldCdcPage(changes, global.changes, limit) || hasMore;
            nextGlobalCursor = global.cursor;
        }

        const nextCursor = encodeConnectorCursor({ g: nextGlobalCursor, s: nextShardCursors, v: 1 });
        const page: ConnectorSyncPage = { changes, hasMore, nextCursor };

        return Response.json(page, { status: 200 });
    };

    /**
     * Replay endpoint behind `cirrus backup restore --to &lt;time>`. Accepts
     * per-shard pre-bucketed batches (the shape `/sync` emits, so the caller
     * just forwards each shard's changes back to the same shard — no
     * re-bucketing, which also sidesteps deletes carrying no shard-key field)
     * plus optional `globalChanges`. Applies them via `applyCdcChanges` and
     * returns the counts.
     */
    const handleApplyCdc = async (request: Request, env: unknown): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Apply endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!checkAdminAuth(request, options.adminToken)) {
            throw new CirrusError("admin apply endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        const coordinator = options.queryCoordinator;

        if (!coordinator) {
            throw new CirrusError("Apply endpoint requires a `queryCoordinator` on the worker", { code: "BAD_REQUEST", status: 400 });
        }

        const raw = await readJsonBodyWithLimit(request);
        const rawBatches = Array.isArray(raw["batches"]) ? raw["batches"] : [];
        const batches = rawBatches
            .map((batch) => batch as { changes?: unknown; shardKey?: unknown })
            .filter(
                (batch): batch is { changes: ReadonlyArray<Record<string, unknown>>; shardKey: string } =>
                    typeof batch.shardKey === "string" && Array.isArray(batch.changes),
            );
        const globalChanges = Array.isArray(raw["globalChanges"]) ? (raw["globalChanges"] as ReadonlyArray<Record<string, unknown>>) : [];

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env, options.resolveIdentity);

        const shardResult = await coordinator.orchestrateApplyCdc(options.shardDO, { batches, headers: forwardedHeaders });

        const globalApplied = globalChanges.length > 0 && options.applyGlobals ? await options.applyGlobals({ changes: globalChanges }) : 0;

        return Response.json({ applied: shardResult.applied + globalApplied, failed: shardResult.failed, ok: shardResult.ok }, { status: 200 });
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
            throw new CirrusError("scheduled endpoints require a `schedulerDO` namespace on the worker", { code: "SCHEDULER_NOT_CONFIGURED", status: 400 });
        }

        return options.schedulerDO;
    };

    const resolveSchedulerStub = (request: Request): ResolvedShard => {
        assertAdminAuthorized(request);

        return resolveShard(requireSchedulerNamespace(), options.schedulerInstanceName ?? "default");
    };

    const handleScheduledList = async (request: Request): Promise<Response> => {
        if (request.method !== "GET") {
            throw new CirrusError("Scheduled-list endpoint requires GET", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const stub = resolveSchedulerStub(request);

        return stub.fetch(new Request("https://scheduler.internal/list", { method: "GET" }));
    };

    /**
     * Proxy a browser WebSocket upgrade to the SchedulerDO's `/ws` so the
     * dashboard can subscribe to the live job list. A browser `WebSocket` can't
     * set an `Authorization` header, so the admin token is also accepted via the
     * `?token=` query parameter — the only channel the constructor allows.
     */
    const handleScheduledWebSocket = (request: Request): Promise<Response> => {
        if (request.headers.get("Upgrade") !== "websocket") {
            throw new CirrusError("WebSocket upgrade header missing", { code: "BAD_REQUEST", status: 426 });
        }

        if (!checkAdminAuth(request, options.adminToken) && !checkAdminWsToken(request, options.adminToken)) {
            throw new CirrusError("admin authorization required", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        const namespace = requireSchedulerNamespace();
        const stub = resolveShard(namespace, options.schedulerInstanceName ?? "default");

        return stub.fetch(new Request("https://scheduler.internal/ws", { headers: { Upgrade: "websocket" } }));
    };

    const handleScheduledCancel = async (request: Request): Promise<Response> => {
        if (request.method !== "POST") {
            throw new CirrusError("Scheduled-cancel endpoint requires POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        const stub = resolveSchedulerStub(request);
        const body = (await request.json().catch(() => undefined)) as { id?: unknown } | undefined;

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
        const result = await storageList(queryParameter(url, "prefix"), {
            cursor: queryParameter(url, "cursor"),
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
            .map(([path, entry]) => {
                return { args: describeArguments(entry.args), kind: entry.kind, path };
            })
            .toSorted((a, b) => a.path.localeCompare(b.path));

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

        const table = queryParameter(new URL(request.url), "table");

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

        const userId = queryParameter(new URL(request.url), "userId");
        const page = await introspector.listSessions({ ...parsePaging(request), userId });

        return Response.json(page, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const buildHttpActionContext = async (request: Request, env: unknown): Promise<HttpActionContext> => {
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
            const payload: { error?: { code?: string; message?: string }; result?: unknown } = await response.json();

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

        return options.httpRouter.fetch(request, { ...(env as object), __cirrusCtx: httpContext }, context);
    };

    const handleWebSocketUpgrade = async (request: Request, env: unknown, url: URL): Promise<Response> => {
        if (request.headers.get("Upgrade") !== "websocket") {
            throw new CirrusError("WebSocket upgrade header missing", { code: "BAD_REQUEST", status: 426 });
        }

        const shardKey = url.searchParams.get("shard") ?? defaultShard;

        // Resolve the calling identity (if any) and run the per-shard
        // authorization callback before forwarding. The WS path doesn't
        // need the rest of the forward context — only the identity for
        // the authorization decision.
        if (options.authorizeShard) {
            // eslint-disable-next-line unicorn/no-null -- the public authorizeShard callback's anonymous-identity sentinel is `null`
            const identity = options.resolveIdentity ? ((await options.resolveIdentity(request, env)) ?? null) : null;
            const allowed = await options.authorizeShard(identity, shardKey);

            if (!allowed) {
                throw new CirrusError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
            }
        } else if (shardKey !== defaultShard) {
            warnUnauthenticatedShardAccessOnce("shard");
        }

        return forwardToShard(options.shardDO, shardKey, request);
    };

    /**
     * Run the per-shard / fan-out authorization gate for an RPC envelope. Throws
     * a 403 `CirrusError` when the caller is not authorized. Fan-out is a
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
                    throw new CirrusError("Forbidden fan-out", { code: "FORBIDDEN_FANOUT", status: 403 });
                }
            } else if (options.authorizeShard) {
                // `authorizeShard` is configured but `authorizeFanOut`
                // is not. Fan-out is a privileged op (it bypasses the
                // per-shard gate by design), so default-deny instead
                // of silently letting any authenticated caller
                // enumerate every shard for the table.
                throw new CirrusError("Fan-out requires `authorizeFanOut` to be configured on the worker when `authorizeShard` is set", {
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
                throw new CirrusError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
            }
        } else if (envelope.shardKey !== undefined && envelope.shardKey !== defaultShard) {
            // No per-shard gate and the caller named a non-default shard.
            warnUnauthenticatedShardAccessOnce("shard");
        }
    };

    const handleRpc = async (request: Request, env: unknown): Promise<Response> => {
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
                    throw new CirrusError("RPC envelope set `fanOut` but no `queryCoordinator` is configured on the worker", {
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
                emitRpcEvent(observability, buildErrorEvent(envelope.functionPath, Date.now() - rpcStartedAt, error, { shardKey }));
                throw error;
            }
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
            throw new CirrusError("scheduled backup requires a `backupStore` on the worker", { code: "BACKUP_NOT_CONFIGURED", status: 500 });
        }

        if (!coordinator) {
            throw new CirrusError("scheduled backup requires a `queryCoordinator` on the worker", { code: "BACKUP_NOT_CONFIGURED", status: 500 });
        }

        if (!options.adminToken || options.adminToken.length === 0) {
            throw new CirrusError("scheduled backup requires an `adminToken` to authenticate the per-shard export gate", {
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
                    await streamExportRows(coordinator, forwardedHeaders, tables, writeRow);
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
        const fileKey = `${prefix}cirrus-backup-${timestamp.replaceAll(/[.:]/gu, "-")}.ndjson`;
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
    const internalRoutes: Record<string, InternalRoute> = {
        [WS_PATH]: (request, env, url) => handleWebSocketUpgrade(request, env, url),
        [RPC_PATH]: (request, env) => handleRpc(request, env),
        [SCHEDULER_DISPATCH_PATH]: (request, env) => handleSchedulerDispatch(request, env),
        [MIGRATE_PATH]: (request, env) => handleMigrate(request, env),
        [PITR_PATH]: (request, env) => handlePitr(request, env),
        [EXPORT_PATH]: (request, env) => handleExport(request, env),
        [IMPORT_PATH]: (request, env) => handleImport(request, env),
        [SYNC_PATH]: (request, env) => handleCdcSync(request, env),
        [CONNECTOR_SYNC_PATH]: (request, env) => handleConnectorSync(request, env),
        [APPLY_PATH]: (request, env) => handleApplyCdc(request, env),
        [SCHEDULED_WS_PATH]: (request) => handleScheduledWebSocket(request),
        [SCHEDULED_CANCEL_PATH]: (request) => handleScheduledCancel(request),
        [SCHEDULED_PATH]: (request) => handleScheduledList(request),
        [STORAGE_PATH]: (request) => handleStorageList(request),
        [FUNCTIONS_PATH]: (request) => handleFunctionsList(request),
        [GLOBAL_TABLES_PATH]: (request) => handleGlobalTables(request),
        [GLOBAL_TABLE_PATH]: (request) => handleGlobalTablePage(request),
        [AUTH_USERS_PATH]: (request) => handleAuthUsers(request),
        [AUTH_SESSIONS_PATH]: (request) => handleAuthSessions(request),
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
                throw new CirrusError("Body too large", { code: "PAYLOAD_TOO_LARGE", status: 413 });
            }
        }

        // Auth providers register routes as `"METHOD path"` (e.g. `"GET /auth/signin"`).
        // We also accept legacy pathname-only keys for ad-hoc handlers.
        const methodAndPath = `${request.method} ${url.pathname}`;
        const route = options.routes?.[methodAndPath] ?? options.routes?.[url.pathname];

        if (route) {
            return route(request, env, context);
        }

        // Internal `/_cirrus/*` endpoints, keyed by pathname. Each entry adapts
        // to the shared `(request, env, url) => Promise<Response>` shape so the
        // dispatch stays a single table lookup rather than a long if-chain.
        const internalRoute = internalRoutes[url.pathname];

        if (internalRoute) {
            return internalRoute(request, env, url);
        }

        // HTTP actions are the lowest-priority matcher: explicit routes and the
        // internal `/_cirrus/*` endpoints above always win. Once the request
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
    };
};

/** Re-exported helper so callers can roundtrip envelopes in tests. */
const defineRpcEnvelope = (envelope: RpcEnvelope): RpcEnvelope => envelope;

export { createWorker, defineRpcEnvelope };
export type {
    AdminTableResolver,
    AuthIntrospector,
    AuthPage,
    AuthSession,
    AuthTimestamp,
    AuthUser,
    BackupManifest,
    BackupStore,
    CronHandler,
    CronJobDispatch,
    ExecutionContextLike,
    FunctionDescriptor,
    FunctionRegistryEntry,
    FunctionRegistryLike,
    GlobalExportFunction as GlobalExportFn,
    GlobalImportFunction as GlobalImportFn,
    GlobalIntrospector,
    GlobalTableInfo,
    GlobalTablePage,
    HttpActionContext,
    HttpActionLike,
    HttpRouterLike,
    ResolvedIdentity,
    Route,
    RpcContext,
    RpcEnvelope,
    ScheduledControllerLike,
    ShardingInfo,
    StorageListFunction as StorageListFn,
    StorageObject,
    WorkerOptions,
};
