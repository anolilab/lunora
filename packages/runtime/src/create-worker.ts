import { isLunoraError, toErrorBody } from "@lunora/errors";
import type { HttpCacheLike } from "@lunora/platform";

import { asBucketStorage } from "../../../shared/as-bucket-storage";
import type { BatchEntry } from "../../../shared/batch-wire";
import { BRANCH_MARKER_REJECTION, hasBranchMarker } from "../../../shared/branch-marker";
import { collectPages } from "../../../shared/collect-pages";
import { constantTimeEqual } from "../../../shared/constant-time-equal";
import { isDuplicateInstanceError } from "../../../shared/duplicate-instance";
import { evictOldestEntry } from "../../../shared/evict-oldest";
import type { ExecutionContextLike } from "../../../shared/execution-context";
import { NOOP_EXECUTION_CONTEXT } from "../../../shared/execution-context";
import { signCanonical } from "../../../shared/hmac-url";
import { encodeIdentityHeader, encodeUserIdHeader } from "../../../shared/identity-header";
import { buildTraceparent, otlpRandomHex } from "../../../shared/otlp";
import type { RegionHint } from "../../../shared/region-hint";
import { regionHintFromRequest } from "../../../shared/region-hint";
import { RELAY_NAME_INFIX, relayName } from "../../../shared/relay-name";
import { parseMinSeq, REPLICA_NAME_INFIX, replicaName } from "../../../shared/replica-name";
import type { RestExposure } from "../../../shared/rest-surface";
import type { TraceSamplingConfig } from "../../../shared/sampling";
import { decodeWire, encodeArgsOrThrow, encodeWire } from "../../../shared/wire-codec";
import { isEnvFlagEnabled, mintWsAdminToken, verifyWsAdminToken } from "../../../shared/ws-admin-token";
import { assertArgsObject } from "./assert-args-object";
import type { AuthAdmin } from "./auth-admin-routes";
import { buildAuthAdminRoutes } from "./auth-admin-routes";
import type { AuthAuditReader } from "./auth-audit-rpc";
import { buildGetAuthAuditLog, GET_AUTH_AUDIT_LOG_OP } from "./auth-audit-rpc";
import { buildBackupAdminRoutes } from "./backup-admin-routes";
import { groupBatchCallsByShard } from "./batch";
import { MAX_BODY_BYTES, readBodyBytesWithLimit, readBodyTextWithLimit, readJsonBodyWithLimit } from "./body-readers";
import { buildDataMovementAdminRoutes } from "./data-movement-admin-routes";
import type { FunctionArgumentDescriptor } from "./describe-args";
import { LunoraError, toErrorResponse } from "./errors";
import { streamExportRows } from "./export-stream";
import type { ExportCursorStore, ExportSink } from "./export-tap";
import type { HealthProbe } from "./health-routes";
import { buildHealthRoutes, d1Probe, durableObjectProbe, presenceProbe } from "./health-routes";
import type { IdentityContractLike, ResolvedIdentity } from "./identity-resolvers";
import { wrapResolverWithContract } from "./identity-resolvers";
import { streamingImport } from "./import-stream";
import { buildIntrospectionAdminRoutes } from "./introspection-admin-routes";
import type { KvIntrospector } from "./kv-admin-routes";
import { buildKvAdminRoutes, KV_VALUE_MAX_BODY_BYTES, KV_VALUE_PATH } from "./kv-admin-routes";
import type { LogArchiveConfig } from "./log-archive-admin-routes";
import { buildLogArchiveAdminRoutes } from "./log-archive-admin-routes";
import { assertMethod } from "./method-guard";
import type { ObservabilityEvent, ObservabilitySink, ObservabilitySinkContext } from "./observability";
import { emitRpcEvent, flushSink } from "./observability";
import { buildOrchestrationAdminRoutes } from "./orchestration-admin-routes";
import type { DispatchTraceContext } from "./otel-trace";
import { beginDispatchTrace, injectTraceContext } from "./otel-trace";
import type { FanOutSpec, QueryCoordinator } from "./query-coordinator";
import type { DurableObjectJurisdiction, ResolvedShard, ShardNamespaceLike } from "./resolve-shard";
import { applyJurisdiction, resolveShard } from "./resolve-shard";
import { createResourceAttributeResolver } from "./resource-detect";
import type { RestInvoke, RestRateLimit } from "./rest-routes";
import { buildRestRoutes } from "./rest-routes";
import { buildScheduledAdminRoutes } from "./scheduled-admin-routes";
import { runScheduledBackup } from "./scheduled-backup";
import type { SecurityOptions } from "./security-headers";
import { decorateResponse, enforceOrigin, enforceWebSocketOrigin, handleCorsPreflight, resolveSecurity } from "./security-headers";
import { buildStorageAdminRoutes, STORAGE_PATH, STORAGE_UPLOAD_MAX_BODY_BYTES } from "./storage-admin-routes";
import type { TrustInboundTraceContext } from "./trace-trust";
import { createDroppedTraceNotice, resolveTraceTrust } from "./trace-trust";
import { buildVectorAdminRoutes } from "./vector-admin-routes";
import type { WorkflowsRestClient } from "./workflows-admin-routes";
import { buildWorkflowsAdminRoutes } from "./workflows-admin-routes";

/**
 * Wire-format RPC envelope. Posted to `POST /_lunora/rpc`.
 *
 * `functionPath` is the `<file>:<function>` identifier emitted by codegen,
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

type Route = (request: Request, env: unknown, context: ExecutionContextLike) => Promise<Response> | Response;

/**
 * Routes whose reader declares a body budget above the shared {@link MAX_BODY_BYTES}
 * JSON cap. The entry-point `Content-Length` fast-reject reads this table so the
 * header check agrees with the reader that actually enforces the limit.
 */
const ROUTE_BODY_BUDGETS: Record<string, number> = {
    [KV_VALUE_PATH]: KV_VALUE_MAX_BODY_BYTES,
    [STORAGE_PATH]: STORAGE_UPLOAD_MAX_BODY_BYTES,
};

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
    cache?: { purge: (options: { purgeEverything?: boolean; tags?: string[] }) => Promise<unknown> };
    fetch: typeof globalThis.fetch;

    /**
     * The same `run*` trio bound to a named shard, mirroring
     * `createShardClient(...).forShard(key)`.
     *
     * An HTTP action runs in the WORKER, not inside a shard, so — unlike a
     * query/mutation ctx, whose `run*` is already inside the owning DO — it has
     * to be told which shard to talk to. `ctx.run*` alone targets the default
     * shard, which on a `.shardBy(...)` app is the root DO: a webhook that read
     * `ctx.runQuery(api.messages.list, { channelId })` got the root shard's rows
     * (usually none) with no error and no way to say otherwise.
     */
    forShard: (shardKey: string) => Pick<HttpActionContext, "runAction" | "runMutation" | "runQuery">;
    runAction: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runMutation: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;
    runQuery: <R>(reference: unknown, args?: Record<string, unknown>) => Promise<R>;

    /**
     * Deferred dispatch, present only when the worker declares a `schedulerDO`.
     *
     * "Receive webhook → enqueue the real work → return 200 immediately" is the
     * most common HTTP-action shape there is, and without this every app
     * hand-rolled a hop through a mutation. That hop is not a one-liner: a
     * function reference cannot cross the RPC boundary, so targets had to be
     * named by string and resolved shard-side — and on an endpoint reachable
     * unauthenticated (a platform-signed webhook) a free-form target string is a
     * "call any internal function" primitive, forcing a closed allow-list that
     * needs an entry per target.
     *
     * Talking to the scheduler DO directly avoids all of it. This is no more
     * privileged than the `run*` members beside it: the reference is a literal
     * from the app's own source, never caller-supplied.
     */
    scheduler?: SchedulerContext;

    /**
     * Object storage, present only when the app declared a `.storage(...)`.
     *
     * R2 is a worker binding, so an HTTP handler reaches it in the same place an
     * action does — the previous omission was incidental rather than principled.
     * (`db` stays absent, which is not the same category: an HTTP handler is not
     * transactional.)
     *
     * Typed `unknown` so the runtime stays free of a `@lunora/storage`
     * dependency; the server side narrows it to the real `Storage`.
     */
    storage?: unknown;

    /**
     * The request's `ExecutionContext.waitUntil`, forwarded so a handler can
     * keep work alive past the returned `Response` — the shape an HTTP action
     * exists for ("ack the webhook now, finish the work after"). Optional
     * because {@link ExecutionContextLike.waitUntil} is: a framework mount seam
     * or a unit test may hand over a partial context, and this is absent rather
     * than a throwing stub so a caller can tell "no deferral available here"
     * from "deferred". Mirrors `HttpActionCtx.waitUntil` on the server side.
     */
    waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The scheduler surface on an HTTP action context. Mirrors `@lunora/server`'s
 * `Scheduler` so `HttpActionCtx` can `Pick` it straight off `ActionContext`;
 * kept structural here so the runtime stays free of a `@lunora/scheduler`
 * dependency.
 */
interface SchedulerContext {
    cancel: (id: string) => Promise<{ cancelled: boolean }>;
    get: (id: string) => Promise<Record<string, unknown> | null>;
    list: () => Promise<Record<string, unknown>[]>;
    runAfter: (delayMs: number, target: unknown, args?: Record<string, unknown>) => Promise<string>;
    runAt: (timestampMs: number, target: unknown, args?: Record<string, unknown>) => Promise<string>;
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

/**
 * Bulk import of `.global()` rows. Returns insert counts + errors merged across
 * tables.
 *
 * Each row carries its true physical source `line` so error attribution stays
 * accurate even when global rows are interspersed with shard rows or blank lines
 * in the NDJSON (a single `startLine` can't describe non-contiguous rows). The
 * `startLine` field is the line of the FIRST global row, retained only as a
 * backward-compatible fallback for importers that haven't adopted per-row lines.
 */
type GlobalImportFunction = (request: { rows: ReadonlyArray<{ doc: Record<string, unknown>; line: number; table: string }>; startLine?: number }) => Promise<{
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

    /**
     * Lowercase-hex SHA-256, when the object was written with one. R2 reports a
     * checksum only if the writer supplied it, so this is absent for objects
     * uploaded before that was wired up — consumers must treat "absent" as "not
     * reported", never as "does not match".
     */
    sha256?: string;
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
    /** The `<file>:<function>` identifier, e.g. `messages:list`. */
    path: string;
    /** `"internal"` functions are never exposed by the discovery endpoint; absence === public. */
    visibility?: "internal" | "public";
}

/** One value in {@link FunctionRegistryLike} — the bits of a registered function the discovery endpoint reads. */
interface FunctionRegistryEntry {
    /** The function's `v.*` args validator map; read structurally for the signature view. */
    args?: unknown;

    /**
     * Opt-in public-surface tag set by the `.expose({ rest: true })` builder
     * modifier (plan 167). Present only on procedures deliberately published over
     * REST; the runtime builds a `/_lunora/rest/<namespace>/<fn>` route for each,
     * routing THROUGH the procedure so auth/RLS/validators are enforced. Rides
     * along on the registered function's identity (like `fn.x402` / `fn.rls`), so
     * reading it needs no change to the generated registry shape.
     *
     * `cache` is the optional response-caching policy the REST router turns into
     * `Cache-Control` / `Cache-Tag` / `Vary` headers (see `rest-cache`).
     */
    expose?: RestExposure;

    /**
     * The generated registry carries `"stream"` alongside query/mutation/action;
     * the discovery endpoint surfaces the latter three only (a `stream` function
     * isn't runnable from the function runner), but accepting the kind here lets
     * callers pass the generated `LUNORA_FUNCTIONS` map without a cast.
     */
    kind: "action" | "mutation" | "query" | "stream";
    visibility?: "internal" | "public";

    /**
     * x402 payment tag set by the `.x402({ price })` builder modifier. Present
     * only on paid public procedures; the origin worker answers an unpaid RPC
     * for such a function with a real `402` challenge (via the injected
     * {@link WorkerOptions.x402Charge} gate) before dispatching, then verifies +
     * settles at the origin boundary so the shard never sees payment state.
     * Rides along on the registered function object's identity — codegen casts
     * the real `fn` into `LUNORA_FUNCTIONS`, so reading it needs no change to the
     * generated shape (same as `fn.rls`).
     */
    x402?: { readonly price: number | string };
}

/**
 * The generated `LUNORA_FUNCTIONS` dispatch table, narrowed to what the
 * discovery endpoint reads. Pass the map straight from `_generated/functions.ts`.
 */
type FunctionRegistryLike = Record<string, FunctionRegistryEntry>;

/**
 * Injected x402 charge gate — the seam that paywalls a `.x402({ price })`-tagged
 * procedure at the origin worker without the runtime importing `@lunora/x402`
 * (which would pull viem/solana into every worker bundle). Build it with
 * `createProcedureChargeGate(config)` from `@lunora/x402/charge` and pass it as
 * {@link WorkerOptions.x402Charge}.
 *
 * Given the inbound `request`, the paid procedure's `spec` (its `functionPath` —
 * used as the x402 challenge `resource` — and USD `price`), and a `dispatch`
 * that runs the real shard forward, it returns a real `402` + `PAYMENT-REQUIRED`
 * challenge when the request is unpaid, or the dispatched response (with
 * `X-PAYMENT-RESPONSE` attached) once the client's `X-PAYMENT` is verified and
 * settled. `dispatch` runs only after payment is verified — an unpaid or
 * invalid request never reaches the shard.
 */
type X402ChargeGate = (
    request: Request,
    spec: { functionPath: string; price: number | string },
    dispatch: () => Promise<Response>,
    // Mirrors `@lunora/x402`'s `ChargeHandlerDeps` structurally — the runtime
    // deliberately doesn't import `@lunora/x402` (the gate is injected). The
    // request's `ctx.waitUntil`, forwarded so the settlement-receipt sink
    // survives past the response instead of being cancelled when the request ends.
    deps?: { waitUntil?: (promise: Promise<unknown>) => void },
) => Promise<Response>;

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
    options?: { bucket?: string; contentType?: string; sha256?: string },
) => Promise<{ etag?: string; key: string }> | { etag?: string; key: string };

/**
 * Reads one object's bytes back out of a storage bucket. Structurally the part
 * of `@lunora/storage`'s `Storage["download"]` the admin endpoint needs — the
 * body stream plus enough metadata to set the response headers. `null` means
 * "no such object", which the route turns into a 404.
 *
 * This is the read half of {@link StorageUploadFunction}: `lunora backup
 * restore --bucket` pulls a snapshot back through it under the same admin
 * bearer that wrote it, so restoring from a bucket does not depend on signed
 * URLs (which need a signing secret the deployment may not have configured).
 */
type StorageDownloadFunction = (
    key: string,
    options?: { bucket?: string },
) => Promise<{ body: ReadableStream | null; httpMetadata?: { contentType?: string }; size?: number } | null>;

/**
 * Mints a (signed or public) URL for one object so the admin file browser can
 * offer a "copy URL" action. The optional `expiresInSeconds` lets the caller pick
 * a share-link lifetime (the host clamps it); `bucket` selects a named bucket.
 * `method` and `contentType` are forwarded to the underlying signer and let the
 * caller mint a presigned PUT URL for large-blob uploads that bypass the
 * worker's body-size cap (the importer uses this for Convex storage blobs
 * above the 1 MiB limit).
 * Structurally compatible with `@lunora/storage`'s `Storage["getSignedUrl"]`.
 */
type StorageSignedUrlFunction = (
    key: string,
    options?: { bucket?: string; contentType?: string; expiresInSeconds?: number; method?: "GET" | "PUT" },
) => Promise<string> | string;

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
 * The trigger's own trace, handed to a consumer so every function it dispatches
 * is a child of the trigger span instead of an unrelated root trace.
 */
interface TriggerTrace {
    /** W3C `traceparent` naming the trigger's SERVER span. */
    traceparent: string;
}

/**
 * A Cloudflare Queues push-consumer handler — the worker's `queue()` entry
 * forwards each delivered `MessageBatch` (typed `unknown` here to keep the
 * runtime decoupled from `@lunora/queue`'s structural batch type) along with the
 * invocation's own {@link TriggerTrace}.
 */
type QueueConsumerHandler = (batch: unknown, env: unknown, context: ExecutionContextLike, trigger: TriggerTrace) => Promise<void>;

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
    functionPath?: string;
    name: string;
    shardKey?: string;

    /**
     * Set when the job targets a durable workflow instead of a function: the
     * `WORKFLOW_*` binding name on `env`. On a firing trigger the worker starts a
     * NEW workflow instance (the {@link CronJobDispatch.args} become its
     * `params`) rather than dispatching {@link CronJobDispatch.functionPath} to a
     * shard. Mutually exclusive with `functionPath`.
     */
    workflow?: string;
}

/**
 * Structural view of a Cloudflare `Workflow` binding — just the `create` the
 * cron dispatcher needs to start an instance. Kept structural so the runtime
 * stays free of a hard dependency on `@lunora/workflow` / workers-types.
 */
interface WorkflowBindingLike {
    create: (options?: { id?: string; params?: Record<string, unknown> }) => Promise<unknown>;
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
    functionPath?: string;
    name: string;
    shardKey?: string;
    /** The `WORKFLOW_*` binding name when the job starts a durable workflow instead of a function. */
    workflow?: string;
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

    /**
     * List objects under a prefix. `include: ["customMetadata"]` is how
     * retention tells its own snapshots from an operator's without a request
     * per object — R2 returns custom metadata on a listing only when asked, and
     * may return fewer than `limit` results when it is, which the cursor loop
     * already handles.
     */
    list: (options?: { cursor?: string; include?: ("customMetadata" | "httpMetadata")[]; limit?: number; prefix?: string }) => Promise<{
        cursor?: string;
        objects: ReadonlyArray<{ customMetadata?: Record<string, string>; key: string }>;
        truncated?: boolean;
    }>;
    put: (
        key: string,
        body: ArrayBuffer | ArrayBufferView | Blob | null | ReadableStream | string,
        // `sha256` (hex or bytes) is what makes R2 record a checksum for the
        // object; without it `list()`/`head()` report none and every later
        // integrity check degrades to comparing sizes. `customMetadata` carries
        // the marker retention prunes on.
        options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string }; sha256?: ArrayBuffer | string },
    ) => Promise<unknown>;
}

/**
 * Health / readiness probe configuration (plan 177). Everything is optional; the
 * runtime always registers its default binding probes, so the endpoints work
 * with `health: {}` (or the field omitted). Nothing here is a secret — `appName`
 * / `appVersion` are the only strings echoed in the body, and per-check messages
 * are surfaced only under the `"admin"` posture.
 */
interface HealthOptions {
    /** Application name surfaced in the health body. Defaults to `"lunora"`. */
    appName?: string;
    /** Application version surfaced in the health body. Defaults to `"0.0.0"`. */
    appVersion?: string;

    /**
     * Auth posture. `"public"` (default) serves the probe unauthenticated with
     * per-check messages redacted; `"admin"` requires a valid admin bearer and
     * includes the (runtime-authored) messages.
     */
    auth?: "admin" | "public";
    /** Cache the computed report for this many ms so a frequent poller (or an unauthenticated flood) does not re-run every probe. Defaults to `5000` for the public posture and `0` (no cache) for the bearer-gated admin posture. */
    cacheTtlMs?: number;
    /** Skip the auto-registered D1 / R2 / queue / Hyperdrive binding probes (keep only the DO probe + `probes`). Defaults to `false`. */
    disableBindingProbes?: boolean;
    /** Extra bespoke probes appended to the auto-registered set (e.g. a downstream API reachability check). */
    probes?: ReadonlyArray<HealthProbe>;
}

/**
 * One registered device subscription as surfaced by the gated
 * `__lunora_admin__:listPushSubscriptions` admin RPC (backing the Studio
 * Notifications page). Structurally mirrors `@lunora/notify`'s
 * `PushSubscriptionDevice` — the runtime carries NO `@lunora/notify` dependency,
 * so the shape is declared here and matched by duck typing (the studio reuses the
 * canonical `@lunora/notify` type). Delivery secrets (Web Push `keys`, FCM
 * `token`) are never part of this shape.
 */
interface NotifySubscriptionDevice {
    /** Unix-ms creation time. */
    createdAt: number;
    /** Web Push service endpoint URL (web-push only). */
    endpoint?: string;
    /** Stable identifier used as the store key. */
    id: string;
    /** The delivery channel this subscription targets (`"web-push"` / `"fcm"`). */
    kind: string;
    /** Last delivery error message, when `lastStatus` is `failed`/`expired`. */
    lastError?: string;
    /** Unix-ms time of the most recent register/send touch. */
    lastSeenAt: number;
    /** Last-known delivery outcome (`"ok"` / `"failed"` / `"expired"`). */
    lastStatus?: string;
    /** Arbitrary app metadata (device name, locale, topics, …). */
    metadata?: Record<string, unknown>;
    /** Owning user id, or `null`/absent when anonymous. */
    userId?: null | string;
}

/**
 * The minimal read surface the worker needs off an `@lunora/notify` subscription
 * store to serve `__lunora_admin__:listPushSubscriptions`: just `list`. Codegen
 * binds this from the app's `defineNotify({ store })` (`store(env)`), so the
 * worker reads registered devices through the very store the handlers write to.
 * Structural (not a `@lunora/notify` import) to keep the runtime dependency-free.
 */
interface NotifySubscriptionStoreLike {
    /**
     * List stored subscriptions, optionally narrowed by `filter`. The parameter
     * type EXACTLY MIRRORS `@lunora/notify`'s `SubscriptionFilter` (the runtime
     * carries no `@lunora/notify` dependency, so it is re-declared structurally):
     * an identical shape keeps a concrete `SubscriptionStore` assignable here under
     * `strictFunctionTypes` (contravariant parameter), while letting the RPC push
     * `{ kind, userId, limit }` DOWN to the store so a large device table is
     * filtered + bounded server-side (indexed in the D1 store) instead of
     * list-all-then-filter-in-memory. `filter` is optional, so an existing caller
     * that lists everything is unaffected.
     */
    list: (filter?: NotifySubscriptionFilter) => Promise<ReadonlyArray<NotifySubscriptionDevice & { keys?: unknown; token?: unknown }>>;
}

/**
 * Structural mirror of `@lunora/notify`'s `SubscriptionFilter` — kept byte-for-byte
 * compatible (same optional fields, same `kind` union) so threading it through
 * {@link NotifySubscriptionStoreLike} does NOT change that cross-package contract's
 * assignability. See the note on {@link NotifySubscriptionStoreLike.list}.
 */
interface NotifySubscriptionFilter {
    /** Restrict to a delivery kind. */
    kind?: "fcm" | "web-push";
    /** Cap the number of rows returned (a server-side `LIMIT`). */
    limit?: number;
    /** Restrict to a single owning user. */
    userId?: null | string;
}

/**
 * The caller a {@link WorkerOptions.authorizeShard} decision is made for.
 *
 * Every value that reaches this gate originates OUTSIDE the trust boundary — an
 * RPC, a REST call, a WebSocket upgrade, an in-process `serverQuery`. Dispatch
 * that originates INSIDE it (a firing cron, a scheduler job) never reaches the
 * gate at all, so `identity: null` means exactly one thing here: an
 * unauthenticated end user.
 */
interface ShardCaller {
    /** The identity `resolveIdentity` produced for this request, or `null` when the caller is unauthenticated. */
    identity: ResolvedIdentity | null;
    /** The shard the caller named (the default shard when the request named none). */
    shardKey: string;
}

interface WorkerOptions {
    /**
     * An additional, async authorization gate for the `/_lunora/admin/*` plane
     * (the Studio's HTTP + WS endpoints), OR-ed with the static {@link WorkerOptions.adminToken}
     * bearer. When it resolves `true` for a request, that request is treated as
     * admin-authorized even without the bearer; when it resolves `false` (or is
     * unset) the bearer remains the only path. Evaluated once per admin request
     * and never on the RPC/WebSocket data hot path.
     *
     * The intended producer is `@lunora/cloudflare-access`'s `accessAdminGate(...)`,
     * which verifies the request's `Cf-Access-Jwt-Assertion` JWT and applies an
     * `isAdmin(claims)` predicate — so the Studio can sit behind Cloudflare Access
     * instead of (or alongside) a shared admin token. It needs no `env` binding
     * (verification is static team-domain/aud config + the remote JWKS), so it
     * composes without threading async through every admin route.
     *
     * The second argument is the request's `ExecutionContext`, carrying
     * `context.access` when the Access policy is attached to the Worker rather
     * than to a hostname. It is `undefined` when the host supplied no context.
     */
    adminGate?: (request: Request, context?: ExecutionContextLike) => boolean | Promise<boolean>;

    /**
     * Admin bearer token expected by the export/import endpoints. When unset,
     * the endpoints respond with `ADMIN_FORBIDDEN` — the same posture the
     * per-shard admin gate uses.
     */
    adminToken?: string;

    /**
     * Opt into an authorization-open posture for sharded and fan-out access.
     *
     * By default (this flag unset/`false`) the runtime FAILS CLOSED per
     * operation: naming a non-default shard (a potential cross-tenant hop) is
     * rejected with a `403` (`FORBIDDEN_SHARD`) unless
     * {@link WorkerOptions.authorizeShard} is configured, and a fan-out
     * envelope is rejected (`FORBIDDEN_FANOUT`) unless
     * {@link WorkerOptions.authorizeFanOut} is. Set this to `true` to allow
     * such requests from any caller (including unauthenticated ones) —
     * appropriate only when every table is protected by per-row RLS. The
     * runtime then emits a single `console.warn` so the open posture stays
     * visible in logs. The flag is consulted per operation: it has no effect
     * on an operation whose own `authorize*` callback is configured (that
     * callback gates directly), but configuring only one of the two callbacks
     * does NOT cover the other operation.
     *
     * NOTE: this is a behaviour change from earlier alphas, where the same
     * situation was warn-once-then-allow. Apps that relied on client-chosen
     * shard keys without an `authorize*` callback must set this flag explicitly.
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
     * The auth/security audit read plane backing the studio's "Security / audit"
     * page (the `__lunora_admin__:getAuthAuditLog` admin RPC). The audit trail
     * lives in the auth D1 database (via `@lunora/auth`'s `SqlExecutor`), not in a
     * shard's DO SQLite, so — unlike the other `__lunora_admin__:*` ops — the RPC
     * is served here at the worker, admin-gated, through this reader. Wire it with
     * `@lunora/auth`'s `createAuthAuditReader(d1Executor(env.DB))`. Omit it and the
     * RPC responds `AUTH_AUDIT_NOT_CONFIGURED`; a caller without a valid admin
     * bearer always gets `ADMIN_FORBIDDEN` first (default-closed).
     */
    authAuditReader?: AuthAuditReader;

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
     * Optional table-level authorization callback for fan-out RPC envelopes.
     * Called after `resolveIdentity` and before `coordinator.fanOut` walks
     * the registry. Returning `false` rejects the request with 403
     * `FORBIDDEN_FANOUT`. When unset, fan-out is denied by default
     * whenever {@link WorkerOptions.authorizeShard} is configured — fan-out is a
     * privileged operation (it dispatches the caller's function across
     * every live shard for the table) and a per-shard gate is not
     * sufficient to authorize it. Apps that need client-driven fan-out
     * must opt in explicitly via this callback.
     *
     * SCOPE: this gate is TABLE-granular — it decides whether the caller may fan
     * this function out over this table at all, never which ROWS come back. Row
     * filtering is RLS's job and stays RLS's job on the fan-out path too: the
     * reserved `__lunora_relation__:read` hop carries the child's read policy as
     * data (`where` + `relationPolicies`) so each shard applies it. Do not read
     * an `authorizeFanOut: () => true` as "this caller may see every row".
     */
    authorizeFanOut?: (identity: ResolvedIdentity | null, table: string, functionPath: string) => boolean | Promise<boolean>;

    /**
     * Optional per-shard authorization callback for CLIENT-ORIGINATED access.
     * Called from the RPC, REST, in-process `serverQuery`, and WebSocket-upgrade
     * paths after `resolveIdentity` has produced an identity but before the
     * request is forwarded to the named shard. Returning `false` (or a promise
     * resolving to `false`) rejects the request with a 403 `FORBIDDEN_SHARD`.
     * When unset, naming a non-default shard is default-denied unless the worker
     * opts into open access with `allowUnauthenticatedShardAccess: true`.
     *
     * SCOPE — this is a gate on CALLERS, so it only ever runs where there is one.
     * Server-initiated dispatch (a firing cron, a scheduler job) does NOT pass
     * through it: those originate inside the trust boundary (the worker's own
     * `scheduled()` handler, or the HMAC/admin-bearer-gated scheduler endpoint,
     * which authenticates first), and they carry no end-user identity to judge.
     * The reserved `__lunora_admin__:*` RPCs are exempt for the same reason.
     * A gate that sees `identity: null` is therefore always looking at an
     * anonymous END USER, and `({ identity }) => identity?.userId !== undefined`
     * is a correct, complete gate — it cannot starve the scheduler.
     *
     * Note: this callback does NOT gate fan-out envelopes — fan-out
     * targets every live shard for a table and must be authorized at the
     * table level via {@link WorkerOptions.authorizeFanOut}. Configuring this callback
     * without `authorizeFanOut` causes fan-out envelopes to be denied by
     * default.
     */
    authorizeShard?: (caller: ShardCaller) => boolean | Promise<boolean>;

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
     * NDJSON object lands at `<prefix>lunora-backup-<id>.ndjson` and its manifest
     * at the same key plus `.manifest.json`.
     */
    backupPrefix?: string;

    /**
     * Retention window for scheduled backups: the newest N snapshots under
     * {@link WorkerOptions.backupPrefix} are the ones considered current. Omit
     * (or `0`) to treat every backup as current.
     *
     * **Reporting only — this never deletes.** Each run logs how many snapshots
     * sit past the window and points at `lunora backup prune`, which is the only
     * thing that removes one (and which confirms first). A bucket therefore
     * grows until someone prunes it. Said explicitly because the name reads like
     * the opposite, and because a backup deleted by a cron nobody was watching
     * is not a failure mode this should ever have.
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
     *
     * "Every table" needs {@link WorkerOptions.listSchemaTables}; without it the
     * backup reaches only the default shard. Export warns when that happens.
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

    /** Default shard key used when an envelope omits one. */
    defaultShardKey?: string;

    /**
     * Durable per-shard cursor store for the continuous CDC export tap (plan 170),
     * mirroring the CDC-in `__lunora_source_cursor` watermark. Build a KV-backed
     * one with `createKvCursorStore(env.CDC_CURSORS)`. Required (alongside
     * {@link WorkerOptions.exportSinks}) for the `POST /_lunora/admin/export-tap/run`
     * drain route; absent → the route reports `EXPORT_TAP_NOT_CONFIGURED`.
     */
    exportCursorStore?: ExportCursorStore;

    /**
     * Stream `.global()` rows for the admin export endpoint. When omitted,
     * the export endpoint covers only shard-local tables.
     */
    exportGlobals?: GlobalExportFunction;

    /**
     * Named continuous-export sinks (plan 170) the CDC tap drains the op-log change
     * feed to. Build with `webhookSink({...})`, `r2Sink({...})`, or a custom
     * `defineExportSink({...})`. Paired with {@link WorkerOptions.exportCursorStore}
     * to enable the `POST /_lunora/admin/export-tap/run` drain route (at-least-once,
     * ordered per shard, resumable). Absent / empty → the route reports not-configured.
     */
    exportSinks?: Record<string, ExportSink>;

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
     * Health / readiness probe configuration (plan 177). When present (or left as
     * the default — probes are always registered), the worker serves
     * `GET /_lunora/health` (aggregate; `503` when a critical dependency is down)
     * and `GET /_lunora/health/ready` (readiness gate). The runtime auto-registers
     * probes for the shard Durable Object (reachability, critical), any D1 binding
     * (`SELECT 1`, critical), and R2 / queue / Hyperdrive bindings (presence,
     * non-critical); `probes` adds bespoke checks. The body never leaks secrets —
     * see {@link HealthOptions}.
     */
    health?: HealthOptions;

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
     * The declared identity claim contract (`defineIdentity(...)` from
     * `@lunora/server`), passed by the generated worker entry. When present, the
     * worker validates every `resolveIdentity` result against it at the trust
     * boundary (on the public data paths — RPC / WebSocket / HTTP-action /
     * server-query, never the admin path) *before* the claims become `ctx.auth`.
     * A resolver output that violates the contract is downgraded to anonymous or
     * rejected with a `401`, per the contract's `onInvalid`. Omitted → no
     * validation, and the identity stays the historical untyped claim bag.
     */
    identity?: IdentityContractLike;

    /**
     * Insert `.global()` rows for the admin import endpoint. When omitted,
     * rows targeting global tables are reported as hard errors.
     */
    importGlobals?: GlobalImportFunction;

    /**
     * Restrict every Durable Object this worker reaches — shard DOs, the
     * scheduler DO, the fan-out coordinator, subscriptions — to a Cloudflare
     * data-residency jurisdiction (`"eu"`, `"us"`, `"fedramp"`). The runtime
     * derives a jurisdiction-pinned subnamespace from {@link WorkerOptions.shardDO}
     * and {@link WorkerOptions.schedulerDO} once, so all routing inherits it.
     *
     * Fail-closed: if the bound namespace does not expose `.jurisdiction()`
     * (an older `@cloudflare/workers-types`), the worker throws rather than
     * silently routing to the un-pinned global namespace. Omit it for the
     * default, un-pinned behaviour.
     *
     * ⚠️ Set once, before the first deploy — changing it strands data. A DO name
     * maps to a *different* ID per jurisdiction, so toggling this on an existing
     * deployment makes every shard/scheduler call resolve to a new, empty DO; the
     * prior data stays in the old jurisdiction and is unreachable (no in-place
     * migration). Usually set via the schema's `.jurisdiction(...)`, which codegen
     * threads here.
     * @see https://developers.cloudflare.com/durable-objects/reference/data-location/
     */
    jurisdiction?: DurableObjectJurisdiction;

    /**
     * Introspector for Workers KV namespaces, backing the studio's KV browser
     * via `GET /_lunora/admin/kv/namespaces`, `GET /_lunora/admin/kv/keys`,
     * `GET|PUT|DELETE /_lunora/admin/kv/value`. Build it from the env's bound
     * KV namespaces with `createKvIntrospector` from `@lunora/bindings/kv`.
     * Omit it and those endpoints respond `KV_NOT_CONFIGURED`.
     */
    kvIntrospector?: KvIntrospector;

    /**
     * Every table the schema declares, in no particular order. Codegen fills this
     * in from the same generated `schema` object that backs
     * {@link WorkerOptions.resolveTableSharding}.
     *
     * Export uses it to answer "every table" with a real list. Shard discovery is
     * driven by the table list — the coordinator unions each named table's live
     * shard keys — so an export that names no tables discovers no shards. Before
     * this existed, `lunora export` with no `--tables`, and the scheduled backup
     * with `backupTables` omitted (documented as "back up every table"), wrote a
     * file containing only `.global()` D1 rows and no shard-local rows at all.
     *
     * Optional so a hand-written worker still runs; absent, export falls back to
     * the default shard, which covers a single-DO deployment but cannot reach the
     * other DOs of a `.shardBy(...)` one.
     */
    listSchemaTables?: () => ReadonlyArray<string>;

    /**
     * The durable log archive's read config — the R2 Data Catalog (Iceberg)
     * table `pipelineLogSink` writes to, so the studio Logs panel's Archive feed
     * (and the `/_lunora/admin/logs/archive` route) can read it back via R2 SQL.
     * The R2 SQL credentials come from `env` (`R2_SQL_ACCOUNT_ID` / `R2_SQL_TOKEN`
     * / `R2_SQL_BUCKET`); this only names the table (+ optional namespace / column
     * overrides). Absent → the Archive feed reports "not configured".
     */
    logArchive?: LogArchiveConfig;

    /**
     * The `@lunora/notify` device-subscription store, bound from the request
     * `env` by codegen from the app's `lunora/notify.ts` `defineNotify({ store })`.
     * Backs the gated `__lunora_admin__:listPushSubscriptions` admin RPC (the
     * Studio Notifications page): the worker reads registered devices — endpoint /
     * kind / last-send status / delivery errors — through the SAME store the
     * handlers register into. Delivery secrets (Web Push keys, FCM token) are
     * stripped before the devices leave the worker. Absent (no store configured)
     * ⇒ the RPC returns an empty device list rather than erroring.
     */
    notifySubscriptionStore?: NotifySubscriptionStoreLike;

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
     * Cloudflare Queues push-consumer handler — the worker's `queue(batch, …)`
     * entry forwards every delivered `MessageBatch` here. Built by codegen from
     * `lunora/queues.ts` (via `@lunora/queue`'s `dispatchQueueBatch`, which routes
     * by `batch.queue` to the matching `defineQueue` handler), so the runtime
     * stays decoupled from the queue package. Omitted when no push queues exist.
     */
    queue?: QueueConsumerHandler;

    /**
     * Serve one-shot **queries** from a read replica placed in the caller's
     * region instead of from the shard owner. Off by default.
     *
     * What it buys: a query answered near the reader rather than across an
     * ocean. What it costs: a query that names no bookmark may be up to
     * `LUNORA_REPLICA_MAX_STALENESS_MS` (default 1000) behind the owner, and
     * every replica is a second Durable Object holding a copy of the shard.
     *
     * Read-your-writes is preserved for callers that pass the `commitCursor`
     * their last write returned back as `x-lunora-min-seq`: the replica catches
     * up to at least that cursor or the read falls back to the owner. Mutations,
     * actions, streams, subscriptions, and fan-outs are never replica-routed.
     *
     * Requires CDC to be enabled on the schema — the changelog IS the
     * replication feed. Without it a replica has nothing to follow, reports
     * itself unavailable, and every read falls back to the owner (correct, and
     * one wasted hop per read).
     */
    replicaReads?: boolean;

    /* eslint-disable no-secrets/no-secrets -- the env-var NAME below is a config key, not a credential */

    /**
     * Enforce the ephemeral WS admin token: the worker's WS admin gate rejects
     * the raw master admin token in the `?token=` query parameter — only a
     * short-lived sub-token minted by `POST /_lunora/admin/ws-token` (or the
     * master token in the `Authorization` HEADER, which never leaks via URLs)
     * authorizes.
     *
     * **On by default**: a query string lands in access logs, browser history and
     * `Referer`, so the master admin credential must not ride one. The studio
     * mints and sends the ephemeral token already.
     *
     * To opt back out for a legacy client that still puts the master token in a
     * URL, set **`env.LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN`** to
     * `0`/`false`/`off`/`no`/`disabled`. That is the knob to use: it is read
     * independently by the worker AND by the shard/relay Durable Objects, so the
     * whole deployment agrees. This code-level option only governs the WORKER's
     * gate — a DO stamps its own socket from `env` alone, so setting `false` here
     * without the env var yields a socket the worker admits and the DO marks
     * non-admin (admin subscriptions then return nothing).
     */
    requireEphemeralWsToken?: boolean;
    /* eslint-enable no-secrets/no-secrets */

    /**
     * Resolve the calling identity from the inbound RPC request. Called once
     * per RPC (and per fan-out) before the request is forwarded to the
     * shard. The returned `userId` becomes `ctx.auth.userId` on the shard
     * side; remaining keys (`email`, role flags, etc.) are JSON-encoded and
     * forwarded as `x-lunora-identity` so `ctx.auth.getIdentity()` can
     * return them. Returning `null` (or omitting this option) means
     * anonymous — no identity headers are injected.
     *
     * The third argument is the request's `ExecutionContext`, forwarded so a
     * resolver can read identity the platform supplies out-of-band rather than
     * off the request — `context.access` on a Worker protected by Cloudflare
     * Access is the one that exists today. It is `undefined` on the paths that
     * have no context to give (a direct {@link LunoraWorker.serverQuery} call, a
     * host that mounts the worker without one), so a resolver that uses it must
     * still handle its absence.
     */
    resolveIdentity?: (request: Request, env: unknown, context?: ExecutionContextLike) => Promise<ResolvedIdentity | null> | ResolvedIdentity | null;

    /**
     * Resolve a table's sharding metadata. Required by the import endpoint to
     * bucket rows; when omitted, every row routes to the default shard.
     */
    resolveTableSharding?: AdminTableResolver;

    /**
     * The shared HTTP cache a REST `cache` policy is stored in and served from.
     *
     * Defaults to the host's own (`caches.default` on Cloudflare), which is what
     * makes `.expose({ rest: true, cache })` store anything at all. Pass `null` to
     * keep the surface headers-only — the declared `Cache-Control` still goes out,
     * but nothing is written to the colo. A host with no cache needs no opt-out:
     * `rest-edge-cache` finds none and degrades to the same behaviour.
     */
    restEdgeCache?: HttpCacheLike | null;

    /**
     * Optional per-request rate-limit gate for the opt-in public REST surface
     * (plan 167). Invoked with the inbound request + the target `functionPath`
     * BEFORE the procedure is dispatched; return a `429` `Response` to reject
     * (returned verbatim, `Retry-After` included) or `undefined` to allow. Build it
     * over `@lunora/ratelimit` in the worker entry — the runtime stays free of a
     * hard `@lunora/ratelimit` dependency. Only consulted for REST calls; typed RPC
     * is unaffected.
     */
    restRateLimit?: RestRateLimit;

    /**
     * Map of routes for custom HTTP handlers (auth callbacks etc.). Keys can
     * be either `"METHOD path"` (e.g. `"GET /healthz"`) or just `"path"`
     * (e.g. `"/healthz"`) — the runtime will match the more specific form
     * first.
     */
    routes?: Record<string, Route>;

    /**
     * Trace-sampling policy for the observability pipeline, mirroring Cloudflare
     * Workers' `head_sampling_rate`. Governs only trace spans (the per-dispatch
     * SERVER span and the `ctx.trace` INTERNAL spans beneath it) — never metrics
     * or `ctx.log` lines.
     *
     * The decision is deterministic per trace: a stable value derived from the
     * `traceId` is compared to `headRate`, so the same trace is kept or dropped
     * as a whole on the worker and on every shard/container it fans out to (no
     * half traces). The head decision is propagated to shards via the
     * `traceparent` sampled flag, so they drop the matching `ctx.trace` spans
     * coherently.
     *
     * With `alwaysSampleErrors` (default `true`), a trace that produced an error
     * span is kept whole regardless of the head decision — the tail bias, so
     * failures are never sampled away even at an aggressive `headRate`. Omit the
     * option (or leave `headRate` at its default `1`) to keep every trace.
     */
    sampling?: TraceSamplingConfig;

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

    /**
     * Secure-by-default HTTP edge applied to every response the worker emits
     * (RPC, auth, admin, `httpRoute` handlers, SSR fallback): baseline security
     * headers, deny-by-default CORS, and a CSRF/origin guard. Every layer is on
     * by default and individually opt-out — see {@link SecurityOptions}. Omit it
     * to take the hardened defaults; set a field to `false` to relax that layer
     * (e.g. `security: { cors: { allowedOrigins: ["https://app.example.com"] } }`).
     */
    security?: SecurityOptions;

    /** Namespace binding for the shard Durable Object (typically `env.SHARD`). */
    shardDO: ShardNamespaceLike;

    /**
     * Where a shard should be created, by shard key — a per-tenant placement
     * policy (`(key) => "weur"` for a European tenant, say).
     *
     * The platform already creates a shard near whichever request first touches
     * it, so this exists for the cases where that request is the wrong signal:
     * a shard first materialized by a cron fire, a migration fan-out, a seeding
     * run, or the Studio lands wherever that ran, and stays there for life. A
     * key whose region is not known yet returns `undefined`, which restores the
     * default (place near the first request).
     *
     * Advisory in both directions: the hint is honoured only by the resolution
     * that CREATES the object — changing this callback later does not move a
     * shard that already exists — and even then the platform places near the
     * hinted region rather than exactly in it.
     */
    shardRegion?: (shardKey: string) => RegionHint | undefined;

    /**
     * Resolve the app-facing storage capability from the worker `env` — the same
     * `createStorage(...)` / `createBucketStorage(...)` result the shard DO
     * receives, built over the same R2 bindings.
     *
     * This is what backs `ctx.storage` on an HTTP action. R2 is a worker binding,
     * so an HTTP handler can reach it directly and needs no shard hop; omitting
     * it left `HttpActionCtx` without storage, so a handler could not store an
     * upload or mint a presigned URL. The requirement then propagated outward:
     * any helper the ctx was threaded into had to be typed for the worst case,
     * which barred every HTTP caller from the helper entirely — even on the
     * branches that never touch storage.
     *
     * Distinct from the `storage*` options below, which are the admin-gated
     * studio file-browser ops, not the app surface.
     */
    storage?: (env: unknown) => unknown;

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
     * Reads one object back, backing the admin-gated
     * `GET /_lunora/admin/storage/object` endpoint that `lunora backup restore
     * --bucket` pulls snapshots through. Wrap the storage call — the generated
     * app worker emits
     * `(key, opts) => pick(opts?.bucket).download(key)` — rather than passing
     * `createStorage(...).download` itself, whose second parameter is a byte
     * range, not a bucket. Omit it and the endpoint responds
     * `STORAGE_DOWNLOAD_NOT_CONFIGURED`.
     */
    storageDownload?: StorageDownloadFunction;

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
     * Who may hand this worker a trace to join. Controls whether an inbound W3C
     * `traceparent` is continued — adopting its trace id, parenting this
     * dispatch's span under the upstream span, and carrying its `tracestate` to
     * the shard. **Default: off.**
     *
     * ```ts
     * trustInboundTraceContext: true             // nothing untrusted can reach this worker
     * trustInboundTraceContext: "mtls"           // only edge-verified client certificates
     * trustInboundTraceContext: (request) => …   // anything else
     * ```
     *
     * Off by default because the header is caller-supplied: on a worker an
     * untrusted client can reach directly, trusting it lets anyone choose which
     * trace their spans and `ctx.log` lines join — grafting entries into another
     * tenant's waterfall in a shared collector — and, because the head-sampling
     * verdict is derived from the trace id, choose their own sampling outcome.
     * (Error traces are unaffected either way: the tail bias is evaluated from
     * the worker's own decision, never the caller's.)
     *
     * Turn it on when something you control — a gateway, service mesh, or
     * Cloudflare Access — sets `traceparent` itself; a proxy that only _forwards_
     * the client's header is not such a thing. Behind a front door like that,
     * `true` is the answer, because every caller has already passed it. Confirm
     * the worker really is unreachable otherwise — a `*.workers.dev` route left
     * enabled is a second front door with no gate on it.
     *
     * Leaving this unset logs a one-time hint if an inbound trace is actually
     * dropped; setting it explicitly to `false` keeps the behaviour and silences
     * that.
     * @see {@link TrustInboundTraceContext} for what each signal proves.
     */
    trustInboundTraceContext?: TrustInboundTraceContext;

    /**
     * Read-only introspector for Vectorize indexes, backing the studio's vector
     * browser via `GET /_lunora/admin/vector/indexes` and
     * `POST /_lunora/admin/vector/query`. Build it from the generated
     * `LUNORA_VECTOR_INDEXES` registry plus the env Vectorize bindings (and the
     * schema's embedders, to enable similarity queries). Omit it and those
     * endpoints respond `VECTORS_NOT_CONFIGURED`.
     */
    vectorIntrospector?: VectorIntrospector;

    /**
     * Voice-session Durable Object namespaces, keyed by the agent's
     * `lunora/agents.ts` export name (e.g. `{ support: env.VOICE_SUPPORT }`).
     * Codegen wires this for every voice-enabled agent. When set, the worker
     * exposes `/_lunora/voice/<agentExportName>` — a WebSocket upgrade that
     * resolves the caller's identity, forwards it on the server-minted
     * `x-lunora-userid` / `x-lunora-identity` headers, and hands the socket to
     * the agent's `VoiceSessionDO`. Omit it (voice-free apps) and the route does
     * not exist.
     */
    voiceAgents?: Record<string, ShardNamespaceLike>;

    /**
     * Resolver for the Cloudflare Workflows REST client, built from the
     * deployment `env` (its `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`).
     * Set by the codegen-emitted worker entry (which depends on
     * `@lunora/workflow`); when omitted, the `/_lunora/admin/workflows*` proxy
     * reports "not configured" and the studio shows the credentials empty state.
     */
    workflowsClient?: (env: unknown) => undefined | WorkflowsRestClient;

    /**
     * Injected x402 charge gate for paid (`.x402({ price })`) procedures. Build
     * it with `createProcedureChargeGate(config)` from `@lunora/x402/charge` and
     * pass it here; the runtime stays free of a hard `@lunora/x402` dependency
     * (and its viem/solana deps).
     *
     * **Required whenever any registered function is `.x402()`-tagged.** The
     * origin worker refuses to dispatch a paid procedure with a config error
     * (`500`) when this is absent, rather than serving it free — the paywall is
     * fail-closed by construction. See {@link X402ChargeGate}.
     *
     * The converse also holds: setting this without {@link WorkerOptions.functions}
     * throws at construction. The `.x402` tags are read off that registry, so a
     * gate with no registry would paywall nothing.
     */
    x402Charge?: X402ChargeGate;
}

interface RpcContext {
    ctx: ExecutionContextLike;
    env: unknown;
    request: Request;
    shardKey: string;
}

const RPC_PATH = "/_lunora/rpc";
const RPC_BATCH_PATH = "/_lunora/rpc-batch";
const WS_PATH = "/_lunora/ws";

/** HTTP metadata extracted safely from an inbound request for observability. */
interface RequestTelemetryMeta {
    host?: string;
    method: string;
    path?: string;
    port?: number;
    scheme?: string;
    userAgent?: string;
}

/**
 * Build the per-request context handed to every observability sink.
 *
 * `waitUntil` is the only conditional part — it needs an `ExecutionContext`, which
 * some entry points (an in-process `serverQuery`) may not have. Resource
 * detection is not gated on it: `env` and `request` are available on every path,
 * and gating them on an unrelated capability was silently blanking resource
 * attributes on the paths that lacked one.
 *
 * What crosses this boundary is deliberately narrow — a `waitUntil` and a thunk
 * that resolves a small allowlisted attribute bag. Sinks are user-extensible and
 * this context is fanned out to all of them, so raw `env` (every secret binding)
 * and the raw `Request` (its `Authorization`/`Cookie`) must not be reachable here.
 */
const buildSinkContext = (environment: unknown, request: Request, waitUntil?: (promise: Promise<unknown>) => void): ObservabilitySinkContext => {
    return {
        resourceAttributes: createResourceAttributeResolver(environment, request),
        ...(waitUntil === undefined ? {} : { waitUntil }),
    };
};

/**
 * Normalize a `waitUntil`-bearing source — an `ExecutionContext` (RPC), or an
 * SSR host's `{ waitUntil }` (REST) — into the `{ waitUntil? }` deps shape the
 * x402 gate expects. Both gate sites forward through this one helper so they
 * pass an identically-shaped `deps`. Forwarding through the source (rather than
 * extracting the method) preserves its receiver, and a source without a
 * `waitUntil` yields `{}` so the gate falls back to fire-and-forget.
 */
const forwardWaitUntil = (source?: { waitUntil?: (promise: Promise<unknown>) => void }): { waitUntil?: (promise: Promise<unknown>) => void } =>
    source?.waitUntil ? { waitUntil: (promise): void => source.waitUntil?.(promise) } : {};

/**
 * Project a dispatch's trace context onto the `ObservabilityEvent` fields that
 * carry it. One helper so the success and failure emits at every dispatch site
 * cannot drift on which of the four they set — the previous hand-copied spreads
 * had already diverged.
 */
const traceEventFields = (trace: DispatchTraceContext): Pick<ObservabilityEvent, "parentSpanId" | "spanId" | "traceFlags" | "traceId"> => {
    return {
        spanId: trace.spanId,
        traceFlags: trace.traceFlags,
        traceId: trace.traceId,
        ...(trace.parentSpanId === undefined ? {} : { parentSpanId: trace.parentSpanId }),
    };
};

/** Extract HTTP semantic metadata from a request without throwing on bad URLs. */
const requestTelemetryMeta = (request: Request): RequestTelemetryMeta => {
    const { method } = request;
    const userAgent = request.headers.get("user-agent") ?? undefined;
    let url: URL;

    try {
        url = new URL(request.url);
    } catch {
        return { method, userAgent };
    }

    const port = url.port === "" ? undefined : Number(url.port);

    return {
        host: url.hostname,
        method,
        path: url.pathname,
        port: Number.isNaN(port) ? undefined : port,
        scheme: url.protocol.replace(":", ""),
        userAgent,
    };
};
/** Prefix for a voice-enabled agent's real-time session upgrade — `/_lunora/voice/<agentExportName>` (dynamic, so matched by prefix not the exact-path table). */
const VOICE_PATH_PREFIX = "/_lunora/voice/";
const SCHEDULER_DISPATCH_PATH = "/_lunora/scheduler/dispatch";
/** Admin-gated POST that manually fires one code-defined cron job by name (studio "Run now"). */
const CRON_JOBS_RUN_PATH = "/_lunora/admin/cron-jobs/run";

/**
 * Admin-gated POST minting a short-lived HMAC-signed WS admin sub-token (plan
 * 095). Authenticated by the master admin bearer in the `Authorization` header;
 * returns `{ token, expiresAtMs }`. The studio sends the minted token — never
 * the master token — in the WS `?token=` query string, so the master credential
 * stays out of URLs/logs.
 */
const ADMIN_WS_TOKEN_PATH = "/_lunora/admin/ws-token";
/** Prefix shared by every Studio admin route (`/_lunora/admin/*`). */
const ADMIN_PATH_PREFIX = "/_lunora/admin/";
/** Prefix shared by the whole reserved plane the worker owns — everything else on the origin belongs to the app. */
const RESERVED_PATH_PREFIX = "/_lunora/";
/** The lone cross-shard admin route that sits outside {@link ADMIN_PATH_PREFIX}. */
const MIGRATE_PATH = "/_lunora/migrate";

/**
 * Public, unauthenticated health probe (`GET /_lunora/status`). Dev tooling and
 * AI agents poll it to confirm the worker is up and routing (the CLI's
 * `lunora dev --background` blocks on it before detaching). Deliberately
 * static and secret-free, and the body is a bare `{"ok":true}` — no framework
 * name or version — so a production deployment doesn't hand scanners a
 * stronger fingerprint than the path shape already implies.
 */
const STATUS_PATH = "/_lunora/status";

/** True for the admin routes the async `adminGate` may authorize — everything under `/_lunora/admin/` plus `/_lunora/migrate`. */
const isAdminPath = (pathname: string): boolean => pathname.startsWith(ADMIN_PATH_PREFIX) || pathname === MIGRATE_PATH;

/**
 * The reserved cross-shard relation reader's function-path prefix. Inlined as a
 * literal rather than imported so the runtime carries no `@lunora/do` dependency.
 */
const RELATION_FUNCTION_PREFIX = "__lunora_relation__:";

/**
 * Refuse a `__lunora_relation__:*` dispatch that is NOT a fan-out.
 *
 * SECURITY: the reserved relation reader answers with RAW, RLS-blind rows for
 * whatever `args.table` names, and the confused-deputy binding that pins
 * `args.table` to the AUTHORIZED `fanOut.table` lives in `parseEnvelope` and runs
 * only when a `fanOut` is present. So on a single-shard dispatch `args.table` is
 * entirely free, and the `authorizeFanOut` gate — the only thing that authorizes
 * this reader — is never consulted.
 *
 * Every surface that turns a function reference into a shard dispatch calls this,
 * not just the RPC edge: the shard applies NO gate of its own and its comment
 * names this refusal as the reason ("worker refuses this prefix on a single-shard
 * envelope, so it's only reachable through the authorizeFanOut-gated fan-out
 * path"). A surface that skips it is not a weaker check, it is no check.
 */
const assertNotReservedRelationPath = (functionPath: string): void => {
    if (functionPath.startsWith(RELATION_FUNCTION_PREFIX)) {
        throw new LunoraError("`__lunora_relation__:*` is a fan-out-only reserved RPC and cannot be dispatched to a single shard", {
            code: "FORBIDDEN",
            status: 403,
        });
    }
};

/**
 * Narrow an app-supplied authorization verdict to an exact `true`.
 *
 * SECURITY: every `WorkerOptions` gate below (`authorizeShard`,
 * `authorizeFanOut`, `adminGate`) is DECLARED to answer a boolean, but it is app
 * code and untyped JavaScript reaches it — `catch`-less `as` casts too. The
 * canonical mistake is `authorize: async ({ request }) => verifySignedUrl(url,
 * secret)` with `.valid` forgotten: it hands back `{ valid: false }`, a DENIAL
 * that is TRUTHY, and a `if (!allowed)` test then grants. Awaiting into `unknown`
 * and comparing to `true` means a broken gate can only ever deny.
 */
const grants = async (verdict: unknown): Promise<boolean> => (await verdict) === true;

/**
 * Read the optional caller identity a server-initiated dispatch may forward on
 * the `x-lunora-userid` / `x-lunora-identity` headers, returning the shape
 * `dispatchToShard` threads to the shard (or `undefined` when neither is set).
 *
 * Deliberately opaque: both values are captured as raw strings and later copied
 * verbatim back onto the outbound shard request's headers (see the
 * `dispatchToShard` header block below) without being decoded here. The inbound
 * request is itself `@lunora/dispatch`'s own `fetch` to this worker, which
 * already encodes via `encodeUserIdHeader`/`encodeIdentityHeader` — so the
 * string captured here is already `ByteString`-safe and needs no
 * decode-then-re-encode round trip; it's the shard's `parseIdentityHeader` /
 * voice DO's identity parser that ultimately decode it.
 */
const readForwardedIdentity = (request: Request): { identity?: string; userId?: string } | undefined => {
    const forwardedUserId = request.headers.get("x-lunora-userid");
    const forwardedIdentity = request.headers.get("x-lunora-identity");

    if (forwardedUserId === null && forwardedIdentity === null) {
        return undefined;
    }

    return {
        ...(forwardedIdentity === null ? {} : { identity: forwardedIdentity }),
        ...(forwardedUserId === null ? {} : { userId: forwardedUserId }),
    };
};
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
 * Reserved admin RPC the worker (NOT the DO) serves to list the app's registered
 * `@lunora/notify` device subscriptions for the Studio Notifications page. Unlike
 * the DO-served admin RPCs, the subscription store is a WORKER option (built from
 * `env` via `defineNotify({ store })`), so this op is intercepted in `handleRpc`
 * ahead of the shard forward and gated by the worker's admin bearer. Spelled out
 * inline, like the other admin-op constants, to avoid importing `@lunora/notify`.
 */
const LIST_PUSH_SUBSCRIPTIONS_OP = "__lunora_admin__:listPushSubscriptions";

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

/** `true` iff `pathname` is the auth plane's root or nested under it (`/api/auth`, `/api/auth/sign-in/email`). */
const isUnderAuthBasePath = (pathname: string, basePath: string): boolean => {
    const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;

    return pathname === base || pathname.startsWith(`${base}/`);
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
    const mappable = isLunoraError(error);
    const code = mappable ? error.code : "INTERNAL_SERVER_ERROR";
    const status = mappable ? error.status : 500;
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
 * Extract a token-expiry (epoch ms) from a resolved identity, or `undefined`
 * when none is declared. Prefers an explicit `expiresAtMs` (epoch ms); falls
 * back to the JWT-standard `exp` (epoch SECONDS, scaled to ms). Non-finite /
 * non-numeric values are ignored so a malformed claim never expires a socket.
 * @returns epoch ms expiry, or `undefined` when no expiry claim is present.
 */
const identityExpiryMs = (identity: ResolvedIdentity): number | undefined => {
    const { exp, expiresAtMs } = identity;

    if (typeof expiresAtMs === "number" && Number.isFinite(expiresAtMs)) {
        return expiresAtMs;
    }

    if (typeof exp === "number" && Number.isFinite(exp)) {
        return exp * 1000;
    }

    return undefined;
};

/**
 * Build the headers forwarded to the shard and the resolved identity, shared by
 * the RPC path and HTTP-action context. `userId` and `claims` mirror what the
 * DO reconstructs from the `x-lunora-userid` / `x-lunora-identity` headers.
 */

/**
 * The per-event sink context for an invocation, or `undefined` when the platform
 * exposes no `waitUntil` (where a network sink falls back to fire-and-forget).
 *
 * One helper because both invocation boundaries — the `fetch` flush and
 * `instrumentTrigger` — need the identical shape, and a divergence would
 * silently downgrade one of them.
 */
const sinkContextFor = (context: ExecutionContextLike): ObservabilitySinkContext | undefined =>
    context.waitUntil
        ? {
              waitUntil: (promise) => {
                  context.waitUntil?.(promise);
              },
          }
        : undefined;

/**
 * Name of the queue a consumer batch came from, for the trigger's span name.
 *
 * The batch is typed `unknown` at this boundary (the consumer handler is
 * codegen-built and the worker deliberately doesn't depend on `@lunora/queue`'s
 * types), so the name is read defensively: a batch without a string `queue`
 * falls back to a constant rather than stringifying `undefined` into the span
 * name, which would show up in a collector as a literal `queue:undefined` group.
 */
const queueNameOf = (batch: unknown): string => {
    const name = (batch as { queue?: unknown } | null | undefined)?.queue;

    return typeof name === "string" && name.length > 0 ? name : "unknown";
};

/**
 * The `ExecutionContext` of the request currently in flight, so the many places
 * that resolve identity can hand it to `resolveIdentity` without every one of
 * them (including the extracted admin-route modules, which take
 * `resolveForwardContext` as an injected dep) having to thread a fourth argument
 * through its own signature.
 *
 * Recorded once, at the single `fetch` funnel in `handle`, and keyed on the
 * `Request` object — so an entry cannot outlive its request, cannot be read by a
 * different one, and needs no eviction policy.
 *
 * Unlike the per-worker `accessAdminGrants` WeakSet, this lives at **module**
 * scope, because `resolveForwardContext` does. That is safe for the same reason
 * the WeakSet is — the key is a `Request` identity, which no two isolated
 * requests share — but it does mean two composed workers in one isolate write to
 * the same map. The only way that matters is a re-entrant mount (an inner
 * `lunoraHandler` invoked without a context, for a request an outer worker
 * already recorded) overwriting the entry mid-flight; nothing re-resolves
 * identity after dispatch today, so it cannot bite yet. A path that resolves
 * identity for a `Request` this never saw — notably a caller that rebuilds the
 * request object before calling `serverQuery` — reads `undefined`, which is why
 * `serverQuery` also accepts the context explicitly.
 */
const executionContextByRequest = new WeakMap<Request, ExecutionContextLike>();

const resolveForwardContext = async (
    request: Request,
    env: unknown,
    resolveIdentity: WorkerOptions["resolveIdentity"],
    // Defaults to the in-flight context recorded by `handle`. Passed explicitly
    // only by callers that did not reach here through the `fetch` funnel.
    context: ExecutionContextLike | undefined = executionContextByRequest.get(request),
): Promise<ForwardContext> => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const authorization = request.headers.get("authorization");
    const cookie = request.headers.get("cookie");
    const bookmark = request.headers.get("x-d1-bookmark");
    // Client-supplied mutation-replay idempotency key. Safe to forward verbatim:
    // the DO namespaces the dedup record by the server-minted identity, so a
    // forged id can only ever collide with the same caller's own mutations.
    const mutationId = request.headers.get("x-lunora-mutation-id");
    // Custom-mutator push identity: a stable per-device client id + a monotonic
    // per-client sequence. Forwarded verbatim — the DO classifies the sequence
    // against its `__client_watermark` (already-applied / next / out-of-order),
    // so a forged value can only reorder a caller's own mutator stream.
    const clientId = request.headers.get("x-lunora-client-id");
    const clientSeq = request.headers.get("x-lunora-client-seq");

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

    if (clientId) {
        headers["x-lunora-client-id"] = clientId;
    }

    if (clientSeq) {
        headers["x-lunora-client-seq"] = clientSeq;
    }

    // Forward the caller's IP server-side from Cloudflare's `CF-Connecting-IP`
    // (set by the edge, overwriting any client-supplied value — so it's trusted;
    // a raw `x-forwarded-for` is client-spoofable and deliberately NOT used).
    // The DO surfaces it as `ctx.ip` (e.g. to rate-limit anonymous traffic by IP).
    const clientIp = request.headers.get("cf-connecting-ip");

    if (clientIp) {
        headers["x-lunora-client-ip"] = clientIp;
    }

    if (!resolveIdentity) {
        // eslint-disable-next-line unicorn/no-null -- `claims`/`identity`/`userId` feed the public HttpActionContext + authorize* callback contracts, whose anonymous sentinel is `null`
        return { claims: null, headers, identity: null, userId: null };
    }

    const identity = await resolveIdentity(request, env, context);

    if (!identity || typeof identity.userId !== "string" || identity.userId.length === 0) {
        // eslint-disable-next-line unicorn/no-null -- `claims`/`identity`/`userId` feed the public HttpActionContext + authorize* callback contracts, whose anonymous sentinel is `null`
        return { claims: null, headers, identity: null, userId: null };
    }

    // Base64url-encoded when `userId` has any non-Latin-1 code unit — otherwise
    // forwarded unchanged. HTTP header values are WebIDL `ByteString`s, so a raw
    // id containing e.g. a CJK/emoji character would throw on `new Request(...)`
    // at the shard fetch below; see shared/identity-header.ts.
    headers["x-lunora-userid"] = encodeUserIdHeader(identity.userId);

    // Forward an optional token-expiry so the DO can drop a socket whose
    // credential has lapsed (the client then reconnects, re-resolving identity).
    // Accept either `expiresAtMs` (epoch ms) or the JWT-standard `exp` (epoch
    // seconds); the DO reads `x-lunora-identity-exp` as epoch ms.
    const expiresAtMs = identityExpiryMs(identity);

    if (expiresAtMs !== undefined) {
        headers["x-lunora-identity-exp"] = String(expiresAtMs);
    }

    // Strip `userId` so the DO doesn't see it twice. The rest of the identity
    // (claims like email/name/roles) is JSON-encoded so handlers can read it
    // via `ctx.auth.getIdentity()`.
    const { userId, ...extra } = identity;
    // eslint-disable-next-line unicorn/no-null -- `claims` is surfaced via the public HttpActionContext `getIdentity()` whose empty sentinel is `null`
    const claims = Object.keys(extra).length > 0 ? extra : null;

    if (claims) {
        // UTF-8 -> base64url so any non-Latin-1 claim (a CJK/Cyrillic/Arabic name,
        // an emoji, …) stays a valid WebIDL `ByteString` header value. Decoded on
        // the shard side by `parseIdentityHeader` (delegates to
        // `decodeIdentityHeader`, which also still accepts a legacy raw-JSON
        // value). See shared/identity-header.ts.
        headers["x-lunora-identity"] = encodeIdentityHeader(claims);
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
 * @returns the validated spec, or `undefined` when `fanOut` is absent.
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

/**
 * Dev request-loop diagnostic. With `LUNORA_DEBUG_RPC` set on the worker env
 * (e.g. in `.dev.vars`), emit one line per RPC so a client-side request loop
 * shows up as a wall of identical entries in the dev server (vite / wrangler)
 * terminal — immediately naming the runaway function + shard. Off by default, so
 * it never adds noise in production unless the flag is explicitly set. Extracted
 * from `handleRpc` so the guard doesn't inflate that hot path's complexity.
 */
const logRpcDebug = (env: unknown, envelope: RpcEnvelope): void => {
    if (!(env as { LUNORA_DEBUG_RPC?: unknown } | undefined)?.LUNORA_DEBUG_RPC) {
        return;
    }

    // eslint-disable-next-line no-console -- intentional, flag-gated dev request-loop diagnostic
    console.warn(`[lunora:rpc] ${envelope.fanOut ? "fan-out" : `shard=${envelope.shardKey ?? "(root)"}`} ${envelope.functionPath}`);
};

/**
 * Resolve (and validate) the x402 charge tag for a single RPC: returns the paid
 * function's `.x402({ price })` tag, or `undefined` when the function is free.
 *
 * Fail-closed by construction — a paid function that is fanned out, or one with
 * no `x402Charge` gate configured on the worker, throws here rather than being
 * dispatched free. Extracted from `handleRpc` so the paid-procedure guard
 * doesn't inflate that hot path's cognitive complexity.
 *
 * A worker configured with `x402Charge` but no `functions` never reaches this —
 * {@link assertX402Configurable} refuses to build it (see there for why the
 * refusal belongs at construction).
 */
const resolveX402Charge = (envelope: RpcEnvelope, options: WorkerOptions): FunctionRegistryEntry["x402"] => {
    if (options.functions === undefined) {
        return undefined;
    }

    const x402Tag = options.functions[envelope.functionPath]?.x402;

    if (!x402Tag) {
        return undefined;
    }

    // Paid fan-out is unsupported: a challenge/settlement is one payment for one
    // resource, not N shards. Refuse rather than charge once and fan out.
    if (envelope.fanOut) {
        throw new LunoraError("a paid (`.x402`) function cannot be fanned out", { code: "BAD_REQUEST", status: 400 });
    }

    // Fail-closed: a paid function with no charge gate configured must NOT be
    // served free. Refuse with a config error rather than dispatch.
    if (!options.x402Charge) {
        throw new LunoraError(`function "${envelope.functionPath}" is marked paid (.x402) but no x402Charge gate is configured on the worker`, {
            code: "MISCONFIGURED",
            status: 500,
        });
    }

    return x402Tag;
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

    // Read the untrusted fields off the raw parsed body (not the `RpcEnvelope`
    // cast) so these boundary checks narrow real `unknown` values rather than the
    // already-typed envelope shape.
    const raw = body as { args?: unknown; shardKey?: unknown };

    // `args` flows untrusted to `JSON.stringify` + the shard RPC body; reject a
    // non-object (`args: "x"` / `args: 5`) at the edge rather than forwarding a
    // malformed envelope the shard then has to defend against. Absent → `{}`.
    // Same guard the public REST surface applies (`assertArgsObject`) — one
    // check, so the two entry points can't drift.
    if (raw.args !== undefined) {
        assertArgsObject(raw.args, "RPC");
    }

    // `shardKey` flows to `resolveShard` → `idFromName(shardKey)`, which expects a
    // string; a non-string (`shardKey: 123`) would otherwise reach the DO
    // namespace untyped. Validate the type at the boundary (an empty string is a
    // valid named shard, so only the type is enforced).
    if (raw.shardKey !== undefined && typeof raw.shardKey !== "string") {
        throw new LunoraError("RPC `shardKey` must be a string", { code: "BAD_REQUEST", status: 400 });
    }

    const envelope = body as RpcEnvelope;

    const fanOut = validateFanOut(envelope.fanOut);
    const args = envelope.args ?? {};

    // SECURITY (confused-deputy): for the reserved `__lunora_relation__:*` fan-out,
    // `authorizeFanOut` is gated on `fanOut.table`, but the shard read uses
    // `args.table` (relation-fanout.ts). Left unreconciled, a client could
    // authorize a decoy table via `fanOut.table` and read a different, sensitive
    // table via `args.table` — a raw, RLS-blind cross-tenant dump. Bind the read
    // table to the authorized table (and reject an explicit mismatch) so the
    // authorized table is provably the table read. The legitimate reverse-relation
    // caller always sets both to the same value, so this is transparent to it.
    if (fanOut && envelope.functionPath.startsWith("__lunora_relation__:")) {
        const requestedTable = (args as { table?: unknown }).table;

        if (typeof requestedTable === "string" && requestedTable !== fanOut.table) {
            throw new LunoraError("RPC `args.table` must match the authorized `fanOut.table` for a relation fan-out", { code: "BAD_REQUEST", status: 400 });
        }

        (args as { table?: unknown }).table = fanOut.table;
    }

    return {
        args,
        fanOut,
        functionPath: envelope.functionPath,
        shardKey: envelope.shardKey,
    };
};

/** Per-isolate cache of a shard's relay count (the promotion probe), TTL-bounded so a promoted shard doesn't add a round-trip to every WS upgrade. */
interface RelayProbeEntry {
    expiresMs: number;
    relayCount: number;
}

const relayProbeCache = new Map<string, RelayProbeEntry>();

/** How long a relay-count probe is cached per isolate before the runtime re-asks the owner. */
const RELAY_PROBE_TTL_MS = 5000;

/**
 * Cap on the relay-probe cache. `shardKey` comes from the client-chosen `?shard=`
 * WS-upgrade param, so a client cycling distinct shard values would otherwise grow
 * this map monotonically for the isolate's lifetime. Bounded (oldest-out) so the
 * cache can't be turned into an unbounded memory sink.
 */
const RELAY_PROBE_MAX_ENTRIES = 4096;

/**
 * Ask the owner how many relays to spread new connections across for `shardKey`
 * (plan 075 Phase 2), cached per isolate so a promoted shard doesn't add a
 * round-trip to every WS upgrade. Fails closed to `0` (owner-served) on any error,
 * so a relay-probe hiccup can never break a connection.
 */
const probeRelayCount = async (namespace: ShardNamespaceLike, shardKey: string): Promise<number> => {
    const now = Date.now();
    const cached = relayProbeCache.get(shardKey);

    if (cached !== undefined && cached.expiresMs > now) {
        return cached.relayCount;
    }

    // Drop the stale entry on a read-miss so an expired, never-re-probed key can't
    // linger for the isolate's lifetime.
    if (cached !== undefined) {
        relayProbeCache.delete(shardKey);
    }

    let relayCount = 0;

    try {
        const response = await resolveShard(namespace, shardKey).fetch(new Request("https://shard.internal/_lunora/route"));

        if (response.ok) {
            const body: unknown = await response.json();
            const reported = (body as { relayCount?: unknown }).relayCount;

            if (typeof reported === "number" && reported > 0) {
                relayCount = Math.floor(reported);
            }
        }
    } catch {
        relayCount = 0;
    }

    // Bound the cache before inserting so a high-cardinality shard set can't grow
    // the map without limit.
    evictOldestEntry(relayProbeCache, RELAY_PROBE_MAX_ENTRIES);
    relayProbeCache.set(shardKey, { expiresMs: now + RELAY_PROBE_TTL_MS, relayCount });

    return relayCount;
};

/**
 * Find the env binding name holding the shard DO namespace, so the runtime can tell
 * each DO how to address its siblings for the relay hub (`x-lunora-shard-binding`).
 * Matched by identity against the un-jurisdictioned `options.shardDO`.
 * @returns the binding key (e.g. `"SHARD"`), or `undefined` when it can't be found (relay tier stays inert)
 */
const resolveShardBindingName = (env: unknown, namespace: ShardNamespaceLike): string | undefined => {
    if (env === null || typeof env !== "object") {
        return undefined;
    }

    return Object.entries(env).find(([, value]) => value === namespace)?.[0];
};

/** Build the POST the shard's `/rpc` route expects: `{ args, functionPath }` under the caller's headers. */
const shardRpcRequest = (functionPath: string, args: Record<string, unknown>, headers: Record<string, string>): Request =>
    new Request("https://shard.internal/rpc", { body: JSON.stringify({ args, functionPath }), headers, method: "POST" });

/** The server-minted identity trio the DOs trust verbatim on an upgrade. */
const IDENTITY_HEADER_NAMES = ["x-lunora-userid", "x-lunora-identity", "x-lunora-identity-exp"] as const;

/**
 * SECURITY: strip any client-supplied copy of the identity trio from an upgrade
 * clone, then re-set the server-minted values off `resolveForwardContext`'s
 * headers — an absent resolved value stays stripped, so an anonymous caller can
 * never smuggle a forged `x-lunora-userid` through to the DO.
 */
const setIdentityHeaders = (headers: Headers, forwardedHeaders: Record<string, string>): void => {
    for (const name of IDENTITY_HEADER_NAMES) {
        headers.delete(name);

        const value = forwardedHeaders[name];

        if (value !== undefined) {
            headers.set(name, value);
        }
    }
};

/**
 * Clone an upgrade request's headers with EVERY client-supplied `x-lunora-*`
 * header stripped, then the server-minted identity trio re-set.
 *
 * SECURITY: the DOs trust `x-lunora-*` verbatim (identity trio;
 * `x-lunora-shard-binding`, used to address relay siblings via `env[binding]`;
 * `x-lunora-system` / `-client-ip` on the RPC path), so a forged copy that
 * survives the strip is a privilege escalation. Every upgrade path shares this
 * one implementation — two hand-rolled copies had already diverged, one of them
 * deleting from a LIVE `Headers` iterator, which skips entries and left forged
 * headers standing. The keys are snapshotted before deleting for exactly that
 * reason. Non-`x-lunora-` headers (crucially `Upgrade: websocket`) are preserved.
 */
const buildUpgradeHeaders = (request: Request, forwardedHeaders: Record<string, string>): Headers => {
    const headers = new Headers(request.headers);

    // NOTE: the snapshot must stay in its own binding. Spreading inline in the
    // `for…of` trips `unicorn/no-useless-spread`, whose autofix drops the spread
    // and restores the live-iterator bug.
    const clientHeaderNames = [...headers.keys()];

    for (const name of clientHeaderNames) {
        if (name.startsWith("x-lunora-")) {
            headers.delete(name);
        }
    }

    setIdentityHeaders(headers, forwardedHeaders);

    return headers;
};

/**
 * Constant-time-ish bearer check used by the admin endpoints. We accept the
 * token as a verbatim string match because the worker's existing
 * `Authorization` header handling is also plain — the per-shard gate is what
 * provides the constant-time check downstream.
 */

/**
 * Verify an HMAC-SHA-256 (base64url, unpadded) signature over `body` against
 * `secret`. Mirrors `@lunora/scheduler`'s `signDispatch` via the shared
 * `signCanonical` (same envelope, one implementation). We re-derive the expected
 * signature and constant-time compare the encoded strings so a forged or absent
 * signature can never authenticate a dispatch.
 */
const verifyHmacSignature = async (secret: string, body: string, suppliedSignature: string): Promise<boolean> => {
    if (secret.length === 0 || suppliedSignature.length === 0) {
        return false;
    }

    return constantTimeEqual(await signCanonical(secret, body), suppliedSignature);
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
 * instead (the studio sends it there as the client's `wsToken`). Accepts either
 * the master admin token (backward compatible) or a short-lived sub-token
 * minted by `POST /_lunora/admin/ws-token` — the studio sends the ephemeral
 * token so the master credential never lands in URLs/logs.
 */
const checkAdminWsToken = async (request: Request, expected: string | undefined, requireEphemeral: boolean): Promise<boolean> => {
    if (!expected || expected.length === 0) {
        return false;
    }

    const supplied = new URL(request.url).searchParams.get("token");

    if (supplied === null) {
        return false;
    }

    if (await verifyWsAdminToken(expected, supplied)) {
        return true;
    }

    // Enforcement: with `requireEphemeralWsToken` on, a raw master token in the
    // URL is rejected — the query string is exactly where it leaks (logs /
    // history / Referer). The header bearer path (`requestIsAdmin`) is
    // unaffected; browsers can't set it on a WS upgrade,
    // so it never rides a URL.
    if (requireEphemeral) {
        return false;
    }

    return constantTimeEqual(expected, supplied);
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

    /**
     * Cloudflare Queues consumer entry — present only when the app declares push
     * queues. Forwards each delivered `MessageBatch` to the configured
     * {@link WorkerOptions.queue} handler; a no-op when none is set.
     */
    queue?: (batch: unknown, env: unknown, context: ExecutionContextLike) => Promise<void>;
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
     * @param options.context The host's `ExecutionContext`. Required to reach an
     * identity the platform supplies out-of-band rather than on the
     * request — `context.access` under a Worker-scoped Cloudflare
     * Access policy. Omit it there and the call resolves anonymous
     * while the same user's `/_lunora/rpc` traffic is authenticated.
     * @param options.shardKey Routes to a specific shard (omitted → the worker's
     * `defaultShardKey`).
     * @param options.waitUntil The host's `waitUntil`, so dispatch telemetry
     * whose export is deferred (a gzipped OTLP body) survives isolate teardown.
     */
    serverQuery: (
        request: Request,
        env: unknown,
        reference: unknown,
        args?: Record<string, unknown>,
        options?: { context?: ExecutionContextLike; shardKey?: string; waitUntil?: (promise: Promise<unknown>) => void },
    ) => Promise<Response>;
}

/**
 * Structurally detect a health probe for one `env` binding (plan 177). Auto-detection
 * is binding-name-agnostic and cheap: a D1 database (`.prepare`/`.batch`/`.dump`) gets
 * an active `SELECT 1` probe (critical); R2 / queue / Hyperdrive bindings get a
 * presence-only probe (non-critical, no billable remote op). Returns `undefined` for
 * a value that matches no known binding shape.
 */
const detectBindingProbe = (key: string, value: unknown): HealthProbe | undefined => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return undefined;
    }

    const shape = value as Record<string, unknown>;

    // D1Database: `.prepare` + `.batch` + `.dump`. Active `SELECT 1`.
    if (typeof shape["prepare"] === "function" && typeof shape["batch"] === "function" && typeof shape["dump"] === "function") {
        return d1Probe(`d1:${key}`, value as { prepare: (sql: string) => { first: () => Promise<unknown> } });
    }

    // R2Bucket: `.list` + `.head` + `.createMultipartUpload`. Presence only.
    if (typeof shape["list"] === "function" && typeof shape["head"] === "function" && typeof shape["createMultipartUpload"] === "function") {
        return presenceProbe(`r2:${key}`, true);
    }

    // Queue: `.send` + `.sendBatch`, no `.get`. Presence only.
    if (typeof shape["send"] === "function" && typeof shape["sendBatch"] === "function" && typeof shape["get"] !== "function") {
        return presenceProbe(`queue:${key}`, true);
    }

    // Hyperdrive: exposes a `connectionString` string. Presence only.
    if (typeof shape["connectionString"] === "string") {
        return presenceProbe(`hyperdrive:${key}`, true);
    }

    return undefined;
};

/**
 * Refuse to build a worker whose paywall cannot see the functions it is meant to
 * charge for.
 *
 * `.x402({ price })` tags live on the `functions` registry, so with no registry
 * there is nothing to read them off: every paid procedure would dispatch FREE —
 * no 402, no settlement, no diagnostic — under a docblock promising the paywall
 * is fail-closed by construction. `defineApp()` always supplies the registry, so
 * only a hand-rolled `createWorker({ shardDO, x402Charge })` can land here, and
 * that is a configuration mistake with exactly one honest moment to report it:
 * when the worker is built. Warning per isolate while paid dispatches sail
 * through trades a revenue/authorization hole for a log line nobody reads.
 */
const assertX402Configurable = (options: WorkerOptions): void => {
    if (options.x402Charge !== undefined && options.functions === undefined) {
        throw new LunoraError(
            "`x402Charge` requires `functions`: paid (.x402) procedures are read from the function registry, so without it every paid procedure would dispatch FREE. Build the worker with `defineApp()` (which supplies the registry) or pass `functions` explicitly.",
            { code: "MISCONFIGURED", status: 500 },
        );
    }
};

/**
 * Build a Cloudflare Worker entry. Returns an object with `fetch` so it can
 * be re-exported directly as `export default createWorker(...)`.
 */
const createWorker = (options: WorkerOptions): LunoraWorker => {
    assertX402Configurable(options);

    // Resolved once here rather than per request: the trust policy is fixed for
    // the worker's lifetime, so a dispatch pays a single predicate call.
    const isTrustedUpstream = resolveTraceTrust(options.trustInboundTraceContext);
    const noticeDroppedTrace = createDroppedTraceNotice(options.trustInboundTraceContext);
    const defaultShard = options.defaultShardKey ?? "__root__";

    // The trust-boundary identity gate: only the PUBLIC data paths (RPC /
    // WebSocket / HTTP-action / server-query) use this wrapped resolver, which
    // validates every resolved identity against the `defineIdentity(...)` contract
    // (when configured) before it becomes `ctx.auth`. The admin forward path keeps
    // the raw `options.resolveIdentity` — admin is gated by the bearer / Access,
    // not the app's identity contract. See `wrapResolverWithContract`.
    const publicResolveIdentity: WorkerOptions["resolveIdentity"] = wrapResolverWithContract(options.resolveIdentity, options.identity);

    // Pin every DO this worker reaches to the configured jurisdiction exactly
    // once, here at the boundary. Downstream routing (`forwardToShard`,
    // `coordinator.fanOut`, the scheduler stubs) reads these derived namespaces
    // instead of `options.shardDO`/`options.schedulerDO`, so the residency
    // constraint flows everywhere without threading it through each call.
    // When `options.jurisdiction` is unset these are the bindings unchanged.
    const shardDO = applyJurisdiction(options.shardDO, options.jurisdiction);
    const schedulerDO = options.schedulerDO === undefined ? undefined : applyJurisdiction(options.schedulerDO, options.jurisdiction);

    /**
     * Every worker→shard hop, with the app's placement policy applied in one
     * place. A shard that already exists ignores the hint, so this is safe to
     * call on the hot path; a shard being created for the first time lands
     * where `options.shardRegion` says instead of wherever the creating request
     * happened to run.
     */
    /** One log line per isolate when a residency pin makes the placement hints inert. */
    let warnedPlacementUnderResidency = false;

    /**
     * Drop a region hint when the deployment is pinned to a jurisdiction.
     *
     * A jurisdiction is a hard residency constraint; a region is an advisory
     * hint. Composing them would mean asking the platform to honour both, and
     * that pairing is not something any runtime available here can answer:
     * workerd rejects `.jurisdiction()` outright ("Jurisdiction restrictions are
     * not implemented in workerd" — see `placement.workerd.test.ts`), so the
     * combination is unreachable in dev, in CI, and in every test, and would
     * first execute in production on exactly the deployments that chose
     * residency because correctness matters most to them.
     *
     * Shipping the untested pairing risks failing every dispatch to buy a
     * placement refinement; dropping the hint costs only the refinement, and the
     * jurisdiction already constrains placement to the region that matters. So
     * residency wins, and the operator is told once rather than left to wonder
     * why `shardRegion` reads as ignored.
     */
    const placementUnderResidency = (locationHint: RegionHint | undefined): RegionHint | undefined => {
        if (locationHint === undefined || options.jurisdiction === undefined) {
            return locationHint;
        }

        if (!warnedPlacementUnderResidency) {
            warnedPlacementUnderResidency = true;

            // eslint-disable-next-line no-console -- a silently ignored placement policy is worse than a log line
            console.warn(
                `[lunora] jurisdiction "${options.jurisdiction}" pins placement, so region hints (\`shardRegion\`, replica and relay placement) are not sent. Residency wins.`,
            );
        }

        return undefined;
    };

    const forwardToShard = async (
        namespace: ShardNamespaceLike,
        shardKey: string,
        request: Request,
        locationHint: RegionHint | undefined = options.shardRegion?.(shardKey),
    ): Promise<Response> => resolveShard(namespace, shardKey, placementUnderResidency(locationHint)).fetch(request);

    // Effective admin bearer for the request-time `/_lunora/admin/*` gates: the
    // explicit `options.adminToken`, or — when unset (the `composeWorker` default,
    // since the generated worker entry doesn't thread it) — `env.LUNORA_ADMIN_TOKEN`.
    // Resolved once per isolate from the first request's env (env is constant
    // within an isolate, so no cross-request race), mirroring `ensureSecurityResolved`.
    // Without this, the local Studio's admin calls would 403 even though both it
    // and the worker read the same `LUNORA_ADMIN_TOKEN` from `.dev.vars`.
    let envAdminToken: string | undefined;
    const effectiveAdminToken = (): string | undefined => options.adminToken ?? envAdminToken;

    // Ephemeral-WS-token enforcement: the explicit worker option, or — when
    // unset — the `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` env knob (resolved once
    // per isolate alongside the admin token, same env-is-constant reasoning).
    // Default ON: a WS upgrade's `?token=` accepts only the 60s sub-token, since
    // a URL query string lands in access logs, browser history and `Referer` —
    // exactly where the master admin credential must never be. The studio already
    // mints and sends the ephemeral token; opting out (`…=off`) restores the old
    // master-token-in-URL behaviour.
    let envRequireEphemeralWsToken: boolean | undefined;
    const effectiveRequireEphemeralWsToken = (): boolean => options.requireEphemeralWsToken ?? envRequireEphemeralWsToken ?? true;
    // The env binding name holding the shard namespace, resolved once per isolate
    // from the first request's env (same env-is-constant reasoning as the admin
    // token). A replica needs it to address its owner — it is the only way a DO
    // learns how to reach a sibling — so a replica-routed read carries it the way
    // the WS-upgrade path already does for the relay tier.
    let shardBindingName: string | undefined;

    /**
     * Capture everything the worker derives from `env` once per isolate, on the
     * first request (env is constant within an isolate): the admin bearer, the
     * ephemeral-WS-token knob, and the shard namespace binding name.
     */
    const captureEnvDerivedConfig = (env: unknown): void => {
        const record = (env ?? {}) as Record<string, unknown>;

        shardBindingName ??= resolveShardBindingName(env, options.shardDO);

        if (envRequireEphemeralWsToken === undefined && options.requireEphemeralWsToken === undefined) {
            const raw = record["LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN"];

            if (typeof raw === "string" && raw.length > 0) {
                envRequireEphemeralWsToken = isEnvFlagEnabled(raw, true);
            }
        }

        if (envAdminToken !== undefined || options.adminToken !== undefined) {
            return;
        }

        const value = record["LUNORA_ADMIN_TOKEN"];

        if (typeof value === "string" && value.length > 0) {
            envAdminToken = value;
        }
    };

    // Per-request admin grants from `options.adminGate` (e.g. a verified Cloudflare
    // Access identity). `handle` evaluates the async gate once for `/_lunora/admin/*`
    // requests and records the granted request here; the per-route gates consult it
    // through `requestIsAdmin`, so an Access-authorized request passes the same SYNC
    // gates the static bearer does — without threading async verification through
    // every extracted admin-route builder. A `WeakSet` keyed by the request lets the
    // entry be collected with the request, and concurrent requests never alias.
    const accessAdminGrants = new WeakSet<Request>();

    // The unified admin predicate every `/_lunora/admin/*` gate routes through: the
    // static bearer, OR a grant `handle` recorded from `options.adminGate`.
    const requestIsAdmin = (request: Request): boolean => checkAdminAuth(request, effectiveAdminToken()) || accessAdminGrants.has(request);

    /**
     * Evaluate `options.adminGate` once for this request and record the grant
     * `requestIsAdmin` consults. A gate that throws degrades to "no grant" — fail
     * closed for the gate, open for the static bearer — so a request carrying a
     * valid admin token is never locked out and the throw never 500s the request.
     *
     * Callers decide WHERE it is worth paying for: `applyAdminGate` runs it for
     * `/_lunora/admin/*` (so the async verification never touches the `/_lunora/rpc`
     * + `/_lunora/ws` data hot path), and `serveReservedWorkerRpc` runs it for the
     * two admin RPCs the worker serves at `/_lunora/rpc`, after the envelope has
     * already named one of them.
     */
    const recordAdminGrant = async (request: Request): Promise<void> => {
        if (options.adminGate === undefined || accessAdminGrants.has(request)) {
            return;
        }

        try {
            // Polarity here is INVERTED — truthy GRANTS admin — so an unnarrowed
            // verdict is the worst of the three: a gate returning a claims object,
            // a `Response`, or `{ ok: false }` would unlock every `/_lunora/admin/*`
            // route. `grants` requires the exact `true`.
            if (await grants(options.adminGate(request, executionContextByRequest.get(request)))) {
                accessAdminGrants.add(request);
            }
        } catch {
            // No grant recorded; `requestIsAdmin` still honours the static admin token.
        }
    };

    // Forward-context for the cross-shard admin orchestrators (migrate / rank /
    // pitr / export / import / …). They authorize fanned-out per-shard RPCs by
    // forwarding the inbound `Authorization` bearer, which an Access-authorized
    // admin request never carries — it presented a `Cf-Access-Jwt-Assertion`,
    // consumed by the edge `adminGate`. So an Access-only admin would clear the
    // edge gate yet have every downstream shard admin gate reject the fan-out.
    // When the request holds a recorded Access grant and brings no bearer of its
    // own, mint the worker's own configured admin token into the forwarded
    // headers, so the per-shard gates (which trust only the static bearer) accept
    // the orchestrated calls. No static token configured → nothing to mint, and
    // the operation fails closed downstream exactly as before.
    const resolveAdminForwardContext = async (request: Request, env: unknown): Promise<ForwardContext> => {
        const context = await resolveForwardContext(request, env, options.resolveIdentity);

        if (accessAdminGrants.has(request) && context.headers["authorization"] === undefined) {
            const token = effectiveAdminToken();

            if (token !== undefined) {
                context.headers["authorization"] = `Bearer ${token}`;
            }
        }

        return context;
    };

    // Fan-out and non-default shard routing are privileged: without an
    // `authorize*` callback a client-named non-default shard (potential
    // cross-tenant access) or a cross-shard fan-out is DEFAULT-DENIED. The
    // operator can restore the open posture explicitly with
    // `allowUnauthenticatedShardAccess: true` (e.g. a single-tenant app that
    // relies entirely on per-row RLS), which allows it and warns once so the
    // gap stays visible in logs. This fails closed by default — previously the
    // posture was warn-once-then-allow, which meant a production misconfig was
    // silent after the first request per isolate.
    let warnedUnauthenticatedShardAccess = false;

    /** One log line per isolate for a `replicaReads` that cannot take effect (see {@link replicaTargetFor}). */
    let warnedReplicaReadsWithoutRegistry = false;
    const warnReplicaReadsWithoutRegistry = (): void => {
        if (warnedReplicaReadsWithoutRegistry) {
            return;
        }

        warnedReplicaReadsWithoutRegistry = true;

        // eslint-disable-next-line no-console -- a silently inert feature flag is worse than a log line
        console.warn("[lunora] `replicaReads: true` has no effect without `functions` — read eligibility is decided from the function registry.");
    };

    const guardUnauthenticatedShardAccess = (kind: "fan-out" | "shard"): void => {
        if (!options.allowUnauthenticatedShardAccess) {
            const callback = kind === "fan-out" ? "authorizeFanOut" : "authorizeShard";

            throw new LunoraError(
                `${kind} access is default-denied: configure \`${callback}\` on the worker, or set \`allowUnauthenticatedShardAccess: true\` to explicitly allow unauthenticated ${kind} access (relying solely on per-row RLS).`,
                { code: kind === "fan-out" ? "FORBIDDEN_FANOUT" : "FORBIDDEN_SHARD", status: 403 },
            );
        }

        if (warnedUnauthenticatedShardAccess) {
            return;
        }

        warnedUnauthenticatedShardAccess = true;

        // eslint-disable-next-line no-console -- surface the acknowledged open authorization posture in logs
        console.warn(
            [
                `[lunora] SECURITY: serving ${kind} access with \`allowUnauthenticatedShardAccess: true\` and no \`authorizeShard\`/\`authorizeFanOut\` — `,
                `any caller (including unauthenticated ones) can target any shard / fan out across the table. `,
                `This is safe only if every table is protected by per-row RLS. Configure \`authorizeShard\`/\`authorizeFanOut\` to gate it.`,
            ].join(""),
        );
    };

    /**
     * Per-shard authorization for a client-originated request, shared by the
     * RPC, REST, `serverQuery`, and WebSocket-upgrade paths: run
     * `authorizeShard` when configured (403 `FORBIDDEN_SHARD` on deny);
     * otherwise a non-default shard is default-denied via
     * {@link guardUnauthenticatedShardAccess}.
     *
     * Server-initiated dispatch does not call this — see
     * {@link WorkerOptions.authorizeShard} for why.
     */
    const assertShardAuthorized = async (identity: ResolvedIdentity | null, shardKey: string): Promise<void> => {
        // `::relay::` / `::replica::` are RESERVED: only the runtime mints those
        // names, and a DO reads its own name to learn its role. A client-supplied
        // key carrying either infix therefore addresses a DO that believes it is
        // another shard's relay or replica — and this is the one gate every
        // client-originated key crosses (RPC, REST, `serverQuery`, WS upgrade), so
        // it is refused here rather than at each mint site. Ahead of
        // `authorizeShard`: the name is malformed whatever the policy says.
        if (shardKey.includes(RELAY_NAME_INFIX) || shardKey.includes(REPLICA_NAME_INFIX)) {
            throw new LunoraError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
        }

        if (options.authorizeShard) {
            const allowed = await grants(options.authorizeShard({ identity, shardKey }));

            if (!allowed) {
                throw new LunoraError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
            }
        } else if (shardKey !== defaultShard) {
            guardUnauthenticatedShardAccess("shard");
        }
    };

    // The cross-shard orchestration (`migrate` / `rank` / `rankpage` /
    // `shard-traffic`) + single-shard `pitr` handlers live in a sibling module;
    // they reach the admin gate, coordinator, shard namespace, and forward
    // helpers through injected deps (mirroring the other extracted clusters).
    const orchestrationAdminRoutes = buildOrchestrationAdminRoutes({
        defaultShard,
        forwardToShard,
        isAdmin: requestIsAdmin,
        queryCoordinator: options.queryCoordinator,
        resolveForwardContext: resolveAdminForwardContext,
        shardDO,
    });

    /**
     * Forward a server-initiated function call (a scheduler dispatch or a firing
     * cron job) to its shard: POST `{ functionPath, args }` to the shard's RPC.
     *
     * The app's `authorizeShard` gate is deliberately NOT applied here. It is a
     * gate on callers, and this dispatch has none: both entry points are already
     * inside the trust boundary (the worker's own `scheduled()` handler, and
     * `handleSchedulerDispatch`, which verifies an HMAC signature or admin bearer
     * before it gets here). Running the gate anyway meant passing a `null`
     * identity that the app could not distinguish from an anonymous end user, so
     * the natural gate (`identity?.userId !== undefined`) 403'd every cron and
     * scheduled job — with the DO retrying forever and nothing in the app's logs
     * naming the cause. The reserved `__lunora_admin__:*` RPCs are exempted from
     * the same gate for the same reason.
     */
    const dispatchToShard = async (
        functionPath: string,
        args: Record<string, unknown>,
        shardKey: string,
        mutationId?: string,
        forwardedIdentity?: { identity?: string; userId?: string },
        traceparent?: string,
    ): Promise<Response> => {
        // The scheduler-dispatch endpoint takes `functionPath` off a request body and a
        // cron target is app-authored — neither can legitimately be the reserved
        // fan-out-only reader, and this path stamps the system flag below.
        assertNotReservedRelationPath(functionPath);

        // `x-lunora-system` marks this as a trusted server-initiated dispatch so the
        // shard may run `internal` functions (scheduled/cron jobs are typically
        // internal). Authorization was already enforced above; this header is set
        // only here, never on the client RPC path.
        const headers: Record<string, string> = { "content-type": "application/json", "x-lunora-system": "1" };

        // A trusted server dispatch may ALSO carry a verified caller identity (e.g.
        // a voice session attributing its thread writes to the socket's user). The
        // shard reconstructs identity from these headers independently of the system
        // flag, so `x-lunora-system: "1"` and a userId coexist — the call runs with
        // system privileges AND the caller's RLS/ownership context. Only reachable
        // from the admin/HMAC-gated scheduler-dispatch endpoint, so these values
        // already passed the runtime's own `resolveForwardContext` mint upstream.
        if (forwardedIdentity?.userId !== undefined && forwardedIdentity.userId.length > 0) {
            headers["x-lunora-userid"] = forwardedIdentity.userId;
        }

        if (forwardedIdentity?.identity !== undefined && forwardedIdentity.identity.length > 0) {
            headers["x-lunora-identity"] = forwardedIdentity.identity;
        }

        // A stable per-job dedup key makes an at-least-once re-fire safe: the DO
        // idempotency table (keyed on `(identity, mutation-id)`) collapses a repeat
        // dispatch — e.g. a scheduler retry after the origin response was lost but
        // the side effect already committed — so the job's effect isn't applied
        // twice. Without it, at-least-once delivery double-applies non-idempotent
        // handlers. Server-initiated dispatch shares the one `"system:"` namespace
        // (it originates inside the trust boundary), but the caller passes a unique
        // per-job id so `("system:", id)` stays unique across distinct jobs.
        if (mutationId !== undefined && mutationId.length > 0) {
            headers["x-lunora-mutation-id"] = mutationId;
        }

        // Join the caller's trace when there is one. Without it the shard mints a
        // fresh trace for every server-initiated dispatch, so a cron's span was a
        // childless root and each function it fired was an unrelated orphan trace.
        // Only reachable from the admin/HMAC-gated paths above, so the value is
        // already inside the trust boundary — no inbound-trust policy applies.
        if (traceparent !== undefined && traceparent.length > 0) {
            headers.traceparent = traceparent;
        }

        return forwardToShard(shardDO, shardKey, shardRpcRequest(functionPath, args, headers));
    };

    /**
     * Start a durable-workflow instance: resolve `binding` off `env` and
     * `create()` it with `args` as its `params`. A missing/malformed binding is a
     * hard failure (the job can't run) surfaced as a 500, so the caller's
     * invocation fails rather than silently no-op'ing. Shared by cron-fire
     * ({@link runOneCronJob}) and one-shot scheduler dispatch
     * ({@link handleSchedulerDispatch}); `label` names the caller in the error.
     *
     * `instanceId` is the idempotency key, and the two callers answer it
     * differently on purpose.
     *
     * **Scheduler dispatch passes the record id.** That path is at-least-once: a
     * DO eviction, an edge 502 or a transport blip after this origin already
     * started the workflow makes `SchedulerDO.dispatch()` report failure, and
     * `recordRetry` re-fires the SAME record up to `MAX_RETRY_ATTEMPTS` times
     * (`reindexOrphanedRecords` and `drainRecord`'s swallowed post-success cleanup
     * re-fire it too). Without an id Cloudflare mints a fresh random instance for
     * each of those, so one scheduled job runs its whole pipeline up to five times
     * — while two scheduler docblocks justify the retry loop with "idempotent
     * dispatch keyed by record id". The record id is already on the wire, and
     * `resolveScheduleId` constrains it to `^\w[\w-]{0,63}$`, which is inside the
     * engine's own `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` (and well inside its 100-char
     * ceiling) — so `create({ id })` accepts it. That containment is the whole
     * reason the leading character is constrained at all: base64url mints `-` as
     * often as any other character, and a leading one is a VALIDATION rejection
     * here, which {@link isDuplicateInstanceError} does not match and the
     * scheduler therefore retries to `dead:` five attempts later.
     *
     * **The cron path passes nothing.** There is no record id there, every
     * scheduled fire of an expression is a distinct run, and the admin "Run now"
     * trigger has to be repeatable on demand — a stable per-job key would make the
     * second fire a duplicate and silently never run again. Cron has no re-fire
     * loop to dedupe against, so a fresh instance per fire is the correct
     * semantics rather than a gap.
     *
     * A duplicate-instance rejection is therefore SUCCESS: it is the proof that a
     * previous attempt's create already landed. Every other rejection propagates,
     * so the record stays retryable.
     */
    const startWorkflowInstance = async (binding: string, args: Record<string, unknown>, env: unknown, label: string, instanceId?: string): Promise<void> => {
        const candidate = (env as Record<string, unknown> | null | undefined)?.[binding];

        if (!candidate || typeof (candidate as { create?: unknown }).create !== "function") {
            throw new LunoraError(`${label} targets workflow binding "${binding}", which is not bound on env`, {
                code: "CRON_JOB_FAILED",
                status: 500,
            });
        }

        // `args` may carry app-forwarded, user-derived input (e.g. a public
        // mutation's `ctx.scheduler.runAfter(workflowRef, args)`) — reject the
        // reserved workflow branch-marker key at this trust boundary the same as
        // every other create surface, or a forged marker could reach a child's
        // `event.payload` and spoof events into an arbitrary workflow instance.
        if (hasBranchMarker(args)) {
            throw new LunoraError(`${label} params ${BRANCH_MARKER_REJECTION}`, {
                code: "BAD_REQUEST",
                status: 400,
            });
        }

        try {
            await (candidate as WorkflowBindingLike).create(instanceId === undefined ? { params: args } : { id: instanceId, params: args });
        } catch (error: unknown) {
            if (!isDuplicateInstanceError(error)) {
                throw error;
            }
        }
    };

    /**
     * Run one code-defined cron job: start its durable workflow instance, or
     * dispatch its function to the shard (a non-2xx response is a failure).
     * Throws a {@link LunoraError} on failure so both the scheduled-fire loop and
     * the manual `/cron-jobs/run` trigger surface the same error shape.
     */
    const runOneCronJob = async (job: CronJobDispatch, env: unknown, traceparent?: string): Promise<void> => {
        if (job.workflow) {
            await startWorkflowInstance(job.workflow, job.args ?? {}, env, `cron job "${job.name}"`);

            return;
        }

        if (job.functionPath === undefined) {
            throw new LunoraError(`cron job "${job.name}" has neither a function target nor a workflow target`, {
                code: "CRON_JOB_FAILED",
                status: 500,
            });
        }

        const response = await dispatchToShard(job.functionPath, job.args ?? {}, job.shardKey ?? defaultShard, undefined, undefined, traceparent);

        if (!response.ok) {
            // A failed background job is operationally a 500-class "didn't run",
            // not a client error — keep the shard's transport status in the
            // message rather than overloading the error `status`.
            throw new LunoraError(`cron job "${job.name}" (${job.functionPath}) failed with shard status ${String(response.status)}`, {
                code: "CRON_JOB_FAILED",
                status: 500,
            });
        }
    };

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
        if (!requestIsAdmin(request)) {
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

    /**
     * Dispatch every code-defined cron job declared under the firing expression,
     * collecting per-job failures into `errors` so one failing job neither aborts
     * the others nor is swallowed.
     * @returns how many jobs were declared under `cron` — 0 means the expression
     * matched nothing, which the caller reports rather than treating as success.
     */
    const runCronJobs = async (cron: string, env: unknown, errors: Error[], toError: (error: unknown) => Error, traceparent?: string): Promise<number> => {
        const cronJobs = options.cronJobs?.[cron];

        if (!cronJobs) {
            return 0;
        }

        for (const job of cronJobs) {
            try {
                // eslint-disable-next-line no-await-in-loop -- intentional: jobs on one expression run sequentially for deterministic order and to avoid a concurrent-RPC herd against a single shard
                await runOneCronJob(job, env, traceparent);
            } catch (error: unknown) {
                errors.push(toError(error));
            }
        }

        return cronJobs.length;
    };

    /**
     * Manually trigger one code-defined cron job by name — the same dispatch the
     * scheduled fire uses, on demand from the studio's "Run now" action. Looks the
     * job up across every cron expression (names are unique project-wide), runs it
     * once, and reports success or the dispatch error. Admin-gated like the other
     * `/_lunora/admin/*` mutations.
     */
    const handleRunCronJob = async (request: Request, env: unknown): Promise<Response> => {
        assertAdminAuthorized(request);

        assertMethod(request, "POST", "cron-jobs run");

        if (!options.cronJobs) {
            throw new LunoraError("cron-jobs run endpoint requires a `cronJobs` map on the worker", { code: "CRON_JOBS_NOT_CONFIGURED", status: 400 });
        }

        const body = (await readJsonBodyWithLimit(request)) as { name?: unknown };
        const name = typeof body.name === "string" ? body.name : "";

        if (name === "") {
            throw new LunoraError("cron-jobs run endpoint requires a job `name`", { code: "BAD_REQUEST", status: 400 });
        }

        const job = Object.values(options.cronJobs)
            .flat()
            .find((candidate) => candidate.name === name);

        if (!job) {
            throw new LunoraError(`no cron job named "${name}" is registered`, { code: "CRON_JOB_NOT_FOUND", status: 404 });
        }

        await runOneCronJob(job, env);

        return Response.json({ name, ran: true }, { status: 200 });
    };

    /**
     * Release a workpool job's concurrency slot after its action settles, by
     * calling the SAME SchedulerDO instance's `/complete` (routed via the echoed
     * `instanceName`). No-op for non-pooled jobs.
     *
     * Best-effort in the sense that a failure must not fail the dispatch the
     * scheduler awaits — but understand what that costs: there is NO
     * reconciliation and NO lease. `reservePoolSlot` increments a durable counter
     * and only a matching `/complete` decrements it, so a swallowed release leaks
     * that slot for the lifetime of the pool. At the default `maxConcurrency: 1`
     * one leak wedges the pool permanently, with every later job re-arming the
     * alarm every 1000 ms and never running. Every early return from a dispatch
     * that reserved a slot must reach this call.
     */
    const releasePoolSlot = async (candidate: { id?: unknown; instanceName?: unknown; pool?: unknown }): Promise<void> => {
        const pool = typeof candidate.pool === "string" && candidate.pool.length > 0 ? candidate.pool : undefined;

        if (!pool || !schedulerDO || typeof candidate.id !== "string") {
            return;
        }

        const instanceName = typeof candidate.instanceName === "string" && candidate.instanceName.length > 0 ? candidate.instanceName : "default";

        try {
            await resolveShard(schedulerDO, instanceName).fetch(
                new Request("https://scheduler.internal/complete", {
                    body: JSON.stringify({ id: candidate.id, pool }),
                    headers: { "content-type": "application/json" },
                    method: "POST",
                }),
            );
        } catch {
            // Swallowed so a release failure can't fail the dispatch the scheduler
            // awaits. Nothing reconciles it (see above): this leaks the slot.
        }
    };

    /**
     * Receiver for the `SchedulerDO`'s scheduled-job dispatch. The scheduler DO
     * POSTs `{ functionPath, args, shardKey, scheduledFor, id }` as raw JSON,
     * authenticated by an HMAC-SHA-256 (base64url) signature over the exact body
     * in the `x-lunora-scheduler-signature` header (secret in
     * `env.LUNORA_SCHEDULER_SECRET`), or — when no HMAC secret is configured on
     * the scheduler — an `authorization: Bearer <admin token>` fallback. An
     * unsigned/forged request is rejected with 403; we never run a job we can't
     * authenticate.
     *
     * On success the job is dispatched through the SAME shard-forward path as
     * `/_lunora/rpc` and the shard's response is propagated. This request's own
     * signature/bearer check IS the authorization — the app's `authorizeShard`
     * gate judges end-user callers and does not run here (see
     * {@link WorkerOptions.authorizeShard}).
     */
    const handleSchedulerDispatch = async (request: Request, env: unknown): Promise<Response> => {
        assertMethod(request, "POST", "Scheduler dispatch");

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
            // `DISPATCH_UNAUTHENTICATED`, never a plain `FORBIDDEN`: this refusal
            // is about the CALLER's credentials, not about the function it asked
            // for. Dispatch consumers (`@lunora/queue`, `@lunora/workflow`) treat
            // a 403 as deterministic and ack the message instead of retrying — so
            // a rotated secret would silently drain the queue one message per
            // delivery. The distinct code is what keeps this retryable.
            throw new LunoraError("Scheduler dispatch requires a valid signature or admin bearer", { code: "DISPATCH_UNAUTHENTICATED", status: 403 });
        }

        let body: unknown;

        try {
            body = JSON.parse(rawBody);
        } catch {
            throw new LunoraError("Scheduler dispatch body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
        }

        const candidate = (body ?? {}) as {
            args?: unknown;
            functionPath?: unknown;
            id?: unknown;
            instanceName?: unknown;
            pool?: unknown;
            shardKey?: unknown;
            workflow?: unknown;
        };

        const args = (candidate.args ?? {}) as Record<string, unknown>;

        // Forward the scheduler record id as the idempotency key so an at-least-once
        // re-fire (a retry after the origin response was lost but the side effect
        // already committed) is deduped rather than double-applying the job. This
        // makes the scheduler's "idempotent dispatch keyed by record id" contract
        // actually hold. Derived BEFORE the workflow branch below, which returns:
        // that branch is exactly the one the scheduler's retry loop re-fires, and
        // leaving it without an id let one scheduled workflow run its whole
        // pipeline once per retry attempt.
        const recordId = typeof candidate.id === "string" && candidate.id.length > 0 ? candidate.id : undefined;

        // A workflow/agent target starts a durable instance (the args become its
        // `params`) rather than dispatching a function to a shard — the
        // `WORKFLOW_*`/`AGENT_*` binding lives on the runtime's `env`, not the DO.
        // The record id becomes the INSTANCE id, so a re-fire attaches to the
        // running instance instead of starting a second one; the function path
        // below spends the same id as the shard's replay-dedup `mutationId`.
        //
        // It still releases its pool slot. `Scheduler.runAt` accepts a
        // `WorkflowReference` alongside `RunOptions.pool`, and `reservePoolSlot`
        // reserves for ANY record carrying `pool` — so a pooled workflow job DOES
        // hold a slot, and returning before the release below wedged the pool for
        // good at the default `maxConcurrency: 1`.
        if (typeof candidate.workflow === "string" && candidate.workflow.length > 0) {
            // Deliberately NOT decoded here. A function target's args are decoded by
            // the shard, but a workflow target's become Workflow `params`, which
            // Cloudflare serialises as JSON into durable storage — so a decoded
            // `bigint` fails creation outright and a decoded `Date` silently arrives
            // as a string. The wire form IS JSON-safe, so it travels intact and
            // `createRunContext` decodes it where the handler reads `params`.
            await startWorkflowInstance(candidate.workflow, args, env, "scheduled workflow", recordId);

            await releasePoolSlot(candidate);

            return Response.json({ ok: true }, { status: 200 });
        }

        if (typeof candidate.functionPath !== "string" || candidate.functionPath.length === 0) {
            throw new LunoraError("Scheduler dispatch is missing `functionPath`", { code: "BAD_REQUEST", status: 400 });
        }

        const shardKey = typeof candidate.shardKey === "string" && candidate.shardKey.length > 0 ? candidate.shardKey : defaultShard;

        // A server-initiated dispatch may forward a verified caller identity on the
        // `x-lunora-userid` / `x-lunora-identity` headers (e.g. a voice session
        // attributing its `agents:*` thread writes to the socket's user). This
        // endpoint is admin-bearer/HMAC gated, so the caller is already trusted; the
        // headers pass through to the shard alongside the system flag for RLS.
        const identity = readForwardedIdentity(request);

        // The caller (a trigger's `ctx.run`, the scheduler DO) already opened a
        // trace and named it on the request; forward it so the dispatched function
        // is a CHILD of the work that asked for it rather than its own trace.
        const response = await dispatchToShard(candidate.functionPath, args, shardKey, recordId, identity, request.headers.get("traceparent") ?? undefined);

        // Workpool jobs hold a concurrency slot until the action settles; release
        // it. Best-effort only in that a failure can't fail this dispatch — a
        // missed release is NOT reconciled and leaks the slot (see
        // `releasePoolSlot`).
        await releasePoolSlot(candidate);

        return response;
    };

    // The `__lunora_admin__:getAuthAuditLog` handler. Unlike the shard-forwarded
    // `__lunora_admin__:*` ops, the auth audit trail is D1-backed (via
    // `@lunora/auth`'s `SqlExecutor`), so it is intercepted in `handleRpc` and
    // served HERE — admin-gated (`assertAdminAuthorized`, default-closed) through
    // the injected `authAuditReader`.
    const getAuthAuditLog = buildGetAuthAuditLog({
        assertAdmin: assertAdminAuthorized,
        getReader: () => options.authAuditReader,
    });

    /**
     * Serve the gated `__lunora_admin__:listPushSubscriptions` admin RPC — the
     * Studio Notifications page's read of registered `@lunora/notify` devices.
     * Default-closed (non-admin bearer → 403 FORBIDDEN); a `{ kind?, userId?,
     * limit? }` filter is pushed DOWN to the store (indexed + bounded server-side,
     * default cap 1000). Reads through `options.notifySubscriptionStore`
     * (bound by codegen from `defineNotify({ store })`); when absent — no notify
     * store configured — returns an empty device list rather than erroring. Every
     * device is projected to strip the Web Push `keys` and FCM `token` delivery
     * secrets so they never leave the worker.
     */
    const listPushSubscriptions = async (request: Request, args: Record<string, unknown> | undefined): Promise<Response> => {
        assertAdminAuthorized(request);

        const store = options.notifySubscriptionStore;

        if (store === undefined) {
            return Response.json({ result: encodeWire({ subscriptions: [] }) }, { headers: { "content-type": "application/json" }, status: 200 });
        }

        const rawKind = args?.["kind"];
        const rawUserId = args?.["userId"];
        const rawLimit = args?.["limit"];
        // Narrow `kind` to the store's union so the typed filter crosses the
        // structural boundary; a stray value simply means "no kind filter".
        const kindFilter = rawKind === "fcm" || rawKind === "web-push" ? rawKind : undefined;
        const userIdFilter = typeof rawUserId === "string" && rawUserId !== "" ? rawUserId : undefined;
        // Default a bound so the admin page never ships an unbounded table; a client
        // may request a smaller page but not an unbounded one. TRUNCATE FIRST, then
        // test `> 0`: a fractional request in (0, 1) truncates to 0, which the store
        // reads as "no LIMIT" (unbounded) — so a truncated-to-nothing limit must fall
        // back to the default cap, never collapse to 0 and leak the full table.
        const truncatedLimit = typeof rawLimit === "number" && Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 0;
        const limit = truncatedLimit > 0 ? Math.min(truncatedLimit, 1000) : 1000;

        // Push `{ kind, userId, limit }` DOWN to the store — filtered + bounded
        // server-side (indexed in the D1 store), not list-all-then-filter-in-memory.
        const stored = await store.list({ kind: kindFilter, limit, userId: userIdFilter });

        const subscriptions: NotifySubscriptionDevice[] = stored
            // Defense-in-depth: `{ kind, userId }` are pushed DOWN to `store.list`
            // above for the indexed perf win, but a store that ignores the filter (a
            // non-filtering `SubscriptionStore` implementation, or a test double) would
            // otherwise return everything. Re-apply the same predicate in memory so the
            // RPC is correct regardless of the store — `null` and absent `userId` both
            // read as anonymous, matching the store's `userId IS NULL` semantics.
            .filter((device) => {
                if (kindFilter !== undefined && device.kind !== kindFilter) {
                    return false;
                }

                // `null` and absent `userId` both read as anonymous, matching the
                // store's `userId IS NULL` semantics (and `userIdFilter`, which is
                // `null | string`) — a legitimate null site.
                // eslint-disable-next-line unicorn/no-null -- comparison mirrors the store's `userId IS NULL`
                return userIdFilter === undefined || (device.userId ?? null) === userIdFilter;
            })
            // Strip delivery secrets (`keys`, `token`) — the browser only needs the
            // endpoint / kind / owner / timestamps + last-send status.
            .map(({ keys: _keys, token: _token, ...device }) => device);

        // Same envelope as the shard-forwarded admin ops — see the note on
        // `getAuthAuditLog`. `client.query()` reads `decodeWire(body.result)`.
        return Response.json({ result: encodeWire({ subscriptions }) }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    /**
     * Handle the reserved single-shard RPCs the worker serves itself rather than
     * forwarding to a shard: the D1-backed auth-audit read and the notify
     * device-list read (both admin-gated, default-closed). Returns a `Response`
     * to short-circuit `handleRpc`, or `undefined` to let normal shard dispatch
     * proceed. A fan-out envelope is never worker-served. The fan-out-only
     * relation-prefix guard lives in `assertDispatchableEnvelope`, which runs first.
     */
    const serveReservedWorkerRpc = async (request: Request, envelope: RpcEnvelope): Promise<Response | undefined> => {
        if (envelope.fanOut) {
            return undefined;
        }

        if (envelope.functionPath !== GET_AUTH_AUDIT_LOG_OP && envelope.functionPath !== LIST_PUSH_SUBSCRIPTIONS_OP) {
            return undefined;
        }

        // These two are Studio endpoints served at `/_lunora/rpc`, not under
        // `/_lunora/admin/*`, so `applyAdminGate` — which is path-scoped, to keep
        // the async gate off the data hot path — never evaluated `adminGate` for
        // them and never recorded a grant. `requestIsAdmin` is then the static
        // bearer alone, so an Access-only deployment (an `adminGate` and no
        // `LUNORA_ADMIN_TOKEN`) got 403 on the Studio's auth-audit and
        // notification-device reads while every `/_lunora/admin/*` route worked.
        // Evaluated HERE rather than by widening `isAdminPath`: it runs only once
        // the envelope has been parsed and named one of these two reserved paths,
        // so ordinary RPC traffic still never pays for it.
        await recordAdminGrant(request);

        return envelope.functionPath === GET_AUTH_AUDIT_LOG_OP ? getAuthAuditLog(request, envelope.args ?? {}) : listPushSubscriptions(request, envelope.args);
    };

    // The data-movement admin routes (export / sync / connector-sync / apply /
    // import) live in a sibling module; the export/import row producers are
    // injected because they close over the worker options and are shared with
    // the scheduled R2 backup (mirroring the other extracted clusters). Threads the
    // shared `requireAdminOption` gate helper like its siblings (every route gates
    // behind the coordinator option, so no bare `assertAdmin` is needed).
    const dataMovementAdminRoutes = buildDataMovementAdminRoutes({
        applyGlobals: options.applyGlobals,
        assertAdmin: assertAdminAuthorized,
        exportCursorStore: options.exportCursorStore,
        exportSinks: options.exportSinks,
        defaultShardKey: defaultShard,
        // Codegen supplies the schema's table list, so "every table" is a real list
        // rather than an empty one. It used to be hardcoded empty with a note that
        // the seam "stays for a host that can" enumerate — `listSchemaTables` is
        // that host, and leaving this blind kept CDC sync and the export tap
        // discovering no shards at all.
        knownTables: () => [...(options.listSchemaTables?.() ?? [])],
        queryCoordinator: options.queryCoordinator,
        requireAdminOption,
        resolveForwardContext: resolveAdminForwardContext,
        shardDO,
        streamExportRows: (coordinator, headers, tables, writeRow) => streamExportRows(options, coordinator, headers, tables, writeRow, shardDO),
        streamingImport: (request, headers) => streamingImport(request, options, headers, shardDO),
        syncGlobals: options.syncGlobals,
    });

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
        if (schedulerDO === undefined) {
            throw new LunoraError("scheduled endpoints require a `schedulerDO` namespace on the worker", { code: "SCHEDULER_NOT_CONFIGURED", status: 400 });
        }

        return schedulerDO;
    };

    const resolveSchedulerStub = (request: Request): ResolvedShard => {
        assertAdminAuthorized(request);

        return resolveShard(requireSchedulerNamespace(), options.schedulerInstanceName ?? "default");
    };

    // The `/_lunora/admin/scheduled*` handlers live in a sibling module; they reach
    // the admin gate, scheduler-namespace requirement, and resolved stub through
    // injected deps (mirroring the other extracted clusters below).
    const scheduledAdminRoutes = buildScheduledAdminRoutes({
        checkWsAdmin: async (request) => requestIsAdmin(request) || checkAdminWsToken(request, effectiveAdminToken(), effectiveRequireEphemeralWsToken()),
        requireSchedulerNamespace,
        resolveSchedulerStub,
        schedulerInstanceName: options.schedulerInstanceName ?? "default",
    });

    // `/_lunora/admin/workflows*` — the studio's window onto Cloudflare Workflows
    // execution state. The REST client is built outside this package (by the
    // codegen worker entry, via `options.workflowsClient`); `@lunora/workflow` is a
    // devDep whose types are bundled by packem, so the published runtime carries no
    // `@lunora/workflow` runtime dep. Absent the client, the proxy reports "not configured".
    const workflowsAdminRoutes = buildWorkflowsAdminRoutes({
        assertAdmin: assertAdminAuthorized,
        resolveWorkflowsClient: options.workflowsClient ?? (() => undefined),
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
            storageDownload: options.storageDownload,
            storageList: options.storageList,
            storageSignedUrl: options.storageSignedUrl,
            storageUpload: options.storageUpload,
        },
    });

    // The `/_lunora/admin/backup/*` handlers live in a sibling module; they reach
    // the admin gate, the worker options and the body reader through injected deps.
    const backupAdminRoutes = buildBackupAdminRoutes({
        options,
        readJsonBody: readJsonBodyWithLimit,
        requireAdminOption,
    });

    const vectorAdminRoutes = buildVectorAdminRoutes({
        readJsonBody: readJsonBodyWithLimit,
        requireAdminOption,
        vectorIntrospector: options.vectorIntrospector,
    });

    const kvAdminRoutes = buildKvAdminRoutes({
        kvIntrospector: options.kvIntrospector,
        readJsonBody: readJsonBodyWithLimit,
        requireAdminOption,
    });

    const logArchiveAdminRoutes = buildLogArchiveAdminRoutes({
        logArchive: options.logArchive,
        readJsonBody: readJsonBodyWithLimit,
        requireAdminOption,
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

    // Health / readiness probes (plan 177). Probes are resolved per-request from
    // the invocation `env` — Cloudflare bindings only exist at request time — so a
    // fresh registry always reflects the live deployment. Auto-detection is
    // structural (no static binding-name knowledge) and deliberately cheap: the
    // DO probe issues one reachability request, D1 runs `SELECT 1`, and R2 / queue
    // / Hyperdrive are presence-only (never a billable remote op).
    const resolveHealthProbes = (env: unknown): ReadonlyArray<HealthProbe> => {
        const probes: HealthProbe[] = [];

        // Durable Object reachability — the one dependency every deployment has.
        // Prefer the runtime's own shard namespace, falling back to `env.SHARD`.
        const namespace = (shardDO as ShardNamespaceLike | undefined) ?? (env as { SHARD?: ShardNamespaceLike } | undefined)?.SHARD;

        if (namespace !== undefined) {
            // `durable-object:default` follows the same `kind:key` shape as the
            // binding probes (`d1:…`, `r2:…`) so the public posture reduces it to
            // the safe kind `durable-object` via the shared colon rule — the `key`
            // is the fixed literal `default`, never the operator's `defaultShard`.
            probes.push(durableObjectProbe("durable-object:default", namespace, defaultShard));
        }

        if (options.health?.disableBindingProbes !== true) {
            for (const [key, value] of Object.entries((env ?? {}) as Record<string, unknown>)) {
                const probe = detectBindingProbe(key, value);

                if (probe !== undefined) {
                    probes.push(probe);
                }
            }
        }

        for (const probe of options.health?.probes ?? []) {
            probes.push(probe);
        }

        return probes;
    };

    const healthRoutes = buildHealthRoutes({
        appName: options.health?.appName,
        appVersion: options.health?.appVersion,
        auth: options.health?.auth ?? "public",
        cacheTtlMs: options.health?.cacheTtlMs,
        isAdmin: requestIsAdmin,
        resolveProbes: resolveHealthProbes,
    });

    /**
     * `ctx.scheduler` for an HTTP action — a thin RPC wrapper over the scheduler
     * DO, mirroring what `@lunora/scheduler`'s `createScheduler` does from a
     * shard. The two write to and read from the SAME records, so they must agree
     * on the envelope: both wire-encode `args` on the way in and decode a record
     * on the way out (see `create-dispatch-runner.ts` for why the hop needs
     * bracketing).
     *
     * The scheduler DO takes its callback origin from `env.LUNORA_ORIGIN_URL`
     * at both schedule and fire time — deliberately, so a request cannot steer
     * the dispatch — and answers `ORIGIN_NOT_CONFIGURED` when it is unset. So
     * nothing origin-shaped is sent from here.
     */
    const buildHttpScheduler = (namespace: ShardNamespaceLike): SchedulerContext => {
        /** Undo `schedule`'s encode on a record read back out of the DO — the mirror of `@lunora/scheduler`'s `decodeRecordArgs`. Identity for pure-JSON args. */
        const decodeRecordArgs = (record: Record<string, unknown>): Record<string, unknown> =>
            "args" in record ? { ...record, args: decodeWire(record["args"]) } : record;

        const instanceName = options.schedulerInstanceName ?? "default";
        const stub = (): ResolvedShard => resolveShard(namespace, instanceName);

        const call = async <R>(path: string, init: RequestInit): Promise<R> => {
            const response = await stub().fetch(new Request(`https://scheduler.internal${path}`, init));

            if (!response.ok) {
                throw new LunoraError(`ctx.scheduler: SchedulerDO ${path} failed (${String(response.status)}): ${await response.text()}`, {
                    code: "INTERNAL",
                    status: 500,
                });
            }

            return await response.json();
        };

        const post = async <R>(path: string, body: unknown): Promise<R> =>
            await call<R>(path, { body: JSON.stringify(body), headers: { "content-type": "application/json" }, method: "POST" });

        // A generated `workflows.<name>` / `agents.<name>` reference carries a
        // `binding` and starts a durable instance per fire; a function reference
        // carries `__lunoraRef`; a bare string is already a `"ns:fn"` path.
        const targetFields = (target: unknown): Record<string, unknown> => {
            // Deliberately NO bare-string branch, unlike the shard-side
            // `createScheduler`. These endpoints are reachable unauthenticated
            // (platform-signed webhooks), so accepting a caller-shaped
            // `"ns:fn"` would be the "call any internal function" primitive
            // this surface exists to avoid — and `run()` beside it rejects
            // anything without `__lunoraRef` for the same reason. A reference
            // from the generated `internal` / `workflows` / `agents` is a
            // literal in the app's own source and cannot come off a request.
            const candidate = target as { __lunoraRef?: unknown; binding?: unknown } | null | undefined;

            if (candidate === null || candidate === undefined) {
                throw new LunoraError("ctx.scheduler: target is required — pass a reference from the generated `internal` / `workflows` / `agents`", {
                    code: "BAD_REQUEST",
                    status: 400,
                });
            }

            if (typeof candidate.binding === "string" && candidate.binding.length > 0) {
                return { workflow: candidate.binding };
            }

            if (typeof candidate.__lunoraRef === "string") {
                return { functionPath: candidate.__lunoraRef };
            }

            throw new LunoraError(
                "ctx.scheduler: expected a reference from the generated `internal` / `workflows` / `agents` — a bare function-path string is refused here, because an HTTP action can be reached unauthenticated",
                {
                    code: "BAD_REQUEST",
                    status: 400,
                },
            );
        };

        /**
         * Walk every page of the DO's `/list` and return the records.
         *
         * The DO answers ONE bounded page (`{ records, truncated, cursor }`), so
         * handing the raw body back both breaks the declared
         * `Record<string, unknown>[]` contract and silently drops every job past
         * the page size. The walk itself is `shared/collect-pages.ts`, which
         * `@lunora/scheduler`'s `createScheduler.list()` — the shard-side client
         * of the same route — also uses, so the two cannot drift apart.
         */
        const listAll = async (): Promise<Record<string, unknown>[]> => {
            const records = await collectPages<Record<string, unknown>>(async (cursor) =>
                call<{ cursor?: string; records?: Record<string, unknown>[]; truncated?: boolean }>(
                    cursor === undefined ? "/list" : `/list?cursor=${encodeURIComponent(cursor)}`,
                    { method: "GET" },
                ),
            );

            return records.map((record) => decodeRecordArgs(record));
        };

        const schedule = async (scheduledFor: number, target: unknown, args: Record<string, unknown> = {}): Promise<string> => {
            const fields = targetFields(target);

            const { id } = await post<{ id: string }>("/schedule", {
                args: encodeArgsOrThrow("ctx.scheduler", String(fields["functionPath"] ?? fields["workflow"]), args),
                scheduledFor,
                ...fields,
            });

            return id;
        };

        return {
            cancel: async (id) => await post<{ cancelled: boolean }>("/cancel", { id }),
            // The DO answers `{ record }` — or `{}` for an id that matched
            // nothing — never the bare record, so handing its body back broke the
            // declared `Record<string, unknown> | null` and gave a caller
            // `{ record: … }` where `createScheduler.get()` gives the record.
            get: async (id) => {
                const body = await call<{ record?: Record<string, unknown> }>(`/get?id=${encodeURIComponent(id)}`, { method: "GET" });

                // eslint-disable-next-line unicorn/no-null -- public contract returns `Record<string, unknown> | null`, mirroring `createScheduler.get`
                return body.record === undefined ? null : decodeRecordArgs(body.record);
            },
            list: listAll,
            runAfter: async (delayMs, target, args) => {
                // `@lunora/scheduler`'s `assertScheduleDelay`, restated: this
                // package does not depend on `@lunora/scheduler` (it speaks to the
                // SchedulerDO over HTTP), and pulling it in for one guard would
                // add `cron-parser` to the worker entry. The CODE is kept in step
                // by hand — a caller's bad argument, never `INTERNAL`.
                if (!Number.isFinite(delayMs) || delayMs < 0) {
                    throw new LunoraError("ctx.scheduler.runAfter: `delayMs` must be a non-negative finite number", { code: "INVALID_INPUT", status: 400 });
                }

                return await schedule(Date.now() + delayMs, target, args);
            },
            runAt: async (timestampMs, target, args) => {
                // `@lunora/scheduler`'s `assertScheduleInstant`, restated for the
                // same reason `runAfter` restates its guard above — and to the same
                // CODE and MESSAGE, byte for byte. An unchecked NaN/Infinity
                // serializes to `null` through JSON and reaches the DO as a
                // malformed `scheduledFor`; an instant already in the past is an
                // overdue job, not a bad argument, so it passes.
                if (!Number.isFinite(timestampMs)) {
                    throw new LunoraError("ctx.scheduler.runAt: `date` must be a non-negative finite number", { code: "INVALID_INPUT", status: 400 });
                }

                return await schedule(timestampMs, target, args);
            },
        };
    };

    const buildHttpActionContext = async (request: Request, env: unknown, context: ExecutionContextLike): Promise<HttpActionContext> => {
        const { claims, headers, userId } = await resolveForwardContext(request, env, publicResolveIdentity);

        const sinkContext = buildSinkContext(env, request, (promise) => context.waitUntil?.(promise));

        const runOn =
            (shardKey: string) =>
            async <R>(reference: unknown, args: Record<string, unknown> = {}): Promise<R> => {
                const functionPath = (reference as { __lunoraRef?: unknown }).__lunoraRef;

                if (typeof functionPath !== "string") {
                    throw new LunoraError("ctx.run*: expected a function reference from the generated `api`", { code: "BAD_REQUEST", status: 400 });
                }

                // This path stamps `x-lunora-system: "1"` below, so an unguarded relation
                // dispatch here would read raw rows as a TRUSTED caller. The stricter
                // posture already exists one function over (`buildHttpScheduler`'s
                // `targetFields` refuses a bare `"ns:fn"` string because an HTTP action
                // can be reached unauthenticated) — same reasoning, same surface.
                assertNotReservedRelationPath(functionPath);

                // Through the SAME dispatcher the `/_lunora/rpc` and `serverQuery` paths
                // use, rather than a bare `forwardToShard`: that is what puts this call
                // in the RPC event stream and under a `traceparent`-parented span, which
                // a hand-rolled forward silently left out — a webhook route's work was
                // absent from observability while the docs promised every dispatch is a
                // span.
                //
                // Wire-bracketed in both directions, as every dispatch hop is; see
                // `create-dispatch-runner.ts`.
                //
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- `dispatchSingleShard` is a closure-captured const declared below; this arrow only ever runs per request, long after construction
                const response = await dispatchSingleShard(
                    request,
                    functionPath,
                    encodeWire(args) as Record<string, unknown>,
                    shardKey,
                    // `x-lunora-system` marks this a trusted server-initiated dispatch, so
                    // the shard will run `internal` functions — exactly as on the
                    // scheduler path above, and for the same reason.
                    //
                    // An `httpRouter` handler is app-authored worker code, not a client:
                    // the reference it passes is a literal `internal.foo.bar` from the
                    // app's own source, never a caller-supplied string, and the handler
                    // has already run whatever authorization it requires (the operator
                    // bearer on a cell-register route, a deploy-key lookup on an ingest
                    // route). Without this the route's `ctx.run*` reached the shard as an
                    // ordinary *client* RPC, and `handleRpc` — which refuses internals to
                    // anything lacking this flag — answered FUNCTION_NOT_FOUND, so every
                    // route delegating to an `internal*` function failed with a 500 that
                    // named a function the registry demonstrably contained.
                    //
                    // This widens visibility only. The shard reconstructs identity from
                    // the `x-lunora-*` headers independently of the flag, so the call
                    // still runs under the caller's RLS/ownership context; `headers` is
                    // minted by `resolveForwardContext` from a fixed allowlist that never
                    // copies `x-lunora-system` off the inbound request, so a client cannot
                    // forge it. The external client path (`/_lunora/rpc`, and SSR loaders
                    // that go through it) never passes here and stays gated.
                    { ...headers, "x-lunora-system": "1" },
                    sinkContext,
                );

                const payload: { error?: { code?: string; message?: string }; result?: unknown } = await response.json();

                if (payload.error) {
                    throw new LunoraError(payload.error.message ?? "shard RPC failed", {
                        code: payload.error.code ?? "INTERNAL",
                        status: response.status,
                    });
                }

                return decodeWire(payload.result) as R;
            };

        const run = runOn(defaultShard);

        return {
            auth: {
                getIdentity: () => Promise.resolve(claims),
                userId,
            },
            cache: context.cache,
            fetch: globalThis.fetch.bind(globalThis),
            forShard: (shardKey: string) => {
                const scoped = runOn(shardKey);

                return { runAction: scoped, runMutation: scoped, runQuery: scoped };
            },
            runAction: run,
            runMutation: run,
            runQuery: run,
            ...(schedulerDO === undefined ? {} : { scheduler: buildHttpScheduler(schedulerDO) }),
            // Bound to the execution context so a handler — or a wrapper reading
            // it structurally, e.g. `@lunora/x402`'s `withX402` receipt sink —
            // can outlive the response. Omitted entirely when the host supplied
            // no `waitUntil`, so the optional member stays honest.
            ...(context.waitUntil === undefined ? {} : { waitUntil: context.waitUntil.bind(context) }),
            // Built over the worker's own R2 bindings — an HTTP handler runs
            // where an action does, so this needs no shard hop. Absent (rather
            // than a throwing stub) when the app declared no `.storage()`, which
            // is what makes the optional `storage` on `HttpActionCtx` honest.
            ...(options.storage === undefined ? {} : { storage: asBucketStorage(options.storage(env)) }),
        };
    };

    const dispatchHttpRoute = async (request: Request, env: unknown, context: ExecutionContextLike): Promise<Response | undefined> => {
        if (!options.httpRouter) {
            return undefined;
        }

        // Build the action context up front and inject it on a private env
        // binding; the router's middleware lifts it into the handler's context.
        // hono then matches/dispatches and returns its own response (incl. 404).
        const httpContext = await buildHttpActionContext(request, env, context);

        // In-process serverQuery fast-path (PLAN4 §2.2 / §5.3): an SSR loader
        // running inside this worker can call `worker.serverQuery(request, env,
        // api.foo.bar, args, { shardKey })` to reach a Lunora query without a
        // self-`fetch` to `/_lunora/rpc`. It resolves identity + runs the
        // per-shard authorization gate identically to `handleRpc`, then
        // dispatches to the owning shard (the worker→DO hop is itself in-process
        // — not a network self-fetch). `ctx.run*` now shares that dispatcher; what
        // still separates them is the authorization gate, which `serverQuery` runs
        // and `ctx.run*` deliberately does not (it dispatches as `x-lunora-system`
        // on behalf of app-authored route code). `serverQuery` stays the
        // identity-parity-guaranteed entrypoint for loaders.

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

        // CSRF / Cross-Site WebSocket Hijacking guard. The WS handshake is a GET,
        // so the HTTP `enforceOrigin` (safe-method-exempt) never covers it, yet
        // the browser auto-attaches the session cookie here and WS is not bound
        // by CORS/SOP. Reject cross-origin cookie-bearing upgrades before we
        // resolve/forward identity — otherwise any page could open the socket as
        // the logged-in victim and read/write as them. Same-origin, token/bearer
        // (no cookie), and `csrf.trustedOrigins` upgrades pass.
        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- `resolvedSecurity` is a closure-captured `let` assigned at construction and re-resolved per request in `fetch()` before routing ever reaches this handler
        const blockedUpgrade = enforceWebSocketOrigin(request, resolvedSecurity);

        if (blockedUpgrade) {
            return blockedUpgrade;
        }

        const shardKey = url.searchParams.get("shard") ?? defaultShard;

        // Resolve the calling identity once: it both gates the shard and is
        // forwarded to the DO so the socket carries a verified userId (the basis
        // for trusted `onConnect`/`onDisconnect` lifecycle hooks). Mirrors the
        // RPC path's `resolveForwardContext` → `authorize*` ordering.
        const { headers: forwardedHeaders, identity } = await resolveForwardContext(request, env, publicResolveIdentity);

        await assertShardAuthorized(identity, shardKey);

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
        const upgradeHeaders = buildUpgradeHeaders(request, forwardedHeaders);

        // Relay tier (plan 075 Phase 2): when the shard is promoted, route this NEW
        // connection to one of its relays so the owner sheds connection + fan-out
        // load — invisible to the client (same socket, same whispers). Tell the DO
        // its namespace binding so it can address siblings for the hub.
        const binding = resolveShardBindingName(env, options.shardDO);

        if (binding !== undefined) {
            upgradeHeaders.set("x-lunora-shard-binding", binding);

            const relayCount = await probeRelayCount(shardDO, shardKey);

            if (relayCount > 0) {
                // Spread connections across the relay set at random, and hint
                // the client's region so a relay is CREATED near real traffic.
                //
                // The spread is load-levelling and stays random on purpose: the
                // relay tier exists because per-flush fan-out on one DO becomes
                // the bottleneck at ~8k sockets, so routing a whole region to
                // `hash(region) % relayCount` would pile a single-region app —
                // the common case — back onto one relay and re-create the exact
                // wall promotion was meant to escape. Locality rides on the hint
                // instead: each relay lands in the region of whichever client
                // first drew it, so a single-region app gets every relay in its
                // own region, and a multi-region one spreads them across the
                // regions actually generating load.
                // eslint-disable-next-line sonarjs/pseudo-random -- load distribution across relays, not a security-sensitive value
                const target = relayName(shardKey, Math.floor(Math.random() * relayCount));

                return forwardToShard(shardDO, target, new Request(request, { headers: upgradeHeaders }), regionHintFromRequest(request));
            }
        }

        return forwardToShard(shardDO, shardKey, new Request(request, { headers: upgradeHeaders }));
    };

    /**
     * Handle a voice-session WebSocket upgrade for `/_lunora/voice/<agentExportName>`.
     * Only registered when `options.voiceAgents` is provided (a voice-free app has
     * no route). Mirrors {@link handleWebSocketUpgrade}: enforce the WS origin
     * guard, resolve the caller's identity once, and forward the socket to the
     * agent's `VoiceSessionDO` keyed by `threadKey`, carrying the server-minted
     * `x-lunora-userid` / `x-lunora-identity` headers so the voice turn attributes
     * its thread writes to the caller. Returns 404 for an unknown agent and 400 for
     * a missing `threadKey`; never throws (a thrown upgrade handler 500s a socket).
     */
    const handleVoiceUpgrade = async (request: Request, env: unknown, url: URL): Promise<Response> => {
        const { voiceAgents } = options;

        if (voiceAgents === undefined) {
            return new Response("Not found", { status: 404 });
        }

        if (request.headers.get("Upgrade") !== "websocket") {
            return new Response("Expected a WebSocket upgrade", { headers: { allow: "GET" }, status: 426 });
        }

        // eslint-disable-next-line @typescript-eslint/no-use-before-define -- `resolvedSecurity` is a closure-captured `let` assigned at construction and re-resolved per request in `fetch()` before routing reaches this handler
        const blockedUpgrade = enforceWebSocketOrigin(request, resolvedSecurity);

        if (blockedUpgrade) {
            return blockedUpgrade;
        }

        let agentName: string;

        try {
            agentName = decodeURIComponent(url.pathname.slice(VOICE_PATH_PREFIX.length));
        } catch {
            // A malformed percent-encoding (e.g. `/_lunora/voice/%`) makes
            // `decodeURIComponent` throw `URIError` — treat an undecodable agent
            // name as an unknown agent (404) rather than a 500.
            return new Response("Unknown voice agent", { status: 404 });
        }

        const namespace = Object.hasOwn(voiceAgents, agentName) ? voiceAgents[agentName] : undefined;

        if (namespace === undefined) {
            return new Response("Unknown voice agent", { status: 404 });
        }

        const threadKey = url.searchParams.get("threadKey");

        if (threadKey === null || threadKey.length === 0) {
            return new Response("Missing threadKey", { status: 400 });
        }

        // Resolve the caller's identity once and forward it to the voice DO so the
        // session's `agents:*` thread writes are attributed to the caller (RLS /
        // ownership). Same shape/authorization ordering as the RPC/WS paths.
        const { headers: forwardedHeaders, identity } = await resolveForwardContext(request, env, publicResolveIdentity);

        // Deliberately NOT `assertShardAuthorized`, and the difference is the
        // `else`: that helper default-denies only a NON-default shard, because its
        // callers have a default shard a caller may legitimately land on. There is
        // no default voice shard — every `threadKey` is client-supplied — so this
        // path default-denies unconditionally. Routing it through the helper would
        // admit a caller who names the default shard as their `threadKey`.
        if (options.authorizeShard) {
            const allowed = await grants(options.authorizeShard({ identity, shardKey: threadKey }));

            if (!allowed) {
                // The same typed error the helper throws, so a denied voice caller
                // gets `FORBIDDEN_SHARD` like every other path rather than an
                // untyped 403 a client cannot branch on.
                throw new LunoraError("Forbidden shard", { code: "FORBIDDEN_SHARD", status: 403 });
            }
        } else {
            // Every voice `threadKey` is client-supplied and there is no default
            // voice shard, so — like the RPC/WS non-default-shard paths — this is
            // default-denied without an `authorizeShard`: an unauthenticated caller
            // must not be able to name an arbitrary threadKey and reach another
            // tenant's shared agent thread. Throws a 403 `LunoraError` (rendered by
            // the outer handler's `toErrorResponse`), overridable by
            // `allowUnauthenticatedShardAccess: true` for RLS-only single-tenant apps.
            guardUnauthenticatedShardAccess("shard");
        }

        const upgradeHeaders = buildUpgradeHeaders(request, forwardedHeaders);

        return forwardToShard(namespace, threadKey, new Request(request, { headers: upgradeHeaders }));
    };

    /**
     * Run the per-shard / fan-out authorization gate for an RPC envelope. Throws
     * a 403 `LunoraError` when the caller is not authorized. Fan-out is a
     * privileged op: when `authorizeShard` is set but `authorizeFanOut` is not,
     * fan-out is default-denied rather than silently allowed.
     */
    // Fan-out authorization, extracted from `authorizeRpcEnvelope` to keep that
    // function's cognitive complexity within budget. Fan-out envelopes target
    // every live shard for the table (no client-named shardKey), so the per-shard
    // gate cannot authorize them — `authorizeFanOut` gates fan-out at the table
    // level, and the reserved `__lunora_relation__:*` read is always default-denied
    // without it.
    const authorizeFanOutEnvelope = async (
        fanOut: NonNullable<RpcEnvelope["fanOut"]>,
        functionPath: string,
        identity: ResolvedIdentity | null,
    ): Promise<void> => {
        if (options.authorizeFanOut) {
            const allowed = await grants(options.authorizeFanOut(identity, fanOut.table, functionPath));

            if (!allowed) {
                throw new LunoraError("Forbidden fan-out", { code: "FORBIDDEN_FANOUT", status: 403 });
            }

            return;
        }

        if (functionPath.startsWith("__lunora_relation__:")) {
            // SECURITY: the reserved `__lunora_relation__:*` fan-out reads RAW,
            // RLS-blind rows from every shard (reverse cross-backend relations)
            // and — unlike `__lunora_admin__:*` — carries no DO-level token
            // backstop. So it must NEVER fall into the warn-and-allow open-posture
            // branch below: that would hand any caller a function-less full-table
            // dump across all shards. Default-deny it whenever `authorizeFanOut` is
            // absent, independent of `authorizeShard` (enabling reverse
            // cross-backend relations REQUIRES configuring `authorizeFanOut`).
            throw new LunoraError("reverse cross-backend relation reads (`__lunora_relation__:*`) require `authorizeFanOut` to be configured on the worker", {
                code: "FORBIDDEN_FANOUT",
                status: 403,
            });
        }

        if (options.authorizeShard) {
            // `authorizeShard` is configured but `authorizeFanOut` is not. Fan-out
            // is a privileged op (it bypasses the per-shard gate by design), so
            // default-deny instead of silently letting any authenticated caller
            // enumerate every shard for the table.
            throw new LunoraError("Fan-out requires `authorizeFanOut` to be configured on the worker when `authorizeShard` is set", {
                code: "FORBIDDEN_FANOUT",
                status: 403,
            });
        }

        // Neither callback configured: fan-out is default-denied unless the
        // operator explicitly opted into unauthenticated access.
        guardUnauthenticatedShardAccess("fan-out");
    };

    const authorizeRpcEnvelope = async (envelope: RpcEnvelope, identity: ResolvedIdentity | null): Promise<void> => {
        // Reserved admin RPCs (`__lunora_admin__:*`, single-shard) are privileged
        // operator calls authorized by the shard DO's admin-bearer gate
        // (`isAdminAuthorized`), NOT by the per-tenant `authorizeShard` callback —
        // an admin request carries an admin bearer, not an end-user session, so it
        // resolves to a `null` identity and `authorizeShard(null, …)` would
        // default-deny it. Skip the tenant gate so the request reaches the DO,
        // which is the real authority (and rejects a bad/absent bearer with its
        // own 403). Without this, ANY app that configures `authorizeShard` (the
        // recommended secure posture) would 403 every admin RPC — mail-capture,
        // recordAuthEvent, and the whole Studio admin surface — before it ever
        // reached the DO. A fan-out envelope with this prefix is NOT exempted: it
        // falls through to the fan-out branch below and is default-denied.
        if (!envelope.fanOut && envelope.functionPath.startsWith("__lunora_admin__:")) {
            return;
        }

        // Per-shard authorization runs after identity resolution and before the
        // request is forwarded. Fan-out routes through the table-level gate;
        // single-shard dispatch goes through `authorizeShard`.
        if (envelope.fanOut) {
            await authorizeFanOutEnvelope(envelope.fanOut, envelope.functionPath, identity);

            return;
        }

        // No per-shard gate and the caller named a non-default shard:
        // default-denied unless unauthenticated shard access is opted in.
        await assertShardAuthorized(identity, envelope.shardKey ?? defaultShard);
    };

    /**
     * The region-local replica that should answer this read, or `undefined` when
     * the read belongs on the owner.
     *
     * Deliberately narrow. Only a **query** is eligible: a mutation or action
     * has to run where the single writer is, and a `stream` is a long-lived
     * dispatch a follower has no business serving. Only a request Cloudflare
     * could geolocate is eligible, because the replica's whole point is being
     * near *this* caller. And a shard key that already carries a reserved role
     * infix is never re-targeted — that would build a replica of a replay of a
     * relay, addressing a DO nobody follows.
     */
    const replicaTargetFor = (request: Request, functionPath: string, shardKey: string): undefined | { name: string; region: RegionHint } => {
        if (options.replicaReads !== true) {
            return undefined;
        }

        // Eligibility is decided from the function registry, so a worker that
        // enables the feature without threading `functions` would get it
        // silently disabled — every read quietly owner-served, indistinguishable
        // from a replica tier that is simply cold. Say so once.
        if (options.functions === undefined) {
            warnReplicaReadsWithoutRegistry();

            return undefined;
        }

        if (options.functions[functionPath]?.kind !== "query") {
            return undefined;
        }

        if (shardKey.includes(REPLICA_NAME_INFIX) || shardKey.includes(RELAY_NAME_INFIX)) {
            return undefined;
        }

        const region = regionHintFromRequest(request);

        return region === undefined ? undefined : { name: replicaName(shardKey, region), region };
    };

    /**
     * Send one RPC to the shard that should serve it: a region-local replica for
     * an eligible read, the owner for everything else.
     *
     * A replica answers `421` when it cannot serve the read at the required
     * freshness (behind the caller's bookmark, or unable to follow its owner at
     * all). That is a routing answer, not a failure: the read is retried once
     * against the owner, which always can. There is exactly one retry — the
     * owner is the terminal target, so a second hop could only loop.
     */
    const forwardRpcToShard = async (
        request: Request,
        functionPath: string,
        args: Record<string, unknown>,
        shardKey: string,
        outgoingHeaders: Record<string, string>,
    ): Promise<Response> => {
        const replica = replicaTargetFor(request, functionPath, shardKey);

        if (replica !== undefined) {
            const replicaHeaders: Record<string, string> = {
                ...outgoingHeaders,
                "x-lunora-replica-read": "1",
                ...(shardBindingName === undefined ? {} : { "x-lunora-shard-binding": shardBindingName }),
            };

            // The caller's read-your-writes bookmark: the `commitCursor` its last
            // write returned. Client-supplied, and safe to trust because it can
            // only ever make this read STRICTER — an inflated value costs the
            // caller a fallback to the owner, it never surfaces older data.
            const minSeq = parseMinSeq(request.headers.get("x-lunora-min-seq"));

            if (minSeq !== undefined) {
                replicaHeaders["x-lunora-min-seq"] = String(minSeq);
            }

            const fromReplica = await forwardToShard(shardDO, replica.name, shardRpcRequest(functionPath, args, replicaHeaders), replica.region);

            if (fromReplica.status !== 421) {
                return fromReplica;
            }
        }

        return forwardToShard(shardDO, shardKey, shardRpcRequest(functionPath, args, outgoingHeaders));
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
        request: Request,
        functionPath: string,
        args: Record<string, unknown>,
        shardKey: string,
        forwardedHeaders: Record<string, string>,
        sinkContext?: ObservabilitySinkContext,
    ): Promise<Response> => {
        const rpcStartedAt = Date.now();
        const { observability, sampling } = options;
        const requestMeta = requestTelemetryMeta(request);

        // Open this dispatch's trace. `beginDispatchTrace` applies the inbound-trust
        // policy, mints the span, and settles the sampled verdict in one place, so
        // the span's `flags`, the `traceparent` we forward, and the export gate can
        // never disagree about whether this trace is sampled.
        const { decision, ignoredUpstream, trace } = beginDispatchTrace(request, {
            ...(sampling === undefined ? {} : { sampling }),
            trustInbound: isTrustedUpstream(request),
        });

        if (ignoredUpstream) {
            noticeDroppedTrace();
        }

        // `x-lunora-sample-errors` carries the tail-bias toggle alongside the
        // `traceparent` sampled flag, so a sampled-out trace that errors is still
        // kept whole on both the worker and the shard.
        const outgoingHeaders: Record<string, string> = {
            ...forwardedHeaders,
            "x-lunora-sample-errors": decision.keepErrors ? "1" : "0",
        };

        injectTraceContext(trace, outgoingHeaders);

        try {
            // Re-emit the RPC body at the shard's `/rpc` route — on a region-local
            // replica when this read is eligible for one, else on the owner.
            const response = await forwardRpcToShard(request, functionPath, args, shardKey, outgoingHeaders);

            // A non-2xx from the shard is reported as ok=false even though no
            // exception was thrown — the user-visible result is still an error
            // surface, just one the shard chose to encode in the status code.
            emitRpcEvent(
                observability,
                {
                    ...requestMeta,
                    ...traceEventFields(trace),
                    durationMs: Date.now() - rpcStartedAt,
                    functionPath,
                    ok: response.ok,
                    shardKey,
                    ...(response.ok ? {} : { error: { code: "SHARD_ERROR", message: `shard returned ${String(response.status)}`, status: response.status } }),
                },
                sinkContext,
                // No `sampling` fallback: `emitRpcEvent` ignores it whenever a
                // settled `decision` is passed, so passing it here would only
                // mislead a reader into thinking both are live.
                undefined,
                // The verdict `beginDispatchTrace` already settled — `trace.sampled`
                // is the propagated bit (honoring a trusted upstream's sampled-out
                // `00`), NOT `decision.isTraced`, so the export gate can never
                // disagree with the `traceparent` we forwarded.
                { isTraced: trace.sampled, keepErrors: decision.keepErrors },
            );

            // The DO's `x-d1-bookmark` header (which lets the client pin reads
            // after a write) is already on the shard `response`. The one thing
            // the shard cannot know is which key the WORKER resolved it under:
            // a caller that omits `shardKey` and one that spells out the
            // configured default reach the same shard, and only this side knows
            // they are the same. Stamping it lets the client file its
            // read-your-writes cursor under one canonical key instead of two —
            // which is the difference between a bookmark that constrains the
            // next read and one that quietly does not.
            //
            // `response.headers` is immutable on a `fetch` result, so this is
            // the one place a rebuild is warranted; `statusText` is carried over
            // explicitly because a bare `Response(body, { status })` drops it.
            const stamped = new Response(response.body, { headers: response.headers, status: response.status, statusText: response.statusText });

            stamped.headers.set("x-lunora-shard-key", shardKey);

            return stamped;
        } catch (error) {
            emitRpcEvent(
                observability,
                {
                    ...requestMeta,
                    ...traceEventFields(trace),
                    ...buildErrorEvent(functionPath, Date.now() - rpcStartedAt, error, { shardKey }),
                },
                sinkContext,
                // See the success path above: `sampling` is dead once a settled
                // `decision` is passed, so it is omitted here too.
                undefined,
                { isTraced: trace.sampled, keepErrors: decision.keepErrors },
            );
            throw error;
        }
    };

    /**
     * The three pre-dispatch envelope-shape guards, hoisted out of {@link handleRpc}
     * so the hot path stays flat: (1) `fanOut` + `shardKey` are mutually exclusive;
     * (2) a `__lunora_relation__:*` single-shard envelope would bypass the
     * `authorizeFanOut` gate and read raw rows, so it is refused (the literal prefix
     * is inlined to keep the runtime free of a `@lunora/do` dependency); (3) a
     * `fanOut` envelope is rejected BEFORE `resolveIdentity` runs when no coordinator
     * is configured, so a request already destined for a 400 wastes no identity IO.
     */
    const assertDispatchableEnvelope = (envelope: RpcEnvelope): void => {
        if (envelope.fanOut && envelope.shardKey) {
            throw new LunoraError("RPC envelope cannot set both `shardKey` and `fanOut`", { code: "BAD_REQUEST", status: 400 });
        }

        if (!envelope.fanOut) {
            assertNotReservedRelationPath(envelope.functionPath);
        }

        if (envelope.fanOut && !options.queryCoordinator) {
            throw new LunoraError("RPC envelope set `fanOut` but no `queryCoordinator` is configured on the worker", {
                code: "BAD_REQUEST",
                status: 400,
            });
        }
    };

    const handleRpc = async (request: Request, env: unknown, context?: ExecutionContextLike): Promise<Response> => {
        assertMethod(request, "POST", "RPC");

        const envelope = await parseEnvelope(request);

        // Dev diagnostic (opt-in via `LUNORA_DEBUG_RPC`): one line per RPC so a
        // client-side request loop shows up as a wall of identical entries in the
        // dev server terminal. Logged before validation so even rejected floods
        // are visible; off by default.
        logRpcDebug(env, envelope);

        // Throwing envelope guards: fan-out+shardKey, the fan-out-only relation
        // prefix, and fan-out without a coordinator (checked BEFORE `resolveIdentity`
        // so a doomed request never triggers the identity hook's DB/IO).
        assertDispatchableEnvelope(envelope);

        // Reserved single-shard RPCs served at the worker boundary instead of being
        // forwarded to a shard: the D1-backed auth-audit read and the notify
        // device-list read (both admin-gated). A returned Response short-circuits
        // dispatch; `undefined` continues normal routing.
        const reservedResponse = await serveReservedWorkerRpc(request, envelope);

        if (reservedResponse !== undefined) {
            return reservedResponse;
        }

        // Forward selected headers from the inbound request so the DO can
        // honour auth, sessions, and D1 read-your-writes consistency.
        const { headers: forwardedHeaders, identity } = await resolveForwardContext(request, env, publicResolveIdentity);

        await authorizeRpcEnvelope(envelope, identity);

        // x402 paid-procedure gate. A `.x402({ price })`-tagged function is
        // paywalled at the origin worker: an unpaid RPC gets a real 402 +
        // PAYMENT-REQUIRED challenge; a verified + settled `X-PAYMENT` dispatches
        // as normal. Verify/settle stay HERE, at the origin boundary — the shard
        // never sees payment state (plan 134 §Phase 2.4). Resolved off the
        // registered function's identity (`fn.x402`), like `fn.rls`; the helper
        // fail-closes on paid fan-out or a missing charge gate.
        const x402Tag = resolveX402Charge(envelope, options);

        {
            // Timing wraps the dispatch only — envelope parse + coordinator
            // gate + identity resolution happen above and are not part of
            // the user-observable RPC duration we report.
            const rpcStartedAt = Date.now();
            const { observability } = options;
            const requestMeta = requestTelemetryMeta(request);

            // Hand the request's `ctx.waitUntil` to sinks so a network sink's
            // POST survives isolate teardown after the response returns.
            const sinkContext = buildSinkContext(env, request, context && ((promise) => context.waitUntil?.(promise)));

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
                    const result = await coordinator.fanOut(shardDO, {
                        args: envelope.args ?? {},
                        fanOut: envelope.fanOut,
                        functionPath: envelope.functionPath,
                        headers: forwardedHeaders,
                    });

                    emitRpcEvent(
                        observability,
                        {
                            durationMs: Date.now() - rpcStartedAt,
                            fanOut: {
                                failed: result.failed,
                                shards: result.ok + result.failed,
                                table: envelope.fanOut.table,
                            },
                            functionPath: envelope.functionPath,
                            ...requestMeta,
                            ok: true,
                        },
                        sinkContext,
                    );

                    return Response.json(result, {
                        headers: { "content-type": "application/json" },
                        status: 200,
                    });
                } catch (error) {
                    emitRpcEvent(
                        observability,
                        {
                            ...buildErrorEvent(envelope.functionPath, Date.now() - rpcStartedAt, error, { fanOut: { table: envelope.fanOut.table } }),
                            ...requestMeta,
                        },
                        sinkContext,
                    );
                    throw error;
                }
            }

            const shardKey = envelope.shardKey ?? defaultShard;

            const dispatch = (): Promise<Response> =>
                dispatchSingleShard(request, envelope.functionPath, envelope.args ?? {}, shardKey, forwardedHeaders, sinkContext);

            // Paid procedure: run the injected x402 gate around the shard
            // dispatch (challenge / verify / dispatch / settle). The gate's
            // presence was already asserted above when `x402Tag` is set, so the
            // `x402Charge` re-check here is only for the type system.
            if (x402Tag && options.x402Charge) {
                return options.x402Charge(request, { functionPath: envelope.functionPath, price: x402Tag.price }, dispatch, forwardWaitUntil(context));
            }

            return dispatch();
        }
    };

    /**
     * Batch RPC transport (plan 088). Accepts `{ calls: [{ id, functionPath, args,
     * shardKey?, mutationId?, clientId?, clientSeq? }] }`, resolves identity ONCE,
     * runs the per-shard `authorizeShard` gate on every entry (identical to
     * `handleRpc`), groups entries by `shardKey`, and forwards one `/rpc-batch`
     * sub-request per shard DO — so a batch spanning many shards is split and
     * each DO applies its slice sequentially (preserving per-client watermark
     * ordering + idempotency). Per-entry results are reassembled by `id`; the
     * response is `{ results: [{ id, status, body }] }`, each `body` the untouched
     * single-call envelope. Capabilities/pipelining are explicitly NOT supported
     * (see plan 088 §fence — incompatible with DO hibernation).
     */
    const handleBatchRpc = async (request: Request, env: unknown, context?: ExecutionContextLike): Promise<Response> => {
        assertMethod(request, "POST", "RPC batch");

        // `readJsonBodyWithLimit` now rejects a non-object body (`null` / an array /
        // a bare scalar) itself, matching what this handler used to check by hand.
        const body = await readJsonBodyWithLimit(request);
        const { calls } = body as { calls?: unknown };

        if (!Array.isArray(calls)) {
            throw new LunoraError("RPC batch `calls` must be an array", { code: "BAD_REQUEST", status: 400 });
        }

        // Identity is resolved ONCE for the batch (one authenticated request); the
        // per-shard gate below still runs for every entry, exactly as `handleRpc`.
        // Use `publicResolveIdentity` (the contract-wrapped resolver) so this public
        // data path enforces `defineIdentity(...)` exactly like `handleRpc` — the raw
        // resolver would let contract-violating claims through to the shard verbatim.
        const { headers: forwardedHeaders, identity } = await resolveForwardContext(request, env, publicResolveIdentity);

        // Validate + group by target shard (throws on a malformed/reserved/oversized batch).
        const groups = groupBatchCallsByShard(calls, defaultShard);

        // Paid (`.x402`) procedures are not allowed in a batch: one POST carries
        // one `X-PAYMENT`, so a batch mixing free + paid (or several paid) calls
        // can't be gated per-entry with a single 402 challenge. Refuse the whole
        // batch if any entry is paid — callers dispatch paid functions
        // individually over `/_lunora/rpc` (plan 134 §Phase 2.3).
        for (const entries of groups.values()) {
            for (const entry of entries) {
                if (options.functions?.[entry.functionPath]?.x402) {
                    throw new LunoraError(
                        `paid (\`.x402\`) function "${entry.functionPath}" cannot be called in a batch; dispatch it individually over ${RPC_PATH}`,
                        {
                            code: "BAD_REQUEST",
                            status: 400,
                        },
                    );
                }
            }
        }

        // Per-shard authorization for every entry — same gate as the single-call
        // path — run in parallel (they share the resolved identity).
        await Promise.all(
            [...groups.entries()].flatMap(([shardKey, entries]) =>
                entries.map((entry) => authorizeRpcEnvelope({ args: entry.args, functionPath: entry.functionPath, shardKey }, identity)),
            ),
        );

        const { observability } = options;
        const sinkContext = buildSinkContext(env, request, context && ((promise) => context.waitUntil?.(promise)));
        const requestMeta = requestTelemetryMeta(request);

        const results: unknown[] = [];
        // Each shard is a distinct source whose `x-d1-bookmark` values are not
        // comparable across shards, so we cannot pick a "latest" when a batch spans
        // shards. Collect the per-shard bookmarks and only echo one back when a
        // single shard produced one (the read-your-writes case: one mutation +
        // reads that touch no other bookmarked source) — pinning the client to an
        // arbitrary shard's (possibly older) bookmark would silently break RYOW.
        const bookmarks: string[] = [];

        // A slot-level error envelope for an entry whose shard sub-batch never
        // produced a per-call result (forward failure, non-JSON, non-2xx, or an
        // omitted id). Containing it to the entry's own slot keeps a single
        // unhealthy shard from discarding the results of the healthy shards that
        // rode the same batch — the demux contract is "every slot gets a body".
        const slotError = (entry: BatchEntry, status: number, code: string, message: string): { body: unknown; id: unknown; status: number } => {
            return { body: { error: { code, message } }, id: entry.id, status };
        };

        // Fail a whole sub-batch to its own slots: emit one observability event per
        // entry (built by `eventFor` so the forward vs. non-JSON paths keep their
        // own error mapping) and push a slot-level error for each, so an unhealthy
        // shard never throws away the results of the healthy shards in the batch.
        const failSubBatch = (
            entries: BatchEntry[],
            status: number,
            code: string,
            message: string,
            eventFor: (entry: BatchEntry) => ObservabilityEvent,
        ): void => {
            for (const entry of entries) {
                emitRpcEvent(observability, eventFor(entry), sinkContext);
                results.push(slotError(entry, status, code, message));
            }
        };

        // Single-call parity: emit one observability event per delivered entry. The
        // sub-batch wall-clock is shared across its entries (one DO round-trip), so
        // the per-entry `durationMs` is an honest approximation.
        const emitEntryEvents = (
            entries: BatchEntry[],
            shardKey: string,
            durationMs: number,
            statusById: Map<unknown, number>,
            fallbackStatus: number,
        ): void => {
            for (const entry of entries) {
                const status = statusById.get(entry.id) ?? fallbackStatus;
                const ok = status < 400;

                emitRpcEvent(
                    observability,
                    {
                        durationMs,
                        functionPath: entry.functionPath,
                        ...requestMeta,
                        ok,
                        shardKey,
                        ...(ok ? {} : { error: { code: "SHARD_ERROR", message: `batched call returned ${String(status)}`, status } }),
                    },
                    sinkContext,
                );
            }
        };

        // Fan the per-shard sub-batches out in parallel (different DOs, independent
        // watermarks); entries WITHIN a shard stay ordered by the DO's sequential loop.
        await Promise.all(
            [...groups.entries()].map(async ([shardKey, entries]) => {
                const headers = new Headers(forwardedHeaders);

                headers.set("content-type", "application/json");

                const subRequest = new Request("https://shard.internal/rpc-batch", { body: JSON.stringify({ calls: entries }), headers, method: "POST" });
                const subStartedAt = Date.now();
                let response: Response;

                try {
                    response = await forwardToShard(shardDO, shardKey, subRequest);
                } catch (error) {
                    // The whole sub-batch failed to reach the shard — slot-error every
                    // entry it carried instead of throwing the batch. The failure is
                    // always reported as 502 (a protocol-level "shard unreachable"
                    // decision, independent of what actually threw); `toErrorBody`
                    // only supplies the code/message, redacting the raw (likely
                    // infra-internal) error text unless it's a recognized, non-internal
                    // `LunoraError`.
                    const durationMs = Date.now() - subStartedAt;
                    const { body: errorBody } = toErrorBody(error, { fallbackCode: "SHARD_UNAVAILABLE", redactedMessage: "shard unavailable" });

                    failSubBatch(entries, 502, errorBody.code, errorBody.message, (entry) => {
                        return {
                            ...buildErrorEvent(entry.functionPath, durationMs, error, { shardKey }),
                            ...requestMeta,
                        };
                    });

                    return;
                }

                const durationMs = Date.now() - subStartedAt;
                const bookmark = response.headers.get("x-d1-bookmark");

                if (bookmark) {
                    bookmarks.push(bookmark);
                }

                let parsed: { results?: { body?: unknown; id?: number; status?: number }[] };

                try {
                    parsed = await response.json();
                } catch {
                    // Malformed shard response — fail every entry to its own slot
                    // rather than dropping them silently into "no result".
                    const message = `shard batch returned a non-JSON response (${String(response.status)})`;

                    failSubBatch(entries, response.status, "SHARD_ERROR", message, (entry) => {
                        return {
                            durationMs,
                            error: { code: "SHARD_ERROR", message, status: response.status },
                            functionPath: entry.functionPath,
                            ...requestMeta,
                            ok: false,
                            shardKey,
                        };
                    });

                    return;
                }

                const entryResults = Array.isArray(parsed.results) ? parsed.results : [];
                const statusById = new Map(entryResults.map((entry) => [entry.id, entry.status ?? response.status]));
                const seenIds = new Set(entryResults.map((entry) => entry.id));

                emitEntryEvents(entries, shardKey, durationMs, statusById, response.status);
                results.push(...entryResults);

                // Any entry the shard omitted (short/partial response) gets an
                // explicit slot error rather than a silent "no result" client-side.
                for (const entry of entries) {
                    if (!seenIds.has(entry.id)) {
                        results.push(slotError(entry, response.status, "SHARD_ERROR", `shard batch omitted result for call ${String(entry.id)}`));
                    }
                }
            }),
        );

        const responseHeaders: Record<string, string> = { "content-type": "application/json" };
        const [onlyBookmark] = bookmarks;

        if (bookmarks.length === 1 && onlyBookmark !== undefined) {
            responseHeaders["x-d1-bookmark"] = onlyBookmark;
        }

        return Response.json({ results }, { headers: responseHeaders, status: 200 });
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
     * 1. `resolveForwardContext(request, env, publicResolveIdentity)` — the
     * identical identity resolution (`resolveIdentity` behind the same
     * contract-validation gate as the HTTP path, cookie / authorization /
     * `x-d1-bookmark` forwarding, `x-lunora-userid` / `x-lunora-identity` header
     * derivation). Same per-request auth context, byte-for-byte.
     * 2. `authorizeRpcEnvelope({ functionPath, shardKey }, identity)` — the
     * identical per-shard authorization gate (`authorizeShard`), so an
     * unauthenticated / unauthorized call to an auth-gated function is rejected
     * here exactly as it is on `/_lunora/rpc` (same `FORBIDDEN_SHARD` 403).
     * 3. `resolveX402Charge(...)` — the identical paid-procedure gate, so a
     * `.x402({ price })` function is paywalled here (402 challenge, verify,
     * settle) exactly as it is on `/_lunora/rpc` and the REST surface.
     * 4. `dispatchSingleShard(...)` — the identical shard routing, observability
     * event, bookmark propagation, and `Response` shape.
     *
     * Result: byte-identical to what `POST /_lunora/rpc` returns for the same
     * function reference, args, `shardKey`, and inbound request. It returns the
     * raw shard {@link Response} (the same object `handleRpc` returns) so callers
     * and tests can compare it byte-for-byte against the HTTP path.
     *
     * ONE THING THE CALLER MUST SUPPLY. An identity that the platform provides
     * out-of-band rather than on the request — `context.access` under a
     * Worker-scoped Cloudflare Access policy — is not reachable from `request`
     * alone. The HTTP path picks it up from the `fetch` funnel; a direct
     * `serverQuery` has no funnel, so pass `callOptions.context`. Omit it under
     * such a policy and this call resolves ANONYMOUS while the same user's
     * `/_lunora/rpc` traffic is authenticated — an SSR loader renders empty (or
     * 403s) and then hydrates fine, which is a miserable thing to debug.
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
        callOptions: { context?: ExecutionContextLike; shardKey?: string; waitUntil?: (promise: Promise<unknown>) => void } = {},
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

            // Fan-out is not reachable here (see the docblock), so this dispatch is
            // always single-shard — which is exactly the envelope shape the reserved
            // relation reader must never be reached through. Checked BEFORE
            // `resolveForwardContext` so a doomed call triggers no identity IO,
            // mirroring `handleRpc`'s ordering and keeping the byte-identical-result
            // contract honest (`/_lunora/rpc` answers 403 FORBIDDEN for this input).
            assertNotReservedRelationPath(functionPath);

            // Resolve identity off the SAME inbound request the HTTP path uses, so
            // cookies / bearer / bookmark and the derived `x-lunora-*` headers are
            // byte-identical to `handleRpc`'s. The context is passed explicitly
            // because this path has no `fetch` funnel to have recorded it, and an
            // SSR host may well hand us a rebuilt `Request` object.
            const { headers: forwardedHeaders, identity } = await resolveForwardContext(request, env, publicResolveIdentity, callOptions.context);

            // Run the IDENTICAL per-shard authorization gate. A `shardKey` of
            // `undefined` resolves to `defaultShard` for both the gate and the
            // dispatch, mirroring `handleRpc` exactly.
            const envelope: RpcEnvelope = { args, functionPath, shardKey: callOptions.shardKey };

            await authorizeRpcEnvelope(envelope, identity);

            const shardKey = callOptions.shardKey ?? defaultShard;
            // Pass the caller's `waitUntil` when the SSR host has one: an OTLP body
            // past the gzip threshold is exported asynchronously, so without it an
            // error span can be dropped when the isolate tears down.
            const serverSinkContext = buildSinkContext(env, request, callOptions.waitUntil);
            const dispatch = (): Promise<Response> => dispatchSingleShard(request, functionPath, args, shardKey, forwardedHeaders, serverSinkContext);

            // Step 4 of the parity contract: a `.x402({ price })` procedure is
            // paywalled here exactly as on `/_lunora/rpc` and the REST surface
            // (challenge / verify / dispatch / settle around the shard call). This
            // transport used to dispatch straight through, so an SSR loader served
            // every paid result free — no 402, no settlement — while the option's
            // own JSDoc promised the paywall was fail-closed by construction.
            const x402Tag = resolveX402Charge(envelope, options);

            if (x402Tag && options.x402Charge) {
                return await options.x402Charge(
                    request,
                    { functionPath, price: x402Tag.price },
                    dispatch,
                    forwardWaitUntil(callOptions.waitUntil ? { waitUntil: callOptions.waitUntil } : callOptions.context),
                );
            }

            return await dispatch();
        } catch (error: unknown) {
            return toErrorResponse(error);
        }
    };

    /**
     * The worker's `scheduled()` entry: dispatch the firing cron trigger to the
     * matching {@link WorkerOptions.crons} handler (if any) and run the built-in
     * backup when the trigger matches {@link WorkerOptions.backupCron}. Both run
     * when a user handler shares the backup's expression. Errors from each are
     * collected and rethrown together so one failure neither masks the other nor
     * is silently swallowed — the platform sees the cron invocation fail.
     */

    /**
     * Wrap a NON-`fetch` worker trigger — a queue batch, a cron fire — in the same
     * telemetry the RPC path gets: its own trace, one SERVER span, and a flush of
     * the batching sink at the invocation boundary.
     *
     * Without this, everything a queue consumer or cron job does is invisible:
     * `ctx.log`/`ctx.trace` inside the dispatched function still fire, but they
     * hang off a trace with no root, so a collector shows orphan spans and no
     * "this cron took 40s" bar to hang them under. Background work is exactly
     * where you least want a blind spot, since nobody is watching a response time.
     *
     * Trigger events are exported WITHOUT the head-sampling ratio. A ratio tuned
     * for request traffic would hide most fires of a once-an-hour cron — the exact
     * blind spot this wrapper exists to close — and trigger volume is inherently
     * low enough that keeping all of them costs nothing.
     *
     * The trace is always minted here rather than adopted: a queue message or a
     * cron controller carries no `traceparent`. Linking a consumer span back to
     * the producing request is instead the job of `span.addLink`, since parenting
     * would be wrong — the producer's request is long over by then.
     */
    const instrumentTrigger = async <T>(functionPath: string, context: ExecutionContextLike, run: (traceparent: string) => Promise<T>): Promise<T> => {
        const { observability } = options;
        const startedAt = Date.now();
        const traceId = otlpRandomHex(16);
        const spanId = otlpRandomHex(8);
        const sinkContext = sinkContextFor(context);
        // Handed to the work this trigger drives so its dispatches JOIN this trace.
        // Always sampled: trigger events deliberately bypass the head ratio (see
        // above), and announcing a verdict we did not apply is how a downstream tier
        // drops the children of a span we kept.
        const triggerTraceparent = buildTraceparent(traceId, spanId, true);

        try {
            const result = await run(triggerTraceparent);

            emitRpcEvent(observability, { durationMs: Date.now() - startedAt, functionPath, ok: true, spanId, traceId }, sinkContext);

            return result;
        } catch (error) {
            emitRpcEvent(observability, { ...buildErrorEvent(functionPath, Date.now() - startedAt, error, {}), spanId, traceId }, sinkContext);

            throw error;
        } finally {
            // The invocation boundary. A Workers isolate can be frozen the moment
            // this returns, so a batching sink that has not been told to ship
            // would simply lose everything it buffered.
            flushSink(observability, sinkContext);
        }
    };

    const handleScheduled = async (controller: ScheduledControllerLike, env: unknown, context: ExecutionContextLike, traceparent?: string): Promise<void> => {
        // A cron can fire on an isolate that never served a `fetch`, so resolve
        // `env.LUNORA_ADMIN_TOKEN` here too — the built-in backup authenticates its
        // per-shard export fan-out with `effectiveAdminToken()`.
        captureEnvDerivedConfig(env);

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
        // Failures join `errors` for the combined rethrow below. `env` carries the
        // `WORKFLOW_*` bindings a workflow-targeting job starts an instance on.
        const ranJobs = await runCronJobs(controller.cron, env, errors, toError, traceparent);
        const isBackupCron = Boolean(options.backupStore) && options.backupCron !== undefined && options.backupCron === controller.cron;

        if (isBackupCron) {
            try {
                await runScheduledBackup(options, shardDO, effectiveAdminToken(), controller);
            } catch (error: unknown) {
                errors.push(toError(error));
            }
        }

        if (!userHandler && ranJobs === 0 && !isBackupCron) {
            // Cloudflare fired an expression nothing is registered under — almost
            // always `triggers.crons` in wrangler.jsonc drifting from the
            // generated cron map. Returning quietly makes that a green invocation
            // that ran nothing, which is indistinguishable from a working cron
            // until someone notices the work never happened.
            const registered = [...new Set([...Object.keys(options.crons ?? {}), ...Object.keys(options.cronJobs ?? {})])];

            // eslint-disable-next-line no-console -- the scheduled() entry point has no request-scoped logger; the host captures console
            console.warn(
                `[lunora] scheduled("${controller.cron}") fired but no cron handler is registered for that expression. Registered: ${registered.length === 0 ? "(none)" : registered.join(", ")}. Check that \`triggers.crons\` in wrangler.jsonc matches the app's cron definitions.`,
            );
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
    type InternalRoute = (request: Request, env: unknown, url: URL, context: ExecutionContextLike) => Promise<Response> | Response;

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

            await forwardToShard(
                shardDO,
                defaultShard,
                shardRpcRequest(RECORD_AUTH_EVENT_OP, { outcome }, { authorization: `Bearer ${adminBearer}`, "content-type": "application/json" }),
            );
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
            context.waitUntil?.(recordAuthAttempt(env, authResponse.status >= 400 ? "fail" : "ok"));
        }

        return authResponse;
    };

    // Opt-in public REST surface (plan 167). A REST call is routed THROUGH the
    // procedure via the exact same steps as `handleRpc` — identity resolution,
    // the `authorizeRpcEnvelope` gate, then `dispatchSingleShard` (or the
    // coordinator fan-out) — so auth, RLS, and the `v.*` validators are enforced at
    // the shard identically to typed RPC. The router is built from the registry, so
    // a non-exposed procedure has no route (default-closed).
    const invokeExposed: RestInvoke = async ({ args, env, functionPath, request, shardKey, waitUntil }) => {
        // `invokeExposed` builds the envelope directly rather than routing through
        // `parseEnvelope`, so it needs its own call to the shared guard — same
        // check the RPC edge applies, so a REST-only bypass can't reappear.
        assertArgsObject(args, "REST");

        const envelope: RpcEnvelope = { args, functionPath, ...(shardKey === undefined ? {} : { shardKey }) };
        const { headers: forwardedHeaders, identity } = await resolveForwardContext(request, env, publicResolveIdentity);

        await authorizeRpcEnvelope(envelope, identity);

        const resolvedShardKey = shardKey ?? defaultShard;
        // See `serverQuery`: the public REST surface must keep its telemetry alive
        // past the response too, or gzipped error spans are lost.
        const restSinkContext = buildSinkContext(env, request, waitUntil);
        const dispatch = (): Promise<Response> => dispatchSingleShard(request, functionPath, args, resolvedShardKey, forwardedHeaders, restSinkContext);

        // A `.x402({ price })`-tagged procedure exposed over REST is paywalled at
        // the origin exactly as over RPC (challenge / verify / settle around the
        // shard dispatch); the gate's presence is re-checked for the type system.
        const x402Tag = resolveX402Charge(envelope, options);

        if (x402Tag && options.x402Charge) {
            return options.x402Charge(request, { functionPath, price: x402Tag.price }, dispatch, forwardWaitUntil({ waitUntil }));
        }

        return dispatch();
    };

    const restRoutes = buildRestRoutes({
        functions: options.functions ?? {},
        invoke: invokeExposed,
        readJsonBody: readJsonBodyWithLimit,
        // `null` is a meaningful value here (the explicit opt-out) and `undefined`
        // means "whatever the host has", so the option is forwarded as-is rather
        // than spread when truthy.
        edgeCache: options.restEdgeCache,
        ...(options.restRateLimit ? { rateLimit: options.restRateLimit } : {}),
    });

    // Resolved once at construction so the per-request handler can skip the custom-route
    // lookup entirely when there are none. Treat an empty object as "no routes": the
    // generated composed/app workers always pass a literal `routes: {}` (never `undefined`),
    // so a truthiness check alone would never actually skip the work it claims to. Holding
    // the narrowed map (not just a boolean) lets the handler index it without a non-null
    // assertion.
    const customRoutes = options.routes !== undefined && Object.keys(options.routes).length > 0 ? options.routes : undefined;

    const internalRoutes: Record<string, InternalRoute> = {
        [STATUS_PATH]: (request) => {
            // Health probes are reads; anything else on this path is a scanner
            // or a mistake — refuse rather than answer 200 to arbitrary verbs.
            if (request.method !== "GET" && request.method !== "HEAD") {
                return new Response(undefined, { headers: { allow: "GET, HEAD" }, status: 405 });
            }

            return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
        },
        [WS_PATH]: (request, env, url) => handleWebSocketUpgrade(request, env, url),
        [RPC_PATH]: (request, env, _url, context) => handleRpc(request, env, context),
        [RPC_BATCH_PATH]: (request, env, _url, context) => handleBatchRpc(request, env, context),
        [SCHEDULER_DISPATCH_PATH]: (request, env) => handleSchedulerDispatch(request, env),
        [CRON_JOBS_RUN_PATH]: (request, env) => handleRunCronJob(request, env),
        // Mint a short-lived HMAC-signed WS admin sub-token. Gated by the master
        // admin bearer (header) / `adminGate`; the studio then sends the minted
        // token — not the master credential — in the WS `?token=`
        // query string. Signed with the master token itself, so both isolates
        // verify statelessly and rotating `LUNORA_ADMIN_TOKEN` invalidates every
        // outstanding sub-token. `no-store` keeps the token out of caches.
        [ADMIN_WS_TOKEN_PATH]: async (request) => {
            assertMethod(request, "POST", "ws-token");

            assertAdminAuthorized(request);

            const signingSecret = effectiveAdminToken();

            if (signingSecret === undefined) {
                // Reachable only via an `adminGate` grant with no static token
                // configured — there is no key to sign with, so minting is off.
                throw new LunoraError("ws-token minting requires a configured admin token", { code: "ADMIN_TOKEN_NOT_CONFIGURED", status: 400 });
            }

            const minted = await mintWsAdminToken(signingSecret);

            return Response.json(minted, { headers: { "cache-control": "no-store" } });
        },

        // Extracted handler clusters built above, merged in (mirroring the auth
        // plane below): orchestration (migrate / rank / rankpage / shard-traffic /
        // pitr), data-movement (export / import / sync / connector-sync / apply),
        // scheduled, storage, vector, and the static-introspection reads
        // (functions / cron-jobs / openapi / openrpc / global tables).
        ...orchestrationAdminRoutes,
        ...dataMovementAdminRoutes,
        ...scheduledAdminRoutes,
        ...workflowsAdminRoutes,
        ...storageAdminRoutes,
        ...backupAdminRoutes,
        ...vectorAdminRoutes,
        ...kvAdminRoutes,
        ...logArchiveAdminRoutes,
        ...introspectionAdminRoutes,
        // `/_lunora/health` + `/_lunora/health/ready` — public (or admin-gated)
        // liveness/readiness probes; not under the admin prefix, so `applyAdminGate`
        // never runs on them (the handler self-gates when `auth: "admin"`).
        ...healthRoutes,
        // `/_lunora/rest/<namespace>/<fn>` — the opt-in public REST surface, one
        // route per `.expose({ rest: true })` procedure (default-closed). Routes
        // THROUGH the procedure, so auth/RLS/validators are enforced at the shard.
        ...restRoutes,
        // `/_lunora/admin/auth/*` — the whole user-management plane, one route per
        // `AuthAdmin` op, dispatched by the descriptor table in `./auth-admin-routes`.
        ...buildAuthAdminRoutes({
            assertAdmin: assertAdminAuthorized,
            getAuthAdmin: () => options.authAdmin,
            parsePaging,
            queryParameter,
            readJsonBody: readJsonBodyWithLimit,
        }),
    };

    // Resolve the secure-by-default HTTP edge once at construction. Throws here
    // (rather than per request) on an unenforceable combination such as a
    // wildcard CORS origin paired with credentials. The `env`-aware re-resolve
    // (honoring the `LUNORA_SECURITY_*` opt-out vars) happens lazily on the first
    // request — env is per-invocation, but deployment-stable, so it is memoized.
    let resolvedSecurity = resolveSecurity(options.security);
    let securityEnvResolved = false;

    // Fold the deployment env into the resolved security config once, on the
    // first request. `env` isn't available at construction, so the eager resolve
    // above sees only code config; this picks up the `LUNORA_SECURITY_*` /
    // `LUNORA_ALLOWED_ORIGINS` env knobs. Must run before the preflight/CSRF
    // guards in `fetch` (not just inside `handle`), or the very first request per
    // cold isolate would evaluate them against the env-less config.
    const ensureSecurityResolved = (env: unknown): void => {
        if (!securityEnvResolved) {
            securityEnvResolved = true;
            resolvedSecurity = resolveSecurity(options.security, (env ?? {}) as Record<string, unknown>);
        }
    };

    // The path-scoped half of the Access admin gate: verify {@link recordAdminGrant}
    // ONCE per `/_lunora/admin/*` request. Restricted to `isAdminPath` so the async
    // verification never runs on the `/_lunora/rpc` + `/_lunora/ws` data hot path —
    // the two admin RPCs served AT `/_lunora/rpc` call `recordAdminGrant` themselves,
    // after the envelope has named one of them.
    const applyAdminGate = async (request: Request, pathname: string): Promise<void> => {
        if (!isAdminPath(pathname)) {
            return;
        }

        await recordAdminGrant(request);
    };

    const handle = async (request: Request, env: unknown, context: ExecutionContextLike): Promise<Response> => {
        // Record the context for this request before anything resolves identity:
        // `resolveIdentity` / `adminGate` read it back through
        // `executionContextByRequest` to reach platform-supplied identity
        // (`context.access` under Worker-scoped Cloudflare Access).
        executionContextByRequest.set(request, context);

        const url = new URL(request.url);

        // Fast-path reject on a declared `Content-Length` over the cap — cheap
        // (a header read, no body materialization) but NOT authoritative:
        // `Content-Length` is forgeable. A chunked body omits it and a
        // non-numeric value parses to `NaN`, so a missing/unparseable length is
        // treated as "unknown" (let the request through here) — the real
        // enforcement happens in `readBodyTextWithLimit` / the streaming import
        // reader, which abort with 413 once cumulative bytes exceed the cap.
        //
        // Scoped to the planes the FRAMEWORK dispatches — the reserved
        // `/_lunora/*` surface (what `MAX_BODY_BYTES` documents itself as
        // capping) and the auth plane it mounts. Unscoped, it also pre-rejected
        // the app's own `httpRouter` routes: an upload route 413'd a 2 MiB POST
        // before the router ever ran, while the identical 2 MiB sent chunked
        // sailed straight through, so on that plane it was neither a cap the app
        // could rely on nor one it could raise. Whether app routes deserve a body
        // cap is a separate, deliberate decision; this is not one.
        const onFrameworkPlane =
            url.pathname.startsWith(RESERVED_PATH_PREFIX) ||
            (options.authHandler !== undefined && isUnderAuthBasePath(url.pathname, options.authBasePath ?? DEFAULT_AUTH_BASE_PATH));

        if (onFrameworkPlane && (request.method === "POST" || request.method === "PUT")) {
            const contentLength = Number(request.headers.get("content-length") ?? "");
            // Routes that declare their own larger body budget (the KV value PUT,
            // which reads under `KV_VALUE_MAX_BODY_BYTES` to allow a 25 MiB KV
            // value, and the storage object upload, which moves real files) must
            // not be pre-rejected by the shared 1 MiB cap — else the per-route cap
            // is dead code for any client that sends a `Content-Length`. Pick the
            // route's cap so the header check matches the reader's cap.
            const maxBodyBytes = ROUTE_BODY_BUDGETS[url.pathname] ?? MAX_BODY_BYTES;

            if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
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
        // We also accept legacy pathname-only keys for ad-hoc handlers. Guard the
        // whole lookup behind `customRoutes` (resolved once at construction) so the
        // common composed-worker path (no custom routes) skips the `"METHOD path"`
        // string allocation and the two object reads on every request.
        if (customRoutes) {
            const methodAndPath = `${request.method} ${url.pathname}`;
            const route = customRoutes[methodAndPath] ?? customRoutes[url.pathname];

            if (route) {
                return route(request, env, context);
            }
        }

        // Internal `/_lunora/*` endpoints, keyed by pathname. Each entry adapts
        // to the shared `(request, env, url) => Promise<Response>` shape so the
        // dispatch stays a single table lookup rather than a long if-chain.
        const internalRoute = internalRoutes[url.pathname];

        if (internalRoute) {
            await applyAdminGate(request, url.pathname);

            return internalRoute(request, env, url, context);
        }

        // Voice sessions live under a DYNAMIC prefix (`/_lunora/voice/<agent>`), so
        // they can't ride the exact-path `internalRoutes` table. Only reachable when
        // the app wired `voiceAgents` (a voice-enabled agent) — otherwise it falls
        // through to the 404 below.
        if (options.voiceAgents !== undefined && url.pathname.startsWith(VOICE_PATH_PREFIX)) {
            return handleVoiceUpgrade(request, env, url);
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
                context.passThroughOnException?.();
            }

            // Resolve env-driven security knobs before the preflight/CSRF guards
            // below read `resolvedSecurity`, so opt-outs and env CORS apply from
            // the first request per isolate (not just the second onward).
            ensureSecurityResolved(env);

            // Pick up `env.LUNORA_ADMIN_TOKEN` for the admin gates (see top of
            // createWorker), so the Studio's admin calls authenticate when the
            // token lives only in env (the composed-worker default).
            captureEnvDerivedConfig(env);

            // CORS preflight is answered up front for allowlisted origins; its
            // own response already carries the `Access-Control-Allow-*` headers,
            // so it skips the security-header decoration below.
            const preflight = handleCorsPreflight(request, resolvedSecurity);

            if (preflight) {
                return preflight;
            }

            // CSRF/origin guard: reject unsafe cross-origin cookie requests
            // before any handler (and thus any state change) runs.
            const blocked = enforceOrigin(request, resolvedSecurity);

            if (blocked) {
                return decorateResponse(blocked, request, resolvedSecurity);
            }

            try {
                const response = await handle(request, env, context);

                return decorateResponse(response, request, resolvedSecurity);
            } catch (error: unknown) {
                return decorateResponse(toErrorResponse(error), request, resolvedSecurity);
            } finally {
                // Invocation boundary: ship whatever the (batching) sink buffered
                // during this request. Registered through `waitUntil` so the export
                // outlives the response instead of racing isolate teardown.
                flushSink(options.observability, sinkContextFor(context));
            }
        },
        async queue(batch, env, context) {
            // Forward to the codegen-built push-consumer handler (which routes by
            // `batch.queue` via `@lunora/queue`). A no-op when the app declares no
            // push queues, so re-exporting `queue` unconditionally is harmless.
            //
            // Named after the queue so a collector groups consumer invocations per
            // queue rather than lumping every batch under one span name.
            await instrumentTrigger(`queue:${queueNameOf(batch)}`, context, async (traceparent) => {
                await options.queue?.(batch, env, context, { traceparent });
            });
        },
        async scheduled(controller, env, context) {
            // Named after the cron EXPRESSION, which is the stable identity of a
            // trigger — `scheduledTime` varies per fire and would make every run
            // its own group in a collector.
            await instrumentTrigger(`cron:${controller.cron}`, context, async (traceparent) => {
                await handleScheduled(controller, env, context, traceparent);
            });
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

/**
 * Whether the Lunora options configure any cron surface (so Lunora owns
 * `scheduled` rather than the framework host).
 *
 * EMPTINESS, not presence. Codegen emits `cronJobs: LUNORA_CRONS` unconditionally
 * and `LUNORA_CRONS` is `{}` for a cron-free app, so a presence check (`??` stops
 * at the first non-nullish value) is `true` for every app built through
 * `defineApp().buildFrameworkWorker(host)` — which made the preservation branch
 * below unreachable and dropped the framework host's own `scheduled` in every one
 * of them.
 */
const hasLunoraCrons = (options: FrameworkWorkerOptions): boolean =>
    Boolean(options.backupCron) || Object.keys(options.crons ?? {}).length > 0 || Object.keys(options.cronJobs ?? {}).length > 0;

/**
 * Compose a meta-framework's Cloudflare Worker handler with Lunora's realtime
 * plane into one `{ fetch, scheduled }` Worker — the **single, shared** class-B
 * (own-CF-adapter, hook-injection) composer behind `@lunora/astro`'s
 * `withLunora` and codegen's `buildFrameworkWorker` (PLAN4 §3). It wraps
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
        queue: (batch, env, context) => build(optionsFactory(env)).queue?.(batch, env, context) ?? Promise.resolve(),
        scheduled: (controller, env, context) => build(optionsFactory(env)).scheduled(controller, env, context),
        serverQuery: (request, env, reference, args, options) => build(optionsFactory(env)).serverQuery(request, env, reference, args, options),
    };
};

/**
 * Options for {@link createLunoraHandler}. Either an `(env) => options` factory
 * (full control — for bindings that only exist at request time), or a partial
 * {@link FrameworkWorkerOptions} object whose `shardDO` defaults to the
 * conventional `env.SHARD` binding. Pass nothing for the common case.
 */
type LunoraHandlerOptions = ((env: unknown) => FrameworkWorkerOptions) | Partial<FrameworkWorkerOptions>;

/**
 * Resolve per-request Lunora worker options. A factory is called with the
 * request `env`; a partial object has its `shardDO` defaulted to `env.SHARD` so
 * the common case needs no configuration. Throws a clear error when no shard
 * namespace can be found — a wiring mistake, not a runtime condition to swallow.
 */
const resolveLunoraOptions = (options: LunoraHandlerOptions, env: unknown): FrameworkWorkerOptions => {
    if (typeof options === "function") {
        return options(env);
    }

    const shardDO = options.shardDO ?? (env as { SHARD?: ShardNamespaceLike } | undefined)?.SHARD;

    if (!shardDO) {
        throw new LunoraError(
            "@lunora/runtime: no shard Durable Object namespace found. Bind `SHARD` in wrangler.jsonc, or pass `createLunoraHandler({ shardDO: env.MY_SHARD })`.",
        );
    }

    return { ...options, shardDO };
};

/**
 * Build a framework-neutral request handler for Lunora's realtime plane
 * (`/_lunora/rpc`, `/_lunora/ws`, `/_lunora/admin/*`). This is the **one shared
 * seam** every web-standard framework integration mounts — Hono, Nitro/h3,
 * Elysia, or any WinterCG host running on Cloudflare Workers — so each is a
 * 1–2 line bridge (`(request, env, ctx) => Response`) rather than a bespoke
 * adapter package.
 *
 * Mount it under `/_lunora/*` (or whatever path you reserve) inside your app's
 * router; everything else stays your framework's. The host supplies, per
 * request: a Web `Request`, the Cloudflare `env` (carrying the `SHARD` Durable
 * Object namespace), and — when available — the `ExecutionContext`. The
 * `101 Switching Protocols` WebSocket-upgrade `Response` (with its `webSocket`)
 * is returned verbatim, so the framework streams the socket through unchanged.
 *
 * ```ts
 * // Hono
 * const lunora = createLunoraHandler();
 * app.use("/_lunora/*", (c) => lunora(c.req.raw, c.env, c.executionCtx));
 *
 * // Nitro / h3
 * const lunora = createLunoraHandler();
 * export default defineEventHandler((event) => {
 *   const { ctx, env } = event.context.cloudflare;
 *   return lunora(toWebRequest(event), env, ctx);
 * });
 * ```
 *
 * `shardDO` defaults to `env.SHARD`; pass `options` (or an `(env) => options`
 * factory) to add `auth`, `crons`, a `security` posture, or a custom namespace.
 * A new worker is composed per request because the options (and the `SHARD`
 * binding they default from) are only known once `env` arrives.
 * @param options Partial worker options (default `shardDO: env.SHARD`), or an `(env) => options` factory.
 */
const createLunoraHandler =
    (options: LunoraHandlerOptions = {}): ((request: Request, env: unknown, context?: ExecutionContextLike) => Promise<Response>) =>
    (request, env, context) =>
        createWorker(resolveLunoraOptions(options, env)).fetch(request, env, context ?? NOOP_EXECUTION_CONTEXT);

/** Re-exported helper so callers can roundtrip envelopes in tests. */
const defineRpcEnvelope = (envelope: RpcEnvelope): RpcEnvelope => envelope;

export { composeWorker, createLunoraHandler, createWorker, defineRpcEnvelope, probeRelayCount, resolveLunoraOptions, withFrameworkWorker };
export { type AccessContextLike, type AccessIdentityLike, type ExecutionContextLike, NOOP_EXECUTION_CONTEXT } from "../../../shared/execution-context";
export type {
    AuthAdmin,
    AuthCapabilities,
    AuthConfigInfo,
    AuthImpersonation,
    AuthPage,
    AuthSession,
    AuthUser,
    AuthUserFieldSpec,
    ListAuthUsersOptions,
} from "./auth-admin-routes";
export type { AuthAuditEntry, AuthAuditLogResult, AuthAuditOutcome, AuthAuditReader, ReadAuthAuditQuery } from "./auth-audit-rpc";
export { GET_AUTH_AUDIT_LOG_OP } from "./auth-audit-rpc";
// Identity-resolver layer lives in its own module; re-export the public names
// here so `@lunora/runtime`'s import surface is unchanged.
export type {
    ComposeIdentityResolversErrorMode,
    ComposeIdentityResolversOptions,
    IdentityContractLike,
    IdentityResolver,
    IdentityValidation,
    ResolvedIdentity,
} from "./identity-resolvers";
export type {
    AdminTableResolver,
    BackupStore,
    CronHandler,
    CronJobDispatch,
    CronJobInfo,
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
    LunoraHandlerOptions,
    LunoraWorker,
    NotifySubscriptionDevice,
    NotifySubscriptionStoreLike,
    QueueConsumerHandler,
    Route,
    RpcContext,
    RpcEnvelope,
    ScheduledControllerLike,
    ShardCaller,
    ShardingInfo,
    StorageDeleteFunction as StorageDeleteFn,
    StorageDownloadFunction as StorageDownloadFn,
    StorageListFunction as StorageListFn,
    StorageObject,
    StorageSignedUrlFunction as StorageSignedUrlFn,
    StorageUploadFunction as StorageUploadFn,
    TriggerTrace,
    VectorIndexSummary,
    VectorIntrospector,
    VectorQueryMatch,
    WorkerOptions,
};

export { composeIdentityResolvers, routeIdentityResolvers } from "./identity-resolvers";
export type { KvIntrospector, KvKeyEntry, KvKeyListResult, KvNamespaceSummary, KvValueResult } from "./kv-admin-routes";
export type { BackupManifest } from "./scheduled-backup";
