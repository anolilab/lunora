import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { isLunoraError, LunoraError, toErrorBody } from "@lunora/errors";
import type {
    AppendRequestLogEntry,
    ContextFetch,
    ContextLogLevel,
    ContextMetrics,
    ContextTracer,
    DatabaseInstrumentation,
    DatabaseTally,
    FunctionMetricBucket,
    FunctionMetricBucketsResult,
    FunctionMetricIndexHit,
    HostTracingLike,
    IndexHit,
    IssueState,
    IssueStatePatch,
    LogEventInput,
    MetricHistoryOptions,
    QueryStatEntry,
    RequestLogWriteOptions,
    SpanCollection,
    SpanCollector,
    TraceAnchor,
} from "@lunora/observability";
import {
    appendRequestLogEntry,
    buildSecurityAudit,
    createDatabaseTally,
    createMetrics,
    createSpanCollector,
    createTracedFetch,
    createTracer,
    dispatchRootSpan,
    emitLogEvent,
    emitRequestLogEvent,
    explainIssue,
    foldTraces,
    formatTally,
    FUNCTION_METRICS_MAX_PATHS,
    instrumentDatabase,
    ISSUE_STATE_TABLE,
    LogBuffer,
    mergeScanAttribution,
    MetricBuffer,
    parseLogArgs,
    readErrorIssues,
    readFunctionMetricBuckets,
    readFunctionMetricIndexHits,
    readFunctionMetrics,
    readFunctionMetricsTotals,
    readMetricHistory,
    readQueryMetrics,
    recordAuthEvent,
    recordFunctionMetric,
    recordMetricHistory,
    recordQueryMetric,
    redactArgs,
    REQUEST_LOG_TABLE,
    resolveTraceAnchor,
    SpanBuffer,
    upsertIssueState,
} from "@lunora/observability";
import type { ShardHost, SocketHost } from "@lunora/platform";
import { createShardHost, createSocketHost } from "@lunora/platform-cloudflare";
import type {
    AdvisorProcedure,
    AdvisoryFinding,
    CdcChange,
    CdcChangeKey,
    ColumnMeta,
    CreateWorkflowInstanceResult,
    DependencyTracker,
    DurableStreamSink,
    ExportRow,
    FanoutMetricsResult,
    FlagsResult,
    FunctionCallStat,
    FunctionStatsResult,
    GlobalPollCounters,
    ImportShardResult,
    IndexKeyEntry,
    KeyRange,
    LifecycleDispatchInfo,
    LifecycleEvent,
    MaskPoliciesResult,
    MigrationRunResult,
    MutationDelta,
    OwnerRelay,
    QueueMetadata,
    QueuesResult,
    ReactiveCacheOptions,
    ReactorMetadata,
    ReactorState,
    ReadFootprint,
    RelayHost,
    RelayMember,
    ReplicaOwnerHost,
    ResolvedShape,
    RlsPoliciesResult,
    RpcRequest,
    SearchBackfillProgress,
    ShapeDiffCache,
    ShapePokeCursorRow,
    ShapePokePart,
    ShapeProbeCounters,
    ShapeRow,
    ShapeRowOp,
    ShapeSubscriptionQuery,
    ShardRankPageResult,
    ShardSiblingHost,
    ShardSocketLike,
    SocketAttachment,
    SqlExec,
    StorageRulesResult,
    StudioFeaturesResult,
    SubscriptionEnvelope,
    SubscriptionIdentity,
    SubscriptionQuery,
    SubscriptionsResult,
    TableIndexInfo,
    TransactionLimits,
    TransactionSqlLike,
    TtlSweepSpec,
    WorkflowInstanceStatusResult,
    WorkflowsResult,
} from "@lunora/shard-engine";
import {
    ADMIN_FUNCTION_PREFIX,
    ADMIN_FUNCTIONS,
    advanceClientWatermark,
    appendAuditEntry,
    armRestore,
    awaitWsDrain,
    buildPokeFrames,
    buildSettings,
    buildShapeDiff,
    bumpCdcEpoch,
    CDC_LOG_TABLE,
    cdcCanVouchFor,
    cdcTouchesTables,
    cdcTrimmedError,
    clearCapturedMail,
    clearQueueMessages,
    ConflictError,
    createDependencyTracker,
    createFanoutCounters,
    createGlobalPollCounters,
    createReadFootprint,
    createRelayLink,
    createReplicaLink,
    createShapeDiffCache,
    createShapeProbeCounters,
    cursorBelowRetainedFloor,
    DATA_MIGRATION_STATE_TABLE,
    DEFAULT_MAX_RELAYS,
    deleteGlobalShapeSnapshot,
    deleteGlobalShapeSnapshotsForConnection,
    deleteShapePokeCursor,
    deleteShapePokeCursorsForConnection,
    diffGlobalMembership,
    DurableStreamRunner,
    envOptionalPositiveInt,
    FLAGS_FUNCTION_PREFIX,
    gateReplicaDispatch,
    GlobalPollTick,
    globalShapeReadKey,
    handleReplicaControl,
    isDevEnvironment,
    isLossyBody,
    listReactorStates,
    listTables,
    MAX_PAGE_SIZE,
    mergeChangedKeys,
    migrateClientWatermark,
    minCdcReplayableSeq,
    minCdcSeq,
    minShapePokeCursor,
    parseExportShardArgs,
    parseImportShardArgs,
    projectColumns,
    ReactiveCache,
    reactiveCacheKey,
    reactorNeedsRun,
    readBookmark,
    readCdcChangeKeys,
    readCdcChanges,
    readCdcCursor,
    readCdcEpoch,
    readClientWatermark,
    readGlobalShapeSnapshot,
    readIdempotent,
    readMigrationStatus,
    readQueueMessageById,
    readReactorState,
    readShapePokeCursor,
    readTablePage,
    recordCapturedMail,
    recordChangedKeys,
    recordFanoutPass,
    recordGlobalPollPass,
    recordQueueMessages,
    recordShapeProbePass,
    RELATION_FUNCTION_PREFIX,
    runSocketPool,
    SCAN_DEP,
    selectExpiredIds,
    selectMatchingIds,
    selectShapeRows,
    ShardRunner,
    stableStringify,
    stableWireKey,
    subscriptionFrames,
    summarizeFanoutTopics,
    summarizeSubscriptions,
    TransactionHeadroomTracker,
    trimIdempotent,
    trySendFrame,
    UNVOUCHABLE_DEP,
    writeGlobalShapeSnapshot,
    writeIdempotent,
    writeReactorState,
    writeShapePokeCursor,
    writeShapePokeCursors,
    writeTouchesMemo,
} from "@lunora/shard-engine";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { drizzle as drizzleDO } from "drizzle-orm/durable-sqlite";

import type { BatchEntry } from "../../../shared/batch-wire";
import { MAX_BATCH_ENTRIES } from "../../../shared/batch-wire";
import { constantTimeEqual } from "../../../shared/constant-time-equal";
import { evictOldestEntry } from "../../../shared/evict-oldest";
import { decodeIdentityExpiryHeader, decodeUserIdHeader, dropExpiredCredentialSocket, isIdentityExpired } from "../../../shared/identity-header";
import { jsonResponse } from "../../../shared/json-response";
import type { LogSinkContext } from "../../../shared/log-event";
import type { LogFields } from "../../../shared/log-fields";
import type { MetricEvent } from "../../../shared/metric-event";
import { LUNORA_ATTR, parseTraceparent } from "../../../shared/otlp";
import { PAGE_DELTA_CAPABILITY } from "../../../shared/page-result";
import type { SpanEvent, SpanHandle } from "../../../shared/span-event";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { adminSocketBinding, isEnvFlagEnabled, verifyWsAdminToken } from "../../../shared/ws-admin-token";
import {
    batchedTableLookup,
    readAdminAuditLog,
    readAdminDurableSignal,
    readAdminFacetColumn,
    readAdminIssues,
    readAdminRequestLog,
    readAdminRunSql,
    readAdminStorageOrphans,
    readAdminStorageReferences,
} from "./admin-readers";
import type {
    QueueBindingHandle,
    RunShardApplyCdcArgs,
    RunShardApplyCdcResult,
    RunShardBulkRowArgs,
    RunShardBulkRowResult,
    RunShardCdcSyncArgs,
    RunShardExportArgs,
    RunShardImportArgs,
    RunShardMigrationArgs,
    RunShardRankBeforeArgs,
    RunShardRankPageArgs,
    RunShardWriteArgs,
    RunShardWriteResult,
    WorkflowBindingHandle,
} from "./admin-rpc-args";
import {
    bookmarkHeaders,
    buildTestMailInput,
    cdcSuffix,
    decodeIndexHitKey,
    dispatchSpanKey,
    extractBearerToken,
    parseApplyCdcArgs,
    parseAssigneeArgument,
    parseBulkDeleteArgs,
    parseBulkPatchArgs,
    parseCdcSyncArgs,
    parseClearTableArgs,
    parseClientSeqHeader,
    parseCreateWorkflowInstanceArgs,
    parseEmit,
    parseGetWorkflowInstanceStatusArgs,
    parseIdentityHeader,
    parseIssueHash,
    parsePositiveInt,
    parseRankBeforeArgs,
    parseRankPageArgs,
    parseRecordAuthEventArgs,
    parseRecordContainerEventArgs,
    parseRecordMailArgs,
    parseRecordQueueMessageArgs,
    parseReplayQueueMessageArgs,
    parseRunAsArgs,
    parseRunMigrationArgs,
    parseSampleRate,
    parseSendQueueMessageArgs,
    parseSeverityArgument,
    parseTablePageFilters,
    parseTablePageOrderBy,
    parseWriteRowArgs,
    sampleHit,
    setsIntersect,
    tablesFromDeps,
    toWorkflowInstanceError,
    toWorkflowInstanceState,
} from "./admin-rpc-args";
import { buildBatchEntryRequest } from "./batch";
import { CdcRetentionRunner } from "./cdc-retention";
import { resolveSchemaHistoryRead } from "./schema-history-reads";
import { generateChart, generateFilter, generateSql } from "./sql-assistant";

/**
 * Client→server text frame the runtime answers with {@link WS_KEEPALIVE_PONG}
 * via the DO Hibernation API's auto-response — see {@link ShardDO.armWebSocketKeepalive}.
 * The exchange never wakes the Durable Object, so an idle subscription socket
 * stays alive across hibernation without a billable request. Clients send this
 * payload on their heartbeat instead of an app-level ping.
 */

/**
 * The success envelope for every admin RPC.
 *
 * `jsonResponse` is plain `Response.json`, and admin handlers return values read
 * straight out of the row store — `decodeDocJson` hands back a real `bigint` for
 * a `v.bigint()` column and a real `ArrayBuffer` for `v.bytes()`. Uncoded, the
 * first throws `TypeError: Do not know how to serialize a BigInt` (a whole shard
 * export 500s) and the second flattens to `{}` in a consumer's backup. Wrapping
 * the envelope once here covers every handler rather than leaving each to
 * remember; `createShardClient` already runs `decodeWire(body.result)` on every
 * admin call (`@lunora/runtime`'s `shard-client`), and both codecs are the
 * identity on pure-JSON payloads, so nothing else changes shape.
 */
const adminResponse = (result: unknown): Response => jsonResponse({ result: encodeWire(result) }, 200);

/**
 * The ingress half of {@link adminResponse}, so a payload this shard exported
 * can be handed straight back — `cdcSync` → `applyCdc`, `exportShard` →
 * `importShard` — with its `bigint`/bytes intact. Identity for pure-JSON args,
 * so every other op is unaffected.
 * @throws LunoraError `BAD_REQUEST` when the args are malformed — `decodeWire` raises a bare `RangeError` past its depth / bigint-digit bounds, and these are caller-supplied, so that is a 400 rather than the unmapped 500 it would otherwise become
 */
const decodeAdminArgs = (rawArgs: Record<string, unknown>): Record<string, unknown> => {
    let decoded: unknown;

    try {
        decoded = decodeWire(rawArgs);
    } catch {
        throw new LunoraError("BAD_REQUEST", "malformed admin RPC arguments");
    }

    // Decoding can change the SHAPE, not just the leaves: a top-level tagged
    // `undefined` decodes to a primitive and a root array stays an array.
    // Handlers index `args` before validating it, so the object-ness has to be
    // re-established here rather than assumed from the parameter type.
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        throw new LunoraError("BAD_REQUEST", "malformed admin RPC arguments");
    }

    return decoded as Record<string, unknown>;
};

const WS_KEEPALIVE_PING = "lunora-ping";
/** Canned reply the runtime returns for {@link WS_KEEPALIVE_PING}; never reaches a message handler. */
const WS_KEEPALIVE_PONG = "lunora-pong";

/**
 * Hard ceiling on a single inbound WS frame — 1Mi UTF-16 code units for a text
 * frame, 1 MiB for a binary one. Every subscription envelope the protocol defines
 * (`connect` / `subscribe` / `unsubscribe` / a mutator push) is kilobytes at most;
 * without an explicit cap the only bound is the platform's own per-message limit,
 * which is orders of magnitude larger than anything legitimate and leaves a decode
 * + `JSON.parse` of that size reachable per frame.
 *
 * Named UNITS, not BYTES: a text frame is measured with `String.length`, so an
 * all-astral-plane payload is up to ~4x this in bytes. That is the intended
 * trade — counting real bytes means encoding the string first, which is the exact
 * work the cap exists to avoid. It bounds the parse, not the wire.
 */
const MAX_WS_FRAME_UNITS = 1024 * 1024;

/** Get the per-socket `Map` stored under `ws` in `store`, creating it on first use. */
const socketMap = <V>(store: WeakMap<ShardSocketLike, Map<string, V>>, ws: ShardSocketLike): Map<string, V> => {
    let map = store.get(ws);

    if (!map) {
        map = new Map<string, V>();
        store.set(ws, map);
    }

    return map;
};

/**
 * The sink surface the DO hands its three signals to: `ctx.log` lines, `ctx.trace`
 * spans, and `ctx.metrics` measurements. Structurally compatible with
 * `@lunora/runtime`'s `ObservabilitySink` without taking a dependency on it.
 */
interface TelemetrySink {
    /**
     * Ship anything the sink has buffered, now. Called at the end of every
     * dispatch (and of an alarm / socket message), so a batching sink — which
     * exports one request per invocation instead of one per event — is never left
     * holding telemetry a quiet shard would sit on indefinitely. Optional: a
     * non-buffering sink simply omits it. Mirror of `@lunora/runtime`'s
     * `ObservabilitySink.flush`.
     */
    flush?: (context?: LogSinkContext) => void;

    /**
     * **Opt-in, EXPERIMENTAL, default off.** When `true`, each `ctx.trace` span is
     * ALSO emitted as a Cloudflare **custom span** (`tracing.enterSpan` from
     * `cloudflare:workers`, GA 2026-06-16) so it nests inside CF's native trace
     * tree on the hosted path — capability-probed, and a safe no-op off-CF / on an
     * older compat date / when unsampled. This only ADDS a CF-side span; the
     * `onSpan` event below (our `SpanBuffer`/`otlpSink`) is unchanged and stays the
     * source of truth. The bridge is now workerd-validated as available and
     * side-effect-free inside a real DO (our recorded spans stay intact); CF's
     * exported parent-linking under sampling is still unverified, so it stays
     * EXPERIMENTAL. Mirror of `@lunora/runtime`'s `ObservabilitySink`
     * `fuseCloudflareTraces`; see {@link createTracer} for the double-export caveat.
     */
    fuseCloudflareTraces?: boolean;

    /**
     * Detail level for automatic `ctx.db` instrumentation. Default `"summary"` —
     * aggregate counters folded onto the dispatch's root span when one is recorded,
     * so cost does not grow with call count and an uninstrumented handler still
     * emits nothing extra. Mirror of `@lunora/runtime`'s `ObservabilitySink`.
     */
    instrumentDatabase?: DatabaseInstrumentation;

    /**
     * **Opt-in, default off.** Durable per-minute `ctx.metrics.*` rollups written to
     * the reserved per-shard SQLite table (the Studio's local trend chart). Off by
     * default because every measurement then costs a durable SQLite write on the
     * request path — the live cross-instance path is `onMetric`, this is only the
     * local convenience. An object tunes the caps (`maxSeries` / `retentionBuckets`);
     * `true` uses the built-in defaults. Mirror of `@lunora/runtime`'s
     * `ObservabilitySink`.
     */
    metricHistory?: boolean | MetricHistoryOptions;
    onLog?: (event: LogEventInput, context?: LogSinkContext) => void;
    onMetric?: (event: MetricEvent, context?: LogSinkContext) => void;
    onSpan?: (event: SpanEvent, context?: LogSinkContext) => void;

    /**
     * Whether `ctx.fetch` is instrumented — a CLIENT span per outbound call plus
     * W3C `traceparent` propagation to the callee. Default on; set `false` to get
     * the bare platform `fetch`, or an object to control which destinations
     * receive trace context. Mirror of `@lunora/runtime`'s `ObservabilitySink`.
     */
    traceFetch?: boolean | { propagate?: ((url: URL) => boolean) | boolean };
}

/**
 * Memoized resolution of CF's `tracing` namespace, or `undefined` when custom
 * spans are unavailable. Backs the opt-in `makeTracer` Cloudflare custom-spans
 * bridge (see {@link createTracer}).
 *
 * Deliberately a guarded DYNAMIC import, not a top-level
 * `import { tracing } from "cloudflare:workers"`. A static named import of
 * `tracing` would be a module link-time dependency — on a compat date predating
 * custom spans the binding may not exist, and `@lunora/do` is also imported in
 * plain Node (the `@lunora/testing` harness), where `cloudflare:workers` cannot
 * resolve at all. The dynamic import runs ONLY when the bridge is enabled
 * (default off), and its `catch` turns any absence into a safe `undefined`.
 * `enterSpan` is additionally feature-probed (`typeof … === "function"`) so an
 * older runtime exposing a partial `tracing` still no-ops rather than throwing.
 *
 * Resolved at most once per isolate and cached (including the "unavailable"
 * verdict), so the import cost is paid a single time.
 */
let cloudflareTracingResolved = false;

let cloudflareTracing: HostTracingLike | undefined;

const resolveHostTracing = async (): Promise<HostTracingLike | undefined> => {
    if (!cloudflareTracingResolved) {
        cloudflareTracingResolved = true;

        try {
            const cloudflareModule = (await import("cloudflare:workers")) as { tracing?: unknown };
            const candidate = cloudflareModule.tracing;

            cloudflareTracing =
                candidate !== null && typeof candidate === "object" && typeof (candidate as HostTracingLike).enterSpan === "function"
                    ? (candidate as HostTracingLike)
                    : undefined;
        } catch {
            // Off-Cloudflare (e.g. the Node test harness) or a runtime without the
            // module — custom spans simply aren't available. A safe no-op.
            cloudflareTracing = undefined;
        }
    }

    return cloudflareTracing;
};

/**
 * Structural shape of the `ctx.log` logger the DO builds (see the server
 * `LunoraLogger`). Declared locally so `@lunora/do` takes no dependency on
 * `@lunora/server`; the overloaded public method type lives there.
 */
interface ContextLogger {
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;

    /**
     * Emit a **structured event** — OTel's Events API — rather than a log line.
     *
     * The difference is what carries the meaning. A log line's payload is its
     * message: prose, written for a human, free to be reworded next week. An
     * event's payload is its `fields` under a stable `name`, written for a query.
     * Only the second can answer "how many checkouts failed, by plan, this hour"
     * without a substring search over English.
     *
     * On the wire this sets OTel's `LogRecord.eventName` (plus the `event.name`
     * attribute for collectors predating that field), so any OTLP backend
     * recognises it without Lunora-specific configuration.
     */
    event: (name: string, fields?: LogFields) => void;
    fatal: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    log: (...args: unknown[]) => void;
    trace: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    with: (fields: LogFields) => ContextLogger;
}

/**
 * The only part of a trace anchor an alarm-path log site needs: the id it files
 * the line under.
 *
 * Declared here as a structural projection rather than re-exporting
 * `@lunora/observability`'s `TraceAnchor`, because `@lunora/do` deliberately
 * does not re-export observability (see this package's index) and the generated
 * shard — which forwards this value into `recordExternalSourceError` — must be
 * able to name the type without taking on that dependency. A real `TraceAnchor`
 * satisfies it, so internal callers pass theirs unchanged.
 */
interface TraceRefLike {
    traceId: string;
}

/**
 * Minimal projection of `DurableObjectState` that the ShardDO base requires.
 * Declared structurally so unit tests can pass in plain object doubles
 * without depending on the workers runtime.
 *
 * NOTE on hibernation attachments: the Workers runtime exposes
 * `serializeAttachment(value)` and `deserializeAttachment()` as methods on
 * the **WebSocket itself**, not on the DO state. The mock-based test suite
 * historically modeled them on the state — that has been corrected; the
 * production code now matches the workerd shape.
 */
interface ShardDOState {
    /** Abort + restart the DO — used to apply a native PITR restore immediately (`ctx.abort()`). */
    abort?: (reason?: string) => void;

    acceptWebSocket: (ws: WebSocket, tags?: string[]) => void;

    /**
     * Concurrency-blocking gate — `state.blockConcurrencyWhile(fn)` delays
     * the next fetch dispatch until `fn` resolves. Used by
     * {@link ShardDO.runInTransaction} to serialize the whole transaction span
     * against concurrent RPCs, so the handler's reads and writes are isolated
     * from other in-flight handlers on the same DO.
     */
    blockConcurrencyWhile?: <T>(callback: () => Promise<T>) => Promise<T>;
    getWebSockets: (tag?: string) => WebSocket[];
    /** Optional pointer to the DO instance id so we can detect `__root__`. */
    id?: { name?: string };

    /**
     * Register a constant ping/pong auto-response so the runtime answers a
     * known keepalive frame on a hibernated socket WITHOUT waking this DO (no
     * billable request, no dispatch). Optional: absent in the unit harness and
     * older runtimes, present on the real `DurableObjectState`.
     */
    setWebSocketAutoResponse?: (pair: WebSocketRequestResponsePair) => void;
    storage: {
        /** Native PITR (≤30 days): bookmark for a past `time`. Absent in local dev. */
        getBookmarkForTime?: (time: Date | number) => Promise<string>;
        /** Native PITR: bookmark for the object's current state. Absent in local dev. */
        getCurrentBookmark?: () => Promise<string>;
        /** Native PITR: arm a restore to `bookmark` on next restart; returns the undo bookmark. */
        onNextSessionRestoreBookmark?: (bookmark: string) => Promise<string>;

        /**
         * Arm the DO's single alarm to fire at `scheduledTime` (ms epoch),
         * waking {@link ShardDO.alarm}. Used by the global-shape poll loop.
         * Optional: present on the real runtime, absent in the unit harness
         * (where the poll loop degrades to seed-only).
         */
        setAlarm?: (scheduledTime: Date | number) => Promise<void>;
        sql: {
            [key: string]: unknown;

            /**
             * Current size of the SQLite database in bytes. Backed by a real
             * getter on the runtime — read on every access.
             */
            readonly databaseSize?: number;

            /**
             * Run a SQL statement without parameters. The runtime exposes this as
             * `state.storage.sql.exec(...)`; {@link ShardDO.runInTransaction} also
             * probes for it to confirm the handler will have a SQL connection.
             */
            exec?: (query: string) => unknown;
        };
    };
    /** Defer work past the response — used by `flushChangedTables` to keep the response path snappy. */
    waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Subset of the Workers `WebSocket` interface that exposes the hibernation
 * attachment methods. We type these structurally so the unit tests can pass
 * a plain object that satisfies the same contract — the real runtime adds
 * them to every socket returned via the Hibernation API.
 *
 * Note: `WebSocket` in `@cloudflare/workers-types` already declares these
 * methods as required. We deliberately do NOT extend that type — at runtime
 * inside `workerd` they're always present, but the unit tests pass plain
 * `WebSocket`-shaped objects that may not have them. The intersection here
 * is informational; the runtime calls are guarded with optional chaining.
 */
interface HibernatableWebSocket {
    deserializeAttachment?: () => unknown;
    serializeAttachment?: (value: unknown) => void;
}

/**
 * Result of re-running a subscription's query. `tables` is the set of tables
 * the query touched (discovered at runtime via the db adapter's `onRead`
 * hook) — the shard uses it to decide which writes should trigger a re-run.
 */
interface SubscriptionOutcome {
    /**
     * Index slices the run was provably confined to, per table — see
     * {@link SubscriptionMemo.ranges}. Absent when the run reported no
     * narrowable read.
     */
    ranges?: Map<string, KeyRange[]>;
    result: unknown;
    tables: Set<string>;
}

/**
 * What one reactor dispatch reports back to {@link ShardDO.dispatchReactors}.
 *
 * `digest` becomes the reactor's new baseline; `tables` is the read footprint
 * that decides whether a later flush needs to re-run it at all. The shard cannot
 * derive either without running the reactor, which is why the generated
 * `runReactor` override returns both rather than the base computing them.
 */
interface ReactorRunOutcome {
    digest: string;
    ran: boolean;
    tables: ReadonlyArray<string>;
}

/** Per-socket, per-shape poke baseline: the `__cdc_log` cursor this shape's view has been poked through. */
interface ShapeMemo {
    cursor: number;

    /**
     * The cursor of the last poke that actually carried ROWS for this shape —
     * i.e. what the client's own cursor for it is, since a client advances only
     * on a part it receives. Distinct from `cursor`, which also advances on an
     * empty diff (nothing to deliver, but the op range is covered); stamping
     * `cursor` as the client's expected base would fire a spurious gap on every
     * shape that had ever seen an empty flush.
     *
     * In-memory only, and `undefined` until this wake has delivered a part: a
     * hibernation eviction simply leaves the next part's base unstamped, which
     * disarms the gap check for one poke rather than guessing at it.
     *
     * Only `cursor` is written durably, and {@link ShardDO.retentionFloor} reads
     * that column — so the retention sweep trims against a value that can sit
     * above where the client actually is. See that method for why the gap it
     * opens is always empty.
     */
    delivered?: number;

    /**
     * This shape computed rows that were never handed to the socket — the send
     * threw mid-poke, or the resolve/diff itself threw before one could be built.
     * `cursor` is left where it was in that case, so the range is still owed.
     *
     * It exists because leaving `cursor` alone is not enough on its own: the very
     * next flush on an UNRELATED table finds the shape absent from `changed` and
     * force-advances `cursor` straight past the owed range, while `delivered`
     * stays behind — so the re-poke never happens AND the poke after it stamps a
     * `baseCheckpoint` the client agrees with, passing its gap check over a view
     * that is permanently missing rows. While this is set,
     * {@link ShardDO.collectShapePokeParts} diffs the shape unconditionally
     * instead, the op-log equivalent of the `.global()` poll loop's
     * `tick.requestResync()`. Cleared by {@link ShardDO.recordShapeMemo}, i.e. by
     * any advance — a delivered poke, or a diff that came back genuinely empty.
     */
    owed?: boolean;
}

/**
 * One distinct statement's folded activity within a dispatch — see
 * {@link ShardDO.currentStmtSamples}. `count` is how many raw executions
 * folded into this entry; `totalDurationMs`/`rowsRead`/`rowsWritten` are sums
 * across all of them, so `totalDurationMs / count` recovers the per-execution
 * average `recordQueryMetric`'s bucket histogram places the entry by.
 */
interface StmtSample {
    count: number;
    rowsRead: number;
    rowsWritten: number;
    totalDurationMs: number;
}

/**
 * Classification of a watermarked custom-mutator push against the shard's
 * `__client_watermark`: `expected` is the next in-order sequence, `kind`
 * whether the push is a replay (`"already"`), the next one (`"next"`), or an
 * out-of-order arrival (`"gap"`).
 */
type ClientMutationClass = { expected: number; kind: "already" | "gap" | "next" };

/**
 * The per-request identity/replay fields a dispatch must run under. Captured
 * before the mutation-replay gate and re-pinned inside it, because the gate only
 * delays ENTRY: a sibling `fetch()`'s prologue can overwrite the shared
 * `currentRequest*` fields while this dispatch waits its turn. Kept as one named
 * shape so the capture list lives in exactly one place instead of being an
 * unenforced "remember to add the next field here too" invariant.
 */
interface RequestScope {
    /**
     * The inbound `x-d1-bookmark`. In the scope for the same reason the identity
     * fields are: a queued mutation admitted after a sibling's prologue would
     * otherwise have `getInboundBookmark()` hand its `.global()` reads ANOTHER
     * request's D1 session pin, which is read-your-writes reading someone else's.
     */
    bookmark: string | undefined;
    clientId: string | undefined;
    clientSeq: number | undefined;
    mutationId: string | undefined;
    mutatorClass: ClientMutationClass | undefined;
    system: boolean;
    userId: string | undefined;
}

/**
 * The read-set / cache-hit attribution for ONE `/rpc` dispatch, filled in by
 * {@link ShardDO.runCachedQuery} and read back by {@link ShardDO.recordRequestLog}.
 *
 * A mutable object THREADED BY VALUE rather than a `currentRequest*` field on
 * the instance, for the same reason `dispatchHeadroom` and `dispatchTrace`
 * already are: a Durable Object serves concurrent `/rpc` dispatches, and every
 * one of these values is written after the handler's awaits. Off a shared field
 * they were whatever the LAST dispatch to resolve wrote — so the request log
 * filed one request's cache hit and read tables under another's, and a sibling's
 * prologue/epilogue could blank them out entirely. Both fields stay `undefined`
 * when the dispatch never reached the cache (a write/action, a cache-less shard,
 * or a query that fell through the re-entry guard) — the request log renders
 * that as "unknown" rather than asserting a read set.
 */
interface QueryAttribution {
    cacheHit?: boolean;
    readTables?: Set<string>;
}

/**
 * The reactive-cache read capture for ONE query dispatch: the dependency
 * tracker the cache indexes the entry by, plus the range footprint its
 * range-precise invalidation reads.
 *
 * Minted by {@link ShardDO.runCachedQuery} and threaded BY VALUE — handed to
 * its `run` callback, on through `handleRpc`'s fourth parameter, and into the
 * generated `buildCtx`, which binds it into the ctx-db read hooks via
 * {@link ShardDO.getCtxDbReadHook} / {@link ShardDO.getCtxDbReadRangeHook}. It
 * is NOT an instance field: a Durable Object serves concurrent `/rpc`
 * dispatches, and a shared field holds one capture for all of them — the second
 * query's reads would land in the first one's dep set and the second would be
 * skipped by the re-entry guard entirely (never read from the cache, never
 * stored).
 *
 * `AsyncLocalStorage` would carry it implicitly, but workerd only enables ALS
 * under `nodejs_compat` and shard DOs run the slimmer `sqlite_compat` profile —
 * see the header of `@lunora/shard-engine`'s `dependency-tracker.ts`.
 */
interface QueryReadScope {
    /** Range footprint for this dispatch — the `onReadRange` channel. */
    footprint: ReadFootprint;
    /** Dependency tracker for this dispatch — the `onRead` channel. */
    tracker: DependencyTracker;
}

/**
 * How an RPC dispatch resolved: the handler ran (`"ran"`), or the mutation-replay
 * cache already held this `(identity, mutationId)`'s result (`"cached"`).
 * Tagged rather than inferred from which half is `undefined`, so a `"cached"`
 * outcome whose stored value happens to BE `undefined` cannot be misread as a
 * fresh run.
 */
type DispatchOutcome = { cached: { value: unknown }; kind: "cached" } | { kind: "ran"; result: unknown };

/**
 * Shard-level configuration passed through `super(state, env, …)` by the
 * generated subclass, which sources every key from the app's
 * `createShardDO(config)` argument. A bag rather than positional args so
 * subclasses don't break when a knob lands.
 */
interface ShardDOOptions {
    /**
     * Whether every writer this shard builds spreads {@link ShardDO.ctxDbTuning}.
     * The emitter sets it, because it is the only thing that can see inside the
     * generated `buildCtx` and the admin/maintenance writers to know.
     *
     * Left unset (a hand-written subclass), {@link ShardDO.recordChangedTable}
     * keeps its coarse per-table invalidation backstop, so a writer that never
     * received the cache cannot serve a pre-write read. Set wrongly, it would
     * disable that backstop — which is why it is declared rather than inferred
     * from a call to the accessor.
     */
    ctxDbCacheWired?: boolean;

    /**
     * Ceiling on the join keys one relation-crossing `where` predicate may pull
     * back via semijoin pre-resolution before failing closed. Reaches
     * `createShardCtxDb` through {@link ShardDO.ctxDbTuning}; `undefined` keeps
     * the engine default (`DEFAULT_MAX_RELATION_KEYS`).
     */
    maxRelationKeys?: number;

    /**
     * Enable the per-shard reactive query cache. When provided, the dispatch
     * path routes every registered `query` through {@link ShardDO.runCachedQuery},
     * memoizing results by `(identity, functionPath, stable-stringified args)`.
     * Omit for the zero-overhead default (every dispatch re-runs the handler).
     *
     * The cache is invisible to the WS subscription bridge: invalidations land
     * via the ctx-db write hooks (the `cache` option {@link ShardDO.ctxDbTuning}
     * supplies) BEFORE the broadcast goes out, so subscribers that re-run their
     * queries in response always observe the post-write state.
     */
    reactiveCache?: ReactiveCacheOptions;

    /**
     * Resolution policy for relation-crossing `where` predicates whose child is
     * co-located in this shard — `"auto"` (cost-based, the engine default),
     * `"always"` (inline correlated EXISTS) or `"never"` (universal semijoin).
     * All three return identical rows. Reaches `createShardCtxDb` through
     * {@link ShardDO.ctxDbTuning}.
     */
    relationExistsPushDown?: "always" | "auto" | "never";
}

/**
 * The per-SOCKET facts a subscription push needs, resolved once per socket per
 * write-flush rather than once per subscription.
 *
 * Both depend only on the socket, never on the subscription being pushed, and a
 * single flush pushes many subscriptions down one socket — so recomputing them
 * inside {@link ShardDO.pushSubscriptionData} would repeat a
 * `__client_watermark` SELECT and an attachment read per subscription.
 */
interface SocketDelivery {
    /** This socket's custom-mutator watermark, stamped on every outgoing frame. */
    clientWatermark: number | undefined;

    /** Whether this socket announced {@link PAGE_DELTA_CAPABILITY} on `connect`. */
    pageDeltas: boolean;
}

/** Per-subscription memo used to suppress no-op pushes. */
interface SubscriptionMemo {
    lastJson: string;

    /**
     * Index slices this subscription's reads were provably confined to, keyed
     * by table. A table present here was read ONLY through the listed ranges,
     * so a write landing outside all of them cannot change the result. A table
     * in {@link SubscriptionMemo.tables} but absent here was read in some
     * unnarrowable way (a scan, a search, a join) and always re-runs.
     */
    ranges?: Map<string, KeyRange[]>;
    tables: Set<string>;
}

/**
 * Sentinel diff baseline meaning "no value has ever been delivered to this
 * socket for this subscription". Stored as a memo's `lastJson` when the very
 * first push to a socket fails to leave the outbound buffer. It can never equal
 * `JSON.stringify(value)` (which always yields valid JSON) and is not itself
 * valid JSON, so `subscriptionListDeltas` rejects it — the next write-flush
 * always re-sends a full snapshot rather than a delta against a value the client
 * never saw. See {@link ShardDO.pushSubscriptionData}.
 */
const UNDELIVERED_BASELINE = "<undelivered>";

/**
 * Threshold at which a `__root__` DO triggers the size warning. 1 GiB —
 * exactly 10% of the 10 GiB per-DO SQLite ceiling, leaving plenty of runway
 * to plan a `.shardBy()` migration before the wall hits.
 */
const ROOT_DO_SIZE_WARN_BYTES = 1_073_741_824;

/**
 * Retention window for mutation-replay dedup rows. A `(identity, mutationId)`
 * older than this is past any realistic offline-replay window, so pruning it
 * can only ever re-run a mutation the client long since saw acked.
 */
const IDEMPOTENCY_RETENTION_MS = 86_400_000;

/**
 * Minimum spacing between throttled, in-line GC sweeps of the dedup table —
 * at most one sweep an hour per warm instance, amortized onto a mutation
 * dispatch rather than a timer.
 */
const IDEMPOTENCY_GC_INTERVAL_MS = 3_600_000;

/**
 * The refusal a paid (`.x402`) procedure gets on a socket. The paywall lives at
 * the origin worker (`/_lunora/rpc`, REST, `serverQuery`), which a WebSocket
 * never crosses — and neither a live subscription (seed plus every poke) nor a
 * stream (one ack plus N chunks) is the one call one payment buys. Shared by the
 * `subscribe` gate, the `stream` gate and the refresh sweep so the three cannot
 * drift apart.
 */
const paidSocketRefusal = (functionPath: string, verb: "streamed" | "subscribed"): string =>
    `paid (\`.x402\`) function "${functionPath}" cannot be ${verb}; call it individually over /_lunora/rpc`;

/**
 * What the client is told when a socket cannot take another registration.
 *
 * Both refusals name the limit AND a way around it. An app only ever meets one
 * of them at runtime, in production, on the connection it was relying on — so
 * "cap reached" without a number to design against and a remedy to reach for is
 * a wall, not a diagnostic. The queries and shapes share one budget, which is
 * the part nobody guesses.
 */
const subscriptionRefusal = (kind: "count" | "size", cap: number, bytes: number): string =>
    kind === "count"
        ? `subscription cap of ${String(cap)} reached on this socket (live queries and shapes share it); unsubscribe an idle one, or open a second socket`
        : `failed to persist the socket attachment, which must stay under the ${String(bytes)}-byte hibernation limit (live queries and shapes share it); shrink the subscription's arguments, unsubscribe an idle one, or open a second socket`;

/**
 * The run-key component for a caller with no verified identity.
 *
 * Anonymous callers must not share a transcript with each other — collapsing
 * them onto a constant hands the second caller the first one's answer without
 * ever running the handler. But they should still resume their OWN run across a
 * reload, which is the whole point of a durable stream, so the key has to be
 * something stable across sockets.
 *
 * The client's own `clientId` (the stable id it sends on `connect`, already
 * trusted for the mutation watermark) is that. It is client-supplied, so it
 * separates honest callers rather than defending against a hostile one — which
 * is the right bar here: `userId` takes precedence whenever the socket has an
 * identity to check, so this path only ever governs anonymous traffic sharing
 * its own answers. A client that sent none falls back to its connection, which
 * isolates correctly and simply cannot resume.
 */
const anonymousStreamCaller = (attachment: SocketAttachment, streamId: string): string =>
    attachment.clientId === undefined ? `conn:${attachment.connectionId ?? streamId}` : `client:${attachment.clientId}`;

/**
 * The stream wire vocabulary, bound to one socket + stream id.
 *
 * Both stream paths — the ephemeral per-socket iterator and the durable
 * runner's sink — speak the same four frames. Building them in one place keeps
 * the two from drifting (they already had, on canceller cleanup), and keeps the
 * shape of an `error` frame in a single spot, which matters because the durable
 * path PERSISTS the message it sends and replays it to every later attach.
 */
const streamFrames = (
    ws: ShardSocketLike,
    id: string,
): {
    ack: () => void;
    chunk: (data: unknown, seq?: number, generation?: number) => boolean;
    complete: () => boolean;
    fail: (failure: { code: string; message: string }) => boolean;
} => {
    return {
        ack: () => {
            trySendFrame(ws, JSON.stringify({ id, type: "ack" }));
        },
        // `generation` rides only durable chunks (an `undefined` key is dropped
        // by JSON.stringify) — the client echoes it on resume so the server can
        // refuse to splice a different run's tail onto the prefix it holds.
        chunk: (data, seq, generation) =>
            trySendFrame(ws, JSON.stringify(seq === undefined ? { data, id, type: "chunk" } : { data, generation, id, seq, type: "chunk" })),
        complete: () => trySendFrame(ws, JSON.stringify({ id, type: "complete" })),
        fail: (failure) => trySendFrame(ws, JSON.stringify({ error: failure, id, type: "error" })),
    };
};

/**
 * Reserved shard name for the fallback Durable Object that hosts every
 * table without an explicit `.shardBy()` or `.global()` modifier.
 */

const ROOT_SHARD_NAME = "__root__";

/**
 * Dependency-set sentinel for admin introspection subscriptions that aren't
 * bound to a single user table (`getMetrics`, `getLogs`, `listTables`,
 * `migrationStatus`). It is `"*"` — a name no real SQLite table can take, so it
 * never collides with a tracked write — and `refreshSubscriptions` treats
 * a memo carrying it as "re-run on every write-flush".
 */
const ADMIN_WILDCARD = "*";

/**
 * Whether a subscription's memo proves this write cannot have changed its
 * result — the skip `refreshSubscriptions` applies before re-running a query.
 *
 * A MISSING memo means "unknown deps" and never skips. A memo carrying the
 * admin wildcard always re-runs: its value is not bound to any single table.
 * Otherwise the write is irrelevant either because none of the tables the memo
 * recorded changed at all, or because they did but every one of them was read
 * through a narrowed index slice and no written position falls inside one — any
 * table the memo did not narrow, or any write whose position was unknown, makes
 * `writeTouchesMemo` answer true and the re-run proceeds.
 */
const memoProvesUnchanged = (
    memo: SubscriptionMemo | undefined,
    changed: Set<string>,
    changedKeys: Map<string, IndexKeyEntry[] | undefined> | undefined,
): boolean => memo !== undefined && !memo.tables.has(ADMIN_WILDCARD) && (!setsIntersect(memo.tables, changed) || !writeTouchesMemo(memo, changed, changedKeys));

/**
 * Hard server-side ceiling on rows written per bulk admin call — `deleteRows`,
 * `clearTable`, `patchRows`. The op never touches more than this in one
 * round-trip; the result's `hasMore` tells the caller to loop. Bound TO
 * `readTablePage`'s `MAX_PAGE_SIZE` (not just documented as matching it) so one
 * "delete matching" / "set matching" batch drains exactly one full preview
 * page's worth of rows and the two can't silently drift apart.
 */
const SHARD_BULK_ROW_CAP = MAX_PAGE_SIZE;

/** Rows swept per TTL batch, and the max batches drained per alarm tick (bounds one sweep's work so it can't stall the shard). */
const TTL_SWEEP_BATCH = 200;
const TTL_SWEEP_MAX_BATCHES = 20;
/** Cadence the TTL sweep re-arms its shared-alarm tier at while any `.ttl()` table exists — a coarse, bounded expiry window. */
const TTL_SWEEP_INTERVAL_MS = 30_000;

/**
 * FIFO bound on {@link ShardDO.dispatchSpans}. A dispatch deletes its own entry
 * in the `finally`, so this only matters for ctxs built outside one (an alarm, a
 * subscription re-run) which mint an anchor and never reach that boundary. Sized
 * well above any realistic interleave depth — it is a leak backstop, not a
 * working set.
 */
const MAX_TRACKED_DISPATCH_SPANS = 256;

/**
 * Bound on the per-trace held-span array a sampled-out dispatch accumulates for
 * the tail-bias flush (see {@link ShardDO.recordSpan}). Matches the span ring's
 * capacity — a trace holding more spans than the whole ring could retain is
 * already pathological, and the array is dropped wholesale when the dispatch
 * `finally` deletes the `traceSampling` entry, so this is a backstop against a
 * runaway single trace, not a working set.
 */
const MAX_HELD_SPANS_PER_TRACE = 500;

/**
 * Bound on distinct normalised statements folded into
 * {@link ShardDO.currentStmtSamples} per dispatch. Mirrors
 * `database-telemetry.ts`'s `MAX_DB_SPANS_PER_CTX`: a handler that queries in a
 * loop already folds repeats of the SAME statement into one running entry (see
 * `sql` getter), so this only bounds the number of DISTINCT statement shapes one
 * dispatch can accumulate before {@link ShardDO.flushStmtSamples} starts
 * dropping brand-new ones — a handler building ad-hoc SQL per iteration
 * (dynamic column lists, generated `IN (...)` clauses) would otherwise grow the
 * buffer, and the flush that drains it, without bound.
 */
const MAX_STMT_SAMPLES_PER_DISPATCH = 200;

/**
 * `event.name` of the per-dispatch wide event. Namespaced so it never collides
 * with an application's own `ctx.log.event(...)` names, and stable because
 * dashboards and alerts will filter on it.
 */
const WIDE_EVENT_NAME = "lunora.dispatch";

/**
 * Flatten a {@link ReadFootprint.ranges} snapshot into the flat array
 * `ReactiveCache.run`'s `ranges` thunk expects. `undefined` (nothing
 * narrowable) becomes `[]` — the thunk's own default — rather than a special
 * case the caller has to know about.
 */
const flattenReadRanges = (byTable: Map<string, KeyRange[]> | undefined): KeyRange[] => (byTable ? [...byTable.values()].flat() : []);

/**
 * Base class for shard Durable Objects.
 *
 * Concrete subclasses implement `handleRpc` and may emit deltas via
 * `broadcastDelta`. Subscriptions are stored on each WebSocket via
 * `serializeAttachment` so they survive hibernation.
 */
abstract class ShardDO {
    /**
     * Per-socket cap on concurrent stream iterators. Each in-flight stream
     * pins an `AbortController` + the user's async generator + any buffered
     * chunks on the WS — letting a client open hundreds of streams in
     * parallel would let it pin DO memory without ever sending a message.
     * 8 is generous for legitimate clients (the studio rarely opens more
     * than 2-3 simultaneously) and small enough that the worst-case memory
     * footprint stays bounded.
     */
    protected static readonly MAX_STREAMS_PER_SOCKET = 8;

    /**
     * The runtime's hard ceiling on one hibernation attachment.
     *
     * MEASURED against workerd rather than taken from a doc page: a
     * `serializeAttachment` of 16385 bytes throws
     * `A WebSocket 'attachment' cannot be larger than 16384 bytes.`, and 8192
     * succeeds. The measurement lives in
     * `__tests__/shard-do.subscription-cap.test.ts`; the workerd half is
     * `__tests__/workerd/shard-do.workerd.test.ts`.
     *
     * This is the bound that actually binds, and the runtime is the only thing
     * that enforces it — deliberately. A pre-flight size check here would need a
     * second size model, and `JSON.stringify` is not it: an attachment
     * legitimately holds the decoded wire types (`bigint`, `Date`, bytes), and
     * stringifying a `bigint` throws. So `subscribe`/`shapeSubscribe` let the
     * runtime refuse, roll the registry back, and spend this constant on saying
     * WHY — the hibernation API makes them swallow the throw itself, and
     * "failed to persist subscription attachment" is not something an app can
     * act on.
     */
    protected static readonly MAX_ATTACHMENT_BYTES = 16_384;

    /**
     * Per-socket cap on `subs` + `shapes` together — a coarse backstop on
     * per-poke fan-out work, NOT the storage bound.
     *
     * The storage bound is {@link ShardDO.MAX_ATTACHMENT_BYTES}, and it is the
     * one that can actually stop a legitimate app: every registration is
     * persisted in the hibernation attachment as `{functionPath, table, args,
     * sinceSeq, sinceEpoch}` beside `connectionId`/`userId`/`identity`/
     * `clientId`/`context`/`whispers`, and `args` is the client's to choose, so
     * no fixed count can bound it.
     *
     * 32 against the measured numbers: a realistic registration (a function
     * path, one id argument, a limit, a cursor and an epoch uuid) costs ~218
     * bytes, and a fully decorated socket's fixed fields — identity claims, app
     * `context`, whisper topics — about 550. 32 of them is ~7.5 KB, under half
     * the 16384-byte ceiling, so the count cap never fires before the byte
     * budget for a record of that shape. It fires only for registrations small
     * enough that 32 of them are cheap, which is where a fan-out backstop
     * belongs.
     *
     * This was briefly 8, derived from a 2048-byte attachment budget that the
     * runtime does not impose — 8× too small, and low enough to break an app
     * holding a dozen live queries on one socket at runtime, which is the
     * failure this number exists to avoid.
     *
     * Both numbers are asserted in `__tests__/shard-do.subscription-cap.test.ts`.
     */
    protected static readonly MAX_SUBSCRIPTIONS_PER_SOCKET = 32;

    /**
     * How many times one `onQueryChange` reactor may run within a single refresh
     * drain before it is treated as non-converging and dropped for the rest of
     * that drain.
     *
     * This is a correctness backstop, not a performance knob. A reactor's handler
     * writes, those writes flush, and that flush re-evaluates reactors — so a
     * handler that always changes what its own `select` returns never settles and
     * would spin the shard indefinitely. 8 is generously above any legitimate
     * cascade: an actor advancing a state machine converges in a handful of steps
     * (each one removing rows from the set it watched), and anything needing more
     * than 8 rounds off a single mutation is describing a loop, not a workflow.
     *
     * Scoped per DRAIN, so sustained legitimate write load is never throttled —
     * each new drain restarts every reactor's budget. Only a cascade WITHIN one
     * drain, which is exactly the non-convergence signature, can exhaust it.
     */
    protected static readonly MAX_REACTOR_RUNS_PER_DRAIN = 8;

    /**
     * Poll interval (ms) for `.global()`-table shapes. A global table lives in
     * D1 with no per-DO op-log, so its shapes can't be poke-live; the DO re-reads
     * each subscribed global shape's membership from D1 on an alarm every
     * `GLOBAL_SHAPE_POLL_INTERVAL_MS` and pokes only the diff. This is the
     * latency floor for a global-shape update — deliberately coarse (seconds, not
     * the sub-millisecond poke-live path) since the D1 read fans out per tick.
     */
    protected static readonly GLOBAL_SHAPE_POLL_INTERVAL_MS = 2000;

    /**
     * Upper bound on a `.global()`-shape's materialized membership. Each global
     * shape keeps its ENTIRE current membership as a per-socket snapshot
     * (`Map<rowKey, hash>`) so the poll loop can diff it; that snapshot — and the
     * read buffer feeding it — scale with the membership size, multiplied by every
     * subscribed socket. An unbounded membership (a global table with no narrowing
     * shape predicate or RLS read scope) would grow them without limit and evict
     * the DO. A shape whose membership exceeds this cap is failed closed (left
     * empty, logged) rather than retained — the developer must narrow it. Sized
     * well above any reasonable per-identity replicated set so legitimate shapes
     * never trip it.
     */
    protected static readonly GLOBAL_SHAPE_MAX_ROWS = 50_000;

    /**
     * How long a `.global()` poll may go without an unconditional membership
     * pass. Between resyncs the poll trusts the global changelog and skips
     * unchanged tables; a resync re-reads regardless, so a write that left no
     * changelog row (another system writing the same database) still surfaces
     * within this window instead of never.
     */
    protected static readonly GLOBAL_SHAPE_RESYNC_MS = 30_000;

    /**
     * Per-socket whisper-topic cap. Topic membership rides the same hibernation
     * attachment as `subs`, so bound it for the same reason — a runaway
     * `whisper_subscribe` loop must not wedge the attachment past the runtime's
     * size budget. Over-cap joins are silently ignored (whispering is
     * best-effort, never acked).
     */
    protected static readonly MAX_WHISPER_TOPICS_PER_SOCKET = 64;

    /**
     * Cap on the serialized size (bytes) of a whisper `data` payload. Whispers
     * carry small awareness blobs (cursor, typing flag); bounding the payload
     * stops a client from turning the fan-out into a bandwidth-amplification
     * vector. An over-limit whisper is dropped (best-effort, never acked).
     */
    protected static readonly MAX_WHISPER_BYTES = 4096;

    /**
     * Whisper-rate token bucket: each socket may burst {@link ShardDO.WHISPER_RATE_BURST}
     * whispers, refilling at {@link ShardDO.WHISPER_RATE_PER_SEC}/s. Without this a single
     * client could loop `whisper` frames, each costing O(connections) to fan out
     * — an O(N) CPU + egress amplification the per-message byte cap alone doesn't
     * close. In-memory (resets to full burst on hibernation, which is the
     * conservative direction).
     */
    protected static readonly WHISPER_RATE_BURST = 50;

    protected static readonly WHISPER_RATE_PER_SEC = 25;

    /**
     * Set once the very first `__root__` warning has been emitted. Static so
     * a hot DO cannot spam the log on every write; the v0.1 lifetime of a DO
     * exceeds any reasonable cooldown so a single warning is sufficient. The
     * test suite resets this via `resetRootSizeWarning` for isolation.
     */
    private static rootSizeWarned = false;

    /** Test-only: reset the static "warned once" flag. */
    public static resetRootSizeWarning(): void {
        ShardDO.rootSizeWarned = false;
    }

    /**
     * Compute the shared poll alarm's next wake time from both tiers' signals.
     * Global shapes need the fixed `GLOBAL_SHAPE_POLL_INTERVAL_MS` floor whenever
     * any are subscribed (a global table has no per-DO op-log, so it can only be
     * polled). External-source ingest instead reports the earliest NEXT-DUE
     * timestamp across its non-manual sources (or `undefined` when none exist) —
     * a source with a large `refresh.everyMs` must sleep until it's actually due,
     * not spin at the global-shape floor. Returns `undefined` when NEITHER tier
     * has pending work, so the DO can go fully idle instead of re-arming for no
     * reason; otherwise the earlier of the two candidate times (never later than
     * `nowMs`, so a source that's already due arms essentially immediately).
     */
    private static nextPollAlarmTarget(
        globalShapesRemaining: number,
        nextSourceDueAt: number | undefined,
        nextTtlDueAt: number | undefined,
        nowMs: number,
    ): number | undefined {
        const globalTarget = globalShapesRemaining > 0 ? nowMs + ShardDO.GLOBAL_SHAPE_POLL_INTERVAL_MS : undefined;

        // The earliest of the tiers that report a pending time; a tier that's
        // already due (past timestamp) is floored to `nowMs` so it arms promptly.
        const candidates = [globalTarget, nextSourceDueAt, nextTtlDueAt]
            .filter((value): value is number => value !== undefined)
            .map((value) => Math.max(value, nowMs));

        return candidates.length > 0 ? Math.min(...candidates) : undefined;
    }

    protected state: ShardDOState;

    protected env: unknown;

    /**
     * Opt-in per-shard reactive query cache. Instantiated when the generated
     * subclass passes `reactiveCache` through
     * `super(state, env, { reactiveCache: { … } })`; otherwise undefined and the
     * dispatch path runs with zero cache overhead.
     *
     * The cache is per-shard and in-memory only — it is lost on DO restart and
     * on workerd hibernation. That's fine: a cold shard simply re-runs the query
     * on the first call.
     */
    protected readonly reactiveCache: ReactiveCache | undefined;

    /**
     * Running read tallies for the shape-poke path, surfaced next to
     * {@link ShardDO.fanout} on `getFanoutMetrics`. `run` counts the reads this
     * instance issued to SQLite; `served` counts the ones the per-flush
     * {@link ShapeDiffCache} answered because another socket had already asked the
     * identical question. BOTH halves of the diff are counted — the changed-key
     * scan keyed by `(table, op range)` and the membership probe keyed by
     * `(effectiveWhere, that same range)` — so the reported sharing rate covers
     * the work the cache actually does rather than half of it.
     *
     * Without the split the sharing is invisible: a flush that collapsed a
     * hundred reads into one looks exactly like a flush that only ever had one
     * shape.
     */
    protected shapeProbe: ShapeProbeCounters = createShapeProbeCounters();

    /**
     * Running `.global()` poll tallies, reported alongside {@link ShardDO.shapeProbe}.
     * `run` counts membership drains actually issued to the global backend;
     * `served` counts the (socket, shape) pairs a tick skipped because the global
     * changelog proved their table had not moved.
     */
    protected globalPoll: GlobalPollCounters = createGlobalPollCounters();

    /** ctx-db relation knobs from {@link ShardDOOptions}, handed on by {@link ShardDO.ctxDbTuning}. */
    private readonly ctxDbRelationOptions: Pick<ShardDOOptions, "maxRelationKeys" | "relationExistsPushDown">;

    /**
     * Whether {@link ShardDO.ctxDbTuning} has been consulted, i.e. whether the
     * subclass's `createShardCtxDb` call is wired to the precise, per-row
     * invalidation half of the cache contract.
     *
     * It gates a coarse fallback in {@link ShardDO.recordChangedTable}: a shard
     * whose writer never received the cache would otherwise keep serving
     * memoized results across writes — stale reads, silently. The fallback drops
     * every entry on a written table, which is strictly more invalidation than
     * the wired path does, so the two never disagree about correctness; only
     * about hit rate.
     */
    private readonly ctxDbCacheWired: boolean;

    /**
     * The host-neutral engine runner. `fetch` and `alarm` delegate through it, so
     * the dispatch entry points name a platform contract rather than a Durable
     * Object. While the engine extraction is in progress the runner forwards back
     * to the Cloudflare implementations below through its `handlers` seam.
     */
    private readonly runner: ShardRunner;

    /**
     * This shard's storage/execution slot. Replaces direct `state.storage` reach-
     * through, so the SQL hot path and the transaction boundary are expressed
     * against a contract any host can satisfy.
     */
    private readonly shardHost: ShardHost;

    /**
     * Hibernated socket accept/enumerate/tag, alongside {@link ShardDO.shardHost}.
     * Enumeration yields handles rather than raw sockets, which is what lets the
     * per-socket memo maps key identically on the event and fan-out paths.
     */
    private readonly socketHost: SocketHost;

    /**
     * Lazily-built drizzle handle over `state.storage`. Memoised so a single
     * DO instance reuses the same dialect across handler calls. The drizzle
     * DO driver only touches `storage.sql`, so test doubles only need to
     * supply that field — see {@link ShardDOState}.
     */
    private drizzleHandle: DrizzleSqliteDODatabase<Record<string, unknown>> | undefined;

    /**
     * Tracks transaction nesting so we can reject nested transactions —
     * SQLite-in-DO does not support them and the runtime would crash with
     * "cannot start a transaction within a transaction".
     */

    /**
     * The once-per-instance shard-init run, memoized. Absent until the first
     * dispatch on this instance; absent again after an eviction drops the heap,
     * which is precisely when init has to happen. See
     * {@link ShardDO.ensureShardInit}.
     */
    private shardInitOnce?: Promise<void>;

    private transactionDepth: number = 0;

    /**
     * Per-request D1 Sessions API bookmark, read from the inbound
     * `x-d1-bookmark` header at the top of `fetch` and exposed to handlers
     * via `getInboundBookmark`. Cleared between requests so a stale
     * bookmark from a previous client never leaks into the next session.
     */
    private currentRequestBookmark: string | undefined;

    /**
     * Per-request D1 bookmark to echo on the outbound response. Handlers
     * call `setOutboundBookmark` after a global-table write so the
     * client can pin subsequent reads on the same replica.
     */
    private currentResponseBookmark: string | undefined;

    /**
     * Per-request userId forwarded from the runtime via the
     * `x-lunora-userid` header. Surfaced to handlers via
     * `getCurrentUserId`. Cleared in the `finally` block of `fetch`
     * so a stale identity from a previous client never leaks into the
     * next request.
     */
    private currentRequestUserId: string | undefined;

    /**
     * Per-request caller IP forwarded from the runtime via the
     * `x-lunora-client-ip` header (sourced server-side from Cloudflare's trusted
     * `CF-Connecting-IP`). Surfaced to handlers as `ctx.ip` via `getCurrentIp`;
     * cleared in the `finally` block of `fetch` like the other per-request fields.
     */
    private currentRequestIp: string | undefined;

    /** W3C `traceparent` of the inbound RPC; forwarded onto outbound container fetches. */
    private currentRequestTraceparent: string | undefined;

    /**
     * Trace ids for the in-flight dispatch, resolved once at entry (see
     * {@link resolveTraceAnchor}). Shared by `ctx.trace` and by the synthetic
     * root span recorded on the way out so both agree even with no inbound
     * `traceparent`. Cleared in the same `finally` as the other per-request
     * fields.
     */
    private currentRequestTrace: { rootSpanId: string; traceId: string } | undefined;

    /**
     * Anchor of the in-flight trigger (`withTriggerTrace`), handed across the
     * `runner.handleAlarm()` boundary that stops the alarm handler from just
     * taking it as an argument.
     *
     * A field only because of that indirection, and read under one rule: capture
     * it into a local SYNCHRONOUSLY at the top of the handler, before any `await`.
     * Read later it is no safer than `currentRequestTrace` — a socket frame
     * interleaving at an await point would pick up the alarm's trace and file its
     * own failure under it. Everything downstream takes the captured value as a
     * parameter for exactly that reason.
     */
    private currentTriggerTrace: TraceAnchor | undefined;

    /**
     * Per-trace head-sampling state, keyed by `traceId` so concurrent dispatches on
     * the same DO instance can't clobber each other's decision. A DO interleaves
     * dispatches across `await` points, and the span-recording and error-flush
     * choke points run after a span body (or the whole dispatch) settles — by which
     * point a flat per-instance field could have been overwritten by a sibling
     * dispatch (the same hazard `dispatchTrace` guards against for the trace anchor).
     * Each entry holds `sampled` (the inbound `traceparent` flag; absent means keep,
     * so alarms, subscription re-runs and non-Lunora callers export exactly as
     * before — when false, `ctx.trace` INTERNAL spans are held out of the live export
     * and re-decided in the dispatch `finally` as a tail bias), `keepErrors` (the
     * runtime's `x-lunora-sample-errors` / `alwaysSampleErrors` toggle — a sampled-out
     * trace that errored is still exported whole unless off), `sink` (captured
     * when a sampled-out span is first held, so the `finally` can flush the trace's
     * held spans), and `held` (the sampled-out spans themselves, buffered ON THIS
     * ENTRY rather than read back from the shared span ring — the ring is bounded and
     * a concurrent trace could evict this trace's error spans before the flush, which
     * would silently defeat `alwaysSampleErrors`; bounded by
     * {@link MAX_HELD_SPANS_PER_TRACE}). Registered at dispatch entry by the
     * dispatch's own `traceId`, read by `span.traceId`, and deleted in the `finally`
     * (which drops `held` with it, so no spans leak past the dispatch).
     */
    private traceSampling = new Map<string, { held?: SpanEvent[]; keepErrors: boolean; sampled: boolean; sink?: TelemetrySink }>();

    /**
     * The per-dispatch **wide event** — everything a handler attached through
     * `ctx.span` — keyed by `traceId` for exactly the reason `traceSampling`
     * is: a DO interleaves dispatches across `await` points, and a flat field
     * would let a sibling dispatch's attributes land on this one's span.
     *
     * A wide event is the answer to "monitor everything without drowning in
     * logs": rather than a dozen `ctx.log.info` lines whose only readers are
     * humans grepping, a handler accumulates its facts onto the ONE span the
     * dispatch already emits, and the collector gets a single richly-attributed
     * record it can group and aggregate. Cost is flat — one span per request,
     * however much you attach.
     *
     * Keyed by {@link dispatchSpanKey} (trace id AND root span id) rather than
     * `traceId` alone — see there for the concurrent-dispatch collision that
     * distinction prevents.
     *
     * Bounded by {@link MAX_TRACKED_DISPATCH_SPANS}: the dispatch `finally`
     * deletes its own entry, but a ctx built outside a dispatch (an alarm, a
     * subscription re-run) mints its own anchor and has no such boundary, so the
     * map is FIFO-capped rather than trusted to drain.
     */
    private dispatchSpans = new Map<string, { collector?: SpanCollector; dbTally?: DatabaseTally; sink?: TelemetrySink }>();

    /**
     * The most recent telemetry sink seen while building a ctx — the flush handle
     * for paths that have no ctx of their own (see `flushTelemetry`).
     */
    private lastTelemetrySink: TelemetrySink | undefined;

    /**
     * Client-issued idempotency key for the in-flight mutation, forwarded via the
     * `x-lunora-mutation-id` header. When set, the dispatch path dedups the call
     * by `(currentRequestUserId, mutationId)`: a replay short-circuits to the
     * cached result, and `persistIdempotentResult` records the result right
     * after the handler's writes commit so the dedup row is durable iff the
     * writes are. Absent on queries and legacy clients. Cleared in the `fetch`
     * `finally` block.
     */
    private currentRequestMutationId: string | undefined;

    /**
     * Stable per-device client id for the in-flight custom-mutator push,
     * forwarded via the `x-lunora-client-id` header. Backs the
     * `__client_watermark` table: the dispatch path classifies the paired
     * `currentRequestClientSeq` against the stored high-watermark (already
     * processed / next / out-of-order gap). Absent on legacy mutations and
     * queries (those keep the `__idempotency` path). Cleared in `fetch`'s
     * `finally`.
     */
    private currentRequestClientId: string | undefined;

    /**
     * Monotonic per-client mutation sequence for the in-flight custom-mutator
     * push, forwarded via the `x-lunora-client-seq` header (numeric). Paired
     * with `currentRequestClientId` to drive the watermark classification.
     * `undefined` when absent or non-numeric.
     */
    private currentRequestClientSeq: number | undefined;

    /**
     * The in-flight push's custom-mutator classification, stashed by `fetch`
     * before `handleRpc` so the in-transaction bookkeeping ({@link
     * ShardDO.commitMutationBookkeeping}) can advance the `__client_watermark` for
     * a `"next"` push inside the same commit as the writes. `undefined` for an
     * ordinary mutation / non-mutator push. Cleared per request.
     */
    private currentMutatorClass: ClientMutationClass | undefined;

    /**
     * Set once a mutation's replay bookkeeping (idempotency row + watermark
     * advance) has committed INSIDE the handler transaction, so the post-dispatch
     * path skips the now-redundant best-effort writes. Cleared per request; stays
     * `undefined` for actions/queries (no transaction wrapper) so their
     * dispatch-level idempotency persist still runs.
     *
     * It carries the committing dispatch's `x-lunora-mutation-id` rather than being
     * a bare boolean, because this is a SHARED field on an instance that serves
     * concurrent dispatches — see {@link ShardDO.recordPostDispatchBookkeeping} for
     * what a bare boolean let a concurrent mutation do to an action's replay guard.
     * A mutation carrying no id records `{ mutationId: undefined }`, which is still
     * distinguishable from "nothing committed".
     */
    private mutationBookkeeping: { mutationId: string | undefined } | undefined;

    /**
     * Wall-clock millis of the last `__idempotency` GC sweep on this warm
     * instance. The dedup write throttles `trimIdempotent` to at most once an
     * hour off this field (in-memory, so a fresh instance just sweeps on its
     * first mutation) — keeping the 24h-retention cleanup off the per-mutation
     * hot path without needing a separate alarm/cron.
     */
    private lastIdempotencyTrimAt = 0;

    /**
     * Changelog retention: the throttled sweep that bounds `__cdc_log` and the
     * archive-backed read that serves a consumer once it can no longer be
     * answered from the live log.
     *
     * Every input is a thunk, so this field initializer can run before the
     * constructor has assigned `env` — and so `sql` and the retention floor are
     * read at the moment the sweep uses them rather than the moment this was
     * built, which is the property the deferred destructive step depends on.
     */
    private readonly cdcRetention = new CdcRetentionRunner({
        enabled: () => this.cdcEnabled(),
        env: () => this.env,
        epoch: () => this.currentCdcEpoch(),
        recordError: (scope, error) => {
            this.recordShapeError(scope, error);
        },
        retentionFloor: (sql) => this.retentionFloor(sql),
        shardKey: () => this.currentShardKey(),
        sql: () => this.sql as SqlExec,
        waitUntil: (promise) => this.shardHost.waitUntil?.(promise),
    });

    /**
     * Per-request identity envelope forwarded from the runtime via the
     * `x-lunora-identity` JSON header. Stores claims like `email`,
     * `name`, or custom roles populated by `resolveIdentity` on the
     * worker. Surfaced to handlers via `getCurrentIdentity`.
     */
    private currentRequestIdentity: Record<string, unknown> | undefined;

    /**
     * Whether the in-flight `/rpc` call is a trusted server-initiated dispatch
     * (scheduler/cron), signalled by the `x-lunora-system` header that only the
     * worker's authorized dispatch path sets. When true, `handleRpc` may invoke
     * `internal` functions; client RPCs never carry it, so internals stay
     * unreachable across the external boundary. Cleared in `fetch`'s `finally`.
     */
    private currentRequestSystem = false;

    /**
     * Tables written during the in-flight RPC, accumulated by
     * `recordChangedTable`. Drained after `handleRpc` returns to drive
     * `refreshSubscriptions`. `null` when no write has happened yet so
     * the common read-only path allocates nothing.
     */
    private pendingChangedTables: Set<string> | undefined = undefined;

    /**
     * Index positions written during the current RPC, keyed by table. A value of
     * `undefined` means at least one write to that table had no derivable
     * position, so the table cannot be narrowed for this batch. Drained
     * alongside {@link ShardDO.pendingChangedTables}.
     */
    private pendingChangedKeys: Map<string, IndexKeyEntry[] | undefined> | undefined = undefined;

    /** Coalesced twin of {@link ShardDO.pendingChangedKeys} for the in-flight refresh pass. */
    private pendingRefreshKeys: Map<string, IndexKeyEntry[] | undefined> | undefined = undefined;

    /**
     * Coalesced set of tables awaiting a subscription-refresh pass, merged
     * across every {@link ShardDO.flushChangedTables} call that lands while a
     * pass is already draining. The single drain loop
     * ({@link ShardDO.drainSubscriptionRefreshes}) owns this set; a burst of N
     * writes to the same table therefore collapses into one (or two) refresh
     * passes instead of N, so each affected subscription's handler re-runs once
     * per burst rather than once per write. `undefined` when nothing is pending.
     */
    private pendingRefreshTables: Set<string> | undefined = undefined;

    /** True while {@link ShardDO.drainSubscriptionRefreshes} is running; the single-waiter gate that coalesces concurrent flushes. */
    private refreshInFlight = false;

    /**
     * Last pushed result per `(socket, subId)`, keyed by socket. Lets
     * `refreshSubscriptions` skip re-running queries whose tables were
     * untouched and suppress pushes when the re-run result is unchanged. Held
     * in memory only — it does not survive hibernation, which is safe: a cold
     * memo simply forces one re-run and (at most) one redundant push.
     */
    private readonly subMemos = new WeakMap<ShardSocketLike, Map<string, SubscriptionMemo>>();

    /**
     * Per-socket poke baseline for shape subscriptions: maps each shape's
     * subscription id to the `__cdc_log` cursor it has been poked through.
     * `pokeShapeSubscribers` reads each op page since this cursor and advances
     * it to the flush watermark.
     *
     * This is a hot in-memory **cache** over the durable `__shape_poke_cursor`
     * table (keyed by the socket's `connectionId` + subId), mirroring
     * {@link ShardDO.globalShapeSnapshots}: a hibernation eviction clears the
     * WeakMap, so on the next wake {@link ShardDO.readShapeMemoCursor} misses
     * and falls back to the stored cursor, then the shape's subscribe-time
     * `sinceSeq` off the attachment, and finally `0` — without the durable
     * fallback, every wake's first write would rescan the entire retained
     * `__cdc_log` for that table from `0` instead of resuming where the
     * socket left off.
     */
    private readonly shapeMemos = new WeakMap<ShardSocketLike, Map<string, ShapeMemo>>();

    /**
     * Per-socket, per-**global**-shape membership snapshot: maps each global
     * shape's subscription id to a `key → projected-value JSON` map of the rows
     * last poked to that socket. A `.global()` (D1) table has no op-log to diff,
     * so {@link ShardDO.refreshGlobalShape} re-reads the full membership on each
     * alarm tick and diffs it against this snapshot to compute the poke. Parallel
     * to {@link ShardDO.shapeMemos} (the cursor baseline for poke-live shapes).
     *
     * This is a hot in-memory **cache** over the durable `__global_shape_snapshot`
     * table (keyed by the socket's `connectionId` + subId): a hibernation eviction
     * clears the WeakMap, so on the next alarm wake {@link ShardDO.readGlobalSnapshot}
     * misses and re-loads the baseline from SQLite — without it, the diff would run
     * against an empty baseline and a row deleted from D1 while the DO slept would
     * never be poked as a `delete`, lingering on the client as a phantom row.
     */
    private readonly globalShapeSnapshots = new WeakMap<ShardSocketLike, Map<string, Map<string, string>>>();

    /**
     * Whether the `__global_shape_snapshot` table has actually answered a read on
     * this instance.
     *
     * Separates "the durable row is missing" from "there is no durable store at
     * all". A unit harness passes a stub `sql` handle, so every snapshot read and
     * write throws and the baseline lives only in
     * {@link ShardDO.globalShapeSnapshots} — the documented pre-durable behaviour,
     * and not something to log or to treat as a lost baseline. On a real shard the
     * table is created by migration, so the first read sets this and a missing row
     * from then on means exactly what it says.
     */
    private durableSnapshotStoreAvailable = false;

    /**
     * Whether a global-shape poll alarm is currently armed. Guards
     * {@link ShardDO.scheduleGlobalPoll} from re-arming on every seed; reset in
     * {@link ShardDO.alarm} before the poll so a still-subscribed shape re-arms.
     */
    private globalPollScheduled = false;

    /** Monotonic per-DO poke id source; correlates a poke's `pokeStart`/`pokePart`/`pokeEnd` frames. */
    private pokeSequence = 0;

    /** Per-socket whisper-rate token bucket (see {@link ShardDO.WHISPER_RATE_BURST}). In-memory; resets on hibernation. */
    private readonly whisperBuckets = new WeakMap<ShardSocketLike, { last: number; tokens: number }>();

    /**
     * Per-socket {@link AbortController} map keyed by stream id, used to
     * propagate a client unsubscribe (or a socket close) into the user
     * handler. In-memory only: a hibernation drops the controllers, which is
     * fine because the corresponding socket is gone too — the iterator
     * pumping into it would have nowhere to write.
     */
    private readonly streamCancellers = new WeakMap<ShardSocketLike, Map<string, AbortController>>();

    /**
     * Live producers for durable streams, keyed by run key. In-memory on
     * purpose: it tracks who is *currently* producing, while the transcript
     * itself lives in SQLite. A run whose entry is missing but whose row still
     * says `running` was interrupted by an eviction — see
     * {@link ShardDO.attachDurableStream}.
     */

    /**
     * Durable-stream runs for this shard. The engine owns the state machine and
     * the producer; this class only adapts sockets onto it.
     */
    private readonly durableStreams = new DurableStreamRunner({ sql: () => this.sql as SqlExec, waitUntil: (promise) => this.shardHost.waitUntil?.(promise) });

    /**
     * Lifetime request counters surfaced by the `__lunora_admin__:getMetrics`
     * RPC. In-memory only — they reset when the DO hibernates or restarts, which
     * is the right granularity for a "since this instance woke" health readout
     * (durable aggregation would be a separate, heavier feature).
     *
     * `subscriptionRefreshErrors` (DO-01) rides along the same lifetime/in-memory
     * shape: incremented, alongside a structured log, wherever a live-query
     * refresh or shape poke swallows a per-subscription/per-socket error so its
     * siblings can keep flushing (`refreshSubscriptions`, `pokeShapeSubscribers`
     * via `recordSubscriptionRefreshError`). It IS on the `getMetrics` wire
     * response (`collectMetrics`); a studio panel charting it is a follow-up.
     */
    private readonly metrics = { errors: 0, requests: 0, sinceMs: Date.now(), subscriptionRefreshErrors: 0 };

    /**
     * Running fan-out cost counters surfaced by the
     * `__lunora_admin__:getFanoutMetrics` RPC — one tally for the reactive
     * shape-poke path (`pokeShapeSubscribers`) and one for the whisper broadcast
     * path (`broadcastWhisper`). Each pass records the sockets it iterated (the
     * O(subscribers) cost) and delivered to. In-memory and reset on
     * hibernation/restart, sharing `metrics.sinceMs` as the "since this instance
     * woke" epoch. This is the observability half of plan 075's auto-elastic
     * relay tier (Phase 1): measure the per-flush fan-out cost so the promotion
     * threshold is grounded in real numbers, with no behavior change.
     */
    private readonly fanout = { shapePoke: createFanoutCounters(), whisper: createFanoutCounters() };

    /**
     * The `.global()` changelog position the last poll tick observed, or
     * `undefined` on a cold instance. In-memory on purpose: losing it costs one
     * full re-read pass, which is the safe direction — a stale persisted cursor
     * would let a tick skip a table that HAD changed.
     */
    private globalPollCursor: number | undefined;

    /**
     * Set when a shape failed to settle in the last poll tick, forcing the next one
     * to read every shape unconditionally. See {@link GlobalPollTick.resyncRequested}
     * for why a shared cursor leaves no cheaper recovery.
     */
    private globalResyncRequested = false;

    /**
     * Whether this wake has already re-minted the epoch to seal a rolled-back
     * timeline. In-memory on purpose — see {@link ShardDO.sealForkedTimeline} for
     * why the seal is capped at one per wake, and why losing the flag on eviction
     * is the correct direction.
     */
    private forkSealed = false;

    /**
     * Wall-clock millis of the last unconditional `.global()` membership pass.
     * Bounds how long a write this deployment cannot see in its own changelog —
     * an out-of-band writer against the global database — can go unnoticed.
     */
    private lastGlobalResyncAt = 0;

    /**
     * The runtime's Durable Object namespace binding name (e.g. `"SHARD"`),
     * learned from `x-lunora-shard-binding` so a DO can address its siblings
     * (`this.env[binding].getByName(...)`) for the relay hub. Absent in single-DO
     * mode / the unit harness — when absent, the relay tier is inert and whispers
     * stay shard-local (no behavior change).
     *
     * NOT sent on every inbound request: the worker stamps it on the WebSocket
     * upgrade and on a replica-routed RPC, and a sibling DO stamps it on the
     * relay/replica POSTs — the owner `/rpc` path does not. So this field is
     * "whatever the last request that carried one said", which is why it is kept
     * across requests rather than re-read per request, and why `OwnerRelay`
     * persists the learned value in SQLite instead of trusting it to be live.
     */
    private shardBinding: string | undefined;

    /**
     * Memoised {@link ShardDO.currentAdminBinding} result, keyed by the token it
     * was derived from so a rotation within one isolate re-derives rather than
     * serving the old fingerprint.
     */
    private adminBindingMemo: { binding: Promise<string>; token: string } | undefined;

    /**
     * The auto-elastic fan-out relay collaborator (plan 075) — an {@link OwnerRelay}
     * or {@link RelayMember} chosen ONCE from this DO's name, or `undefined` for an
     * unnamed (single-DO) DO where the relay tier is inert. All relay state +
     * transport lives on it, reached back through the {@link RelayHost} adapter, so
     * owner-only state can never sit next to relay-only state on this class.
     */
    private readonly relay: OwnerRelay | RelayMember | undefined;

    /**
     * The read-replica collaborator — set only on a DO whose name marks it as a
     * replica of another shard, `undefined` on an owner (and on an unnamed
     * single-DO shard, where there is nothing to replicate from).
     */
    private readonly replica: ReturnType<typeof createReplicaLink>;

    /**
     * The owner half of the replica seam — what answers `/_lunora/replica` for
     * the replicas following this shard. Present on every DO, because a DO
     * cannot know whether anything follows it until something asks.
     */
    private readonly replicaOwnerHost: ReplicaOwnerHost;

    /**
     * Declared indexes (`table:index`) a query has exercised since this instance
     * woke, stamped by `getCtxDbIndexUseHook`. In-memory and reset on
     * hibernation/restart — drives the `unused_index` runtime advisory.
     */
    private readonly usedIndexes = new Set<string>();

    /**
     * Per-function execution counters surfaced by the
     * `__lunora_admin__:getFunctionStats` RPC, keyed by `<file>:<function>`
     * path. Shares the `metrics` lifecycle: in-memory, reset on
     * hibernation/restart. `functionPath` is caller-controlled (the runtime
     * forwards it unchecked), so the map is NOT bounded by the app's registered
     * function count — every path that reaches a metrics-recording dispatch
     * lands here, including one that resolves to nothing. `recordFunctionCall`
     * therefore caps it at {@link FUNCTION_METRICS_MAX_PATHS} the same way the
     * durable `__lunora_metrics` twin caps its table. Maintained by
     * `recordFunctionCall` at the one dispatch site that also bumps the
     * aggregate `metrics` counters.
     */
    private readonly functionStats = new Map<string, FunctionCallStat>();

    /**
     * Recent RPC errors on this shard instance, surfaced by the
     * `__lunora_admin__:getLogs` RPC. In-memory only and bounded — like
     * `metrics`, it resets on hibernation/restart. We only capture RPC
     * dispatch failures here (path + error message), not user `console.*` output:
     * intercepting the console cheaply isn't possible, so this is honestly a
     * "recent RPC errors on this instance" feed, not a general application log.
     */
    private readonly logs = new LogBuffer();

    /**
     * Recent `ctx.trace` spans (plus the synthetic per-dispatch root), powering
     * the studio's Traces panel. In-memory and hibernation-volatile like
     * `logs` — production tracing ships to a collector via `otlpSink`.
     */
    private readonly spans = new SpanBuffer();

    /**
     * Running aggregates of `ctx.metrics.*` measurements, powering the studio's
     * Metrics panel. In-memory and hibernation-volatile like `logs` and
     * `spans`, but folds samples into per-series totals rather than ringing
     * raw events — production aggregation ships to a collector via the sink.
     */
    private readonly metricSeries = new MetricBuffer();

    /**
     * Tables the in-flight dispatch full-scanned (read via `SCAN_DEP`, no index
     * / point lookup). Allocated at the top of each `/rpc` dispatch and drained
     * into `recordFunctionCall` once the handler returns, so the durable
     * `__lunora_metrics_scans` attribution can pin a slow function to the
     * table(s) it scanned. Independent of the per-dispatch
     * {@link QueryReadScope} (which only exists when the reactive cache is
     * enabled), so the causal signal is collected even on a cache-less shard.
     * Stamped by `getCtxDbReadHook`.
     */
    private currentScannedTables: Set<string> | undefined;

    /**
     * Declared indexes the in-flight dispatch exercised (used to narrow a read,
     * via `onIndexUse`), keyed by `JSON.stringify([table, index])`. Allocated at the top of each
     * `/rpc` dispatch and drained into `recordFunctionCall` once the handler
     * returns, so the durable `__lunora_metrics_index` hit counter — the producer
     * behind the advisor dead-index lint — records on the same dispatch path as
     * the scan attribution. Stamped by `getCtxDbIndexUseHook`.
     */
    private currentIndexHits: Set<string> | undefined;

    /**
     * Per-DISTINCT-statement SQL samples collected during the current `/rpc`
     * dispatch by the instrumented `sql` getter, keyed by the raw query text.
     * Drained into the durable `__lunora_metrics_queries` table after the
     * handler returns (same pattern as `currentScannedTables` /
     * `currentIndexHits`). `undefined` when no dispatch is in flight; allocated
     * fresh per dispatch so a previous request's samples never leak into the
     * next one.
     *
     * Keyed by the raw query string rather than a growing array: a handler
     * that queries in a loop reuses the SAME prepared-statement text on every
     * iteration (bind parameters travel separately via `...params`, never
     * inlined into `query`), so folding each call into its entry as it lands
     * collapses the loop to one entry — {@link ShardDO.flushStmtSamples} then
     * pays one upsert per DISTINCT statement instead of one per raw execution.
     * Bounded at {@link MAX_STMT_SAMPLES_PER_DISPATCH} distinct entries; past
     * that, a brand-new statement shape (ad-hoc SQL built per iteration) is
     * dropped and `currentStmtSamplesTruncated` is set — already-tracked
     * statements keep folding regardless.
     *
     * `rowsWritten` is always 0 here — the ctx-db adapter doesn't expose a
     * `changes()` count through the structural `SqlExec` surface, so we
     * attribute only SELECT result sizes as `rowsRead`.
     */
    private currentStmtSamples: Map<string, StmtSample> | undefined;

    /**
     * The instrumented `sql` proxy built for {@link ShardDO.currentStmtSamples},
     * and the samples map it was built for.
     *
     * `get sql()` is read on essentially every storage call, and a fresh `Proxy`
     * per read is not only an allocation: the resume path memoizes this shard's
     * table catalog in a `WeakMap` keyed by the handle, so a new object each read
     * meant that memo never once hit during a dispatch — it re-scanned
     * `sqlite_master` every time, which is the 18% of `evaluateResume` the memo
     * exists to remove.
     */
    private instrumentedSql: undefined | { proxy: unknown; samples: Map<string, StmtSample> };

    /**
     * Set when `currentStmtSamples` hit {@link MAX_STMT_SAMPLES_PER_DISPATCH}
     * distinct statements and a brand-new shape was dropped this dispatch.
     * Folded onto the dispatch's wide event as `db.stmt_samples_truncated`
     * (mirrors `database-telemetry.ts`'s `db.spans_truncated`) so a truncated
     * leaderboard contribution reads as partial rather than complete.
     */
    private currentStmtSamplesTruncated: boolean | undefined;

    public constructor(state: ShardDOState, env: unknown, options: ShardDOOptions = {}) {
        this.state = state;
        this.env = env;

        // Build the provider-neutral Cloudflare host adapters and mount the
        // host-neutral shard engine runner. The runner owns the platform contract
        // seam; `fetch`/`alarm` delegate through it. First slice: the runner
        // forwards back to the existing Cloudflare-specific implementations so
        // tests and public API stay stable.
        this.shardHost = createShardHost(state as never);
        this.socketHost = createSocketHost(state as never);
        this.runner = new ShardRunner(this.shardHost, this.socketHost, {
            handlers: {
                handleAlarm: () => this.handleAlarmCloudflare(),
                handleFetch: (request) => this.handleFetchCloudflare(request),
            },
        });

        if (options.reactiveCache) {
            this.reactiveCache = new ReactiveCache(options.reactiveCache);
        }

        this.ctxDbCacheWired = options.ctxDbCacheWired ?? false;
        this.ctxDbRelationOptions = {
            ...(options.maxRelationKeys === undefined ? {} : { maxRelationKeys: options.maxRelationKeys }),
            ...(options.relationExistsPushDown === undefined ? {} : { relationExistsPushDown: options.relationExistsPushDown }),
        };

        // What every internal tier needs from this DO: its own name (the role
        // signal), the env, the namespace binding, and SQLite. Built once and
        // spread into each tier's host so the four can never drift apart.
        const sibling: ShardSiblingHost = {
            doName: () => this.runner.shardKey,
            env: () => this.env,
            shardBinding: () => this.shardBinding,
            sql: () => this.sql as SqlExec,
        };

        // The relay tier reaches this DO back through a narrow adapter; the role-typed
        // collaborator (owner vs relay) is fixed once from the DO name (plan 075).
        const host: RelayHost = {
            ...sibling,
            buildShapeDiff: (resolved, fromCursor, toCursor) => this.diffRelayedShape(resolved, fromCursor, toCursor),
            computeOpLogShapeSeed: (shape, resolved) => this.computeOpLogShapeSeed(shape, resolved),
            currentCdcEpoch: () => this.currentCdcEpoch(),
            deliverWhisperLocal: (topic, frame, exclude) => this.deliverWhisperLocal(topic, frame, exclude),
            getWebSockets: () => this.runner.sockets(),
            maskMetadata: () => this.maskMetadata(),
            nextPokeId: () => {
                this.pokeSequence += 1;

                return `poke-${String(this.pokeSequence)}`;
            },
            readAttachment: (ws) => this.readAttachment(ws),
            recordShapePokeFanout: (iterated, delivered, elapsedMs) => {
                this.fanout.shapePoke = recordFanoutPass(this.fanout.shapePoke, iterated, delivered, elapsedMs);
            },
            resolveShape: (name, args, identity) => this.resolveShape(name, args, identity),
            rlsMetadata: () => this.rlsMetadata(),
        };

        this.relay = createRelayLink(host);

        // Region-local read replicas. Same rule as the relay tier: the role is
        // fixed once from the DO name. The owner half is what SERVES
        // `/_lunora/replica`; `this.replica` is set only on a DO that follows one.
        //
        // The three CDC readers pass `undefined` straight through — it means
        // "this shard has no changelog", and the replica tier refuses to
        // replicate a shard that cannot be followed rather than inventing a
        // timeline out of a sentinel.
        this.replicaOwnerHost = {
            ...sibling,
            exportRows: async () => this.runShardExport({}),
            ownerCursor: () => this.currentCdcCursor(),
            ownerEpoch: () => this.currentCdcEpoch(),
            // The PAYLOAD floor, not the key floor. A replica replays post-images,
            // and payload compaction keeps keys while dropping documents — so
            // `minCdcSeq` would advertise a position from which replay is
            // impossible, and the follower would sit below the real floor forever
            // without ever being told to bootstrap.
            ownerFloor: () => (this.cdcEnabled() ? minCdcReplayableSeq(this.sql as SqlExec) : undefined),
            readChanges: (sinceSeq, limit) => this.runShardCdcSync({ limit, sinceSeq }),
            // `COUNT(*)` per user table — cheap next to building the snapshot,
            // which is the whole point: the bootstrap cap has to be decided
            // before the rows are materialized, not after.
            rowCount: () => listTables(this.sql as SqlExec).reduce((total, table) => total + table.rowCount, 0),
        };
        this.replica = createReplicaLink({
            ...sibling,
            applyChanges: async (changes) => {
                const { applied } = await this.runShardApplyCdc({ changes });

                // Same post-replay step the `applyCdc` admin RPC takes: replayed
                // rows are real writes, so any live subscriber on this DO has to
                // see them.
                await this.flushChangedTables();

                return applied;
            },
            importRows: async (rows) => this.runShardImport({ rows }),
        });

        this.armWebSocketKeepalive();
    }

    /**
     * Worker-side fetch entry point. Delegates to the host-neutral
     * {@link ShardRunner}, which forwards to the Cloudflare implementation below.
     */
    public async fetch(request: Request): Promise<Response> {
        await this.ensureShardInit();

        return this.runner.handleFetch(request);
    }

    /**
     * Hibernation API: invoked by the runtime when a message arrives on a
     * hibernated socket. Subclasses can override this to intercept; the
     * default decodes a {@link SubscriptionEnvelope} and updates the registry.
     *
     * Deliberately NOT wrapped in {@link withTriggerTrace}, unlike `alarm`. Frame
     * rate here is unbounded — a whisper fan-out or presence stream drives many
     * per second — and minting a trace anchor per frame costs two `crypto`
     * draws plus hex encoding, which measurably regressed the fan-out benchmark
     * (~30% on `broadcastWhisper` to 128 members). The trade is also worse than it
     * looks: a frame's work is a subscription re-evaluation whose data flow is
     * already attributable to the RPC that wrote the data, so the root span buys
     * little. An alarm is the opposite — low frequency, and genuinely
     * un-attributable background work — which is why that one keeps the wrapper.
     *
     * `ctx.trace`/`ctx.span` inside a frame still record; they just anchor to the
     * ctx's own trace rather than a per-frame root.
     */
    public async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        await this.ensureShardInit();

        // Map the runtime socket to the handle enumeration also yields, so
        // per-socket memo state is keyed identically on both paths. Falls back to
        // the raw socket only when the host cannot map it — in which case
        // enumeration cannot see it either, so the two stay consistent.
        return this.handleWebSocketMessage(this.runner.socketFor(ws), message);
    }

    /**
     * Hibernation API: invoked on socket close. The runtime has already
     * closed the socket by the time we're called — calling `ws.close()`
     * again would throw "WebSocket has been closed" in the Workers runtime.
     */
    public async webSocketClose(rawSocket: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
        await this.ensureShardInit();

        // Same boundary conversion as `webSocketMessage`: per-socket state is keyed
        // on the handle, so the close path must resolve the same identity or it
        // would tear down nothing.
        const ws = this.runner.socketFor(rawSocket);

        // Fire `onDisconnect` lifecycle hooks the instant the socket drops —
        // replaying the identity + context recorded at connect — so presence and
        // other cleanup happen immediately, not after a TTL. Only a socket that
        // recorded a `connectionId` (went through the lifecycle-aware upgrade)
        // dispatches; the hooks run under the connecting user's identity.
        const attachment = this.readAttachment(ws);

        // The hooks deliberately run before any teardown so they observe
        // pre-cleanup state; the `finally` guarantees the deterministic
        // teardown below still runs when the dispatch machinery itself throws
        // (e.g. a malformed attachment in `lifecycleInfo`). The failure is held
        // rather than left in flight so a teardown step can't displace it, and
        // rethrown once cleanup is done.
        //
        // The two relay posts below are NOT held that way: they are logged and
        // swallowed. They are fire-and-forget control frames by contract
        // (`RelayHub.releaseRelayShapes` / `announceDrain`), so a dropped one
        // leaves the registration to the coarser detach/full-drain reclamation
        // — while a throw out of `webSocketClose` is a Durable Object close
        // handler failing, which the runtime can only answer by breaking the
        // actor, taking every OTHER live socket on this shard down with it.
        // Trading a transient cross-DO post failure for that is a bad deal, and
        // there is nobody to hand the rejection to anyway: the socket is
        // already gone and nothing retries a close. The `webSocketMessage`
        // sibling that releases a single shape reasons identically. A lifecycle
        // hook throwing is a different class — that is the app's own code
        // failing, and it still propagates.
        let dispatchError: { error: unknown } | undefined;

        try {
            if (attachment.connectionId !== undefined) {
                await this.dispatchLifecycle("disconnect", this.lifecycleInfo(attachment));
            }
        } catch (error) {
            dispatchError = { error };
        } finally {
            // Abort in-flight stream iterators bound to this socket so user
            // handlers stop pumping into a closed channel rather than discovering
            // it on the next yield.
            const cancellers = this.streamCancellers.get(ws);

            if (cancellers) {
                for (const controller of cancellers.values()) {
                    controller.abort();
                }

                this.streamCancellers.delete(ws);
            }

            // Drop the per-socket subscription memo too — leaving it would pin
            // the socket in the WeakMap until GC and (more importantly) keep the
            // stale memo set around if the same socket id is reused after a
            // bounce. Cheap to recompute on the next subscribe.
            this.subMemos.delete(ws);
            this.shapeMemos.delete(ws);
            this.globalShapeSnapshots.delete(ws);

            this.purgeDurableSocketBaselines(attachment.connectionId);

            // Release this socket's owner-side relayed-shape registrations
            // BEFORE the attachment is cleared — the relay reads `connectionId`
            // off it to address the release. Per-socket, so it covers the far
            // more common case than the detach below: a relay that keeps other
            // sockets never detaches, and each of its retired connections would
            // otherwise leave a permanent row pinning op-log retention.
            try {
                await this.relay?.releaseRelayShapes(ws);
            } catch (error) {
                // eslint-disable-next-line no-console -- server-side diagnostic for a dropped relay-shape release; a close handler must not reject (see above)
                console.error("[@lunora/do] relay shape release failed during socket close:", error);
            }

            // Clear the attachment so a future reconnection starts clean.
            (ws as HibernatableWebSocket).serializeAttachment?.(undefined);

            // Relay tier collapse (plan 075 Phase 2): a relay that just lost its last
            // socket detaches from its owner, so the owner stops forwarding to it.
            // The detach is a network post, so it can reject — logged like the
            // release above rather than escaping the `finally`, where it would
            // both break the actor and displace a dispatch failure the caller
            // still has to see.
            try {
                await this.relay?.announceDrain(ws);
            } catch (error) {
                // eslint-disable-next-line no-console -- server-side diagnostic for a dropped relay detach; a close handler must not reject (see above)
                console.error("[@lunora/do] relay drain failed during socket close:", error);
            }
        }

        // Rethrown outside the `finally` so no teardown step can displace it.
        if (dispatchError !== undefined) {
            throw dispatchError.error;
        }
    }

    /**
     * Hibernation API: invoked on socket error — and, for an error-terminated
     * socket, invoked INSTEAD OF {@link ShardDO.webSocketClose}, not before it.
     *
     * workerd's hibernation manager dispatches exactly one termination event per
     * socket (`legacy-hibernation-manager.c++`, `handleSocketTermination`): a
     * premature `DISCONNECTED` becomes a synthetic 1006 close event, and EVERY
     * other exception — a protocol error, an event timeout, a `webSocketMessage`
     * handler that threw — becomes an error event with no close to follow. So
     * the teardown `webSocketClose` owns (the `onDisconnect` dispatch, the
     * per-socket memos, and the durable `__shape_poke_cursor` /
     * `__lunora_global_shape_snapshot` rows keyed by a `connectionId` that can
     * never reconnect) has to run from here too. One orphaned poke-cursor row
     * pins `minShapePokeCursor` — a `SELECT MIN(cursor)` over the whole table —
     * and with it the CDC log's retention floor, permanently.
     *
     * Delegating is safe to run twice: `webSocketClose` clears the attachment,
     * so a second pass finds no `connectionId` and does nothing.
     *
     * The error handler must not throw (the runtime is already tearing the
     * socket down and there is nothing left to retry), so a teardown failure is
     * logged rather than propagated. Subclasses overriding this for logging must
     * call `super.webSocketError(...)` or the rows above leak.
     */
    public async webSocketError(rawSocket: WebSocket, error: unknown): Promise<void> {
        try {
            // 1006 / `wasClean: false` — the same shape workerd synthesizes for
            // the disconnect half of this branch.
            await this.webSocketClose(rawSocket, 1006, "websocket error", false);
        } catch (teardownError) {
            // eslint-disable-next-line no-console -- server-side diagnostic: the socket is already gone, so there is nothing to propagate a teardown failure to
            console.error("[@lunora/do] socket error teardown failed:", teardownError, "(original socket error:", error, ")");
        }
    }

    /**
     * Durable Object alarm handler — the heartbeat for `.global()`-table shapes
     * AND external-source (`.source(...)`) ingest, which share one alarm. The
     * runtime wakes this when the poll alarm armed by `scheduleGlobalPoll` fires;
     * it refreshes every subscribed global shape (diff-poke from the global
     * backend), materializes any due sourced tables, and re-arms at
     * {@link ShardDO.nextPollAlarmTarget} — the fixed floor while global shapes
     * are subscribed, or the earliest source next-due time when only ingest
     * remains (so a 1-hour-`refresh` source sleeps ~1 hour instead of waking
     * every 2 s). With neither tier pending, the alarm is not re-armed and the DO
     * goes idle. A base-only / global-free / source-free DO never arms it, so
     * this stays dormant there.
     */
    public async alarm(): Promise<void> {
        await this.ensureShardInit();

        return this.withTriggerTrace("alarm", async () => this.runner.handleAlarm());
    }

    /**
     * Subclasses implement function dispatch.
     *
     * `headroom` is an optional BY-VALUE override, mirroring
     * {@link ShardDO.runShardWrite}'s pattern: the main `/rpc` dispatch
     * (`handleFetchCloudflare`) captures its freshly-minted tracker in a LOCAL and
     * passes it here explicitly, so the ctx this dispatch builds is metered
     * against ITS OWN tracker however the (possibly `await`-interleaved) handler
     * interleaves with a concurrent one. Callers that dispatch
     * through here without minting their own tracker (`dispatchLifecycle`,
     * `handleRunAs`) omit it and the codegen subclass falls back to
     * `this.transactionHeadroom()`, which mints a FRESH per-ctx budget — never
     * the in-flight dispatch's.
     *
     * `scope` is the same shape of BY-VALUE thread for the reactive cache: the
     * `/rpc` query path routes through {@link ShardDO.runCachedQuery}, which
     * mints a {@link QueryReadScope} per dispatch and passes it here so the ctx
     * this dispatch builds stamps reads into ITS OWN tracker and footprint.
     * Implementations must hand it to `getCtxDbReadHook(scope)` /
     * `getCtxDbReadRangeHook(scope)` on the `createShardCtxDb(...)` call that
     * builds the ctx; both factories return unbound (tracker-less) hooks when it
     * is omitted, which is what every non-cached dispatch passes.
     */
    public abstract handleRpc(
        functionPath: string,
        args: Record<string, unknown>,
        headroom?: TransactionHeadroomTracker,
        scope?: QueryReadScope,
    ): Promise<unknown>;

    /**
     * The registered function paths to dispatch on a lifecycle moment —
     * `connect`/`disconnect` per socket, `init` once per Durable Object instance,
     * `reactor` after each write flush.
     * Base default is empty; the codegen subclass overrides it to return the
     * generated lifecycle manifest keyed by `event`. Kept as a data hook (like
     * `tableRefs`/`rlsMetadata`) so the security-load-bearing dispatch — running
     * each hook under the verified identity + system dispatch — stays here in the
     * base and can't be mis-wired by generated code.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass returns the generated lifecycle manifest
    protected lifecycleHookPaths(_event: "connect" | "disconnect" | "init" | "reactor"): ReadonlyArray<string> {
        return [];
    }

    /**
     * Run every registered `connect`/`disconnect` hook for a socket, each under
     * the connecting user's verified identity and a trusted system dispatch (so
     * the internal hooks are permitted). A hook that throws is swallowed (logged)
     * — a disconnect must never fail the hibernation close path, and one hook's
     * failure must not skip the rest. Hooks run sequentially so they share the
     * DO's single-threaded write snapshot deterministically.
     */
    protected async dispatchLifecycle(event: "connect" | "disconnect", info: LifecycleDispatchInfo): Promise<void> {
        for (const functionPath of this.lifecycleHookPaths(event)) {
            try {
                // The event is passed as the handler's `args`; the lifecycle
                // wrapper forwards it verbatim. `handleRpc` builds the ctx and
                // enforces the internal-visibility gate, which the system flag
                // satisfies.
                // eslint-disable-next-line no-await-in-loop -- sequential by design: hooks share the DO's single-threaded write snapshot deterministically, and a throwing hook must not skip the rest
                await this.withRequestIdentity(info.userId, info.identity, () =>
                    this.withSystemDispatch(() => this.handleRpc(functionPath, info.event as unknown as Record<string, unknown>)),
                );
            } catch (error: unknown) {
                this.logs.push({
                    functionPath,
                    level: "error",
                    message: error instanceof Error ? error.message : String(error),
                    timestamp: Date.now(),
                });
            }
        }
    }

    /**
     * Re-evaluate every registered `onQueryChange` reactor after a write flush,
     * and run the ones whose watched read actually changed.
     *
     * The cheap gate first: a reactor whose stored footprint is disjoint from
     * `changed` cannot have had its result altered by this flush, so its `select`
     * is not even re-run. An unknown footprint (never run, or an unparseable row)
     * counts as "touches everything" — the same degradation direction the rest of
     * the reactive layer takes, where a redundant run is acceptable and a missed
     * one is not.
     *
     * Then the real test, which is what separates a reactor from a trigger: the
     * dispatch re-runs `select`, digests the result, and invokes the app's handler
     * ONLY when that digest differs from the stored baseline. A write that touched
     * a watched table but did not change what the read returns costs one query and
     * stops there.
     *
     * `runs` is the drain-scoped convergence bound. A reactor's handler writes;
     * those writes flush; that flush re-enters this method. That cascade is the
     * feature — it is how an actor advances a state machine a step at a time — and
     * a reactor whose handler always changes its own read never settles. Rather
     * than trust every app to converge, a reactor that exceeds
     * {@link ShardDO.MAX_REACTOR_RUNS_PER_DRAIN} within one drain is dropped for
     * the rest of that drain and the failure is logged. The shard stays
     * responsive and the broken reactor is named.
     *
     * A throwing reactor is contained per reactor, like every other background
     * dispatch here: its baseline is left untouched, so it is retried on the next
     * flush rather than being silently skipped forever.
     */
    protected async dispatchReactors(changed: Set<string>, runs: Map<string, number>): Promise<void> {
        const paths = this.lifecycleHookPaths("reactor");

        if (paths.length === 0) {
            return;
        }

        const sqlHandle = this.sql as SqlExec;

        for (const path of paths) {
            // Reading the baseline is itself a SQL call, and the storage failure
            // that breaks a reactor breaks this too. Unguarded it would abort the
            // whole drain — stranding every table merged into the pending set and
            // every live subscriber waiting on it — for one reactor's bad read.
            // An unreadable baseline degrades to `undefined`, which
            // `reactorNeedsRun` treats as "must run": the same direction every
            // other unknown in this feature takes.
            let state: ReactorState | undefined;

            try {
                state = readReactorState(sqlHandle, path);
            } catch (error: unknown) {
                this.recordReactorError(path, error);
            }

            if (!reactorNeedsRun(state, changed)) {
                continue;
            }

            if (!this.claimReactorBudget(path, runs)) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- reactors run sequentially by design: each observes the writes the previous one committed, and one throwing reactor must not skip the rest
            await this.dispatchOneReactor(sqlHandle, path, state?.digest);
        }
    }

    /**
     * Run one reactor dispatch and report what it saw.
     *
     * A no-op seam here; the generated subclass overrides it, because running a
     * reactor needs two things the base cannot build — a ctx (for `select` and the
     * handler) and a read footprint around it. Mirrors `runSubscription`, which
     * has the identical shape for the socket-terminated side of reactivity.
     * @returns the run's digest and read footprint, or `undefined` when the path
     * resolves to nothing (a manifest naming a function this build does not have).
     */
    // eslint-disable-next-line class-methods-use-this -- a seam: the base cannot build a ctx, the generated subclass overrides
    protected async runReactor(_path: string, _previousDigest?: string): Promise<ReactorRunOutcome | undefined> {
        await Promise.resolve();

        return undefined;
    }

    /**
     * Record a contained reactor failure into the log ring. Mirrors
     * {@link ShardDO.recordExternalSourceError}: the dispatch loop needs to write
     * this line and the log ring is private.
     */
    protected recordReactorError(path: string, error: unknown, trace?: TraceRefLike): void {
        this.recordShapeError(`reactor:${path}`, error, trace);
    }

    /**
     * Run every registered `onShardInit` hook, once, on a freshly-constructed
     * instance. Called by the generated {@link ShardDO.runShardInit} override
     * AFTER it has cleared the schema's `.memory()` tables — that order is the
     * contract: a hook exists to refill what the clear emptied.
     *
     * Dispatched with NO request identity, under the system flag (which satisfies
     * the internal-visibility gate). There is genuinely no caller here — the
     * instance was constructed because the runtime needed it, not because a user
     * asked — so `ctx.auth` is anonymous and RLS does not apply, exactly as for a
     * cron tick. `withRequestIdentity` is deliberately NOT used: inheriting
     * whatever identity happens to be on the instance would run a rebuild as an
     * arbitrary user.
     *
     * Sequential, and a throw is contained per hook: one hook that cannot rebuild
     * its slice must not skip the others, and none of them may fail the dispatch
     * that woke the shard (see {@link ShardDO.ensureShardInit}).
     */
    protected async dispatchShardInit(): Promise<void> {
        const event = { shardKey: this.currentShardKey() };

        for (const functionPath of this.lifecycleHookPaths("init")) {
            try {
                // eslint-disable-next-line no-await-in-loop -- sequential by design: a later hook may depend on state an earlier one rebuilt, and a throwing hook must not skip the rest
                await this.withSystemDispatch(() => this.handleRpc(functionPath, event));
            } catch (error: unknown) {
                this.recordShardInitError(functionPath, error);
            }
        }
    }

    /**
     * Serve a reserved {@link RELATION_FUNCTION_PREFIX} fan-out read/count for
     * reverse cross-backend relations (a `.global()` parent loading a
     * shard-local child that spans every shard). Returns a BARE value — the
     * child-row array for `__lunora_relation__:read`, a number for
     * `__lunora_relation__:count` — so the coordinator's `concat`/`sum` merge
     * composes the per-shard results. Runs under the forwarded caller identity
     * (the `x-lunora-userid` / `x-lunora-identity` headers stashed for the
     * request), never the admin token.
     *
     * The base class is schema-agnostic, so it cannot build the ctx-db needed to
     * read the child table; the codegen subclass overrides this with a
     * schema-aware implementation. Reaching the base default means the prefix was
     * dispatched against a ShardDO with no generated schema bound.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with a schema-aware reader that uses `this`
    protected runRelationFanoutRead(_functionPath: string, _args: Record<string, unknown>): Promise<unknown> {
        throw new LunoraError("NOT_IMPLEMENTED", "__lunora_relation__: no schema bound — the base ShardDO cannot serve cross-shard relation reads", {
            status: 500,
        });
    }

    /**
     * Instrumented SQL handle. Wraps `state.storage.sql` so that every `exec`
     * call during a user RPC dispatch is timed and its result size folded into
     * `currentStmtSamples`. The samples are flushed to the durable
     * `__lunora_metrics_queries` table after the handler returns (same lifecycle
     * as `currentScannedTables`/`currentIndexHits`).
     *
     * The wrapper is only active when `currentStmtSamples` is defined (i.e.
     * during a live user RPC dispatch). Admin ops, subscription re-runs, and
     * any other path that doesn't allocate `currentStmtSamples` pass through to
     * the raw handle unchanged — recording there would skew leaderboard totals
     * with internal housekeeping queries.
     *
     * IMPORTANT: the instrumented wrapper must NOT call any SQL itself (e.g. to
     * flush metrics) — it is invoked synchronously inside an `exec` call and
     * the SQLite connection is not re-entrant in workerd. Samples are flushed
     * after the handler fully resolves.
     */
    protected get sql(): unknown {
        const rawSql = this.shardHost.sql;
        const samples = this.currentStmtSamples;

        // Only instrument during a live user dispatch.
        if (samples === undefined) {
            return rawSql;
        }

        if (this.instrumentedSql?.samples === samples) {
            return this.instrumentedSql.proxy;
        }

        const rawExec = (rawSql as { exec?: unknown }).exec;

        if (typeof rawExec !== "function") {
            return rawSql;
        }

        // Fold one execution's timing/result-size into its statement's running
        // entry (keyed by the raw query text — see `currentStmtSamples`), rather
        // than appending a new array entry per execution. A handler that queries
        // in a loop reuses the same prepared-statement text every iteration, so
        // this collapses the loop to one entry that `flushStmtSamples` drains
        // with a single upsert. Bounded at `MAX_STMT_SAMPLES_PER_DISPATCH`
        // DISTINCT entries; a brand-new statement shape past that cap is
        // dropped and `currentStmtSamplesTruncated` is set — already-tracked
        // statements keep folding regardless of the cap.
        const foldSample = (query: string, durationMs: number, rowsRead: number, rowsWritten: number): void => {
            const existing = samples.get(query);

            if (existing !== undefined) {
                existing.count += 1;
                existing.totalDurationMs += durationMs;
                existing.rowsRead += rowsRead;
                existing.rowsWritten += rowsWritten;

                return;
            }

            if (samples.size >= MAX_STMT_SAMPLES_PER_DISPATCH) {
                this.currentStmtSamplesTruncated = true;

                return;
            }

            samples.set(query, { count: 1, rowsRead, rowsWritten, totalDurationMs: durationMs });
        };

        const instrumentedExec = (query: string, ...params: unknown[]): unknown => {
            const start = Date.now();
            const cursor = (rawExec as (...args: unknown[]) => unknown).call(rawSql, query, ...params);
            // We wrap `.toArray()` and `.one()` on the cursor to capture result
            // sizes synchronously without buffering the rows ourselves.
            let wrapped = false;

            if (cursor !== null && typeof cursor === "object") {
                const c = cursor as Record<string, unknown>;

                const wrap = (name: "one" | "toArray", rowsOf: (value: unknown) => number): boolean => {
                    const method = c[name];

                    if (typeof method !== "function") {
                        return false;
                    }

                    const original = method.bind(c) as () => unknown;

                    c[name] = () => {
                        const value = original();

                        foldSample(query, Date.now() - start, rowsOf(value), 0);

                        return value;
                    };

                    return true;
                };

                const wrappedToArray = wrap("toArray", (rows) => (rows as unknown[]).length);
                const wrappedOne = wrap("one", () => 1);

                wrapped = wrappedToArray || wrappedOne;
            }

            // When neither `.toArray()` nor `.one()` will fold a sample — DDL /
            // DML the caller discards without iterating, or a defensive guard
            // against a non-object return — record a zero-rows sample immediately
            // so the statement still appears in the leaderboard. The wrapped
            // methods take priority when they are used: they fold their own
            // samples and this fallback never fires for the same execution.
            if (!wrapped) {
                foldSample(query, Date.now() - start, 0, 0);
            }

            return cursor;
        };

        // A structural proxy that looks like the real sql handle to the callers
        // that cast it to `SqlExec`, with our instrumented `exec`. Cached against
        // the samples map it folds into, so it is one object for the whole
        // dispatch and identity-keyed memos downstream keep working.
        const proxy = new Proxy(rawSql, {
            get(target, prop) {
                if (prop === "exec") {
                    return instrumentedExec;
                }

                // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Reflect.get returns any; this is the standard proxy passthrough pattern
                return Reflect.get(target, prop, target);
            },
        });

        this.instrumentedSql = { proxy, samples };

        return proxy;
    }

    /**
     * Drizzle handle scoped to this Durable Object's SQLite storage. Use this
     * for typed queries against generated `sqliteTable` schemas. The handle
     * participates in `runInTransaction` via drizzle's own `transaction`
     * helper — there is no need to call `db.transaction(...)` directly from
     * subclasses; wrap your work in `runInTransaction` and use `this.db`
     * inside the handler instead.
     */
    protected get db(): DrizzleSqliteDODatabase<Record<string, unknown>> {
        if (this.drizzleHandle) {
            return this.drizzleHandle;
        }

        // The drizzle DO driver introspects `storage.sql` only; the structural
        // projection here matches what tests already supply.
        this.drizzleHandle = drizzleDO(this.state.storage as unknown as DurableObjectStorage, { logger: false });

        return this.drizzleHandle;
    }

    /**
     * Run `handler` inside a SQLite transaction. Commits if it resolves;
     * rolls back if it throws. The `ConflictError` re-throw lets the
     * runtime translate optimistic-concurrency failures into a 409 response.
     *
     * Nested calls are refused with a `LunoraError`-shaped object — SQLite
     * in Durable Objects does not support nested transactions, so we fail
     * loudly rather than silently flattening them.
     *
     * Drizzle queries issued via `db` inside the handler participate
     * in this transaction implicitly — drizzle writes through the same
     * `state.storage.sql` handle the transaction below is opened on, and that
     * transaction is connection-scoped, so the boundary is shared without any
     * handle being threaded through. Do **not** call `this.db.transaction(...)`
     * from inside a handler; that would attempt a nested SQLite transaction.
     *
     * Why `state.storage.transaction(closure)` and not raw BEGIN/COMMIT SQL, and
     * not `this.db.transaction(handler)` either:
     *
     * 1. workerd FORBIDS raw `BEGIN`/`COMMIT`/`SAVEPOINT` inside a Durable Object
     * — it answers "please use the state.storage.transaction() … APIs
     * instead", so issuing them fails every transactional mutation. (An
     * earlier revision of this method did use raw SQL; do not go back.)
     *
     * 2. `transactionSync` is synchronous: it invokes the callback and does not
     * await its return value, so an async handler would let the transaction
     * commit before the handler resolves. Drizzle's `db.transaction()` has the
     * same shape and the same problem.
     *
     * The async `state.storage.transaction(closure)` is the platform primitive
     * that fits: atomic, rolled back automatically when the closure throws, and
     * isolated from concurrent dispatch.
     */

    /**
     * Is an atomic write boundary open on this instance right now?
     *
     * Exposed for the generated `ctx.db`, whose `_commitSeq` allocation is only
     * allowed to reuse one sequence across writes that commit together. A
     * mutation dispatch runs inside {@link ShardDO.runInTransaction}; an action
     * deliberately does not (its external I/O cannot be rolled back), so its
     * writes commit independently and each needs its own sequence.
     *
     * A live predicate rather than a flag threaded at ctx-construction time: the
     * boundary opens AFTER `buildCtx` has already run, and a flag would have to be
     * passed correctly at every one of the many `buildCtx` call sites — a
     * requirement that fails silently when missed.
     * @returns `true` while a storage transaction is open.
     */
    protected isInTransaction(): boolean {
        return this.transactionDepth > 0;
    }

    /**
     * Let `work` outlive this dispatch where the host supports it.
     *
     * The generated dispatches use this to flush `ctx.storage`'s deferred object
     * deletes once their writes have committed — cleanup that is already durable
     * on the row side and so must not hold up the response.
     *
     * Falls back to awaiting inline when the host has no `waitUntil`, so the work
     * still happens — dropping it there would make a leaked object look like
     * passing behaviour. On such a host the caller DOES wait for the work.
     * @param work already-started work; a rejection is the caller's to contain
     */
    protected async deferPastResponse(work: Promise<unknown>): Promise<void> {
        if (this.runner.background(work)) {
            return;
        }

        await work;
    }

    protected async runInTransaction<T>(handler: () => Promise<T> | T): Promise<T> {
        if (this.transactionDepth > 0) {
            throw new LunoraError("NESTED_TRANSACTION", "nested transactions are not supported in SQLite-in-DO", { status: 500 });
        }

        const sqlHandle = this.shardHost.sql as TransactionSqlLike | undefined;

        if (!sqlHandle || typeof sqlHandle.exec !== "function") {
            throw new LunoraError("SQL_UNAVAILABLE", "storage.sql is not available on this ShardDO state", { status: 500 });
        }

        // workerd FORBIDS raw `BEGIN`/`COMMIT`/`SAVEPOINT` SQL inside a Durable
        // Object ("please use the state.storage.transaction() ... APIs instead")
        // — issuing them throws and fails every transactional mutation. Both
        // guarantees the handler needs are contract primitives:
        // `ShardHost.runSerialized` is the single-writer gate and
        // `ShardHost.transaction` the atomic, auto-rolling-back boundary, and
        // `ShardRunner.runInTransaction` composes them in that order. The
        // `storage.sql` guard above still ensures the handler's SQL has a
        // connection.
        //
        // Only the depth bookkeeping stays here: it is `ShardDO` state, and the
        // nested-transaction error above reads it.
        return this.runner.runInTransaction(async () => {
            this.transactionDepth = 1;

            try {
                return await handler();
            } finally {
                this.transactionDepth = 0;
            }
        });
    }

    /**
     * Returns the D1 Sessions API bookmark forwarded by the client on this
     * request, or `undefined` when none was supplied. Handlers pass this
     * into `db.withSession(bookmark)` to opt into read-your-writes
     * consistency across replicas.
     */
    protected getInboundBookmark(): string | undefined {
        return this.currentRequestBookmark;
    }

    /**
     * Record the post-write D1 bookmark that should be echoed back to the
     * client on the outbound `x-d1-bookmark` header. Safe to call multiple
     * times — the last value wins; only the most recent write's bookmark
     * is meaningful for downstream read pinning.
     */
    protected setOutboundBookmark(bookmark: string | undefined): void {
        this.currentResponseBookmark = bookmark;
    }

    /**
     * The userId forwarded by the runtime's `resolveIdentity` hook for the
     * current request, or `undefined` when the request is anonymous. Use
     * this to populate `ctx.auth.userId` inside `buildCtx`.
     */
    protected getCurrentUserId(): string | undefined {
        return this.currentRequestUserId;
    }

    /**
     * The caller's IP for the current request (Cloudflare's `CF-Connecting-IP`,
     * forwarded server-side), or `undefined` when unknown. Use this to populate
     * `ctx.ip` inside `buildCtx`.
     */
    protected getCurrentIp(): string | undefined {
        return this.currentRequestIp;
    }

    /**
     * W3C `traceparent` of the inbound RPC (forwarded by the runtime), or
     * `undefined`. `buildCtx` passes it to `createContainerContext` so outbound
     * container fetches carry it and the container's spans join the same trace.
     */
    protected getCurrentTraceparent(): string | undefined {
        return this.currentRequestTraceparent;
    }

    /**
     * The in-flight dispatch's trace ids, for the generated `buildCtx` to hand to
     * {@link makeTracer}. `undefined` outside a dispatch (an alarm, a lifecycle
     * hook), where the tracer mints its own anchor.
     */
    protected getCurrentTrace(): { rootSpanId: string; traceId: string } | undefined {
        return this.currentRequestTrace;
    }

    /**
     * Identity claims (email, name, roles, …) forwarded by the runtime's
     * `resolveIdentity` hook. Returns `undefined` for anonymous requests
     * or when no extra claims were attached. Use this to populate the
     * value returned by `ctx.auth.getIdentity()` inside `buildCtx`.
     */
    protected getCurrentIdentity(): Record<string, unknown> | undefined {
        return this.currentRequestIdentity;
    }

    /**
     * Whether the in-flight `/rpc` call is a trusted server-initiated dispatch
     * (scheduler/cron). A concrete `handleRpc` consults this to decide whether
     * `internal` functions may run — they may for system dispatch, never for a
     * client RPC (which never carries the `x-lunora-system` header).
     */
    protected isSystemDispatch(): boolean {
        return this.currentRequestSystem;
    }

    /**
     * Run a data migration by id against this shard, returning the runner's
     * result. The base class can't reach the project's generated
     * `LUNORA_MIGRATIONS` registry or build a schema-aware writer, so it reports
     * the migration as unknown; the codegen-generated subclass overrides this to
     * look the migration up and invoke `runDataMigration`.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to reach the generated migration registry
    protected runShardDataMigration(args: RunShardMigrationArgs): Promise<MigrationRunResult> {
        return Promise.reject(new LunoraError("MIGRATION_NOT_FOUND", `data migration "${args.id}" is not registered`, { status: 404 }));
    }

    /**
     * Index the rows that predate a `.searchIndex()` into its companion, a
     * bounded number of pages per call, and report whether anything is left.
     *
     * This is the exit from `staged: true`. A staged index is skipped by every
     * migration pass by design — the option exists for tables too large to walk
     * during a cold start — so without an explicit run its pre-existing rows are
     * unsearchable forever. The base class can't reach the project's generated
     * `schema`, so it reports the op unsupported; the codegen subclass overrides
     * it to call `backfillSearchIndexes`.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to reach the generated schema
    protected runShardSearchBackfill(_options: { maxPages?: number }): SearchBackfillProgress {
        // `NOT_IMPLEMENTED`, not `INTERNAL`: the latter is catalogued `internal`, so
        // `errorToResponse` would replace this message with "internal error" and the
        // caller would get a bare 501 with nothing actionable in it.
        throw new LunoraError("NOT_IMPLEMENTED", "search backfill is unavailable: this shard was built without a generated schema");
    }

    /**
     * Lazily provision the shard's physical tables before an operation that
     * depends on them existing. The base class has no `schema.ts`, so it does
     * nothing; the codegen subclass overrides this to run `runShardMigrations`
     * once (guarded by an idempotent `migrated` flag). Kept here so base-class
     * paths — notably admin introspection — can materialise tables on demand
     * without knowing the schema, which is what keeps the data browser from
     * showing an empty shard on first load.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this to run the generated schema's migrations
    protected ensureMigrated(): void {}

    /**
     * Foreign-key map for `table`: doc field → target table, for every field
     * declared `v.id("target")` in the schema, so the data browser can render
     * those cells as links. The base class can't see the user's `schema.ts`, so
     * it returns `undefined` (no links); the codegen subclass overrides this with
     * the schema-derived map.
     */

    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to read the generated schema's foreign keys
    protected tableRefs(_table: string): Record<string, string> | undefined {
        return undefined;
    }

    /**
     * Declared indexes for `table` (secondary, search, rank, vector), surfaced by
     * the schema viewer via `__lunora_admin__:listTableIndexes`. Like
     * {@link tableRefs}, the base class can't see the user's `schema.ts`, so it
     * reports none; the codegen subclass overrides this with the schema-derived
     * list. Schema-sourced rather than read from SQLite because lunora's physical
     * indexes are `json_extract` expressions whose field names PRAGMA can't recover.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this to read the generated schema's index metadata
    protected tableIndexes(_table: string): TableIndexInfo[] {
        return [];
    }

    /**
     * Typed columns for `table` (name, validator-IR type, PK/FK/storage role),
     * surfaced by the schema viewer's diagram via `__lunora_admin__:describeTable`.
     * Like {@link tableRefs}/{@link tableIndexes}, the base class can't see the
     * user's `schema.ts`, so it reports none; the codegen subclass overrides this
     * with the schema-derived list. Schema-sourced rather than read from SQLite
     * because lunora stores rows in a `__doc__` JSON blob, so PRAGMA recovers
     * neither declared types nor PK/FK roles.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the generated schema's column metadata
    protected tableColumns(_table: string): ColumnMeta[] {
        return [];
    }

    /**
     * Storage-key columns per table (`{ table: [field, …] }`) — every field
     * declared `v.storage(...)` in the schema, so the admin `storageReferences`
     * read can join R2 objects back to the rows that own them (and flag orphans).
     * Like {@link tableRefs}, the base class can't see the user's `schema.ts`, so
     * it reports none; the codegen subclass overrides this with the schema-derived
     * map.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the generated storage-column map
    protected storageColumns(): Record<string, string[]> {
        return {};
    }

    /**
     * Static schema advisories for this deployment, surfaced via
     * `__lunora_admin__:getAdvisories`. Computed by `@lunora/advisor` at codegen
     * time (the only place the schema + query reads are both available) and
     * emitted into the generated subclass, which overrides this. The base class
     * can't see the user's `schema.ts`, so it reports none.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the generated advisory list
    protected advisories(): AdvisoryFinding[] {
        return [];
    }

    /**
     * Every declared procedure, surfaced via
     * `__lunora_admin__:getAdvisorProcedures`. Discovered by the codegen feeder
     * and emitted into the generated subclass, which overrides this.
     *
     * Separate from {@link advisories} because it is the denominator, not the
     * numerator: findings say what is wrong, this says how much exists to be
     * right, and the studio's health score needs both. The base class can't see
     * the user's functions, so it reports none.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the generated procedure list
    protected advisorProcedures(): AdvisorProcedure[] {
        return [];
    }

    /**
     * Row-level-security metadata for this deployment, surfaced via
     * `__lunora_admin__:rlsPolicies` to the studio's read-only RLS inspector:
     * which `definePolicy`s guard which `(table, on)` and which `defineRole`s
     * are registered. Statically discovered by `@lunora/codegen` at codegen
     * time (the only place every `.use(rls(...))` chain is visible) and emitted
     * into the generated subclass, which overrides this. The base class can't
     * see the user's `lunora/` sources, so it reports none. Never includes the
     * `when` predicate — that's an opaque closure whose logic stays in code.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the generated RLS policy + role metadata
    protected rlsMetadata(): RlsPoliciesResult {
        return { policies: [], roles: [] };
    }

    /**
     * Masking metadata for this deployment, surfaced via
     * `__lunora_admin__:maskPolicies` to the studio's data-browser mask preview:
     * which `(table, column)` pairs a `.use(mask(...))` chain redacts and the
     * declared strategy. Statically discovered by `@lunora/codegen` (the only
     * place every `.use(mask(...))` chain is visible) and emitted into the
     * generated subclass, which overrides this. The base class can't see the
     * user's `lunora/` sources, so it reports none. Never includes the masking
     * closure — only the column + strategy descriptor.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the generated mask column metadata
    protected maskMetadata(): MaskPoliciesResult {
        return { columns: [] };
    }

    /**
     * Storage access-rule metadata for this deployment, surfaced via
     * `__lunora_admin__:storageRules` to the studio's read-only access-rules
     * view: which `defineStorageRule`s gate which `(bucket, on, prefix)`.
     * Statically discovered by `@lunora/codegen` from every
     * `.use(storageRules(...))` chain and emitted into the generated subclass,
     * which overrides this. The base class can't see the user's `lunora/`
     * sources, so it reports none. Never includes the `when` predicate.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the generated storage-rule metadata
    protected storageRulesMetadata(): StorageRulesResult {
        return { rules: [] };
    }

    /**
     * Which optional, package-backed features this deployment wires up, surfaced
     * via `__lunora_admin__:studioFeatures` so the studio hides nav pages whose
     * backing package isn't enabled (mirroring how auth panels gate on
     * capabilities). Statically discovered by `@lunora/codegen` from the app's
     * `lunora/` sources + schema and emitted into the generated subclass, which
     * overrides this. The base class can't see the user's project, so it reports
     * every flag `false` — an un-generated `ShardDO` shows no optional pages.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the statically-discovered feature flags
    protected studioFeatures(): StudioFeaturesResult {
        return {
            analytics: false,
            auth: false,
            containers: false,
            flags: false,
            kv: false,
            mail: false,
            notifications: false,
            payments: false,
            queues: false,
            scheduler: false,
            storage: false,
            vectors: false,
            workflows: false,
        };
    }

    /**
     * Evaluate every statically-discovered feature flag under `context` for the
     * studio's read-only Flags page (`__lunora_admin__:listFlags`). The flag keys
     * + value types are discovered by `@lunora/codegen` from the app's
     * `ctx.flags.<type>("key", …)` reads and evaluated through the configured
     * `@lunora/flags` provider — work only the codegen subclass can do, so it
     * overrides this. The base class wires no provider and reports
     * `configured: false` with zero flags (an un-generated `ShardDO` has none).
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with live OpenFeature evaluation over the discovered flag keys
    protected evaluateFlags(_context?: Record<string, unknown>): Promise<FlagsResult> {
        return Promise.resolve({ configured: false, flags: [] });
    }

    /**
     * Serve one reserved {@link FLAGS_FUNCTION_PREFIX} live flag read for the
     * React client's `useFlag`/`useFlags`. `functionPath` carries the flag key +
     * type and `args` the per-subscriber targeting context; the codegen subclass
     * overrides this to evaluate the flag through the app's `@lunora/flags`
     * provider under `identity` and return the resolved value. The base class
     * wires no provider, so it returns `null` — `resolveReactiveOutcome` reads
     * `null` as "nothing to deliver" and the subscriber keeps its default.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this to evaluate the flag through the configured provider
    protected runFlagSubscriptionRead(_functionPath: string, _arguments: Record<string, unknown>, _identity?: SubscriptionIdentity): Promise<unknown> {
        // eslint-disable-next-line unicorn/no-null -- the "nothing to deliver" sentinel resolveReactiveOutcome reads
        return Promise.resolve(null);
    }

    /**
     * The Cloudflare Queues declared by this app, surfaced via
     * `__lunora_admin__:listQueues` for the studio's Queues page. Queues are NOT
     * Durable Objects and hold no shard state, so this is pure declaration
     * metadata statically discovered by `@lunora/codegen` from `lunora/queues.ts`
     * and emitted into the generated subclass, which overrides this. The base
     * class can't see the user's project, so it reports none.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the statically-discovered queue metadata
    protected queuesMetadata(): QueuesResult {
        return { queues: [] };
    }

    /**
     * The Cloudflare Workflows declared by this app, surfaced via
     * `__lunora_admin__:listWorkflows` for the studio's Workflows page. Workflows
     * are NOT Durable Objects and hold no shard state, so this is pure
     * declaration metadata statically discovered by `@lunora/codegen` from
     * `lunora/workflows.ts` and emitted into the generated subclass, which
     * overrides this. The base class can't see the user's project, so it reports
     * none — an un-generated `ShardDO` lists zero workflows.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this with the statically-discovered workflow metadata
    protected workflowsMetadata(): WorkflowsResult {
        return { workflows: [] };
    }

    /**
     * Runtime advisories derived from observed signal — currently `unused_index`:
     * a declared index a query has never exercised since this instance woke. To
     * keep noise down it only inspects tables that have used *some* index (so a
     * never-queried table never spams findings; a table queried only via full
     * scan is the `filter_without_index` lint's concern, not this one). The
     * "since this instance woke" caveat rides in the detail — like the other
     * in-memory counters, the signal resets on hibernation.
     */
    protected runtimeAdvisories(): AdvisoryFinding[] {
        const usedTables = new Set([...this.usedIndexes].map((key) => key.slice(0, key.indexOf(":"))));
        const findings: AdvisoryFinding[] = [];

        for (const table of usedTables) {
            for (const index of this.tableIndexes(table)) {
                // Only the kinds a query names explicitly (and that this hook
                // stamps): secondary, search, rank. Vector indexes use a separate
                // API not tracked here.
                if (index.type === "vector" || this.usedIndexes.has(`${table}:${index.name}`)) {
                    continue;
                }

                findings.push({
                    cacheKey: `unused_index:${table}:${index.name}`,
                    categories: ["PERFORMANCE"],
                    description:
                        "A declared index has not been exercised by any query since this shard instance started. An unused index costs storage and is maintained on every write for no read benefit.",
                    detail: `Index "${index.name}" on table "${table}" has not been used since this instance woke, though other indexes on "${table}" have — it may be redundant.`,
                    facing: "INTERNAL",
                    level: "INFO",
                    metadata: { index: index.name, indexKind: index.type, since: "instance-woke", table },
                    name: "unused_index",
                    remediation: "Confirm over a representative window, then drop the index if no query needs it.",
                    title: "Unused index",
                });
            }
        }

        return findings;
    }

    /**
     * Export every row this shard owns across the requested tables (or every
     * shard-local user table when none are specified) as `{table, doc}` records.
     * Globals are not the DO's concern; the worker reads those from D1.
     *
     * The base class can't build a schema-aware writer without seeing the user's
     * `schema.ts`, so it returns an empty list; the codegen-generated subclass
     * overrides this with `exportShardRows(...)` against the live writer.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected runShardExport(_args: RunShardExportArgs): Promise<ExportRow[]> {
        return Promise.resolve([]);
    }

    /**
     * Re-insert a batch of `{table, doc}` rows on this shard, returning the
     * per-table insert counts and a per-row error array. Schema-failed rows do
     * not abort the batch — they're surfaced in `errors` and the rest land.
     *
     * The base class can't build a writer; the codegen subclass overrides this
     * to call `importShardRows(...)` inside one transaction per batch.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected runShardImport(_args: RunShardImportArgs): Promise<ImportShardResult> {
        return Promise.resolve({ conflicts: 0, errors: [], inserted: {} });
    }

    /**
     * Apply a single-row insert/patch/replace/delete through the schema-aware
     * writer. The base class can't build a writer without the user's `schema.ts`,
     * so it reports the table as unknown; the codegen-generated subclass overrides
     * this to run the op against a live `createShardCtxDb(...)` writer (which
     * maintains the FTS/aggregate/rank shadow tables and runs validators).
     *
     * The single seam every writer-routed single-row write goes through — a studio
     * row edit, a bulk row op, a TTL expiry. `headroom` is an optional BY-VALUE
     * meter: an admin caller omits it and the override falls back to
     * `this.transactionHeadroom()`, which mints a fresh per-call budget, while
     * {@link ShardDO.pollTtlSweeps} (an alarm work item draining many rows under
     * ONE ceiling) passes its own tracker explicitly.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected runShardWrite(args: RunShardWriteArgs, _headroom?: TransactionHeadroomTracker): Promise<RunShardWriteResult> {
        return Promise.reject(new LunoraError("UNKNOWN_TABLE", `unknown table: ${args.table}`, { status: 404 }));
    }

    /**
     * The engine behind every writer-routed BULK row op — `deleteRows`,
     * `clearTable`, `patchRows`. Collects one bounded batch of matching ids with
     * the same predicate {@link readTablePage} previews, then hands each to
     * `apply` ONE AT A TIME so the FTS / aggregate / rank shadow tables stay
     * correct. Bounded to {@link SHARD_BULK_ROW_CAP} per call; `hasMore` tells
     * the caller to loop rather than writing an unbounded set at once.
     *
     * The three ops differ only in the per-row call and in what they name the
     * count, so they share this and rename `count` at the wire boundary.
     *
     * `after` is the KEYSET CURSOR, passed explicitly rather than read off `args`
     * so that "this scan was ordered" and "a cursor may be returned" cannot drift
     * apart: a cursor comes back only when one went in. The last id of an
     * UNORDERED scan is an arbitrary point in id space, and a caller resuming from
     * it would skip every matching row sorting below it — silently.
     *
     * Applications are sequential by design — parallel writes to one DO would
     * contend on OCC — so the per-row `await` is intentional. That also makes each
     * row an interleaving point, so a mid-batch throw is reachable (an OCC
     * conflict, or a `.unique()` column patched to a constant across two rows).
     * Rows applied before it are ALREADY COMMITTED — the writer commits per row —
     * so the caller must flush on the failure path too; {@link handleBulkRowOp}
     * owns that, alongside every other admin arm's flush.
     */
    protected async runShardBulkRowOp(args: RunShardBulkRowArgs, apply: (id: string) => Promise<void>, after?: string): Promise<RunShardBulkRowResult> {
        const limit = Math.min(Math.max(Math.trunc(args.limit ?? SHARD_BULK_ROW_CAP), 1), SHARD_BULK_ROW_CAP);

        // Collect this batch's ids first (a read; raw SQL is fine), then write
        // each through the writer.
        const { hasMore, ids } = selectMatchingIds(this.sql as SqlExec, {
            after,
            filters: args.filters,
            limit,
            search: args.search,
            table: args.table,
        });

        let count = 0;

        for (const id of ids) {
            // eslint-disable-next-line no-await-in-loop -- see the note above: per-row writer calls must serialise to avoid OCC contention on the shard DO
            await apply(id);
            count += 1;
        }

        // Only an ordered scan yields a resumable boundary — see the note above.
        return { count, cursor: after === undefined ? undefined : ids.at(-1), hasMore };
    }

    /**
     * Count, for the row identified by `rowId`, how many rows precede it under
     * `index` within `partitionKey` on this shard (`before`) and the partition's
     * total (`total`). The cross-shard coordinator fans this out to every shard
     * and sums the results into a global rank.
     *
     * The base class can't build a schema-aware writer without the user's
     * `schema.ts`, so it has no rank shadow tables to count against; the
     * codegen-generated subclass overrides this to call `rankBefore(...)` on a
     * live `createShardCtxDb(...)` writer.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected runShardRankBefore(_args: RunShardRankBeforeArgs): Promise<{ before: number; total: number }> {
        return Promise.reject(new LunoraError("NOT_IMPLEMENTED", "rankBefore is not implemented in base ShardDO", { status: 500 }));
    }

    /**
     * Page this shard's local ranked slice under `index`, each row tagged with
     * its rank-key tuple (`partitionKey`, `sortValues`, `rowId`). The cross-shard
     * coordinator (`orchestrateRankPage`) fans this out to every live shard and
     * k-way merges the slices into one globally-ranked page.
     *
     * Same base/codegen split as {@link runShardRankBefore}: the base class has
     * no schema-aware writer, so the codegen subclass overrides this to call
     * `rankPageRows(...)` on a live `createShardCtxDb(...)` writer.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected runShardRankPage(_args: RunShardRankPageArgs): Promise<ShardRankPageResult> {
        return Promise.reject(new LunoraError("NOT_IMPLEMENTED", "rankPage is not implemented in base ShardDO", { status: 500 }));
    }

    /**
     * Page this shard's change-data-capture log past `sinceSeq`. Read-only and
     * schema-free — it only touches the `__cdc_log` table — so the base class
     * implements it directly (no codegen override needed). Returns an empty
     * page that leaves the cursor untouched when CDC was never enabled on this
     * shard, so the coordinator tolerates shards that predate CDC.
     */
    protected runShardCdcSync(args: RunShardCdcSyncArgs): { changes: CdcChange[]; cursor: number } {
        const sql = this.sql as SqlExec;
        const present = sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, CDC_LOG_TABLE).toArray().length > 0;

        if (!present) {
            return { changes: [], cursor: args.sinceSeq };
        }

        // Retention-gap guard, and it comes first because it is the more
        // destructive of the two levels. `trimCdcChanges` DELETES rows, so a
        // consumer resuming below the retained floor would be handed the surviving
        // tail with an advanced cursor and no indication that anything was
        // skipped — a warehouse table permanently missing the trimmed range, and
        // nothing anywhere reporting it. The resume and shape-seed paths already
        // gate on this floor (they re-seed instead); this path, the one warehouse
        // connectors and `cdcSync` use, did not. `+ 1` because a consumer sitting
        // exactly at `floor - 1` has seen everything below the floor.
        const floor = minCdcSeq(sql);

        if (floor !== undefined && cursorBelowRetainedFloor(floor, args.sinceSeq)) {
            throw cdcTrimmedError(floor, args.sinceSeq, "shard");
        }

        const page = readCdcChanges(sql, { limit: args.limit, sinceSeq: args.sinceSeq });

        // Payload-compaction guard. A compacted row keeps its key and loses its
        // `doc`, which is exactly what a shape diff wants and exactly what a
        // change-feed consumer must never be handed silently: a doc-less
        // insert/update is indistinguishable on the wire from a delete, so
        // serving one would corrupt a warehouse table rather than fail. A
        // consumer whose page contains one is told so, and re-syncs from a
        // snapshot.
        //
        // The test is "a row that SHOULD carry a post-image and doesn't", not
        // "the oldest row that carries one": a `delete` stores a NULL doc by
        // design, so a log whose retained prefix opens with deletes — a fresh
        // changelog, or one this sweep trimmed to a delete boundary — is
        // perfectly serveable and must not be refused. Compaction only ever
        // clears a PREFIX of the log, so a compacted row in the requested range
        // always lands in this first page.
        const compacted = page.changes.find((change) => change.op !== "delete" && change.doc === undefined);

        if (compacted !== undefined) {
            throw new LunoraError(
                "CDC_PAYLOAD_COMPACTED",
                `cdc payloads at or before seq ${String(compacted.seq)} have been compacted; resume from a snapshot (sinceSeq ${String(args.sinceSeq)} is below the retained payload window)`,
                { status: 409 },
            );
        }

        return page;
    }

    /**
     * Page the changelog the way {@link ShardDO.runShardCdcSync} does, with the
     * R2 cold tier behind it — see {@link CdcRetentionRunner.syncPage}.
     *
     * Deliberately layered around the sync method rather than folded into it,
     * and the reason is latency, not signatures. `runShardCdcSync` is also the
     * replica link's `readChanges`; that path is sync only as far as
     * `servePull`, whose own caller is already async, so threading a promise
     * through it would cost one `await` in one function. What it would also cost
     * is an R2 round trip on the replica pull path, which runs per follower per
     * poll — and `servePull` gates on the floor before it reads, so it would
     * have to be restructured to reach the fallback at all rather than merely
     * awaited.
     *
     * The consequence is real and not merely theoretical: a follower below the
     * floor still pays a full bootstrap where a connector no longer does. It is
     * tracked as a follow-up, not absorbed silently here.
     */
    protected cdcSyncPage(args: RunShardCdcSyncArgs): Promise<{ changes: CdcChange[]; cursor: number }> {
        return this.cdcRetention.syncPage(() => this.runShardCdcSync(args), args);
    }

    /**
     * The `__cdc_log` high-watermark stamped on outbound `data`/`delta` frames
     * as their `cursor`, letting a client persist its resume position (Pillar
     * 1b). Returns `undefined` when CDC was never enabled on this shard — there
     * is no monotonic cursor to advertise, and the frame omits the field so the
     * wire stays byte-identical to the pre-cursor format for non-CDC apps.
     */
    protected currentCdcCursor(): number | undefined {
        return this.cdcEnabled() ? readCdcCursor(this.sql as SqlExec) : undefined;
    }

    /**
     * This shard's current CDC epoch, stamped on `data`/`delta`/`resume` frames
     * next to the cursor so a reconnecting client can prove it is resuming the
     * same changelog timeline it cached (see {@link evaluateResume}). Returns
     * `undefined` when CDC was never enabled — the frame omits the field, keeping
     * the wire byte-identical to the pre-epoch format for non-CDC apps.
     */
    protected currentCdcEpoch(): string | undefined {
        return this.cdcEnabled() ? readCdcEpoch(this.sql as SqlExec) : undefined;
    }

    /**
     * Mint a fresh CDC epoch because a resume claim just proved this shard's
     * changelog forked under it, and return the new value for the outgoing frame.
     *
     * The trigger is a client presenting `sinceEpoch === epoch` with `sinceSeq >
     * cursor`: it holds a cursor this shard once issued on THIS timeline and can
     * no longer account for. Only a rollback produces that — in practice a native
     * PITR restore, which is armed in {@link handlePitrAdminOp}.
     *
     * **Why the signal has to come from a client.** A restore reverts the whole
     * SQLite database, `__cdc_meta` included, so the proactive bump `pitrRestore`
     * performs is rolled back along with everything else — the epoch cannot
     * detect the one event it exists for. Nothing durable inside a SQLite-backed
     * Durable Object escapes that: the KV half of `state.storage` is the same
     * database, and an alarm is a row in it. The only record of the pre-restore
     * timeline that the restore cannot reach is the cursor each CLIENT cached, so
     * that is what this reads. Turning one client's refusal into a shard-wide
     * epoch bump is what extends the protection to clients that reconnect later,
     * after post-restore writes have climbed the AUTOINCREMENT back past their
     * own `sinceSeq` and the `sinceSeq > cursor` guard no longer fires for them.
     *
     * **What it detects.** Any rollback under a live subscriber base, promptly: a
     * restore restarts the object (`ctx.abort()`, or the eviction that lets a
     * deferred restore apply), which drops every hibernated socket, so the whole
     * subscriber set reconnects with pre-restore cursors while the restored
     * cursor is still low. The first of them seals the fork for the rest.
     *
     * **What it cannot detect.** A rollback on a shard whose clients ALL stay
     * offline until the cursor has climbed back past their cursors — nobody is
     * left to present the proof. A shard with no subscribers at all is the
     * degenerate case of that, and is also the case where nothing is stale.
     *
     * **On trusting `sinceSeq`.** It is client-supplied, so a caller that already
     * knows this shard's epoch can force a bump, and a bump is shard-wide: every
     * subscriber takes a full snapshot instead of a resume on its NEXT reconnect.
     * The cost is bounded (the once-per-wake latch below) and deferred — nothing
     * is pushed and no live subscription is interrupted — and it stays strictly
     * less than what the same caller can already spend by subscribing without a
     * `sinceSeq` at all.
     * @returns the freshly minted epoch, to stamp on the frame this verdict produces
     */
    protected sealForkedTimeline(): string {
        // At most once per wake, and that bound is a security property rather
        // than an optimisation.
        //
        // The proof this acts on — "a client presents a cursor ahead of ours on
        // our own epoch" — is CLIENT-SUPPLIED, and the epoch it must match is
        // stamped on every frame the client has ever received. So any subscriber
        // can manufacture the proof at will, and without a bound each forged
        // frame would cost one SQLite write and invalidate the cached resume of
        // every other subscriber on the shard: a one-frame request amplified into
        // N full snapshots.
        //
        // One seal is all a real restore needs — it re-mints the epoch shard-wide,
        // so every client that reconnects afterwards is refused by the epoch
        // comparison above rather than by re-proving the rollback. Latching after
        // the first therefore costs the genuine case nothing.
        //
        // What it caps the forged case AT is one epoch bump per wake, and that is
        // not free: an eviction leaves the epoch intact and every client resumes
        // across it, whereas a bump forces all N subscribers to take a full
        // snapshot on their next reconnect. So the honest bound is "one forged
        // frame buys N snapshots, once per wake", not "the cost of a cold wake" —
        // still bounded, still deferred (nothing is pushed and no live
        // subscription is interrupted), and still strictly less than the same
        // caller can spend by simply subscribing without a `sinceSeq`. Stated
        // plainly because a latch defended by an understated threat is a latch
        // someone deletes as unnecessary. A restore evicts the object, so the next
        // real fork gets a fresh instance and a fresh latch.
        if (this.forkSealed) {
            // Already sealed this wake: hand back the epoch minted then, so the
            // caller still stamps the post-fork timeline on its refusal.
            return readCdcEpoch(this.sql as SqlExec);
        }

        this.forkSealed = true;

        return bumpCdcEpoch(this.sql as SqlExec);
    }

    /**
     * Decide whether a reconnecting subscription can resume from `sinceSeq`
     * without a full snapshot. Returns the current high-watermark `cursor` plus
     * a `resumable` verdict.
     *
     * `resumable: true` means `sinceSeq` is within the CDC retention window,
     * every entry in the query's `readSet` is one the changelog can speak for,
     * and none of them changed in `(sinceSeq, cursor]` — the client's cached
     * value is still current, so the caller emits a lightweight `resume` frame
     * instead of re-shipping the snapshot.
     *
     * `resumable: false` means the log was compacted past `sinceSeq` (a
     * retention gap), a read table changed (the client needs the fresh value),
     * the read-set contains something the changelog cannot vouch for (see
     * {@link cdcCanVouchFor}), or CDC is off — the caller falls back to the
     * full-snapshot seed.
     */
    protected evaluateResume(
        sinceSeq: number,
        readSet: Set<string>,
        sinceEpoch?: string,
    ): { cursor: number | undefined; epoch: string | undefined; resumable: boolean } {
        const sql = this.sql as SqlExec;

        if (!this.cdcEnabled()) {
            // Stub `sql` handle or a pre-CDC shard: can't prove the client is
            // current, so fall back to a full snapshot.
            return { cursor: undefined, epoch: undefined, resumable: false };
        }

        const cursor = readCdcCursor(sql);
        // Read the epoch once: it gates the resume verdict AND is returned so the
        // caller (`seedSubscription`) can stamp the frame without a second read.
        const epoch = readCdcEpoch(sql);

        // Timeline fork: the client cached against a different epoch (a reset, or
        // a recycled DO id), so its `sinceSeq` indexes an unrelated changelog.
        // Re-snapshot regardless of the seq comparison. A client that supplies a
        // `sinceSeq` but no epoch (pre-epoch client) is treated the same — we
        // can't prove it shares this timeline.
        if (sinceEpoch !== epoch) {
            return { cursor, epoch, resumable: false };
        }

        // Rollback guard: a legitimate `sinceSeq` can never exceed the current
        // high-watermark (the cursor is monotonic and survives trims). A client
        // claiming to have seen MORE than the shard holds, on THIS epoch, is
        // proof the log rolled back under it — and is the only such proof that
        // exists (see {@link sealForkedTimeline}). Refuse this client, and seal
        // the fork for every other one.
        if (sinceSeq > cursor) {
            return { cursor, epoch: this.sealForkedTimeline(), resumable: false };
        }

        // Everything below this line reasons from `__cdc_log`, so first ask
        // whether the log is entitled to speak for what this query read at all
        // — a `.global()` table, the `"*"` flags/admin wildcard, or any other
        // dependency it never records makes "nothing changed" a claim it cannot
        // support. See {@link cdcCanVouchFor}; an unrecorded (empty) read-set is
        // an instance of the same rule, not a separate case.
        //
        // This gate sits BEFORE the at-the-high-watermark fast path deliberately:
        // a `.global()` write bumps no cursor on this shard, so `sinceSeq ===
        // cursor` is exactly the state a client that missed one arrives in.
        if (!cdcCanVouchFor(sql, readSet)) {
            return { cursor, epoch, resumable: false };
        }

        // Client already at the high-watermark: nothing newer exists, so it is
        // trivially current — the read-set is vouchable, so no unlogged source
        // can have moved under it.
        if (sinceSeq === cursor) {
            return { cursor, epoch, resumable: true };
        }

        // Retention gap: the log no longer covers `(sinceSeq, cursor]`, so we
        // can't prove what the client missed and must re-snapshot. Two cases:
        //   - `floor === undefined`: the log was fully compacted yet
        //     `sinceSeq < cursor` (the watermark lives on past a total trim via
        //     `sqlite_sequence`), so every missed change is gone.
        //   - `floor > sinceSeq + 1`: the oldest retained change is newer than
        //     the client's next-expected seq, so `(sinceSeq, floor)` was
        //     compacted away.
        const floor = minCdcSeq(sql);

        // The `floor === undefined` half is this path's own, not the shared
        // predicate's: an empty log with `sinceSeq < cursor` means the log was
        // fully trimmed while the watermark lived on through `sqlite_sequence`,
        // so every missed change is gone.
        if (floor === undefined || cursorBelowRetainedFloor(floor, sinceSeq)) {
            return { cursor, epoch, resumable: false };
        }

        // Resumable iff no table the query reads changed since `sinceSeq`. That
        // is a metadata question — which TABLES appear in `(sinceSeq, cursor]` —
        // so it is answered by an existence probe against the `("table", seq)`
        // index rather than by materializing the changes. The scan this replaced
        // read a bounded page of changes WITH their post-images and, past that
        // page, gave up and re-snapshotted: a client offline long enough to
        // accumulate the cap was the one guaranteed to be re-sent its whole
        // query result, precisely when the delta was worth the most.
        return { cursor, epoch, resumable: !cdcTouchesTables(sql, sinceSeq, readSet) };
    }

    /**
     * The `__idempotency` namespace for the in-flight request, or `undefined` when
     * the mutation must not be deduped at all.
     *
     * An authenticated caller namespaces by its server-minted user id, so a forged
     * `mutation_id` can only ever collide with that caller's own mutations. An
     * ANONYMOUS caller has no such id: namespacing every one of them under `""`
     * puts distinct clients in ONE key space, where a reused or guessable
     * `mutation_id` makes one client's mutation short-circuit to another's cached
     * result — suppressed without ever running. So an anonymous caller namespaces
     * by its `x-lunora-client-id` instead (minted client-side — stable per device
     * for an app with a durable outbox, which persists the id alongside each
     * queued write; per session otherwise, so a reload widens the dedup window
     * rather than defeating it); one that sends none gets `undefined` and simply
     * skips the cache, which fails
     * OPEN (the handler re-runs, the pre-idempotency behaviour) rather than
     * risking another client's mutation.
     *
     * A server-initiated dispatch (`x-lunora-system`, e.g. a queue/scheduler
     * retry) shares one namespace even when it carries no identity: it originates
     * INSIDE the trust boundary and its `mutationId` is server-minted, so there is
     * no untrusted party to collide with — and it is exactly the caller that needs
     * dedup most.
     */
    protected idempotencyNamespace(): string | undefined {
        const userId = this.currentRequestUserId;

        if (userId !== undefined && userId.length > 0) {
            return userId;
        }

        if (this.currentRequestSystem) {
            return "system:";
        }

        const clientId = this.currentRequestClientId;

        return clientId !== undefined && clientId.length > 0 ? `anon:${clientId}` : undefined;
    }

    /**
     * Look up a previously-committed mutation for the in-flight request's
     * `(identity, mutationId)`. Returns `{ value }` (the cached, JSON-decoded
     * handler result) on a hit so the dispatch path can short-circuit, or
     * `undefined` when `mutationId` is absent (queries / legacy clients), the
     * caller has no dedup namespace (see {@link idempotencyNamespace}), or the
     * mutation has not run yet. Tolerates a stub `sql` handle without the dedup
     * table (returns a miss) so unit harnesses that skip migrations still work.
     * @returns the cached result box on a hit, or `undefined` for a miss or absent mutationId
     */
    protected readIdempotentResult(mutationId: string | undefined): { value: unknown } | undefined {
        const namespace = this.idempotencyNamespace();

        if (mutationId === undefined || namespace === undefined) {
            return undefined;
        }

        try {
            const record = readIdempotent(this.sql as SqlExec, namespace, mutationId);

            return record === undefined ? undefined : { value: JSON.parse(record.resultJson) };
        } catch {
            // Missing table (pre-migration shard / test stub) or a malformed
            // cached payload — treat as a miss and let the handler run.
            return undefined;
        }
    }

    /**
     * Record the in-flight mutation's result against its `(identity, mutationId)`
     * so a later replay of the same id short-circuits through
     * {@link readIdempotentResult} instead of re-running the handler. A no-op
     * unless the request carried an `x-lunora-mutation-id` header (queries and
     * legacy clients leave `currentRequestMutationId` undefined) AND the caller
     * has a dedup namespace — the read side skips the same two cases, so the two
     * never disagree about whether a key exists.
     *
     * For a mutation this runs INSIDE the handler's transaction (via
     * {@link ShardDO.commitMutationBookkeeping}, which `handleRpc` invokes before
     * the transaction commits), so the dedup row is durable iff the writes are —
     * closing the crash window where the writes commit but the replay guard does
     * not. Actions/queries aren't transaction-wrapped, so they call this on the
     * live dispatch path right after the handler resolves, through the same
     * `this.sql` handle. `INSERT OR IGNORE` keeps a concurrent double-dispatch (or
     * the now-skipped post-dispatch call) of the same id idempotent. Also runs the
     * throttled dedup-table GC.
     */
    protected persistIdempotentResult(result: unknown): void {
        const namespace = this.idempotencyNamespace();

        if (this.currentRequestMutationId === undefined || namespace === undefined) {
            return;
        }

        const now = Date.now();

        try {
            // Store the WIRE-encoded result so the cache holds JSON-safe bytes (a
            // raw `bigint` result would otherwise throw here) and a later replay
            // returns byte-identical wire form without a second `encodeWire`.
            // `encodeWire` maps a void mutation's `undefined` to a tagged array, so
            // `JSON.stringify` always yields a string for real data — the old
            // `?? "null"` floor is now dead (a non-data result would throw and the
            // catch below swallows it, since this bookkeeping is best-effort).
            writeIdempotent(this.sql as SqlExec, namespace, this.currentRequestMutationId, JSON.stringify(encodeWire(result)), now);

            // Throttled GC: drop dedup rows past the retention window at most once
            // per interval per warm instance.
            if (now - this.lastIdempotencyTrimAt > IDEMPOTENCY_GC_INTERVAL_MS) {
                // Stamp BEFORE the sweep, not after: the throttle guard is the
                // only thing that stops this running again, so a trim that
                // throws must still push the next attempt out by a full
                // interval. Stamping after left a persistently failing
                // full-scan DELETE re-running inside every subsequent
                // mutation's write transaction, swallowed by the catch below
                // and getting more expensive each time. Both siblings
                // (`durable-stream-runner.trim`, `cdc-retention`) stamp first.
                this.lastIdempotencyTrimAt = now;
                trimIdempotent(this.sql as SqlExec, now - IDEMPOTENCY_RETENTION_MS);
            }
        } catch {
            // Missing dedup table (pre-migration shard / test stub) or a stub
            // `sql` handle — best-effort bookkeeping must never fail a mutation
            // whose writes already committed. The replay just re-runs (the read
            // side also treats a missing row as a miss).
        }
    }

    /**
     * Whether `functionPath` names a registered custom mutator (a `defineMutator`
     * declaration) rather than an ordinary `mutation`. The base class knows of no
     * mutators, so the default is `false`; the codegen-generated subclass
     * overrides this to consult its mutator registry. When `true` (and the push
     * carries a `clientId`/`clientSeq`), the dispatch path applies the
     * `__client_watermark` ordering semantics instead of the legacy idempotency
     * dedup.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this to consult its mutator registry
    protected isCustomMutator(_functionPath: string): boolean {
        return false;
    }

    /**
     * Whether `functionPath` names a registered `mutation` — the only function
     * kind whose dispatch may enter the single-writer gate.
     *
     * The gate is `ShardHost.runSerialized`, which on Cloudflare is
     * `state.blockConcurrencyWhile`: it stalls EVERY other dispatch on the
     * shard (queries, WebSocket frames, alarms) for as long as the closure
     * runs. A mutation already ran inside it — `runInTransaction` composes the
     * same gate — so wrapping its dedup check costs nothing extra. An action
     * does not: it is dispatched straight off `handleRpc` and routinely awaits
     * seconds of outbound I/O (an LLM call, a payment round-trip). Gating one
     * would let any caller freeze the whole shard for that long, repeatedly and
     * cheaply, just by attaching an `x-lunora-mutation-id` header — which the
     * runtime forwards verbatim for every kind. Queries are the same story with
     * a smaller constant.
     *
     * Nothing outside a mutation writes the dedup row either
     * (`persistIdempotentResult` runs from the mutation transaction's
     * bookkeeping), so a non-mutation's cache read could only ever miss.
     *
     * The base class has no function registry, so the default is `true` — the
     * conservative answer, preserving the gate wherever the kind is unknown.
     * The codegen-generated subclass overrides it with the real
     * `LUNORA_FUNCTIONS` lookup, which is what production dispatch uses.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this to consult `LUNORA_FUNCTIONS`
    protected isMutationFunction(_functionPath: string): boolean {
        return true;
    }

    /**
     * Classify an in-flight custom-mutator push against the shard's stored
     * high-watermark for `currentRequestClientId`. The watermark is the highest
     * per-client sequence the DO has applied, so the push is exactly one of:
     *
     * - `"already"` — `seq <= watermark`: a replay of a confirmed (or in-flight,
     * now-resent) mutation. The handler must NOT re-run; the dispatch path returns
     * a benign ack so the client drops the pending overlay.
     * - `"next"` — `seq == watermark + 1`: the next mutation in order. Run the
     * authoritative `server` impl and advance the watermark in the same commit.
     * - `"gap"` — `seq > watermark + 1`: an out-of-order arrival (an earlier push
     * was lost). Halt: the client must resend from `watermark + 1`.
     *
     * Returns `undefined` when the push is not a watermarked custom mutator
     * (missing client id/seq, or a stub `sql` handle without the table) so the
     * caller falls through to the legacy idempotency path.
     */
    protected classifyClientMutation(): ClientMutationClass | undefined {
        const clientId = this.currentRequestClientId;
        const seq = this.currentRequestClientSeq;

        if (clientId === undefined || seq === undefined) {
            return undefined;
        }

        // Scope the watermark to the authenticated identity (as `__idempotency`
        // does), so a reused/spoofed `clientId` under a different user can't
        // suppress the real owner's sequence.
        const identity = this.currentRequestUserId ?? "";

        let watermark: number;

        try {
            watermark = readClientWatermark(this.sql as SqlExec, identity, clientId);
        } catch {
            // The `__client_watermark` table is missing. Rather than silently
            // downgrade a mutator-enabled push to the legacy path (which never
            // emits `lastMutationId`), try to create it and re-read so the shard
            // self-heals. A genuine stub `sql` handle (unit harness) throws on
            // the DDL too — only then do we fall back to the legacy path.
            try {
                migrateClientWatermark(this.sql as SqlExec);
                watermark = readClientWatermark(this.sql as SqlExec, identity, clientId);
            } catch {
                return undefined;
            }
        }

        const expected = watermark + 1;

        if (seq <= watermark) {
            return { expected, kind: "already" };
        }

        return seq === expected ? { expected, kind: "next" } : { expected, kind: "gap" };
    }

    /**
     * Terminal response for a watermarked custom-mutator push that is NOT the
     * next-in-order mutation — an idempotent replay ack (`"already"`) or an
     * out-of-order halt (`"gap"`). Returns `undefined` for an ordinary mutation
     * or a `"next"` push so `fetch` proceeds to the authoritative handler. Records
     * the function call on the short-circuit paths so metrics stay attributed.
     */
    protected rejectNonNextMutation(functionPath: string, mutatorClass: ClientMutationClass | undefined, dispatchStartedAt: number): Response | undefined {
        if (mutatorClass === undefined || mutatorClass.kind === "next") {
            return undefined;
        }

        this.recordFunctionCall(functionPath, Date.now() - dispatchStartedAt, undefined, this.currentScannedTables, this.currentIndexHits);

        if (mutatorClass.kind === "already") {
            // Replay of a confirmed (or now-resent) mutation — ack without
            // re-running, echoing the watermark so the client can drop the
            // pending optimistic overlay.
            // eslint-disable-next-line unicorn/no-null -- `result: null` is the explicit on-the-wire "no fresh result" sentinel for a replay ack; `undefined` would be dropped by JSON serialization.
            return jsonResponse({ lastMutationId: mutatorClass.expected - 1, result: null }, 200, bookmarkHeaders(this.currentResponseBookmark));
        }

        // Out-of-order gap — an earlier push was lost. Halt the batch so the
        // client resends from `expected`; never apply out of order.
        return jsonResponse(
            {
                error: {
                    code: "OUT_OF_ORDER",
                    expectedMutationId: mutatorClass.expected,
                    message: `out-of-order mutation; expected sequence ${String(mutatorClass.expected)}`,
                },
            },
            409,
            bookmarkHeaders(this.currentResponseBookmark),
        );
    }

    /**
     * Respond to a dispatch that hit the `(identity, mutationId)` idempotency
     * cache. Records the (zero-work) function call, then: for a `"next"` custom
     * mutator whose handler already committed but whose watermark advance was
     * lost to a crash in between, re-advance and echo `lastMutationId` exactly as
     * the post-commit path does (otherwise the cached branch returns a bare
     * result with a stale watermark and the client reports every later seq as a
     * gap forever); for everything else, return the bare cached `{ result }`.
     */
    protected respondFromIdempotencyCache(
        functionPath: string,
        dispatchStartedAt: number,
        mutatorClass: ClientMutationClass | undefined,
        cachedValue: unknown,
    ): Response {
        this.recordFunctionCall(functionPath, Date.now() - dispatchStartedAt, undefined, this.currentScannedTables, this.currentIndexHits);

        if (mutatorClass?.kind === "next") {
            this.advanceClientMutationWatermark();

            return this.buildDispatchResponse(mutatorClass, cachedValue);
        }

        // A replayed plain mutation already committed in a prior dispatch, so its
        // real commit cursor is in the past; the current high-watermark is a safe
        // conservative bound (CDC only grows, so a frame at `>= ` it is also `>= `
        // the original), letting an in-session requeue still drop its optimistic
        // overlay. {@link mutationCommitCursor} applies the same mutation/CDC scope.
        const commitCursor = this.mutationCommitCursor();

        return jsonResponse(
            commitCursor === undefined ? { result: cachedValue } : { commitCursor, result: cachedValue },
            200,
            bookmarkHeaders(this.currentResponseBookmark),
        );
    }

    /**
     * The CDC cursor a just-committed plain mutation landed at — the post-write
     * high-watermark, on the same scale as the `cursor` on `data`/`delta` frames.
     * The client drops a pending per-call optimistic overlay once it sees a frame
     * with `cursor >= commitCursor` (gapless reconciliation that keeps mutations
     * concurrent, without the serialized custom-mutator watermark). Scoped to a
     * mutation (carries an `x-lunora-mutation-id`) on a CDC-enabled shard;
     * `undefined` otherwise, leaving the wire byte-identical for queries/actions
     * and CDC-off shards.
     */
    protected mutationCommitCursor(): number | undefined {
        return this.currentRequestMutationId === undefined ? undefined : this.currentCdcCursor();
    }

    /**
     * Build the success response for a dispatched RPC. A `"next"` custom-mutator
     * push echoes the applied `lastMutationId` so the client drops the pending
     * optimistic overlay as soon as the ack lands; a plain mutation echoes
     * `commitCursor` (see {@link mutationCommitCursor}); other calls return the
     * bare `{ result }` envelope unchanged.
     */
    protected buildDispatchResponse(mutatorClass: ClientMutationClass | undefined, result: unknown): Response {
        if (mutatorClass?.kind === "next") {
            return jsonResponse({ lastMutationId: this.currentRequestClientSeq, result }, 200, bookmarkHeaders(this.currentResponseBookmark));
        }

        const commitCursor = this.mutationCommitCursor();

        return jsonResponse(commitCursor === undefined ? { result } : { commitCursor, result }, 200, bookmarkHeaders(this.currentResponseBookmark));
    }

    /**
     * Commit a mutation's replay bookkeeping — the `(identity, mutationId)`
     * idempotency dedup row and, for a `"next"` custom-mutator push, the
     * `__client_watermark` advance — INSIDE the handler's transaction. Called by
     * the generated `handleRpc` mutation branch after the user handler resolves
     * but before the transaction commits, so the writes, the dedup row, and the
     * watermark land in one atomic commit: a crash can't leave the writes durable
     * without the replay guard (which a re-dispatch would otherwise re-run) nor
     * without the watermark. Records {@link ShardDO.mutationBookkeeping} under this
     * dispatch's mutation id so `fetch` skips the redundant post-dispatch persist.
     */
    protected commitMutationBookkeeping(result: unknown): void {
        this.persistIdempotentResult(result);

        // Strict: a watermark write that throws here rolls the whole mutation back
        // rather than committing writes whose watermark was never advanced.
        if (this.currentMutatorClass?.kind === "next") {
            this.advanceClientMutationWatermark({ strict: true });
        }

        this.mutationBookkeeping = { mutationId: this.currentRequestMutationId };
    }

    /**
     * Best-effort replay bookkeeping for the live dispatch path, run after
     * `handleRpc` returns. A generated mutation already committed it atomically
     * inside its transaction (via {@link ShardDO.commitMutationBookkeeping}, which
     * sets the flag), so this skips. Actions/queries aren't transaction-wrapped,
     * so they record their dedup row here (a no-op without an `x-lunora-mutation-id`),
     * and a `"next"` push advances its watermark (the gap self-heals on replay).
     *
     * The skip is matched on the MUTATION ID, not on a bare "someone committed"
     * flag. A Durable Object serves concurrent `fetch`es over one instance, and
     * only mutation FUNCTIONS take the `runSerialized` gate — an action carrying an
     * `x-lunora-mutation-id` dispatches straight through. So a mutation could
     * commit its bookkeeping while such an action sat on an await, and the action's
     * tail then read the shared flag as its own, skipped its `__idempotency` write,
     * and left a client retry free to re-run the handler (a second charge, a second
     * outbound call). `currentRequestMutationId` is re-pinned from this dispatch's
     * `RequestScope` immediately above the call, so comparing against it asks the
     * question that actually matters: did MY dispatch already commit?
     *
     * The comparison can only ever be wrong in the safe direction. A sibling
     * dispatch's prologue clearing the record makes this re-run a write that is
     * idempotent by construction; nothing makes it skip a write it owes.
     */
    protected recordPostDispatchBookkeeping(result: unknown, mutatorClass: ClientMutationClass | undefined): void {
        if (this.mutationBookkeeping !== undefined && this.mutationBookkeeping.mutationId === this.currentRequestMutationId) {
            return;
        }

        this.persistIdempotentResult(result);

        if (mutatorClass?.kind === "next") {
            this.advanceClientMutationWatermark();
        }
    }

    /**
     * Advance the stored high-watermark for the in-flight custom mutator to
     * `currentRequestClientSeq` through the same `this.sql` handle. On the
     * transactional path ({@link ShardDO.commitMutationBookkeeping}, `strict`) it
     * runs inside the handler's commit, so the watermark is durable iff the writes
     * are; a failure rethrows to roll the mutation back. On the best-effort
     * cache-hit recovery path (`strict` omitted) a missing table is swallowed —
     * the replay re-runs and re-advances (the read side treats a missing row as
     * watermark 0), so the gap self-heals.
     */
    protected advanceClientMutationWatermark(options?: { strict?: boolean }): void {
        const clientId = this.currentRequestClientId;
        const seq = this.currentRequestClientSeq;

        if (clientId === undefined || seq === undefined) {
            return;
        }

        try {
            advanceClientWatermark(this.sql as SqlExec, this.currentRequestUserId ?? "", clientId, seq);
        } catch (error) {
            // On the strict (in-transaction) path, fail loudly so the mutation
            // rolls back instead of committing without its watermark.
            if (options?.strict) {
                throw error;
            }

            // Best-effort cache-hit recovery: a missing table / stub handle is
            // tolerated — the replay re-runs and re-advances.
        }
    }

    /**
     * Replay a batch of CDC changes into this shard (point-in-time recovery).
     * Schema-aware — it builds a `createShardCtxDb` writer — so the base class
     * can't implement it; the codegen-generated subclass overrides this to call
     * `applyCdcChanges(writer, args.changes)`.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected runShardApplyCdc(_args: RunShardApplyCdcArgs): Promise<RunShardApplyCdcResult> {
        return Promise.reject(new LunoraError("NOT_IMPLEMENTED", "applyCdc is not implemented in base ShardDO", { status: 500 }));
    }

    /**
     * Whether `functionPath` is a paid (`.x402({ price })`) procedure. The paywall
     * lives at the origin worker (`/_lunora/rpc`, REST, `serverQuery`), which a
     * WebSocket subscription never crosses — so the shard must refuse to seed or
     * poke a paid query itself, or it is served free. The base class has no
     * function registry, so the default is `false`; the codegen-generated
     * subclass overrides it with the real `LUNORA_FUNCTIONS` lookup.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this to consult `LUNORA_FUNCTIONS`
    protected isPaidFunction(_functionPath: string): boolean {
        return false;
    }

    /**
     * Register a subscription on the given socket. Stored via
     * `ws.serializeAttachment` so it survives hibernation.
     *
     * Returns a status so the caller can surface a structured error frame
     * when the query is paid, the cap is hit or the attachment fails to
     * serialize. We never throw out of this path — the WS hibernation API
     * treats a thrown `webSocketMessage` as a fatal-channel error.
     *
     * The `paid` refusal sits here rather than at the envelope so every
     * registration path — not only the `subscribe` frame — goes through it.
     */
    protected subscribe(ws: ShardSocketLike, subId: string, query: SubscriptionQuery): "ok" | "paid" | "serialize_failed" | "too_many" {
        if (query.functionPath !== undefined && this.isPaidFunction(query.functionPath)) {
            return "paid";
        }

        const attachment = this.readAttachment(ws);

        // Counts BOTH registries, exactly as `shapeSubscribe` does: the cap
        // bounds what one socket's attachment holds, and subs and shapes share
        // that attachment. Counting only `subs` here let a socket that
        // registered shapes first hold up to twice the ceiling.
        if (Object.keys(attachment.subs).length + Object.keys(attachment.shapes ?? {}).length >= ShardDO.MAX_SUBSCRIPTIONS_PER_SOCKET) {
            return "too_many";
        }

        attachment.subs[subId] = query;

        try {
            (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
        } catch {
            // The attachment can fail to serialize if the JSON body grows
            // past the runtime's per-socket limit. Roll back the in-memory
            // mutation so a retry has a chance to land and surface a
            // structured error to the caller.
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- `subs` is a Record keyed by dynamic subscription id; removal is the intended rollback
            delete attachment.subs[subId];

            return "serialize_failed";
        }

        return "ok";
    }

    protected unsubscribe(ws: ShardSocketLike, subId: string): void {
        const attachment = this.readAttachment(ws);

        // Capture the current query so we can roll back on serialization failure.
        const captured = attachment.subs[subId];

        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- `subs` is a Record keyed by dynamic subscription id; removal is the intended unsubscribe
        delete attachment.subs[subId];

        try {
            (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
        } catch {
            // Roll back the in-memory deletion so the subscription remains
            // intact — mirrors the subscribe() rollback path. We never throw
            // out of this path; the WS hibernation API treats a thrown
            // webSocketMessage as a fatal-channel error.
            if (captured !== undefined) {
                attachment.subs[subId] = captured;
            }

            return;
        }

        this.subMemos.get(ws)?.delete(subId);
    }

    /**
     * Register a live shape subscription on a socket — the partial-replication
     * parallel to {@link ShardDO.subscribe}. Stores the descriptor in the
     * attachment's `shapes` registry (created lazily) so it survives
     * hibernation, sharing the per-socket cap with `subs`. Returns a status the
     * caller surfaces as a structured error frame; never throws (a thrown
     * `webSocketMessage` is a fatal-channel error under the hibernation API).
     */
    protected shapeSubscribe(ws: ShardSocketLike, subId: string, shape: ShapeSubscriptionQuery): "ok" | "serialize_failed" | "too_many" {
        const attachment = this.readAttachment(ws);
        const shapes = attachment.shapes ?? {};

        if (Object.keys(attachment.subs).length + Object.keys(shapes).length >= ShardDO.MAX_SUBSCRIPTIONS_PER_SOCKET) {
            return "too_many";
        }

        shapes[subId] = shape;
        attachment.shapes = shapes;

        try {
            (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
        } catch {
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- `shapes` is a Record keyed by dynamic subscription id; removal is the intended rollback
            delete attachment.shapes[subId];

            return "serialize_failed";
        }

        return "ok";
    }

    /** Remove a shape subscription and its poke baseline. Mirrors {@link ShardDO.unsubscribe}'s rollback-on-serialize-failure contract. */
    protected shapeUnsubscribe(ws: ShardSocketLike, subId: string): void {
        const attachment = this.readAttachment(ws);
        const { shapes } = attachment;

        if (!shapes) {
            return;
        }

        const captured = shapes[subId];

        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- `shapes` is a Record keyed by dynamic subscription id; removal is the intended unsubscribe
        delete shapes[subId];

        try {
            (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
        } catch {
            if (captured !== undefined) {
                shapes[subId] = captured;
            }

            return;
        }

        this.shapeMemos.get(ws)?.delete(subId);
        this.globalShapeSnapshots.get(ws)?.delete(subId);

        // Drop the durable baselines for this shape too (no-op for a
        // connection-id-less socket), so an unsubscribe doesn't leave a stale
        // snapshot/cursor a later resubscribe would diff/resume against.
        if (attachment.connectionId !== undefined) {
            try {
                deleteGlobalShapeSnapshot(this.sql as SqlExec, attachment.connectionId, subId);
            } catch {
                /* stub sql / missing table — nothing durable to clean up */
            }

            try {
                deleteShapePokeCursor(this.sql as SqlExec, attachment.connectionId, subId);
            } catch {
                /* stub sql / missing table — nothing durable to clean up */
            }
        }

        // The relayed twin of those two deletes. A socket on a RELAY registers
        // its shape in the OWNER's `__lunora_relay_shapes`, which this DO cannot
        // reach with a local DELETE — and nothing else reclaims that row until
        // the whole relay detaches, while every surviving row pins the op-log
        // retention floor (`OwnerRelay.minShapeCursor`). Fire-and-forget through
        // `waitUntil`: it is a cross-DO post, the unsubscribe must not block on
        // it, and it is a no-op on an owner.
        const released = this.relay?.releaseRelayShapes(ws, subId).catch((error: unknown) => {
            // Never reject out of here: this runs under `webSocketMessage`,
            // where a throw is a fatal-channel error. The release is
            // best-effort anyway — a dropped frame leaves the registration to
            // the coarser detach/full-drain reclamation.
            // eslint-disable-next-line no-console -- server-side diagnostic for a dropped relay-shape release
            console.error("[@lunora/do] relay shape release failed:", error);
        });

        if (released !== undefined) {
            this.shardHost.waitUntil?.(released);
        }
    }

    /**
     * Decide whether a single subscription is interested in a mutation
     * delta. The default implementation checks the table name, then runs a
     * shallow-equality predicate over `query.args` against `delta.row`. A
     * subscription with no `args` matches every row in the table.
     *
     * Subclasses can override this to implement range queries, joins, or
     * full-text matching — anything more elaborate than equality. When
     * `delta.row` is undefined (delete events without row data) we fall back
     * to a broadcast so subscribers know to refetch; trying to filter
     * against missing data would silently drop legitimate notifications.
     */
    // eslint-disable-next-line class-methods-use-this -- protected matching hook kept non-static so subclasses can refine subscription/delta matching
    protected matchesSubscription(query: SubscriptionQuery, delta: MutationDelta): boolean {
        if (query.table !== delta.table) {
            return false;
        }

        const { args } = query;

        if (!args) {
            return true;
        }

        const { row } = delta;

        if (!row) {
            return true;
        }

        for (const [key, expected] of Object.entries(args)) {
            if (row[key] !== expected) {
                return false;
            }
        }

        return true;
    }

    /**
     * Broadcast a mutation delta to every subscriber whose registered query
     * targets the affected table _and_ matches its args. The wire payload
     * includes the per-socket subscription id, so we serialise once per
     * `(socket, sub)` pair — but the structural delta body itself is
     * identical, so we build a payload keyed by `subId` lazily.
     */
    protected broadcastDelta(delta: MutationDelta): void {
        const sockets = this.runner.sockets();
        // Pre-stringify the immutable portion. The only per-message variation
        // is `id`, which we splice in below — cheaper than calling
        // JSON.stringify(...) for every (socket, sub) pair.
        //
        // Wire-encode first, matching every sibling outbound path
        // (`pushSubscriptionData`, poke frames, whisper, stream chunks):
        // `delta.row` is the fully-decoded document a write just applied, which
        // can carry `bigint`/`Date`/`ArrayBuffer` — a raw `JSON.stringify` drops
        // an `ArrayBuffer` to `{}` and throws outright on a `bigint`.
        //
        // `encodeWire` is STRICT where the old raw `JSON.stringify` was lossy: a
        // value the wire refuses (a `RegExp`, a class instance) used to broadcast
        // as `{}` and now throws here. That is deliberate — a subscriber silently
        // receiving `{}` for a row field is corruption it cannot detect — but it
        // IS a behaviour change for a subclass or trigger that puts such a value
        // in a row, and this runs after the write committed, so the throw
        // surfaces on an otherwise-successful mutation. Keep rows to values the
        // wire round-trips; every other outbound path already requires that.
        const deltaJson = JSON.stringify(encodeWire(delta));

        for (const ws of sockets) {
            const attachment = this.readAttachment(ws);

            // Same outbound token-expiry rule every other fan-out applies: a
            // socket whose credential lapsed must not keep receiving its user's
            // rows. This path is subclass-driven (see the README's `broadcast`
            // hook), so nothing upstream of it has already checked.
            if (isIdentityExpired(attachment.expiresAt)) {
                this.dropExpiredSocket(ws);

                continue;
            }

            // `Object.keys`, not `Object.entries`: this runs once per socket for
            // every mutation, and `entries` allocates a pair array per socket
            // before any subscription has been tested — so sockets that match
            // nothing pay the same as sockets that do.
            //
            // NOT `for...in`: it walks inherited enumerable keys, where
            // `Object.entries` was own-only. See the "never inherited ones" test.
            const { subs } = attachment;

            for (const subId of Object.keys(subs)) {
                const query = subs[subId];

                if (query === undefined || !this.matchesSubscription(query, delta)) {
                    continue;
                }

                // Delivery is best-effort here (legacy broadcast path has no diff
                // baseline to protect), so the boolean is intentionally ignored.
                trySendFrame(ws, `{"type":"delta","id":${JSON.stringify(subId)},"delta":${deltaJson}}`);
            }
        }
    }

    /**
     * Re-run a subscription's query and return its current result alongside
     * the set of tables it read. The base class can't dispatch user functions,
     * so it returns `null` — the codegen-generated subclass overrides this to
     * run the handler from the project's function registry. Returning `null`
     * disables server re-execution and leaves the legacy `broadcastDelta`
     * path as the only live-update mechanism.
     *
     * `identity` is the EXPLICIT subscriber identity the query runs under. It
     * is passed by value (anonymous by default — see {@link SubscriptionIdentity})
     * and forwarded straight into the codegen subclass's `buildCtx`, so a
     * subscription re-run never reads or mutates the shared, per-request
     * `currentRequestUserId`/`currentRequestIdentity` instance fields from a
     * deferred (`waitUntil`) or concurrently-interleaved context.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to dispatch via the generated function map
    protected executeSubscription(
        _functionPath: string,
        _args: Record<string, unknown>,
        _identity?: SubscriptionIdentity,
    ): Promise<SubscriptionOutcome | null> {
        // eslint-disable-next-line unicorn/no-null -- base default: `null` = "no such subscription"; the codegen subclass overrides and also returns null
        return Promise.resolve(null);
    }

    /**
     * Resolve a named shape to its concrete query plan for `identity`. The base
     * class has no shape registry, so it returns `undefined` — partial
     * replication is disabled and a `shape_subscribe` is rejected. The
     * codegen-generated subclass overrides this to look the shape up in the
     * project's `defineShape` registry, evaluate its `where(ctx, args)` under the
     * subscriber's verified identity, and AND-compose it with the table's RLS
     * read base-where into {@link ResolvedShape.effectiveWhere}.
     *
     * `identity` is the socket's OWN verified identity (the same unforgeable
     * value `refreshSubscriptions` threads), passed by value so this never reads
     * the mutable per-request identity fields. Returning `undefined` is the
     * fail-closed signal — an unknown shape, or an RLS-required table with no
     * policy resolving for this identity, yields no subscription rather than
     * leaking rows.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to dispatch via the generated shape registry
    protected resolveShape(_name: string, _args: Record<string, unknown>, _identity?: SubscriptionIdentity): ResolvedShape | undefined {
        return undefined;
    }

    /**
     * The RLS-uniform gate (plan 075 Phase 3): whether a reactive shape may be
     * relay-multicast — i.e. one delta is correct for **every** subscriber. The owner
     * decides it (see {@link OwnerRelay.isShapeRelayUniform} — a static RLS read-policy
     * guard plus claim-exhaustive `Proxy` probes, fail-closed); this thin delegation
     * is the seam the gate test exercises. A non-owner DO is never relay-uniform.
     */
    protected isShapeRelayUniform(name: string, args: Record<string, unknown>): boolean {
        return this.relay?.isShapeRelayUniform(name, args) ?? false;
    }

    /**
     * Read the FULL current membership of a `.global()`-table shape from its D1
     * (or Hyperdrive) backend — the seed/poll source for the latency-tiered
     * global shape path. A `.global()` table lives in another store with no
     * per-DO op-log, so this is the only way to learn its rows from inside the
     * shard DO; {@link ShardDO.seedGlobalShape} calls it once on subscribe and
     * {@link ShardDO.refreshGlobalShape} on every alarm tick, diffing the result
     * against the per-socket snapshot to compute the poke.
     *
     * The base class has no global backend, so it returns `[]` (a base-only DO,
     * or a project with no global tables, never resolves a global shape). The
     * codegen subclass overrides it to drain `globalDb.findMany(table, { where:
     * effectiveWhere })` under the socket's verified `identity` — the same
     * unforgeable value `resolveShape` composed the RLS predicate with, so the
     * D1 read is identity-scoped exactly like the poke-live path.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this to read the global (D1) backend; the base has none
    protected readGlobalShapeRows(_resolved: ResolvedShape, _identity?: SubscriptionIdentity): Promise<ShapeRow[]> {
        return Promise.resolve([]);
    }

    /**
     * Poll external-source (`.source(...)`) tables once (plan 077): materialize
     * each sourced table's freshly-pulled tenant slice into this DO's SQLite. The
     * base `ShardDO` has no sourced tables, so it returns `undefined` and the
     * ingest tier stays dormant — zero behavior change for every existing DO. The
     * codegen subclass overrides it to, per sourced table, build a
     * `createShardCtxDb` writer, read the tenant slice from Hyperdrive under this
     * DO's shard key, and run `runExternalSourceTick` (read local baseline → diff
     * → apply via the validated CDC writer).
     *
     * Returns the EARLIEST next-due timestamp (absolute epoch ms) across every
     * non-manual sourced table — `polledAt.get(table) ?? now` plus that source's
     * `refresh.everyMs` — or `undefined` when every sourced table is
     * `refresh: "manual"` (or there are none). NOT a bare active count: the
     * shared poll alarm ({@link ShardDO.alarm}) uses this to re-arm at the exact
     * next time ingest needs to run, instead of spinning at the fixed
     * `GLOBAL_SHAPE_POLL_INTERVAL_MS` floor for a source whose `refresh.everyMs`
     * is, say, an hour away.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass implements the real Hyperdrive-backed poll, and is the only consumer of `_trace`
    protected pollExternalSources(_trace?: TraceRefLike): Promise<number | undefined> {
        return Promise.resolve(undefined);
    }

    /**
     * Arm the shared poll alarm for external-source ingest (plan 077). The alarm is
     * shared with the global-shape poll tier; the codegen subclass calls this once
     * (on construction / first sourced write) so a sourced DO starts its ingest
     * loop, after which {@link ShardDO.alarm} re-arms itself while
     * {@link ShardDO.pollExternalSources} reports remaining work. Idempotent; a
     * no-op when the runtime exposes no `setAlarm` (unit harness).
     */
    protected scheduleSourcePoll(): Promise<void> {
        return this.scheduleGlobalPoll();
    }

    /**
     * The resolved TTL policies (`.ttl(field, { after })`) for this DO's schema —
     * one {@link TtlSweepSpec} per table that declares a TTL. The base `ShardDO`
     * has no schema, so it returns `[]` and the TTL tier stays dormant. The
     * codegen subclass overrides it to read each table's `ttlPolicy` (+ its
     * `.softDelete()` marker) off the imported schema.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass reads the imported schema
    protected ttlSweeps(): ReadonlyArray<TtlSweepSpec> {
        return [];
    }

    /**
     * Sweep every `.ttl()` table once: page the rows past their expiry and remove
     * each THROUGH the schema-aware writer (`runShardWrite`) so companions
     * / CDC / live subscriptions stay correct and a `.softDelete()` table soft-deletes
     * instead of physically removing the row. Work is bounded per tick
     * ({@link TTL_SWEEP_BATCH} × {@link TTL_SWEEP_MAX_BATCHES}) so a large backlog
     * drains across several alarms without stalling the shard.
     *
     * Returns the next-due timestamp (a coarse {@link TTL_SWEEP_INTERVAL_MS}
     * cadence, so freshly-written rows expire within a bounded window) while any
     * TTL table exists, or `undefined` when there are none — so a DO with no TTL
     * table never arms this tier.
     *
     * One {@link ShardDO.alarmHeadroom} tracker covers the WHOLE sweep pass (every
     * spec, every batch) — not per-row or per-spec — because the ceiling exists to
     * bound one alarm tick's total isolate cost, not any single table's. A
     * `TRANSACTION_LIMIT_EXCEEDED` mid-batch is "batch full", not a genuine
     * failure: `selectExpiredIds` never re-selects an already-deleted row, so
     * deletion IS the resumable checkpoint here — no separate cursor is needed.
     * The sweep stops immediately, logs a `warn` (not `recordShapeError`, which
     * would surface as a genuine failure), and returns `Date.now()` so the shared
     * alarm re-arms promptly via `nextPollAlarmTarget`'s existing due-now floor,
     * rather than waiting out the full `TTL_SWEEP_INTERVAL_MS` cadence.
     */
    protected async pollTtlSweeps(trace?: TraceRefLike): Promise<number | undefined> {
        const specs = this.ttlSweeps();

        if (specs.length === 0) {
            return undefined;
        }

        const sql = this.sql as SqlExec;
        const now = Date.now();
        const headroom = this.alarmHeadroom();

        for (const spec of specs) {
            let batches = 0;
            let hasMore = true;

            while (hasMore && batches < TTL_SWEEP_MAX_BATCHES) {
                const page = selectExpiredIds(sql, spec, now, TTL_SWEEP_BATCH);

                for (const id of page.ids) {
                    // eslint-disable-next-line no-await-in-loop -- per-row writer deletes must serialise to avoid OCC contention on the shard DO (same reasoning as `runShardBulkRowOp`)
                    const limitHit = await this.deleteExpiredTtlRow(spec.table, id, headroom, trace);

                    if (limitHit) {
                        return Date.now();
                    }
                }

                hasMore = page.hasMore;
                batches += 1;
            }
        }

        return now + TTL_SWEEP_INTERVAL_MS;
    }

    /**
     * Arm the shared poll alarm for the TTL sweep. Mirrors {@link scheduleSourcePoll};
     * the codegen subclass calls it once on construction when the schema declares a
     * `.ttl()` table so the sweep loop starts, after which {@link ShardDO.alarm}
     * re-arms itself. Idempotent; a no-op when the runtime exposes no `setAlarm`.
     */
    protected scheduleTtlSweep(): Promise<void> {
        return this.scheduleGlobalPoll();
    }

    /** This DO's shard key (its DO name), or `__root__` for the single-DO default. The `tenantBy` mapper binds it into the source query. */
    protected currentShardKey(): string {
        return this.runner.shardKey ?? ROOT_SHARD_NAME;
    }

    /**
     * Run the once-per-instance shard init — clear `.memory()` tables, then fire
     * every `onShardInit` hook — before the caller's dispatch proceeds.
     *
     * **Why this lives in the base class and is awaited at every entry point.**
     * A memory table is emptied by the eviction that dropped this instance's
     * heap, and the init hooks are what refill it. Any dispatch that reached user
     * code before they finished would read a silently empty table — not an error,
     * just wrong data — which is the single hazard `.memory()` carries. Putting
     * the gate on `fetch` / `webSocketMessage` / `webSocketClose` / `alarm`
     * means a new dispatch path cannot forget it: there is no fifth way into this
     * object from the runtime.
     *
     * Memoized as a PROMISE, not a boolean: concurrent entries (an alarm racing
     * an RPC on a freshly-woken shard) must all wait on the same run rather than
     * each starting their own. The field lives on the instance, so it is absent
     * exactly when the heap was dropped — the same signal `ensureMigrated` uses.
     *
     * A failure is absorbed here, deliberately: an init hook that cannot rebuild
     * presence must not take down the request that woke the shard. Absorbing also
     * keeps the memo from caching a rejected promise, which would turn one bad
     * init into a permanently broken instance.
     *
     * What the shard is left holding depends on WHERE it failed, and neither state
     * is "empty" by default — a memory table's rows sit in SQLite until
     * `clearMemoryTables` deletes them, so an eviction alone does not remove them:
     *
     * - **After the clear** (a hook threw) — the tables are cleared but not
     * refilled, so reads see nothing. The safe direction.
     * - **Before or during the clear** (`ensureMigrated` or `clearMemoryTables`
     * itself threw) — the PREVIOUS instance's rows are still there, so reads see
     * stale presence rather than none. The worse of the two, and the reason the
     * error is recorded rather than swallowed.
     */
    protected async ensureShardInit(): Promise<void> {
        this.shardInitOnce ??= this.runShardInit().catch((error: unknown) => {
            this.recordShardInitError("__shard_init__", error);
        });

        await this.shardInitOnce;
    }

    /**
     * The shard-init body. A no-op here; the generated subclass overrides it to
     * clear the schema's `.memory()` tables and dispatch the `onShardInit`
     * manifest. Kept as a seam (rather than the base reaching for a schema it
     * does not have) for the same reason `pollExternalSources` is one.
     * @returns a promise that settles when init is complete.
     */
    // eslint-disable-next-line class-methods-use-this -- a seam: the base has no schema to clear, the generated subclass overrides
    protected async runShardInit(): Promise<void> {
        await Promise.resolve();
    }

    /**
     * Record a contained `onShardInit` failure into the log ring. Mirrors
     * {@link ShardDO.recordExternalSourceError}: the generated override needs to
     * write this line and the log ring is private, so the seam keeps the buffer
     * encapsulated. `hookPath` is the failing hook's function path, or
     * `__shard_init__` when the failure was outside any single hook.
     */
    protected recordShardInitError(hookPath: string, error: unknown, trace?: TraceRefLike): void {
        this.recordShapeError(`init:${hookPath}`, error, trace);
    }

    /**
     * Record a contained external-source ingest failure (one sourced table's
     * poll) into the log ring without aborting the others.
     *
     * `trace` is the alarm's anchor, forwarded by the generated
     * `pollExternalSources` override from the value it was handed. Optional so a
     * subclass generated before this parameter existed still compiles and simply
     * records an uncorrelated line.
     */
    protected recordExternalSourceError(table: string, error: unknown, trace?: TraceRefLike): void {
        this.recordShapeError(`source:${table}`, error, trace);
    }

    /**
     * Record a contained external-source BACK-OFF — a transaction-limit hit
     * mid-batch, which is "batch full" rather than a failure, so it lands at
     * `warn` and does NOT group as an Issue the way
     * {@link ShardDO.recordExternalSourceError} does.
     *
     * Exists because the generated poll loop needs to write this line and the log
     * ring is private: emitting `this.logs.push(...)` into the subclass does not
     * compile, which went unnoticed only because no fixture or example declares a
     * `.source()` table. A protected seam keeps the buffer encapsulated and gives
     * the line the same trace correlation as its sibling above.
     */
    protected recordExternalSourceWarning(table: string, message: string, trace?: TraceRefLike): void {
        this.logs.push({
            functionPath: `source:${table}`,
            level: "warn",
            message,
            timestamp: Date.now(),
            traceId: trace?.traceId,
        });
    }

    /* eslint-disable no-secrets/no-secrets -- JSDoc names the `AsyncIterable<unknown>` type, not a credential */

    /**
     * Look up a streaming-query function and return a thunk that produces the
     * `AsyncIterable<unknown>` when handed an {@link AbortSignal}. The codegen
     * subclass overrides this to dispatch via `LUNORA_FUNCTIONS`; the base
     * default returns `null`, which surfaces as `{type:"error", code:"NOT_FOUND"}`
     * to the client.
     *
     * The deferred-iterator shape (`(signal) => AsyncIterable<unknown>`) keeps
     * the cancel signal pluggable per-call without coupling this signature to
     * the wire-frame loop in `handleStream`.
     *
     * `identity` is the socket's verified identity, threaded BY VALUE exactly as
     * {@link ShardDO.executeSubscription} threads it and for the same reason: a
     * `stream` frame is dispatched fire-and-forget and its iterator is pulled
     * long after, interleaved with unrelated `/rpc` dispatches, so reading the
     * shared per-request identity fields instead would run an `rls()` /
     * `ctx.auth`-scoped stream as nobody while the shard is idle — and as
     * whoever else is mid-flight while it is not.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to dispatch via the generated function map
    protected executeStream(
        _functionPath: string,
        _args: Record<string, unknown>,
        _identity?: SubscriptionIdentity,
    ): null | { durable?: { ttlMs?: number }; iterator: (signal: AbortSignal) => AsyncIterable<unknown> } {
        // eslint-disable-next-line unicorn/no-null -- base default: `null` = "no such streaming function"; the codegen subclass overrides and also returns null
        return null;
    }

    /* eslint-enable no-secrets/no-secrets */

    /**
     * Wrap a query handler in the reactive cache. The `/rpc` dispatch path calls
     * this for every path {@link ShardDO.isQueryFunction} recognises, so a
     * subclass does NOT wrap its own `handleRpc` — see the re-entry guard below
     * for why doing both would be worse than doing neither. When the cache is
     * configured we key by `(identity, functionPath, stable-stringified args)`,
     * mint a fresh {@link QueryReadScope} (dep tracker + read footprint) and
     * hand it to `run` — which threads it through `handleRpc` into the ctx the
     * handler reads through, so this dispatch's reads stamp THIS dispatch's
     * tracker even while a sibling dispatch is parked on an await. When the
     * cache is absent we just call `run()` with no scope — same shape, zero
     * overhead.
     *
     * Subclasses must ALSO pass `getCtxDbReadHook(scope)` as the `onRead`
     * option on their `createShardCtxDb(...)` call so the tracker actually
     * collects deps. Without that wiring the cache memoizes results with empty
     * dep sets, so the write hooks never invalidate them — the
     * {@link ReactiveCache} class is contract-neutral about who fills `deps`,
     * and dep-less entries survive `invalidate` AND `invalidateTable` alike, so
     * neither the ctx-db hooks nor the {@link ShardDO.recordChangedTable}
     * backstop can rescue that omission.
     *
     * The scope's {@link ReadFootprint} is the ranges channel:
     * `getCtxDbReadRangeHook(scope)` — and the range-marking half of
     * `getCtxDbReadHook(scope)` — stamp it. Its
     * `ranges()` is handed to `reactiveCache.run` as a LAZY 4th argument (a
     * thunk, evaluated only after `run()` resolves), the same deferral
     * `deps` already relies on: the footprint is only complete once the
     * handler has actually run. Subclasses that also want range-precise
     * invalidation should pass `getCtxDbReadRangeHook(scope)` as `onReadRange`
     * on the same `createShardCtxDb(...)` call — mirroring `onRead` above. A
     * subclass that only wires `onRead` still works: `ranges()` degrades to
     * `undefined` and every read is treated as a whole-table dependency, per
     * `ReactiveCache.run`'s own default. When `onReadRange` IS wired, a table
     * `footprint.ranges()` could not narrow (any by-id/scan read, or a
     * provable range mixed with one) still falls back to a whole-table
     * `SCAN_DEP`, stamped after `run()` resolves — see the fallback in this
     * method's body. Only a table read EXCLUSIVELY through provable ranges
     * gets range-precise invalidation instead.
     */
    protected async runCachedQuery<R>(
        functionPath: string,
        args: Record<string, unknown>,
        run: (scope?: QueryReadScope) => Promise<R>,
        attribution?: QueryAttribution,
        outer?: QueryReadScope,
    ): Promise<R> {
        if (!this.reactiveCache) {
            return run();
        }

        // Already inside a cached query — a nested `ctx.runQuery`, or a subclass
        // that wraps its own dispatch under the base one. Such a caller threads
        // the scope it was handed as `outer`, and we pass straight through ON
        // THAT SCOPE. Memoizing here would be actively wrong, not merely
        // redundant: the inner call would build its own ctx off its own scope, so
        // every read the handler makes from that point lands in the INNER dep set
        // and the outer entry is stored with no deps at all — permanently
        // un-invalidatable stale data. Passing `outer` back keeps the reads
        // landing where they belong.
        //
        // Note this is a per-CALL signal, not instance state: two independent
        // concurrent dispatches each mint their own scope below and neither sees
        // the other, which is the whole point of threading it.
        if (outer) {
            return run(outer);
        }

        const tracker = createDependencyTracker();
        const footprint = createReadFootprint();
        const scope: QueryReadScope = { footprint, tracker };

        // Detect a cache hit cheaply by diffing the cache's lifetime hit
        // counter across the `run` call — a hit means the callback (and thus
        // the dep stamps) never ran, so the read set comes from the cached
        // entry's own deps, not this tracker. The request log reads both fields
        // afterwards; capturing them here keeps the dispatch site oblivious to
        // whether the cache is even enabled.
        const hitsBefore = this.reactiveCache.stats().hits;

        // Scope the cache entry to the caller's FULL identity — userId AND the
        // identity claims (active-org/role/tenant) that RLS can key on — so a
        // per-request claim that varies while userId stays constant never
        // memoizes one context's rows for another caller sharing the same DO.
        // An anonymous request (no userId, no claims) collapses to the `null`
        // bucket. `stableStringify` canonicalizes key order, so equal identities
        // yield equal discriminators (same guarantee the args encoding relies on).
        const userId = this.getCurrentUserId();
        const claims = this.getCurrentIdentity();
        const identity =
            userId === undefined && claims === undefined
                ? // eslint-disable-next-line unicorn/no-null -- reactiveCacheKey's identity arg is `null | string`; null is the documented "anonymous caller" discriminator
                  null
                : // eslint-disable-next-line unicorn/no-null -- fold userId/claims into the discriminator; missing fields serialize as null so the shape stays canonical
                  stableStringify({ claims: claims ?? null, userId: userId ?? null });

        // Wraps `run` so that, once the handler has actually executed and the
        // footprint is final, every table it touched that `footprint.ranges()`
        // could NOT narrow gets a whole-table `SCAN_DEP` stamped into the same
        // tracker `deps` set the cache indexes by — mirroring the whole-table
        // fallback `executeSubscription` gets for free from `footprint.tables`
        // (see `writeTouchesMemo` in `subscription-range-gate.ts`, which treats
        // any table in a subscription's memo without a narrowed range as
        // "assume touched"). Two reads land here: a table read only through an
        // unprovable path (scan / by-id), which the tracker already deps via
        // `getCtxDbReadHook`, and — the gap this closes — a table read through
        // BOTH a provable range (`onReadRange`, deps nothing on its own) AND a
        // by-id read (`onRead`, which marks the table unnarrowable so
        // `ReadFootprint.ranges()` drops its slices). That mix used to leave
        // the cache entry with deps `{table:id}` and ranges `[]`: an insert of
        // a NEW row into the range matched neither and the stale entry
        // survived. A table `ranges()` DID narrow is deliberately left alone —
        // adding a fallback there would defeat the range-precise invalidation
        // this cache exists to provide. This does not touch `ReadFootprint`'s
        // unnarrowable semantics (which subscriptions also rely on); it only
        // changes what `runCachedQuery` derives FROM that footprint.
        //
        // Ordering relies on `ReactiveCache.run`'s own contract: it awaits
        // `run()` in full, THEN calls the `ranges` thunk, and only THEN reads
        // `deps` to index the entry. `tracker.collect()` below hands the cache
        // a live `Set` reference, so stamping it here — after the real
        // handler resolved but before either later step — lands in time.
        const runWithRangeFallback = async (): Promise<R> => {
            const result = await run(scope);
            const narrowed = footprint.ranges();

            for (const table of footprint.tables) {
                if (!narrowed?.has(table)) {
                    tracker.recordRead(table, SCAN_DEP);
                }
            }

            return result;
        };

        const result = await this.reactiveCache.run(reactiveCacheKey(functionPath, args, identity), tracker.collect(), runWithRangeFallback, () =>
            flattenReadRanges(footprint.ranges()),
        );

        if (attribution) {
            // `attribution` is an out-parameter by design — the per-dispatch
            // sink `beginDispatch` minted and the dispatch tail reads back.
            Object.assign(attribution, { cacheHit: this.reactiveCache.stats().hits > hitsBefore, readTables: tablesFromDeps(tracker.collect()) });
        }

        return result;
    }

    /**
     * Returns an `onRead` callback suitable to hand to `createShardCtxDb`'s
     * `onRead` option, BOUND to the dispatch whose {@link QueryReadScope} is
     * passed in. `runCachedQuery` mints that scope and threads it through
     * `handleRpc`; a dispatch with no cache scope (a mutation, an action, a
     * cache-less shard) passes nothing and gets a hook that stamps no deps — so
     * subclasses can wire this hook unconditionally without checking whether
     * the cache is enabled.
     *
     * It ALSO records the table into {@link currentScannedTables} whenever the
     * read was a full-table scan (the `SCAN_DEP` sentinel), scope or no scope.
     * That set is drained into `recordFunctionCall` after dispatch to build the
     * durable per-function full-scan attribution — unlike the tracker, it's
     * collected even when the reactive cache is off, since the causal signal is
     * independent of caching.
     *
     * It ALSO marks the table unnarrowable on the scope's `footprint`,
     * mirroring `executeSubscription`'s wiring (which hands a single
     * `ReadFootprint`'s `onRead`/`onReadRange` pair straight to `buildCtx`).
     * `ctx-db.ts`'s reader calls this `onRead` and `onReadRange` mutually
     * exclusively per read — a provable index slice fires ONLY `onReadRange`,
     * everything else (by-id, scan, an unprovable slice) fires ONLY this
     * `onRead` — so folding the footprint's `onRead` in here is exactly the
     * "read this table outside a range" signal {@link ReadFootprint.ranges}
     * needs to drop that table from the narrowed set.
     */
    protected getCtxDbReadHook(scope?: QueryReadScope): (table: string, idOrScan?: string) => void {
        return (table, idOrScan) => {
            scope?.tracker.recordRead(table, idOrScan ?? SCAN_DEP);
            scope?.footprint.onRead(table, idOrScan ?? SCAN_DEP);

            // Attribute a scan ONLY on the explicit `SCAN_DEP` sentinel. A
            // predicated (indexed) `findMany` calls `onRead(table)` with no id
            // marker BEFORE stamping its matched rows (see `ctx-db.ts`), so
            // counting `undefined` here would mis-attribute every indexed query
            // as a full scan and fabricate "missing index" insights. The cache
            // tracker above still coalesces `undefined` to `SCAN_DEP` — that is
            // a deliberately conservative invalidation choice, independent of
            // this causal signal.
            if (idOrScan === SCAN_DEP) {
                this.currentScannedTables?.add(table);
            }
        };
    }

    /**
     * Returns an `onReadRange` callback suitable to hand to
     * `createShardCtxDb`'s `onReadRange` option, alongside
     * `getCtxDbReadHook(scope)` as `onRead` on the same call — the pairing
     * `executeSubscription` already uses via `ReadFootprint`. Stamps the
     * footprint of the {@link QueryReadScope} passed in and is a no-op when
     * none is, so subclasses can wire this hook unconditionally regardless of
     * whether the cache is enabled. Without this wiring `runCachedQuery`'s
     * ranges thunk always observes an empty footprint and every cached query
     * degrades to the prior whole-table dependency — safe, just not
     * range-precise.
     */
    // eslint-disable-next-line class-methods-use-this -- symmetry with `getCtxDbReadHook`: both are the scope-binding factories a generated `buildCtx` calls
    protected getCtxDbReadRangeHook(scope?: QueryReadScope): (range: KeyRange) => void {
        return (range) => {
            scope?.footprint.onReadRange(range);
        };
    }

    /**
     * Read hook recording which declared indexes a query actually exercises.
     * Two destinations, both stamped here so a single hook serves the live and
     * durable signals. First, the in-memory `usedIndexes` set behind the
     * `unused_index` runtime advisory (reset on hibernation/restart — a "since
     * this instance woke" readout, like the function/scan counters), keyed
     * `table:index`. Second, the per-dispatch `currentIndexHits` set, drained
     * into `recordFunctionCall` so the DURABLE `__lunora_metrics_index` hit
     * counter (the advisor dead-index lint's producer) records one read per
     * distinct `(table, index)` this dispatch exercised. Passed as `onIndexUse`
     * to `createShardCtxDb` by the generated subclass.
     */
    protected getCtxDbIndexUseHook(): (table: string, indexName: string) => void {
        return (table, indexName) => {
            this.usedIndexes.add(`${table}:${indexName}`);
            // JSON-keyed so a table or index name can never alias a different
            // pair when the set is unpacked back into `{table, index}` in
            // recordFunctionCall, matching the durable __lunora_metrics_index key.
            this.currentIndexHits?.add(JSON.stringify([table, indexName]));
        };
    }

    /**
     * The `createShardCtxDb` options this DO's configuration decides, as one
     * spreadable slice: the reactive cache (invalidation half of the contract)
     * plus the two relation-resolution knobs from {@link ShardDOOptions}.
     *
     * The generated `buildCtx` spreads this FIRST into its `createShardCtxDb`
     * call, so a per-request option it sets afterwards still wins:
     *
     * ```ts
     * createShardCtxDb({ ...this.ctxDbTuning(), auth: …, schema, sql, … })
     * ```
     *
     * One accessor rather than three, because it is one decision — "how this
     * deployment configured its ctx-db" — and the emitter should not have to
     * grow a line per knob. Only keys the app actually set are present, so
     * spreading never overwrites an engine default with `undefined`.
     *
     * Handing over `cache` is what makes writes invalidate at row + index-range
     * precision (`ctx-db.ts` calls `cache.invalidate(table, id, indexKeys)` on
     * every `insert`/`patch`/`replace`/`delete`). EVERY writer the emitter builds
     * spreads this — the user-facing ctx and all three admin/maintenance writers —
     * because a writer that skips it leaves post-write reads answering from the
     * pre-write snapshot.
     *
     * Pure: it reports the slice and records nothing. Whether the emitter actually
     * wired it is a fact the emitter knows statically and declares through
     * {@link ShardDOOptions.ctxDbCacheWired}; inferring it from a call to this
     * accessor made reading the slice — in a test, or to log it — silently disarm
     * the invalidation backstop in {@link ShardDO.recordChangedTable}.
     */
    protected ctxDbTuning(): { cache?: ReactiveCache; maxRelationKeys?: number; relationExistsPushDown?: "always" | "auto" | "never" } {
        return {
            ...this.ctxDbRelationOptions,
            ...(this.reactiveCache === undefined ? {} : { cache: this.reactiveCache }),
        };
    }

    /**
     * Whether `functionPath` names a registered `query` — the only kind whose
     * result may be memoized by the reactive cache.
     *
     * The base class has no function registry, so the default is `false`: the
     * conservative answer, since caching an `action` would skip its outbound
     * side effects on a hit and caching a `mutation` is meaningless. The
     * codegen-generated subclass overrides it with the real `LUNORA_FUNCTIONS`
     * lookup, which is what production dispatch uses.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this to consult `LUNORA_FUNCTIONS`
    protected isQueryFunction(_functionPath: string): boolean {
        return false;
    }

    /**
     * Ceilings for one transaction. The base class uses the engine defaults
     * (sized for a 128 MiB Durable Object isolate); a subclass overrides this
     * to raise them for a deployment that genuinely needs bigger transactions.
     */
    // eslint-disable-next-line class-methods-use-this -- override seam; the base answer is deliberately constant
    protected transactionLimits(): Partial<TransactionLimits> {
        return {};
    }

    /**
     * A fresh budget for a dispatch that brought none of its own.
     *
     * This used to hand back an INSTANCE FIELD stamped by `beginDispatch` — "the
     * meter of whichever `/rpc` is in flight". Nothing that reaches it is that
     * dispatch: the `/rpc` path value-threads its own tracker into `handleRpc`
     * and never consults this. What reached it were the out-of-band callers —
     * `dispatchLifecycle`'s `onConnect`/`onDisconnect` hooks, `handleRunAs`, the
     * admin `runShardWrite` behind the studio's row editor — which either
     * charged their writes to an unrelated in-flight mutation's budget (failing
     * one of the two with a ceiling neither caused) or, with no dispatch in
     * flight, ran completely unmetered.
     *
     * So: mint one, the same by-value answer {@link ShardDO.subscriptionHeadroom}
     * and {@link ShardDO.alarmHeadroom} give their own out-of-band callers, and
     * for the same reason — an ambient field says "a dispatch is in flight", not
     * "this caller is that dispatch".
     */
    protected transactionHeadroom(): TransactionHeadroomTracker {
        return new TransactionHeadroomTracker(this.transactionLimits());
    }

    /**
     * A fresh budget for one deferred subscription re-run.
     *
     * The re-run is dispatched from inside the WRITING request's `try` and may
     * outlive it via `waitUntil`, so it must not spend the mutation's budget:
     * metering reader work against writer budget would trip the ceiling and
     * surface as `refreshOne`'s swallowed catch, silently dropping a live
     * update.
     *
     * Handed to `buildCtx` BY VALUE from the generated `executeSubscription`,
     * the same way {@link SubscriptionIdentity} is threaded — deliberately not
     * signalled through an instance flag. A flag would say "a refresh is in
     * flight", not "this caller is the refresh", and the drain runs in the
     * background: a concurrent `/rpc` dispatch building its `ctx.db` during the
     * drain would take the refresh branch and lose its own ceiling entirely.
     */
    protected subscriptionHeadroom(): TransactionHeadroomTracker {
        return new TransactionHeadroomTracker(this.transactionLimits());
    }

    /**
     * A fresh budget for one alarm-driven work item — one external-source
     * table's tick, or one TTL sweep pass.
     *
     * Alarm work runs with no client waiting and no `/rpc` dispatch in flight,
     * so `transactionHeadroom()`'s per-dispatch tracker is `undefined` there —
     * leaving external-source ingest and TTL sweeps completely unmetered, the
     * exact isolate-exhaustion class the meter exists to bound. Handed to the
     * writer BY VALUE, the same pattern as `subscriptionHeadroom()` and for the
     * same reason: an ambient instance-field flag would race a concurrently
     * in-flight `/rpc` dispatch, or a sibling alarm work item, clearing or
     * substituting the wrong tracker mid-flight.
     */
    protected alarmHeadroom(): TransactionHeadroomTracker {
        return new TransactionHeadroomTracker(this.transactionLimits());
    }

    /**
     * Record that `table` was written during the current RPC. Wired into the
     * db adapter's `broadcast` callback by the generated subclass so that
     * `flushChangedTables` can re-run only the affected subscriptions.
     */
    protected recordChangedTable(table: string, indexKeys?: ReadonlyArray<IndexKeyEntry>): void {
        this.pendingChangedTables ??= new Set<string>();
        this.pendingChangedTables.add(table);
        this.pendingChangedKeys = recordChangedKeys(this.pendingChangedKeys, table, indexKeys);

        // Backstop for a subclass whose `createShardCtxDb` call never took
        // `ctxDbTuning()`'s `cache`: without it nothing would invalidate, and the
        // reactive cache would answer post-write reads from the pre-write
        // snapshot. This signal has no row id, so it can only be table-wide —
        // coarser than the wired path, never wronger. Runs before the delta
        // broadcast (this IS the broadcast hook), so a subscriber re-running its
        // query already sees the post-write state.
        if (!this.ctxDbCacheWired) {
            this.reactiveCache?.invalidateTable(table);
        }
    }

    /**
     * Per-batch progress hook for the codegen subclass's data-migration runner
     * (wired via `runDataMigration`'s `onBatch`). The runner persists progress to
     * the reserved {@link DATA_MIGRATION_STATE_TABLE} through raw SQL the
     * change-tracker can't observe, so record that table here and flush — that's
     * what re-runs live `migrationStatus` subscribers mid-run. Centralised in the
     * base class so subclasses don't have to remember the record-then-flush dance.
     */
    protected async flushMigrationProgress(): Promise<void> {
        this.recordChangedTable(DATA_MIGRATION_STATE_TABLE);
        await this.flushChangedTables();
    }

    /**
     * Record one `ctx.log.*` call from a handler. Invoked by the generated
     * `buildCtx` logger closure, which supplies the executing `functionPath` and
     * the sink resolved from `createShardDO({ observability })` (if any).
     *
     * Three destinations, each best-effort so a logging call can NEVER turn a
     * served request into a failed one. First, the in-memory {@link LogBuffer}
     * that powers the studio's live Logs panel (it resets on hibernation, like
     * the metrics counters). Second, a structured `{ source: "lunora", type:
     * "log" }` console event that rides CF Workers Logs / Logpush to prod sinks
     * and is pretty-printed by the CLI / Vite dev-server formatter in the
     * terminal. Third, the optional programmatic `sink.onLog` — the in-process
     * hook for users who route logs themselves (webhook/Sentry/etc.), mirroring
     * `onRpc`.
     *
     * Unlike request-log args, `ctx.log` args are NOT redacted: the developer
     * chose to log them, exactly like a raw `console.log`.
     */
    protected recordUserLog(
        functionPath: string,
        level: ContextLogLevel,
        args: unknown[],
        message: string,
        fields: Record<string, unknown> | undefined,
        sink?: TelemetrySink,
        eventName?: string,
        anchor?: TraceAnchor,
    ): void {
        // Correlate the line to its dispatch span. Read from the resolved anchor
        // rather than re-parsing the inbound `traceparent`, so a dispatch that
        // MINTED its ids (no inbound context — a subscription re-run, an alarm, a
        // server-initiated call) still correlates: re-parsing would yield
        // `undefined` there and silently split a handler's logs from its spans,
        // which is exactly what the docs promise doesn't happen.
        //
        // An explicit `anchor` pins the trace for a caller that runs AFTER the
        // handler's awaits — the dispatch `finally` emitting the wide event —
        // where the shared field may already belong to an interleaved dispatch.
        const trace = anchor ?? this.currentRequestTrace;

        // One canonical event built once, fed to all three destinations. Only the
        // console event drops raw `args` (see emitLogEvent); the buffer and sink
        // get the full payload. Structured `fields` DO ride every destination.
        const event: LogEventInput = {
            args,
            ...(eventName === undefined ? {} : { eventName }),
            fields,
            functionPath,
            level,
            message,
            shardKey: this.runner.shardKey,
            spanId: trace?.rootSpanId,
            traceId: trace?.traceId,
            ts: Date.now(),
            userId: this.getCurrentUserId(),
        };

        this.logs.push({ fields, functionPath, level, message, timestamp: event.ts, traceId: event.traceId });

        try {
            emitLogEvent(event);
        } catch {
            // Best-effort: never let log emission fail the handler.
        }

        if (sink?.onLog) {
            try {
                // Thread the DO's `waitUntil` so a durable sink (e.g. a
                // Pipeline → R2 log sink) can keep its send alive past the
                // response; `undefined` when the state doesn't expose it, where
                // the sink falls back to fire-and-forget.
                sink.onLog(event, { waitUntil: this.shardHost.waitUntil });
            } catch {
                // A buggy log sink must not break the handler — see emitLogEvent.
            }
        }
    }

    /**
     * Build the `ctx.log` logger for one dispatched function. Each severity method
     * accepts either the structured form (`(message, fields)`) or console-style
     * varargs (see {@link parseLogArgs}); `with(fields)` returns a child that
     * stamps `fields` onto every line. The generated `buildCtx` calls this once
     * per dispatch and assigns the result to `ctx.log`.
     */
    protected makeLogger(functionPath: string, sink?: TelemetrySink, boundFields?: Record<string, unknown>): ContextLogger {
        const at =
            (level: ContextLogLevel) =>
            (...args: unknown[]): void => {
                const { fields, message } = parseLogArgs(args, boundFields);

                this.recordUserLog(functionPath, level, args, message, fields, sink);
            };

        return {
            debug: at("debug"),
            error: at("error"),
            event: (name: string, fields?: LogFields) => {
                // The event NAME is the record's message, so a plain-text log
                // viewer still shows something meaningful; the structured payload
                // is `fields`, and `eventName` is what makes a collector treat the
                // record as a queryable event rather than prose.
                this.recordUserLog(functionPath, "info", [name], name, boundFields ? { ...boundFields, ...fields } : fields, sink, name);
            },
            fatal: at("fatal"),
            info: at("info"),
            log: at("log"),
            trace: at("trace"),
            warn: at("warn"),
            with: (fields: Record<string, unknown>) => this.makeLogger(functionPath, sink, boundFields ? { ...boundFields, ...fields } : fields),
        };
    }

    /**
     * Build the `ctx.trace` span factory for one dispatched function. The
     * generated `buildCtx` calls this once per dispatch and assigns the result to
     * `ctx.trace`.
     *
     * Thin wiring over {@link createTracer}, which owns the span semantics (see
     * there for why nesting is explicit rather than ambient). Everything it needs
     * from the shard is passed explicitly.
     *
     * `anchor` is the trace this ctx's spans belong to; omit it for a ctx with no
     * owning dispatch (an alarm, a subscription re-run) to mint a fresh anchor, so
     * `ctx.trace` still yields a coherent self-contained trace there.
     *
     * The Cloudflare custom-spans bridge is threaded here but stays off unless the
     * resolved sink sets `fuseCloudflareTraces` (see {@link resolveHostTracing}).
     */
    protected makeTracer(functionPath: string, sink?: TelemetrySink, anchor?: TraceAnchor): ContextTracer {
        // Resolve the anchor once so its `sampled` verdict is snapshotted for every
        // span this tracer records — carried to `recordSpan` rather than re-looked-up
        // from `traceSampling` at span-close time, so a span that ends AFTER the
        // dispatch tore its entry down still honours the trace's sampling decision.
        const resolvedAnchor = anchor ?? resolveTraceAnchor(undefined);

        return createTracer({
            anchor: resolvedAnchor,
            // Raw span error messages/stacktraces in dev only — production
            // defaults to the same redacted posture as the request log and
            // function-metrics sinks (see `context-telemetry.ts`'s `captureRaw`).
            captureRaw: isDevEnvironment(this.env),
            fuseHostSpans: sink?.fuseCloudflareTraces === true,
            functionPath,
            record: (span) => {
                this.recordSpan(span, sink, resolvedAnchor.sampled);
            },
            resolveHostTracing,
            shardKey: this.runner.shardKey,
            userId: () => this.getCurrentUserId(),
        });
    }

    /**
     * The trace anchor a ctx's `trace` and `span` both hang off.
     *
     * Resolved once per `buildCtx` and shared, so `ctx.trace` spans and the
     * `ctx.span` wide event land in the SAME trace. Previously each consumer
     * minted its own fallback when there was no current trace, which was fine
     * while `ctx.trace` was the only consumer and silently splits the two now
     * that there are two.
     *
     * `identityScoped` marks a deferred/interleaved caller (a subscription seed
     * or refresh): those must NOT inherit the shared per-request trace, which a
     * concurrent RPC may have re-set, so they mint their own self-contained one.
     */
    protected resolveDispatchAnchor(identityScoped: boolean): TraceAnchor {
        return (identityScoped ? undefined : this.getCurrentTrace()) ?? resolveTraceAnchor(undefined);
    }

    /**
     * Wrap `ctx.db` in automatic instrumentation — see {@link instrumentDatabase}
     * for why the default is aggregate counters rather than a span per call.
     *
     * A no-op (returning the database untouched) with no sink configured or with
     * `instrumentDatabase: "off"`, so a deployment that collects nothing pays
     * nothing.
     */
    protected instrumentDb<T extends object>(database: T, functionPath: string, anchor: TraceAnchor, sink?: TelemetrySink): T {
        const mode = sink === undefined ? "off" : (sink.instrumentDatabase ?? "summary");

        if (mode === "off") {
            // Bail before touching `dispatchSpans`: with nothing collecting, the
            // tally allocation and its map insert would be per-dispatch waste on
            // the hot path (it showed up as a benchmark regression).
            return database;
        }

        return instrumentDatabase(database, {
            anchor,
            // Raw constraint-error messages in dev only — matches `makeTracer`'s
            // `captureRaw` posture.
            captureRaw: isDevEnvironment(this.env),
            functionPath,
            mode,
            record: (recorded) => {
                this.recordSpan(recorded, sink, anchor.sampled);
            },
            shardKey: this.runner.shardKey,
            // Parked on the dispatch entry rather than written through `ctx.span`:
            // the counters enrich a root span that is being recorded anyway, but
            // must never be the reason one gets recorded. Read once in
            // `recordDispatchRootSpan`, so a query pays only integer increments.
            tally: this.dispatchTally(anchor),
            userId: () => this.getCurrentUserId(),
        });
    }

    /**
     * Build `ctx.fetch` — the platform `fetch`, instrumented.
     *
     * Every outbound call becomes a CLIENT span and carries a `traceparent` to
     * the callee, so time spent waiting on someone else's service stops being an
     * unexplained gap in the waterfall and the callee's spans join this trace
     * instead of starting an unrelated one.
     *
     * Falls back to the bare global `fetch` when no sink is configured or the
     * sink opted out via `traceFetch: false` — there is no point paying for spans
     * nobody collects, and an app calling a third party it would rather not send
     * trace ids to needs a way to say so.
     */
    protected makeFetch(functionPath: string, anchor: TraceAnchor, sink?: TelemetrySink): ContextFetch {
        const base: ContextFetch = (input, init) => globalThis.fetch(input, init);

        if (sink === undefined || sink.traceFetch === false) {
            return base;
        }

        return createTracedFetch(
            {
                anchor,
                // Raw fetch error messages in dev only. A failed `ctx.fetch` throws
                // a message that embeds the request URL, query string included, and
                // spans fan out to third-party collectors — so production takes the
                // same redacted posture as `makeTracer` (see `context-telemetry.ts`).
                captureRaw: isDevEnvironment(this.env),
                functionPath,
                ...(typeof sink.traceFetch === "object" && sink.traceFetch.propagate !== undefined ? { propagate: sink.traceFetch.propagate } : {}),
                record: (span) => {
                    this.recordSpan(span, sink, anchor.sampled);
                },
                shardKey: this.runner.shardKey,
                userId: () => this.getCurrentUserId(),
            },
            base,
        );
    }

    protected makeDispatchSpan(anchor: TraceAnchor, sink?: TelemetrySink): SpanHandle {
        const spanKey = dispatchSpanKey(anchor);

        /**
         * The collector is LAZY on purpose. `buildCtx` builds `ctx.span` for every
         * dispatch, but most handlers never touch it — allocating a collector and a
         * Map entry per request for them would put pure waste on the hot path, and
         * would make `dispatchSpans.has(...)` useless as the "did this dispatch
         * record a wide event?" signal the root-span gate depends on.
         *
         * The sink IS registered eagerly (when there is one — with no sink there is
         * nothing to remember, and a dispatch that collects nothing should pay
         * nothing; this was a measured hot-path cost). It is captured here rather
         * than looked up at flush time because the dispatch `finally` that flushes
         * a batching sink has no ctx and so no way back to `config.observability`.
         */
        this.lastTelemetrySink = sink ?? this.lastTelemetrySink;

        if (sink !== undefined) {
            evictOldestEntry(this.dispatchSpans, MAX_TRACKED_DISPATCH_SPANS);
            this.dispatchSpans.set(spanKey, this.dispatchSpans.get(spanKey) ?? { sink });
        }

        const collector = (): SpanCollector => {
            evictOldestEntry(this.dispatchSpans, MAX_TRACKED_DISPATCH_SPANS);

            const entry = this.dispatchSpans.get(spanKey) ?? { sink };

            // Raw `recordException` stacktraces/messages in dev only — matches
            // `makeTracer`'s `captureRaw` posture for the wide event's collector.
            entry.collector ??= createSpanCollector({ spanId: anchor.rootSpanId, traceId: anchor.traceId }, isDevEnvironment(this.env));
            this.dispatchSpans.set(spanKey, entry);

            return entry.collector;
        };

        return {
            addEvent: (name, attributes) => {
                collector().handle.addEvent(name, attributes);
            },
            // Answerable without materializing a collector — the ids come from the
            // anchor, not from anything the handler recorded. Reading the dispatch's
            // trace id must not itself count as "this dispatch produced a wide event".
            spanContext: () => {
                return { spanId: anchor.rootSpanId, traceId: anchor.traceId };
            },
            addLink: (link) => {
                collector().handle.addLink(link);
            },
            recordEvaluation: (evaluation) => {
                collector().handle.recordEvaluation(evaluation);
            },
            recordException: (error) => {
                collector().handle.recordException(error);
            },
            setAttribute: (key, value) => {
                collector().handle.setAttribute(key, value);
            },
            setAttributes: (fields) => {
                collector().handle.setAttributes(fields);
            },
        };
    }

    /**
     * Build the `ctx.metrics` recorder for one dispatched function. Thin wiring
     * over {@link createMetrics}, which owns the instrument semantics.
     */
    protected makeMetrics(functionPath: string, sink?: TelemetrySink): ContextMetrics {
        return createMetrics({
            functionPath,
            record: (event) => {
                this.recordMetric(event, sink);
            },
            shardKey: this.runner.shardKey,
        });
    }

    /**
     * Fold one measurement into the in-memory {@link metricSeries} readout and
     * hand it to the optional `sink.onMetric`. Best-effort like
     * {@link recordUserLog} and {@link recordSpan}: recording a measurement must
     * never break the handler that recorded it.
     *
     * The buffer folds rather than rings: a measurement's value is in its
     * aggregate over a window, which a bounded ring of raw samples can't represent
     * (it evicts the oldest samples, the ones a running total needs). So the
     * buffer keeps one running aggregate per series and resets on hibernation like
     * logs and spans — a "recent metrics on this instance" dev readout. Durable,
     * cross-instance aggregation is still the sink's job.
     */
    protected recordMetric(event: MetricEvent, sink?: TelemetrySink): void {
        // Stamp the exemplar: the measurement inherits the recording dispatch's
        // trace id (when it ran inside one), so a metric point can link to a trace.
        // Owned here, not by `createMetrics` — the shard is what knows the current
        // request's trace context.
        const exemplarTraceId = this.currentRequestTrace?.traceId;
        const stamped: MetricEvent = exemplarTraceId === undefined ? event : { ...event, traceId: exemplarTraceId };

        // Every target is best-effort: recording a measurement must never break the
        // handler that recorded it (a malformed event, a SQLite write failure, a
        // buggy sink). One swallow so the policy is stated once, not per target.
        const bestEffort = (run: () => void): void => {
            try {
                run();
            } catch {
                // Telemetry is best-effort — see above.
            }
        };

        // Live in-memory fold (the "recent on this instance" readout).
        bestEffort(() => {
            this.metricSeries.push(stamped);
        });

        // Durable per-minute rollups — OPT-IN (default off). Every measurement
        // otherwise pays a billed, rate-limited SQLite write on the request path,
        // competing with app data for the shard's write budget; the payoff is only
        // the Studio's 24h local trend chart. The live cross-instance path is
        // `sink.onMetric` below. Gated BEFORE touching `rawSql` so a disabled sink
        // allocates nothing and runs no SQL.
        const metricHistory = sink?.metricHistory;

        if (metricHistory !== undefined && metricHistory !== false) {
            // Use the RAW storage handle, NOT `this.sql`: the getter instruments
            // statements into the Query Insights leaderboard during a dispatch, and
            // these housekeeping writes would be misattributed to the user function
            // that recorded the metric (matching recordFunctionMetric et al., which
            // all write through the raw handle for the same reason).
            const rawSql = this.shardHost.sql as unknown as SqlExec;
            // Pass the tune object straight through: `recordMetricHistory` already
            // coalesces every field with `?? DEFAULT`, so stripping `undefined`
            // keys here bought nothing. `true` (no tuning) becomes `{}`.
            const historyOptions: MetricHistoryOptions = typeof metricHistory === "object" ? metricHistory : {};

            bestEffort(() => {
                recordMetricHistory(rawSql, stamped, exemplarTraceId, historyOptions);
            });
        }

        // Optional export sink (the durable, cross-instance path).
        if (sink?.onMetric) {
            bestEffort(() => sink.onMetric?.(stamped, { waitUntil: this.shardHost.waitUntil }));
        }
    }

    /** The decode + route body of {@link webSocketMessage}, split out so the trace wrapper stays a one-liner. */
    // eslint-disable-next-line sonarjs/cognitive-complexity -- Workers hibernation message router: the type/credential/route branching is the wire protocol and stays clearer inline than split across helpers sharing the socket + envelope
    protected async handleWebSocketMessage(ws: ShardSocketLike, message: string | ArrayBuffer): Promise<void> {
        // Token-expiry: a socket whose credential lapsed is dropped before its
        // frame is processed, so the client reconnects and re-resolves identity.
        // This is the inbound-activity check; the load-bearing one is in
        // `refreshSubscriptions`, which drops an expired socket BEFORE pushing it
        // the user's live data (a passive subscriber sends no frames — its
        // keepalive pings auto-respond and never reach here — so inbound checks
        // alone would never fire for the common case).
        if (this.isSocketExpired(ws)) {
            this.dropExpiredSocket(ws);

            return;
        }

        // Frame-size cap BEFORE the decode+parse: without it the only bound on an
        // inbound frame is the platform's own per-message limit, so a client can
        // make the DO decode and `JSON.parse` a multi-megabyte body per frame.
        // Byte length for a binary frame, UTF-16 code units for a text one (see
        // the constant). An over-cap frame is refused, never truncated.
        const rawSize = typeof message === "string" ? message.length : message.byteLength;

        if (rawSize > MAX_WS_FRAME_UNITS) {
            trySendFrame(ws, JSON.stringify({ message: "frame too large", type: "error" }));

            return;
        }

        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        let envelope: SubscriptionEnvelope;

        try {
            envelope = JSON.parse(text) as SubscriptionEnvelope;
        } catch {
            trySendFrame(ws, JSON.stringify({ message: "invalid envelope", type: "error" }));

            return;
        }

        if (envelope.type === "connect") {
            // One-shot control frame the client sends right after the socket
            // opens: record its connection `context` on the attachment (so it
            // survives hibernation and can be replayed at close) and fire the
            // `onConnect` lifecycle hooks under the socket's verified identity.
            const attachment = this.readAttachment(ws);

            // Idempotent: a socket announces `connect` exactly once. A re-sent
            // (or duplicate) frame must not re-fire `onConnect`, or it would
            // out-number the single `onDisconnect` at close.
            if (attachment.connected === true) {
                return;
            }

            if (envelope.context !== undefined) {
                attachment.context = envelope.context;
            }

            // Record the client's stable id so shape pokes to this socket can
            // echo its `__client_watermark` as `lastMutationId` (overlay-drop).
            if (envelope.clientId !== undefined) {
                attachment.clientId = envelope.clientId;
            }

            // Resolve the announced capabilities to the decisions they gate,
            // rather than persisting the raw tokens. `caps` is client-supplied
            // and otherwise unbounded — the sibling attachment arrays (`subs`,
            // `whispers`) are both explicitly capped for exactly that reason,
            // and an over-large one here would either starve `subs` or make
            // `serializeAttachment` throw, dropping the whole attachment. A
            // fixed set of booleans is bounded by construction, and nothing
            // reads an unrecognised token back: the server can only act on ones
            // it understands, so keeping them would store input with no reader.
            if (Array.isArray(envelope.caps)) {
                attachment.pageDeltas = envelope.caps.includes(PAGE_DELTA_CAPABILITY);
            }

            attachment.connected = true;

            // `connected` lives on the SAME object the `try` below persists —
            // if `context` is what made it too large and the whole attachment
            // fails to serialize, `connected` doesn't survive either, even
            // though only `context` was ever documented as at-risk. A resent
            // `connect` (there's no ack frame for this envelope, so a client may
            // legitimately retry after a timeout) would then re-enter this
            // branch and re-fire `onConnect` — `webSocketClose` still only fires
            // `onDisconnect` once, breaking the symmetry the `connected === true`
            // check above exists to guarantee.
            //
            // Retry once with `context` omitted so `connected`/`clientId`/
            // `pageDeltas` still persist even when `context` alone is what
            // doesn't fit. Only if THAT also fails is nothing here persistable;
            // in that case, don't fire `onConnect` at all — an unpersisted
            // `connected` flag means the next `deserializeAttachment` read sees
            // `connected: false`, so a resent `connect` frame correctly re-enters
            // this branch and retries, rather than silently never firing again.
            let persisted = true;

            try {
                (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
            } catch {
                const withoutContext: SocketAttachment = { ...attachment };

                delete withoutContext.context;

                try {
                    (ws as HibernatableWebSocket).serializeAttachment?.(withoutContext);
                } catch {
                    // Neither attempt persisted. Roll back the in-memory flip so
                    // this local `attachment` object agrees with what's actually
                    // in storage — the same defensive move `subscribe`/
                    // `unsubscribe` above make on their own serialize failure.
                    attachment.connected = false;
                    persisted = false;
                }
            }

            // The in-memory `attachment` still carries `context` regardless of
            // which serialize attempt (if any) succeeded, so a persisted-retry
            // still fires the hook with the caller's supplied context THIS turn
            // — it just won't survive to `onDisconnect` at close.
            if (persisted) {
                await this.dispatchLifecycle("connect", this.lifecycleInfo(attachment));
            }

            return;
        }

        if (envelope.type === "subscribe" && envelope.query) {
            const { functionPath } = envelope.query;
            const isAdmin = functionPath?.startsWith(ADMIN_FUNCTION_PREFIX) === true;

            // Admin introspection subscriptions read shard internals (raw rows,
            // metrics, logs), so they are gated by the same `LUNORA_ADMIN_TOKEN`
            // as the HTTP admin RPCs — recorded on the socket at upgrade and
            // re-derived from `env` here, so a rotation revokes the socket rather
            // than only the HTTP plane. A socket that only cleared the
            // user-subscription gate must never be able to read admin data by
            // naming a reserved functionPath.
            if (isAdmin && !(await this.attachmentAdminAuthorized(this.readAttachment(ws)))) {
                trySendFrame(ws, JSON.stringify({ id: envelope.id, message: "admin subscription requires admin authorization", type: "error" }));

                return;
            }

            // Decode the wire-encoded subscription args ONCE, at the entry point —
            // BEFORE the attachment store and the seed — so every downstream
            // consumer (re-execution on poke, `reactiveCacheKey`, RLS predicate
            // eval) sees REAL values (`bigint`/`Date`/bytes), and the
            // structured-clone attachment carries them through hibernation.
            // `decodeWire` is identity for pure-JSON args (legacy frames included).
            let query: SubscriptionQuery;

            try {
                query =
                    envelope.query.args === undefined
                        ? envelope.query
                        : { ...envelope.query, args: decodeWire(envelope.query.args) as Record<string, unknown> };
            } catch {
                // A malformed tagged payload (over-long bigint, over-deep nesting)
                // must not throw out of `webSocketMessage` — surface a structured
                // error frame instead, mirroring the persist-failure path.
                trySendFrame(
                    ws,
                    JSON.stringify({
                        code: "BAD_SUBSCRIPTION_ARGS",
                        error: { code: "BAD_SUBSCRIPTION_ARGS", message: "subscription args failed wire decoding" },
                        id: envelope.id,
                        type: "error",
                    }),
                );

                return;
            }

            const status = this.subscribe(ws, envelope.id, query);

            if (status !== "ok") {
                // The `paid` refusal mirrors the origin's batch gate (`BAD_REQUEST`):
                // a paid query is one payment for one call, which a live
                // subscription (seed + every poke) cannot be.
                const { code, message: errorMessage } = {
                    paid: { code: "BAD_REQUEST", message: paidSocketRefusal(String(functionPath), "subscribed") },
                    serialize_failed: {
                        code: "SUBSCRIPTION_PERSIST_FAILED",
                        message: subscriptionRefusal("size", ShardDO.MAX_SUBSCRIPTIONS_PER_SOCKET, ShardDO.MAX_ATTACHMENT_BYTES),
                    },
                    too_many: {
                        code: "TOO_MANY_SUBSCRIPTIONS",
                        message: subscriptionRefusal("count", ShardDO.MAX_SUBSCRIPTIONS_PER_SOCKET, ShardDO.MAX_ATTACHMENT_BYTES),
                    },
                }[status];

                trySendFrame(ws, JSON.stringify({ code, error: { code, message: errorMessage }, id: envelope.id, type: "error" }));

                return;
            }

            trySendFrame(ws, JSON.stringify({ id: envelope.id, type: "ack" }));

            // Seed the subscriber with the query's current result so the first
            // value arrives over the same channel as later updates. When the
            // subclass doesn't support re-execution (base default), this is a
            // no-op and the subscriber relies on its initial HTTP query.
            if (functionPath) {
                await this.seedSubscriptionGuarded(ws, envelope.id, query, functionPath, isAdmin);
            }

            return;
        }

        if (envelope.type === "shape_subscribe" && envelope.shape) {
            // Decode-at-entry, mirroring the `subscribe` branch above: the stored
            // descriptor and every `resolveShape` see real values.
            let shapeArgs: Record<string, unknown> | undefined;

            try {
                shapeArgs = envelope.shape.args === undefined ? undefined : (decodeWire(envelope.shape.args) as Record<string, unknown>);
            } catch {
                this.sendSubscriptionError(ws, envelope.id, "BAD_SUBSCRIPTION_ARGS", "shape args failed wire decoding");

                return;
            }

            await this.handleShapeSubscribe(ws, envelope.id, {
                args: shapeArgs,
                name: envelope.shape.name,
                sinceEpoch: envelope.sinceEpoch,
                sinceSeq: envelope.sinceCheckpoint,
            });

            return;
        }

        if (envelope.type === "shape_unsubscribe") {
            this.shapeUnsubscribe(ws, envelope.id);
            trySendFrame(ws, JSON.stringify({ id: envelope.id, type: "ack" }));

            return;
        }

        if (envelope.type === "stream" && envelope.query?.functionPath) {
            // Streams are public-only: there is no admin-streaming surface, so
            // anything matching the admin prefix is rejected up front rather
            // than allowed to slip through executeStream().
            if (envelope.query.functionPath.startsWith(ADMIN_FUNCTION_PREFIX)) {
                trySendFrame(ws, JSON.stringify({ id: envelope.id, message: "streams must be public", type: "error" }));

                return;
            }

            // `.x402({ price }).stream(...)` carries the price tag into
            // `LUNORA_FUNCTIONS` like any other paid procedure, but this frame
            // never crosses the origin's paywall — so a paid stream served here
            // is served free. Refuse it the same way `subscribe` refuses a paid
            // live query.
            if (this.isPaidFunction(envelope.query.functionPath)) {
                this.sendSubscriptionError(ws, envelope.id, "BAD_REQUEST", paidSocketRefusal(envelope.query.functionPath, "streamed"));

                return;
            }

            // Decode the wire-encoded stream args (bigint/bytes survive the WS hop)
            // before handing them to the stream handler — mirrors the `/rpc` path,
            // and the `subscribe` / `shape_subscribe` branches above.
            //
            // Decoded into a local FIRST, not inline in the call below. `decodeWire`
            // throws a `RangeError` on an over-long bigint or past its 64-level
            // nesting cap, and inline it threw during ARGUMENT EVALUATION — before
            // `handleStream` had returned a promise, so the trailing `.catch()`
            // could not see it. Neither `handleWebSocketMessage` nor
            // `webSocketMessage` wraps this, so under the hibernation API one
            // malformed frame killed the whole socket instead of failing one stream.
            let streamArgs: Record<string, unknown>;

            try {
                streamArgs = decodeWire(envelope.query.args ?? {}) as Record<string, unknown>;
            } catch {
                trySendFrame(
                    ws,
                    JSON.stringify({
                        error: { code: "BAD_SUBSCRIPTION_ARGS", message: "stream args failed wire decoding" },
                        id: envelope.id,
                        type: "error",
                    }),
                );

                return;
            }

            // Fire-and-forget: handleStream owns its own error reporting (it
            // sends `type:"error"` frames to the socket). The trailing no-op
            // catch only guards the rare pre-try throw path (e.g. ws.send on a
            // socket the runtime already tore down) so a dead socket can't
            // surface as an unhandled rejection.
            this.handleStream(
                ws,
                envelope.id,
                envelope.query.functionPath,
                streamArgs,
                // Client input: a non-integer or negative watermark would seed
                // `delivered` past real chunks and silently truncate the stream,
                // so it is normalised here rather than trusted.
                Number.isInteger(envelope.sinceChunk) && (envelope.sinceChunk as number) > 0 ? (envelope.sinceChunk as number) : 0,
                // Same trust boundary for the resume generation: only a positive
                // integer counts; anything else behaves like an older client
                // that never sent one.
                Number.isInteger(envelope.generation) && (envelope.generation as number) > 0 ? (envelope.generation as number) : undefined,
            ).catch(() => {
                /* socket already gone; nothing to report */
            });

            return;
        }

        if (envelope.type === "whisper_subscribe" || envelope.type === "whisper_unsubscribe") {
            if (typeof envelope.topic === "string" && envelope.topic.length > 0) {
                const join = envelope.type === "whisper_subscribe";

                this.setWhisperMembership(ws, envelope.topic, join);

                // Relay tier (plan 075 Phase 2): once a relay holds a subscriber, it
                // announces itself so the owner forwards whisper frames to it.
                if (join) {
                    await this.relay?.announce();
                }
            }

            return;
        }

        if (envelope.type === "whisper") {
            if (typeof envelope.topic === "string" && envelope.topic.length > 0) {
                await this.broadcastWhisper(ws, envelope.topic, envelope.data);
            }

            return;
        }

        if (envelope.type === "unsubscribe") {
            // Stream cancel: abort the in-flight iterator (if any) before
            // touching the subscription registry. unsubscribe() on a non-sub
            // id is a no-op, so this stays safe even when id namespaces overlap.
            const cancellers = this.streamCancellers.get(ws);
            const controller = cancellers?.get(envelope.id);

            if (controller) {
                controller.abort();
                cancellers?.delete(envelope.id);
            }

            this.unsubscribe(ws, envelope.id);
            trySendFrame(ws, JSON.stringify({ id: envelope.id, type: "ack" }));
        }
    }

    /**
     * Stamp everything one RPC dispatch needs off its request, and reset every
     * per-request capture the handler will fill.
     *
     * Split from {@link ShardDO.handleFetchCloudflare} together with
     * {@link ShardDO.endDispatch}, and the pairing is the point: these two own
     * the same set of fields, and the whole correctness story for them is that
     * every field one sets, the other clears. Spread across a 479-line method
     * the two ends were 350 lines apart, so a newly-added per-request field
     * stamped here and forgotten there leaks into the NEXT request on the same
     * DO instance — a cross-request identity bleed with no local symptom.
     * `__tests__/dispatch-lifecycle.test.ts` asserts the symmetry directly.
     *
     * Returns the two values the caller must hold in locals rather than read
     * back off `this`: an `await`-interleaved concurrent dispatch can re-set the
     * shared fields, and the `finally` would then file this dispatch's telemetry
     * under another request's trace (see the comments inside).
     * @returns this dispatch's trace anchor and its transaction-headroom tracker
     */

    /**
     * Cloudflare-specific fetch implementation — WebSocket upgrades and the RPC
     * routes. Injected into {@link ShardRunner} as the host-specific handler while
     * the engine is progressively extracted.
     */
    // eslint-disable-next-line sonarjs/cognitive-complexity -- the DO's central request router; the branching IS the route table, and splitting the request lifecycle across helpers would hurt readability more than the score costs
    protected async handleFetchCloudflare(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // Learn the DO namespace binding the runtime routes through, so this DO can
        // address its siblings for the relay hub (plan 075 Phase 2). Only SOME
        // inbound requests carry it (the WS upgrade, a replica-routed RPC, and a
        // sibling DO's relay/replica POST — not the owner `/rpc` path), so it is
        // kept across requests once known rather than expected on each one.
        //
        // An EMPTY header is treated as "not supplied", not as a value. A sibling
        // POST stamps `shardBinding() ?? ""` (see `relay-hub.ts`), so a peer that
        // does not yet know its own binding sends the empty string — and `??`
        // alone would let that overwrite a binding this DO already knew, because
        // `headers.get` returns `""` rather than `null`. `siblingStub` then
        // resolves `env[""]` to nothing and the whole relay tier goes silently
        // dark until some later request happens to carry a real value.
        const suppliedBinding = request.headers.get("x-lunora-shard-binding");

        this.shardBinding = suppliedBinding === null || suppliedBinding === "" ? this.shardBinding : suppliedBinding;

        // The non-RPC routes (WS upgrade + the internal owner↔relay control channel)
        // are handled up front; everything past here is the shard-local RPC endpoint.
        const early = await this.routeNonRpc(url, request);

        if (early !== undefined) {
            return early;
        }

        if (url.pathname !== "/rpc" || request.method !== "POST") {
            return new Response("Not found", { status: 404 });
        }

        let payload: RpcRequest;

        try {
            payload = await request.json();
        } catch {
            return jsonResponse({ error: { code: "BAD_REQUEST", message: "invalid JSON body" } }, 400);
        }

        // A replica serves ONLY the reads the runtime explicitly routed to it,
        // and only once it has caught up far enough to answer them.
        if (this.replica !== undefined) {
            const refusal = await gateReplicaDispatch(this.replica, request, payload.functionPath);

            if (refusal !== undefined) {
                return refusal;
            }
        }

        // Reserved admin-introspection RPCs are intercepted before user
        // dispatch — they read raw SQLite directly rather than running a
        // registered function, and carry their own bearer-token gate. Run under
        // their own request scope: this branch returns before `beginDispatch`, so
        // without it the admin plane inherits whatever a concurrent `/rpc` left on
        // `this`. See {@link ShardDO.withAdminRequestScope}.
        if (payload.functionPath.startsWith(ADMIN_FUNCTION_PREFIX)) {
            return await this.withAdminRequestScope(async () => await this.handleAdminRpc(request, payload.functionPath, payload.args ?? {}));
        }

        // Stash the inbound D1 bookmark and identity headers for the
        // duration of the handler call so getters return the right
        // values. Cleared on exit so the next request starts fresh.
        const { dispatchAttribution, dispatchHeadroom, dispatchStartedAt, dispatchTrace } = this.beginDispatch(request);

        // Outcome of the dispatch, for the synthetic root span recorded in the
        // `finally` below. A sentinel rather than a boolean so the `catch` can
        // hand the thrown value straight through to the span's error classifier.
        let dispatchError: { thrown: unknown } | undefined;

        try {
            // Reserved cross-shard relation read/count (reverse cross-backend
            // relations). Served BEFORE user dispatch and returned BARE (row
            // array / number) — never `{ result }`-wrapped — so the Query
            // Coordinator's `concat`/`sum` merge composes the per-shard
            // values. Runs under the forwarded identity stashed above; the
            // worker refuses this prefix on a single-shard envelope, so it's
            // only reachable through the authorizeFanOut-gated fan-out path.
            //
            // BARE but still WIRE-ENCODED, for the reason {@link adminResponse}
            // spells out: these rows come straight out of the row store, where
            // `decodeDocJson` has already restored a real `bigint` for a
            // `v.int64()` column and a real `ArrayBuffer` for `v.bytes()`.
            // Uncoded, the first makes `Response.json` throw
            // `TypeError: Do not know how to serialize a BigInt` (the whole
            // fan-out 500s) and the second flattens to `{}` — a silently emptied
            // column in the parent's `with:` result. The consumer half is
            // `decodeWire` in `@lunora/runtime`'s `cross-shard-relations`; both
            // codecs are the identity on pure-JSON payloads, so a relation with
            // no exotic columns is byte-identical to before.
            if (payload.functionPath.startsWith(RELATION_FUNCTION_PREFIX)) {
                const value = await this.runRelationFanoutRead(payload.functionPath, payload.args ?? {});

                return jsonResponse(encodeWire(value), 200, bookmarkHeaders(this.currentResponseBookmark));
            }

            // Custom-mutator ordering: a watermarked push (`clientId` +
            // numeric `clientSeq`) on a registered mutator is classified against
            // `__client_watermark` BEFORE the handler runs, so out-of-order and
            // replayed pushes never reach the authoritative impl. Ordinary
            // mutations (and pushes without the headers) get `undefined` here and
            // ride the idempotency path below unchanged.
            const mutatorClass = this.isCustomMutator(payload.functionPath) ? this.classifyClientMutation() : undefined;

            // Stash it so the in-transaction bookkeeping (run from `handleRpc`'s
            // mutation transaction) advances the watermark for a `"next"` push in
            // the same commit as the writes.
            this.currentMutatorClass = mutatorClass;

            const watermarkShortCircuit = this.rejectNonNextMutation(payload.functionPath, mutatorClass, dispatchStartedAt);

            if (watermarkShortCircuit !== undefined) {
                return watermarkShortCircuit;
            }

            // Mutation-replay dedup: if this `(identity, mutationId)` already
            // committed, return its cached result without re-running the
            // handler (so a client that replays an unacked write — same id —
            // sees exactly-once semantics). The id rides the
            // `x-lunora-mutation-id` header (stashed into `currentRequestMutationId`
            // above), the same source `persistIdempotentResult` reads when it
            // records the row after the handler commits.
            //
            // For a MUTATION the read and the `handleRpc` call run inside ONE
            // `ShardHost.runSerialized` span — the same single-writer gate
            // `ShardRunner.runInTransaction` composes with `transaction` — so two
            // concurrent dispatches carrying the same `mutationId` can't both
            // observe a cache miss and both run the handler. A mutation was
            // already going to hold that gate, so the widened span costs it
            // nothing.
            //
            // An action or query takes the SAME dedup read WITHOUT the gate. The
            // gate is `blockConcurrencyWhile`: it stalls every other dispatch on
            // the shard, and an action routinely awaits seconds of outbound I/O
            // it can never roll back. Gating one would let any caller freeze the
            // whole shard for that long — repeatedly, and for free — by attaching
            // an `x-lunora-mutation-id` header the runtime forwards verbatim for
            // every kind. See {@link isMutationFunction}. The exactly-once
            // guarantee an action gets is therefore the weaker, pre-gate one:
            // a sequential replay short-circuits, two genuinely concurrent
            // dispatches of the same id can both miss.
            //
            // `(identity, mutationId)` is captured into a LOCAL scope here and
            // re-pinned onto the instance fields as the FIRST statement inside
            // the gated closure. The gate itself only delays entry — while THIS
            // dispatch waits its turn, another dispatch's prologue (a sibling
            // `fetch()`, same "concurrent fetches" characteristic the gate exists
            // to guard against) can run and overwrite these same shared fields
            // before this closure is admitted. `readIdempotentResult`, and the
            // write-side calls `handleRpc` makes via `commitMutationBookkeeping`
            // (persisting the result, advancing the client watermark), all read
            // them straight off `this`, so without the re-pin a dedup check (or
            // its commit) could silently run under ANOTHER dispatch's identity —
            // exactly the kind of corruption this fix exists to close, just moved
            // one field over. (`dispatchTrace`/`dispatchHeadroom` above capture
            // the same way, for the same reason, on the other side of `handleRpc`.)
            const requestScope = this.captureRequestScope();

            // Decode the wire codec (`bytes`/`bigint`/typed-array/±Infinity
            // leaves) ONLY for the handler, so `validateArgs` sees real
            // `ArrayBuffer`/`bigint` values. `payload.args` stays in wire form for
            // the request log/metrics below (JSON-safe — a raw `bigint` there
            // would throw `JSON.stringify`).
            // The outbound bookmark this dispatch's own writes produced, snapshotted
            // at the last instant the handler owns the shared field. `buildDispatchResponse`
            // reads `currentResponseBookmark` after the gate has released, and the
            // handler can still `await` past its final `.global()` write — so a
            // sibling's prologue could clear the field, or replace it with its own,
            // between the write and the response. A local closes that window.
            let outboundBookmark: string | undefined;

            const runHandler = async (): Promise<unknown> => {
                const handlerArgs = decodeWire(payload.args ?? {}) as Record<string, unknown>;

                // A registered `query` goes through the reactive cache when one
                // is configured; every other kind dispatches straight through. The
                // decoded args are what get keyed (`stableWireKey` handles the
                // `bigint`/bytes leaves), so two calls that differ only in wire
                // encoding still share an entry. `runCachedQuery` is a pass-through
                // when `reactiveCache` is undefined, but the kind lookup is skipped
                // in that case so a cache-less shard pays nothing.
                const handlerResult = await (this.reactiveCache !== undefined && this.isQueryFunction(payload.functionPath)
                    ? this.runCachedQuery(
                          payload.functionPath,
                          handlerArgs,
                          // The scope is threaded BY VALUE into the handler's ctx
                          // (see `handleRpc`), so this dispatch's reads stamp its
                          // own tracker even while a sibling is mid-await.
                          (scope) => this.handleRpc(payload.functionPath, handlerArgs, dispatchHeadroom, scope),
                          dispatchAttribution,
                      )
                    : this.handleRpc(payload.functionPath, handlerArgs, dispatchHeadroom));

                outboundBookmark = this.currentResponseBookmark;

                return handlerResult;
            };

            const dedupMutationId = requestScope.mutationId;

            const dedupedDispatch = async (cacheKey: string): Promise<DispatchOutcome> => {
                const cached = this.readIdempotentResult(cacheKey);

                return cached === undefined ? { kind: "ran", result: await runHandler() } : { cached, kind: "cached" };
            };

            let dispatchOutcome: DispatchOutcome;

            if (dedupMutationId === undefined) {
                dispatchOutcome = { kind: "ran", result: await runHandler() };
            } else if (this.isMutationFunction(payload.functionPath)) {
                dispatchOutcome = await this.shardHost.runSerialized(async () => {
                    this.restoreRequestScope(requestScope);

                    return await dedupedDispatch(dedupMutationId);
                });
            } else {
                dispatchOutcome = await dedupedDispatch(dedupMutationId);
            }

            // Re-pin for the TAIL, for the same reason the gated closure re-pins
            // on the way in: the post-dispatch bookkeeping below (the dedup row
            // for a non-transactional dispatch, the client-watermark advance)
            // reads `currentRequest*` straight off `this`, and every await
            // since the prologue — the handler's own, and the gate's queueing
            // time — is a window for a sibling `fetch()`'s prologue to have
            // overwritten them. Without this the tail could commit under another
            // dispatch's identity.
            this.restoreRequestScope(requestScope);

            // AFTER the restore, which clears the field on purpose. A cached
            // outcome never ran a handler, so `undefined` is the right answer
            // there: it performed no `.global()` write to report.
            this.currentResponseBookmark = outboundBookmark;

            if (dispatchOutcome.kind === "cached") {
                return this.respondFromIdempotencyCache(payload.functionPath, dispatchStartedAt, mutatorClass, dispatchOutcome.cached.value);
            }

            const { result } = dispatchOutcome;

            this.recordPostDispatchBookkeeping(result, mutatorClass);

            // Custom-mutator watermark WRITE: advance the per-client high-water
            // mark to this sequence now that the authoritative writes committed.
            // No-op unless this dispatch was classified `"next"` above.
            //
            // NOT atomic with the handler: the handler's writes auto-commit per
            // statement, then `persistIdempotentResult` and this advance run as
            // two further separate writes. A crash after the handler commits but
            // before this advance leaves the watermark behind — the client's
            // unacked replay re-classifies as `"next"` (the read side treats a
            // missing/lower row as already-processed) and re-runs idempotently,
            // re-advancing. So the gap self-heals; it never drops or double-applies
            // the write. The advance helper below documents the same
            // replay-recovery contract for a failed watermark write.
            if (mutatorClass?.kind === "next") {
                this.advanceClientMutationWatermark();
            }

            const durationMs = Date.now() - dispatchStartedAt;

            // Record the handler's own latency (before the subscription
            // write-flush below) against the per-function counters, along
            // with any tables it full-scanned (causal attribution).
            this.recordFunctionCall(payload.functionPath, durationMs, undefined, this.currentScannedTables, this.currentIndexHits);

            // Flush per-statement SQL samples accumulated during dispatch to
            // the durable `__lunora_metrics_queries` table. Best-effort:
            // a flush failure (e.g. no sql handle in tests) must never fail
            // the response.
            this.flushStmtSamples();

            // Snapshot the written-table set BEFORE `flushChangedTables`
            // drains it — afterwards `pendingChangedTables` is `undefined`,
            // so the request log would record an empty write set.
            const tablesWritten = [...(this.pendingChangedTables ?? [])];

            this.recordRequestLog(payload.functionPath, payload.args ?? {}, durationMs, "ok", tablesWritten, dispatchTrace, dispatchAttribution);

            // Inspect the post-write size before responding. SQLite-in-DO
            // exposes `databaseSize` as a real getter; reading it is a
            // cheap stat call, not a full table scan.
            this.maybeWarnRootSize();

            // Snapshot the response before re-running subscriptions so the
            // bookmark captured by the handler is preserved verbatim. A custom
            // mutator echoes the applied `lastMutationId` so the client can drop
            // the pending optimistic overlay as soon as the ack lands (the poke
            // frame carries the same watermark for passive subscribers).
            // Encode the result to wire form exactly here (the fresh path). The
            // idempotency cache also stores the encoded form (see
            // `persistIdempotentResult`), so `respondFromIdempotencyCache` /
            // `buildDispatchResponse` never re-encode — no double-encoding.
            const response = this.buildDispatchResponse(mutatorClass, encodeWire(result));

            await this.flushChangedTables();

            return response;
        } catch (error: unknown) {
            this.metrics.errors += 1;
            dispatchError = { thrown: error };
            const durationMs = Date.now() - dispatchStartedAt;
            const message = error instanceof Error ? error.message : String(error);
            // Count only OCC conflicts as write contention — a unique-index
            // breach / onDelete-restrict / trigger-overflow also surfaces as a
            // 409 ConflictError but is a constraint failure, not contention, and
            // would mis-fire the write-contention advisor.
            const conflicted = error instanceof ConflictError && error.kind === "occ";

            // Do NOT record per-function metrics for an unregistered/`FUNCTION_NOT_FOUND`
            // dispatch: `functionPath` is caller-controlled and the runtime forwards it
            // without checking it against the registry, so recording here would let a
            // flood of random paths grow both the durable `__lunora_metrics` table and the
            // in-memory `functionStats` map without bound (the Map's "bounded by the app's
            // finite registered-function set" assumption only holds for real functions).
            // The request log + error buffer below still capture the failure, and both are
            // bounded (retention / fixed buffer).
            const code = (error as { code?: unknown } | null)?.code;

            if (code !== "FUNCTION_NOT_FOUND") {
                // Redact BEFORE either function-metrics sink sees it: `recordFunctionCall`
                // feeds this same string into both the durable `__lunora_metrics.last_error_message`
                // column and the in-memory `functionStats` cache served by
                // `__lunora_admin__:getFunctionStats`, so redacting once here — with the
                // same `standardRules` treatment and `captureRaw` dev escape hatch the
                // request-log sinks use — keeps every error-message sink consistent. The
                // RAW `message` still goes to `recordRequestLog` below (which redacts
                // internally, at the durable-row/Logpush boundary) and the in-memory
                // `this.logs` dev buffer, unaffected by this local redaction.
                const redactedErrorMessage = redactArgs(message, isDevEnvironment(this.env)) as string;

                this.recordFunctionCall(payload.functionPath, durationMs, redactedErrorMessage, this.currentScannedTables, this.currentIndexHits, conflicted);
            }
            // Flush statement samples even on error paths — partial sampling
            // is better than losing the timing signal entirely.
            this.flushStmtSamples();
            this.recordRequestLog(
                payload.functionPath,
                payload.args ?? {},
                durationMs,
                "error",
                [...(this.pendingChangedTables ?? [])],
                dispatchTrace,
                dispatchAttribution,
                message,
            );
            this.logs.push({
                functionPath: payload.functionPath,
                level: "error",
                message,
                timestamp: Date.now(),
                // The local, not the shared field: this runs after the handler's
                // awaits, where an interleaved dispatch may have re-set it.
                traceId: dispatchTrace.traceId,
            });

            // A fresh error row landed, but the failed dispatch's own writes (if
            // any) rolled back, so nothing else drives a refresh. Mark the reqlog
            // table changed and flush so the live `getLogs`/`getIssues`
            // admin-wildcard subscriptions re-run and surface the throw in real
            // time — the ok path flushes here too. Any rolled-back data tables
            // still in the pending set re-read committed state, so no stale push.
            this.recordChangedTable(REQUEST_LOG_TABLE);
            await this.flushChangedTables();

            return this.errorToResponse(error);
        } finally {
            // Guard hoisted to the call site so the common case — a handler that
            // touched neither `ctx.trace` nor `ctx.span` — is visibly a no-op here.
            // A wide event alone is reason enough to record the root span: it is
            // the span the attributes live on, so skipping it would silently
            // discard everything the handler attached.
            const dispatchSpan = this.dispatchSpans.get(dispatchSpanKey(dispatchTrace));

            if (this.spans.hasTrace(dispatchTrace.traceId) || dispatchSpan?.collector !== undefined) {
                this.recordDispatchRootSpan(payload.functionPath, dispatchStartedAt, dispatchError, dispatchTrace);
            }

            this.dispatchSpans.delete(dispatchSpanKey(dispatchTrace));

            // Invocation boundary for the shard, mirroring the worker's: a batching
            // sink is told to ship what this dispatch produced. Without it the DO's
            // spans and logs would sit in a buffer until the next dispatch happened
            // to fill it — arbitrarily late, or never on a quiet shard.
            if (dispatchSpan?.sink?.flush) {
                try {
                    dispatchSpan.sink.flush({ waitUntil: this.shardHost.waitUntil });
                } catch {
                    // Best-effort — a telemetry flush must never fail a served request.
                }
            }
            // Export boundary for a sampled-out trace: now that the dispatch has
            // settled we know whether it errored, so flush its held `ctx.trace`
            // spans (tail bias) or drop them. A no-op for sampled-in traces (their
            // spans already streamed live).
            this.flushSampledOutTrace(dispatchTrace, dispatchError !== undefined);
            this.traceSampling.delete(dispatchTrace.traceId);
            this.endDispatch();
        }
    }

    /**
     * Cloudflare-specific alarm implementation, injected into {@link ShardRunner}
     * as the host-specific handler while the engine is progressively extracted.
     */
    protected async handleAlarmCloudflare(): Promise<void> {
        // A replica runs the owner's class, so every background tier the schema
        // arms — external-source polling, TTL sweeps, global-shape polls — would
        // otherwise fire here too, against a COPY. The damage is not theoretical:
        // an external source resolves its tenant from `currentShardKey()`, which
        // on a replica is the replica's own name, so a full pull would match
        // nothing and diff every replicated row into a delete. Background work
        // belongs to the single writer; a follower only ever replays.
        if (this.replica !== undefined) {
            return;
        }

        // Captured before the first `await`, then passed by value everywhere below:
        // this handler is the alarm's own scope, so nothing has interleaved yet.
        // `undefined` when the alarm ran outside `withTriggerTrace` (a direct call
        // in a test), which simply leaves these log lines uncorrelated.
        const trace = this.currentTriggerTrace;

        this.globalPollScheduled = false;

        let globalShapesRemaining: number;

        try {
            globalShapesRemaining = await this.pollGlobalShapes(trace);
        } catch (error) {
            // `pollGlobalShapes` already contains per-socket/per-shape failures;
            // this guards a catastrophic failure (e.g. `getWebSockets` throwing)
            // so the poll heartbeat re-arms and retries next tick instead of
            // dying permanently and silently dropping every global subscriber.
            this.recordShapeError("shape:poll", error, trace);
            globalShapesRemaining = 1;
        }

        // A contained tier failure re-arms at the fixed floor (a conservative
        // retry) rather than stranding its loop or spinning immediately.
        const pollTier = async (tag: string, run: () => Promise<number | undefined>): Promise<number | undefined> => {
            try {
                return await run();
            } catch (error) {
                this.recordShapeError(tag, error, trace);

                return Date.now() + ShardDO.GLOBAL_SHAPE_POLL_INTERVAL_MS;
            }
        };

        // External-source (`.source(...)`) ingest shares this alarm (plan 077). The
        // base hook returns `undefined` (dormant); the codegen subclass overrides
        // it to materialize each sourced table and report the earliest NEXT-DUE
        // timestamp across every non-manual source.
        const nextSourceDueAt = await pollTier("source:poll", async () => this.pollExternalSources(trace));

        // Declarative TTL expiry (`.ttl(...)`) shares this alarm too. The base hook
        // returns `undefined` (no TTL tables); the codegen subclass overrides
        // `ttlSweeps()` from the schema so the sweep pages + removes expired rows and
        // reports its next-due.
        const nextTtlDueAt = await pollTier("ttl:sweep", async () => this.pollTtlSweeps(trace));

        // Drain the tables the ingest poll just wrote: a sourced table is local, so
        // its `defineShape` subscribers are poked through the standard
        // changed-table → `pokeShapeSubscribers` path (the same one a mutation
        // uses), NOT the global-shape poke path. Without this, materialized rows land
        // in SQLite but live subscribers never see the incremental update. A no-op
        // when nothing was queued (non-sourced DOs, or a steady-state tick).
        await this.flushChangedTables();

        const nextAlarmAt = ShardDO.nextPollAlarmTarget(globalShapesRemaining, nextSourceDueAt, nextTtlDueAt, Date.now());

        if (nextAlarmAt !== undefined) {
            await this.scheduleGlobalPoll(nextAlarmAt);
        }
    }

    /**
     * Build `ctx.span` — the handle onto the **dispatch's own span**, and with it
     * the wide-event surface.
     *
     * `ctx.trace(...)` creates a *new* child span for a sub-operation; this
     * attaches to the one that already exists for the request. That is the
     * distinction between "time this thing" and "record a fact about this
     * request", and conflating them is why instrumentation usually degrades into
     * log spam: with nowhere to put a fact, people reach for `ctx.log.info`.
     *
     * Attributes accumulate across the whole dispatch and are folded into the
     * root span in `recordDispatchRootSpan` — the OTel-native form of a
     * wide event, needing no non-standard "canonical log line" convention on the
     * collector side.
     *
     * Keyed by `dispatchSpanKey` — trace id AND root span id — so two concurrent
     * dispatches forwarded under the same client trace accumulate separately.
     */

    /**
     * Snapshot the per-request identity/replay fields into a {@link RequestScope}.
     * Paired with {@link ShardDO.restoreRequestScope}; see that type's docstring
     * for why the dispatch path needs it.
     */
    private captureRequestScope(): RequestScope {
        return {
            bookmark: this.currentRequestBookmark,
            clientId: this.currentRequestClientId,
            clientSeq: this.currentRequestClientSeq,
            mutationId: this.currentRequestMutationId,
            mutatorClass: this.currentMutatorClass,
            system: this.currentRequestSystem,
            userId: this.currentRequestUserId,
        };
    }

    /**
     * Re-pin a {@link RequestScope} captured by {@link ShardDO.captureRequestScope}.
     *
     * Also clears the OUTBOUND bookmark, which is produced rather than captured:
     * whatever sits in the field on the way in belongs to whichever dispatch ran
     * during the wait, and echoing it would report a stranger's D1 write position
     * as this request's. The dispatch path re-pins its own afterwards.
     */
    private restoreRequestScope(scope: RequestScope): void {
        this.currentRequestBookmark = scope.bookmark;
        this.currentResponseBookmark = undefined;
        this.currentRequestClientId = scope.clientId;
        this.currentRequestClientSeq = scope.clientSeq;
        this.currentRequestMutationId = scope.mutationId;
        this.currentMutatorClass = scope.mutatorClass;
        this.currentRequestSystem = scope.system;
        this.currentRequestUserId = scope.userId;
    }

    /**
     * The dispatch entry's db tally, created on first use. Shares the entry with
     * `ctx.span`'s collector but is deliberately a separate slot — see
     * `instrumentDb`.
     */
    private dispatchTally(anchor: TraceAnchor): DatabaseTally {
        evictOldestEntry(this.dispatchSpans, MAX_TRACKED_DISPATCH_SPANS);

        const key = dispatchSpanKey(anchor);
        const entry = this.dispatchSpans.get(key) ?? {};

        entry.dbTally ??= createDatabaseTally();
        this.dispatchSpans.set(key, entry);

        return entry.dbTally;
    }

    /**
     * Give a NON-`fetch` Durable Object trigger — an alarm, an inbound socket
     * frame — the same telemetry an RPC dispatch gets: its own trace anchor, a
     * dispatch root span, and a flush of the batching sink when it finishes.
     *
     * These paths were previously invisible. An alarm can drive `.global()` shape
     * refreshes and external-source ingest, and a socket frame can run a whole
     * subscription re-evaluation, but neither produced a root span — so any
     * `ctx.trace` span they created hung off a freshly-minted anchor with nothing
     * above it, and a collector showed orphans with no bar explaining what caused
     * them. Alarms are also precisely where a silent failure hides longest,
     * because no client is waiting on a response to notice.
     *
     * The anchor is published on `currentRequestTrace` ONLY when nothing else has
     * claimed it, and restored afterwards, so a concurrently-interleaved RPC
     * dispatch (which captured its own anchor in a local at entry) keeps its
     * attribution. Worst case under interleaving is a mis-attributed inner span —
     * the same trade the surrounding code already makes with this field — never a
     * corrupted or lost one.
     */
    private async withTriggerTrace<T>(name: string, run: () => Promise<T>): Promise<T> {
        const anchor = resolveTraceAnchor(undefined);
        const startedAt = Date.now();
        const claimed = this.currentRequestTrace === undefined;

        if (claimed) {
            this.currentRequestTrace = anchor;
        }

        // Published unconditionally, unlike the shared dispatch field above: this
        // one is written only here, and a trigger is the only thing that reads it
        // (synchronously, at entry — see the field's docstring).
        const previousTrigger = this.currentTriggerTrace;

        this.currentTriggerTrace = anchor;

        let failure: { thrown: unknown } | undefined;

        try {
            return await run();
        } catch (error) {
            failure = { thrown: error };

            throw error;
        } finally {
            this.currentTriggerTrace = previousTrigger;

            if (claimed && this.currentRequestTrace === anchor) {
                this.currentRequestTrace = undefined;
            }

            // Only when the trigger actually produced telemetry — an idle alarm
            // that did nothing should not mint a bar in the studio waterfall and
            // evict a real trace from the bounded ring.
            if (this.spans.hasTrace(anchor.traceId) || this.dispatchSpans.get(dispatchSpanKey(anchor))?.collector !== undefined) {
                this.recordDispatchRootSpan(name, startedAt, failure, anchor);
            }

            this.dispatchSpans.delete(dispatchSpanKey(anchor));
            this.flushTelemetry();
        }
    }

    /**
     * Ask the last-seen telemetry sink to ship what it has buffered.
     *
     * Used by the trigger paths ({@link withTriggerTrace}), which have no `ctx`
     * and therefore no direct handle on `config.observability`. The sink is a
     * per-worker singleton in every real configuration, so remembering the most
     * recent one is exact in practice and harmless otherwise: a flush is
     * idempotent and a sink with an empty buffer is a no-op.
     */
    private flushTelemetry(): void {
        try {
            this.lastTelemetrySink?.flush?.({ waitUntil: this.shardHost.waitUntil });
        } catch {
            // Best-effort — a telemetry flush must never fail the trigger.
        }
    }

    /**
     * Buffer the synthetic root span for a finished dispatch. The caller gates
     * this on the dispatch having actually produced spans (the `hasTrace` check at
     * the call site): every request minting a root would fill the bounded ring
     * with single-bar traces from uninstrumented handlers and evict the
     * instrumented ones the panel exists to show.
     *
     * `anchor` carries the dispatch's trace ids, captured at entry rather than
     * read from `this` here — this runs after the handler's awaits, where the
     * shared field may already belong to an interleaved dispatch.
     *
     * When the handler attached a **wide event** through `ctx.span`, this also
     * exports it — see {@link exportWideEvent} for why it goes out as an OTel
     * Event record rather than on the span itself.
     */
    private recordDispatchRootSpan(functionPath: string, startedAt: number, failure: { thrown: unknown } | undefined, anchor: TraceAnchor): void {
        const wide = this.dispatchSpans.get(dispatchSpanKey(anchor));
        const durationMs = Date.now() - startedAt;
        // Auto-instrumentation counters ride whatever root span is being recorded;
        // they never cause one (see `instrumentDb`).
        const databaseAttributes = wide?.dbTally === undefined || wide.dbTally.calls === 0 ? undefined : formatTally(wide.dbTally);
        // Mirrors `db.spans_truncated`: the per-dispatch statement-sample buffer
        // (see `currentStmtSamples`) hit its distinct-statement cap, so the
        // query-metrics leaderboard's contribution from this dispatch is partial.
        const stmtSamplesAttributes: LogFields | undefined = this.currentStmtSamplesTruncated ? { "db.stmt_samples_truncated": true } : undefined;
        const collected =
            wide?.collector === undefined
                ? undefined
                : {
                      ...wide.collector.collected,
                      attributes: { ...databaseAttributes, ...stmtSamplesAttributes, ...wide.collector.collected.attributes },
                  };

        try {
            this.spans.push(
                dispatchRootSpan({
                    anchor,
                    // Raw failure messages in dev only — matches `makeTracer`'s
                    // `captureRaw` posture for this synthetic root span.
                    captureRaw: isDevEnvironment(this.env),
                    // The wide event, if the handler attached one through `ctx.span`.
                    ...(collected === undefined ? {} : { collected }),
                    durationMs,
                    failure,
                    functionPath,
                    shardKey: this.runner.shardKey,
                    startTs: startedAt,
                    userId: this.getCurrentUserId(),
                }),
            );
        } catch {
            // Best-effort — span capture must never fail a served request.
        }

        if (wide?.collector !== undefined) {
            this.exportWideEvent(functionPath, durationMs, failure, anchor, { collected: collected ?? wide.collector.collected, sink: wide.sink });
        }
    }

    /**
     * Export a dispatch's wide event as a standard OTel **Event** log record
     * (`lunora.dispatch`), correlated to the dispatch's trace and span.
     *
     * **Why a log record rather than the span's attributes.** The local dispatch
     * root span shares its `spanId` with the SERVER span `@lunora/runtime` emits
     * for the same dispatch — they are the same logical span, seen from the two
     * sides of the shard hop. Exporting our copy too would put two partial spans
     * with identical `trace_id`/`span_id` on the wire, which collectors resolve
     * inconsistently (merge, last-write, or duplicate). An Event record carrying
     * `traceId`/`spanId` is unambiguous, is the OTel-sanctioned shape for exactly
     * this ("a named, structured occurrence"), and every OTLP backend can group
     * and aggregate it with no Lunora-specific configuration.
     *
     * The span still carries the attributes LOCALLY, which is what the Studio
     * waterfall renders — so the wide event is visible in both places, exported
     * exactly once.
     */
    private exportWideEvent(
        functionPath: string,
        durationMs: number,
        failure: { thrown: unknown } | undefined,
        anchor: TraceAnchor,
        wide: { collected: SpanCollection; sink?: TelemetrySink },
    ): void {
        try {
            const { attributes } = wide.collected;

            this.recordUserLog(
                functionPath,
                // An errored dispatch's wide event is an error record, so severity
                // routing/alerting works on it without inspecting attributes.
                failure === undefined ? "info" : "error",
                [WIDE_EVENT_NAME],
                WIDE_EVENT_NAME,
                {
                    ...attributes,
                    // The always-present skeleton, under OTel-ish names so the
                    // record is useful even from a handler that attached nothing
                    // but a couple of business fields.
                    [LUNORA_ATTR.durationMs]: durationMs,
                    [LUNORA_ATTR.functionPath]: functionPath,
                    [LUNORA_ATTR.ok]: failure === undefined,
                },
                wide.sink,
                WIDE_EVENT_NAME,
                anchor,
            );
        } catch {
            // Best-effort — see recordUserLog.
        }
    }

    /**
     * Buffer one span for the studio Traces panel and hand it to the optional
     * `sink.onSpan`. Best-effort throughout, exactly like {@link recordUserLog}:
     * a span is recorded *after* its body already settled, so letting a telemetry
     * failure escape here would turn a succeeded operation into a failed request.
     *
     * The span is ALWAYS buffered locally (the Studio Traces panel is a full
     * "recent traces on this instance" readout, unaffected by sampling). Only the
     * export to the sink is sampled: when the active dispatch's trace was sampled
     * OUT (its inbound `traceparent` flag was `00`), the span is held back rather
     * than streamed — the dispatch `finally` re-decides once the trace's error
     * status is known ({@link flushSampledOutTrace}), so an errored trace is still
     * exported whole (tail bias). Spans from a sampled-in dispatch, or from another
     * trace (a subscription re-run mints its own anchor), stream immediately.
     */
    // eslint-disable-next-line @typescript-eslint/member-ordering -- kept in the span-recording cluster (next to recordDispatchRootSpan) for cohesion rather than hoisted above every private member
    protected recordSpan(span: SpanEvent, sink?: TelemetrySink, sampledSnapshot?: boolean): void {
        try {
            this.spans.push(span);
        } catch {
            // Best-effort — never let span capture fail the handler.
        }

        if (!sink?.onSpan) {
            return;
        }

        // Look the live verdict up by the SPAN's own `traceId` (not the shared
        // `currentRequestTrace`, which a sibling dispatch may have overwritten by now).
        const sampling = this.traceSampling.get(span.traceId);

        if (sampling !== undefined) {
            if (!sampling.sampled) {
                // Sampled out, dispatch still in flight: hold this span back and
                // remember the sink so the `finally` can flush the trace's held
                // spans if it turns out to error. Held ON THIS PER-TRACE ENTRY —
                // NOT re-read from the shared span ring at flush time, where a
                // concurrent trace could have evicted these error spans first.
                sampling.sink = sink;

                // The synthetic dispatch root never goes to `onSpan`, so it is not
                // held either — flushSampledOutTrace only ever emits `ctx.trace` spans.
                if (span.dispatch !== true) {
                    const held = sampling.held ?? (sampling.held = []);

                    held.push(span);

                    if (held.length > MAX_HELD_SPANS_PER_TRACE) {
                        held.shift();
                    }
                }

                return;
            }

            this.emitSpan(span, sink);

            return;
        }

        // No LIVE `traceSampling` entry. Either a span from a self-anchored trace
        // (an alarm or subscription re-run mints its own anchor and never registers
        // one — those must export) or a LATE span whose dispatch already tore its
        // entry down in the `finally` (a streaming AI-SDK span, a detached hook).
        // Decide from the verdict snapshotted onto the span when it OPENED (the
        // `createTracedFetch`/`anchor.sampled` pattern) rather than the deleted
        // entry: a sampled-OUT late span is dropped (previously it fell through and
        // exported unconditionally, leaking an orphan child of a sampled-out trace),
        // a sampled-in one still exports.
        if (sampledSnapshot === false) {
            return;
        }

        this.emitSpan(span, sink);
    }

    /**
     * Hand one span to `sink.onSpan`, swallowing sink throws. The DO's `waitUntil`
     * is threaded so a network sink (otlpSink) can keep its export alive past the
     * response, matching the log path. Extracted so both the live-stream path in
     * {@link recordSpan} and the deferred error-keep flush in
     * {@link flushSampledOutTrace} share one guarded emit.
     */
    private emitSpan(span: SpanEvent, sink: TelemetrySink): void {
        if (!sink.onSpan) {
            return;
        }

        try {
            sink.onSpan(span, { waitUntil: this.shardHost.waitUntil });
        } catch {
            // A buggy span sink must not break the handler.
        }
    }

    /**
     * Export-boundary decision for a sampled-out trace, run from the dispatch
     * `finally` once the error status is known. A sampled-in trace already
     * streamed live, so this returns early for it; a sampled-out trace exports its
     * held `ctx.trace` spans only when `alwaysSampleErrors` is set AND the trace
     * errored (the dispatch threw, or a held span settled `ok: false`) — the tail
     * bias — and otherwise drops them. Held spans are drained from the per-trace
     * `held` array `recordSpan` accumulated (the synthetic dispatch root is never
     * held, since it never goes to `onSpan`) — NOT re-read from the shared span
     * ring, whose bound a concurrent trace could have used to evict these very
     * error spans before this flush ran.
     */
    private flushSampledOutTrace(trace: { traceId: string }, dispatchFailed: boolean): void {
        // Read THIS trace's own verdict + held sink (keyed by traceId), so an
        // interleaved sibling dispatch's state can't drop this trace's error spans.
        const sampling = this.traceSampling.get(trace.traceId);

        if (!sampling || sampling.sampled || !sampling.keepErrors) {
            return;
        }

        const { held, sink } = sampling;

        // Allocation-free short-circuit for the common sampled-out dispatch: no
        // sink, or nothing was held (a handler that never touched `ctx.trace`).
        if (!sink?.onSpan || held === undefined || held.length === 0) {
            return;
        }

        const traceHasError = dispatchFailed || held.some((span) => !span.ok);

        if (!traceHasError) {
            return;
        }

        for (const span of held) {
            this.emitSpan(span, sink);
        }
    }

    /**
     * Assemble the per-socket {@link LifecycleDispatchInfo} from its attachment:
     * the verified identity to replay and the {@link LifecycleEvent} the hooks
     * receive as their argument. `shardKey` is this DO's shard name.
     */
    private lifecycleInfo(attachment: SocketAttachment): LifecycleDispatchInfo {
        const event: LifecycleEvent = {
            connectionId: attachment.connectionId ?? "",
            shardKey: this.runner.shardKey ?? ROOT_SHARD_NAME,
            // eslint-disable-next-line unicorn/no-null -- LifecycleEvent.userId is `string | null`; null is the contractual anonymous sentinel mirrored on ctx.auth
            userId: attachment.userId ?? null,
            ...(attachment.context === undefined ? {} : { context: attachment.context }),
        };

        return { event, identity: attachment.identity, userId: attachment.userId };
    }

    /**
     * Run `fn` with the trusted-system flag set (restored afterwards), so an
     * internal function dispatched through `handleRpc` is permitted. Mirrors the
     * header-driven flag the worker's authorized path sets, without forging a
     * header. The single toggle primitive for lifecycle-hook dispatch.
     */
    private async withSystemDispatch<R>(run: () => Promise<R> | R): Promise<R> {
        const previous = this.currentRequestSystem;

        this.currentRequestSystem = true;

        try {
            return await run();
        } finally {
            this.currentRequestSystem = previous;
        }
    }

    /**
     * Emit a one-shot console warning when the `__root__` DO's SQLite file
     * crosses {@link ROOT_DO_SIZE_WARN_BYTES} (1 GiB = 10% of the per-DO
     * ceiling). We deliberately avoid throwing — apps should keep working;
     * the warning is the migration signal.
     */

    /**
     * Assemble the health snapshot served by `__lunora_admin__:getMetrics`:
     * lifetime request/error counts, the live SQLite size, and (when an opt-in
     * reactive cache is configured) its hit/miss stats.
     *
     * `requests`/`errors` now report the **durable** lifetime totals from the
     * `__lunora_metrics` table (source of truth) so they survive
     * hibernation/restart; the in-memory counters are used only as a fallback
     * when the durable read throws. The response is extended additively with
     * `functions` (per-function persisted rows), `history` (the coarse
     * time-series buckets), and `indexHits` (the per-`(table, index)` hit
     * counts) so the studio can read durable per-function metrics, chart
     * history, and feed the advisor dead-index lint without breaking existing
     * fields. `indexHits` is shaped exactly as the advisor's `AdvisorIndexHit`
     * (`{ table, index, reads }`), so the studio passes it straight to
     * `runLints({ ..., indexHits })` after summing the per-shard arrays.
     *
     * `subscriptionRefreshErrors` (DO-01) rides along the same way: an
     * in-memory-only lifetime count (no durable table, unlike `requests`/
     * `errors`), incremented by `recordSubscriptionRefreshError` whenever a live
     * query refresh or shape poke swallows a per-subscription error to protect
     * its siblings. The field is on the wire so it is queryable/testable now;
     * charting it in the studio's metrics panel is a follow-up.
     */
    private collectMetrics(): {
        cache: null | { bytes: number; entries: number; evictions: number; hits: number; misses: number };
        databaseSize: null | number;
        errors: number;
        functions: FunctionCallStat[];
        history: (FunctionMetricBucket & { path: string })[];

        /**
         * True when the durable bucket table held more rows than
         * {@link readFunctionMetricBuckets}'s read limit could return, so
         * `history` is a partial (newest) window rather than the app's full
         * retained history. Additive — absent on a worker predating the signal,
         * so an older studio build simply never renders the notice.
         */
        historyTruncated: boolean;
        indexHits: FunctionMetricIndexHit[];
        queryStats: QueryStatEntry[];
        requests: number;
        shard: string;
        sinceMs: number;
        subscriptionRefreshErrors: number;
        uptimeMs: number;
    } {
        const size = this.shardHost.sql.databaseSize;

        // Durable totals are the source of truth; fall back to the in-memory
        // counters only if the persisted read is unavailable.
        let { requests } = this.metrics;
        let { errors } = this.metrics;

        try {
            const totals = readFunctionMetricsTotals(this.shardHost.sql);

            requests = totals.requests;
            errors = totals.errors;
        } catch {
            // Keep the in-memory fallback already assigned above.
        }

        // Durable per-(table, index) hit counts for the dead-index lint.
        // Best-effort: a missing/unmigrated sql handle yields an empty feed
        // rather than failing the metrics read.
        let indexHits: FunctionMetricIndexHit[] = [];

        try {
            indexHits = readFunctionMetricIndexHits(this.shardHost.sql);
        } catch {
            // No durable index-hit table yet — report an empty feed.
        }

        // Per-statement query aggregates for the slow-query leaderboard.
        // Best-effort: a missing/unmigrated sql handle yields an empty feed
        // rather than failing the metrics read.
        let queryStats: QueryStatEntry[] = [];

        try {
            queryStats = readQueryMetrics(this.shardHost.sql);
        } catch {
            // No durable query-metrics table yet — report an empty feed.
        }

        const historyResult = this.collectFunctionMetricBuckets();

        return {
            // eslint-disable-next-line unicorn/no-null -- metrics wire shape: `cache` is `null | {...}`, null reported when the reactive cache is disabled
            cache: this.reactiveCache ? this.reactiveCache.stats() : null,
            // eslint-disable-next-line unicorn/no-null -- metrics wire shape: `databaseSize` is `null | number`, null when the runtime doesn't expose a size
            databaseSize: typeof size === "number" ? size : null,
            errors,
            functions: this.collectFunctionStats().functions,
            history: historyResult.buckets,
            historyTruncated: historyResult.truncated,
            indexHits,
            queryStats,
            requests,
            shard: this.runner.shardKey ?? ROOT_SHARD_NAME,
            sinceMs: this.metrics.sinceMs,
            subscriptionRefreshErrors: this.metrics.subscriptionRefreshErrors,
            uptimeMs: Date.now() - this.metrics.sinceMs,
        };
    }

    /**
     * Drop the durable global-shape and shape-poke-cursor baselines a closing
     * socket leaves behind. Leaving them orphans rows under a `connectionId`
     * that can never reconnect (a fresh upgrade mints a new id), slowly leaking
     * both tables — and an orphaned poke cursor also pins `minShapePokeCursor`,
     * and with it the CDC log's retention floor. No-op for a socket that never
     * recorded a connection id (it wrote no rows to begin with).
     *
     * Each delete is swallowed on its own: a stub `sql` handle or a
     * pre-migration shard has nothing durable to clean up, and neither may fail
     * the close path.
     */
    private purgeDurableSocketBaselines(connectionId: string | undefined): void {
        if (connectionId === undefined) {
            return;
        }

        try {
            deleteGlobalShapeSnapshotsForConnection(this.sql as SqlExec, connectionId);
        } catch {
            /* stub sql / missing table — nothing durable to clean up */
        }

        try {
            deleteShapePokeCursorsForConnection(this.sql as SqlExec, connectionId);
        } catch {
            /* stub sql / missing table — nothing durable to clean up */
        }
    }

    /**
     * Fold one dispatch into the per-function counters keyed by `functionPath`,
     * creating the entry on first sight. `errorMessage` is supplied only when
     * the handler threw, in which case the failure counters advance too. The
     * caller is expected to have already redacted `errorMessage` (via
     * `redactArgs`, the same `standardRules` treatment the request-log sinks
     * use) — this method persists/caches it verbatim into BOTH the durable
     * `__lunora_metrics.last_error_message` column and the in-memory
     * `functionStats.lastErrorMessage` served by `getFunctionStats`, so an
     * un-redacted message reaching here leaks into the Studio.
     * `scannedTables` carries the tables the dispatch full-scanned (collected by
     * `getCtxDbReadHook`), which advance the causal scan attribution.
     * `indexHits` carries the declared indexes it exercised (collected by
     * `getCtxDbIndexUseHook`, NUL-free `JSON.stringify([table, index])` keys),
     * which advance the durable `__lunora_metrics_index` hit counter behind the
     * dead-index lint. Called once per `/rpc` dispatch alongside the aggregate
     * `metrics` update.
     *
     * Two writes happen here. The in-memory {@link functionStats} map is kept
     * for the fast warm-instance path, and the durable `__lunora_metrics`
     * table is upserted so the counters survive hibernation/restart — the
     * persisted table is the source of truth the admin RPCs read from. The
     * persist is best-effort: a SQL failure (e.g. a test double without a
     * `sql` handle) must never turn a successful dispatch into a failed one,
     * so it is swallowed and the in-memory counters still advance.
     */
    private recordFunctionCall(
        functionPath: string,
        durationMs: number,
        errorMessage?: string,
        scannedTables?: ReadonlySet<string>,
        indexHits?: ReadonlySet<string>,
        conflicted: boolean = false,
    ): void {
        const now = Date.now();
        const scanned = scannedTables ? [...scannedTables] : [];
        // Each entry is a `JSON.stringify([table, index])` key stamped by the
        // index-use hook; decode back to `{ table, index }` for the durable
        // upsert. Skipped entirely when the dispatch used no declared index.
        const hits: IndexHit[] = indexHits ? [...indexHits].map((key) => decodeIndexHitKey(key)).filter((hit): hit is IndexHit => hit !== undefined) : [];

        // Durable upsert on the hot path: two PK-keyed INSERT…ON CONFLICT
        // statements plus a bounded bucket trim, plus one upsert per scanned
        // table and one per exercised index. Survives restart/hibernation.
        try {
            recordFunctionMetric(this.shardHost.sql, {
                conflicted,
                durationMs,
                errored: errorMessage !== undefined,
                errorMessage,
                indexHits: hits,
                path: functionPath,
                scannedTables: scanned,
                ts: now,
            });
        } catch {
            // Best-effort: never let metrics persistence fail the request.
        }

        const existing = this.functionStats.get(functionPath);
        const stat: FunctionCallStat = existing ?? {
            calls: 0,
            conflicts: 0,
            errors: 0,
            lastCalledAt: now,
            // eslint-disable-next-line unicorn/no-null -- wire shape: `null` until the function first throws
            lastErrorAt: null,
            // eslint-disable-next-line unicorn/no-null -- wire shape: `null` until the function first throws
            lastErrorMessage: null,
            maxDurationMs: 0,
            path: functionPath,
            scannedTables: [],
            scans: 0,
            totalDurationMs: 0,
        };

        stat.calls += 1;
        stat.totalDurationMs += durationMs;
        stat.maxDurationMs = Math.max(stat.maxDurationMs, durationMs);
        stat.lastCalledAt = now;

        // Fold the dispatch's full-scan attribution into the in-memory stat so
        // the warm-instance fallback (used when the durable read fails) carries
        // the causal data too — via the same `mergeScanAttribution` rule the
        // durable `__lunora_metrics_scans` upsert uses, so the two can't drift.
        if (scanned.length > 0) {
            stat.scans += scanned.length;
            mergeScanAttribution(stat.scannedTables, scanned);
        }

        if (errorMessage !== undefined) {
            stat.errors += 1;
            stat.lastErrorAt = now;
            stat.lastErrorMessage = errorMessage;
        }

        if (conflicted) {
            stat.conflicts += 1;
        }

        if (existing === undefined) {
            // Distinct-path cap, mirroring the durable twin's
            // `FUNCTION_METRICS_MAX_PATHS` admission rule: `functionPath` is
            // caller-controlled, and the recording paths that never resolve it
            // (the idempotency cache hit, the watermark short-circuit) can be
            // driven with a fresh path per request. Refuse the new path rather
            // than evict — protecting the incumbents is the reason the cap
            // exists, exactly as `admitPath` argues on the durable side.
            if (this.functionStats.size >= FUNCTION_METRICS_MAX_PATHS) {
                return;
            }

            this.functionStats.set(functionPath, stat);
        }
    }

    /**
     * Flush the per-DISTINCT-statement SQL samples accumulated during the
     * current dispatch into the durable `__lunora_metrics_queries` table.
     * Called after `recordFunctionCall` on both the success and error paths.
     *
     * Already folded by the instrumented `sql` getter (see
     * `currentStmtSamples`), so this pays exactly one `recordQueryMetric` call
     * — one accumulator upsert plus one bucket upsert — per distinct statement
     * the dispatch ran, however many times it actually ran. `count` carries the
     * real execution count through so the durable `exec_count`/`total_duration_ms`
     * still reflect every execution, not just one.
     *
     * Best-effort: a SQL failure (e.g. a test double without a usable `sql`
     * handle) must never fail the response, so every call is swallowed.
     * Clearing `currentStmtSamples` happens in the `finally` block of the
     * dispatch path, not here, so a partial flush (partial error) still
     * drains the correct slice.
     */
    private flushStmtSamples(): void {
        const samples = this.currentStmtSamples;

        if (!samples || samples.size === 0) {
            return;
        }

        try {
            const sqlHandle = this.shardHost.sql as unknown as SqlExec;

            for (const [rawSql, sample] of samples) {
                try {
                    recordQueryMetric(sqlHandle, rawSql, sample.totalDurationMs, sample.rowsRead, sample.rowsWritten, Date.now(), sample.count);
                } catch {
                    // Per-statement failures are swallowed so a bad statement
                    // never breaks the whole flush.
                }
            }
        } catch {
            // Best-effort: never let metrics persistence fail the request.
        }
    }

    /**
     * Assemble the per-function readout served by
     * `__lunora_admin__:getFunctionStats`, sorted most-recently-called first so
     * the busiest functions surface at the top of the studio table.
     *
     * Reads from the durable `__lunora_metrics` table — the source of truth —
     * so the counts reflect the function's lifetime, not just calls since this
     * instance woke. Falls back to the in-memory map only if the durable read
     * throws (e.g. a test double without a usable `sql` handle), keeping the
     * warm-instance counters available even then. The wire shape is unchanged
     * (`{ functions, sinceMs }`), so existing studio/runtime consumers keep
     * working; the rows are now backed by persisted data.
     */
    private collectFunctionStats(): FunctionStatsResult {
        try {
            const functions = readFunctionMetrics(this.shardHost.sql);

            return { functions, sinceMs: this.metrics.sinceMs };
        } catch {
            const functions = [...this.functionStats.values()].toSorted((a, b) => b.lastCalledAt - a.lastCalledAt);

            return { functions, sinceMs: this.metrics.sinceMs };
        }
    }

    /**
     * Per-function coarse time-series served additively by the metrics RPC, so
     * the studio can chart call/error history. Reads the durable
     * `__lunora_metrics_buckets` table; returns an empty, non-truncated result
     * when persistence is unavailable so the response stays well-formed.
     */
    private collectFunctionMetricBuckets(): FunctionMetricBucketsResult {
        try {
            return readFunctionMetricBuckets(this.shardHost.sql);
        } catch {
            return { buckets: [], truncated: false };
        }
    }

    private maybeWarnRootSize(): void {
        if (ShardDO.rootSizeWarned) {
            return;
        }

        const idName = this.runner.shardKey;

        if (idName !== ROOT_SHARD_NAME) {
            return;
        }

        const size = this.shardHost.sql.databaseSize;

        if (typeof size !== "number" || size < ROOT_DO_SIZE_WARN_BYTES) {
            return;
        }

        ShardDO.rootSizeWarned = true;
        // eslint-disable-next-line no-console -- intentional one-shot operational warning surfacing the __root__ DO approaching the 10 GiB ceiling
        console.warn(
            `[@lunora/do] __root__ Durable Object SQLite size is ${String(size)} bytes (>= 1 GiB, 10% of the 10 GiB per-DO ceiling). Plan a \`.shardBy()\` migration before you hit the wall. See https://lunora.sh/docs/concepts/sharding for guidance.`,
        );
    }

    /**
     * Map a thrown value to a JSON response. `ValidationError` from
     * `@lunora/values` becomes a 400 with code `VALIDATION_ERROR`. A
     * `LunoraError` keeps its declared status/code. Everything else becomes
     * a 500 with code `RPC_FAILED`.
     */
    // eslint-disable-next-line class-methods-use-this -- cohesive DO instance method (groups with the request handlers); kept non-static so subclasses can override the error mapping
    private errorToResponse(error: unknown): Response {
        // Delegate the envelope + redaction to the shared `toErrorBody` so this
        // edge applies the identical "internal-coded errors never echo their
        // message" invariant as the runtime/streaming edges. A non-internal
        // `LunoraError` (`ConflictError`, `NotFoundError`, `@lunora/server`'s
        // `LunoraError`, …) is echoed with its hint/docsUrl + wire-encoded data;
        // `isLunoraError` is structural, so this package takes no hard dep on the
        // packages that throw these.
        const { body, redacted, status } = toErrorBody(error, { encodeData: encodeWire, fallbackCode: "RPC_FAILED", redactedMessage: "internal error" });

        if (redacted) {
            // eslint-disable-next-line no-console -- server-side diagnostic for an internal/unhandled error
            console.error("[@lunora/do] internal error:", error);
        }

        return jsonResponse({ error: body }, status);
    }

    /**
     * Batch dispatch (plan 088). Applies each `calls[]` entry through the SAME
     * single-call `/rpc` path (via a nested `this.fetch`), **sequentially**, so
     * the per-`(identity, mutationId)` idempotency dedup and the per-client
     * `__client_watermark` ordering are enforced entry-by-entry exactly as for an
     * individual call — no duplication of the dispatch core, no reordering.
     *
     * Failures are **per-slot, not fail-fast**: an entry that throws (or a
     * custom-mutator `OUT_OF_ORDER` gap) is captured in its own result slot and
     * later entries still run. Ordering is still safe — a later same-client
     * mutator after a gap re-classifies as a gap too (the watermark never
     * advanced), so it cannot apply out of order; unrelated entries/queries are
     * independent. The response is `{ results: [{ id, status, body }] }` in
     * request order; each `body` is the untouched single-call envelope (its
     * `result` already wire-encoded), so the client demuxes + decodes each
     * exactly as one call.
     */
    private async handleBatchRpc(request: Request): Promise<Response> {
        let payload: { calls?: unknown };

        try {
            payload = await request.json();
        } catch {
            return jsonResponse({ error: { code: "BAD_REQUEST", message: "invalid JSON body" } }, 400);
        }

        if (!Array.isArray(payload.calls)) {
            return jsonResponse({ error: { code: "BAD_REQUEST", message: "batch `calls` must be an array" } }, 400);
        }

        // Defense-in-depth against a single request pinning this single-threaded
        // DO with a huge sequential loop (the worker caps this too).
        if (payload.calls.length > MAX_BATCH_ENTRIES) {
            return jsonResponse({ error: { code: "BAD_REQUEST", message: `batch exceeds the ${String(MAX_BATCH_ENTRIES)}-call limit` } }, 400);
        }

        const results: { body: unknown; id: unknown; status: number }[] = [];
        let latestBookmark: string | undefined;

        for (const raw of payload.calls) {
            // eslint-disable-next-line no-await-in-loop -- sequential BY DESIGN: preserves per-client watermark ordering + idempotency across the batch
            const outcome = await this.dispatchBatchEntry(request, raw as BatchEntry);

            if (outcome.bookmark !== undefined) {
                latestBookmark = outcome.bookmark;
            }

            results.push({ body: outcome.body, id: outcome.id, status: outcome.status });
        }

        return jsonResponse({ results }, 200, bookmarkHeaders(latestBookmark));
    }

    /** Dispatch one batch entry through the single-call `/rpc` path and capture its envelope (plan 088). */
    private async dispatchBatchEntry(
        batchRequest: Request,
        entry: BatchEntry,
    ): Promise<{ body: unknown; bookmark: string | undefined; id: unknown; status: number }> {
        try {
            const response = await this.fetch(buildBatchEntryRequest(batchRequest, entry));

            return { body: await response.json(), bookmark: response.headers.get("x-d1-bookmark") ?? undefined, id: entry.id, status: response.status };
        } catch (error: unknown) {
            // A malformed entry (non-object, or missing `functionPath`) makes the
            // per-entry request builder / the nested `/rpc` dispatch throw *before*
            // the single-call path's own try/catch. Contain it to this slot so one
            // bad entry can't 500 the whole batch (per-slot isolation is the contract).
            // Routed through `toErrorBody` so a genuine `LunoraError` still surfaces
            // its real code/status/message, while any other throw is redacted behind
            // the generic `BATCH_ENTRY_FAILED`/500 this slot always returned before.
            const { body, status } = toErrorBody(error, { fallbackCode: "BATCH_ENTRY_FAILED" });

            return {
                body: { error: body },
                bookmark: undefined,
                id: (entry as BatchEntry | null | undefined)?.id,
                status,
            };
        }
    }

    /**
     * Serve the writer-routed BULK row ops — `deleteRows`, `clearTable`,
     * `patchRows`. One seam rather than three arms of {@link handleAdminRpc}'s
     * dispatch chain, because all three share the same shape: parse a predicate,
     * run a bounded batch THROUGH the schema-aware writer, flush the touched
     * tables so live subscribers re-run, and audit the counts.
     *
     * The caller checks the three paths before calling, so this always answers.
     */
    private async handleBulkRowOp(functionPath: string, args: Record<string, unknown>): Promise<Response> {
        let applied = 0;

        // ONE meter for the whole batch, threaded by value into every per-row
        // `runShardWrite` — the same shape {@link ShardDO.pollTtlSweeps} uses for
        // its own many-rows-under-one-ceiling pass, and for the same reason.
        //
        // Letting each row fall through to the override's
        // `headroom ?? this.transactionHeadroom()` fallback minted a FRESH
        // tracker per row: up to {@link SHARD_BULK_ROW_CAP} allocations and, more
        // to the point, a ceiling that resets every row and therefore bounds
        // nothing. A bulk op is precisely the unbounded-work case the meter
        // exists for — 500 rows is where a clear-table can actually exhaust the
        // isolate — so it gets one budget, charged across the batch.
        const headroom = this.transactionHeadroom();

        try {
            // `clearTable` is `deleteRows` with no predicate — the same
            // writer-routed bounded loop, matching every row — so the two share an
            // arm and differ only in which parser reads the args and which verb the
            // audit carries. Neither resumes, so neither passes a cursor.
            const isClear = functionPath === ADMIN_FUNCTIONS.clearTable;

            if (isClear || functionPath === ADMIN_FUNCTIONS.deleteRows) {
                const parsed = isClear ? parseClearTableArgs(args) : parseBulkDeleteArgs(args);
                const result = await this.runShardBulkRowOp(parsed, async (id) => {
                    await this.runShardWrite({ id, op: "delete", table: parsed.table }, headroom);
                    applied += 1;
                });

                this.recordAudit(isClear ? "clearTable" : "deleteRows", { table: parsed.table, detail: { deleted: result.count, hasMore: result.hasMore } });

                return adminResponse(result);
            }

            const parsed = parseBulkPatchArgs(args);
            // Each row goes through `runShardWrite` — the same single-row seam the
            // studio's row editor uses — so the `.global()` guard, the validators
            // and the reactive invalidation apply unchanged and codegen needs no
            // second writer override.
            //
            // A row that vanished between the id scan and here is SKIPPED, not
            // fatal: the scan and the write are separated by an `await` per row, so
            // a concurrent client mutation, another operator, or this table's own
            // `.ttl()` sweep can remove one mid-batch. The delete arm is already
            // silent on a missing row (`writer.delete` is idempotent); this makes
            // the patch arm match rather than 500 on a routine race.
            const result = await this.runShardBulkRowOp(
                parsed,
                async (id) => {
                    try {
                        await this.runShardWrite({ doc: parsed.doc, id, op: "patch", table: parsed.table }, headroom);
                        applied += 1;
                    } catch (error) {
                        if (!(error instanceof LunoraError) || error.code !== "NOT_FOUND") {
                            throw error;
                        }
                    }
                },
                parsed.after,
            );

            // Field NAMES only — the patched values are operator data.
            this.recordAudit("patchRows", { table: parsed.table, detail: { fields: Object.keys(parsed.doc), hasMore: result.hasMore, patched: result.count } });

            return adminResponse(result);
        } catch (error) {
            // Rows applied before the throw are ALREADY COMMITTED (the writer
            // commits per row), so a privileged partial write still gets an audit
            // record — otherwise a batch that wrote 200 rows and then failed leaves
            // no trace at all.
            if (applied > 0) {
                this.recordAudit("bulkRowOpFailed", { table: typeof args["table"] === "string" ? args["table"] : undefined, detail: { applied } });
            }

            throw error;
        } finally {
            // Flushed here, alongside every other admin arm's flush, and on the
            // failure path too: without it the tables a partial batch touched stay
            // un-drained and live subscribers keep serving pre-write values until
            // some unrelated later write happens to flush them.
            //
            // Swallowed rather than awaited bare: a flush rejection would REPLACE
            // the per-row error above, losing which row actually failed.
            await this.flushChangedTables().catch((flushError: unknown) => {
                this.recordShapeError("bulkRowOp:flush", flushError);
            });
        }
    }

    /**
     * Serve a reserved admin-introspection RPC (`__lunora_admin__:*`) for the
     * data browser. Gated by `env.LUNORA_ADMIN_TOKEN`: introspection is
     * **disabled unless the token is configured**, and when it is, the request
     * must present a matching `Authorization: Bearer` header. The blast radius
     * is raw table contents, so the default is closed — unlike the WebSocket
     * upgrade gate, which defaults open for local dev.
     */
    private async handleAdminRpc(request: Request, functionPath: string, rawArgs: Record<string, unknown>): Promise<Response> {
        if (!this.isAdminAuthorized(request)) {
            return jsonResponse({ error: { code: "ADMIN_FORBIDDEN", message: "admin introspection is disabled or the bearer token is invalid" } }, 403);
        }

        try {
            const args = decodeAdminArgs(rawArgs);

            // Read-only introspection ops share their logic with the WS
            // subscription bridge (see readAdminOp / executeAdminSubscription),
            // so a live subscriber and a one-shot POST observe the same shape.
            const read = this.readAdminOp(functionPath, args);

            if (read) {
                return adminResponse(read.result);
            }

            if (functionPath === ADMIN_FUNCTIONS.runMigration) {
                const parsed = parseRunMigrationArgs(args);
                const result = await this.runShardDataMigration(parsed);

                // The migration rewrites rows through the writer, which records
                // the touched tables; flush so live subscribers re-run against
                // the new values. No-op on a dryRun (nothing was written).
                await this.flushChangedTables();

                this.recordAudit("runMigration", {
                    id: parsed.id,
                    detail: { changed: result.changed, direction: result.direction, dryRun: result.dryRun, processed: result.processed },
                });

                return adminResponse(result);
            }

            if (functionPath === ADMIN_FUNCTIONS.exportShard) {
                const parsed = parseExportShardArgs(args);

                // The export reads through the writer; producing a streaming
                // body would require coordinating with the worker's
                // `ReadableStream`. We instead materialize the rows here and
                // let the worker stitch shard responses into one NDJSON stream
                // — each shard's JSON envelope is small (bounded by
                // `batchSize` × tables) and the worker pipes them serially.
                const rows = await this.runShardExport({ batchSize: parsed.batchSize, tables: parsed.tables });

                return adminResponse({ rows });
            }

            if (functionPath === ADMIN_FUNCTIONS.importShard) {
                const parsed = parseImportShardArgs(args);
                const result = await this.runShardImport({ rows: parsed.rows, startLine: parsed.startLine });

                // The import inserts rows through the writer, which records
                // touched tables; flush so live subscribers re-run.
                await this.flushChangedTables();

                this.recordAudit("importShard", { detail: { conflicts: result.conflicts, errors: result.errors.length, inserted: result.inserted } });

                return adminResponse(result);
            }

            if (functionPath === ADMIN_FUNCTIONS.writeRow) {
                const parsed = parseWriteRowArgs(args);
                const result = await this.runShardWrite(parsed);

                // The write went through the writer, which records the touched
                // table; flush so live subscribers re-run against the new value.
                await this.flushChangedTables();

                this.recordAudit("writeRow", { table: parsed.table, id: result.id ?? parsed.id, detail: { op: result.op } });

                return adminResponse(result);
            }

            if (functionPath === ADMIN_FUNCTIONS.deleteRows || functionPath === ADMIN_FUNCTIONS.clearTable || functionPath === ADMIN_FUNCTIONS.patchRows) {
                return await this.handleBulkRowOp(functionPath, args);
            }

            if (functionPath === ADMIN_FUNCTIONS.rankBefore) {
                // Read-only: counts rows preceding `rowId` in the partition. No
                // writer mutation, so nothing to flush — the cross-shard
                // coordinator sums the `{before, total}` from every shard.
                const result = await this.runShardRankBefore(parseRankBeforeArgs(args));

                return adminResponse(result);
            }

            if (functionPath === ADMIN_FUNCTIONS.rankPage) {
                // Read-only: this shard's local ranked slice, each row tagged
                // with its rank-key tuple. No writer mutation, so nothing to
                // flush — the cross-shard coordinator k-way merges the
                // `{ rows, hasMore }` slices from every shard into one page.
                const result = await this.runShardRankPage(parseRankPageArgs(args));

                return adminResponse(result);
            }

            if (functionPath === ADMIN_FUNCTIONS.cdcSync) {
                // Read-only: page this shard's change-data-capture log past the
                // caller's per-shard cursor. The coordinator collects each
                // shard's `{ changes, cursor }` into one streaming-export batch.
                const result = await this.cdcSyncPage(parseCdcSyncArgs(args));

                return adminResponse(result);
            }

            if (functionPath === ADMIN_FUNCTIONS.applyCdc) {
                // Replay a CDC batch into this shard (point-in-time recovery).
                // The writer mutates rows, so flush touched tables afterward.
                const result = await this.runShardApplyCdc(parseApplyCdcArgs(args));

                await this.flushChangedTables();

                this.recordAudit("applyCdc", { detail: { applied: result.applied } });

                return adminResponse(result);
            }

            if (functionPath === ADMIN_FUNCTIONS.runAs) {
                return this.handleRunAs(args);
            }

            const handled = await this.handleExtraAdminOp(functionPath, args);

            if (handled) {
                return handled;
            }

            return jsonResponse({ error: { code: "UNKNOWN_ADMIN_OP", message: `unknown admin op: ${functionPath}` } }, 404);
        } catch (error: unknown) {
            return this.errorToResponse(error);
        }
    }

    /**
     * Dispatch the side-effecting / non-read admin ops that `handleAdminRpc`
     * doesn't handle inline: the auth-event + mail-capture writes, the search
     * backfill, and the native PITR ops. Returns the op's `Response`, or `undefined` when `functionPath`
     * isn't one of these (so the caller answers 404). Kept out of
     * `handleAdminRpc` to hold that dispatcher under the complexity budget,
     * mirroring `handlePitrAdminOp`.
     */
    private async handleExtraAdminOp(functionPath: string, args: Record<string, unknown>): Promise<Response | undefined> {
        // One `path → handler` lookup rather than an arm per op: each of these is
        // the same shape (take the decoded args, answer a Response), and growing
        // the chain by one `if` per new op is what pushed this dispatcher past
        // its complexity budget.
        const handler = this.simpleAdminHandlers()[functionPath];

        if (handler !== undefined) {
            return handler(args);
        }

        // The three AI-assistant writes share one shape (parse → call → audit →
        // respond), so they dispatch from a map rather than three more arms.
        const aiHandler = this.aiAdminHandlers()[functionPath];

        if (aiHandler !== undefined) {
            return aiHandler(args);
        }

        const triaged = await this.handleIssueTriageOp(functionPath, args);

        if (triaged !== undefined) {
            return triaged;
        }

        // `??` rather than another `if` arm: this method is a long dispatch chain
        // held deliberately at the complexity budget, and each additional arm costs
        // against it (which is why `handleIssueTriageOp` / `handleInspectAdminOp` /
        // `handlePitrAdminOp` exist at all).
        return this.handleInspectAdminOp(functionPath) ?? this.handlePitrAdminOp(functionPath, args);
    }

    /**
     * Serve the argument-free, read-only inspection reads. A sibling of
     * {@link ShardDO.handleIssueTriageOp} / {@link ShardDO.handlePitrAdminOp} for
     * the same reason they exist: `handleExtraAdminOp` is a long `functionPath`
     * chain, and every arm added to it costs a point of cognitive complexity
     * against that method's budget.
     *
     * Synchronous, unlike its siblings — nothing here awaits, because these reads
     * touch only this shard's own SQLite. Returns `undefined` for any path it does
     * not own so the caller keeps walking the chain.
     */
    private handleInspectAdminOp(functionPath: string): Response | undefined {
        if (functionPath === ADMIN_FUNCTIONS.listReactors) {
            return this.handleListReactors();
        }

        return undefined;
    }

    /**
     * Serve the four Issue-triage admin writes — `resolveIssue` / `ignoreIssue`
     * (a status change), `assignIssue` (set/clear an owner), `setIssueSeverity`
     * (tag/clear severity). Each upserts one row in the reserved
     * `__lunora_issue_state__` side table keyed by the Issue's fingerprint
     * `hash`, then re-derives at read time in {@link readErrorIssues}. Returns
     * `undefined` for any path it doesn't own so `handleExtraAdminOp` falls
     * through. Admin-gated by `handleAdminRpc`'s caller (the `LUNORA_ADMIN_TOKEN`
     * bearer); a bad/missing `hash` (or a bad status/severity value) is a 400.
     *
     * The write lands through raw SQL the change-tracker can't observe, so it
     * marks {@link ISSUE_STATE_TABLE} changed and flushes — the live Issues
     * subscription is an admin-wildcard memo that re-runs whenever a flush finds
     * a changed table, so the triage shows up without an unrelated write.
     */
    private async handleIssueTriageOp(functionPath: string, args: Record<string, unknown>): Promise<Response | undefined> {
        const patch = this.parseIssueTriagePatch(functionPath, args);

        if (patch === undefined) {
            return undefined;
        }

        const hash = parseIssueHash(args);
        const updatedBy = typeof args["updatedBy"] === "string" ? args["updatedBy"] : undefined;
        const sql = this.shardHost.sql as unknown as SqlExec;
        const state: IssueState = upsertIssueState(sql, hash, patch, Date.now(), updatedBy);

        this.recordChangedTable(ISSUE_STATE_TABLE);
        await this.flushChangedTables();

        this.recordAudit(functionPath.slice(ADMIN_FUNCTION_PREFIX.length), { detail: { ...patch, hash } });

        return adminResponse({ state });
    }

    /**
     * Map an Issue-triage admin path to the `IssueStatePatch` it applies, or
     * `undefined` when the path isn't a triage write. `assignIssue`/
     * `setIssueSeverity` accept an explicit `null` to CLEAR the field (unassign /
     * untag); a missing or malformed value is a 400 rather than a silent no-op.
     */
    // eslint-disable-next-line class-methods-use-this -- kept an instance method for symmetry with the other `parse*`/handler seams
    private parseIssueTriagePatch(functionPath: string, args: Record<string, unknown>): IssueStatePatch | undefined {
        if (functionPath === ADMIN_FUNCTIONS.resolveIssue) {
            return { status: "resolved" };
        }

        if (functionPath === ADMIN_FUNCTIONS.ignoreIssue) {
            return { status: "ignored" };
        }

        if (functionPath === ADMIN_FUNCTIONS.assignIssue) {
            // Assigning implicitly reopens (someone owns it now); the two moves stay one round-trip.
            return { assignee: parseAssigneeArgument(args), status: "open" };
        }

        if (functionPath === ADMIN_FUNCTIONS.setIssueSeverity) {
            return { severity: parseSeverityArgument(args) };
        }

        return undefined;
    }

    /**
     * `__lunora_admin__:backfillSearch` — index the rows that predate this
     * shard's `.searchIndex()` declarations, `maxPages` pages at a time.
     *
     * Bounded rather than run-to-completion because a DO request has a CPU and
     * wall-clock budget, and the tables `staged: true` exists for are precisely
     * the ones a single unbounded walk cannot finish. Progress is durable, so an
     * operator drives it with repeated calls until `done` — `lunora run
     * '__lunora_admin__:backfillSearch' --args '{"maxPages":20}'` needs no new
     * CLI surface. Admin-gated by `handleAdminRpc`'s caller.
     */
    private handleBackfillSearch(args: Record<string, unknown>): Response {
        const raw = args["maxPages"];

        // ABSENT means "no cap" — a small shard finishes in one call. A PRESENT
        // but unusable value is a 400, not a silent uncapping: `{"maxPages":"20
        // pages"}`, `0`, and `-1` all used to read as "run to completion", which
        // is the opposite of what the caller asked for and does it on exactly the
        // tables `staged: true` exists for because they cannot be walked in one
        // request. Same reason the retention knobs parse strictly (`env-int.ts`):
        // a lenient read of an operator's typo does the destructive thing quietly.
        let maxPages: number | undefined;

        if (raw !== undefined) {
            const parsed = typeof raw === "number" ? raw : Number(raw);

            if (!Number.isFinite(parsed) || parsed < 1) {
                return jsonResponse(
                    { error: { code: "BAD_REQUEST", message: "backfillSearch: maxPages must be a positive integer, or omitted to run to completion" } },
                    400,
                );
            }

            maxPages = Math.floor(parsed);
        }

        const result = this.runShardSearchBackfill(maxPages === undefined ? {} : { maxPages });

        this.recordAudit("backfillSearch", { detail: { done: result.done, pages: result.pages } });

        return adminResponse(result);
    }

    /**
     * Record one app-level auth attempt for the auth-failure SLO (PLAN3 §2.3).
     * The worker calls this fire-and-forget (via `waitUntil`) after a top-level
     * `/api/auth/*` ATTEMPT route returns, so it never blocks or fails the auth
     * response. `outcome` is validated up front (400 `BAD_REQUEST` on a bad
     * value); the durable upsert itself is best-effort — a SQL failure is
     * swallowed so the SLO signal is simply absent rather than turning the
     * recording call into an error. Admin-gated by `handleAdminRpc`'s caller.
     */
    private handleRecordAuthEvent(args: Record<string, unknown>): Response {
        const parsed = parseRecordAuthEventArgs(args);

        try {
            recordAuthEvent(this.shardHost.sql, { outcome: parsed.outcome, ts: Date.now() });
        } catch {
            // Best-effort: a metrics write must never fail the call.
        }

        return adminResponse({ recorded: true });
    }

    /**
     * Append one container lifecycle event to the in-memory {@link LogBuffer}
     * the `getLogs` admin RPC reads, so a start/stop/error on a Container DO
     * surfaces in the Studio Logs panel — not just the dev terminal. The
     * Container DO pushes this best-effort (its `console` print stays the source
     * of truth), so a missing/garbage envelope is rejected up front (400) rather
     * than corrupting the buffer. Mapped to `functionPath: "container:<name>"` so
     * the panel renders it alongside `ctx.log` lines. Admin-gated by
     * `handleAdminRpc`'s caller (the same `LUNORA_ADMIN_TOKEN` bearer as every
     * other admin write).
     *
     * An `error`-level lifecycle event (a crash/`onError`, or a non-zero-exit
     * `stop`) is ALSO appended as an `error`-outcome row to the durable
     * `__lunora_reqlog__` — the same readout `getIssues` groups over — so a
     * crash-looping container folds into the Issues list right beside Worker
     * errors (they share the `fingerprintError` hash over `functionPath ::
     * bucket(message)`). The in-memory buffer stays the live Logs feed; the
     * durable row is what survives hibernation for triage.
     */
    private async handleRecordContainerEvent(args: Record<string, unknown>): Promise<Response> {
        const entry = parseRecordContainerEventArgs(args);

        this.logs.push(entry);

        // A crash is either an explicit `error`-level event (an `onError`) OR a
        // `stop` that exited non-zero — the normal crash-loop signal. The exit
        // code rides the `stop` message as `(exit <n>)` and is parsed onto
        // `entry.exitCode`; a `stop` is always `level: "info"`, so without the
        // exit-code arm the common crash path would never fold into Issues (only
        // `onError` would), contradicting this method's contract.
        const crashed = entry.level === "error" || (entry.exitCode !== undefined && entry.exitCode !== 0);

        if (crashed) {
            const logEntry: AppendRequestLogEntry = {
                durationMs: 0,
                errorMessage: entry.message,
                functionPath: entry.functionPath,
                outcome: "error",
                shardKey: this.runner.shardKey,
                ts: entry.timestamp,
            };

            // Shared seam with `recordRequestLog` — persists the durable row AND
            // streams the Logpush event, so a container crash reaches external
            // sinks like every other error (best-effort throughout).
            this.persistRequestLog(logEntry, this.requestLogConfig());

            // The row lands through raw SQL the change-tracker can't observe, and
            // a container push carries no other write — so without this the live
            // `getIssues`/`getLogs` subscriptions (admin-wildcard memos, re-run
            // only when a flush finds a changed table) would show the crash only
            // once some unrelated write happened to flush.
            this.recordChangedTable(REQUEST_LOG_TABLE);
            await this.flushChangedTables();
        }

        return adminResponse({ recorded: true });
    }

    /**
     * Serve the `__lunora_admin__:runAs` admin RPC — the studio's "Run as
     * identity" tool. Dispatches the target `functionPath` through the normal
     * `handleRpc` path while the per-request identity is forged to the supplied
     * `userId`/`identity`, so the function (and any RLS middleware it uses)
     * observes that user instead of the admin caller.
     *
     * SECURITY. This op is reachable only after `handleAdminRpc`'s
     * `isAdminAuthorized` bearer check (the `LUNORA_ADMIN_TOKEN` gate), so an
     * unauthenticated caller can never forge an identity. The inbound
     * `x-lunora-userid`/`x-lunora-identity` headers the runtime sets are
     * overwritten here for the duration of the dispatch and restored after, so
     * the forge can't leak into a later request. The target path is validated to
     * be a non-admin function, so it can't be used to re-enter the admin plane.
     * And the dispatch runs under the admin plane's own request scope
     * ({@link ShardDO.withAdminRequestScope}) — the identity is the only thing
     * forged here, never the system flag or the mutation-replay fields, which
     * would otherwise be whatever a concurrent `/rpc` happened to leave behind.
     *
     * Callers: the studio surfaces it behind a loopback-dev gate (`runAsIdentity`),
     * and `lunora run --as` dispatches through it from the CLI. That gate was
     * always UI-only — the server-side authority is, and remains, the admin
     * bearer check above.
     */
    private async handleRunAs(args: Record<string, unknown>): Promise<Response> {
        const parsed = parseRunAsArgs(args);

        const result = await this.withRequestIdentity(parsed.userId, parsed.identity, () => this.handleRpc(parsed.functionPath, parsed.args));

        // The forged dispatch may have written through the writer (a mutation run
        // as the user); flush touched tables so live subscribers re-run, matching
        // the normal `/rpc` dispatch path.
        await this.flushChangedTables();

        this.recordAudit("runAs", { detail: { functionPath: parsed.functionPath, runAsUserId: parsed.userId } });

        return adminResponse(result);
    }

    /* eslint-disable no-secrets/no-secrets -- reserved admin RPC names are framework constants, not credentials */

    /**
     * Resolve a declared workflow's runtime binding handle from this shard's `env`.
     * Looks the `exportName` up in {@link workflowsMetadata} (the codegen subclass's
     * statically-discovered list) to find its generated `WORKFLOW_*` binding, then
     * reads `env[binding]` and validates it carries the `create`/`get` methods. A
     * bad export name or a missing/malformed binding throws a 400 `LunoraError` so
     * the studio surfaces an actionable message instead of a generic 500.
     */
    private resolveWorkflowBinding(exportName: string): WorkflowBindingHandle {
        const metadata = this.workflowsMetadata().workflows.find((workflow) => workflow.exportName === exportName);

        if (!metadata) {
            throw new LunoraError("BAD_REQUEST", `workflow "${exportName}" is not declared`);
        }

        const binding = (this.env as Record<string, unknown> | undefined)?.[metadata.binding];

        if (
            typeof binding !== "object" ||
            binding === null ||
            typeof (binding as WorkflowBindingHandle).create !== "function" ||
            typeof (binding as WorkflowBindingHandle).get !== "function"
        ) {
            throw new LunoraError("BAD_REQUEST", `workflow binding "${metadata.binding}" is not available on this deployment`);
        }

        return binding as WorkflowBindingHandle;
    }

    /**
     * Serve `__lunora_admin__:createWorkflowInstance` — the studio's "Start
     * instance" button. Resolves the declared workflow's `WORKFLOW_*` binding and
     * calls `.create({ id?, params })`, returning the new instance's id and initial
     * status. No SQLite write happens (workflows are not Durable Objects and hold
     * no shard state), so this only records an audit entry — there's nothing to
     * flush. Admin-gated by `handleAdminRpc`'s caller.
     */
    private async handleCreateWorkflowInstance(args: Record<string, unknown>): Promise<Response> {
        const parsed = parseCreateWorkflowInstanceArgs(args);
        const binding = this.resolveWorkflowBinding(parsed.exportName);

        const instance = await binding.create({ id: parsed.id, params: parsed.params });
        const snapshot = await instance.status();
        const result: CreateWorkflowInstanceResult = { id: instance.id, status: toWorkflowInstanceState(snapshot.status) };

        this.recordAudit("createWorkflowInstance", { id: instance.id, detail: { exportName: parsed.exportName } });

        return adminResponse(result);
    }

    /**
     * Serve `__lunora_admin__:getWorkflowInstanceStatus` — the studio's instance
     * observer. Resolves the workflow binding, fetches the instance handle by id,
     * and reports its current status plus output/error when present. Read-only:
     * inspecting an instance mutates no shard state, so nothing is flushed or
     * audited. Admin-gated by `handleAdminRpc`'s caller.
     */
    private async handleGetWorkflowInstanceStatus(args: Record<string, unknown>): Promise<Response> {
        const parsed = parseGetWorkflowInstanceStatusArgs(args);
        const binding = this.resolveWorkflowBinding(parsed.exportName);

        const instance = await binding.get(parsed.id);
        const snapshot = await instance.status();
        const result: WorkflowInstanceStatusResult = {
            error: toWorkflowInstanceError(snapshot.error),
            id: parsed.id,
            output: snapshot.output,
            status: toWorkflowInstanceState(snapshot.status),
        };

        return adminResponse(result);
    }
    /* eslint-enable no-secrets/no-secrets */

    /**
     * Run one reactor dispatch and record what it did.
     *
     * Split out of {@link ShardDO.dispatchReactors} so that loop stays inside the
     * complexity budget. The three-way split is the contract: a successful
     * dispatch advances the baseline AND a counter, a failure advances only the
     * counter (its baseline must stay put so the next flush retries it), and BOTH
     * flush afterwards.
     */
    private async dispatchOneReactor(sqlHandle: SqlExec, path: string, previousDigest: string | undefined): Promise<void> {
        try {
            const outcome = await this.runReactor(path, previousDigest);

            if (outcome !== undefined) {
                writeReactorState(sqlHandle, path, {
                    digest: outcome.digest,
                    now: Date.now(),
                    // `ran` distinguishes the two non-failure outcomes an operator
                    // needs to tell apart: the handler fired, or `select` re-ran and
                    // the digest matched so it did not. A high suppressed:runs ratio
                    // is the signal that a reactor is watching more than it needs to.
                    result: outcome.ran ? "ran" : "suppressed",
                    // The sentinel is stripped for the same reason the delta frame
                    // strips it (see `pushSubscriptionDelta`): `tables` is persisted
                    // in `__reactor_state` and rendered as the reactor's watched-table
                    // list in the Studio, so a reactor that read `ctx.kv` would show an
                    // internal marker to an operator. Inert either way —
                    // `reactorNeedsRun` intersects against a changed-table set the
                    // sentinel can never be in — but it is not a name to publish.
                    tables: outcome.tables.filter((dep) => dep !== UNVOUCHABLE_DEP),
                });
            }
        } catch (error: unknown) {
            // Report FIRST. The counter write below goes through `runDrizzle` and
            // throws on a SQL failure — and a reactor that threw because storage is
            // unhealthy is exactly the condition that makes this bookkeeping write
            // fail too. Ordered the other way, that second throw would swallow the
            // reason the reactor failed, escape `dispatchReactors`, and abort the
            // whole refresh drain mid-loop.
            this.recordReactorError(path, error);

            // Baseline deliberately NOT advanced — a reactor that threw has not
            // observed this result, so the next flush must offer it again — but the
            // counter and message ARE recorded, which is the whole reason
            // `writeReactorState` takes an outcome rather than a row.
            //
            // Best-effort, like every other durable bookkeeping write on a
            // background path here (`persistIdempotentResult`, `saveShapePokeCursor`,
            // `saveGlobalSnapshot`): losing a counter is not worth failing the drain
            // that other reactors and every live subscriber are waiting on.
            try {
                writeReactorState(sqlHandle, path, {
                    error: error instanceof Error ? error.message : String(error),
                    now: Date.now(),
                    result: "error",
                });
            } catch (writeError: unknown) {
                this.recordReactorError(path, writeError);
            }
        } finally {
            // A reactor's handler writes through `ctx.db`, which only STAGES the
            // touched tables (`recordChangedTable`) — the request path is what
            // normally flushes them, and a reactor has no request. Without this, a
            // reactor's writes would sit unflushed until some unrelated RPC came
            // along: no subscriber would see them, and the cascade that lets an
            // actor advance a state machine would never happen.
            //
            // Safe inside the drain: `flushChangedTables` sees `refreshInFlight` and
            // merges into THIS drain's pending set rather than starting a second one,
            // so the loop simply gets another pass. In the `catch` case the reactor's
            // transaction already rolled back, so at worst this stages a table whose
            // re-run finds nothing changed — the same outcome a failed RPC mutation
            // produces today.
            await this.flushChangedTables();
        }
    }

    /**
     * Claim one run against a reactor's per-drain convergence budget.
     *
     * Split out of {@link ShardDO.dispatchReactors} so that loop stays inside the
     * complexity budget, and because the "log exactly once" bookkeeping is fiddly
     * enough to deserve naming: the counter is advanced one step PAST the ceiling
     * on the first refusal, so the error is recorded once per drain rather than on
     * every subsequent pass — a non-converging reactor would otherwise flood the
     * very log ring that reports it.
     * @returns `true` when the reactor may run; `false` when its budget is spent.
     */
    private claimReactorBudget(path: string, runs: Map<string, number>): boolean {
        const used = runs.get(path) ?? 0;

        if (used < ShardDO.MAX_REACTOR_RUNS_PER_DRAIN) {
            runs.set(path, used + 1);

            return true;
        }

        if (used === ShardDO.MAX_REACTOR_RUNS_PER_DRAIN) {
            runs.set(path, used + 1);
            this.recordReactorError(
                path,
                new Error(
                    `reactor did not converge: ran ${String(ShardDO.MAX_REACTOR_RUNS_PER_DRAIN)} times in one refresh drain and its watched read kept changing. Its handler is rewriting what its own select observes; stopped for this drain.`,
                ),
            );
        }

        return false;
    }

    /**
     * Serve `__lunora_admin__:listReactors` — the studio's read-only Reactors
     * panel.
     *
     * Joins the generated manifest against `__reactor_state` rather than reading
     * either alone. The manifest alone cannot say whether a reactor is doing
     * anything; the state table alone cannot show a reactor that has been
     * declared but never dispatched — and "declared, never run" is exactly the
     * state an operator is looking for when a reactor appears not to work. The
     * join makes both visible, with the manifest as the authoritative roster.
     *
     * Read-only: a reactor listing mutates no shard state, so nothing is flushed
     * or audited. Admin-gated by `handleAdminRpc`'s caller.
     */
    private handleListReactors(): Response {
        const states = new Map<string, ReactorState>(listReactorStates(this.sql as SqlExec).map((entry) => [entry.path, entry.state] as const));

        // Named `stored` rather than `state` because `ShardDO.state` is the Durable
        // Object handle, and the row also carries a `state` FIELD in the response.
        const reactors: ReactorMetadata[] = this.lifecycleHookPaths("reactor").map((path) => {
            const stored = states.get(path);

            if (stored === undefined) {
                return { errors: 0, path, runs: 0, state: "idle", suppressed: 0 };
            }

            return {
                errors: stored.stats.errors,
                ...(stored.lastError === undefined ? {} : { lastError: stored.lastError }),
                ...(stored.lastRanAt === 0 ? {} : { lastRanAt: stored.lastRanAt }),
                path,
                runs: stored.stats.runs,
                // `failing` reads the LAST dispatch, not the lifetime count: a
                // reactor that failed once a week ago and has run cleanly since is
                // active, not failing. `lastError` is retained either way so the
                // panel can still show what went wrong.
                state: stored.lastError === undefined ? "active" : "failing",
                suppressed: stored.stats.suppressed,
                ...(stored.tables === undefined ? {} : { tables: stored.tables }),
            };
        });

        return adminResponse({ reactors });
    }

    /**
     * Serve `__lunora_admin__:listFlags` — the studio's read-only Flags page.
     * Evaluates every statically-discovered feature flag under an optional
     * `args.context` targeting context (the studio's editable context editor)
     * via the {@link evaluateFlags} hook, which the codegen subclass overrides
     * with live OpenFeature evaluation. Read-only: a flag lookup mutates no shard
     * state, so nothing is flushed or audited. Admin-gated by `handleAdminRpc`'s
     * caller.
     */
    private async handleListFlags(args: Record<string, unknown>): Promise<Response> {
        const rawContext = args.context;
        const context =
            typeof rawContext === "object" && rawContext !== null && !Array.isArray(rawContext) ? (rawContext as Record<string, unknown>) : undefined;
        const result = await this.evaluateFlags(context);

        return adminResponse(result);
    }

    /**
     * Run the admin plane's `run()` under its OWN per-request scope, restoring
     * whatever was there on the way out.
     *
     * The admin branch of `fetch` returns before `beginDispatch`, so every field
     * that call would have stamped is left holding the last `/rpc`'s values. Two
     * of them are load-bearing. `currentRequestSystem` is the flag the generated
     * `handleRpc` gates `internal` functions on (`registered.visibility ===
     * "internal" && !this.isSystemDispatch()`), and `runAs` dispatches straight
     * through that gate — so an `x-lunora-system: 1` request that is parked on an
     * await while an admin call arrives lends it the system bit. The replay fields
     * (`currentRequestMutationId` / `currentRequestClientId` / `currentMutatorClass`)
     * are the other: `commitMutationBookkeeping` reads them off `this`, so a
     * mutation dispatched through `runAs` could commit a dedup row and advance a
     * client watermark under the parked request's identity.
     *
     * Restoring rather than clearing on exit is deliberate: an admin call is a
     * guest on a thread another dispatch may own, and clearing would take that
     * dispatch's scope with it. (The `/rpc` tail re-pins its own scope after every
     * await regardless — see `captureRequestScope`'s call site.)
     *
     * The gate is the admin bearer token either way, which already permits
     * `runSql`/`writeRow`/`clearTable`; this closes a gate that does not hold, not
     * a path past the trust boundary.
     */
    private async withAdminRequestScope<R>(run: () => Promise<R>): Promise<R> {
        const previousScope = this.captureRequestScope();
        const previousIdentity = this.currentRequestIdentity;
        const previousBookkeeping = this.mutationBookkeeping;

        this.currentRequestBookmark = undefined;
        this.currentResponseBookmark = undefined;
        this.currentRequestUserId = undefined;
        this.currentRequestIdentity = undefined;
        this.currentRequestClientId = undefined;
        this.currentRequestClientSeq = undefined;
        this.currentRequestMutationId = undefined;
        this.currentMutatorClass = undefined;
        this.mutationBookkeeping = undefined;
        this.currentRequestSystem = false;

        try {
            return await run();
        } finally {
            this.restoreRequestScope(previousScope);
            this.currentRequestIdentity = previousIdentity;
            this.mutationBookkeeping = previousBookkeeping;
        }
    }

    /**
     * Run `run()` with the per-request identity pinned to (`userId`, `identity`),
     * then restore the prior values in a `finally` (even if `run()` throws), so the
     * forced identity can never leak into a later dispatch on this DO instance. The
     * generated `buildCtx` reads identity via `getCurrentUserId`/`getCurrentIdentity`,
     * so pinning the fields around the call makes the dispatched function observe the
     * chosen identity without threading it through the generated signature.
     *
     * Two callers, and they do NOT share a safety argument.
     *
     * {@link handleRunAs} (pins a forged user — the dev "Run as identity" tool)
     * runs synchronously on the request thread with no intervening concurrent
     * dispatch, so the shared field is uncontended for its whole window.
     *
     * {@link dispatchLifecycle} runs from `webSocketClose` (a hibernation close
     * handler that carries no request of its own) and from the `connect`
     * envelope — exactly the deferred/interleaved contexts where a concurrent
     * `/rpc` CAN interleave. What keeps it correct today is downstream, not here:
     * the generated `buildCtx` reads `getCurrentUserId`/`getCurrentIdentity`
     * synchronously when it constructs the ctx, and the `/rpc` tail re-pins the
     * request scope after its own await. A hook path that read the field back
     * after an await would observe the other dispatch's identity, and the
     * `finally` here would then restore values captured before that interleaving.
     *
     * Subscriptions deliberately do NOT use this primitive at all: they thread an
     * explicit {@link SubscriptionIdentity} into `executeSubscription` by value,
     * which is the pattern to reach for when a new deferred caller appears.
     */
    private async withRequestIdentity<R>(userId: string | undefined, identity: Record<string, unknown> | undefined, run: () => Promise<R> | R): Promise<R> {
        const previousUserId = this.currentRequestUserId;
        const previousIdentity = this.currentRequestIdentity;

        this.currentRequestUserId = userId;
        this.currentRequestIdentity = identity;

        try {
            return await run();
        } finally {
            this.currentRequestUserId = previousUserId;
            this.currentRequestIdentity = previousIdentity;
        }
    }

    /**
     * Capture one outbound message into the dev mail catcher (`mail-catcher.ts`).
     * `@lunora/mail`'s capture transport POSTs each rendered, validated send here
     * (fire-and-forget) so the studio's Mail inbox shows it. Admin-gated by
     * `handleAdminRpc`'s caller, so only a request bearing `LUNORA_ADMIN_TOKEN`
     * can record — and the worker only ever calls this when the capture transport
     * is wired (dev). Validates the payload (400 on a bad shape) and returns the
     * generated id.
     *
     * Note: the gate is the admin token alone — the same trust boundary that
     * already protects every other admin write (`writeRow`, `clearTable`,
     * `deleteRows`, `runSql`). A token holder can already mutate the shard
     * arbitrarily, so a token-gated mailbox insert adds no new privilege; the DO
     * has no signal for "capture is active", so an inert-unless-capture guard
     * isn't enforced here (an accepted relaxation of plan 011's STOP condition).
     */
    private handleRecordMail(args: Record<string, unknown>): Response {
        const parsed = parseRecordMailArgs(args);
        const result = recordCapturedMail(this.shardHost.sql, parsed, Date.now());

        return adminResponse(result);
    }

    /** Empty the dev mail-catcher inbox (studio "clear inbox" action). Admin-gated by the caller. */
    private handleClearCapturedMail(): Response {
        const result = clearCapturedMail(this.shardHost.sql);

        return adminResponse(result);
    }

    /**
     * Populate the dev mail-catcher inbox with one synthetic message (studio
     * "Send test" button) so the inbox can be exercised in one click. Builds the
     * message via {@link buildTestMailInput} (validating the optional `to`) and
     * records it through the same `recordCapturedMail` path as a real capture.
     * Admin-gated by `handleAdminRpc`'s caller.
     */
    private handleSendTestMail(args: Record<string, unknown>): Response {
        const input = buildTestMailInput(args);
        const result = recordCapturedMail(this.shardHost.sql, input, Date.now());

        return adminResponse(result);
    }

    /**
     * Serve `__lunora_admin__:recordQueueMessage` — the capture sink the generated
     * worker `queue()` handler (via `@lunora/queue`'s `dispatchQueueBatch`) posts
     * every consumed message batch to. Records it into the reserved
     * `__lunora_queue_messages` table (bounded, auto-trimmed) so the studio Queues
     * panel shows one unified consumed-message log across every push consumer. Like
     * the mail catcher, the gate is the admin token alone — a token holder can
     * already mutate the shard, so a token-gated capture insert adds no privilege.
     */
    private handleRecordQueueMessage(args: Record<string, unknown>): Response {
        const messages = parseRecordQueueMessageArgs(args);
        const result = recordQueueMessages(this.shardHost.sql, messages, Date.now());

        return adminResponse(result);
    }

    /** Empty the dev queue consumed-message log (studio "clear log" action). Admin-gated by the caller. */
    private handleClearQueueMessages(): Response {
        const result = clearQueueMessages(this.shardHost.sql);

        return adminResponse(result);
    }

    /**
     * Serve `__lunora_admin__:sendQueueMessage` — the studio's "Send test message"
     * button. Resolves the declared queue's `QUEUE_*` producer binding and calls
     * `.send(body, { delaySeconds?, contentType? })`, or `.sendBatch(...)` when a
     * `batch` array is supplied. No SQLite write happens here (the message is only
     * captured once a consumer processes it), so this only records an audit entry.
     * Admin-gated by `handleAdminRpc`'s caller.
     */
    private async handleSendQueueMessage(args: Record<string, unknown>): Promise<Response> {
        const parsed = parseSendQueueMessageArgs(args);
        const { binding } = this.resolveQueueBinding(parsed.exportName);

        let sent: number;

        if (parsed.batch === undefined) {
            await binding.send(parsed.body, { contentType: parsed.contentType, delaySeconds: parsed.delaySeconds });
            sent = 1;
        } else {
            await binding.sendBatch(
                parsed.batch.map((body) => {
                    return { body, contentType: parsed.contentType, delaySeconds: parsed.delaySeconds };
                }),
            );
            sent = parsed.batch.length;
        }

        this.recordAudit("sendQueueMessage", { detail: { count: sent, exportName: parsed.exportName } });

        return adminResponse({ sent });
    }

    /**
     * Serve `__lunora_admin__:explainIssue` — the Studio Issues panel's opt-in
     * "Explain in plain language" action. The flow itself lives in
     * {@link explainIssue} (`./issue-explainer`); this method only supplies the
     * deployment's `env.AI` binding and records the audit entry. A one-shot async
     * action (never a subscription read) so the model call fires once per click,
     * not on every write-flush. Admin-gated by `handleAdminRpc`'s caller.
     *
     * Audited whenever the model was actually invoked — including the `ai-error`
     * and `empty-response` outcomes, which are the ones that matter for spend and
     * abuse accountability on a billed external call. Only `no-ai-binding` reached
     * no binding at all and so records nothing.
     */
    private async handleExplainIssue(args: Record<string, unknown>): Promise<Response> {
        const result = await explainIssue((this.env as Record<string, unknown> | undefined)?.["AI"], args);

        if (!result.degraded) {
            this.recordAudit("explainIssue", { detail: { groundedId: result.groundedId, model: result.model } });
        } else if (result.reason !== "no-ai-binding") {
            this.recordAudit("explainIssue", { detail: { groundedId: result.groundedId, reason: result.reason } });
        }

        return adminResponse(result);
    }

    /**
     * Serve `__lunora_admin__:aiGenerateSql` — the SQL editor's opt-in
     * natural-language draft / repair.
     *
     * Grounds the prompt in this shard's REAL tables and columns, so the model
     * names things that exist rather than plausible fiction. The engine validates
     * its own output against the same read-only gate `runSql` enforces, so what
     * comes back here is already safe to hand the editor — and is handed over
     * UNEXECUTED regardless.
     *
     * Audited like every other privileged admin action: an AI-drafted statement
     * is still an operator asking the database a question.
     */
    private async handleGenerateSql(args: Record<string, unknown>): Promise<Response> {
        this.ensureMigrated();

        const sql = this.state.storage.sql as unknown as SqlExec;
        // Reuse the same column reader `describeTables` serves the Studio from —
        // a second schema path would be a second thing to keep in step.
        const schema = listTables(sql).map((table) => {
            return { columns: this.tableColumns(table.name).map((column) => column.name), table: table.name };
        });
        const result = await generateSql((this.env as Record<string, unknown> | undefined)?.["AI"], args, schema);

        if (result.degraded) {
            if (result.reason !== "no-ai-binding") {
                this.recordAudit("aiGenerateSql", { detail: { reason: result.reason } });
            }
        } else {
            // The statement itself is recorded: it is what the operator is about
            // to be handed, and an audit trail that omits it explains nothing.
            this.recordAudit("aiGenerateSql", { detail: { sql: result.sql } });
        }

        return adminResponse(result);
    }

    /** The single-shape admin writes (decode args → Response), keyed by function path. */
    private simpleAdminHandlers(): Record<string, (args: Record<string, unknown>) => Promise<Response> | Response> {
        return {
            [ADMIN_FUNCTIONS.backfillSearch]: (args) => this.handleBackfillSearch(args),
            [ADMIN_FUNCTIONS.clearCapturedMail]: () => this.handleClearCapturedMail(),
            [ADMIN_FUNCTIONS.clearQueueMessages]: () => this.handleClearQueueMessages(),
            [ADMIN_FUNCTIONS.createWorkflowInstance]: (args) => this.handleCreateWorkflowInstance(args),
            [ADMIN_FUNCTIONS.explainIssue]: (args) => this.handleExplainIssue(args),
            [ADMIN_FUNCTIONS.getWorkflowInstanceStatus]: (args) => this.handleGetWorkflowInstanceStatus(args),
            [ADMIN_FUNCTIONS.listFlags]: (args) => this.handleListFlags(args),
            [ADMIN_FUNCTIONS.recordAuthEvent]: (args) => this.handleRecordAuthEvent(args),
            [ADMIN_FUNCTIONS.recordContainerEvent]: (args) => this.handleRecordContainerEvent(args),
            [ADMIN_FUNCTIONS.recordMail]: (args) => this.handleRecordMail(args),
            [ADMIN_FUNCTIONS.recordQueueMessage]: (args) => this.handleRecordQueueMessage(args),
            [ADMIN_FUNCTIONS.replayQueueMessage]: (args) => this.handleReplayQueueMessage(args),
            [ADMIN_FUNCTIONS.sendQueueMessage]: (args) => this.handleSendQueueMessage(args),
            [ADMIN_FUNCTIONS.sendTestMail]: (args) => this.handleSendTestMail(args),
        };
    }

    /** The AI-assistant admin writes, keyed by function path. */
    private aiAdminHandlers(): Record<string, (args: Record<string, unknown>) => Promise<Response>> {
        return {
            [ADMIN_FUNCTIONS.aiAvailable]: () => Promise.resolve(this.handleAiAvailable()),
            [ADMIN_FUNCTIONS.aiChartConfig]: async (args) => this.handleAiChartConfig(args),
            [ADMIN_FUNCTIONS.aiGenerateSql]: async (args) => this.handleGenerateSql(args),
            [ADMIN_FUNCTIONS.aiTableFilter]: async (args) => this.handleAiTableFilter(args),
        };
    }

    /**
     * Serve `__lunora_admin__:aiTableFilter` — a natural-language filter for the
     * data browser, grounded in the browsed table's real columns.
     *
     * Returns STRUCTURED clauses, never SQL, so the browser's existing filter
     * validation and parameter binding apply unchanged.
     */
    private async handleAiTableFilter(args: Record<string, unknown>): Promise<Response> {
        this.ensureMigrated();

        const table = typeof args["table"] === "string" ? args["table"] : "";
        const columns = table === "" ? [] : this.tableColumns(table).map((column) => column.name);
        const result = await generateFilter((this.env as Record<string, unknown> | undefined)?.["AI"], args, columns);

        if (result.degraded && result.reason !== "no-ai-binding") {
            this.recordAudit("aiTableFilter", { detail: { reason: result.reason, table } });
        }

        return adminResponse(result);
    }

    /**
     * Serve `__lunora_admin__:aiAvailable` — does this deployment have an `AI`
     * binding at all?
     *
     * The studio asks ONCE on mount so it can decide whether to paint the
     * assistant affordances. Without it the only way to find out was to issue a
     * real request and read `no-ai-binding` off the failure — which meant an app
     * with no binding rendered "Draft SQL" and "Suggest chart" buttons that did
     * nothing until the operator clicked one, and only then made them vanish.
     *
     * Deliberately NOT part of `studioFeatures()`: those flags are computed at
     * codegen time from imports and declared dependencies, while a binding is a
     * runtime property of `env`. Folding a runtime probe into that codegen-owned
     * contract would make its drift guard meaningless.
     *
     * No model call, no audit entry — it reads one property off `env`.
     */
    private handleAiAvailable(): Response {
        return adminResponse({ available: (this.env as Record<string, unknown> | undefined)?.["AI"] !== undefined });
    }

    /**
     * Serve `__lunora_admin__:aiChartConfig` — infer a chart for a result set.
     *
     * The caller sends the result's SHAPE (column names, inferred types, row
     * count), never its values: per plan 202's Phase 0, inference running on the
     * user's own account is not the same as the operator expecting a model to
     * read their rows, and the shape is enough to choose an axis.
     */
    private async handleAiChartConfig(args: Record<string, unknown>): Promise<Response> {
        // Bounded at the boundary: these names are CALLER-supplied (a result set
        // the studio just rendered), and every other input on this surface is
        // capped. An uncapped list is an unbounded prompt, twice over with the retry.
        const columns = Array.isArray(args["columns"])
            ? (args["columns"] as unknown[]).filter((name): name is string => typeof name === "string").slice(0, 64)
            : [];
        const rawTypes = typeof args["types"] === "object" && args["types"] !== null ? (args["types"] as Record<string, unknown>) : undefined;
        const types =
            rawTypes === undefined
                ? undefined
                : Object.fromEntries(Object.entries(rawTypes).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        const rowCount = typeof args["rowCount"] === "number" ? args["rowCount"] : 0;
        const result = await generateChart((this.env as Record<string, unknown> | undefined)?.["AI"], args, { columns, rowCount, types });

        if (result.degraded && result.reason !== "no-ai-binding") {
            this.recordAudit("aiChartConfig", { detail: { reason: result.reason } });
        }

        return adminResponse(result);
    }

    /**
     * Serve `__lunora_admin__:replayQueueMessage` — the studio's one-click replay /
     * DLQ redrive. Looks the captured row up by id, resolves the destination export
     * (explicit `target` → the parent queue when the message was captured off a
     * dead-letter queue → the queue it was consumed from), and re-enqueues the
     * stored body onto that producer. Records an audit entry; no SQLite write beyond
     * that (the replayed message is re-captured when a consumer processes it).
     * Admin-gated by `handleAdminRpc`'s caller.
     */
    private async handleReplayQueueMessage(args: Record<string, unknown>): Promise<Response> {
        const parsed = parseReplayQueueMessageArgs(args);
        const row = readQueueMessageById(this.shardHost.sql, parsed.id);

        if (row === undefined) {
            throw new LunoraError("BAD_REQUEST", `replayQueueMessage: captured message "${parsed.id}" was not found`, { status: 404 });
        }

        // The catcher caps oversized bodies and stands in a marker for unserializable
        // ones (see `queue-catcher.ts`), so the stored body isn't always the original.
        // Refuse to replay a lossy body rather than deliver a corrupted message the
        // producer never sent.
        if (isLossyBody(row.body)) {
            throw new LunoraError(
                "BAD_REQUEST",
                `replayQueueMessage: captured message "${parsed.id}" has a truncated or unserializable body and can't be replayed faithfully`,
                { status: 422 },
            );
        }

        const target = parsed.target ?? this.resolveReplayTarget(row.queue) ?? row.exportName;

        if (typeof target !== "string" || target === "") {
            throw new LunoraError(
                "BAD_REQUEST",
                `replayQueueMessage: captured message "${parsed.id}" has no declared producer to replay onto (pass \`target\`)`,
            );
        }

        const { binding } = this.resolveQueueBinding(target);

        await binding.send(row.body);

        this.recordAudit("replayQueueMessage", { detail: { messageId: row.messageId, target }, id: parsed.id });

        return adminResponse({ sent: 1, target });
    }

    /**
     * Resolve a declared queue's runtime producer binding from this shard's `env`.
     * Looks the `exportName` up in {@link queuesMetadata} (the codegen subclass's
     * statically-discovered list) to find its generated `QUEUE_*` binding, then
     * reads `env[binding]` and validates it carries `send`/`sendBatch`. A bad export
     * name or a missing/malformed binding throws a 400 `LunoraError` so the studio
     * surfaces an actionable message. Mirrors {@link resolveWorkflowBinding}.
     */
    private resolveQueueBinding(exportName: string): { binding: QueueBindingHandle; metadata: QueueMetadata } {
        const metadata = this.queuesMetadata().queues.find((queue) => queue.exportName === exportName);

        if (!metadata) {
            throw new LunoraError("BAD_REQUEST", `queue "${exportName}" is not declared`);
        }

        const binding = (this.env as Record<string, unknown> | undefined)?.[metadata.binding];

        if (typeof binding !== "object" || binding === null || typeof (binding as QueueBindingHandle).send !== "function") {
            throw new LunoraError("BAD_REQUEST", `queue binding "${metadata.binding}" is not available on this deployment`);
        }

        return { binding: binding as QueueBindingHandle, metadata };
    }

    /**
     * Pick the replay destination export for a captured message's origin queue.
     * When the message was consumed off a queue that is another queue's dead-letter
     * queue, prefer that PARENT queue's producer (a DLQ usually has no producer of
     * its own) so replay redrives onto the original; otherwise re-enqueue onto the
     * queue the message came from. Returns `undefined` when neither is declared.
     */
    private resolveReplayTarget(queueName: string): string | undefined {
        const { queues } = this.queuesMetadata();
        const parent = queues.find((queue) => queue.deadLetterQueue === queueName);

        if (parent !== undefined) {
            return parent.exportName;
        }

        return queues.find((queue) => queue.name === queueName)?.exportName;
    }

    /**
     * Append one durable audit entry for a state-changing admin op that just
     * succeeded, folding the acting user (from `getCurrentUserId`) into `detail`.
     * Called only on the success path, so a rejected/validated op leaves no
     * trace. Best-effort: the write happens after the op's own commit, so it
     * never blocks or fails the response.
     */
    private recordAudit(op: string, fields: { detail?: Record<string, unknown>; id?: string; table?: string } = {}): void {
        const sql = this.shardHost.sql as unknown as SqlExec;
        const userId = this.getCurrentUserId();
        const detail = userId === undefined ? fields.detail : { ...fields.detail, userId };

        appendAuditEntry(sql, { detail, id: fields.id, op, table: fields.table, ts: Date.now() });
    }

    /**
     * Append one structured entry to the durable request log (`request-log.ts`)
     * for a `/rpc` dispatch that just completed — the per-request readout
     * (`<file>:<function>`, shard key, acting user/identity, redacted args,
     * outcome, duration, tables read/written, cache hit) that Cloudflare cannot
     * attribute (PLAN3 §1.1). When `LUNORA_REQUEST_LOG_EMIT` is set, the same
     * entry is ALSO emitted as a structured console event for CF Workers Logs /
     * Logpush to ship to external SIEMs (PLAN3 §3.3) — see `requestLogConfig`.
     *
     * Volume is bounded by two knobs (`requestLogConfig`): SUCCESSFUL dispatches
     * are sampled at `LUNORA_REQUEST_LOG_SAMPLE` (errors always recorded) and the
     * durable rows are trimmed to `LUNORA_REQUEST_LOG_RETENTION`. Args/identity
     * are redacted by default and captured raw only in a dev environment.
     *
     * Best-effort, exactly like `recordFunctionCall`'s durable upsert: a SQL
     * failure (e.g. a test double without a `sql` handle) must NEVER turn a
     * served request into a failed one, so it is swallowed. Args are redacted
     * inside `appendRequestLogEntry` so a raw value never reaches the table.
     *
     * The correlated fields all come from data the dispatch already holds, with
     * no extra hot-path bookkeeping. `tablesWritten` is snapshotted from
     * `pendingChangedTables` by the caller before `flushChangedTables` drains it.
     * `tablesRead` and `cacheHit` arrive in `attribution`, the per-dispatch
     * object `beginDispatch` minted and `runCachedQuery` filled in — passed BY
     * VALUE for the same reason `trace` is, since both are read here, after the
     * handler's awaits, where a shared field belongs to whichever concurrent
     * dispatch resolved last. They are present only for cached query paths — a
     * write/action doesn't run through the cache, an instance with the reactive
     * cache disabled never captures them, and a query that hit the re-entry
     * guard passed through uncached — and are left empty/`undefined` rather
     * than recomputed here.
     * `subscriptionsReRun` is left `0`: the write-driven subscription refresh
     * runs off the response path via `waitUntil` (see `flushChangedTables`), so a
     * per-request count isn't available synchronously at this site, and threading
     * one back would add bookkeeping to the deferred fan-out for no correctness
     * benefit — recorded as `0` with this note rather than faked.
     */
    private recordRequestLog(
        functionPath: string,
        args: Record<string, unknown>,
        durationMs: number,
        outcome: "error" | "ok",
        tablesWritten: string[],
        trace: TraceAnchor,
        attribution: QueryAttribution,
        errorMessage?: string,
    ): void {
        const config = this.requestLogConfig();

        // Sampling: ALWAYS record errors (rare, high-value); sample successful
        // dispatches at `sampleRate` so a hot shard doesn't write+emit on literally
        // every request. One decision governs both sinks, so a sampled-out request
        // is simply not observed — durable row and Logpush event stay consistent.
        if (outcome === "ok" && !sampleHit(config.sampleRate)) {
            return;
        }

        // Build the structured entry once and feed it to BOTH sinks: the durable
        // `__lunora_reqlog__` row (the queryable readout) and — when enabled — a
        // console event CF's Workers Logs / Logpush pipeline ships to external
        // SIEMs (PLAN3 §3.3). Both redact args/identity from this same raw entry
        // (unless `captureRaw` in dev), so the two stay byte-consistent.
        const entry: AppendRequestLogEntry = {
            cacheHit: attribution.cacheHit,
            durationMs,
            errorMessage,
            functionPath,
            identity: this.currentRequestIdentity,
            outcome,
            redactedArgs: Object.keys(args).length === 0 ? undefined : args,
            shardKey: this.runner.shardKey,
            tablesRead: attribution.readTables === undefined ? [] : [...attribution.readTables],
            tablesWritten,
            // Passed BY VALUE, never read off `currentRequestTrace` here: this
            // method runs after the handler's awaits, by which point an
            // interleaved dispatch may have re-set (or cleared) that shared
            // field — which would file this row, and the Logpush event carrying
            // it, under another request's trace. Same hazard, and same fix, as
            // the dispatch root span's `dispatchTrace` capture.
            traceId: trace.traceId,
            ts: Date.now(),
            userId: this.getCurrentUserId(),
        };

        this.persistRequestLog(entry, config);
    }

    /**
     * The single durable-row + Logpush write seam for `__lunora_reqlog__`. Both
     * the per-dispatch {@link recordRequestLog} and the container-crash path
     * ({@link handleRecordContainerEvent}) funnel through here so they can't
     * drift — before this was extracted the container writer persisted the row
     * but silently skipped the Logpush emit every other error got.
     *
     * Best-effort by contract: a SQL failure (e.g. a test double with no `sql`
     * handle) or a serialization hiccup in the emit must NEVER turn a served
     * request — or a container event push — into a failed one, so each half is
     * swallowed independently.
     *
     * Errors are always streamed to `console` (rare, high-value — they ride CF
     * Workers Logs at error level and the dev-server formats them in the
     * terminal), redacted in prod like any other event. The full per-dispatch
     * summary stream (successful OKs too) stays opt-in behind
     * `LUNORA_REQUEST_LOG_EMIT` so a hot shard doesn't emit a line per call.
     */
    private persistRequestLog(entry: AppendRequestLogEntry, config: { captureRaw: boolean; emit: boolean; retention: number | undefined }): void {
        const writeOptions: RequestLogWriteOptions = { captureRaw: config.captureRaw, retention: config.retention };

        try {
            appendRequestLogEntry(this.shardHost.sql, entry, writeOptions);
        } catch {
            // Best-effort: never let request-log persistence fail the caller.
        }

        if (config.emit || entry.outcome === "error") {
            try {
                emitRequestLogEvent(entry, writeOptions);
            } catch {
                // Best-effort: never let event emission fail the caller.
            }
        }
    }

    /**
     * Resolve the request-log knobs from the Worker `env`, all PLAN3 §3.3 decisions.
     *
     * `captureRaw`: raw (un-redacted) args/identity in a dev environment, redacted
     * in production (`isDevEnvironment`) — default redacted.
     *
     * `emit`: also stream each entry as a console event for CF Workers Logs /
     * Logpush (and the dev-server terminal). Explicit `LUNORA_REQUEST_LOG_EMIT`
     * (`"1"`/`"true"` vs `"0"`/`"false"`) always wins; unset, it defaults to
     * `isDevEnvironment` — ON in dev so a developer sees every dispatch, OFF in
     * production where a line per dispatch is log volume an operator opts into.
     * Errors stream regardless (see `recordRequestLog`).
     *
     * `retention`: durable-row cap override (`LUNORA_REQUEST_LOG_RETENTION`);
     * `undefined` falls back to the module default.
     *
     * `sampleRate`: fraction of SUCCESSFUL dispatches recorded
     * (`LUNORA_REQUEST_LOG_SAMPLE`, 0..1, default 1.0 = all); errors always record.
     */
    private requestLogConfig(): { captureRaw: boolean; emit: boolean; retention: number | undefined; sampleRate: number } {
        const env = (this.env ?? {}) as { LUNORA_REQUEST_LOG_EMIT?: string; LUNORA_REQUEST_LOG_RETENTION?: string; LUNORA_REQUEST_LOG_SAMPLE?: string };

        return {
            captureRaw: isDevEnvironment(this.env),
            emit: parseEmit(env.LUNORA_REQUEST_LOG_EMIT, isDevEnvironment(this.env)),
            retention: parsePositiveInt(env.LUNORA_REQUEST_LOG_RETENTION),
            sampleRate: parseSampleRate(env.LUNORA_REQUEST_LOG_SAMPLE),
        };
    }

    /**
     * Native Durable-Object PITR ops (the ≤30-day in-place tier). `getPitrBookmark`
     * reads the current/for-time bookmark; `pitrRestore` arms a restore to a
     * bookmark/time (auditing the target + undo bookmark before any restart, so the
     * undo point survives even if `abort()` drops the response). Returns `null` when
     * `functionPath` isn't a PITR op so the caller falls through. Kept out of
     * `handleAdminRpc` to hold that dispatcher under the complexity budget.
     */
    private async handlePitrAdminOp(functionPath: string, args: Record<string, unknown>): Promise<Response | undefined> {
        const time = typeof args.time === "number" || typeof args.time === "string" ? args.time : undefined;

        if (functionPath === ADMIN_FUNCTIONS.getPitrBookmark) {
            // Read-only — native ≤30-day tier, no write, nothing to flush.
            return adminResponse(await readBookmark(this.state.storage, time));
        }

        if (functionPath !== ADMIN_FUNCTIONS.pitrRestore) {
            return undefined;
        }

        // Destructive: arm a native restore to a bookmark/time.
        const restart = args.restart === true;
        const bookmark = typeof args.bookmark === "string" ? args.bookmark : undefined;
        const armed = await armRestore(this.state.storage, { bookmark, time });

        // Roll the CDC epoch so live subscribers re-snapshot rather than try to
        // resume across the timeline fork a restore introduces. This bump is the
        // proactive half only, and it is genuinely half: the native restore
        // reverts all of SQLite — this epoch row with it — so a deferred restore
        // (`restart: false`) that applies on some later eviction lands on a shard
        // whose epoch is back to its pre-bump value. The window this half does
        // cover is the one between arming and the restart.
        //
        // The other half is reactive and lives in
        // {@link ShardDO.sealForkedTimeline}: the first client to present a
        // cursor ahead of the rewound log, on the reverted epoch, proves the fork
        // from outside SQLite and re-mints the epoch for everyone. Read that
        // comment for what the pair can and cannot detect.
        //
        // Best-effort: `cdcEnabled()` is false on a stub `sql` handle or a
        // pre-CDC shard, so the bump simply no-ops there.
        if (this.cdcEnabled()) {
            bumpCdcEpoch(this.sql as SqlExec);
        }

        this.recordAudit("pitrRestore", { detail: { restart, restoredTo: armed.restoredTo, undoBookmark: armed.undoBookmark } });

        const response = adminResponse({ ...armed, restarted: restart });

        if (restart) {
            // Apply now: restart the DO so it reopens at the armed bookmark.
            this.state.abort?.("lunora PITR restore");
        }

        return response;
    }

    /**
     * Run a single read-only admin introspection op, returning its result plus
     * the table-dependency set the subscription bridge uses to decide when to
     * re-run it. Write/migration/export ops are NOT handled here — they stay in
     * `handleAdminRpc` because they mutate state and can't be safely
     * re-executed on every write-flush. Returns `null` for any non-read op.
     *
     * `readTablePage` depends on exactly the table it reads, so a write to an
     * unrelated table never re-runs it. The counter/log ops (`getMetrics`,
     * `getLogs`, `listTables`, `migrationStatus`) aren't bound to a single
     * table; they carry the {@link ADMIN_WILDCARD} sentinel so
     * `refreshSubscriptions` re-runs them on every write-flush. The
     * per-socket JSON memo in `pushSubscriptionData` still suppresses
     * pushes when the recomputed value is byte-identical.
     * @returns the result and table-dependency set for a read op, or `null` for a write/migration op
     */
    private readAdminOp(functionPath: string, args: Record<string, unknown>): { result: unknown; tables: Set<string> } | null {
        // Materialise the shard's tables before any introspection read, so the
        // data browser sees a freshly-provisioned shard instead of an empty one.
        this.ensureMigrated();

        const sql = this.shardHost.sql as unknown as SqlExec;

        // The wildcard-bound counter/config reads aren't tied to a single table,
        // so they share one branch and the {@link ADMIN_WILDCARD} sentinel; a
        // live subscription on any of them re-runs on every write-flush (the
        // per-socket JSON memo still suppresses byte-identical pushes).
        const wildcardRead = this.readAdminWildcardOp(functionPath);

        if (wildcardRead !== undefined) {
            return { result: wildcardRead, tables: new Set([ADMIN_WILDCARD]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.getAuditLog) {
            return readAdminAuditLog(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.getRequestLog) {
            return readAdminRequestLog(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.getIssues) {
            return readAdminIssues(sql, args);
        }

        const durable = readAdminDurableSignal(functionPath, sql, args);

        if (durable) {
            return durable;
        }

        if (functionPath === ADMIN_FUNCTIONS.readTablePage) {
            return this.readAdminTablePage(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.facetColumn) {
            return readAdminFacetColumn(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.runSql) {
            return readAdminRunSql(sql, args);
        }

        // The SQL linter + schema-version ledger reads live in their own module
        // and register through a lookup, so this chain does not grow an arm per
        // resolver — see `schema-history-reads.ts`.
        const schemaHistoryRead = resolveSchemaHistoryRead(functionPath, ADMIN_FUNCTION_PREFIX, sql, args, ADMIN_WILDCARD);

        if (schemaHistoryRead !== undefined) {
            return schemaHistoryRead;
        }

        const tableSignal = this.readAdminTableSignal(functionPath, sql, args);

        if (tableSignal) {
            return tableSignal;
        }

        const storage = this.readAdminStorageSignal(functionPath, sql, args);

        if (storage) {
            return storage;
        }

        // eslint-disable-next-line unicorn/no-null -- `null` signals "not a recognized admin read", matching the subscription-outcome contract codegen subclasses implement
        return null;
    }

    /**
     * Resolve the table-scoped introspection reads whose payload is a single
     * `this.*()` lookup keyed by an optional `table` arg — `listTableIndexes`
     * (declared indexes), `describeTable` (declared columns) and `migrationStatus`
     * (the migration ledger); plus their batched siblings `describeTables` and
     * `listTablesIndexes` (one RPC for N tables via {@link batchedTableLookup}).
     * The single-table pair carries its `table` (or the {@link ADMIN_WILDCARD}
     * sentinel when unscoped); `migrationStatus` is deployment-wide, so it always
     * carries the wildcard. Returns `undefined` for any other path so
     * {@link readAdminOp} falls through; folded into one helper to keep that
     * dispatcher under its complexity budget.
     * @returns the read result and its table-dependency set, or `undefined` when the path is not owned by this resolver
     */
    private readAdminTableSignal(functionPath: string, sql: SqlExec, args: Record<string, unknown>): undefined | { result: unknown; tables: Set<string> } {
        if (functionPath === ADMIN_FUNCTIONS.listTableIndexes || functionPath === ADMIN_FUNCTIONS.describeTable) {
            const table = typeof args["table"] === "string" ? args["table"] : "";
            const result = functionPath === ADMIN_FUNCTIONS.describeTable ? { columns: this.tableColumns(table) } : { indexes: this.tableIndexes(table) };

            return { result, tables: new Set([table === "" ? ADMIN_WILDCARD : table]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.describeTables) {
            const { byTable: columnsByTable, tables } = batchedTableLookup(args, (table) => this.tableColumns(table));

            return { result: { columnsByTable }, tables };
        }

        // Batched sibling of `listTableIndexes` — one admin RPC for N tables
        // instead of N, following `describeTables`'s exact shape: the fan-out
        // this collapses used to cost a full admin RPC PER table.
        if (functionPath === ADMIN_FUNCTIONS.listTablesIndexes) {
            const { byTable: indexesByTable, tables } = batchedTableLookup(args, (table) => this.tableIndexes(table));

            return { result: { indexesByTable }, tables };
        }

        if (functionPath === ADMIN_FUNCTIONS.migrationStatus) {
            const id = typeof args["id"] === "string" ? args["id"] : undefined;

            return { result: { migrations: readMigrationStatus(sql, id) }, tables: new Set([ADMIN_WILDCARD]) };
        }

        return undefined;
    }

    /**
     * Resolve the storage↔schema correlation admin reads — the file browser's
     * records↔files join (`storageReferences`, object→owning-record + per-key
     * orphans) and its inverse (`storageOrphans`, dangling references: records
     * pointing at a missing object). Both scan only the schema's declared
     * `v.storage()` columns. Returns `undefined` for any other path so
     * {@link readAdminOp} falls through; folded into one helper to keep that
     * dispatcher under its complexity budget.
     * @returns the read result and its table-dependency set, or `undefined` when the path is not owned by this resolver
     */
    private readAdminStorageSignal(functionPath: string, sql: SqlExec, args: Record<string, unknown>): undefined | { result: unknown; tables: Set<string> } {
        if (functionPath === ADMIN_FUNCTIONS.storageReferences) {
            return readAdminStorageReferences(sql, args, this.storageColumns());
        }

        if (functionPath === ADMIN_FUNCTIONS.storageOrphans) {
            return readAdminStorageOrphans(sql, args, this.storageColumns());
        }

        return undefined;
    }

    /**
     * Resolve the read-only admin ops whose result isn't bound to a single table
     * — the in-memory counters (`getMetrics`, `getFunctionStats`), the table list
     * (`listTables`), the in-memory error buffer (`getLogs`) and the masked
     * deployment config (`getSettings`). Returns the result value, or `undefined`
     * for any path it doesn't own (so `readAdminOp` falls through). The caller
     * wraps each in the {@link ADMIN_WILDCARD} sentinel, keeping that one fact in
     * a single place and `readAdminOp` under its complexity budget.
     */
    // eslint-disable-next-line sonarjs/cognitive-complexity -- a flat admin-RPC dispatch chain (one trivial branch per function); #149 added the getTraces/getMetrics branches. A lookup table would obscure the 1:1 path→reader mapping this deliberately keeps.
    private readAdminWildcardOp(functionPath: string): unknown {
        if (functionPath === ADMIN_FUNCTIONS.listTables) {
            return listTables(this.shardHost.sql);
        }

        if (functionPath === ADMIN_FUNCTIONS.getMetrics) {
            return this.collectMetrics();
        }

        if (functionPath === ADMIN_FUNCTIONS.getFunctionStats) {
            return this.collectFunctionStats();
        }

        if (functionPath === ADMIN_FUNCTIONS.listSubscriptions) {
            return this.collectSubscriptions();
        }

        if (functionPath === ADMIN_FUNCTIONS.getFanoutMetrics) {
            // Per-topic subscriber counts + running fan-out cost counters (plan
            // 075 Phase 1 observability). Deployment-wide live state, so it carries
            // the wildcard like the other read-only admin reads.
            return this.collectFanoutMetrics();
        }

        if (functionPath === ADMIN_FUNCTIONS.getLogs) {
            // `dropped` rides along so the panel can say "newest 500 of N" — a
            // full ring is otherwise indistinguishable from an instance that
            // logged exactly 500 lines.
            return { dropped: this.logs.dropped, entries: this.logs.entries() };
        }

        if (functionPath === ADMIN_FUNCTIONS.getTraces) {
            // Recent `ctx.trace` waterfalls from the in-memory span ring, folded
            // per trace (newest first) with depth/offset precomputed so the panel
            // renders rows without re-deriving the tree. `total` reports the
            // distinct traces available so the panel can flag when the newest
            // `DEFAULT_TRACE_LIMIT` shown is only part of the ring.
            const folded = foldTraces(this.spans.entries());

            // `dropped` counts spans the ring evicted before this read, so a
            // truncated waterfall reads as truncated rather than as complete.
            return { dropped: this.spans.dropped, total: folded.total, traces: folded.traces };
        }

        if (functionPath === ADMIN_FUNCTIONS.getMetricSeries) {
            // Running aggregates of `ctx.metrics.*` measurements from the in-memory
            // fold, most-recently-updated first. The counterpart to getLogs/getTraces
            // for the third signal — a "recent metrics on this instance" readout that
            // resets on hibernation; durable aggregation is the sink's job.
            return { series: this.metricSeries.entries() };
        }

        if (functionPath === ADMIN_FUNCTIONS.getMetricHistory) {
            // Durable per-minute rollups of `ctx.metrics.*` from the shard's SQLite,
            // grouped per series with buckets oldest-first — the trend counterpart to
            // getMetricSeries' live snapshot. Survives hibernation; each bucket carries
            // an exemplar traceId so the panel can link a point to a trace. Read whole
            // (clamped by the module's row limit) and windowed client-side, like the
            // getMetrics history the metrics panel already charts.
            return readMetricHistory(this.sql as SqlExec);
        }

        if (functionPath === ADMIN_FUNCTIONS.getSettings) {
            // Read-only deployment config derived from the Worker `env`; string
            // values are masked server-side, so no raw secret crosses the wire.
            return buildSettings(this.env);
        }

        if (functionPath === ADMIN_FUNCTIONS.getSecurityAudit) {
            // Deployment-level security findings derived from the Worker `env`
            // (admin-token strength, WS gate, request-log redaction) — the
            // Security Advisor's signal. No raw secret crosses the wire.
            return buildSecurityAudit(this.env, { dev: isDevEnvironment(this.env) });
        }

        if (functionPath === ADMIN_FUNCTIONS.getAdvisories) {
            // Static schema advisories (codegen-emitted, via `advisories()`) plus
            // runtime ones derived from observed signal (`unused_index`).
            // Deployment-wide, so it carries the wildcard like the other reads.
            return { advisories: [...this.advisories(), ...this.runtimeAdvisories()] };
        }

        if (functionPath === ADMIN_FUNCTIONS.getAdvisorProcedures) {
            // The health map's denominator — deployment-wide, like the advisories above.
            return { procedures: this.advisorProcedures() };
        }

        if (functionPath === ADMIN_FUNCTIONS.rlsPolicies) {
            // Read-only RLS metadata (codegen-emitted, via `rlsMetadata()`): the
            // policies + roles the studio's inspector lists. Schema-wide, so it
            // carries the wildcard like the other static-introspection reads.
            return this.rlsMetadata();
        }

        if (functionPath === ADMIN_FUNCTIONS.maskPolicies) {
            // Read-only masking metadata (codegen-emitted, via `maskMetadata()`):
            // the (table, column, strategy) entries the studio's data-browser mask
            // preview reads. Schema-wide, like the other static-introspection reads.
            return this.maskMetadata();
        }

        if (functionPath === ADMIN_FUNCTIONS.storageRules) {
            // Read-only storage access-rule metadata (codegen-emitted, via
            // `storageRulesMetadata()`): the rules the studio's access-rules view
            // lists. Schema-wide, like the other static-introspection reads.
            return this.storageRulesMetadata();
        }

        if (functionPath === ADMIN_FUNCTIONS.studioFeatures) {
            // Read-only optional-feature flags (codegen-emitted, via
            // `studioFeatures()`): which package-backed nav pages the studio
            // should show. Deployment-wide, like the other static reads.
            return this.studioFeatures();
        }

        if (functionPath === ADMIN_FUNCTIONS.listWorkflows) {
            // Read-only declared-workflow metadata (codegen-emitted, via
            // `workflowsMetadata()`): the Cloudflare Workflows the studio's
            // Workflows page lists. Deployment-wide static declaration data,
            // like the other static reads (workflows hold no shard state).
            return this.workflowsMetadata();
        }

        if (functionPath === ADMIN_FUNCTIONS.listQueues) {
            // Read-only declared-queue metadata (codegen-emitted, via
            // `queuesMetadata()`): the Cloudflare Queues the studio's Queues page
            // lists. Deployment-wide static declaration data (queues hold no
            // shard state).
            return this.queuesMetadata();
        }

        return undefined;
    }

    /**
     * Enumerate every connected WebSocket and the subscriptions it tracks for
     * the `__lunora_admin__:listSubscriptions` realtime inspector. Reads each
     * socket's hibernation attachment (admin flag + live `subs` map) and folds
     * them into a {@link SubscriptionsResult} via {@link summarizeSubscriptions}.
     * Read-only: it touches no SQLite and mutates no socket state.
     */
    private collectSubscriptions(): SubscriptionsResult {
        return summarizeSubscriptions(this.runner.sockets().map((ws) => this.readAttachment(ws)));
    }

    /**
     * Assemble the `__lunora_admin__:getFanoutMetrics` payload for the Studio
     * fan-out observability panel (plan 075 Phase 1). The point-in-time topic
     * subscriber counts are folded live from each socket's attachment via
     * {@link summarizeFanoutTopics}; the running per-path cost counters are the
     * in-memory {@link ShardDO.fanout} tallies, sharing `metrics.sinceMs` as the
     * "since this instance woke" epoch. Touches no SQLite and mutates no socket
     * state; it does call `relay.relayCount()`, which advances the promotion
     * latch — safe here because that transition is a pure, monotonic function of
     * the live socket count (DOs are single-threaded), so a metrics poll only ever
     * drives the latch to the same state the routing path would compute for the
     * same count, never a divergent one.
     */
    private collectFanoutMetrics(): FanoutMetricsResult {
        const summary = summarizeFanoutTopics(this.runner.sockets().map((ws) => this.readAttachment(ws)));
        const relayCount = this.relay?.relayCount() ?? 0;

        return {
            ...summary,
            globalPoll: this.globalPoll,
            maxRelays: this.relay?.maxRelays() ?? DEFAULT_MAX_RELAYS,
            promoted: relayCount > 0,
            relayCount,
            shapePoke: this.fanout.shapePoke,
            shapeProbe: this.shapeProbe,
            sinceMs: this.metrics.sinceMs,
            whisper: this.fanout.whisper,
        };
    }

    /** Resolve a `readTablePage` admin read, parsing the loosely-typed args into the reader's options. */
    private readAdminTablePage(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        const table = typeof args["table"] === "string" ? args["table"] : "";
        const page = readTablePage(sql, {
            filters: parseTablePageFilters(args["filters"]),
            limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
            offset: typeof args["offset"] === "number" ? args["offset"] : undefined,
            orderBy: parseTablePageOrderBy(args["orderBy"]),
            refs: this.tableRefs(table),
            search: typeof args["search"] === "string" ? args["search"] : undefined,
            skipCount: typeof args["skipCount"] === "boolean" ? args["skipCount"] : undefined,
            table,
        });

        // An empty table name can't bind to a real dependency, so fall back
        // to the wildcard rather than a set that never intersects a write.
        return { result: page, tables: new Set([table === "" ? ADMIN_WILDCARD : table]) };
    }

    /**
     * Seed/refresh hook for `__lunora_admin__:*` subscriptions, mirroring
     * `executeSubscription` for user functions. Returns `null` for any
     * path that isn't a read-only admin op so the caller can fall through.
     * Synchronous — admin reads hit raw SQLite directly, no async dispatch.
     */
    private executeAdminSubscription(functionPath: string, args: Record<string, unknown>): SubscriptionOutcome | null {
        const read = this.readAdminOp(functionPath, args);

        // eslint-disable-next-line unicorn/no-null -- mirrors the SubscriptionOutcome contract (`| null`) codegen subclasses override against
        return read ? { result: read.result, tables: read.tables } : null;
    }

    /**
     * Resolve one subscription (seed or refresh) to its {@link SubscriptionOutcome}
     * by routing the `functionPath` to the right read path — shared by
     * {@link seedSubscription} and {@link refreshSubscriptions} so both branch
     * identically:
     * - `__lunora_admin__:*` → {@link executeAdminSubscription} (raw SQLite read).
     * - {@link FLAGS_FUNCTION_PREFIX} → {@link runFlagSubscriptionRead} (the codegen subclass evaluates the flag through the configured provider). The value isn't bound to any table, so it is tagged with the {@link ADMIN_WILDCARD} dep — re-evaluated on every write-flush so a live `useFlag` stays current within a session. A `null` read means "nothing to deliver" (no provider, or a flag that resolved to `null`).
     * - everything else → {@link executeSubscription} (the user query, under the socket's own by-value identity).
     */
    private async resolveReactiveOutcome(
        functionPath: string,
        args: Record<string, unknown>,
        isAdmin: boolean,
        identity: SubscriptionIdentity,
    ): Promise<SubscriptionOutcome | null> {
        if (isAdmin) {
            return this.executeAdminSubscription(functionPath, args);
        }

        if (functionPath.startsWith(FLAGS_FUNCTION_PREFIX)) {
            const result = await this.runFlagSubscriptionRead(functionPath, args, identity);

            // eslint-disable-next-line unicorn/no-null -- matches the flag-read "nothing to deliver" sentinel
            return result === null ? null : { result, tables: new Set([ADMIN_WILDCARD]) };
        }

        // Ranges ride on the outcome, reported by the subscription's OWN read
        // (the generated `executeSubscription` collects them through a
        // `ReadFootprint`). They deliberately do NOT come from a per-request
        // field on `this`: a deferred subscription re-run interleaves with
        // unrelated RPC dispatches, so a shared field would stamp one request's
        // slices onto another subscriber's memo and suppress its invalidations.
        return this.executeSubscription(functionPath, args, identity);
    }

    /**
     * SECURITY BOUNDARY for cross-socket reactive dedup. A read is
     * identity-INDEPENDENT only when its result cannot vary by the caller's
     * verified identity — i.e. the admin/reserved introspection reads, which
     * route to {@link executeAdminSubscription} and ignore the
     * {@link SubscriptionIdentity} entirely.
     *
     * Everything else is identity-DEPENDENT and must NEVER be shared across
     * sockets: a user query may be `rls()` / `ctx.auth`-scoped (different rows
     * per identity), and a flag read ({@link FLAGS_FUNCTION_PREFIX}) evaluates
     * the provider with the subscriber's identity (per-user targeting). Sharing
     * one socket's result with another would leak one identity's rows/flags to a
     * different identity, so this predicate gates {@link ShardDO.resolveReactiveOutcomeDeduped}
     * shut for them.
     */
    // eslint-disable-next-line class-methods-use-this, @typescript-eslint/member-ordering -- pure predicate over the function path; a protected method so the security boundary lives in one named place (and tests can probe it), co-located with the reactive dedup it gates rather than hoisted away from its only caller
    protected isIdentityIndependent(functionPath: string): boolean {
        return functionPath.startsWith(ADMIN_FUNCTION_PREFIX);
    }

    /**
     * Memoizing wrapper over {@link resolveReactiveOutcome}: flush-local sharing across sockets.
     * Within a single {@link refreshSubscriptions} pass, N sockets subscribed to
     * the SAME identity-independent `(functionPath, args)` re-run the query N
     * times today (see the Case-6 fan-out characterization). When the read is
     * identity-independent (admin/reserved — see {@link isIdentityIndependent})
     * its result is the same for every socket, so the first run is cached (by its
     * in-flight Promise, since the bounded worker pool runs sockets in parallel)
     * and shared with the rest — collapsing N runs to ONE.
     *
     * Identity-DEPENDENT reads are passed straight through, UNCACHED: each socket
     * must evaluate under its own by-value identity (RLS / `ctx.auth` / per-user
     * flags), so they never share a result. The `cache` is created fresh per
     * flush by the caller, so a result is never reused across passes (it would go
     * stale after the next write).
     */
    private resolveReactiveOutcomeDeduped(
        functionPath: string,
        args: Record<string, unknown>,
        isAdmin: boolean,
        identity: SubscriptionIdentity,
        cache: Map<string, Promise<SubscriptionOutcome | null>>,
    ): Promise<SubscriptionOutcome | null> {
        if (!this.isIdentityIndependent(functionPath)) {
            return this.resolveReactiveOutcome(functionPath, args, isAdmin, identity);
        }

        // Identity is irrelevant for these reads, so the null-identity key is
        // identical across every sharing socket.
        // eslint-disable-next-line unicorn/no-null -- reactiveCacheKey's identity arg is `null | string`; null = the identity-independent bucket
        const key = reactiveCacheKey(functionPath, args, null);
        const cached = cache.get(key);

        if (cached !== undefined) {
            return cached;
        }

        const pending = this.resolveReactiveOutcome(functionPath, args, isAdmin, identity);

        cache.set(key, pending);

        return pending;
    }

    /**
     * Constant-time bearer check against `env.LUNORA_ADMIN_TOKEN`. Returns
     * `false` (closed) when the token is unset so admin introspection is
     * opt-in rather than exposed by default.
     */
    private isAdminAuthorized(request: Request): boolean {
        const env = (this.env ?? {}) as { LUNORA_ADMIN_TOKEN?: string };
        const token = env.LUNORA_ADMIN_TOKEN;

        if (!token || token.length === 0) {
            return false;
        }

        const supplied = extractBearerToken(request.headers.get("authorization"));

        return supplied !== undefined && constantTimeEqual(supplied, token);
    }

    /**
     * Drive a streaming-query iterator end-to-end:
     * 1. Allocate a per-id {@link AbortController} so a later `unsubscribe`
     * (or socket close) tears the user iterator down.
     * 2. Send a `{type:"ack"}` so the client knows the stream started before
     * any chunks land.
     * 3. Pump every yielded chunk through a `{type:"chunk"}` frame.
     * 4. On normal completion send `{type:"complete"}`; on throw send
     * `{type:"error"}`. Either way drop the controller.
     */

    private async handleStream(
        ws: ShardSocketLike,
        id: string,
        functionPath: string,
        args: Record<string, unknown>,
        sinceSeq = 0,
        generation?: number,
    ): Promise<void> {
        // Read once, up front: the identity the handler runs under must be
        // captured BEFORE the first await and passed by value, because the
        // iterator is pulled long after this frame was dispatched.
        const attachment = this.readAttachment(ws);
        const iterable = this.executeStream(functionPath, args, { identity: attachment.identity, userId: attachment.userId });

        if (!iterable) {
            trySendFrame(ws, JSON.stringify({ error: { code: "NOT_FOUND", message: `stream not registered: ${functionPath}` }, id, type: "error" }));

            return;
        }

        const cancellers = socketMap(this.streamCancellers, ws);

        // One live stream per `id`, refused rather than silently replacing the
        // incumbent. `id` is client-chosen (straight off the frame) and the cap
        // below reads `cancellers.size`, so re-sending one id used to defeat the
        // cap outright: N pumps ran under a single map entry, the second `set`
        // orphaned the first `AbortController` (so neither `unsubscribe` nor
        // `webSocketClose` could reach it), and whichever pump finished first
        // deleted the entry its siblings were still cancelled through.
        if (cancellers.has(id)) {
            trySendFrame(
                ws,
                JSON.stringify({
                    error: { code: "STREAM_ID_IN_USE", message: `stream id ${JSON.stringify(id)} is already live on this socket` },
                    id,
                    type: "error",
                }),
            );

            return;
        }

        // Enforce the per-socket in-flight cap before allocating any state
        // for the new stream. A rejected stream never lands in the
        // canceller map, so a flurry of rejections can't push the count
        // past the cap.
        if (cancellers.size >= ShardDO.MAX_STREAMS_PER_SOCKET) {
            trySendFrame(
                ws,
                JSON.stringify({
                    error: { code: "TOO_MANY_STREAMS", message: `stream cap of ${String(ShardDO.MAX_STREAMS_PER_SOCKET)} reached on this socket` },
                    id,
                    type: "error",
                }),
            );

            return;
        }

        if (iterable.durable) {
            await this.attachDurableStream(ws, id, functionPath, args, { durable: iterable.durable, iterator: iterable.iterator }, sinceSeq, generation);

            return;
        }

        const controller = new AbortController();

        cancellers.set(id, controller);
        trySendFrame(ws, JSON.stringify({ id, type: "ack" }));

        try {
            for await (const chunk of iterable.iterator(controller.signal)) {
                if (controller.signal.aborted) {
                    break;
                }

                // A credential can lapse mid-stream: the inbound check ran once,
                // on the frame that STARTED this stream, and a pump can outlive
                // it indefinitely. Tear the iterator down rather than keep
                // pushing the user's data at an expired socket.
                if (this.isSocketExpired(ws)) {
                    this.dropExpiredSocket(ws);
                    controller.abort();

                    break;
                }

                // Defensive backpressure: when the runtime surfaces
                // `bufferedAmount`, pause iteration if the socket already
                // has > 1 MiB queued. Without this, a slow consumer can
                // make the runtime's outbound buffer grow without bound
                // while we keep pumping `ws.send` calls.
                await awaitWsDrain(ws);

                ws.send(JSON.stringify({ data: encodeWire(chunk), id, type: "chunk" }));
            }

            if (!controller.signal.aborted) {
                ws.send(JSON.stringify({ id, type: "complete" }));
            }
        } catch (error: unknown) {
            // Apply the shared redaction invariant: a non-internal `LunoraError`
            // keeps its intentional, developer-facing message; an internal-coded
            // or bare/unexpected throw is redacted so SQL fragments, file paths,
            // or internal identifiers never reach the client.
            const { body, redacted } = toErrorBody(error, { fallbackCode: "INTERNAL_SERVER_ERROR", redactedMessage: "internal error" });

            if (redacted) {
                // eslint-disable-next-line no-console -- server-side diagnostic for an internal/unhandled stream error
                console.error("[@lunora/do] unhandled stream error:", error);
            }

            trySendFrame(
                ws,
                JSON.stringify({
                    error: { code: body.code, message: body.message },
                    id,
                    type: "error",
                }),
            );
        } finally {
            cancellers.delete(id);

            // Drop the now-empty per-socket canceller map so a socket that
            // churns through many short-lived streams doesn't accumulate empty
            // `Map` instances for the lifetime of the WeakMap entry.
            if (cancellers.size === 0) {
                this.streamCancellers.delete(ws);
            }
        }
    }

    /**
     * Attach a socket to a **durable** stream run.
     *
     * Everything about the run's lifecycle — who may attach to a stored
     * transcript, when a dead run is reclaimed, driving the producer — lives in
     * `@lunora/shard-engine`'s {@link DurableStreamRunner}, because none of it is
     * Cloudflare-specific. This method is the socket adapter: it derives the run
     * key, turns the WebSocket into a sink, and wires the client's cancel.
     *
     * The run key folds in the socket's **verified identity**. Sharing a live run
     * is the feature — a second tab of the same user watches one generation
     * instead of paying for two — but an attach never drives the handler, so a
     * run shared across identities would also skip the procedure's RLS
     * middleware. Identity-scoping the key is what keeps that impossible.
     */
    private async attachDurableStream(
        ws: ShardSocketLike,
        id: string,
        functionPath: string,
        args: Record<string, unknown>,
        registration: { durable: { ttlMs?: number }; iterator: (signal: AbortSignal) => AsyncIterable<unknown> },
        sinceChunk: number,
        generation?: number,
    ): Promise<void> {
        const attachment = this.readAttachment(ws);
        // An ANONYMOUS caller shares nothing. Falling back to a constant here
        // collapsed every anonymous caller onto one key, so the second caller
        // read the first one's transcript and the handler never ran for them —
        // the same cross-caller leak the identity scope closes for signed-in
        // users, on the path where there is no identity to check. The socket's
        // connection id keeps each one to its own run; the cost is that an
        // anonymous reload starts over, which is the honest answer when nothing
        // durable identifies the caller.
        const caller = attachment.userId ?? anonymousStreamCaller(attachment, id);
        const runKey = `${caller}\u0000${functionPath}:${stableWireKey(args)}`;
        const cancellers = socketMap(this.streamCancellers, ws);
        const controller = new AbortController();
        const frames = streamFrames(ws, id);

        cancellers.set(id, controller);
        frames.ack();

        const detach = (): void => {
            cancellers.delete(id);

            // Drop the now-empty per-socket canceller map so a socket that churns
            // through many short-lived streams doesn't accumulate empty `Map`s.
            if (cancellers.size === 0) {
                this.streamCancellers.delete(ws);
            }
        };

        let delivered = 0;

        const sink: DurableStreamSink = {
            chunk: (chunk) => {
                if (chunk.seq <= delivered) {
                    return true;
                }

                // Same mid-run expiry rule as the ephemeral pump. `false` is the
                // sink contract's "this consumer is gone", so the runner drops it
                // and the transcript keeps producing for whoever else is attached.
                if (this.isSocketExpired(ws)) {
                    this.dropExpiredSocket(ws);
                    detach();

                    return false;
                }

                delivered = chunk.seq;

                return frames.chunk(chunk.data, chunk.seq, chunk.generation);
            },
            complete: () => {
                frames.complete();
                detach();
            },
            fail: (failure) => {
                frames.fail(failure);
                detach();
            },
        };

        // Cancelling a durable stream detaches this consumer; the producer keeps
        // going so the transcript completes for whoever attaches next. That is
        // the whole point of declaring it durable.
        controller.signal.addEventListener("abort", () => {
            this.durableStreams.detach(runKey, sink);
            detach();
        });

        await this.durableStreams.attach({
            ...(generation === undefined ? {} : { generation }),
            iterator: registration.iterator,
            runKey,
            sinceChunk,
            sink,
            ...(registration.durable.ttlMs === undefined ? {} : { ttlMs: registration.durable.ttlMs }),
        });
    }

    /**
     * Drain the tables written during the in-flight RPC and re-run every
     * subscription that depends on one of them. Called after `handleRpc`
     * resolves, and per-batch during a data migration via
     * `flushMigrationProgress`. No-op when nothing was written.
     *
     * When the DO state exposes `waitUntil`, the refresh runs off the
     * response path so the client doesn't block on subscription fan-out —
     * a wide subscription set on a hot DO could otherwise add tens of ms
     * to every write's tail latency. The user-facing write is already
     * durable by the time we return; subscribers observe the change
     * shortly after.
     */
    private async flushChangedTables(): Promise<void> {
        const changed = this.pendingChangedTables;
        const changedKeys = this.pendingChangedKeys;

        this.pendingChangedTables = undefined;
        this.pendingChangedKeys = undefined;

        if (!changed || changed.size === 0) {
            return;
        }

        // Merge this request's written tables into the coalesced refresh set.
        if (this.pendingRefreshTables) {
            for (const table of changed) {
                this.pendingRefreshTables.add(table);
            }
        } else {
            this.pendingRefreshTables = changed;
        }

        this.pendingRefreshKeys = mergeChangedKeys(this.pendingRefreshKeys, changedKeys, changed);

        // Single-waiter coalescing: if a refresh pass is already draining, it
        // will observe the tables we just merged before it finishes, so a burst
        // of mutations collapses into one extra pass instead of one pass each.
        // This mirrors the in-flight evaluation lock that keeps a hot shard from
        // re-running every live query once per write.
        if (this.refreshInFlight) {
            return;
        }

        // The drain loop re-runs each subscription under the socket's OWN
        // verified identity (stamped on the attachment at upgrade), threaded as
        // an explicit `SubscriptionIdentity` by value — so the deferred re-run
        // neither reads nor mutates the shared per-request identity fields.
        // Crucial here because this refresh is dispatched via `waitUntil` (a
        // LATER macrotask), where a concurrent in-flight RPC owns
        // `currentRequestUserId`. See {@link SubscriptionIdentity}.

        // Two independent fan-outs share the post-write watermark: the legacy
        // subscription re-execution path and the shape poke protocol (poke
        // subscribers only exist on shape-aware shards, so the poke arm is a
        // no-op there). Both run inside the coalescing drain loop so a burst of
        // writes collapses into one extra pass, and both defer off the response
        // path when `waitUntil` is available so the write's tail latency stays
        // flat.
        // `background` returns false when the host cannot outlive the response,
        // in which case the drain has to be awaited inline. Built once and passed
        // in, NOT called twice: `drainSubscriptionRefreshes()` starts the drain,
        // so evaluating it in both arms would start a second one.
        const drain = this.drainSubscriptionRefreshes();

        if (this.runner.background(drain)) {
            return;
        }

        await drain;
    }

    /**
     * Drain {@link ShardDO.pendingRefreshTables} one coalesced batch at a time
     * until it is empty, then release the {@link ShardDO.refreshInFlight} gate.
     * Tables merged by a `flushChangedTables` that lands mid-pass are picked up
     * by the next loop iteration, so every committed write is observed by a
     * refresh that runs after it — bursts simply share a pass. The post-write
     * high-watermark and live-socket set are re-read inside each
     * `refreshSubscriptions` / `pokeShapeSubscribers` call, so a later batch
     * always reflects the latest committed state.
     */
    private async drainSubscriptionRefreshes(): Promise<void> {
        // Defensive re-entry guard: the real coalescing gate lives in the sole
        // caller (`flushChangedTables` returns early when a drain is in flight),
        // so this should never fire. It is belt-and-suspenders against a future
        // direct caller — not the load-bearing coalescer.
        if (this.refreshInFlight) {
            return;
        }

        this.refreshInFlight = true;

        // Per-DRAIN run counter, keyed by reactor path — the convergence bound.
        // Scoped to the drain rather than to the instance so an app under
        // sustained legitimate write load is never throttled: a new drain starts
        // every reactor's budget over. What it does catch is the reactor whose own
        // writes keep changing its own read, which cascades within ONE drain and
        // would otherwise spin the shard forever.
        const reactorRuns = new Map<string, number>();

        try {
            let batch = this.pendingRefreshTables;
            let batchKeys = this.pendingRefreshKeys;

            while (batch && batch.size > 0) {
                this.pendingRefreshTables = undefined;
                this.pendingRefreshKeys = undefined;

                // Resolve the post-write cut once per coalesced batch; it covers
                // every write merged into this batch. Run the legacy refresh and
                // the shape poke fan-out together off the same watermark.
                const frameCursor = this.currentCdcCursor();
                const frameEpoch = this.currentCdcEpoch();

                // eslint-disable-next-line no-await-in-loop -- passes are intentionally sequential: each observes the prior pass's committed state and the tables merged while it ran
                await Promise.all([
                    this.refreshSubscriptions(batch, batchKeys),
                    this.pokeShapeSubscribers(batch, frameCursor, frameEpoch),
                    this.relay?.onFlush(batch, frameCursor ?? 0),
                ]);

                // Reactors run AFTER the read fan-out, not alongside it. Two
                // reasons: subscribers should observe the state the mutation
                // committed before a reactor mutates it further (the reactor's own
                // writes re-enter this loop and push again), and a reactor opens a
                // write transaction — which has no business racing the read
                // fan-out inside one `Promise.all`.
                // eslint-disable-next-line no-await-in-loop -- same sequencing contract as the fan-out above
                await this.dispatchReactors(batch, reactorRuns);

                batch = this.pendingRefreshTables;
                batchKeys = this.pendingRefreshKeys;
            }

            // Every consumer that was going to advance its durable cursor for
            // these writes has done so, so this is the point at which the
            // retention floor is highest and a sweep reclaims the most. Throttled
            // internally, and a no-op unless retention is configured.
            this.cdcRetention.sweep();
        } finally {
            this.refreshInFlight = false;
        }
    }

    /**
     * For every live subscription whose query reads one of `changed`, re-run
     * the query and push a fresh `{ type: "data" }` frame when the result
     * differs from the last one sent. Subscriptions with no `functionPath`
     * (legacy delta-only) are left to `broadcastDelta`.
     *
     * The per-socket loop runs in parallel across sockets, bounded so a
     * shard with thousands of live subscribers doesn't spin up thousands
     * of `executeSubscription` calls in lockstep and saturate the DO
     * isolate. Within a single socket we stay sequential — the same
     * subscription set is small (cap of {@link ShardDO.MAX_SUBSCRIPTIONS_PER_SOCKET}).
     *
     * ----------------------------------------------------------------------
     * Audit finding #5 — N identical subscriptions ⇒ N query runs per change.
     * ----------------------------------------------------------------------
     * This loop executes `executeSubscription` once PER (socket, sub). When N
     * sockets subscribe to the SAME `(functionPath, args)`, a single write that
     * touches a read table re-runs the identical query N times. The N-runs
     * fan-out is characterized by the `profile:` case in
     * `subscription-refresh.integration.test.ts`.
     *
     * Cross-socket execution dedup (group identical `(functionPath, args)`, run
     * + serialize once, fan the same frame to every sharing socket) was
     * INVESTIGATED and DELIBERATELY NOT implemented here, because it would change
     * observable behavior rather than being a pure optimization:
     *
     * (a) Per-socket memo divergence. The frame a socket receives depends on its
     * OWN `subMemos` entry (`pushSubscriptionData`): one socket may need a
     * `{type:"delta"}`, a freshly-subscribed socket a full `{type:"data"}`
     * snapshot, and an up-to-date socket nothing at all. So only the QUERY RUN +
     * its result can be shared — `pushSubscriptionData` must still run per socket.
     * Dedup saves the N-1 redundant runs, not the fan-out.
     *
     * (b) Side-effect cardinality. The real `executeSubscription` lives in the
     * codegen subclass and dispatches the user handler, which records function
     * metrics, scan attribution, and `ctx.log` lines PER RUN. N subscribers today
     * produce N metric samples / N log lines; collapsing to one run silently
     * under-counts those in the studio. The base class can't see inside the
     * override, so it can't make that trade safely.
     *
     * (c) Error attribution. A throwing run is contained per (socket, sub) here
     * (see the catch below, and the integration test's isolation cases). A shared
     * run would have to fan one failure to every sharing socket while preserving
     * the "leave memo untouched ⇒ re-run next flush" contract.
     *
     * The opt-in {@link ReactiveCache} (`ShardDOOptions.reactiveCache`) does NOT
     * cover this, despite the shared key shape: it wraps `/rpc` query dispatch
     * (see {@link ShardDO.runCachedQuery}), while a refresh runs through
     * `executeSubscription`, which never consults it. It cannot, either — a
     * subscription's re-run is only half about the value. The other half is the
     * `tables`/`ranges` footprint it reports, which is what decides whether the
     * NEXT write re-runs it; a cache hit produces a value with no footprint, so
     * routing refreshes through the cache would quietly empty every memo's
     * dependency set and stop the subscription updating at all.
     *
     * So this fan-out stands as characterized. Collapsing it needs a dedup that
     * shares the footprint alongside the value — {@link ShardDO.resolveReactiveOutcomeDeduped}
     * is that, per flush, for the identity-independent subset — not a second
     * memo bolted into this loop.
     */

    /**
     * Count and log a subscription-delivery error that its caller is about to
     * swallow (DO-01) — `refreshSubscriptions`' per-`(socket, sub)` catch and
     * `pokeShapeSubscribers`' per-socket catch both call this instead of a bare
     * `catch { continue; }`, so a live query or shape poke that throws
     * DETERMINISTICALLY on every flush is counted on `metrics.subscriptionRefreshErrors`
     * and shows up in the studio's Live Logs, rather than repeating silently for
     * the life of the socket. Factored out because both call sites need the
     * identical counter-then-best-effort-log shape, and duplicating it inline
     * pushed each closure over the file's cognitive-complexity budget.
     *
     * `lastTelemetrySink` (not a threaded `sink`) because both flush workers run
     * with no `ctx` — the same stand-in `flushTelemetry` uses.
     *
     * `error` is a caught INTERNAL failure surfaced from a background
     * refresh/poke pass, not a value a developer chose to log via `ctx.log` —
     * so `recordUserLog`'s "args are not redacted" contract (see its
     * docstring) does not apply here: a thrown value can carry an arbitrary
     * `cause`, stack, or custom own property (a handler can `throw
     * Object.assign(new Error(...), { row })`), and `args` rides raw into any
     * `sink.onLog` an operator has configured. Route it through the same
     * `toErrorBody` envelope every other error-crossing boundary in this file
     * uses (see `errorToResponse`, the shape-seed catches above) so only a
     * bounded `{ code, message }` — not the raw error — reaches the sink.
     */
    private recordSubscriptionRefreshError(functionPath: string, error: unknown, fields: Record<string, unknown>): void {
        this.metrics.subscriptionRefreshErrors += 1;

        try {
            const { body } = toErrorBody(error, { fallbackCode: "SUBSCRIPTION_REFRESH_FAILED", redactedMessage: "subscription refresh failed" });

            this.recordUserLog(functionPath, "error", [body], body.message, fields, this.lastTelemetrySink, "subscriptionRefreshError");
        } catch {
            // Best-effort, matching every other telemetry call on this path.
        }
    }

    private async refreshSubscriptions(changed: Set<string>, changedKeys?: Map<string, IndexKeyEntry[] | undefined>): Promise<void> {
        const sockets = [...this.runner.sockets()];

        // The post-write high-watermark is the same for every sub flushed in
        // this pass (they all observe the committed state), so resolve it once
        // and stamp it on every frame as the cursor each subscriber advances to.
        const frameCursor = this.currentCdcCursor();
        const frameEpoch = this.currentCdcEpoch();

        // Flush-local dedup of identity-INDEPENDENT reactive runs: N sockets on
        // the same admin/reserved `(functionPath, args)` share ONE query run this
        // pass instead of re-running it per socket. Created fresh per flush so a
        // result is never reused across writes; identity-dependent reads bypass it
        // entirely (see resolveReactiveOutcomeDeduped).
        const reactiveRunCache = new Map<string, Promise<SubscriptionOutcome | null>>();

        const refreshOne = async (ws: ShardSocketLike): Promise<void> => {
            // Enforce token-expiry on the OUTBOUND path: a lapsed socket must not
            // keep receiving its user's live (RLS/`ctx.auth`-scoped) data. This is
            // the load-bearing check — a passive subscriber never sends an inbound
            // frame, so `webSocketMessage`'s check would never fire for it. Drop
            // the socket and skip its push.
            if (this.isSocketExpired(ws)) {
                this.dropExpiredSocket(ws);

                return;
            }

            const attachment = this.readAttachment(ws);

            // Resolved once per socket per flush, not once per affected
            // subscription below — both depend only on this socket, and are
            // identical for every subscription on it. See {@link SocketDelivery}.
            const delivery = this.socketDelivery(attachment);
            // Resolved once per socket per flush for the same reason: an admin
            // subscription's authorization is REVOCABLE, and the loop below
            // re-derives `isAdmin` from the function path alone.
            const adminAuthorized = await this.attachmentAdminAuthorized(attachment);

            // `Object.keys` for the same reason as `broadcastDelta` — see there.
            const { subs } = attachment;

            for (const subId of Object.keys(subs)) {
                const query = subs[subId];

                // One guard, not two: a truthy `functionPath` already proves
                // `query` is present, and splitting them pushed this function
                // past the cognitive-complexity ceiling for no benefit.
                if (!query?.functionPath) {
                    continue;
                }

                const { functionPath } = query;

                // A subscription registered BEFORE the procedure was paywalled
                // is still sitting in this socket's hibernated attachment, and
                // the registration-time gate in `subscribe` can no longer see
                // it. Without this it keeps being re-run and pushed on every
                // write for the life of the socket — the paid result, free.
                if (this.isPaidFunction(functionPath)) {
                    this.unsubscribe(ws, subId);
                    this.sendSubscriptionError(ws, subId, "BAD_REQUEST", paidSocketRefusal(functionPath, "subscribed"));

                    continue;
                }

                const isAdmin = functionPath.startsWith(ADMIN_FUNCTION_PREFIX);

                // Same drift as the paywall above, on the credential rather than
                // the price: `isAdmin` is recomputed from the PATH, so without
                // this an admin subscription registered under a token that has
                // since been rotated or cleared keeps being re-run and pushed —
                // arbitrary read-only SQL over the shard — for the life of the
                // socket. The token is checked at upgrade and never again.
                if (isAdmin && !adminAuthorized) {
                    this.unsubscribe(ws, subId);
                    this.sendSubscriptionError(ws, subId, "FORBIDDEN", "admin authorization for this socket is no longer valid");

                    continue;
                }

                const memo = this.subMemos.get(ws)?.get(subId);

                if (memoProvesUnchanged(memo, changed, changedKeys)) {
                    continue;
                }

                try {
                    // Re-run under the socket's OWN verified identity (stamped on the
                    // attachment at upgrade, unforgeable by the client) — passed BY
                    // VALUE, so this deferred re-run never reads or mutates the shared
                    // per-request identity fields. Without it an `rls()` / `ctx.auth`
                    // scoped live query would evaluate anonymous and return zero rows.
                    // (Admin + reserved flag reads ignore the identity payload.)
                    // eslint-disable-next-line no-await-in-loop -- subscriptions on a socket re-run sequentially; each shares the single SQLite handle
                    const outcome = await this.resolveReactiveOutcomeDeduped(
                        functionPath,
                        query.args ?? {},
                        isAdmin,
                        { identity: attachment.identity, userId: attachment.userId },
                        reactiveRunCache,
                    );

                    if (!outcome) {
                        continue;
                    }

                    // Backpressure: a write storm fanning out to a slow consumer
                    // would otherwise grow this socket's outbound buffer without
                    // bound (the runtime queues every `ws.send`). Pause this
                    // socket's fan-out until its buffer drains — the per-socket
                    // workers run in parallel, so one backed-up socket never
                    // stalls the others. Mirrors the `handleStream` gate.
                    // eslint-disable-next-line no-await-in-loop -- intentional per-socket backpressure: drain before pushing the next subscription's frame
                    await awaitWsDrain(ws);

                    this.pushSubscriptionData(ws, subId, outcome, frameCursor, frameEpoch, delivery);
                } catch (error) {
                    // A throwing subscription must not abort the refresh of its
                    // siblings, nor fail the mutation that triggered it. The memo
                    // is left untouched ("unknown deps"), so this subscription
                    // re-runs on the next flush — but until now that failure was
                    // silent (DO-01): a subscription whose refresh throws
                    // DETERMINISTICALLY (a bad handler cast, say) repeated
                    // unnoticed for the life of the socket with no signal an
                    // operator could see anywhere. See `recordSubscriptionRefreshError`.
                    this.recordSubscriptionRefreshError(functionPath, error, { subId });

                    continue;
                }
            }
        };

        // Bounded fan-out (default 8 in flight): each worker drains its sockets
        // one at a time so the per-subscription `awaitWsDrain` gate above paces a
        // slow consumer. See {@link runSocketPool}.
        await runSocketPool(sockets, refreshOne);
    }

    /**
     * Run {@link ShardDO.seedSubscription} and fail the ONE subscription — never
     * the socket — when its handler throws.
     *
     * The seed dispatches the user's query: it re-validates the args and runs
     * the procedure's auth/RLS middleware, so an anonymous socket subscribing to
     * an `authQuery`, a bad argument, or a handler `NOT_FOUND` rejects here.
     * Under the WS hibernation API a throw out of `webSocketMessage` is a
     * FATAL-CHANNEL error (see the analysis on `webSocketError`): the runtime
     * tears the socket down, taking every OTHER live subscription on it with
     * it — and the client already saw this subscribe's `ack`, which resets its
     * reconnect backoff, so it reconnects, resubscribes, throws again, and
     * spins at the initial delay for the life of the page.
     *
     * So: drop the just-registered subscription from the attachment and answer
     * with a structured `error` frame carrying the thrown error's code. Mirrors
     * `refreshSubscriptions`' per-`(socket, sub)` catch on the write-flush half
     * of the same path, and `handleShapeSubscribe`'s rollback-then-error on a
     * failed shape seed.
     */
    private async seedSubscriptionGuarded(ws: ShardSocketLike, subId: string, query: SubscriptionQuery, functionPath: string, isAdmin: boolean): Promise<void> {
        try {
            await this.seedSubscription(ws, subId, query, functionPath, isAdmin);
        } catch (error: unknown) {
            // Deregister first: a subscription that never seeded must not be
            // refreshed by the next write flush either.
            this.unsubscribe(ws, subId);
            this.recordSubscriptionRefreshError(functionPath, error, { subId });

            // Same redaction envelope as every other error-crossing boundary in
            // this file: a deliberate `LunoraError` keeps its code and message
            // (`UNAUTHORIZED`, `NOT_FOUND`, a validator's `BAD_REQUEST`), an
            // internal or bare throw is redacted.
            const { body } = toErrorBody(error, { fallbackCode: "SUBSCRIPTION_SEED_FAILED", redactedMessage: "subscription seed failed" });

            this.sendSubscriptionError(ws, subId, body.code, body.message);
        }
    }

    /**
     * Seed a freshly-registered subscription with its first value. Runs the
     * query once, then takes one of two paths.
     *
     * The default path ships the full snapshot via {@link pushSubscriptionData}
     * — a first-time subscribe, an admin sub, or a reconnect whose read-set
     * changed (or fell outside the CDC retention window) since its cursor.
     *
     * The resume path sends a lightweight `resume` frame — a reconnecting client
     * that supplied `sinceSeq` and is still current keeps its cached value and
     * only advances its cursor, saving the full-snapshot round-trip.
     *
     * Either way the fresh result memoises this socket's diff baseline so later
     * write-flushes ({@link refreshSubscriptions}) can emit incremental deltas.
     *
     * MAY THROW: it runs the real handler (arg re-validation plus the whole
     * auth/RLS middleware chain). Every caller goes through
     * {@link ShardDO.seedSubscriptionGuarded}, which owns that failure.
     */
    private async seedSubscription(ws: ShardSocketLike, subId: string, query: SubscriptionQuery, functionPath: string, isAdmin: boolean): Promise<void> {
        const seedArgs = query.args ?? {};
        // Seed under the socket's OWN verified identity (stamped on the attachment
        // at upgrade, unforgeable by the client) — read here and passed BY VALUE,
        // so even though a subscribe envelope can interleave with an in-flight RPC
        // (the seed parks at the handler's first non-storage await), we never read
        // the shared per-request identity field that RPC might be mutating. This is
        // what makes an `rls()` / `ctx.auth`-scoped live query return the
        // subscriber's own rows instead of evaluating anonymous.
        const attachment = this.readAttachment(ws);
        const outcome = await this.resolveReactiveOutcome(functionPath, seedArgs, isAdmin, {
            identity: attachment.identity,
            userId: attachment.userId,
        });

        if (!outcome) {
            return;
        }

        const { sinceEpoch, sinceSeq } = query;
        const resume = isAdmin || sinceSeq === undefined ? undefined : this.evaluateResume(sinceSeq, outcome.tables, sinceEpoch);
        // `evaluateResume` already read the epoch; reuse it and only fall back to
        // a fresh read when no resume was evaluated (first subscribe / admin).
        const epoch = isAdmin ? undefined : (resume?.epoch ?? this.currentCdcEpoch());

        if (resume?.resumable) {
            // Keep the per-socket baseline current (so the next change diffs
            // cleanly) but send only the cursor + epoch — the client already
            // holds an equivalent value at `sinceSeq`.
            this.seedSubscriptionMemo(ws, subId, outcome);

            try {
                trySendFrame(ws, `{"type":"resume","id":${JSON.stringify(subId)}${cdcSuffix(resume.cursor ?? 0, epoch)}}`);
            } catch {
                /* socket may have closed between the ack and this seed */
            }

            return;
        }

        // A FRESH attachment read, not the one captured above: that one predates
        // the `resolveReactiveOutcome` await, and a `connect` envelope can land
        // during it. The identity above is deliberately by-value (see there);
        // the delivery facts are not, and reading them stale would drop a
        // `clientId`/capability this socket has since announced.
        this.pushSubscriptionData(ws, subId, outcome, resume?.cursor ?? this.currentCdcCursor(), epoch, this.socketDelivery(this.readAttachment(ws)));
    }

    /**
     * Resolve the per-socket delivery facts a subscription push needs, from the
     * attachment the caller already holds.
     *
     * Takes the attachment rather than the socket deliberately: neither field
     * needs anything else from `ws`, and every caller has just read one. An
     * earlier shape took `ws` with the attachment as an optional hint, which
     * did not do what it claimed — `socketClientWatermark` read the attachment
     * again internally, so the "already read it" fast path still deserialized
     * twice on the refresh path and three times on the seed path.
     */
    private socketDelivery(attachment: SocketAttachment): SocketDelivery {
        return {
            clientWatermark: this.socketClientWatermark(attachment),
            pageDeltas: attachment.pageDeltas === true,
        };
    }

    /**
     * Drive the full `shape_subscribe` flow as one failure-aware unit: persist the
     * attachment, seed the shape, and ack ONLY once both succeed. A persist
     * rejection (`too_many`/`serialize_failed`) or a seed that can't resolve the
     * shape (unknown / RLS-denied / cross-shard-invalid) rolls the attachment back
     * and sends an `error` frame instead of acking — so a client is never left
     * acked but subscribed to a shape that will never deliver. Never throws (a
     * thrown `webSocketMessage` is fatal to the hibernating socket).
     */
    private async handleShapeSubscribe(ws: ShardSocketLike, subId: string, shape: ShapeSubscriptionQuery): Promise<void> {
        const status = this.shapeSubscribe(ws, subId, shape);

        if (status !== "ok") {
            const code = status === "too_many" ? "TOO_MANY_SUBSCRIPTIONS" : "SUBSCRIPTION_PERSIST_FAILED";
            const message = subscriptionRefusal(status === "too_many" ? "count" : "size", ShardDO.MAX_SUBSCRIPTIONS_PER_SOCKET, ShardDO.MAX_ATTACHMENT_BYTES);

            this.sendSubscriptionError(ws, subId, code, message);

            return;
        }

        // Seed the fresh shape with its initial membership as one insert-poke (or a
        // catch-up diff when the client is still current). On a resolve failure,
        // roll back the just-persisted attachment and error instead of acking.
        const seed = await this.seedShapeSubscription(ws, subId, shape);

        if (seed !== "ok") {
            this.shapeUnsubscribe(ws, subId);
            this.sendSubscriptionError(ws, subId, seed.code, seed.message);

            return;
        }

        // Both persistence and seeding succeeded — ack last (the client keys pokes
        // by shape id, not the ack, so the seed poke arriving first is fine).
        try {
            trySendFrame(ws, JSON.stringify({ id: subId, type: "ack" }));
        } catch {
            /* socket may already be closed; never throw out of webSocketMessage */
        }
    }

    /** Send a structured `error` frame for a failed `subscribe`/`shape_subscribe`, swallowing a send on an already-closed socket. */
    // eslint-disable-next-line class-methods-use-this -- groups with the subscribe flows; uses only its args + the socket
    private sendSubscriptionError(ws: ShardSocketLike, subId: string, code: string, message: string): void {
        try {
            trySendFrame(ws, JSON.stringify({ code, error: { code, message }, id: subId, type: "error" }));
        } catch {
            /* socket may already be closed; never throw out of webSocketMessage */
        }
    }

    /**
     * Seed a freshly-registered shape subscription. Resolves the shape under the
     * socket's verified identity, then ships either:
     *
     * - a **catch-up** poke (the membership diff in `(sinceCheckpoint, cursor]`)
     * when the client supplied a still-current checkpoint within the CDC retention
     * window and on this epoch — the cheap reconnect path; or
     * - a **full** insert-poke of the shape's entire current membership — a
     * first-time subscribe, or a reconnect that fell outside retention / forked
     * epoch.
     *
     * Either way the per-socket shape memo advances to the flush watermark so
     * later `pokeShapeSubscribers` passes diff from the right point.
     *
     * Returns `"ok"` once the shape resolved and its seed poke was attempted, or a
     * `{ code, message }` failure when the shape can't be resolved — an unknown /
     * RLS-denied shape (a base class with no registry resolves nothing), or a
     * `resolveShape` that threw (e.g. a cross-shard-join guard). The caller rolls
     * back the persisted attachment and errors instead of acking, so a client is
     * never left subscribed to a shape that will never deliver.
     */
    private async seedShapeSubscription(ws: ShardSocketLike, subId: string, shape: ShapeSubscriptionQuery): Promise<"ok" | { code: string; message: string }> {
        const attachment = this.readAttachment(ws);
        const identity: SubscriptionIdentity = { identity: attachment.identity, userId: attachment.userId };

        // Relay tier (plan 075 Phase 3): a relay holds no op-log, so it forwards the
        // seed to the owner — the only DO that can resolve the shape against real
        // data, under this socket's verified identity (RLS-correct) — and delivers
        // the owner-computed frames. A non-relay DO returns `undefined` here, falling
        // through to the owner-served path (unchanged).
        const relayed = await this.relay?.seedRelayShape(ws, subId, shape, identity);

        if (relayed !== undefined) {
            return relayed;
        }

        let resolved: ResolvedShape | undefined;

        try {
            resolved = this.resolveShape(shape.name, shape.args ?? {}, identity);
        } catch (error) {
            // A throwing `resolveShape` must not reject the whole `shape_subscribe`
            // (and with it the socket's message handling). Surface it for diagnosis
            // and report a failure so the caller errors instead of acking. Preserve
            // a structured error's `code` (e.g. the cross-shard-join guard).
            this.recordShapeError(`shape:seed:${subId}`, error);

            const { body } = toErrorBody(error, { fallbackCode: "SHAPE_RESOLVE_FAILED", redactedMessage: "shape resolution failed" });

            return { code: body.code, message: body.message };
        }

        if (!resolved) {
            return { code: "SHAPE_NOT_FOUND", message: `shape "${shape.name}" not found or not permitted` };
        }

        // A shard-local shape is replicated FROM the changelog: `pokeShapeSubscribers`
        // diffs it out of `__cdc_log` on every flush. With CDC off that table does
        // not exist, so the seed below succeeds (it reads the table, not the log)
        // and every later diff throws `no such table` into a per-shape catch — the
        // client renders its initial snapshot and is then never told about another
        // row, for the life of the socket, with nothing but a
        // `subscriptionRefreshErrors` counter to say so.
        //
        // Refused at subscribe time instead, naming the switch. `.global()` shapes
        // are driven by the poll loop rather than this log and are unaffected.
        if (!resolved.global && !this.cdcEnabled()) {
            return {
                code: "SHAPE_REQUIRES_CDC",
                message: `shape "${shape.name}" replicates from the changelog, which this app has not enabled — call .cdc() on defineApp()`,
            };
        }

        // Everything past resolution — the global D1 read, the op-log diff/seed
        // build, and the membership probes inside them — can throw (a missing
        // backend, a stub `sql` handle, an over-cap global membership). Wrap the
        // whole seed so any failure becomes a structured `{ code, message }` the
        // caller rolls back and errors on, rather than rejecting `webSocketMessage`
        // and tearing down the socket's message handling.
        try {
            // A `.global()`-table shape has no op-log to resume/diff: seed it from D1
            // and let the alarm poll loop drive updates (latency-tiered, not poke-live).
            if (resolved.global) {
                return await this.seedGlobalShape(ws, subId, resolved, identity, attachment.connectionId ?? "");
            }

            return await this.seedOpLogShape(ws, attachment.connectionId ?? "", subId, shape, resolved);
        } catch (error) {
            this.recordShapeError(`shape:seed:${subId}`, error);

            const { body } = toErrorBody(error, { fallbackCode: "SHAPE_SEED_FAILED", redactedMessage: "shape seed failed" });

            return { code: body.code, message: body.message };
        }
    }

    /**
     * Seed a non-`.global()` (op-log-backed) shape: either a catch-up diff over
     * `(sinceSeq, cursor]` when the client supplied a still-current checkpoint on
     * this epoch within the CDC retention window, or a full membership insert-poke
     * otherwise. The memo advances to `cursor` only once the poke is delivered, so
     * a failed send re-diffs from the prior point rather than skipping rows. May
     * throw (a stub `sql` handle, a membership probe failure); the caller converts
     * it to a structured `shape_subscribe` error.
     */
    private async seedOpLogShape(
        ws: ShardSocketLike,
        connectionId: string,
        subId: string,
        shape: ShapeSubscriptionQuery,
        resolved: ResolvedShape,
    ): Promise<"ok"> {
        const { baseCheckpoint, cursor, epoch, reset, rowsPatch } = this.computeOpLogShapeSeed(shape, resolved);

        // Await drain before the (potentially large) seed poke so a slow consumer
        // can't grow this socket's outbound buffer without bound.
        await awaitWsDrain(ws);

        // `reset` marks the full-membership branch so the client REPLACES its view
        // instead of splicing onto it. A seed is inserts-only, so without the flag a
        // row deleted while the client was away is never removed on reconnect.
        if (this.sendPoke(ws, [{ baseCheckpoint, reset, rowsPatch, shapeId: subId }], cursor, epoch, baseCheckpoint)) {
            this.recordShapeMemo(ws, connectionId, subId, cursor, { carriedRows: true });
        }

        return "ok";
    }

    /**
     * Compute an op-log shape seed (cursor, epoch, the resume base, and the
     * membership `rowsPatch`) WITHOUT sending — the shared core of
     * {@link ShardDO.seedOpLogShape} (sends to a local socket) and the owner relay's
     * `buildShapeSeedFrames` (serializes the frames for a relay to deliver, plan 075
     * Phase 3, via the {@link RelayHost} seam). Resume only when CDC is on, the client is on this
     * epoch, its checkpoint doesn't run ahead of ours, and the log still covers it;
     * else a full re-seed. A fully-compacted log only proves "nothing missed" when
     * the client is already at `cursor`.
     *
     * `reset` is the inverse of the resume decision and MUST ride the wire: the
     * re-seed branch returns the whole membership as inserts, which can only ever
     * add rows, so a client that splices it onto a stale view keeps every row that
     * left the shape while it was disconnected. Callers stamp it on the poke part.
     * @returns the cursor/epoch, the resume base (`baseCheckpoint`), whether this is a full re-seed, and the membership patch
     */
    private computeOpLogShapeSeed(
        shape: ShapeSubscriptionQuery,
        resolved: ResolvedShape,
    ): { baseCheckpoint: number | undefined; cursor: number; epoch: string | undefined; reset: boolean; rowsPatch: ShapeRowOp[] } {
        const sql = this.sql as SqlExec;
        const cursor = this.currentCdcCursor() ?? 0;
        const currentEpoch = this.currentCdcEpoch();
        const floor = this.cdcEnabled() ? minCdcSeq(sql) : undefined;
        const onThisTimeline = currentEpoch !== undefined && shape.sinceEpoch === currentEpoch;

        // Same rollback proof the subscription path acts on, and for the same
        // reason: a checkpoint ahead of our cursor on OUR epoch is the only
        // evidence of a PITR restore that the restore itself cannot revert. Seal
        // the fork here too, or a shape client that reconnects while the rewound
        // cursor is still low would re-seed correctly while every LATER one — by
        // then back inside the range — resumes across it. See
        // {@link ShardDO.sealForkedTimeline}.
        const rolledBack = this.cdcEnabled() && shape.sinceSeq !== undefined && onThisTimeline && shape.sinceSeq > cursor;
        const epoch = rolledBack ? this.sealForkedTimeline() : currentEpoch;

        const canResume =
            this.cdcEnabled() &&
            shape.sinceSeq !== undefined &&
            onThisTimeline &&
            shape.sinceSeq <= cursor &&
            // Not simply `!cursorBelowRetainedFloor(...)`: that is true for an
            // empty log too, and an empty log cannot vouch for the range.
            (shape.sinceSeq === cursor || (floor !== undefined && !cursorBelowRetainedFloor(floor, shape.sinceSeq)));

        const rowsPatch =
            canResume && shape.sinceSeq !== undefined
                ? this.diffShape(sql, resolved, shape.sinceSeq, cursor, createShapeDiffCache())
                : this.buildShapeSeed(sql, resolved);

        return { baseCheckpoint: canResume ? shape.sinceSeq : undefined, cursor, epoch, reset: !canResume, rowsPatch };
    }

    /**
     * Fan the membership diff of every shape affected by this flush to its
     * subscribers — the partial-replication parallel to
     * {@link ShardDO.refreshSubscriptions}, called alongside it from
     * {@link ShardDO.flushChangedTables}. For each socket (bounded fan-out, same
     * concurrency + `awaitWsDrain` backpressure as the subscription path) it
     * resolves each shape under the socket's identity, diffs the shapes whose
     * table changed in `(memoCursor, frameCursor]` — plus any still owing rows an
     * earlier flush failed to deliver — and emits one poke carrying a part per
     * changed shape. No-op when no socket holds a shape.
     */
    private async pokeShapeSubscribers(changed: Set<string>, frameCursor: number | undefined, frameEpoch: string | undefined): Promise<void> {
        const sockets = [...this.runner.sockets()];
        const checkpoint = frameCursor ?? this.currentCdcCursor() ?? 0;
        const sql = this.sql as SqlExec;

        // Flush-local diff cache: shapes over the same op range share ONE changed-key
        // scan, and shapes resolving to the same predicate share ONE membership
        // probe, however many sockets hold them. Created fresh per flush so neither
        // is ever reused across writes (both would go stale). See {@link ShapeDiffCache}.
        const diffCache = createShapeDiffCache();

        // Observability (plan 075 Phase 1): count sockets this flush actually
        // poked so `getFanoutMetrics` can report the delivered-vs-iterated split.
        // Pure measurement — it never alters which sockets are poked.
        let delivered = 0;

        // Durable poke baselines for this whole fan-out, flushed in batches once
        // every socket has been visited. The in-memory memo is still set per
        // socket inside `recordShapeMemo`, so a read during this same flush sees
        // the new value without touching SQLite.
        const pendingCursors: ShapePokeCursorRow[] = [];

        const pokeOne = async (ws: ShardSocketLike): Promise<void> => {
            if (this.isSocketExpired(ws)) {
                this.dropExpiredSocket(ws);

                return;
            }

            const attachment = this.readAttachment(ws);
            const { shapes } = attachment;

            if (!shapes) {
                return;
            }

            const connectionId = attachment.connectionId ?? "";

            try {
                const identity: SubscriptionIdentity = { identity: attachment.identity, userId: attachment.userId };
                const { emptyAdvanced, partAdvanced, parts } = this.collectShapePokeParts(
                    ws,
                    connectionId,
                    shapes,
                    identity,
                    changed,
                    checkpoint,
                    sql,
                    diffCache,
                );

                // Empty-diff shapes advance regardless (nothing to deliver for them),
                // so the next flush doesn't re-scan the same op range.
                for (const subId of emptyAdvanced) {
                    this.recordShapeMemo(ws, connectionId, subId, checkpoint, { carriedRows: false, pending: pendingCursors });
                }

                // Await drain before the (potentially large) poke so a slow consumer
                // can't grow this socket's outbound buffer without bound — the same
                // backpressure the seed/refresh paths apply. Part-bearing shapes
                // advance only after the poke lands; a failed send leaves their memos
                // so the next flush re-emits the rows.
                if (parts.length > 0) {
                    // Marked owed BEFORE the send, not after a failure: `awaitWsDrain`
                    // and `sendPoke` can both throw out to the socket-level catch
                    // below, and a shape that owes rows must not be left looking
                    // settled on the way out. `recordShapeMemo` clears it on delivery.
                    for (const subId of partAdvanced) {
                        this.markShapeOwed(ws, subId);
                    }

                    await awaitWsDrain(ws);

                    if (this.sendPoke(ws, parts, checkpoint, frameEpoch, undefined)) {
                        delivered += 1;

                        for (const subId of partAdvanced) {
                            this.recordShapeMemo(ws, connectionId, subId, checkpoint, { carriedRows: true, pending: pendingCursors });
                        }
                    }
                }
            } catch (error) {
                // A throwing socket (e.g. awaitWsDrain/sendPoke rejecting on a dead
                // connection) must not abort the poke fan-out to its siblings — the
                // bounded pool runs sockets in parallel and one bad socket would
                // otherwise reject the whole Promise.all. Memos are left untouched,
                // so the next flush re-pokes this socket. Mirrors refreshSubscriptions,
                // including the DO-01 fix — see `recordSubscriptionRefreshError`. No
                // single `functionPath` applies to a shape poke (one socket can hold
                // several shapes), so the log is tagged with the admin-namespaced
                // pseudo-path below and the live shape ids.
                this.recordSubscriptionRefreshError(`${ADMIN_FUNCTION_PREFIX}pokeShapeSubscribers`, error, { shapeIds: Object.keys(shapes) });
            }
        };

        // Bounded fan-out matching `refreshSubscriptions`: each worker drains its
        // sockets one at a time so the per-send `awaitWsDrain` gate above applies
        // backpressure on a slow consumer. See {@link runSocketPool}.
        const startMs = Date.now();

        await runSocketPool(sockets, pokeOne);

        // One batched upsert per ~33 baselines instead of one statement per
        // delivered poke. Flushed after the pool rather than inside it so a socket
        // that threw (caught above) does not take its siblings' baselines with it.
        if (pendingCursors.length > 0) {
            try {
                writeShapePokeCursors(this.sql as SqlExec, pendingCursors);
            } catch {
                // Degrade to in-memory-only, exactly as the per-row write did: a
                // stub sql handle or a missing table must not fail the poke. The
                // baseline then falls back to the durable/sinceSeq chain, which
                // only ever degrades DOWNWARD (a re-scan, never a skipped row).
            }
        }

        // Record the fan-out cost of this flush (plan 075 Phase 1). `startMs` wraps
        // the whole pool, so the elapsed time captures the awaited drain/send I/O
        // across every socket; it is coarse (a DO clock advances only on I/O) but
        // the socket counts are exact. Recorded even for a zero-delivery flush so
        // the iterated-vs-delivered ratio reflects wasted work honestly.
        this.fanout.shapePoke = recordFanoutPass(this.fanout.shapePoke, sockets.length, delivered, Date.now() - startMs);
        this.shapeProbe = recordShapeProbePass(this.shapeProbe, diffCache.probesRun, diffCache.probesServed);
    }

    /**
     * The highest `seq` this sweep may compact or delete through without stranding
     * an in-shard consumer: the lowest cursor any durable local consumer has
     * durably reached, or the log's head when there is none.
     *
     * The direction is what matters. Every input can only pull the floor DOWN, and
     * a consumer whose cursor cannot be read contributes nothing rather than a
     * guess — a floor that is too low leaves rows around for one more sweep, while
     * a floor that is too high deletes a range a live subscription still has to be
     * told about.
     *
     * Two in-shard consumers, and they are tracked in different places. Local
     * sockets record `__shape_poke_cursor` per `(connection, subscription)` on
     * every delivered poke, so that table carries their position. **Relayed
     * subscribers are not in it**: a relay's cohort frontier and its per-socket
     * proxies are the owner's shape registry (`__lunora_relay_shapes`, read back
     * through `RelayLink.minShapeCursor`). Reading only the local table would
     * therefore see a fully relayed shard — the high-fan-out case, i.e. exactly
     * the shard an operator turns retention on for — as having no subscribers,
     * and delete the rows the next relayed diff had to read. Both are folded in
     * here.
     *
     * **The floor is each consumer's `cursor`, not its `delivered`** (see
     * {@link ShapeMemo.delivered}), and the two differ: a client's own position is
     * `delivered`, which can sit BELOW the `cursor` this floor is computed from.
     * Trimming to the higher of the two is nonetheless safe, and only for one
     * reason: `cursor` runs ahead of `delivered` exclusively across ranges where
     * that shape's table saw no change at all — that is what an empty diff means,
     * and empty diffs are the only thing that advances `cursor` alone. So the rows
     * this deletes in `(delivered, cursor]` are never rows that shape still owes
     * its client. Change what advances `cursor` and this stops holding.
     *
     * **Known ceiling: a relayed cohort on a quiet table pins this floor.** A
     * scalar MIN over every consumer is only as good as the slowest consumer's
     * ability to advance, and the relay tier's cannot: `OwnerRelay.buildShapePoke`
     * must leave a cohort's cursor where the last DELIVERED poke reached, because
     * advancing it without a poke puts every relay socket's memo below the next
     * poke's `fromCursor` and freezes them (the failure `relay-hub.test.ts` pins).
     * Local sockets have no such constraint — the shard computes their diffs from
     * its own memo — so `collectShapePokeParts` advances them on every flush. The
     * asymmetry means a shard whose shapes are all relayed can still see retention
     * do nothing.
     *
     * The upgrade is a floor PER TABLE rather than one scalar: `readCdcChangeKeys`
     * already filters by table, so a cohort watching a quiet table never needs the
     * busy table's rows and should not be holding them. That is a real change to
     * how the sweep is expressed, not a tweak here, so it waits for a deployment
     * that needs it.
     */
    private retentionFloor(sql: SqlExec): number {
        const head = this.currentCdcCursor() ?? 0;
        const floors = [minShapePokeCursor(sql), this.relay?.minShapeCursor()].filter((cursor): cursor is number => cursor !== undefined);

        return Math.max(0, floors.length === 0 ? head : Math.min(head, ...floors));
    }

    /**
     * Diff every op-log-backed shape a socket holds against this flush, splitting
     * the results into the poke parts to send and the per-shape memo advances. A
     * `.global()` shape (driven by the alarm poll loop, not this flush) and a shape
     * whose table didn't change are skipped; a shape whose resolve/diff throws is
     * counted and logged via `recordSubscriptionRefreshError` (DO-01) and marked
     * owed with its memo unadvanced so a later flush retries. Empty diffs advance
     * unconditionally; part-bearing shapes advance only once the caller confirms
     * the poke was delivered.
     *
     * A shape that owes rows — or whose memo this wake has not established at all
     * — is diffed even when its table is absent from `changed`. That is the op-log
     * counterpart of `tick.requestResync()` on the `.global()` poll path, and
     * without it an undelivered range is skipped rather than retried; see
     * {@link ShapeMemo.owed}.
     */
    private collectShapePokeParts(
        ws: ShardSocketLike,
        connectionId: string,
        shapes: Record<string, ShapeSubscriptionQuery>,
        identity: SubscriptionIdentity,
        changed: Set<string>,
        checkpoint: number,
        sql: SqlExec,
        diffCache: ShapeDiffCache,
    ): { emptyAdvanced: string[]; partAdvanced: string[]; parts: ShapePokePart[] } {
        const parts: ShapePokePart[] = [];
        const emptyAdvanced: string[] = [];
        const partAdvanced: string[] = [];

        for (const [subId, shape] of Object.entries(shapes)) {
            try {
                const resolved = this.resolveShape(shape.name, shape.args ?? {}, identity);

                // Unresolvable, or driven by the `.global()` poll loop rather than
                // this flush: nothing this pass can say about it.
                if (!resolved || resolved.global) {
                    continue;
                }

                // The shape's table saw no write in this flush, so its diff over
                // `(memo, checkpoint]` is empty WITHOUT reading the log. Advance
                // it anyway rather than skipping outright.
                //
                // That is not a micro-optimisation, it is what makes retention
                // work at all. `retentionFloor` is a MIN over every
                // `__shape_poke_cursor` row, so one subscriber to a quiet table —
                // a profile shape on a tab left open overnight — used to hold the
                // whole log's floor at its seed cursor forever, and an operator
                // who set `LUNORA_CDC_LOG_RETENTION` watched the log keep growing
                // with no error, no metric, and nothing to grep. Every flush
                // advances every shape now, so a cursor lags only by the flushes
                // that genuinely could not settle.
                // …with one exception, and it is the whole reason this is a
                // condition rather than a plain `changed.has`. "Empty WITHOUT
                // reading the log" only holds while the memo is known to cover
                // everything before this flush. It does not when the shape still
                // owes rows a previous flush computed but never delivered
                // ({@link ShapeMemo.owed}), and it cannot be known at all when
                // there is no in-memory memo yet — a hibernation eviction drops
                // `owed` with the rest of the map, and the durable cursor alone
                // cannot say whether the wake before it settled. Either way, take
                // one unconditional diff pass instead of advancing: a re-scan of a
                // range the client already has costs a probe, while skipping one it
                // does not is a silently incomplete view for the life of the socket.
                const memo = this.shapeMemos.get(ws)?.get(subId);

                if (memo !== undefined && memo.owed !== true && !changed.has(resolved.table)) {
                    emptyAdvanced.push(subId);

                    continue;
                }

                const memoCursor = this.readShapeMemoCursor(ws, connectionId, subId, shape.sinceSeq);
                const rowsPatch = this.diffShape(sql, resolved, memoCursor, checkpoint, diffCache);

                if (rowsPatch.length > 0) {
                    // Stamp the base the client is ACTUALLY at for this shape — the
                    // cursor of the last poke that carried rows for it, not
                    // `memoCursor` (which also advances on an empty diff and would
                    // read as a gap the client never had). Absent on the first
                    // delivery of a wake; the check is simply disarmed then.
                    const baseCheckpoint = this.shapeMemos.get(ws)?.get(subId)?.delivered;

                    parts.push({ baseCheckpoint, rowsPatch, shapeId: subId });
                    partAdvanced.push(subId);
                } else {
                    emptyAdvanced.push(subId);
                }
            } catch (error) {
                // Counted and logged like the socket-level catch in the caller
                // (see `recordSubscriptionRefreshError`) so a resolve/diff
                // failure contained to one shape still shows up on
                // `metrics.subscriptionRefreshErrors` and the structured
                // telemetry event — not just the socket-level failures that
                // escape this loop entirely.
                //
                // Marked owed for the same reason a failed send is: the memo did
                // not advance, so the range this pass gave up on is unscanned, and
                // the next flush on another table would otherwise advance straight
                // over it. A shape that keeps throwing now retries every flush
                // rather than only the ones touching its table — louder, but a
                // shape that cannot resolve is already an error on every flush that
                // does touch it.
                this.markShapeOwed(ws, subId);
                this.recordSubscriptionRefreshError(`${ADMIN_FUNCTION_PREFIX}pokeShapeSubscribers`, error, { subId });
            }
        }

        return { emptyAdvanced, partAdvanced, parts };
    }

    /**
     * Read the changed row keys for a shape diff. A thin protected seam over
     * {@link readCdcChangeKeys}, kept for the one thing nothing else observes:
     * the `sinceSeq` each diff resumed FROM. Which baseline a poke picked — the
     * durable memo, the attachment's subscribe-time cursor, or a clamped one
     * after a PITR rollback — is the assertion in three tests, and it is not
     * recoverable from the outside.
     *
     * It is NOT the read counter. `ShapeDiffCache.probesRun`/`probesServed` count
     * the reads the per-flush memo collapses, and that is what the sharing tests
     * assert against.
     */
    // eslint-disable-next-line class-methods-use-this, @typescript-eslint/member-ordering -- thin pass-through seam over the module-level reader; a protected method so the per-flush cache + tests share one read point, co-located with the poke path it serves rather than hoisted away from its only caller
    protected readShapeCdcKeys(sql: SqlExec, table: string, sinceSeq: number, upTo: number): CdcChangeKey[] {
        return readCdcChangeKeys(sql, table, sinceSeq, upTo);
    }

    /**
     * One relayed shape's diff, on its own cache.
     *
     * The relay tier computes one delta per cohort or proxy rather than per
     * socket, so there is nothing to share WITHIN a call — the cache exists
     * because the pipeline requires one. Its counters are still folded back into
     * {@link ShardDO.shapeProbe}, because they are reads this instance issued:
     * discarding them would under-report exactly the shards the fan-out panel
     * exists for, since a shard is relayed precisely when its fan-out is large.
     */
    private diffRelayedShape(resolved: ResolvedShape, fromCursor: number, toCursor: number): ShapeRowOp[] {
        const cache = createShapeDiffCache();
        const ops = this.diffShape(this.sql as SqlExec, resolved, fromCursor, toCursor, cache);

        this.shapeProbe = recordShapeProbePass(this.shapeProbe, cache.probesRun, cache.probesServed);

        return ops;
    }

    /**
     * This shard's shape diff: {@link buildShapeDiff} with the changelog read
     * routed through {@link ShardDO.readShapeCdcKeys}, so the DO's one seam over
     * that read stays the DO's.
     *
     * The pipeline itself is host-neutral and lives in `@lunora/shard-engine` —
     * it reads through the `sql` handle and touches no instance state.
     */
    private diffShape(sql: SqlExec, resolved: ResolvedShape, sinceSeq: number, upTo: number, cache: ShapeDiffCache): ShapeRowOp[] {
        return buildShapeDiff(sql, resolved, sinceSeq, upTo, cache, (handle, table, from, to) => this.readShapeCdcKeys(handle, table, from, to));
    }

    /** Build the full insert-poke of a shape's current membership — the first-seed/full-reseed rowset. */
    // eslint-disable-next-line class-methods-use-this -- instance method for symmetry with `buildShapeDiff`; reads via the passed `sql` handle
    private buildShapeSeed(sql: SqlExec, resolved: ResolvedShape): ShapeRowOp[] {
        return selectShapeRows(sql, resolved.table, resolved.effectiveWhere).map((row) => {
            return {
                key: row.id,
                op: "insert" as const,
                table: resolved.table,
                value: projectColumns(row.doc, resolved.columns),
            };
        });
    }

    /**
     * Seed a `.global()`-table shape: read its full membership from D1, ship it
     * as one insert-poke, record the membership snapshot the alarm poll loop will
     * diff against, and arm the poll alarm. A global shape has no op-log cursor,
     * so the poke is stamped at this DO's current cursor (informational only) and
     * carries no resume base — a reconnect always re-seeds full.
     */
    private async seedGlobalShape(
        ws: ShardSocketLike,
        subId: string,
        resolved: ResolvedShape,
        identity: SubscriptionIdentity,
        connectionId: string,
    ): Promise<"ok" | { code: string; message: string }> {
        const rows = await this.readGlobalShapeRows(resolved, identity);

        // Refuse to materialize an unbounded membership into a per-socket snapshot
        // (and never arm the poll loop for it) — fail this one shape closed. Report
        // the over-cap as a structured error so the caller errors the subscribe
        // instead of acking "ok" without ever delivering data.
        if (!this.withinGlobalShapeBound(rows.length, `shape:seed:${subId}`, resolved.table)) {
            return {
                code: "SHAPE_GLOBAL_TOO_LARGE",
                message: `global shape membership for "${resolved.table}" exceeds the ${String(ShardDO.GLOBAL_SHAPE_MAX_ROWS)}-row cap; narrow it with a shape predicate or an RLS read policy`,
            };
        }

        // Seeding is a diff against an empty baseline — every surviving row an insert.
        const { next: snapshot, rowsPatch } = diffGlobalMembership(rows, new Map<string, string>(), { columns: resolved.columns, table: resolved.table });

        // Advance the baseline only after the seed poke lands; a failed send leaves
        // the snapshot empty so the next poll re-diffs the full membership and
        // re-seeds rather than skipping the rows this poke carried.
        await awaitWsDrain(ws);

        // `reset` — a global shape re-seeds in full on EVERY (re)subscribe, and the
        // seed is inserts-only. Without the flag a reconnecting client merges the
        // fresh membership into whatever it still holds and keeps rendering rows
        // that were deleted while it was away, for the life of the tab.
        if (this.sendPoke(ws, [{ reset: true, rowsPatch, shapeId: subId }], this.currentCdcCursor() ?? 0, this.currentCdcEpoch(), undefined)) {
            this.recordGlobalSnapshot(ws, subId, snapshot);
            this.saveGlobalSnapshot(connectionId, subId, snapshot);
        }

        await this.scheduleGlobalPoll();

        return "ok";
    }

    /**
     * Re-read a global shape's membership from D1 and poke only the diff against
     * the socket's last snapshot: a new key → `insert`, a changed projected value
     * → `update`, a vanished key → `delete`. The snapshot advances to the fresh
     * membership even when the diff is empty, so the next tick compares from here.
     * No frame is sent when nothing changed (the common steady-state tick).
     */
    private async refreshGlobalShape(
        ws: ShardSocketLike,
        subId: string,
        resolved: ResolvedShape,
        identity: SubscriptionIdentity,
        connectionId: string,
        tick: GlobalPollTick,
    ): Promise<void> {
        const rows = await this.readGlobalShapeRowsCached(resolved, identity, tick);

        // An over-cap membership: leave the prior snapshot untouched (so the diff
        // recovers if it later shrinks) and skip this tick rather than retaining it.
        // Like a thrown failure, this leaves the socket un-settled against a cursor
        // that has already advanced, so the next tick must not skip the table.
        if (!this.withinGlobalShapeBound(rows.length, `shape:poll:${subId}`, resolved.table)) {
            tick.requestResync();

            return;
        }

        const { lost, snapshot: previous } = this.readGlobalSnapshot(ws, subId, connectionId);
        const { next, rowsPatch } = diffGlobalMembership(rows, previous, { columns: resolved.columns, table: resolved.table });

        // A lost baseline (see `readGlobalSnapshot`) makes the diff a fiction: it
        // is computed against an empty map, so it can emit an `insert` for every
        // surviving row and a `delete` for none — and a row that left the shape
        // while this DO slept would stay on the client for the life of the tab.
        // Send the membership as a full `reset` instead, which is the one frame
        // that drops what the client still holds. Same shape the seed uses.
        if (lost) {
            await awaitWsDrain(ws);

            if (this.sendPoke(ws, [{ reset: true, rowsPatch, shapeId: subId }], this.currentCdcCursor() ?? 0, this.currentCdcEpoch(), undefined)) {
                this.recordGlobalSnapshot(ws, subId, next);
                this.saveGlobalSnapshot(connectionId, subId, next);

                return;
            }

            tick.requestResync();

            return;
        }

        if (rowsPatch.length === 0) {
            // Unchanged tick: membership equals `previous`, so refreshing the
            // in-memory cache to `next` is a no-op-equivalent and never strands
            // rows. Skip the SQLite write (the common steady-state path).
            this.recordGlobalSnapshot(ws, subId, next);

            return;
        }

        // Membership changed: poke the diff, and advance the baseline (in-memory +
        // durable) only once the poke lands. A failed send leaves the prior
        // snapshot so the next tick re-diffs and re-pokes the change rather than
        // losing it.
        await awaitWsDrain(ws);

        if (this.sendPoke(ws, [{ rowsPatch, shapeId: subId }], this.currentCdcCursor() ?? 0, this.currentCdcEpoch(), undefined)) {
            this.recordGlobalSnapshot(ws, subId, next);
            this.saveGlobalSnapshot(connectionId, subId, next);

            return;
        }

        // The poke did not land, so the baseline still predates this diff — and the
        // tick's cursor has moved past the changes it was built from. Ask for an
        // unconditional pass so the next tick rebuilds it rather than skipping.
        tick.requestResync();
    }

    /**
     * Read a socket's global-shape baseline, preferring the hot in-memory cache
     * and falling back to the durable `__global_shape_snapshot` table on a miss (a
     * cold socket after a hibernation eviction). The loaded baseline repopulates
     * the cache so subsequent ticks in this wake hit memory. An empty
     * `connectionId` (a socket that never went through the lifecycle-aware upgrade,
     * e.g. a unit harness) skips the durable read and behaves as in-memory-only.
     */
    private readGlobalSnapshot(ws: ShardSocketLike, subId: string, connectionId: string): { lost: boolean; snapshot: Map<string, string> } {
        const cached = this.globalShapeSnapshots.get(ws)?.get(subId);

        if (cached) {
            return { lost: false, snapshot: cached };
        }

        const stored = this.loadGlobalSnapshot(connectionId, subId);
        const snapshot = stored ?? new Map<string, string>();

        this.recordGlobalSnapshot(ws, subId, snapshot);

        // `lost` = both copies of this subscription's baseline are gone: the
        // in-memory one to a hibernation eviction, the durable one because the
        // read found no row (a persist that failed, or a socket evicted before
        // its first save). Only a poll tick that KNOWS its baseline is missing
        // can avoid diffing against a fabricated empty one — see
        // `refreshGlobalShape`. `undefined` from `loadGlobalSnapshot` means the
        // durable path itself is unavailable (a stub `sql`, a connection-id-less
        // harness socket), which is in-memory-only mode, not a lost baseline.
        return { lost: stored === undefined && this.durableSnapshotStoreAvailable, snapshot };
    }

    /** Record a socket's latest global-shape membership snapshot in the in-memory cache (creating the per-socket map lazily). */
    private recordGlobalSnapshot(ws: ShardSocketLike, subId: string, snapshot: Map<string, string>): void {
        socketMap(this.globalShapeSnapshots, ws).set(subId, snapshot);
    }

    /**
     * Load a durable global-shape baseline from SQLite, or `undefined` when no row
     * is stored / the durable path is unavailable. A stub `sql` handle (unit
     * harness) or a missing table degrades to in-memory-only behavior rather than
     * failing the poll tick — and marks the durable store unavailable, so
     * {@link ShardDO.readGlobalSnapshot} does not mistake it for a lost baseline.
     */
    private loadGlobalSnapshot(connectionId: string, subId: string): Map<string, string> | undefined {
        if (connectionId === "") {
            return undefined;
        }

        try {
            const stored = readGlobalShapeSnapshot(this.sql as SqlExec, connectionId, subId);

            this.durableSnapshotStoreAvailable = true;

            return stored;
        } catch {
            this.durableSnapshotStoreAvailable = false;

            return undefined;
        }
    }

    /**
     * Persist a socket's global-shape baseline to SQLite so the poll-loop diff
     * survives hibernation. A no-op for a connection-id-less socket (the in-memory
     * cache then carries the baseline for the DO's lifetime, matching the
     * pre-durable behavior).
     *
     * A failure is LOGGED rather than swallowed, and the in-memory cache has
     * already advanced past it, so an unreported one would only surface as lost
     * deletes after a hibernation eviction — arbitrarily later and nowhere near
     * the write that failed. The over-cap refusal from `writeGlobalShapeSnapshot`
     * names the subscription to narrow, and is reported unconditionally because
     * it is raised before `sql` is touched at all.
     */
    private saveGlobalSnapshot(connectionId: string, subId: string, snapshot: Map<string, string>): void {
        if (connectionId === "") {
            return;
        }

        try {
            writeGlobalShapeSnapshot(this.sql as SqlExec, connectionId, subId, snapshot);
            this.durableSnapshotStoreAvailable = true;
        } catch (error: unknown) {
            // The over-cap refusal is raised by `writeGlobalShapeSnapshot` BEFORE
            // it touches `sql`, so it can never be a stub-handle artifact — it is
            // always a real, actionable failure and is always reported. Gating it
            // on the availability flag hid it on exactly the path it was written
            // for: an over-wide shape throws on its very first write, so the flag
            // had never been set true and the message naming the subscription was
            // swallowed until some later hibernation eviction happened to flip it.
            //
            // An untyped throw is the other case: a stub `sql` handle (unit
            // harness) has no durable store at all, which is in-memory-only mode
            // rather than a failure worth logging.
            if (isLunoraError(error) || this.durableSnapshotStoreAvailable) {
                this.recordShapeError(`shape:snapshot:${subId}`, error);
            }
        }
    }

    /**
     * Arm the poll alarm if one isn't already pending. Idempotent — every
     * global-shape seed calls it, but only the first arms the alarm. Degrades to
     * a no-op when the runtime exposes no `setAlarm` (the unit harness): a global
     * shape is then seed-only, which the poll-loop tests assert by driving
     * {@link ShardDO.alarm} directly.
     *
     * `atMs` lets {@link ShardDO.alarm} re-arm at a computed target — the
     * earlier of the fixed global-shape floor and the earliest external-source
     * next-due time — instead of always the fixed floor. Every OTHER caller
     * (a fresh global-shape seed, {@link ShardDO.scheduleSourcePoll}'s initial
     * kick) omits it and gets the original `GLOBAL_SHAPE_POLL_INTERVAL_MS`
     * default, since neither knows a more precise due time yet.
     */
    private async scheduleGlobalPoll(atMs?: number): Promise<void> {
        if (this.globalPollScheduled) {
            return;
        }

        this.globalPollScheduled = true;

        try {
            // `ShardHost.alarms` owns the "host cannot arm" case: it resolves
            // silently rather than throwing, which is the same outcome the
            // previous `if (!setAlarm) return` produced — no alarm, no crash.
            await this.shardHost.alarms.set(atMs ?? Date.now() + ShardDO.GLOBAL_SHAPE_POLL_INTERVAL_MS);
        } catch {
            // A failed arm clears the flag so a later seed/tick retries.
            this.globalPollScheduled = false;
        }
    }

    /**
     * Delete one expired row through {@link ShardDO.runShardWrite}, passing this
     * sweep's own by-value meter (the override's `this.transactionHeadroom()`
     * fallback would mint a fresh budget per row, bounding nothing),
     * absorbing a `TRANSACTION_LIMIT_EXCEEDED` as "batch full" rather than
     * letting it propagate — split out of {@link ShardDO.pollTtlSweeps} to keep
     * that method's own complexity down. Returns `true` when the limit was hit
     * (the caller must stop the sweep pass) and logs a `warn` recording it; `false`
     * on an ordinary successful delete. Any OTHER thrown error still propagates —
     * only the meter's own signal is contained here.
     */
    private async deleteExpiredTtlRow(table: string, id: string, headroom: TransactionHeadroomTracker, trace?: TraceRefLike): Promise<boolean> {
        try {
            await this.runShardWrite({ id, op: "delete", table }, headroom);

            return false;
        } catch (error) {
            if (error instanceof LunoraError && error.code === "TRANSACTION_LIMIT_EXCEEDED") {
                this.logs.push({
                    functionPath: "ttl:sweep",
                    level: "warn",
                    message: `TTL sweep for "${table}" hit the transaction limit mid-batch; resuming next tick: ${error.message}`,
                    timestamp: Date.now(),
                    traceId: trace?.traceId,
                });

                return true;
            }

            throw error;
        }
    }

    /**
     * Record a contained shape-tier error (poll / poke / seed) into the DO's log
     * ring without aborting the rest of the pass. The shape pipeline is a
     * best-effort fan-out: one socket's read or one shape's resolve failing must
     * never take down the others — so callers swallow the throw and surface it
     * here for diagnosis. `context` is a synthetic `shape:phase:subId` path.
     *
     * `trace` is passed by the alarm path, which has an anchor to attribute the
     * failure to; the socket-frame callers omit it because their path is
     * deliberately untraced (see `webSocketMessage`). It is a parameter rather
     * than a field read so an alarm interleaving with a socket frame cannot file
     * one path's failure under the other's trace.
     */
    private recordShapeError(context: string, error: unknown, trace?: TraceRefLike): void {
        this.logs.push({
            functionPath: context,
            level: "error",
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
            traceId: trace?.traceId,
        });
    }

    /**
     * Guard a global shape's materialized membership against {@link
     * ShardDO.GLOBAL_SHAPE_MAX_ROWS}. Returns `true` when the row count is within
     * the cap; otherwise records a diagnosable error and returns `false` so the
     * caller fails the shape closed (no snapshot retained, no poke sent) rather
     * than risking a DO eviction on an unbounded global table. The transient read
     * buffer is bounded by the same gate — an over-cap membership is dropped, not
     * snapshotted per socket.
     */
    private withinGlobalShapeBound(rowCount: number, context: string, table: string): boolean {
        if (rowCount <= ShardDO.GLOBAL_SHAPE_MAX_ROWS) {
            return true;
        }

        this.recordShapeError(
            context,
            new Error(
                `global shape membership for "${table}" (${String(rowCount)} rows) exceeds the ${String(ShardDO.GLOBAL_SHAPE_MAX_ROWS)}-row cap; narrow it with a shape predicate or an RLS read policy`,
            ),
        );

        return false;
    }

    /**
     * The changelog settings the generated code hands to the `.global()` writer.
     *
     * `cdc` is the app's own opt-in, forwarded from the shard config so the two
     * logs are governed by ONE switch: a deployment that turns CDC on gets a
     * changelog on both tiers, and one that leaves it off pays for neither. Until
     * this was threaded, the global writer was built without it unconditionally —
     * so the global `__cdc_log` was never written, and the poll's
     * changed-tables fast path was unreachable in every generated app while
     * looking, from the shard side, exactly like a backend that had CDC disabled.
     *
     * `cdcRetentionMs` is read here rather than in the generated factory so every
     * deployment knob goes through one strict parser (see
     * {@link CdcRetentionRunner.sweep} for why lenient parsing on a delete path
     * is a footgun). Absent means the global log is never trimmed.
     */
    // eslint-disable-next-line @typescript-eslint/member-ordering -- co-located with `readGlobalChangedTables` and the poll tick they both serve, rather than hoisted to the protected block away from its only callers
    protected globalCdcOptions(cdc: boolean): { cdc: boolean; cdcRetentionMs?: number } {
        const retentionMs = envOptionalPositiveInt(this.env, "LUNORA_GLOBAL_CDC_RETENTION_MS");

        return { cdc, ...(retentionMs === undefined ? {} : { cdcRetentionMs: retentionMs }) };
    }

    /**
     * Ask the `.global()` backend which tables it recorded a write to after
     * `sinceSeq`. The base class has no global backend, so it reports no
     * visibility (`undefined`) and every poll tick falls back to re-reading
     * membership; the codegen-generated subclass overrides this to forward the
     * question to the global store's changelog. Emitted only for a project that
     * has both shapes and `.global()` tables.
     *
     * `cursorOnly` says the caller has already committed to reading everything
     * this pass and wants only the cursor — see the contract on
     * `DatabaseWriterLike.cdcChangedTables`.
     */
    // eslint-disable-next-line class-methods-use-this, @typescript-eslint/member-ordering -- base-class override hook (the codegen subclass overrides it and uses `this` to build the global writer), co-located with the poll tick it opens rather than hoisted away from its only caller
    protected readGlobalChangedTables(_sinceSeq: number, _cursorOnly?: boolean): Promise<{ cursor: number; floor?: number; tables: string[] } | undefined> {
        return Promise.resolve(undefined);
    }

    private beginDispatch(request: Request): {
        dispatchAttribution: QueryAttribution;
        dispatchHeadroom: TransactionHeadroomTracker;
        dispatchStartedAt: number;
        dispatchTrace: { rootSpanId: string; traceId: string };
    } {
        this.currentRequestBookmark = request.headers.get("x-d1-bookmark") ?? undefined;
        this.currentResponseBookmark = undefined;
        // `decodeUserIdHeader` inverts the runtime's `encodeUserIdHeader`: a
        // Latin-1-safe id is forwarded unchanged, a non-Latin-1 one arrives
        // base64url-encoded behind a leading `=` sentinel. See shared/identity-header.ts.
        this.currentRequestUserId = decodeUserIdHeader(request.headers.get("x-lunora-userid"));
        this.currentRequestMutationId = request.headers.get("x-lunora-mutation-id") ?? undefined;
        // Custom-mutator push identity: a stable per-device client id plus a
        // monotonic per-client sequence. Present only on custom-mutator pushes;
        // the watermark dispatch below classifies the sequence against the
        // shard's `__client_watermark`. A non-numeric/absent seq disables the
        // watermark path (the call falls back to the legacy idempotency dedup).
        this.currentRequestClientId = request.headers.get("x-lunora-client-id") ?? undefined;
        this.currentRequestClientSeq = parseClientSeqHeader(request.headers.get("x-lunora-client-seq"));
        // Reset the in-transaction bookkeeping handshake: `handleRpc` sets the
        // classification + flag for a mutation push so the writes, dedup row, and
        // watermark advance all commit atomically (see `commitMutationBookkeeping`).
        this.currentMutatorClass = undefined;
        this.mutationBookkeeping = undefined;
        this.currentRequestIdentity = parseIdentityHeader(request.headers.get("x-lunora-identity"));
        // The caller's IP, forwarded server-side from Cloudflare's trusted
        // `CF-Connecting-IP` (never copied from a client header). Surfaced as
        // `ctx.ip` so handlers/middleware can key on it (e.g. rate-limit
        // unauthenticated traffic by IP).
        this.currentRequestIp = request.headers.get("x-lunora-client-ip") ?? undefined;
        this.currentRequestSystem = request.headers.get("x-lunora-system") === "1";
        this.currentRequestTraceparent = request.headers.get("traceparent") ?? undefined;
        // Resolve the dispatch's trace anchor once, here, so `ctx.trace` spans and
        // the synthetic root span recorded on the way out agree on the ids even
        // when there is no inbound `traceparent` to derive them from.
        this.currentRequestTrace = resolveTraceAnchor(this.currentRequestTraceparent);
        // Captured into a local as well: the `finally` below runs after the
        // handler's awaits, by which point an interleaved dispatch may have
        // re-set the shared field — reading it there would file this dispatch's
        // root span under another request's trace (and leave that one rootless).
        const dispatchTrace = this.currentRequestTrace;
        // Trace-sampling verdict propagated by the runtime: the `traceparent`
        // sampled flag carries the head decision (absent → keep, so this path is
        // unchanged for alarms / subscription re-runs / non-Lunora callers) and
        // `x-lunora-sample-errors` carries the tail-bias toggle. Registered keyed by
        // THIS dispatch's `traceId` (not a flat field) so a concurrent dispatch's
        // `recordSpan` / `finally` reads its own verdict — see `traceSampling`.
        this.traceSampling.set(dispatchTrace.traceId, {
            keepErrors: request.headers.get("x-lunora-sample-errors") !== "0",
            sampled: parseTraceparent(this.currentRequestTraceparent)?.sampled ?? true,
        });
        this.metrics.requests += 1;
        const dispatchStartedAt = Date.now();

        // Collect the tables this dispatch full-scans (stamped by the
        // ctx-db read hook) so `recordFunctionCall` can persist the causal
        // attribution. Fresh per request; drained below.
        this.currentScannedTables = new Set<string>();

        // A LOCAL, never an instance field: `handleRpc` below receives it BY
        // VALUE (see its docstring), so this dispatch's ctx-build never depends
        // on a shared field still pointing at THIS tracker by the time an
        // `await`-interleaved concurrent dispatch's `finally` runs.
        const dispatchHeadroom = new TransactionHeadroomTracker(this.transactionLimits());

        // Collect the declared indexes this dispatch exercises (stamped by
        // the ctx-db index-use hook) so `recordFunctionCall` can persist the
        // per-index hit counter behind the dead-index lint. Fresh per
        // request; drained below.
        this.currentIndexHits = new Set<string>();

        // Collect per-statement SQL samples from the instrumented `sql`
        // getter so `flushStmtSamples` can persist them to the durable
        // `__lunora_metrics_queries` table after the handler resolves.
        // Allocating a fresh map here activates the instrumentation (the
        // `sql` getter only wraps when this field is defined).
        this.currentStmtSamples = new Map<string, StmtSample>();
        this.currentStmtSamplesTruncated = undefined;

        // The per-request read/cache capture `runCachedQuery` fills in for a
        // cached query path. Handed BACK to the caller, never parked on `this`:
        // it is written and read on both sides of the handler's awaits, so a
        // shared field would attribute it to whichever concurrent dispatch
        // happened to resolve last. See {@link QueryAttribution}.
        return { dispatchAttribution: {}, dispatchHeadroom, dispatchStartedAt, dispatchTrace };
    }

    /** Clear every per-request field {@link ShardDO.beginDispatch} stamped. */
    private endDispatch(): void {
        this.currentRequestTrace = undefined;
        this.currentRequestBookmark = undefined;
        this.currentResponseBookmark = undefined;
        this.currentRequestUserId = undefined;
        this.currentRequestMutationId = undefined;
        this.currentRequestClientId = undefined;
        this.currentRequestClientSeq = undefined;
        this.currentMutatorClass = undefined;
        this.mutationBookkeeping = undefined;
        this.currentRequestIdentity = undefined;
        this.currentRequestIp = undefined;
        this.currentRequestSystem = false;
        this.currentRequestTraceparent = undefined;
        this.currentScannedTables = undefined;
        this.currentIndexHits = undefined;
        this.currentStmtSamples = undefined;
        this.currentStmtSamplesTruncated = undefined;
        // Drop the cached proxy with the samples map it folds into, so the
        // finished dispatch's map is not held alive by it.
        this.instrumentedSql = undefined;
    }

    /**
     * Open one `.global()` poll tick: ask the global changelog what moved since
     * the last tick, and decide whether this tick may use that answer to skip
     * membership reads.
     *
     * Two things force a full pass regardless of what the changelog says. The
     * first is having no cursor to compare against — a cold instance, or a
     * backend with CDC disabled, has no basis for "unchanged" and must read. The
     * second is the resync interval, and it is the honest part of this design: a
     * `.global()` table can be written by something that is not this deployment,
     * and such a write leaves no row in our changelog. Trusting the changelog
     * forever would mean a shape silently frozen against an out-of-band writer,
     * so the fast path is a bounded skip — at worst {@link ShardDO.GLOBAL_SHAPE_RESYNC_MS}
     * of staleness for a change we could not see, against the full membership
     * re-read of every shape on every socket every two seconds that it replaces.
     *
     * That same bound now covers a second case worth naming: a shape whose
     * membership moves WITHOUT a write — a predicate over wall-clock, like
     * `_creationTime > now - 1h`. It used to converge on the poll interval
     * because every tick re-read it; it now converges on the resync interval,
     * because no changelog row marks its table as having moved. Bounded and
     * intended, but a different guarantee than the one this path used to give.
     */
    private async openGlobalPollTick(trace?: TraceRefLike): Promise<GlobalPollTick> {
        const now = Date.now();
        // A shape that failed to settle last tick asks for an unconditional pass
        // regardless of how recently the interval elapsed — see `resyncRequested`.
        const dueForResync = this.globalResyncRequested || now - this.lastGlobalResyncAt >= ShardDO.GLOBAL_SHAPE_RESYNC_MS;

        this.globalResyncRequested = false;

        if (dueForResync) {
            this.lastGlobalResyncAt = now;
        }

        // A cold instance has no cursor to compare against and a resync pass
        // deliberately ignores one, so in both cases the changelog cannot narrow
        // this tick — and asking it would bill a `.global()` round trip for an
        // answer that is discarded. Adopt the cursor without the table list.
        const cursorOnly = this.globalPollCursor === undefined || dueForResync;

        try {
            const changed = await this.readGlobalChangedTables(this.globalPollCursor ?? 0, cursorOnly);

            if (changed === undefined) {
                return new GlobalPollTick();
            }

            // The changelog was trimmed past this instance's cursor, so the rows
            // that would have named the tables it needs are gone and `tables`
            // under-reports. That is indistinguishable from "nothing changed"
            // unless the floor is checked, and acting on it would freeze every
            // shape whose table moved inside the swept range. Degrade to the
            // full pass — the same answer a changelog error already produces,
            // and self-healing rather than merely bounded.
            //
            // `+ 1` because a cursor sitting exactly at `floor - 1` has seen
            // everything below the floor.
            const trimmedPastUs = cursorBelowRetainedFloor(changed.floor, this.globalPollCursor ?? 0);

            this.globalPollCursor = changed.cursor;

            return new GlobalPollTick(cursorOnly || trimmedPastUs ? undefined : new Set(changed.tables));
        } catch (error) {
            // No visibility is always a safe answer — it degrades this tick to the
            // full re-read every tick used to do.
            this.recordShapeError("shape:poll:cdc", error, trace);

            return new GlobalPollTick();
        }
    }

    /**
     * Read a `.global()` shape's membership through this tick's cache.
     *
     * The key is the resolved predicate **and the caller's identity**, and the
     * second half is not redundant with the first. The op-log path can share a
     * probe on the predicate alone because it reads this shard's own SQLite with
     * nothing but that predicate — identity has no other channel into the query.
     * A `.global()` read does not have that property: the backend writer is built
     * per request from `{ identity, userId }`, so an application's own `d1` /
     * `hyperdriveGlobal` factory may scope rows by the caller before this code
     * ever sees them. Two sockets with equal predicates and different identities
     * can therefore be entitled to different rows, and sharing one read between
     * them would hand one user the other's.
     *
     * What remains shareable is what is genuinely identical: every socket of the
     * same user (tabs, devices, reconnects), and every socket of an anonymous or
     * public shape — which is where the fan-out that made this path expensive
     * lives. An identity or predicate that cannot be stably keyed falls back to
     * an un-shared read.
     */
    private async readGlobalShapeRowsCached(resolved: ResolvedShape, identity: SubscriptionIdentity, tick: GlobalPollTick): Promise<ShapeRow[]> {
        return tick.rows(globalShapeReadKey(resolved, identity), async () => this.readGlobalShapeRows(resolved, identity));
    }

    /**
     * Refresh every `.global()`-table shape held across all live sockets, one
     * diff-poke per (socket, shape). Returns the number of global shapes still
     * subscribed so {@link ShardDO.alarm} knows whether to re-arm. Expired sockets
     * are dropped in passing (mirrors {@link ShardDO.pokeShapeSubscribers}).
     */
    private async pollGlobalShapes(trace?: TraceRefLike): Promise<number> {
        const sockets = [...this.runner.sockets()];
        let remaining = 0;

        // Resolve who this tick has work for BEFORE opening it. The tick's own
        // changelog probe is a read against the global backend, and this alarm is
        // shared with the TTL and external-source tiers — so opening it up front
        // would bill a `.global()` round-trip on every tick of a shard whose
        // alarm is armed for something else entirely, which is the cost this
        // whole path exists to remove.
        const pending: { attachment: SocketAttachment; ws: ShardSocketLike }[] = [];

        for (const ws of sockets) {
            if (this.isSocketExpired(ws)) {
                this.dropExpiredSocket(ws);

                continue;
            }

            const attachment = this.readAttachment(ws);

            if (attachment.shapes) {
                pending.push({ attachment, ws });
            }
        }

        if (pending.length === 0) {
            return 0;
        }

        const tick = await this.openGlobalPollTick(trace);

        for (const { attachment, ws } of pending) {
            const identity: SubscriptionIdentity = { identity: attachment.identity, userId: attachment.userId };

            // eslint-disable-next-line no-await-in-loop -- per-socket reads are intentionally serialized to bound concurrent global reads per tick
            remaining += await this.pollSocketGlobalShapes(ws, attachment.shapes ?? {}, identity, attachment.connectionId ?? "", tick, trace);
        }

        this.globalPoll = recordGlobalPollPass(this.globalPoll, tick.readCount, tick.skipped);
        this.globalResyncRequested = tick.resyncRequested;

        return remaining;
    }

    /**
     * Refresh one socket's `.global()`-table shapes, containing per-shape
     * failures so a single throw never aborts the poll tick (and with it the
     * re-arm). Returns the count of global shapes still subscribed on this socket
     * — a failed `resolveShape`/read keeps its shape counted so the alarm keeps
     * polling and retries next tick.
     */
    private async pollSocketGlobalShapes(
        ws: ShardSocketLike,
        shapes: Record<string, ShapeSubscriptionQuery>,
        identity: SubscriptionIdentity,
        connectionId: string,
        tick: GlobalPollTick,
        trace?: TraceRefLike,
    ): Promise<number> {
        let count = 0;

        for (const [subId, shape] of Object.entries(shapes)) {
            let resolved: ResolvedShape | undefined;

            try {
                resolved = this.resolveShape(shape.name, shape.args ?? {}, identity);
            } catch (error) {
                count += 1;
                this.recordShapeError(`shape:poll:${subId}`, error, trace);

                continue;
            }

            if (!resolved?.global) {
                continue;
            }

            count += 1;

            // Nothing wrote to this shape's table since the last tick, and this
            // tick is not a resync — so its membership cannot have moved and the
            // diff would be empty. Skipping is the whole point: the steady state
            // of a `.global()` shape is "unchanged", and it used to cost a full
            // membership drain per socket to establish that.
            if (!tick.shouldRead(resolved.table)) {
                continue;
            }

            try {
                // eslint-disable-next-line no-await-in-loop -- per-shape D1 reads serialized within a socket to bound concurrency
                await this.refreshGlobalShape(ws, subId, resolved, identity, connectionId, tick);
            } catch (error) {
                // This tick's cursor has already moved past the rows that marked
                // the table changed, so a later tick would skip this shape rather
                // than retry it. Ask for one unconditional pass instead.
                tick.requestResync();
                this.recordShapeError(`shape:poll:${subId}`, error, trace);
            }
        }

        return count;
    }

    /**
     * Send one poke (`pokeStart` → `pokePart` per shape → `pokeEnd`) to a socket.
     * All parts apply atomically at `pokeEnd`. Returns `true` when every frame was
     * handed to the socket, `false` when a send threw mid-poke (the socket closed)
     * — callers must NOT advance their shape baselines on a `false` so the client
     * re-receives the rows on its next flush/reconnect instead of losing them.
     *
     * A `false` can leave a `pokeStart` on the wire with no `pokeEnd` behind it
     * (the throw is per frame). That is safe by construction on the client: parts
     * are buffered and applied only at `pokeEnd`, so an abandoned poke leaves the
     * view untouched, and `handlePokeStart` evicts the oldest buffer once the map
     * exceeds its cap — the abandoned ones are always the oldest.
     */
    private sendPoke(
        ws: ShardSocketLike,
        parts: ReadonlyArray<ShapePokePart>,
        checkpoint: number,
        epoch: string | undefined,
        baseCheckpoint: number | undefined,
    ): boolean {
        this.pokeSequence += 1;
        const pokeId = `poke-${String(this.pokeSequence)}`;
        const frames = buildPokeFrames(parts, {
            baseCheckpoint,
            checkpoint,
            epoch,
            lastMutationId: this.socketClientWatermark(this.readAttachment(ws)),
            pokeId,
        });

        try {
            for (const frame of frames) {
                ws.send(frame);
            }

            return true;
        } catch {
            /* socket may have closed mid-poke; the client re-seeds on reconnect */
            return false;
        }
    }

    /**
     * The recipient client's `__client_watermark` for stamping a poke's
     * `lastMutationId`, or `undefined` when the socket announced no `clientId`
     * (a client that doesn't use custom mutators — nothing to drop an overlay
     * for). Read off the attachment so it survives hibernation.
     */
    private socketClientWatermark(attachment: SocketAttachment): number | undefined {
        const { clientId } = attachment;

        if (clientId === undefined) {
            return undefined;
        }

        // Scope by the socket's verified identity, matching how the dispatch path
        // advanced the watermark (`currentRequestUserId`); the upgrade resolves
        // both from the same `x-lunora-userid`.
        try {
            return readClientWatermark(this.sql as SqlExec, attachment.userId ?? "", clientId);
        } catch {
            // Missing table / stub handle — no watermark to echo.
            return undefined;
        }
    }

    /**
     * Record a shape's poke baseline cursor on a socket (creating the
     * per-socket map lazily), and write it through to the durable
     * `__shape_poke_cursor` table so it survives hibernation. Called only on
     * a delivered/advanced poke (never on a computed-but-unsent diff) — see
     * the call sites in {@link ShardDO.pokeShapeSubscribers}. Takes
     * `connectionId` from the caller rather than re-deserializing the
     * attachment (`deserializeAttachment()` is a structured-clone read) —
     * every caller already holds it from resolving the socket's shapes.
     */
    private recordShapeMemo(
        ws: ShardSocketLike,
        connectionId: string,
        subId: string,
        cursor: number,
        options: { carriedRows: boolean; pending?: ShapePokeCursorRow[] },
    ): void {
        const { carriedRows } = options;
        const memos = socketMap(this.shapeMemos, ws);
        // `delivered` only moves when this poke actually put rows on the wire for
        // the shape — that, not `cursor`, is where the client's own cursor sits.
        // See {@link ShapeMemo.delivered}.
        const delivered = carriedRows ? cursor : memos.get(subId)?.delivered;

        // The replacement drops `owed` (see {@link ShapeMemo.owed}), which is the
        // point: both callers advance `cursor` past the range that was owed, either
        // by delivering it or by finding it genuinely empty.
        memos.set(subId, { cursor, ...(delivered === undefined ? {} : { delivered }) });
        // A fan-out passes `pending` so one flush upserts every socket's baseline
        // instead of each poke issuing its own statement. Everything else writes
        // straight through: making buffering the default would mean every future
        // caller has to remember to flush, and a forgotten flush loses the
        // hibernation baseline silently.
        if (options.pending === undefined) {
            this.saveShapePokeCursor(connectionId, subId, cursor);
        } else if (connectionId !== "") {
            options.pending.push({ connectionId, cursor, subId });
        }
    }

    /**
     * Flag a shape as owing rows it computed but never delivered, so the next
     * flush diffs it unconditionally instead of force-advancing its cursor past
     * the range. See {@link ShapeMemo.owed}.
     *
     * Deliberately does NOT create a memo entry when there is none: a missing
     * entry already forces the same unconditional pass in
     * {@link ShardDO.collectShapePokeParts}, and inventing a cursor here would be
     * guessing at a baseline the durable row can answer for real.
     */
    private markShapeOwed(ws: ShardSocketLike, subId: string): void {
        const memo = this.shapeMemos.get(ws)?.get(subId);

        if (memo !== undefined) {
            memo.owed = true;
        }
    }

    /**
     * Read a socket's poke baseline cursor for a shape: the hot in-memory
     * {@link ShardDO.shapeMemos} cache, falling back to the durable
     * `__shape_poke_cursor` row on a miss (a cold socket after a hibernation
     * eviction), then the shape's subscribe-time `sinceSeq` (passed in by the
     * caller, which already holds the attachment this came from — see
     * {@link ShardDO.recordShapeMemo}), and finally `0`. Every fallback
     * degrades DOWNWARD only — a baseline that is too high would silently
     * skip rows a client never saw, while too low is merely a wasted rescan
     * of a range the client already has. The `sinceSeq` rung is a raw
     * client-supplied wire value (unlike `stored`, which this shard wrote
     * itself), so it is clamped against the current high-watermark: after a
     * PITR restore — the same rollback {@link ShardDO.evaluateResume} guards
     * against — a `sinceSeq` above the cursor must degrade to `0`, not be
     * trusted as a baseline. A durable/`sinceSeq` hit repopulates the
     * in-memory cache so later reads this wake hit memory.
     */
    private readShapeMemoCursor(ws: ShardSocketLike, connectionId: string, subId: string, sinceSeq: number | undefined): number {
        const cached = this.shapeMemos.get(ws)?.get(subId)?.cursor;

        if (cached !== undefined) {
            return cached;
        }

        const stored = this.loadShapePokeCursor(connectionId, subId);
        const fallback = stored ?? sinceSeq ?? 0;
        const baseline = fallback > (this.currentCdcCursor() ?? 0) ? 0 : fallback;

        socketMap(this.shapeMemos, ws).set(subId, { cursor: baseline });

        return baseline;
    }

    /**
     * Load a durable shape poke-baseline cursor from SQLite, or `undefined`
     * when none is stored / the durable path is unavailable. A stub `sql`
     * handle (unit harness), a missing table, or a connection-id-less socket
     * degrades to "nothing stored" rather than throwing.
     */
    private loadShapePokeCursor(connectionId: string, subId: string): number | undefined {
        if (connectionId === "") {
            return undefined;
        }

        try {
            return readShapePokeCursor(this.sql as SqlExec, connectionId, subId);
        } catch {
            return undefined;
        }
    }

    /**
     * Persist a socket's shape poke-baseline cursor to SQLite so it survives
     * hibernation. A no-op for a connection-id-less socket (never went
     * through the lifecycle-aware upgrade, e.g. a unit harness) or a stub
     * `sql` handle / missing table — degrades to in-memory-only behavior
     * rather than failing the poke.
     */
    private saveShapePokeCursor(connectionId: string, subId: string, cursor: number): void {
        if (connectionId === "") {
            return;
        }

        try {
            writeShapePokeCursor(this.sql as SqlExec, connectionId, subId, cursor);
        } catch {
            /* stub sql / missing table — degrade to in-memory cache only */
        }
    }

    /**
     * Record `outcome` as this socket's diff baseline for `subId` without
     * sending a frame. Used by the resume fast-path, where the client keeps its
     * cached value but the server still needs a baseline so the next
     * write-flush can diff against it.
     */
    private seedSubscriptionMemo(ws: ShardSocketLike, subId: string, outcome: SubscriptionOutcome): void {
        socketMap(this.subMemos, ws).set(subId, {
            // eslint-disable-next-line unicorn/no-null -- mirrors pushSubscriptionData: an undefined result serializes to JSON null so the baseline matches the wire form
            lastJson: JSON.stringify(encodeWire(outcome.result ?? null)),
            ranges: outcome.ranges,
            tables: outcome.tables,
        });
    }

    /**
     * Memoise `outcome` for `(ws, subId)` and push it to the socket, unless an
     * identical result was already sent. Always refreshes the memo's table set
     * so dependency tracking stays current even when the value is unchanged.
     *
     * When the result is a diffable list (Convex-parity live-pagination, gap
     * #20), the push can go out as one `{type:"delta"}` frame per changed row
     * instead of a full `{type:"data"}` snapshot. Which of the two is sent is
     * `subscriptionFrames`' call, made by rendering both and measuring them —
     * this method just sends what it is handed. The memo is always advanced to
     * the new `lastJson`/`tables` regardless of path.
     *
     * `cursor` (when supplied) is the `__cdc_log` high-watermark this frame
     * covers; it is appended to the emitted `data`/`delta` JSON so a client can
     * persist its resume position and replay it as `sinceSeq` on reconnect
     * (Pillar 1b). Omitted on shards without CDC, keeping the wire byte-identical
     * to the pre-cursor format.
     *
     * `delivery` carries the facts that depend on the SOCKET and not on the
     * subscription — read once by the caller and passed in, never recomputed
     * here. A single write-flush calls this method many times for one socket
     * (once per affected subscription — see `refreshOne`), and both fields are
     * identical across those calls: `clientWatermark` would otherwise be a
     * redundant `SELECT … FROM __client_watermark` per subscription, and
     * `pageDeltas` a redundant attachment read.
     */
    private pushSubscriptionData(
        ws: ShardSocketLike,
        subId: string,
        outcome: SubscriptionOutcome,
        cursor: number | undefined,
        epoch: string | undefined,
        delivery: SocketDelivery,
    ): void {
        const memos = socketMap(this.subMemos, ws);
        const cursorSuffix = cdcSuffix(cursor, epoch);
        const { clientWatermark, pageDeltas } = delivery;

        // Wire-encode the result so a `bytes`/`bigint` column survives the frame
        // (raw `JSON.stringify` drops a buffer to `{}` / throws on a bigint). A
        // pure-JSON result encodes byte-identically, so this baseline + `data`
        // frame stay unchanged for the common case, and the delta path (which
        // encodes its next rows too) diffs against a consistently-encoded baseline.
        // eslint-disable-next-line unicorn/no-null -- WS frame payload: an undefined result serializes to JSON null so the delta frame carries an explicit value
        const json = JSON.stringify(encodeWire(outcome.result ?? null));
        const existing = memos.get(subId);

        if (existing?.lastJson === json) {
            existing.tables = outcome.tables;
            // `ranges` legitimately shifts run-to-run even when the result is
            // byte-identical (a recency-windowed query is the obvious case) — it's
            // recomputed per execution from the index slices actually touched, not
            // derived from the result. Leaving it stale here would violate
            // `subscription-range-gate`'s "assume touched on any uncertainty" law:
            // a later write landing in the REFRESHED range but outside the STALE
            // one would never re-trigger this subscription. Refresh it every run,
            // suppressed or not — matches the non-suppressed branch below.
            existing.ranges = outcome.ranges;

            // The result is byte-identical to the last frame, so no data/delta
            // frame goes out (frame suppression). But a confirmed write whose
            // authoritative result did NOT change this query still committed at
            // this cursor, and BOTH overlay mechanisms need the cursor to drop
            // their pending optimistic state, or it sticks forever with no frame:
            //   - a `@lunora/db` custom-mutator client (announced a `clientId`)
            //     advances its checkpoint gate off `lastMutationId`;
            //   - a plain `useQuery` client with a per-call `optimistic` layer
            //     drops it once `cursor >= commitCursor`.
            // So emit a lightweight `settled` frame (carrying the cursor/epoch)
            // unconditionally, with `lastMutationId` only when this socket has a
            // watermark. An old client ignores the unknown frame.
            const watermarkField = clientWatermark === undefined ? "" : `,"lastMutationId":${String(clientWatermark)}`;

            trySendFrame(ws, `{"type":"settled","id":${JSON.stringify(subId)}${watermarkField}${cursorSuffix}}`);

            return;
        }

        // Row deltas or the full snapshot — `subscriptionFrames` renders both and
        // returns whichever is smaller on the wire, so the frame layout and the
        // choice between the two stay in one place (this method has no business
        // re-deriving the delta envelope just to size it). `existing?.lastJson`
        // is the last value that actually LEFT the socket, so a first send — or
        // one whose predecessor was dropped — has no baseline and gets the
        // snapshot. `clientWatermark` rides on every frame either way, so the
        // client's checkpoint gate can trust what THIS frame's rows reflect
        // instead of a provisional RPC-ack that can race ahead of it (plan 266
        // finding d).
        const frames = subscriptionFrames({
            cursorSuffix,
            lastMutationId: clientWatermark,
            nextResult: outcome.result,
            pageDeltas,
            previousJson: existing?.lastJson,
            snapshotJson: json,
            subId,
            // First REAL dependency, never the unvouchable sentinel. `tables` is
            // insertion-ordered, so a query that read `ctx.kv` before touching a
            // table would otherwise put `UNVOUCHABLE_DEP` on the wire as this
            // frame's `table` — an internal name leaking to every client and all
            // eight SDK ports. The field is a structural guard rather than a
            // routing key, so a wrong value is inert, but an internal marker is
            // not something to publish and then rely on nobody reading.
            table: [...outcome.tables].find((dep) => dep !== UNVOUCHABLE_DEP) ?? "",
        });

        // At-least-once delivery: advance the diff BASELINE (`lastJson`) only once
        // EVERY frame for this value has left the socket. `ws.send` throws when the
        // socket has closed or its outbound buffer is gone, and a partial delta run
        // must keep the baseline at the last fully-delivered value so the next flush
        // re-diffs the whole change (keyed list deltas are idempotent on replay, so
        // re-sending an already-applied row is harmless). Advancing unconditionally
        // would diff the NEXT value against one the client never received, silently
        // losing that update until it reconnected. `.map` before `.every` on purpose:
        // every frame is attempted, and only then is the verdict taken. `tables`
        // always advances so dependency tracking stays accurate even on failure.
        const delivered = frames.map((frame) => trySendFrame(ws, frame)).every(Boolean);

        memos.set(subId, { lastJson: delivered ? json : (existing?.lastJson ?? UNDELIVERED_BASELINE), ranges: outcome.ranges, tables: outcome.tables });
    }

    /**
     * Gate the upgrade request against two complementary controls:
     *
     * 1. Origin allowlist via `env.LUNORA_ALLOWED_ORIGINS` (comma-separated,
     * a single `*` permitting any origin). When unset, any origin is
     * accepted — convenient for local dev, not suitable for production.
     * The wildcard must be honoured here because the worker's CORS layer
     * honours it (`@lunora/runtime`'s `parseEnvCors`): reading the same
     * variable more strictly took every WebSocket upgrade down with a bare
     * 403 on a configuration the CORS side documents as supported, and a
     * browser sends its real `Origin`, never `*`, so nothing else matched.
     * 2. Bearer token via `env.LUNORA_WS_BEARER`. When set, the upgrade
     * must present a matching token. We accept either an
     * `Authorization: Bearer <token>` header (preferred) or a
     * `?token=<token>` query parameter (the only escape hatch for
     * browsers, which can't customise headers on the WebSocket
     * constructor). The match runs in constant time to avoid leaking
     * the token via response-timing differences.
     *
     * The `?token=` path is a real risk surface: the token ends up in
     * server logs, browser history, and `Referer` headers on any
     * subresource the upgrade page loads after the handshake. Use a
     * short-lived rotating token in production rather than a long-lived
     * secret — for the ADMIN credential specifically, the worker mints one
     * (`POST /_lunora/admin/ws-token`) and {@link isAdminSocket} accepts it, so
     * the master `LUNORA_ADMIN_TOKEN` never rides the URL.
     *
     * Async because the admin fallback ({@link isAdminSocket}) verifies the
     * ephemeral sub-token with WebCrypto HMAC.
     */
    private async isUpgradeAllowed(request: Request): Promise<boolean> {
        const env = (this.env ?? {}) as { LUNORA_ALLOWED_ORIGINS?: string; LUNORA_WS_BEARER?: string };
        const allowedOrigins = env.LUNORA_ALLOWED_ORIGINS;

        if (allowedOrigins && allowedOrigins.trim() !== "") {
            const origin = request.headers.get("origin");

            if (!origin) {
                return false;
            }

            const list = new Set(
                allowedOrigins
                    .split(",")
                    .map((entry) => entry.trim())
                    .filter((entry) => entry.length > 0),
            );

            if (!list.has("*") && !list.has(origin)) {
                return false;
            }
        }

        const expectedBearer = env.LUNORA_WS_BEARER;

        if (expectedBearer && expectedBearer.length > 0) {
            const supplied = this.suppliedWsToken(request);

            // The admin credential (master token or minted ephemeral sub-token)
            // is accepted as an alternate so a studio can open its socket even
            // when `LUNORA_WS_BEARER` gates ordinary subscribers. The socket is
            // flagged admin separately (see `isAdminSocket`); matching the
            // bearer alone never grants it.
            if (!supplied || (!constantTimeEqual(supplied, expectedBearer) && !(await this.isAdminSocket(request)))) {
                return false;
            }
        }

        return true;
    }

    /**
     * Token presented on a WS upgrade: the `Authorization: Bearer` header when
     * present, else the `?token=` query parameter (the only channel a browser
     * `WebSocket` constructor can use). Returns `undefined` when neither is set.
     * @returns the bearer token string, or `undefined` when no token was supplied
     */
    // eslint-disable-next-line class-methods-use-this -- cohesive DO instance method grouped with the upgrade-auth helpers; reads only the request
    private suppliedWsToken(request: Request): string | undefined {
        const fromHeader = extractBearerToken(request.headers.get("authorization"));

        if (fromHeader !== undefined) {
            return fromHeader;
        }

        return new URL(request.url).searchParams.get("token") ?? undefined;
    }

    /**
     * Whether the upgrade presented an admin credential: the master
     * `LUNORA_ADMIN_TOKEN` (constant-time compared) or a short-lived sub-token
     * the worker minted with it (`POST /_lunora/admin/ws-token` —
     * HMAC-verified statelessly here, since both isolates hold the master token
     * in `env`). The ephemeral token is what the studio sends in `?token=`, so
     * the master credential stays out of URLs/logs. Closed (resolves `false`)
     * when the admin token is unset, mirroring `isAdminAuthorized` for the HTTP
     * path so admin streaming is opt-in rather than exposed by default.
     *
     * Enforcement is ON by default: a raw master token in the `?token=` query
     * parameter is rejected — the query string is exactly where it leaks (access
     * logs / history / `Referer`). Set `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` to
     * `0`/`false`/`off`/`no`/`disabled` to opt back out for a legacy client. The
     * `Authorization` header path still takes the master token: browsers can't
     * set it on a WS upgrade, so it never rides a URL.
     */
    private async isAdminSocket(request: Request): Promise<boolean> {
        const env = (this.env ?? {}) as { LUNORA_ADMIN_TOKEN?: string; LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN?: string };
        const adminToken = env.LUNORA_ADMIN_TOKEN;

        if (!adminToken || adminToken.length === 0) {
            return false;
        }

        const supplied = this.suppliedWsToken(request);

        if (supplied === undefined) {
            return false;
        }

        if (await verifyWsAdminToken(adminToken, supplied)) {
            return true;
        }

        // `suppliedWsToken` prefers the header; the token came from the query
        // string only when no bearer header was present.
        const fromQuery = extractBearerToken(request.headers.get("authorization")) === undefined;
        const requireEphemeral = isEnvFlagEnabled(env.LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN, true);

        if (fromQuery && requireEphemeral) {
            return false;
        }

        return constantTimeEqual(supplied, adminToken);
    }

    /**
     * Fingerprint of the admin token this DO holds RIGHT NOW, or `undefined`
     * when none is configured. Memoised per token value: the derivation is an
     * HMAC and this is consulted once per socket per write flush.
     */
    private async currentAdminBinding(): Promise<string | undefined> {
        const token = (this.env as { LUNORA_ADMIN_TOKEN?: string } | undefined)?.LUNORA_ADMIN_TOKEN;

        if (token === undefined || token.length === 0) {
            return undefined;
        }

        if (this.adminBindingMemo?.token !== token) {
            this.adminBindingMemo = { binding: adminSocketBinding(token), token };
        }

        return this.adminBindingMemo.binding;
    }

    /**
     * Whether `attachment` still carries a LIVE admin authorization.
     *
     * The upgrade gate runs once and the socket then lives for hours, so the
     * stamped `admin` flag alone is an authorization that can never be revoked:
     * clearing or rotating `LUNORA_ADMIN_TOKEN` shuts the HTTP admin plane on
     * the next request (`isAdminAuthorized` fails closed) and used to shut
     * nothing here — a 60-second sub-token bought 60 seconds to OPEN a socket
     * that then served `runSql`/`readTablePage`/`getLogs` output for its whole
     * life. Re-deriving the fingerprint from `env` makes rotation a revocation
     * on this plane too.
     *
     * Fails closed on every uncertain input: no configured token, no stamped
     * binding, or a mismatch. Both sides are server-derived (the client supplies
     * neither), so an exact comparison is the right one.
     */
    private async attachmentAdminAuthorized(attachment: SocketAttachment): Promise<boolean> {
        if (attachment.admin !== true) {
            return false;
        }

        const current = await this.currentAdminBinding();

        return current !== undefined && attachment.adminBinding === current;
    }

    /**
     * Register the hibernation-safe ping/pong keepalive. The runtime answers a
     * {@link WS_KEEPALIVE_PING} text frame with {@link WS_KEEPALIVE_PONG}
     * WITHOUT waking this Durable Object, keeping idle subscription sockets
     * alive across hibernation with no billable wakeup and no dispatch. The
     * auto-response is per-instance, so this re-runs on every construction
     * (including a post-hibernation wake). Guarded: the API and the
     * `WebSocketRequestResponsePair` global are absent in the unit harness and
     * on older runtimes, where it degrades to a no-op.
     */
    private armWebSocketKeepalive(): void {
        const setter = this.state.setWebSocketAutoResponse;

        if (typeof setter !== "function" || typeof WebSocketRequestResponsePair === "undefined") {
            return;
        }

        setter.call(this.state, new WebSocketRequestResponsePair(WS_KEEPALIVE_PING, WS_KEEPALIVE_PONG));
    }

    /**
     * Route the non-RPC requests `fetch` handles before the shard-local RPC
     * endpoint: a WebSocket upgrade, and the internal `/_lunora/relay` owner↔relay
     * control channel (never reachable by a client — the runtime forwards only
     * worker-internal traffic there). Returns `undefined` for an RPC request, which
     * `fetch` then dispatches.
     * @returns the routed response, or `undefined` when this is an RPC request
     */
    private async routeNonRpc(url: URL, request: Request): Promise<Response | undefined> {
        if (url.pathname === "/_lunora/relay" && request.method === "POST") {
            // The relay tier is inert on an unnamed (single-DO) DO — nothing forwards
            // control frames there, so a 404 is the honest answer.
            return this.relay ? await this.relay.handleControl(request) : new Response("relay tier inactive", { status: 404 });
        }

        // The replica follow channel: a replica pulls its owner's changelog (or
        // takes a bootstrap snapshot) here. Authenticated by the same
        // `LUNORA_RELAY_SECRET` HMAC as the relay channel, and refused by a DO
        // that is itself a replica.
        if (url.pathname === "/_lunora/replica" && request.method === "POST") {
            return handleReplicaControl(this.replicaOwnerHost, request);
        }

        // Promotion probe (plan 075 Phase 2): the runtime asks the owner how many
        // relays to spread new connections across before a WS upgrade. Internal —
        // reachable only via the runtime's worker-side forward, returns just a count.
        if (url.pathname === "/_lunora/route" && request.method === "GET") {
            return jsonResponse({ relayCount: this.relay?.relayCount() ?? 0 });
        }

        // Batch dispatch (plan 088): each entry replays through the single-call
        // `/rpc` path (see `handleBatchRpc`), so idempotency + watermark ordering
        // are preserved without duplicating the dispatch core.
        if (url.pathname === "/rpc-batch" && request.method === "POST") {
            return this.handleBatchRpc(request);
        }

        if (request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade(request);
        }

        return undefined;
    }

    private async handleWebSocketUpgrade(request: Request): Promise<Response> {
        // A replica has no live pipeline: its rows advance only when a READ
        // happens to trigger a catch-up, so a subscription served from here
        // would be a live query that mostly is not. Nothing routes an upgrade to
        // a replica name — only a hand-written `?shard=` can reach this — and it
        // is refused for the same reason the dispatch gate refuses writes.
        if (this.replica !== undefined) {
            return new Response("replica does not serve subscriptions", { status: 421 });
        }

        if (!(await this.isUpgradeAllowed(request))) {
            return new Response("Forbidden", { status: 403 });
        }

        // Resolve the admin flag BEFORE accepting the socket: the (async)
        // sub-token HMAC verify must not sit between `acceptWebSocket` and the
        // attachment stamp, or an early frame could race an unstamped socket.
        const admin = await this.isAdminSocket(request);

        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];

        // Capture the verified identity the runtime forwarded on the upgrade
        // (`resolveIdentity` wired into the WS upgrade) and mint a stable
        // per-socket id. Both are stashed on the attachment so they survive
        // hibernation and can be replayed to the connection-lifecycle hooks at
        // connect/close — including `webSocketClose`, when the socket carries no
        // request of its own.
        const userId = decodeUserIdHeader(request.headers.get("x-lunora-userid"));
        const identity = parseIdentityHeader(request.headers.get("x-lunora-identity"));
        const expiresAt = decodeIdentityExpiryHeader(request.headers.get("x-lunora-identity-exp"));

        // Fingerprint of the token that authorized this socket, so a later
        // rotation of `LUNORA_ADMIN_TOKEN` revokes it rather than leaving a
        // socket whose one-shot upgrade check can never be re-run. Only for an
        // admin socket: an ordinary one has nothing to revoke, and the
        // attachment is a scarce 16 KiB budget.
        const adminBinding = admin ? await this.currentAdminBinding() : undefined;

        // Stamp admin authorization onto the socket at upgrade so later
        // `__lunora_admin__:*` subscribe envelopes (which carry no credential of
        // their own) can be gated without re-verifying a presented token per
        // message — `attachmentAdminAuthorized` compares the fingerprint above
        // instead, so the flag is re-checked but the credential is not replayed.
        //
        // Accepted through `SocketHost`, not `state.acceptWebSocket` directly, so
        // the socket carries the host's accept-time id tag. That tag is what makes
        // `SocketHost.idFor` durable across hibernation and what lets `handleFor`
        // answer in O(1) after a wake instead of scanning the socket set —
        // accepting behind the host's back would leave both to fall back.
        //
        // Accept and stamp are one call for the same reason they were adjacent
        // before: the runtime only tracks attachments for sockets it has accepted,
        // and no frame can arrive against an unstamped socket in between.
        this.socketHost.accept(server, {
            admin,
            connectionId: crypto.randomUUID(),
            subs: {},
            ...(adminBinding === undefined ? {} : { adminBinding }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(identity === undefined ? {} : { identity }),
            ...(userId === undefined ? {} : { userId }),
        } satisfies SocketAttachment);

        // eslint-disable-next-line unicorn/no-null -- Web Response body for a 101 upgrade is `BodyInit | null`; null is the standard "no body" value
        return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * Whether this shard has a `__cdc_log` table. The single source of the
     * "is CDC on here?" probe shared by {@link currentCdcCursor},
     * {@link currentCdcEpoch}, {@link evaluateResume}, and the PITR-restore epoch
     * bump. Returns `false` (rather than throwing) on a stub `sql` handle (unit
     * harness double) or a pre-CDC shard, so callers degrade to the no-CDC path.
     */
    private cdcEnabled(): boolean {
        try {
            return (this.sql as SqlExec).exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, CDC_LOG_TABLE).toArray().length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Whether `ws` carries a credential whose expiry (stamped at upgrade) is
     * now past. Delegates to the shared boundary check `@lunora/agent`'s
     * voice DO uses for the same decision, so the two DOs can never disagree
     * about it.
     */
    private isSocketExpired(ws: ShardSocketLike): boolean {
        return isIdentityExpired(this.readAttachment(ws).expiresAt);
    }

    /**
     * Drop an expired-credential socket via the shared `TOKEN_EXPIRED`/`4001`
     * helper `@lunora/agent`'s voice DO also calls, so both DOs send the
     * client-facing wire shape from one place.
     */
    // eslint-disable-next-line class-methods-use-this -- cohesive socket helper grouped with isSocketExpired; operates only on the passed socket
    private dropExpiredSocket(ws: ShardSocketLike): void {
        dropExpiredCredentialSocket(ws);
    }

    /**
     * Join (`join = true`) or leave a whisper `topic` on this socket. Membership rides
     * the hibernation attachment, bounded by
     * {@link ShardDO.MAX_WHISPER_TOPICS_PER_SOCKET}. Best-effort and silent:
     * whispering is never acked, and an over-cap join or a serialize failure is
     * simply dropped (the join just doesn't take).
     */
    private setWhisperMembership(ws: ShardSocketLike, topic: string, join: boolean): void {
        const attachment = this.readAttachment(ws);
        const topics = attachment.whispers ?? [];
        const has = topics.includes(topic);

        if (join) {
            if (has || topics.length >= ShardDO.MAX_WHISPER_TOPICS_PER_SOCKET) {
                return;
            }

            attachment.whispers = [...topics, topic];
        } else {
            if (!has) {
                return;
            }

            const next = topics.filter((entry) => entry !== topic);

            if (next.length === 0) {
                delete attachment.whispers;
            } else {
                attachment.whispers = next;
            }
        }

        try {
            (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
        } catch {
            /* over-large attachment — the membership change just doesn't persist */
        }
    }

    /**
     * Token-bucket admission for a sender's whisper. Refills lazily from elapsed
     * wall-clock at {@link ShardDO.WHISPER_RATE_PER_SEC}/s up to a burst of
     * {@link ShardDO.WHISPER_RATE_BURST}; returns `false` (drop the whisper) when
     * the bucket is empty. Per-socket, in-memory — a hibernation resets it to a
     * full burst, which is the safe direction (never under-counts into a denial).
     */
    private allowWhisper(ws: ShardSocketLike): boolean {
        const now = Date.now();
        const bucket = this.whisperBuckets.get(ws) ?? { last: now, tokens: ShardDO.WHISPER_RATE_BURST };
        const refilled = Math.min(ShardDO.WHISPER_RATE_BURST, bucket.tokens + ((now - bucket.last) / 1000) * ShardDO.WHISPER_RATE_PER_SEC);

        if (refilled < 1) {
            this.whisperBuckets.set(ws, { last: now, tokens: refilled });

            return false;
        }

        this.whisperBuckets.set(ws, { last: now, tokens: refilled - 1 });

        return true;
    }

    /**
     * Fan an ephemeral whisper out to every OTHER socket on this shard that
     * joined `topic`. No SQLite write, no CDC entry, no query re-run — the
     * payload is relayed verbatim, so it never touches durable state (the
     * AnyCable "whisper" primitive: typing indicators, live cursors). The sender
     * is excluded; an over-limit or over-rate whisper is dropped.
     *
     * Authorization note: whisper topics are NOT access-controlled beyond the
     * shard boundary — any socket on this shard can join and read/inject on any
     * topic name. That matches the AnyCable model (and `from` is unforgeable),
     * but per-topic auth does not exist here; see `whisperSubscribe` on the client.
     */
    private async broadcastWhisper(sender: ShardSocketLike, topic: string, data: unknown): Promise<void> {
        // Rate-limit first — cheapest rejection, and it bounds the O(connections)
        // fan-out cost a tight whisper loop would otherwise impose.
        if (!this.allowWhisper(sender)) {
            return;
        }

        // The client already wire-encoded `data` before sending, and the receiving
        // client `decodeWire`s it — so relay the encoded value verbatim rather than
        // re-encoding it (a second `encodeWire` pass would double-tag it). An older
        // client that sent raw JSON-safe data is unaffected: `encodeWire` was
        // identity for that data, so the passthrough form is byte-identical.
        // eslint-disable-next-line unicorn/no-null -- JSON payload: an undefined whisper body serializes to null so the frame carries an explicit value
        const dataJson = JSON.stringify(data ?? null);

        if (dataJson.length > ShardDO.MAX_WHISPER_BYTES) {
            return;
        }

        // Surface the sender's verified userId so receivers can attribute the
        // whisper (omitted for an anonymous socket). Unforgeable — it comes off
        // the sender's own attachment, stamped at upgrade.
        const from = this.readAttachment(sender).userId;
        const fromSuffix = from === undefined ? "" : `,"from":${JSON.stringify(from)}`;
        const frame = `{"type":"whisper","topic":${JSON.stringify(topic)},"data":${dataJson}${fromSuffix}}`;

        // Deliver to THIS DO's sockets (excluding the sender), then — when the shard
        // is promoted (plan 075 Phase 2) — forward the opaque frame through the relay
        // hub so it reaches the sockets on every other DO serving the shard.
        this.deliverWhisperLocal(topic, frame, sender);
        await this.relay?.forwardWhisper(topic, frame);
    }

    /**
     * Deliver an already-serialized whisper `frame` to every local socket joined to
     * `topic`, excluding `exclude` (the sender, or `undefined` for a frame the relay
     * hub forwarded in — its sender lives on another DO). Records the fan-out pass
     * for `getFanoutMetrics` (plan 075 Phase 1). Pure delivery — no SQLite, no CDC.
     * @returns the number of sockets the frame was sent to
     */
    private deliverWhisperLocal(topic: string, frame: string, exclude: undefined | ShardSocketLike): number {
        let scanned = 0;
        let delivered = 0;

        for (const ws of this.runner.sockets()) {
            scanned += 1;

            if (ws === exclude) {
                continue;
            }

            const attachment = this.readAttachment(ws);

            if (attachment.whispers?.includes(topic) !== true) {
                continue;
            }

            // Enforce token-expiry on THIS outbound path too. It is not
            // redundant with the other four checks — on the canonical whisper
            // workload (presence, cursors, typing indicators) none of them ever
            // runs: `broadcastWhisper` does no SQLite write, so there is no
            // refresh flush, no shape poke and no global poll, and a passive
            // receiver sends no inbound frame for `handleWebSocketMessage` to
            // check. Without this a lapsed socket keeps receiving every whisper
            // on its joined topics — including the sender's `from` userId — for
            // the rest of its life.
            if (isIdentityExpired(attachment.expiresAt)) {
                this.dropExpiredSocket(ws);

                continue;
            }

            // Best-effort fan-out; a closed socket is simply skipped.
            trySendFrame(ws, frame);
            delivered += 1;
        }

        this.fanout.whisper = recordFanoutPass(this.fanout.whisper, scanned, delivered, 0);

        return delivered;
    }

    // eslint-disable-next-line class-methods-use-this -- cohesive DO instance method grouped with the hibernation/attachment helpers; reads only the socket
    private readAttachment(ws: ShardSocketLike): SocketAttachment {
        const raw = (ws as HibernatableWebSocket).deserializeAttachment?.();

        if (raw && typeof raw === "object" && "subs" in raw && (raw as { subs?: unknown }).subs) {
            return raw as SocketAttachment;
        }

        return { subs: {} };
    }
}

export { ROOT_DO_SIZE_WARN_BYTES, ROOT_SHARD_NAME, ShardDO };
export type {
    RunShardApplyCdcArgs,
    RunShardApplyCdcResult,
    RunShardBulkPatchArgs,
    RunShardBulkRowArgs,
    RunShardBulkRowResult,
    RunShardExportArgs,
    RunShardImportArgs,
    RunShardMigrationArgs,
    RunShardRankBeforeArgs,
    RunShardRankPageArgs,
    RunShardWriteArgs,
    RunShardWriteResult,
} from "./admin-rpc-args";

// Re-exported so existing import sites (`./index`, tests) keep their path; the
// canonical home is `./subscription-delivery`.
export { subscriptionListDeltas } from "@lunora/shard-engine";

export type { HibernatableWebSocket, QueryReadScope, ShardDOOptions, ShardDOState, SubscriptionOutcome, TelemetrySink, TraceRefLike };
