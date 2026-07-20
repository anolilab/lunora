import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { LunoraError, toErrorBody } from "@lunora/errors";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { drizzle as drizzleDO } from "drizzle-orm/durable-sqlite";

import type { BatchEntry } from "../../../shared/batch-wire";
import { MAX_BATCH_ENTRIES } from "../../../shared/batch-wire";
import { constantTimeEqual } from "../../../shared/constant-time-equal";
import { jsonResponse } from "../../../shared/json-response";
import { parseTraceparent } from "../../../shared/otlp";
import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { verifyWsAdminToken } from "../../../shared/ws-admin-token";
import type { ExportRow, ImportShardResult } from "./admin-export-import";
import { parseExportShardArgs, parseImportShardArgs } from "./admin-export-import";
import { appendAuditEntry, ensureAuditTable, readAuditLog } from "./audit-log";
import type { AuthMetrics } from "./auth-metrics";
import { readAuthMetrics, recordAuthEvent } from "./auth-metrics";
import { buildBatchEntryRequest } from "./batch";
import type { CdcChange, SqlExec } from "./ctx-db";
import {
    advanceClientWatermark,
    bumpCdcEpoch,
    CDC_LOG_TABLE,
    deleteGlobalShapeSnapshot,
    deleteGlobalShapeSnapshotsForConnection,
    migrateClientWatermark,
    minCdcSeq,
    readCdcChanges,
    readCdcCursor,
    readCdcEpoch,
    readClientWatermark,
    readGlobalShapeSnapshot,
    readIdempotent,
    selectShapeMemberIds,
    selectShapeRows,
    trimIdempotent,
    writeGlobalShapeSnapshot,
    writeIdempotent,
} from "./ctx-db";
import type { ShapeRow } from "./ctx-db-shapes";
import type { MigrationDirection, MigrationRunResult } from "./data-migration";
import { DATA_MIGRATION_STATE_TABLE, readMigrationStatus } from "./data-migration";
import type { DependencyTracker } from "./dependency-tracker";
import { createDependencyTracker, SCAN_DEP, tableFromDepKey } from "./dependency-tracker";
import type { FunctionMetricBucket, FunctionMetricIndexHit, IndexHit } from "./function-metrics";
import {
    mergeScanAttribution,
    readFunctionMetricBuckets,
    readFunctionMetricIndexHits,
    readFunctionMetrics,
    readFunctionMetricsTotals,
    recordFunctionMetric,
} from "./function-metrics";
import type {
    AdvisoryFinding,
    AuditLogResult,
    ColumnMeta,
    CreateWorkflowInstanceResult,
    FanoutMetricsResult,
    FilterClause,
    FilterOperator,
    FlagsResult,
    FunctionCallStat,
    FunctionStatsResult,
    MaskPoliciesResult,
    OrderByClause,
    QueueMetadata,
    QueuesResult,
    RlsPoliciesResult,
    StorageRulesResult,
    StudioFeaturesResult,
    SubscriptionsResult,
    TableIndexInfo,
    WorkflowInstanceStatusResult,
    WorkflowsResult,
} from "./introspect";
import {
    ADMIN_FUNCTION_PREFIX,
    ADMIN_FUNCTIONS,
    createFanoutCounters,
    facetColumn,
    findStorageReferences,
    FLAGS_FUNCTION_PREFIX,
    listTables,
    MAX_PAGE_SIZE,
    readTablePage,
    recordFanoutPass,
    RELATION_FUNCTION_PREFIX,
    selectMatchingIds,
    summarizeFanoutTopics,
    summarizeSubscriptions,
} from "./introspect";
import type { LogEntry } from "./log-buffer";
import { LogBuffer } from "./log-buffer";
import type { RecordMailInput } from "./mail-catcher";
import { clearCapturedMail, MAIL_TABLE, readCapturedMail, recordCapturedMail } from "./mail-catcher";
import { armRestore, readBookmark } from "./pitr";
import type { QueryStatEntry } from "./query-metrics";
import { readQueryMetrics, recordQueryMetric } from "./query-metrics";
import type { QueueMessageOutcome, RecordQueueMessageInput } from "./queue-catcher";
import { clearQueueMessages, isLossyBody, QUEUE_TABLE, readQueueMessageById, readQueueMessages, recordQueueMessages } from "./queue-catcher";
import type { ShardRankPageResult } from "./rank";
import type { ReactiveCacheOptions } from "./reactive-cache";
import { ReactiveCache, reactiveCacheKey, stableStringify } from "./reactive-cache";
import type { OwnerRelay, RelayHost, RelayMember } from "./relay-hub";
import { createRelayLink, DEFAULT_MAX_RELAYS } from "./relay-hub";
import type { AppendRequestLogEntry, ContextLogLevel, IssuesResult, LogEventInput, RequestLogResult, RequestLogWriteOptions } from "./request-log";
import {
    appendRequestLogEntry,
    emitLogEvent,
    emitRequestLogEvent,
    ensureRequestLogTable,
    readErrorIssues,
    readRequestLog,
    renderLogMessage,
    REQUEST_LOG_TABLE,
} from "./request-log";
import { buildSecurityAudit } from "./security-audit";
import { buildSettings, isDevEnvironment } from "./settings";
import type { ShapePokePart, ShapeRowOp } from "./shape-global-diff";
import { buildPokeFrames, diffGlobalMembership, projectColumns } from "./shape-global-diff";
import { runSocketPool } from "./socket-pool";
import { runReadonlySql } from "./sql-console";
import { findDanglingReferences } from "./storage-correlation";
import { awaitWsDrain, sendDeltaFrames, subscriptionListDeltas, trySendFrame } from "./subscription-delivery";
import type { TransactionSqlLike } from "./transaction";
import { ConflictError } from "./transaction";
import type {
    LifecycleDispatchInfo,
    LifecycleEvent,
    MutationDelta,
    ResolvedShape,
    RpcRequest,
    ShapeSubscriptionQuery,
    SocketAttachment,
    SubscriptionEnvelope,
    SubscriptionIdentity,
    SubscriptionQuery,
} from "./types";

/**
 * Client→server text frame the runtime answers with {@link WS_KEEPALIVE_PONG}
 * via the DO Hibernation API's auto-response — see {@link ShardDO.armWebSocketKeepalive}.
 * The exchange never wakes the Durable Object, so an idle subscription socket
 * stays alive across hibernation without a billable request. Clients send this
 * payload on their heartbeat instead of an app-level ping.
 */
const WS_KEEPALIVE_PING = "lunora-ping";
/** Canned reply the runtime returns for {@link WS_KEEPALIVE_PING}; never reaches a message handler. */
const WS_KEEPALIVE_PONG = "lunora-pong";

/**
 * Env values that read as "on" for `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` (see
 * {@link ShardDO.isAdminSocket}). Mirrors the runtime's
 * `REQUIRE_EPHEMERAL_ENV_VALUES` — the two packages don't import from each
 * other to avoid a circular dep.
 */
const REQUIRE_EPHEMERAL_ENV_VALUES = new Set(["1", "enabled", "on", "true", "yes"]);

/**
 * Optional programmatic log sink, resolved from `createShardDO({ observability })`.
 * Structurally a subset of `@lunora/runtime`'s `ObservabilitySink`, so a user can
 * pass the SAME sink object to `createWorker` (which drives `onRpc`) and
 * `createShardDO` (which drives `onLog` from `ctx.log`). Typed structurally so
 * `@lunora/do` takes no dependency on `@lunora/runtime`; the event is the same
 * {@link LogEventInput} shape `emitLogEvent` consumes, built once per call.
 */
interface LogSink {
    onLog?: (event: LogEventInput, context?: { waitUntil?: (promise: Promise<unknown>) => void }) => void;
}

/**
 * Structural shape of the `ctx.log` logger the DO builds (see the server
 * `LunoraLogger`). Declared locally so `@lunora/do` takes no dependency on
 * `@lunora/server`; the overloaded public method type lives there.
 */
interface CtxLogger {
    debug: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    fatal: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    log: (...args: unknown[]) => void;
    trace: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    with: (fields: Record<string, unknown>) => CtxLogger;
}

/** True for a plain object usable as a structured-fields bag (not null, not an array). */
const isLogFields = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Split a `ctx.log.<level>(...)` call's raw arguments into a display `message`
 * and optional structured `fields`. The structured form — a message string plus
 * a plain-object fields bag — is matched only for exactly `(string, object)`;
 * every other shape is console-style and rendered whole (so existing
 * `console`-shaped calls are unchanged). Bound fields from a `.with(...)` child
 * are merged under the per-call fields (per-call wins on a key clash).
 */
const parseLogArgs = (args: unknown[], boundFields?: Record<string, unknown>): { fields?: Record<string, unknown>; message: string } => {
    if (args.length === 2 && typeof args[0] === "string" && isLogFields(args[1])) {
        return { fields: boundFields ? { ...boundFields, ...args[1] } : args[1], message: args[0] };
    }

    return { fields: boundFields, message: renderLogMessage(args) };
};

/** Fold the seven `ctx.log` severities onto the {@link LogBuffer}'s four tiers (it has no `log`/`trace`/`fatal`). */
const BUFFER_LEVEL: Record<ContextLogLevel, "debug" | "error" | "info" | "warn"> = {
    debug: "debug",
    error: "error",
    fatal: "error",
    info: "info",
    log: "info",
    trace: "debug",
    warn: "warn",
};

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
     * {@link ShardDO.runInTransaction} to serialize the BEGIN/COMMIT span
     * against concurrent RPCs so a raw-SQL transaction is isolated from
     * other in-flight handlers on the same DO.
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
             * Run a SQL statement without parameters — used by the
             * transaction helper for BEGIN / COMMIT / ROLLBACK. The runtime
             * exposes this as `state.storage.sql.exec(...)`.
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
    result: unknown;
    tables: Set<string>;
}

/**
 * A shape resolved to its concrete query plan, the return of the
 * {@link ShardDO.resolveShape} hook. The codegen subclass composes the shape's
 * own predicate with the caller's RLS read base-where into `effectiveWhere`
 * under the socket's verified identity (the client never supplies it), so the
 * membership query the poke protocol runs is RLS-correct by construction.
 *
 * `columns`, when present, projects each row-op's `value` to that subset (the
 * shape's declared column allow-list); absent ⇒ the full document is shipped.
 */
/** Per-socket, per-shape poke baseline: the `__cdc_log` cursor this shape's view has been poked through. */
interface ShapeMemo {
    cursor: number;
}

/**
 * Classification of a watermarked custom-mutator push against the shard's
 * `__client_watermark`: `expected` is the next in-order sequence, `kind`
 * whether the push is a replay (`"already"`), the next one (`"next"`), or an
 * out-of-order arrival (`"gap"`).
 */
type ClientMutationClass = { expected: number; kind: "already" | "gap" | "next" };

/**
 * Optional shard-level configuration passed through `super(state, env, …)`.
 * Reserved as a bag rather than positional args so subclasses don't break
 * when new knobs land. Today the only knob is the reactive cache; future
 * additions should keep the same shape (per-feature options object).
 */
interface ShardDOOptions {
    /**
     * Enable the per-shard reactive query cache. When provided, the dispatch
     * path uses {@link ShardDO.runCachedQuery} to memoize query results by
     * `(functionPath, stable-stringified args)`. Omit to keep the legacy
     * behavior (every dispatch re-runs the handler).
     *
     * The cache is invisible to the WS subscription bridge: invalidations
     * land via the ctx-db write hooks (`@lunora/do`'s `createShardCtxDb`
     * `cache` option) BEFORE the broadcast goes out, so subscribers that
     * re-run their queries in response always observe the post-write state.
     */
    reactiveCache?: ReactiveCacheOptions;
}

/** Arguments accepted by the `__lunora_admin__:runMigration` admin RPC. */
interface RunShardMigrationArgs {
    batchSize?: number;
    direction?: MigrationDirection;
    dryRun?: boolean;
    id: string;
    maxBatches?: number;
}

/** Arguments accepted by the `__lunora_admin__:exportShard` admin RPC. */
interface RunShardExportArgs {
    batchSize?: number;
    tables?: ReadonlyArray<string>;
}

/** Arguments accepted by the `__lunora_admin__:importShard` admin RPC. */
interface RunShardImportArgs {
    rows: ReadonlyArray<ExportRow>;
    startLine?: number;
}

/**
 * The single-row mutation the data browser's edit actions issue. `op` selects
 * the writer method:
 *
 * - `insert` — create a row from `doc` (the writer assigns `_id`/`_creationTime`).
 * - `patch` — shallow-merge `doc` into the row `id`.
 * - `replace` — overwrite the row `id`'s fields with `doc` (keeping `_id`).
 * - `delete` — remove the row `id`.
 *
 * Routing through the schema-aware writer (not raw SQL) is deliberate: it keeps
 * the FTS / aggregate / rank shadow tables in sync and runs validators, exactly
 * like a user mutation would.
 */
interface RunShardWriteArgs {
    doc?: Record<string, unknown>;
    id?: string;
    op: "delete" | "insert" | "patch" | "replace";
    table: string;
}

/** Outcome of a {@link RunShardWriteArgs} operation. `id` is the affected row's primary key. */
interface RunShardWriteResult {
    id: null | string;
    op: "delete" | "insert" | "patch" | "replace";
}

/**
 * The bulk delete the data browser's "delete matching" / "clear table" actions
 * issue. The matching rows are collected on the shard (via the same
 * `filters` + `search` predicate `readTablePage` previews), then removed one at
 * a time THROUGH the schema-aware writer — never raw `DELETE` — so the FTS /
 * aggregate / rank shadow tables and `onDelete` cascades stay in sync, exactly
 * like a user mutation would.
 *
 * Bounded by design: at most {@link SHARD_BULK_DELETE_CAP} rows are removed per
 * call and the result reports `hasMore`, so the caller loops a single bounded
 * server round-trip rather than deleting an unbounded set in one transaction.
 * The `clearTable` op is the same path with no predicate (it matches every row).
 */
interface RunShardBulkDeleteArgs {
    filters?: FilterClause[];
    /** Per-call row cap; clamped server-side to `[1, SHARD_BULK_DELETE_CAP]`. */
    limit?: number;
    search?: string;
    table: string;
}

/** Outcome of a {@link RunShardBulkDeleteArgs} operation. */
interface RunShardBulkDeleteResult {
    /** Rows removed through the writer in this call. */
    deleted: number;
    /** `true` when matching rows remain beyond this batch — loop the call to drain them. */
    hasMore: boolean;
}

/**
 * Arguments accepted by the `__lunora_admin__:rankBefore` admin RPC. The query
 * coordinator fans this out to every shard to count, for the row identified by
 * `rowId`, how many rows precede it under `index` within `partitionKey`; the
 * coordinator sums the per-shard `{before, total}` into a global rank.
 */
interface RunShardRankBeforeArgs {
    index: string;
    partitionKey: string;
    rowId: string;
    sortValues: unknown[];
    table: string;
}

/**
 * Arguments accepted by the `__lunora_admin__:rankPage` admin RPC. The query
 * coordinator (`orchestrateRankPage`) fans this out to every live shard of a
 * `.shardBy(...)` table to gather each shard's local ranked slice, then k-way
 * merges them into one globally-ranked page. `take` bounds the per-shard slice;
 * `after` is the structured per-shard resume key (`{ partitionKey, sortValues,
 * rowId }`) the coordinator forwards so the shard pages strictly-after the prior
 * page's last globally-consumed row; `partitionKey` pins a single partition;
 * `directions` (`asc`/`desc` per sort key) parallels the index's `sortBy`
 * directions so a shard's `ORDER BY` matches the coordinator's comparator. Only
 * `table` and `index` are required.
 */
interface RunShardRankPageArgs {
    after?: { partitionKey: string; rowId: string; sortValues: unknown[] };
    cursor?: null | string;
    directions?: ("asc" | "desc")[];
    index: string;
    partitionKey?: string;
    table: string;
    take?: number;
}

/** Per-subscription memo used to suppress no-op pushes. */
interface SubscriptionMemo {
    lastJson: string;
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
 * Upper bound on CDC rows `evaluateResume` scans to decide whether a
 * reconnecting subscription can resume. Mirrors `readCdcChanges`'s own
 * hard clamp (10 000): once this many changes have accumulated since the
 * client's `sinceSeq`, a touching change may sit beyond the scanned page, so
 * the server can't prove the read-set is untouched and re-snapshots instead.
 */
const CDC_RESUME_SCAN_LIMIT = 10_000;

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
 * The trailing `,"cursor":&lt;n>,"epoch":"&lt;e>"` fragment appended to a
 * `data`/`delta`/`resume` frame so a client can persist a resume position it can
 * prove still belongs to this shard's timeline (see `evaluateResume`). Each part
 * is omitted when absent, keeping the wire byte-identical to the pre-cursor /
 * pre-epoch format on non-CDC shards. Single source of the wire rule so the
 * resume frame and `pushSubscriptionData` can never drift apart.
 */
const cdcSuffix = (cursor?: number, epoch?: string): string =>
    (cursor === undefined ? "" : `,"cursor":${String(cursor)}`) + (epoch === undefined ? "" : `,"epoch":${JSON.stringify(epoch)}`);

/** True when `a` and `b` share at least one element. */
const setsIntersect = (a: Set<string>, b: Set<string>): boolean => {
    // Iterate the smaller set for fewer lookups.
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];

    for (const value of small) {
        if (large.has(value)) {
            return true;
        }
    }

    return false;
};

/**
 * Coerce the loosely-typed `runMigration` admin args into a typed shape.
 * `id` is required; `direction` defaults to `"up"` and only flips to `"down"`
 * on an exact match; numeric limits pass through when present.
 */
const parseRunMigrationArgs = (args: Record<string, unknown>): RunShardMigrationArgs => {
    const id = typeof args["id"] === "string" ? args["id"] : "";

    if (id.trim() === "") {
        throw new LunoraError("MIGRATION_ID_REQUIRED", "runMigration: `id` is required", { status: 400 });
    }

    return {
        batchSize: typeof args["batchSize"] === "number" ? args["batchSize"] : undefined,
        direction: args["direction"] === "down" ? "down" : "up",
        dryRun: args["dryRun"] === true,
        id,
        maxBatches: typeof args["maxBatches"] === "number" ? args["maxBatches"] : undefined,
    };
};

/**
 * Hard server-side ceiling on rows removed per `deleteRows` / `clearTable` call.
 * The op never deletes more than this in one round-trip; the result's `hasMore`
 * tells the caller to loop. Bound TO `readTablePage`'s `MAX_PAGE_SIZE` (not just
 * documented as matching it) so one "delete matching" batch drains exactly one
 * full preview page's worth of rows and the two can't silently drift apart.
 */
const SHARD_BULK_DELETE_CAP = MAX_PAGE_SIZE;

/**
 * Validate the `__lunora_admin__:writeRow` payload. Enforces that `id` is
 * present for ops that target an existing row and that `doc` is present for ops
 * that carry one, throwing a 400 `LunoraError` otherwise — the writer would
 * reject these too, but failing here keeps the error shape uniform.
 */
const parseWriteRowArgs = (args: Record<string, unknown>): RunShardWriteArgs => {
    const { op } = args;
    const table = typeof args["table"] === "string" ? args["table"] : "";

    if (op !== "insert" && op !== "patch" && op !== "replace" && op !== "delete") {
        throw new LunoraError("BAD_REQUEST", "writeRow: `op` must be insert|patch|replace|delete");
    }

    if (table.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "writeRow: `table` is required");
    }

    const id = typeof args["id"] === "string" ? args["id"] : undefined;
    const record =
        typeof args["doc"] === "object" && args["doc"] !== null && !Array.isArray(args["doc"]) ? (args["doc"] as Record<string, unknown>) : undefined;

    if (op !== "insert" && (id === undefined || id === "")) {
        throw new LunoraError("BAD_REQUEST", `writeRow: \`id\` is required for op "${op}"`);
    }

    if (op !== "delete" && record === undefined) {
        throw new LunoraError("BAD_REQUEST", `writeRow: \`doc\` is required for op "${op}"`);
    }

    return { doc: record, id, op, table };
};

/* eslint-disable no-secrets/no-secrets -- reserved admin RPC + workflow type names are framework constants, not credentials */

/**
 * Minimal structural shape of a created/fetched workflow instance handle, mirrored
 * from `@lunora/workflow`'s `WorkflowInstanceLike` so `@lunora/do` stays free of a
 * dependency on the workflow package. Only the members the admin ops touch (`id`
 * and `status()`) are modelled.
 */
interface WorkflowInstanceHandle {
    id: string;
    status: () => Promise<{ error?: { message?: unknown; name?: unknown }; output?: unknown; status?: unknown }>;
}

/**
 * Minimal structural shape of a Cloudflare Workflows binding (the `env.WORKFLOW_*`
 * object), mirrored from `@lunora/workflow`'s `WorkflowBindingLike`. Only `create`
 * and `get` — the members the studio's start/observe ops call — are modelled.
 */
interface WorkflowBindingHandle {
    create: (options?: { id?: string; params?: unknown }) => Promise<WorkflowInstanceHandle>;
    get: (id: string) => Promise<WorkflowInstanceHandle>;
}

/** Parsed `__lunora_admin__:createWorkflowInstance` payload: which declared workflow to start, plus optional id/params. */
interface CreateWorkflowInstanceArgs {
    exportName: string;
    id?: string;
    params?: unknown;
}

/**
 * Validate the `__lunora_admin__:createWorkflowInstance` payload. Requires a
 * non-empty `exportName` (the `lunora/workflows.ts` export the handle is addressed
 * by); `id` and `params` are optional. Throws a 400 `LunoraError` on a bad shape.
 */
const parseCreateWorkflowInstanceArgs = (args: Record<string, unknown>): CreateWorkflowInstanceArgs => {
    const exportName = typeof args["exportName"] === "string" ? args["exportName"].trim() : "";

    if (exportName === "") {
        throw new LunoraError("BAD_REQUEST", "createWorkflowInstance: `exportName` is required");
    }

    const id = typeof args["id"] === "string" && args["id"] !== "" ? args["id"] : undefined;

    return { exportName, id, params: args["params"] };
};

/** Parsed `__lunora_admin__:getWorkflowInstanceStatus` payload: which workflow and which instance to inspect. */
interface GetWorkflowInstanceStatusArgs {
    exportName: string;
    id: string;
}

/**
 * Validate the `__lunora_admin__:getWorkflowInstanceStatus` payload. Requires both
 * a non-empty `exportName` and a non-empty instance `id`. Throws a 400
 * `LunoraError` otherwise.
 */
const parseGetWorkflowInstanceStatusArgs = (args: Record<string, unknown>): GetWorkflowInstanceStatusArgs => {
    const exportName = typeof args["exportName"] === "string" ? args["exportName"].trim() : "";
    const id = typeof args["id"] === "string" ? args["id"].trim() : "";

    if (exportName === "") {
        throw new LunoraError("BAD_REQUEST", "getWorkflowInstanceStatus: `exportName` is required");
    }

    if (id === "") {
        throw new LunoraError("BAD_REQUEST", "getWorkflowInstanceStatus: `id` is required");
    }

    return { exportName, id };
};

/** The lifecycle states a workflow instance can report (mirrors `@lunora/workflow`'s `WorkflowInstanceStatus`). */
const WORKFLOW_INSTANCE_STATES: ReadonlySet<string> = new Set<WorkflowInstanceStatusResult["status"]>([
    "complete",
    "errored",
    "paused",
    "queued",
    "running",
    "terminated",
    "unknown",
    "waiting",
    "waitingForPause",
]);

/** Coerce an unknown `status()` payload field into a known instance state, defaulting to `"unknown"`. */
const toWorkflowInstanceState = (raw: unknown): WorkflowInstanceStatusResult["status"] =>
    typeof raw === "string" && WORKFLOW_INSTANCE_STATES.has(raw) ? (raw as WorkflowInstanceStatusResult["status"]) : "unknown";

/**
 * Narrow an unknown `status()` error field into the `{ message, name }` wire shape, or `undefined` when absent.
 * @returns the narrowed error object, or `undefined` when the value is not a plain object
 */
const toWorkflowInstanceError = (raw: unknown): WorkflowInstanceStatusResult["error"] => {
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }

    const { message, name } = raw as { message?: unknown; name?: unknown };

    return { message: typeof message === "string" ? message : "", name: typeof name === "string" ? name : "Error" };
};
/* eslint-enable no-secrets/no-secrets */

/** The structured-filter operators accepted over the wire (mirrors `FilterOperator`). */
const FILTER_OPERATORS: ReadonlySet<string> = new Set<FilterOperator>(["contains", "eq", "gt", "gte", "lt", "lte", "ne"]);

/**
 * Parse the loosely-typed `filters` admin arg into validated {@link FilterClause}s,
 * dropping any malformed entry (non-object, missing/blank column, unknown
 * operator). Returns `undefined` when nothing valid remains so `readTablePage`
 * takes its no-predicate fast path.
 * @returns the validated filter clauses, or `undefined` when no valid clauses remain
 */
const parseTablePageFilters = (raw: unknown): FilterClause[] | undefined => {
    if (!Array.isArray(raw)) {
        return undefined;
    }

    const clauses: FilterClause[] = [];

    for (const item of raw) {
        if (typeof item !== "object" || item === null) {
            continue;
        }

        const record = item as Record<string, unknown>;
        const { column, operator } = record;

        if (typeof column !== "string" || column === "" || typeof operator !== "string" || !FILTER_OPERATORS.has(operator)) {
            continue;
        }

        clauses.push({ column, operator: operator as FilterOperator, value: record["value"] });
    }

    return clauses.length > 0 ? clauses : undefined;
};

/**
 * Parse the loosely-typed `orderBy` admin arg into a validated {@link OrderByClause}.
 * Requires a non-empty `column`; `direction` defaults to `asc` and is coerced to
 * `desc` only on an explicit `"desc"`. Returns `undefined` for anything malformed
 * so `readTablePage` keeps its natural-order read.
 * @returns the validated order-by clause, or `undefined` for malformed input
 */
const parseTablePageOrderBy = (raw: unknown): OrderByClause | undefined => {
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }

    const { column, direction } = raw as Record<string, unknown>;

    if (typeof column !== "string" || column === "") {
        return undefined;
    }

    return { column, direction: direction === "desc" ? "desc" : "asc" };
};

/**
 * Validate the `__lunora_admin__:deleteRows` payload. `table` must be a
 * non-empty string; `filters`/`search` mirror `readTablePage`'s predicate args
 * (so "delete matching" removes exactly the previewed rows) and a numeric
 * `limit` passes through to be clamped against {@link SHARD_BULK_DELETE_CAP}.
 * Throws a 400 `LunoraError` on a missing table, keeping the error shape uniform.
 */
const parseBulkDeleteArgs = (args: Record<string, unknown>): RunShardBulkDeleteArgs => {
    const table = typeof args["table"] === "string" ? args["table"] : "";

    if (table.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "deleteRows: `table` is required");
    }

    return {
        filters: parseTablePageFilters(args["filters"]),
        limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
        search: typeof args["search"] === "string" ? args["search"] : undefined,
        table,
    };
};

/**
 * Validate the `__lunora_admin__:clearTable` payload — the "empty this table"
 * action. Only `table` is meaningful (clearTable carries no predicate: it
 * matches every row); a numeric `limit` passes through for the per-call cap.
 * Throws a 400 `LunoraError` on a missing table.
 */
const parseClearTableArgs = (args: Record<string, unknown>): RunShardBulkDeleteArgs => {
    const table = typeof args["table"] === "string" ? args["table"] : "";

    if (table.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "clearTable: `table` is required");
    }

    return { limit: typeof args["limit"] === "number" ? args["limit"] : undefined, table };
};

/**
 * Validate the `__lunora_admin__:recordAuthEvent` payload — the worker's
 * fire-and-forget record of one auth attempt (PLAN3 §2.3). `outcome` must be
 * exactly `"ok"` or `"fail"`; anything else throws a 400 `LunoraError`, keeping
 * the error shape uniform with the other admin write parsers. Returns the
 * narrowed outcome the {@link recordAuthEvent} helper consumes.
 */
const parseRecordAuthEventArgs = (args: Record<string, unknown>): { outcome: "fail" | "ok" } => {
    const { outcome } = args;

    if (outcome !== "ok" && outcome !== "fail") {
        throw new LunoraError("BAD_REQUEST", 'recordAuthEvent: `outcome` must be "ok" or "fail"');
    }

    return { outcome };
};

/**
 * The mapped {@link LogEntry} one container lifecycle event becomes once parsed.
 * `functionPath` is the synthetic `container:&lt;name>` source so the Studio Logs
 * panel renders the row alongside `ctx.log` lines; `level` is folded to the
 * buffer's level set; `message` is a compact `&lt;event>` / `&lt;event>: &lt;detail>`.
 */
type ContainerLogEntry = LogEntry & { functionPath: string };

/** Recovers the process exit code embedded in a container `stop` message as `(exit &lt;n>)`. */
const CONTAINER_EXIT_CODE_PATTERN = /\(exit (\d+)\)/;

/**
 * Validate the `__lunora_admin__:recordContainerEvent` payload — the Container
 * DO's best-effort push of one lifecycle transition (`@lunora/container`'s
 * `reportContainerLifecycle`). The reserved op carries the same envelope
 * `emitContainerLifecycle` prints to the dev terminal under `args.event`, so the
 * terminal and the Studio Logs panel never diverge. Maps it to a {@link LogEntry}
 * with `functionPath: "container:&lt;name>"`. A malformed envelope throws a 400
 * `LunoraError`, matching the other admin write parsers.
 */
const parseRecordContainerEventArgs = (args: Record<string, unknown>): ContainerLogEntry => {
    const raw = args["event"];

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new LunoraError("BAD_REQUEST", "recordContainerEvent: `event` must be an object");
    }

    const envelope = raw as Record<string, unknown>;
    const container = typeof envelope["container"] === "string" ? envelope["container"] : "";
    const event = typeof envelope["event"] === "string" ? envelope["event"] : "";

    if (container.trim() === "" || event.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "recordContainerEvent: `event.container` and `event.event` are required");
    }

    // Fold the envelope's `error`/`info` level into the buffer's level set
    // (anything but `error` is informational, keeping the panel's filters stable).
    const level = envelope["level"] === "error" ? "error" : "info";
    const detail = typeof envelope["message"] === "string" ? envelope["message"] : undefined;
    const timestamp = typeof envelope["ts"] === "number" ? envelope["ts"] : Date.now();

    // The per-instance correlation id (the container's Durable Object id) rides
    // the envelope as `instance`; carry it through so the Studio can fold rows
    // per running instance instead of collapsing every instance of a container
    // into one lane. The exit code is embedded in the `stop` message as
    // `(exit <n>)` (never a structured field), so recover it here.
    const instance = typeof envelope["instance"] === "string" && envelope["instance"] !== "" ? envelope["instance"] : undefined;
    const exitRaw = detail === undefined ? undefined : CONTAINER_EXIT_CODE_PATTERN.exec(detail)?.[1];
    const exitCode = exitRaw === undefined ? undefined : Number.parseInt(exitRaw, 10);

    return {
        exitCode,
        functionPath: `container:${container}`,
        instance,
        level,
        message: detail === undefined || detail === "" ? event : `${event}: ${detail}`,
        timestamp,
    };
};

/**
 * Arguments accepted by the `__lunora_admin__:runAs` admin RPC — the studio's
 * "Run as identity" tool. `functionPath` + `args` name the target function to
 * dispatch; `userId` (and the optional `identity` claims envelope) are the
 * forged identity it runs under. Admin-gated by `handleAdminRpc`; intended for
 * loopback-dev only (the studio UI exposes it only on a dev gate).
 */
interface RunAsArgs {
    args: Record<string, unknown>;
    functionPath: string;
    identity?: Record<string, unknown>;
    userId: string;
}

/**
 * Validate the `__lunora_admin__:runAs` payload. `functionPath` and `userId`
 * must be non-empty strings; `args` defaults to `{}` and `identity` (if present)
 * must be a plain object of claims. The target `functionPath` must NOT itself be
 * a reserved admin path — forging an identity to re-enter the admin plane is
 * never allowed. Anything malformed throws a 400 `LunoraError`, matching the
 * other admin parsers.
 */
const parseRunAsArgs = (args: Record<string, unknown>): RunAsArgs => {
    const functionPath = typeof args["functionPath"] === "string" ? args["functionPath"] : "";
    const userId = typeof args["userId"] === "string" ? args["userId"] : "";

    if (functionPath.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "runAs: `functionPath` is required");
    }

    if (functionPath.startsWith(ADMIN_FUNCTION_PREFIX)) {
        throw new LunoraError("BAD_REQUEST", "runAs: cannot target a reserved admin function");
    }

    if (userId.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "runAs: `userId` is required");
    }

    const rawArgs = args["args"];

    if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
        throw new LunoraError("BAD_REQUEST", "runAs: `args` must be an object");
    }

    const rawIdentity = args["identity"];

    if (rawIdentity !== undefined && (typeof rawIdentity !== "object" || rawIdentity === null || Array.isArray(rawIdentity))) {
        throw new LunoraError("BAD_REQUEST", "runAs: `identity` must be an object");
    }

    return {
        args: rawArgs === undefined ? {} : (rawArgs as Record<string, unknown>),
        functionPath,
        userId,
        ...(rawIdentity === undefined ? {} : { identity: rawIdentity as Record<string, unknown> }),
    };
};

/**
 * Validate the `__lunora_admin__:recordMail` payload — the dev mail catcher's
 * capture of one outbound message (a rendered, already-validated `SendPayload`
 * from `@lunora/mail`). `subject` must be a string and `to` a string or string
 * array; the optional address/body/header fields are shape-checked. Anything
 * else throws a 400 `LunoraError`, matching the other admin write parsers.
 *
 * This is the trust-boundary re-check for the admin RPC edge — it stays even
 * though the wire type is now centralized. Its return type `RecordMailInput` is
 * a compile-time mirror of `@lunora/mail`'s canonical `SendPayload` (guarded in
 * `mail-catcher.ts`). Adding a captured-mail field is therefore a two-place
 * change: the canonical `SendPayload`/`CapturedMail` in `@lunora/mail`, and the
 * field-by-field validation here (the mirror types update themselves, and their
 * drift guards point you back here). Keep the shapes in lockstep.
 */
const parseRecordMailArgs = (args: Record<string, unknown>): RecordMailInput => {
    const bad = (message: string): never => {
        throw new LunoraError("BAD_REQUEST", `recordMail: ${message}`);
    };

    const { bcc, cc, from, headers, html, replyTo, subject, text, to } = args;

    if (typeof subject !== "string") {
        bad("`subject` must be a string");
    }

    const toOk = typeof to === "string" || (Array.isArray(to) && to.every((entry) => typeof entry === "string"));

    if (!toOk) {
        bad("`to` must be a string or string[]");
    }

    /** @returns the string array when valid, or `undefined` when the value is absent */
    const optionalStringList = (value: unknown, label: string): string[] | undefined => {
        if (value === undefined) {
            return undefined;
        }

        if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
            bad(`\`${label}\` must be a string[]`);
        }

        return value as string[];
    };

    const optionalString = (value: unknown, label: string): string | undefined => {
        if (value !== undefined && typeof value !== "string") {
            bad(`\`${label}\` must be a string`);
        }

        return value as string | undefined;
    };

    return {
        bcc: optionalStringList(bcc, "bcc"),
        cc: optionalStringList(cc, "cc"),
        from: optionalString(from, "from"),
        headers: headers !== undefined && typeof headers === "object" && headers !== null ? (headers as Record<string, string>) : undefined,
        html: optionalString(html, "html"),
        replyTo: optionalString(replyTo, "replyTo"),
        subject: subject as string,
        text: optionalString(text, "text"),
        to: to as string | string[],
    };
};

/** Default recipient for the studio "Send test" action when no `to` is supplied. */
const TEST_MAIL_DEFAULT_TO = "test@lunora.sh";

/**
 * Build the synthetic captured message the studio "Send test" button populates
 * the dev inbox with. A short html+text body carrying a verify link so the
 * catcher's link-extraction + preview have realistic content to render. `to`
 * is validated (optional string, 400 on a bad shape) and defaults to
 * {@link TEST_MAIL_DEFAULT_TO}.
 */
const buildTestMailInput = (args: Record<string, unknown>): RecordMailInput => {
    const { to } = args;

    if (to !== undefined && typeof to !== "string") {
        throw new LunoraError("BAD_REQUEST", "sendTestMail: `to` must be a string");
    }

    const recipient = to ?? TEST_MAIL_DEFAULT_TO;
    const link = "https://example.test/verify?token=demo";

    return {
        from: "Lunora <noreply@lunora.sh>",
        html: `<p>This is a test email from the Lunora dev mail catcher.</p><p><a href="${link}">Verify your email</a></p>`,
        subject: "Lunora test email",
        text: `This is a test email from the Lunora dev mail catcher.\n\nVerify your email: ${link}`,
        to: recipient,
    };
};

/**
 * Minimal structural shape of a Cloudflare Queue producer binding (the generated
 * `env.QUEUE_*` object) — only `send`/`sendBatch`, the members the studio's
 * send/replay ops call. Mirrors `@lunora/queue`'s producer surface so `@lunora/do`
 * needs no dependency on the queue package.
 */
interface QueueBindingHandle {
    send: (body: unknown, options?: { contentType?: string; delaySeconds?: number }) => Promise<void>;
    sendBatch: (messages: Iterable<{ body: unknown; contentType?: string; delaySeconds?: number }>, options?: { delaySeconds?: number }) => Promise<void>;
}

/** Parsed `__lunora_admin__:sendQueueMessage` payload: which declared queue to enqueue to, plus body/tuning. */
interface SendQueueMessageArgs {
    /** When set, enqueue this array as a single `sendBatch` instead of `body` as one message. */
    batch?: unknown[];
    body: unknown;
    contentType?: string;
    delaySeconds?: number;
    exportName: string;
}

/**
 * Validate the `__lunora_admin__:recordQueueMessage` capture payload — a batch of
 * consumed messages posted by the generated worker `queue()` sink. Shape-checks
 * each entry (the trust-boundary re-check at the admin edge) and normalizes it to
 * the {@link RecordQueueMessageInput} the catcher stores. Throws a 400 `LunoraError`
 * on a malformed envelope.
 */
const parseRecordQueueMessageArgs = (args: Record<string, unknown>): RecordQueueMessageInput[] => {
    const bad = (message: string): never => {
        throw new LunoraError("BAD_REQUEST", `recordQueueMessage: ${message}`);
    };

    const raw = args["messages"];

    if (!Array.isArray(raw)) {
        bad("`messages` must be an array");
    }

    const outcomes = new Set<QueueMessageOutcome>(["ack", "error", "retry"]);

    return (raw as unknown[]).map((entry, index): RecordQueueMessageInput => {
        if (typeof entry !== "object" || entry === null) {
            bad(`\`messages[${String(index)}]\` must be an object`);
        }

        const record = entry as Record<string, unknown>;
        const messageId = typeof record["messageId"] === "string" ? record["messageId"] : "";
        const queue = typeof record["queue"] === "string" ? record["queue"] : "";
        const outcome = typeof record["outcome"] === "string" ? record["outcome"] : "";

        if (messageId === "") {
            bad(`\`messages[${String(index)}].messageId\` is required`);
        }

        if (queue === "") {
            bad(`\`messages[${String(index)}].queue\` is required`);
        }

        if (!outcomes.has(outcome as QueueMessageOutcome)) {
            bad(`\`messages[${String(index)}].outcome\` must be one of ack | error | retry`);
        }

        // `Number.isFinite` (not just `typeof === "number"`) so a NaN/Infinity slipped
        // into the JSON payload falls back to the default rather than being stored and
        // later rendered as a broken attempt count / timestamp.
        const { attempts, timestamp } = record;

        return {
            attempts: typeof attempts === "number" && Number.isFinite(attempts) ? attempts : 1,
            body: record["body"],
            deadLettered: record["deadLettered"] === true,
            error: typeof record["error"] === "string" ? record["error"] : undefined,
            exportName: typeof record["exportName"] === "string" ? record["exportName"] : undefined,
            messageId,
            outcome: outcome as QueueMessageOutcome,
            queue,
            timestamp: typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : 0,
        };
    });
};

/** Cloudflare Queues accepts 1–100 messages per `sendBatch` call (a 0 or >100 batch is a `BatchCountOutOfBounds` error). */
const MAX_QUEUE_SEND_BATCH = 100;

/**
 * Validate the `__lunora_admin__:sendQueueMessage` payload (also the replay path's
 * resolved target). Requires a non-empty `exportName`; `delaySeconds` must be a
 * non-negative number when present; `batch` (when an array) switches the op to a
 * single `sendBatch` and must carry 1–{@link MAX_QUEUE_SEND_BATCH} messages. Throws
 * a 400 `LunoraError` on a bad shape.
 */
const parseSendQueueMessageArgs = (args: Record<string, unknown>): SendQueueMessageArgs => {
    const exportName = typeof args["exportName"] === "string" ? args["exportName"].trim() : "";

    if (exportName === "") {
        throw new LunoraError("BAD_REQUEST", "sendQueueMessage: `exportName` is required");
    }

    const delayRaw = args["delaySeconds"];

    if (delayRaw !== undefined && (typeof delayRaw !== "number" || !Number.isFinite(delayRaw) || delayRaw < 0)) {
        throw new LunoraError("BAD_REQUEST", "sendQueueMessage: `delaySeconds` must be a non-negative number");
    }

    const batch = Array.isArray(args["batch"]) ? (args["batch"] as unknown[]) : undefined;

    // Cloudflare's `sendBatch` rejects an empty or >100-message batch (BatchCountOutOfBounds).
    // Fail it on the existing 400 path so a malformed payload never reaches the queue API.
    if (batch !== undefined && (batch.length === 0 || batch.length > MAX_QUEUE_SEND_BATCH)) {
        throw new LunoraError("BAD_REQUEST", `sendQueueMessage: \`batch\` must contain between 1 and ${String(MAX_QUEUE_SEND_BATCH)} messages`);
    }

    return {
        batch,
        body: args["body"],
        contentType: typeof args["contentType"] === "string" ? args["contentType"] : undefined,
        delaySeconds: delayRaw,
        exportName,
    };
};

/**
 * Validate the `__lunora_admin__:replayQueueMessage` payload. Requires a non-empty
 * capture-row `id`; `target` optionally overrides the resolved destination export
 * (the studio uses it for DLQ redrive onto the parent queue). Throws a 400
 * `LunoraError` on a bad shape.
 */
const parseReplayQueueMessageArgs = (args: Record<string, unknown>): { id: string; target?: string } => {
    const id = typeof args["id"] === "string" ? args["id"].trim() : "";

    if (id === "") {
        throw new LunoraError("BAD_REQUEST", "replayQueueMessage: `id` is required");
    }

    const target = typeof args["target"] === "string" && args["target"].trim() !== "" ? args["target"].trim() : undefined;

    return { id, target };
};

/**
 * Validate the `__lunora_admin__:rankBefore` payload. `table`, `index`,
 * `partitionKey`, and `rowId` must be non-empty strings and `sortValues` must
 * be an array; anything else throws a 400 `LunoraError` so the cross-shard
 * coordinator surfaces a uniform error rather than a downstream SQL failure.
 */
const parseRankBeforeArgs = (args: Record<string, unknown>): RunShardRankBeforeArgs => {
    const table = typeof args["table"] === "string" ? args["table"] : "";
    const index = typeof args["index"] === "string" ? args["index"] : "";
    const rowId = typeof args["rowId"] === "string" ? args["rowId"] : "";

    if (table.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "rankBefore: `table` is required");
    }

    if (index.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "rankBefore: `index` is required");
    }

    // `partitionKey` is the encoded partition tuple — `""` is legitimate for a
    // rankIndex with no `partitionBy`, so only the type is enforced, not
    // non-emptiness.
    if (typeof args["partitionKey"] !== "string") {
        throw new LunoraError("BAD_REQUEST", "rankBefore: `partitionKey` must be a string");
    }

    if (rowId.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "rankBefore: `rowId` is required");
    }

    if (!Array.isArray(args["sortValues"])) {
        throw new LunoraError("BAD_REQUEST", "rankBefore: `sortValues` must be an array");
    }

    return { index, partitionKey: args["partitionKey"], rowId, sortValues: args["sortValues"], table };
};

/** Throw a uniform 400 `LunoraError` for a malformed admin payload field. */
const badRequest = (message: string): never => {
    throw new LunoraError("BAD_REQUEST", message);
};

/** Narrow a required non-empty string admin arg or 400 with `&lt;field> is required`. */
const requireNonEmptyString = (value: unknown, field: string): string => {
    if (typeof value !== "string" || value.trim() === "") {
        badRequest(`rankPage: \`${field}\` is required`);
    }

    return value as string;
};

/**
 * Validate the optional `__lunora_admin__:rankPage` `after` resume key the
 * coordinator forwards (`{ partitionKey, sortValues, rowId }`), so a malformed
 * cursor is rejected at the boundary rather than mid-SQL. `undefined` (first
 * page) passes through.
 * @returns the validated after-key object, or `undefined` for a first-page request
 */
const parseRankPageAfter = (raw: unknown): RunShardRankPageArgs["after"] => {
    if (raw === undefined) {
        return undefined;
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        badRequest("rankPage: `after` must be an object");
    }

    const record = raw as Record<string, unknown>;

    if (typeof record["partitionKey"] !== "string" || typeof record["rowId"] !== "string" || !Array.isArray(record["sortValues"])) {
        badRequest("rankPage: `after` must have a string partitionKey, string rowId, and array sortValues");
    }

    return { partitionKey: record["partitionKey"] as string, rowId: record["rowId"] as string, sortValues: record["sortValues"] as unknown[] };
};

/**
 * Validate the `__lunora_admin__:rankPage` payload. `table` and `index` are
 * required non-empty strings; `take`/`cursor`/`after`/`partitionKey`/`directions`
 * are optional and shape-checked just enough to reject obvious garbage before it
 * reaches the rank reader. The error shape stays uniform with the other admin
 * parsers so the cross-shard coordinator surfaces a 400 rather than a downstream
 * SQL failure.
 */
const parseRankPageArgs = (args: Record<string, unknown>): RunShardRankPageArgs => {
    const table = requireNonEmptyString(args["table"], "table");
    const index = requireNonEmptyString(args["index"], "index");

    if (args["take"] !== undefined && typeof args["take"] !== "number") {
        badRequest("rankPage: `take` must be a number");
    }

    if (args["cursor"] !== undefined && args["cursor"] !== null && typeof args["cursor"] !== "string") {
        badRequest("rankPage: `cursor` must be a string or null");
    }

    if (args["partitionKey"] !== undefined && typeof args["partitionKey"] !== "string") {
        badRequest("rankPage: `partitionKey` must be a string");
    }

    if (args["directions"] !== undefined && !Array.isArray(args["directions"])) {
        badRequest("rankPage: `directions` must be an array");
    }

    const directions = args["directions"] === undefined ? undefined : (args["directions"] as unknown[]).map((d) => (d === "desc" ? "desc" : "asc"));

    return {
        after: parseRankPageAfter(args["after"]),
        cursor: typeof args["cursor"] === "string" ? args["cursor"] : undefined,
        directions,
        index,
        partitionKey: typeof args["partitionKey"] === "string" ? args["partitionKey"] : undefined,
        take: typeof args["take"] === "number" ? args["take"] : undefined,
        table,
    };
};

/**
 * Decode a `JSON.stringify([table, index])` index-hit key (stamped by
 * `getCtxDbIndexUseHook`) back into `{ table, index }`. Returns `undefined` for
 * a malformed key so a corrupt entry is skipped rather than throwing on the
 * metrics path.
 * @returns the decoded index hit, or `undefined` for a malformed key
 */
const decodeIndexHitKey = (key: string): IndexHit | undefined => {
    try {
        const parsed = JSON.parse(key) as unknown;

        if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
            return { index: parsed[1], table: parsed[0] };
        }
    } catch {
        // Malformed key — skip it.
    }

    return undefined;
};

/** Arguments accepted by the `__lunora_admin__:cdcSync` admin RPC. */
interface RunShardCdcSyncArgs {
    limit?: number;
    sinceSeq: number;
}

/** Arguments accepted by the `__lunora_admin__:applyCdc` admin RPC. */
interface RunShardApplyCdcArgs {
    changes: ReadonlyArray<CdcChange>;
}

/** Result of an `applyCdc` replay batch. */
interface RunShardApplyCdcResult {
    applied: number;
}

/**
 * Validate the `__lunora_admin__:applyCdc` payload. `changes` must be an array
 * of CDC entries (`{ table, id, op, doc? }`); each is shape-checked just enough
 * to reject obvious garbage before it reaches the writer.
 */
const parseApplyCdcArgs = (args: Record<string, unknown>): RunShardApplyCdcArgs => {
    const raw = args["changes"];

    if (!Array.isArray(raw)) {
        throw new LunoraError("BAD_REQUEST", "applyCdc: `changes` must be an array");
    }

    const changes = raw.map((entry, index): CdcChange => {
        const record = entry as Record<string, unknown>;
        const { op } = record;
        const table = typeof record["table"] === "string" ? record["table"] : "";
        const id = typeof record["id"] === "string" ? record["id"] : "";

        if (table === "" || id === "" || (op !== "insert" && op !== "update" && op !== "delete")) {
            throw new LunoraError("BAD_REQUEST", `applyCdc: changes[${String(index)}] must have a table, id, and op of insert|update|delete`);
        }

        const rawDocument = record["doc"];

        // `typeof [] === "object"`, so an explicit Array.isArray guard is
        // required to keep arrays out of the writer (which expects a
        // Record). Failing here surfaces the malformed change at the parse
        // boundary instead of mid-replay.
        if (rawDocument !== undefined && (typeof rawDocument !== "object" || rawDocument === null || Array.isArray(rawDocument))) {
            throw new LunoraError("BAD_REQUEST", `applyCdc: changes[${String(index)}].doc must be an object`);
        }

        const document = rawDocument as Record<string, unknown> | undefined;

        // When the post-image carries an id it must agree with the entry id,
        // otherwise the replay would write a row whose id contradicts the CDC
        // cursor — reject the inconsistency at the boundary.
        if (document !== undefined && typeof document["_id"] === "string" && document["_id"] !== id) {
            throw new LunoraError("BAD_REQUEST", `applyCdc: changes[${String(index)}].doc._id must match the entry id`);
        }

        return {
            doc: document,
            id,
            op,
            seq: typeof record["seq"] === "number" ? record["seq"] : 0,
            table,
            ts: typeof record["ts"] === "number" ? record["ts"] : 0,
        };
    });

    return { changes };
};

/**
 * Validate the `__lunora_admin__:cdcSync` payload. `sinceSeq` is the caller's
 * per-shard cursor (defaults to 0 = from the beginning); `limit` is an optional
 * page cap. Both are coerced to finite non-negative integers.
 */
const parseCdcSyncArgs = (args: Record<string, unknown>): RunShardCdcSyncArgs => {
    const toCount = (value: unknown): number | undefined => {
        const n = typeof value === "number" ? value : Number(value);

        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
    };

    return { limit: toCount(args["limit"]), sinceSeq: toCount(args["sinceSeq"]) ?? 0 };
};

/**
 * The shard's read-your-writes cursor as a `jsonResponse` headers argument:
 * `x-d1-bookmark` when a bookmark exists, else nothing. Keeps the DO-specific
 * header out of the shared `jsonResponse` helper's signature.
 */
const bookmarkHeaders = (bookmark: string | undefined): Record<string, string> | undefined => (bookmark ? { "x-d1-bookmark": bookmark } : undefined);

/**
 * Decode the JSON envelope shipped on the `x-lunora-identity` header.
 * Malformed payloads collapse to `undefined` rather than throwing — the
 * shard should still serve requests whose identity claims didn't round-trip.
 * @returns the decoded identity object, or `undefined` when the header is absent or malformed
 */
const parseIdentityHeader = (raw: string | null): Record<string, unknown> | undefined => {
    if (!raw) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(raw) as unknown;

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // fall through to undefined
    }

    return undefined;
};

/**
 * Parse the `x-lunora-client-seq` header into a positive integer mutation
 * sequence, or `undefined` when absent / non-numeric / non-positive. A
 * malformed value disables the watermark path for that call rather than
 * throwing — the call then rides the legacy idempotency dedup.
 */
const parseClientSeqHeader = (raw: string | null): number | undefined => {
    if (!raw) {
        return undefined;
    }

    const seq = Number(raw);

    return Number.isInteger(seq) && seq > 0 ? seq : undefined;
};

/**
 * Reduce a dependency-tracker dep set (`table:id` / `table:*scan` keys, see
 * `dependency-tracker.ts`) to the distinct table names it touched. Used to
 * source the request log's `tablesRead` from the per-query tracker without
 * leaking the row-level dep encoding into the log.
 */
const tablesFromDeps = (deps: Set<string>): Set<string> => {
    const tables = new Set<string>();

    for (const dep of deps) {
        const table = tableFromDepKey(dep);

        if (table !== "") {
            tables.add(table);
        }
    }

    return tables;
};

/**
 * Parse a positive-integer env override (e.g. `LUNORA_REQUEST_LOG_RETENTION`); `undefined` when unset/invalid so the caller keeps its default.
 * @returns the parsed positive integer, or `undefined` when unset or invalid
 */
const parsePositiveInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    const value = Number.parseInt(raw, 10);

    return Number.isFinite(value) && value > 0 ? value : undefined;
};

/**
 * Resolve the per-dispatch console-stream toggle (`LUNORA_REQUEST_LOG_EMIT`).
 * An explicit `"1"`/`"true"` forces it on and `"0"`/`"false"` forces it off
 * (even in dev); when the var is unset/empty it falls back to `devDefault` —
 * which the caller passes as {@link isDevEnvironment}, so a dev deployment
 * streams every successful dispatch by default while production stays quiet
 * unless an operator opts in. Errors always stream regardless — see
 * `recordRequestLog`.
 */
const parseEmit = (raw: string | undefined, devDefault: boolean): boolean => {
    if (raw === "1" || raw === "true") {
        return true;
    }

    if (raw === "0" || raw === "false") {
        return false;
    }

    return devDefault;
};

/** Parse a 0..1 sample rate (`LUNORA_REQUEST_LOG_SAMPLE`); clamped to `[0, 1]`, defaulting to `1` (record all) when unset/invalid. */
const parseSampleRate = (raw: string | undefined): number => {
    if (raw === undefined) {
        return 1;
    }

    const value = Number.parseFloat(raw);

    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
};

/** Whether a sampled event survives at `rate` (`1` = always, `0` = never, else a uniform draw). */
const sampleHit = (rate: number): boolean => {
    if (rate >= 1) {
        return true;
    }

    if (rate <= 0) {
        return false;
    }

    // eslint-disable-next-line sonarjs/pseudo-random -- observability sampling, not a security-sensitive draw; an attacker biasing which request logs is not a threat.
    return Math.random() < rate;
};

/**
 * @returns the bearer token from the Authorization header, or `undefined` when absent or not a Bearer scheme
 */
const extractBearerToken = (authorization: string | null): string | undefined => {
    if (!authorization) {
        return undefined;
    }

    const [scheme, ...rest] = authorization.split(" ");

    if (scheme?.toLowerCase() !== "bearer") {
        return undefined;
    }

    const value = rest.join(" ").trim();

    return value.length > 0 ? value : undefined;
};

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
     * Per-socket subscription cap. Each subscription is stored in the
     * hibernation attachment (which is serialized JSON), and runaway
     * subscribe loops would let a single client wedge the attachment past
     * the runtime's size budget — keep the per-socket ceiling well below
     * that. 32 is enough for any reasonable client (one per visible
     * panel/query) and small enough that an attachment serialization
     * failure stays unlikely.
     */
    protected static readonly MAX_SUBSCRIPTIONS_PER_SOCKET = 32;

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
     * (`Map&lt;rowKey, hash&gt;`) so the poll loop can diff it; that snapshot — and the
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
    private static nextPollAlarmTarget(globalShapesRemaining: number, nextSourceDueAt: number | undefined, nowMs: number): number | undefined {
        const globalTarget = globalShapesRemaining > 0 ? nowMs + ShardDO.GLOBAL_SHAPE_POLL_INTERVAL_MS : undefined;

        if (globalTarget === undefined) {
            return nextSourceDueAt === undefined ? undefined : Math.max(nextSourceDueAt, nowMs);
        }

        return nextSourceDueAt === undefined ? globalTarget : Math.min(globalTarget, nextSourceDueAt);
    }

    protected state: ShardDOState;

    protected env: unknown;

    /**
     * Opt-in per-shard reactive query cache. When the subclass passes
     * `ReactiveCacheOptions` to `super(state, env, { reactiveCache: { … } })`
     * the cache is instantiated here and exposed to subclasses via
     * `runCachedQuery`; when omitted (today's default) it stays
     * undefined and the dispatch path runs with zero cache overhead.
     *
     * The cache is per-shard and in-memory only — it is lost on DO restart
     * and on workerd hibernation. That's fine: a cold shard simply re-runs
     * the query on the first call, just like it does today.
     */
    protected readonly reactiveCache: ReactiveCache | undefined;

    /**
     * Lazily-built drizzle handle over `state.storage`. Memoised so a single
     * DO instance reuses the same dialect across handler calls. The drizzle
     * DO driver only touches `storage.sql`, so test doubles only need to
     * supply that field — see {@link ShardDOState}.
     */
    private drizzleHandle: DrizzleSqliteDODatabase<Record<string, unknown>> | undefined;

    /**
     * Tracks BEGIN/COMMIT nesting so we can reject nested transactions —
     * SQLite-in-DO does not support them and the runtime would crash with
     * "cannot start a transaction within a transaction".
     */
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
     * `false` for actions/queries (no transaction wrapper) so their dispatch-level
     * idempotency persist still runs.
     */
    private mutationBookkeepingCommitted = false;

    /**
     * Wall-clock millis of the last `__idempotency` GC sweep on this warm
     * instance. The dedup write throttles `trimIdempotent` to at most once an
     * hour off this field (in-memory, so a fresh instance just sweeps on its
     * first mutation) — keeping the 24h-retention cleanup off the per-mutation
     * hot path without needing a separate alarm/cron.
     */
    private lastIdempotencyTrimAt = 0;

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
    private readonly subMemos = new WeakMap<WebSocket, Map<string, SubscriptionMemo>>();

    /**
     * Per-socket poke baseline for shape subscriptions: maps each shape's
     * subscription id to the `__cdc_log` cursor it has been poked through.
     * `pokeShapeSubscribers` reads each op page since this cursor and advances
     * it to the flush watermark. In-memory only (like {@link ShardDO.subMemos});
     * a cold memo on a reconnected/hibernated socket re-seeds from the client's
     * `sinceCheckpoint`.
     */
    private readonly shapeMemos = new WeakMap<WebSocket, Map<string, ShapeMemo>>();

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
    private readonly globalShapeSnapshots = new WeakMap<WebSocket, Map<string, Map<string, string>>>();

    /**
     * Whether a global-shape poll alarm is currently armed. Guards
     * {@link ShardDO.scheduleGlobalPoll} from re-arming on every seed; reset in
     * {@link ShardDO.alarm} before the poll so a still-subscribed shape re-arms.
     */
    private globalPollScheduled = false;

    /** Monotonic per-DO poke id source; correlates a poke's `pokeStart`/`pokePart`/`pokeEnd` frames. */
    private pokeSequence = 0;

    /** Per-socket whisper-rate token bucket (see {@link ShardDO.WHISPER_RATE_BURST}). In-memory; resets on hibernation. */
    private readonly whisperBuckets = new WeakMap<WebSocket, { last: number; tokens: number }>();

    /**
     * Per-socket {@link AbortController} map keyed by stream id, used to
     * propagate a client unsubscribe (or a socket close) into the user
     * handler. In-memory only: a hibernation drops the controllers, which is
     * fine because the corresponding socket is gone too — the iterator
     * pumping into it would have nowhere to write.
     */
    private readonly streamCancellers = new WeakMap<WebSocket, Map<string, AbortController>>();

    /**
     * Lifetime request counters surfaced by the `__lunora_admin__:getMetrics`
     * RPC. In-memory only — they reset when the DO hibernates or restarts, which
     * is the right granularity for a "since this instance woke" health readout
     * (durable aggregation would be a separate, heavier feature).
     */
    private readonly metrics = { errors: 0, requests: 0, sinceMs: Date.now() };

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
     * The runtime's Durable Object namespace binding name (e.g. `"SHARD"`),
     * forwarded as `x-lunora-shard-binding` on every request so a DO can address
     * its siblings (`this.env[binding].getByName(...)`) for the relay hub. Absent
     * in single-DO mode / the unit harness — when absent, the relay tier is inert
     * and whispers stay shard-local (no behavior change). In-memory; re-learned per
     * request.
     */
    private shardBinding: string | undefined;

    /**
     * The auto-elastic fan-out relay collaborator (plan 075) — an {@link OwnerRelay}
     * or {@link RelayMember} chosen ONCE from this DO's name, or `undefined` for an
     * unnamed (single-DO) DO where the relay tier is inert. All relay state +
     * transport lives on it, reached back through the {@link RelayHost} adapter, so
     * owner-only state can never sit next to relay-only state on this class.
     */
    private readonly relay: OwnerRelay | RelayMember | undefined;

    /**
     * Declared indexes (`table:index`) a query has exercised since this instance
     * woke, stamped by `getCtxDbIndexUseHook`. In-memory and reset on
     * hibernation/restart — drives the `unused_index` runtime advisory.
     */
    private readonly usedIndexes = new Set<string>();

    /**
     * Per-function execution counters surfaced by the
     * `__lunora_admin__:getFunctionStats` RPC, keyed by `&lt;file>:&lt;function>`
     * path. Shares the `metrics` lifecycle: in-memory, reset on
     * hibernation/restart. The map is naturally bounded by the app's registered
     * function count (a finite set), so no eviction is needed. Maintained by
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
     * In-flight dependency tracker for the currently-executing query. Set by
     * `runCachedQuery` so the ctx-db hooks (wired via `onRead`) can
     * stamp deps without threading the tracker explicitly through every
     * generated handler signature. Cleared in the `finally` of the same
     * call so a leaked tracker can never bleed into a sibling RPC.
     */
    private currentTracker: DependencyTracker | undefined;

    /**
     * Tables the in-flight dispatch full-scanned (read via `SCAN_DEP`, no index
     * / point lookup). Allocated at the top of each `/rpc` dispatch and drained
     * into `recordFunctionCall` once the handler returns, so the durable
     * `__lunora_metrics_scans` attribution can pin a slow function to the
     * table(s) it scanned. Independent of `currentTracker` (which only exists
     * when the reactive cache is enabled), so the causal signal is collected
     * even on a cache-less shard. Stamped by `getCtxDbReadHook`.
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
     * Read-tables + cache-hit captured for the current `/rpc` dispatch, so the
     * dispatch site can fold them into the durable request log
     * (`request-log.ts`). Populated by `runCachedQuery` — the one place that
     * both holds the per-query dependency tracker AND learns whether the
     * reactive cache served the result — and reset per request in `fetch`.
     * `undefined`/empty when the reactive cache is disabled or the path is a
     * write/action (which doesn't run through the cache), which is exactly why
     * the request log treats those fields as "unknown" rather than asserting a
     * read set on the hot path.
     */
    private currentRequestReadTables: Set<string> | undefined;

    /**
     * Per-statement SQL samples collected during the current `/rpc` dispatch by
     * the instrumented `sql` getter. Drained into the durable
     * `__lunora_metrics_queries` table after the handler returns (same pattern as
     * `currentScannedTables` / `currentIndexHits`). `undefined` when no dispatch
     * is in flight; allocated fresh per dispatch so a previous request's samples
     * never leak into the next one.
     *
     * Each entry is `[rawSql, durationMs, rowsRead, rowsWritten]`. DML rows
     * written is always 0 here — the ctx-db adapter doesn't expose a
     * `changes()` count through the structural `SqlExec` surface, so we
     * attribute only SELECT result sizes as `rowsRead`.
     */
    private currentStmtSamples: [string, number, number, number][] | undefined;

    /** Whether the current dispatch's cached query was served from cache; `undefined` until `runCachedQuery` resolves one. */
    private currentRequestCacheHit: boolean | undefined;

    public constructor(state: ShardDOState, env: unknown, options: ShardDOOptions = {}) {
        this.state = state;
        this.env = env;

        if (options.reactiveCache) {
            this.reactiveCache = new ReactiveCache(options.reactiveCache);
        }

        // The relay tier reaches this DO back through a narrow adapter; the role-typed
        // collaborator (owner vs relay) is fixed once from the DO name (plan 075).
        const host: RelayHost = {
            buildShapeDiff: (resolved, fromCursor, toCursor) => this.buildShapeDiff(this.sql as SqlExec, resolved, fromCursor, toCursor),
            computeOpLogShapeSeed: (shape, resolved) => this.computeOpLogShapeSeed(shape, resolved),
            currentCdcEpoch: () => this.currentCdcEpoch(),
            deliverWhisperLocal: (topic, frame, exclude) => this.deliverWhisperLocal(topic, frame, exclude),
            doName: () => this.state.id?.name,
            env: () => this.env,
            getWebSockets: () => this.state.getWebSockets(),
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
            shardBinding: () => this.shardBinding,
            sql: () => this.sql as SqlExec,
        };

        this.relay = createRelayLink(host);

        this.armWebSocketKeepalive();
    }

    /** SQLite handle scoped to this Durable Object. */

    /**
     * Worker-side fetch entry point. Handles WebSocket upgrades and the
     * shard-local RPC endpoint forwarded by `@lunora/runtime`.
     */
    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // Learn the DO namespace binding the runtime routes through, so this DO can
        // address its siblings for the relay hub (plan 075 Phase 2). Sent on every
        // forwarded request; kept across requests once known.
        this.shardBinding = request.headers.get("x-lunora-shard-binding") ?? this.shardBinding;

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

        // Reserved admin-introspection RPCs are intercepted before user
        // dispatch — they read raw SQLite directly rather than running a
        // registered function, and carry their own bearer-token gate.
        if (payload.functionPath.startsWith(ADMIN_FUNCTION_PREFIX)) {
            return this.handleAdminRpc(request, payload.functionPath, payload.args ?? {});
        }

        // Stash the inbound D1 bookmark and identity headers for the
        // duration of the handler call so getters return the right
        // values. Cleared on exit so the next request starts fresh.
        this.currentRequestBookmark = request.headers.get("x-d1-bookmark") ?? undefined;
        this.currentResponseBookmark = undefined;
        this.currentRequestUserId = request.headers.get("x-lunora-userid") ?? undefined;
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
        this.mutationBookkeepingCommitted = false;
        this.currentRequestIdentity = parseIdentityHeader(request.headers.get("x-lunora-identity"));
        // The caller's IP, forwarded server-side from Cloudflare's trusted
        // `CF-Connecting-IP` (never copied from a client header). Surfaced as
        // `ctx.ip` so handlers/middleware can key on it (e.g. rate-limit
        // unauthenticated traffic by IP).
        this.currentRequestIp = request.headers.get("x-lunora-client-ip") ?? undefined;
        this.currentRequestSystem = request.headers.get("x-lunora-system") === "1";
        this.currentRequestTraceparent = request.headers.get("traceparent") ?? undefined;
        // Reset the per-request read/cache capture (filled by `runCachedQuery`
        // for cached query paths) so a previous dispatch can't leak into this
        // entry's logged read set / cache-hit flag.
        this.currentRequestReadTables = undefined;
        this.currentRequestCacheHit = undefined;

        this.metrics.requests += 1;
        const dispatchStartedAt = Date.now();

        // Collect the tables this dispatch full-scans (stamped by the
        // ctx-db read hook) so `recordFunctionCall` can persist the causal
        // attribution. Fresh per request; drained below.
        this.currentScannedTables = new Set<string>();

        // Collect the declared indexes this dispatch exercises (stamped by
        // the ctx-db index-use hook) so `recordFunctionCall` can persist the
        // per-index hit counter behind the dead-index lint. Fresh per
        // request; drained below.
        this.currentIndexHits = new Set<string>();

        // Collect per-statement SQL samples from the instrumented `sql`
        // getter so `flushStmtSamples` can persist them to the durable
        // `__lunora_metrics_queries` table after the handler resolves.
        // Allocating a fresh array here activates the instrumentation (the
        // `sql` getter only wraps when this field is defined).
        this.currentStmtSamples = [];

        try {
            // Reserved cross-shard relation read/count (reverse cross-backend
            // relations). Served BEFORE user dispatch and returned BARE (row
            // array / number) — never `{ result }`-wrapped — so the Query
            // Coordinator's `concat`/`sum` merge composes the per-shard
            // values. Runs under the forwarded identity stashed above; the
            // worker refuses this prefix on a single-shard envelope, so it's
            // only reachable through the authorizeFanOut-gated fan-out path.
            if (payload.functionPath.startsWith(RELATION_FUNCTION_PREFIX)) {
                const value = await this.runRelationFanoutRead(payload.functionPath, payload.args ?? {});

                return jsonResponse(value, 200, bookmarkHeaders(this.currentResponseBookmark));
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
            const cached = this.readIdempotentResult(this.currentRequestMutationId);

            if (cached !== undefined) {
                return this.respondFromIdempotencyCache(payload.functionPath, dispatchStartedAt, mutatorClass, cached.value);
            }

            // Decode the wire codec (`bytes`/`bigint`/typed-array/±Infinity leaves)
            // ONLY for the handler, so `validateArgs` sees real `ArrayBuffer`/`bigint`
            // values. `payload.args` stays in wire form for the request log/metrics
            // below (JSON-safe — a raw `bigint` there would throw `JSON.stringify`).
            const result = await this.handleRpc(payload.functionPath, decodeWire(payload.args ?? {}) as Record<string, unknown>);

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

            this.recordRequestLog(payload.functionPath, payload.args ?? {}, durationMs, "ok", tablesWritten);

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
                this.recordFunctionCall(payload.functionPath, durationMs, message, this.currentScannedTables, this.currentIndexHits, conflicted);
            }
            // Flush statement samples even on error paths — partial sampling
            // is better than losing the timing signal entirely.
            this.flushStmtSamples();
            this.recordRequestLog(payload.functionPath, payload.args ?? {}, durationMs, "error", [...(this.pendingChangedTables ?? [])], message);
            this.logs.push({
                functionPath: payload.functionPath,
                level: "error",
                message,
                timestamp: Date.now(),
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
            this.currentRequestBookmark = undefined;
            this.currentResponseBookmark = undefined;
            this.currentRequestUserId = undefined;
            this.currentRequestMutationId = undefined;
            this.currentRequestClientId = undefined;
            this.currentRequestClientSeq = undefined;
            this.currentMutatorClass = undefined;
            this.mutationBookkeepingCommitted = false;
            this.currentRequestIdentity = undefined;
            this.currentRequestIp = undefined;
            this.currentRequestSystem = false;
            this.currentRequestTraceparent = undefined;
            this.currentScannedTables = undefined;
            this.currentIndexHits = undefined;
            this.currentRequestReadTables = undefined;
            this.currentRequestCacheHit = undefined;
            this.currentStmtSamples = undefined;
        }
    }

    /**
     * Hibernation API: invoked by the runtime when a message arrives on a
     * hibernated socket. Subclasses can override this to intercept; the
     * default decodes a {@link SubscriptionEnvelope} and updates the registry.
     */
    // eslint-disable-next-line sonarjs/cognitive-complexity -- Workers hibernation message router: the type/credential/route branching is the wire protocol and stays clearer inline than split across helpers sharing the socket + envelope
    public async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
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

        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        let envelope: SubscriptionEnvelope;

        try {
            envelope = JSON.parse(text) as SubscriptionEnvelope;
        } catch {
            ws.send(JSON.stringify({ message: "invalid envelope", type: "error" }));

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

            attachment.connected = true;

            try {
                (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
            } catch {
                // Over-large context can't be persisted; the hook still runs
                // with the supplied context this turn, but it won't survive
                // to disconnect. Never throw out of webSocketMessage.
            }

            await this.dispatchLifecycle("connect", this.lifecycleInfo(attachment));

            return;
        }

        if (envelope.type === "subscribe" && envelope.query) {
            const { functionPath } = envelope.query;
            const isAdmin = functionPath?.startsWith(ADMIN_FUNCTION_PREFIX) === true;

            // Admin introspection subscriptions read shard internals (raw rows,
            // metrics, logs), so they are gated by the same `LUNORA_ADMIN_TOKEN`
            // as the HTTP admin RPCs — recorded on the socket at upgrade. A
            // socket that only cleared the user-subscription gate must never be
            // able to read admin data by naming a reserved functionPath.
            if (isAdmin && this.readAttachment(ws).admin !== true) {
                ws.send(JSON.stringify({ id: envelope.id, message: "admin subscription requires admin authorization", type: "error" }));

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
                try {
                    ws.send(
                        JSON.stringify({
                            code: "BAD_SUBSCRIPTION_ARGS",
                            error: { code: "BAD_SUBSCRIPTION_ARGS", message: "subscription args failed wire decoding" },
                            id: envelope.id,
                            type: "error",
                        }),
                    );
                } catch {
                    // Socket may already be closed; never throw out of webSocketMessage.
                }

                return;
            }

            const status = this.subscribe(ws, envelope.id, query);

            if (status !== "ok") {
                const code = status === "too_many" ? "TOO_MANY_SUBSCRIPTIONS" : "SUBSCRIPTION_PERSIST_FAILED";
                const errorMessage =
                    status === "too_many"
                        ? `subscription cap of ${String(ShardDO.MAX_SUBSCRIPTIONS_PER_SOCKET)} reached on this socket`
                        : "failed to persist subscription attachment";

                try {
                    ws.send(JSON.stringify({ code, error: { code, message: errorMessage }, id: envelope.id, type: "error" }));
                } catch {
                    // Socket may already be closed; nothing else we can do —
                    // never let the webSocketMessage handler throw.
                }

                return;
            }

            ws.send(JSON.stringify({ id: envelope.id, type: "ack" }));

            // Seed the subscriber with the query's current result so the first
            // value arrives over the same channel as later updates. When the
            // subclass doesn't support re-execution (base default), this is a
            // no-op and the subscriber relies on its initial HTTP query.
            if (functionPath) {
                await this.seedSubscription(ws, envelope.id, query, functionPath, isAdmin);
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
                this.sendShapeSubscribeError(ws, envelope.id, "BAD_SUBSCRIPTION_ARGS", "shape args failed wire decoding");

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
            ws.send(JSON.stringify({ id: envelope.id, type: "ack" }));

            return;
        }

        if (envelope.type === "stream" && envelope.query?.functionPath) {
            // Streams are public-only: there is no admin-streaming surface, so
            // anything matching the admin prefix is rejected up front rather
            // than allowed to slip through executeStream().
            if (envelope.query.functionPath.startsWith(ADMIN_FUNCTION_PREFIX)) {
                ws.send(JSON.stringify({ id: envelope.id, message: "streams must be public", type: "error" }));

                return;
            }

            // Fire-and-forget: handleStream owns its own error reporting (it
            // sends `type:"error"` frames to the socket). The trailing no-op
            // catch only guards the rare pre-try throw path (e.g. ws.send on a
            // socket the runtime already tore down) so a dead socket can't
            // surface as an unhandled rejection.
            // Decode the wire-encoded stream args (bigint/bytes survive the WS hop)
            // before handing them to the stream handler — mirrors the `/rpc` path.
            this.handleStream(ws, envelope.id, envelope.query.functionPath, decodeWire(envelope.query.args ?? {}) as Record<string, unknown>).catch(() => {
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
            ws.send(JSON.stringify({ id: envelope.id, type: "ack" }));
        }
    }

    /**
     * Hibernation API: invoked on socket close. The runtime has already
     * closed the socket by the time we're called — calling `ws.close()`
     * again would throw "WebSocket has been closed" in the Workers runtime.
     */
    public async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
        // Fire `onDisconnect` lifecycle hooks the instant the socket drops —
        // replaying the identity + context recorded at connect — so presence and
        // other cleanup happen immediately, not after a TTL. Only a socket that
        // recorded a `connectionId` (went through the lifecycle-aware upgrade)
        // dispatches; the hooks run under the connecting user's identity.
        const attachment = this.readAttachment(ws);

        if (attachment.connectionId !== undefined) {
            await this.dispatchLifecycle("disconnect", this.lifecycleInfo(attachment));
        }

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

        // Drop the durable global-shape baselines for this socket too — leaving
        // them would orphan rows under a `connectionId` that can never reconnect
        // (a fresh upgrade mints a new id), slowly leaking the snapshot table.
        if (attachment.connectionId !== undefined) {
            try {
                deleteGlobalShapeSnapshotsForConnection(this.sql as SqlExec, attachment.connectionId);
            } catch {
                /* stub sql / missing table — nothing durable to clean up */
            }
        }

        // Clear the attachment so a future reconnection starts clean.
        (ws as HibernatableWebSocket).serializeAttachment?.(undefined);

        // Relay tier collapse (plan 075 Phase 2): a relay that just lost its last
        // socket detaches from its owner, so the owner stops forwarding to it.
        await this.relay?.announceDrain(ws);
    }

    /** Hibernation API: invoked on socket error. */
    // eslint-disable-next-line class-methods-use-this -- Workers hibernation handler: the platform invokes it on the instance; the signature must stay an instance method
    public webSocketError(_ws: WebSocket, _error: unknown): void {
        // Subclasses can override with proper logging. Avoid throwing.
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
        this.globalPollScheduled = false;

        let globalShapesRemaining: number;

        try {
            globalShapesRemaining = await this.pollGlobalShapes();
        } catch (error) {
            // `pollGlobalShapes` already contains per-socket/per-shape failures;
            // this guards a catastrophic failure (e.g. `getWebSockets` throwing)
            // so the poll heartbeat re-arms and retries next tick instead of
            // dying permanently and silently dropping every global subscriber.
            this.recordShapeError("shape:poll", error);
            globalShapesRemaining = 1;
        }

        // External-source (`.source(...)`) ingest shares this alarm (plan 077). The
        // base hook returns `undefined` (dormant); the codegen subclass overrides
        // it to materialize each sourced table and report the earliest NEXT-DUE
        // timestamp across every non-manual source. A contained failure re-arms
        // at the fixed floor (a conservative retry) rather than stranding the
        // ingest loop or spinning immediately.
        let nextSourceDueAt: number | undefined;

        try {
            nextSourceDueAt = await this.pollExternalSources();
        } catch (error) {
            this.recordShapeError("source:poll", error);
            nextSourceDueAt = Date.now() + ShardDO.GLOBAL_SHAPE_POLL_INTERVAL_MS;
        }

        // Drain the tables the ingest poll just wrote: a sourced table is local, so
        // its `defineShape` subscribers are poked through the standard
        // changed-table → `pokeShapeSubscribers` path (the same one a mutation
        // uses), NOT the global-shape poke path. Without this, materialized rows land
        // in SQLite but live subscribers never see the incremental update. A no-op
        // when nothing was queued (non-sourced DOs, or a steady-state tick).
        await this.flushChangedTables();

        const nextAlarmAt = ShardDO.nextPollAlarmTarget(globalShapesRemaining, nextSourceDueAt, Date.now());

        if (nextAlarmAt !== undefined) {
            await this.scheduleGlobalPoll(nextAlarmAt);
        }
    }

    /** Subclasses implement function dispatch. */
    public abstract handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown>;

    /**
     * The registered function paths to dispatch when a socket connects/disconnects.
     * Base default is empty; the codegen subclass overrides it to return the
     * generated lifecycle manifest keyed by `event`. Kept as a data hook (like
     * `tableRefs`/`rlsMetadata`) so the security-load-bearing dispatch — running
     * each hook under the verified identity + system dispatch — stays here in the
     * base and can't be mis-wired by generated code.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass returns the generated lifecycle manifest
    protected lifecycleHookPaths(_event: "connect" | "disconnect"): ReadonlyArray<string> {
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
     * call during a user RPC dispatch is timed and its result size captured into
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
        const rawSql = this.state.storage.sql;
        const samples = this.currentStmtSamples;

        // Only instrument during a live user dispatch.
        if (samples === undefined) {
            return rawSql;
        }

        const rawExec = (rawSql as { exec?: unknown }).exec;

        if (typeof rawExec !== "function") {
            return rawSql;
        }

        const instrumentedExec = (query: string, ...params: unknown[]): unknown => {
            const start = Date.now();
            const cursor = (rawExec as (...args: unknown[]) => unknown).call(rawSql, query, ...params);
            // We wrap `.toArray()` and `.one()` on the cursor to capture result
            // sizes synchronously without buffering the rows ourselves.

            if (cursor !== null && typeof cursor === "object") {
                const c = cursor as Record<string, unknown>;

                if (typeof c["toArray"] === "function") {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- intentional: binding a dynamic method from a cast cursor object
                    const originalToArray = c["toArray"].bind(c);

                    c["toArray"] = () => {
                        const rows = (originalToArray as () => unknown[])();
                        const durationMs = Date.now() - start;

                        samples.push([query, durationMs, rows.length, 0]);

                        return rows;
                    };
                }

                if (typeof c["one"] === "function") {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- intentional: binding a dynamic method from a cast cursor object
                    const originalOne = c["one"].bind(c);

                    c["one"] = () => {
                        const row = (originalOne as () => unknown)();
                        const durationMs = Date.now() - start;

                        samples.push([query, durationMs, 1, 0]);

                        return row;
                    };
                }

                // When neither `.toArray()` nor `.one()` will be called (e.g.
                // DDL / DML that the caller discards without iterating), record
                // a zero-rows sample immediately so the statement still appears
                // in the leaderboard. The `toArray`/`one` overrides above take
                // priority when they are used — they push their own samples and
                // the caller never reaches a point where this fallback fires
                // again for the same execution.
                if (typeof c["toArray"] !== "function" && typeof c["one"] !== "function") {
                    const durationMs = Date.now() - start;

                    samples.push([query, durationMs, 0, 0]);
                }
            } else {
                // Non-object return (shouldn't happen with workerd's SqlStorage
                // but guard defensively).
                const durationMs = Date.now() - start;

                samples.push([query, durationMs, 0, 0]);
            }

            return cursor;
        };

        // Return a structural proxy that looks like the real sql handle to the
        // callers that cast it to `SqlExec`, with our instrumented `exec`.
        return new Proxy(rawSql, {
            get(target, prop) {
                if (prop === "exec") {
                    return instrumentedExec;
                }

                // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- Reflect.get returns any; this is the standard proxy passthrough pattern
                return Reflect.get(target, prop, target);
            },
        });
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
     * in this transaction implicitly — drizzle and the BEGIN/COMMIT below
     * both write through the same `state.storage.sql` handle, so the tx
     * boundary is shared. Do **not** call `this.db.transaction(...)` from
     * inside a handler; that would attempt a nested SQLite transaction.
     *
     * Why raw BEGIN/COMMIT/ROLLBACK strings instead of `this.db.transaction(handler)`?
     * Two reasons, both verified against drizzle-orm 0.45.2's
     * `durable-sqlite/session.js`:
     *
     * 1. The DO driver does NOT issue BEGIN/COMMIT/ROLLBACK SQL — it
     * delegates to `state.storage.transactionSync(callback)`, the
     * DO platform's native transaction primitive. Swapping in
     * `db.transaction()` would silently change the wire-level
     * contract observed by tests and any tooling that intercepts
     * `storage.sql`.
     *
     * 2. `transactionSync` invokes the callback synchronously and does
     * not await its return value. Drizzle's `transaction()` matches
     * that — it passes the tx handle through and then returns.
     * Handing it an async handler would let the transaction commit
     * before the handler resolves, breaking the `() => Promise&lt;T> | T`
     * contract.
     *
     * The raw-SQL approach below is async-safe and gives the
     * connection-scoped semantics SQLite-in-DO is designed for.
     */
    protected async runInTransaction<T>(handler: () => Promise<T> | T): Promise<T> {
        if (this.transactionDepth > 0) {
            throw new LunoraError("NESTED_TRANSACTION", "nested transactions are not supported in SQLite-in-DO", { status: 500 });
        }

        const sqlHandle = this.state.storage.sql as TransactionSqlLike | undefined;

        if (!sqlHandle || typeof sqlHandle.exec !== "function") {
            throw new LunoraError("SQL_UNAVAILABLE", "storage.sql is not available on this ShardDO state", { status: 500 });
        }

        // workerd FORBIDS raw `BEGIN`/`COMMIT`/`SAVEPOINT` SQL inside a Durable
        // Object ("please use the state.storage.transaction() ... APIs instead")
        // — issuing them throws and fails every transactional mutation. Use the
        // platform primitive `state.storage.transaction(closure)`: it's atomic,
        // rolls back automatically when the closure throws, and is correctly
        // isolated from concurrent dispatch. (`transactionSync` is sync-only and
        // can't wrap our async handler; the async `transaction` can.) The
        // `storage.sql` guard above still ensures the handler's SQL has a
        // connection. Test doubles whose storage lacks `transaction` fall back to
        // a bare call — their fakes carry no transactional semantics anyway.
        const transactionalStorage = this.state.storage as undefined | { transaction?: <R>(closure: () => Promise<R>) => Promise<R> };

        const run = async (): Promise<T> => {
            this.transactionDepth = 1;

            try {
                if (typeof transactionalStorage?.transaction === "function") {
                    return await transactionalStorage.transaction(async () => handler());
                }

                return await handler();
            } finally {
                this.transactionDepth = 0;
            }
        };

        if (typeof this.state.blockConcurrencyWhile === "function") {
            return this.state.blockConcurrencyWhile(run);
        }

        // Test doubles may not supply `blockConcurrencyWhile`; fall through to
        // the bare path so existing unit tests keep working. Production state
        // always carries the gate.
        return run();
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
     * `ctx.flags.&lt;type>("key", …)` reads and evaluated through the configured
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
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected runShardWrite(args: RunShardWriteArgs): Promise<RunShardWriteResult> {
        return Promise.reject(new LunoraError("UNKNOWN_TABLE", `unknown table: ${args.table}`, { status: 404 }));
    }

    /**
     * Delete one row by primary key THROUGH the schema-aware writer — the
     * per-row seam {@link runShardBulkDelete} loops over. Routing each delete
     * through the writer (not raw SQL) is the whole point: it keeps the FTS /
     * aggregate / rank shadow tables in sync and fires `onDelete` cascades,
     * exactly like {@link runShardWrite}'s single-row delete.
     *
     * The base class can't build a writer without the user's `schema.ts`, so it
     * reports the table as unknown; the codegen-generated subclass overrides
     * this to call `writer.delete(id)` on a live `createShardCtxDb(...)` writer.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected deleteRowThroughWriter(_table: string, _id: string): Promise<void> {
        return Promise.reject(new LunoraError("UNKNOWN_TABLE", `unknown table: ${_table}`, { status: 404 }));
    }

    /**
     * Bulk-delete the rows of `table` matching the active `filters`/`search`
     * (or every row, for `clearTable`), bounded to {@link SHARD_BULK_DELETE_CAP}
     * per call. Concrete in the base: it collects the matching ids with the same
     * predicate {@link readTablePage} previews, then deletes them ONE AT A TIME
     * through {@link deleteRowThroughWriter} so the FTS / aggregate / rank shadow
     * tables stay correct. Returns `{ deleted, hasMore }` so the caller loops a
     * single bounded round-trip rather than deleting an unbounded set at once.
     *
     * Deletes are sequential by design — parallel writes to one DO would contend
     * on OCC — so the per-row `await` is intentional.
     */
    protected async runShardBulkDelete(args: RunShardBulkDeleteArgs): Promise<RunShardBulkDeleteResult> {
        const limit = Math.min(Math.max(Math.trunc(args.limit ?? SHARD_BULK_DELETE_CAP), 1), SHARD_BULK_DELETE_CAP);

        // Collect this batch's ids first (a read; raw SQL is fine), then remove
        // each through the writer. `hasMore` reflects whether matches remained
        // beyond `limit`, so the caller can loop to drain the rest.
        const { hasMore, ids } = selectMatchingIds(this.sql as SqlExec, {
            filters: args.filters,
            limit,
            search: args.search,
            table: args.table,
        });

        let deleted = 0;

        for (const id of ids) {
            // Sequential: serialise writes to avoid OCC contention on this DO.
            // eslint-disable-next-line no-await-in-loop -- per-row writer deletes must serialise to avoid OCC contention on the shard DO
            await this.deleteRowThroughWriter(args.table, id);
            deleted += 1;
        }

        return { deleted, hasMore };
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

        return readCdcChanges(sql, { limit: args.limit, sinceSeq: args.sinceSeq });
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
     * Decide whether a reconnecting subscription can resume from `sinceSeq`
     * without a full snapshot. Returns the current high-watermark `cursor` plus
     * a `resumable` verdict.
     *
     * `resumable: true` means `sinceSeq` is within the CDC retention window and
     * no table in the query's `readSet` changed in `(sinceSeq, cursor]` — the
     * client's cached value is still current, so the caller emits a lightweight
     * `resume` frame instead of re-shipping the snapshot.
     *
     * `resumable: false` means either the log was compacted past `sinceSeq` (a
     * retention gap), a read table changed (the client needs the fresh value),
     * or CDC is off — the caller falls back to the full-snapshot seed.
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
        // claiming to have seen MORE than the shard holds means the log rolled
        // back (e.g. a PITR restore) under a matching epoch — re-snapshot.
        if (sinceSeq > cursor) {
            return { cursor, epoch, resumable: false };
        }

        // Client already at the high-watermark: nothing newer exists, so it is
        // trivially current regardless of the read-set.
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

        if (floor === undefined || floor > sinceSeq + 1) {
            return { cursor, epoch, resumable: false };
        }

        // An empty read-set means we never recorded which tables the query
        // depends on (unknown deps), so we can't prove it was untouched — force
        // a full snapshot rather than resuming blindly on stale data.
        if (readSet.size === 0) {
            return { cursor, epoch, resumable: false };
        }

        // Resumable iff no table the query reads changed since `sinceSeq`. We
        // read the missed changes (bounded) and test intersection with the
        // read-set.
        const { changes } = readCdcChanges(sql, { limit: CDC_RESUME_SCAN_LIMIT, sinceSeq });

        // Cap hit: more than `CDC_RESUME_SCAN_LIMIT` changes accumulated since
        // `sinceSeq`, so a touching change may sit beyond the page we scanned.
        // We can't prove the read-set is untouched — force a full snapshot.
        if (changes.length >= CDC_RESUME_SCAN_LIMIT) {
            return { cursor, epoch, resumable: false };
        }

        const touchedReadSet = changes.some((change) => readSet.has(change.table));

        return { cursor, epoch, resumable: !touchedReadSet };
    }

    /**
     * Look up a previously-committed mutation for the in-flight request's
     * `(identity, mutationId)`. Returns `{ value }` (the cached, JSON-decoded
     * handler result) on a hit so the dispatch path can short-circuit, or
     * `undefined` when `mutationId` is absent (queries / legacy clients) or the
     * mutation has not run yet. Tolerates a stub `sql` handle without the dedup
     * table (returns a miss) so unit harnesses that skip migrations still work.
     * @returns the cached result box on a hit, or `undefined` for a miss or absent mutationId
     */
    protected readIdempotentResult(mutationId: string | undefined): { value: unknown } | undefined {
        if (mutationId === undefined) {
            return undefined;
        }

        try {
            const record = readIdempotent(this.sql as SqlExec, this.currentRequestUserId ?? "", mutationId);

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
     * legacy clients leave `currentRequestMutationId` undefined).
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
        if (this.currentRequestMutationId === undefined) {
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
            writeIdempotent(this.sql as SqlExec, this.currentRequestUserId ?? "", this.currentRequestMutationId, JSON.stringify(encodeWire(result)), now);

            // Throttled GC: drop dedup rows past the retention window at most once
            // per interval per warm instance.
            if (now - this.lastIdempotencyTrimAt > IDEMPOTENCY_GC_INTERVAL_MS) {
                trimIdempotent(this.sql as SqlExec, now - IDEMPOTENCY_RETENTION_MS);
                this.lastIdempotencyTrimAt = now;
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
     * Classify an in-flight custom-mutator push against the shard's stored
     * high-watermark for `currentRequestClientId`. The watermark is the highest
     * per-client sequence the DO has applied, so the push is exactly one of:
     *
     * - `"already"` — `seq &lt;= watermark`: a replay of a confirmed (or in-flight,
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
     * without the watermark. Sets {@link ShardDO.mutationBookkeepingCommitted} so
     * `fetch` skips the redundant post-dispatch persist.
     */
    protected commitMutationBookkeeping(result: unknown): void {
        this.persistIdempotentResult(result);

        // Strict: a watermark write that throws here rolls the whole mutation back
        // rather than committing writes whose watermark was never advanced.
        if (this.currentMutatorClass?.kind === "next") {
            this.advanceClientMutationWatermark({ strict: true });
        }

        this.mutationBookkeepingCommitted = true;
    }

    /**
     * Best-effort replay bookkeeping for the live dispatch path, run after
     * `handleRpc` returns. A generated mutation already committed it atomically
     * inside its transaction (via {@link ShardDO.commitMutationBookkeeping}, which
     * sets the flag), so this skips. Actions/queries aren't transaction-wrapped,
     * so they record their dedup row here (a no-op without an `x-lunora-mutation-id`),
     * and a `"next"` push advances its watermark (the gap self-heals on replay).
     */
    protected recordPostDispatchBookkeeping(result: unknown, mutatorClass: ClientMutationClass | undefined): void {
        if (this.mutationBookkeepingCommitted) {
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
     * Register a subscription on the given socket. Stored via
     * `ws.serializeAttachment` so it survives hibernation.
     *
     * Returns a status so the caller can surface a structured error frame
     * when the cap is hit or the attachment fails to serialize. We never
     * throw out of this path — the WS hibernation API treats a thrown
     * `webSocketMessage` as a fatal-channel error.
     */
    protected subscribe(ws: WebSocket, subId: string, query: SubscriptionQuery): "ok" | "serialize_failed" | "too_many" {
        const attachment = this.readAttachment(ws);

        if (Object.keys(attachment.subs).length >= ShardDO.MAX_SUBSCRIPTIONS_PER_SOCKET) {
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

    protected unsubscribe(ws: WebSocket, subId: string): void {
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
    protected shapeSubscribe(ws: WebSocket, subId: string, shape: ShapeSubscriptionQuery): "ok" | "serialize_failed" | "too_many" {
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
    protected shapeUnsubscribe(ws: WebSocket, subId: string): void {
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

        // Drop the durable baseline for this shape too (no-op for poke-live shapes
        // / connection-id-less sockets), so an unsubscribe doesn't leave a stale
        // snapshot a later resubscribe would diff against.
        if (attachment.connectionId !== undefined) {
            try {
                deleteGlobalShapeSnapshot(this.sql as SqlExec, attachment.connectionId, subId);
            } catch {
                /* stub sql / missing table — nothing durable to clean up */
            }
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
        const sockets = this.state.getWebSockets();
        // Pre-stringify the immutable portion. The only per-message variation
        // is `id`, which we splice in below — cheaper than calling
        // JSON.stringify(...) for every (socket, sub) pair.
        const deltaJson = JSON.stringify(delta);

        for (const ws of sockets) {
            const attachment = this.readAttachment(ws);

            for (const [subId, query] of Object.entries(attachment.subs)) {
                if (!this.matchesSubscription(query, delta)) {
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
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass implements the real Hyperdrive-backed poll
    protected pollExternalSources(): Promise<number | undefined> {
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

    /** This DO's shard key (its DO name), or `__root__` for the single-DO default. The `tenantBy` mapper binds it into the source query. */
    protected currentShardKey(): string {
        return this.state.id?.name ?? ROOT_SHARD_NAME;
    }

    /** Record a contained external-source ingest failure (one sourced table's poll) into the log ring without aborting the others. */
    protected recordExternalSourceError(table: string, error: unknown): void {
        this.recordShapeError(`source:${table}`, error);
    }

    /**
     * Look up a streaming-query function and return a thunk that produces the
     * `AsyncIterable&lt;unknown>` when handed an {@link AbortSignal}. The codegen
     * subclass overrides this to dispatch via `LUNORA_FUNCTIONS`; the base
     * default returns `null`, which surfaces as `{type:"error", code:"NOT_FOUND"}`
     * to the client.
     *
     * The deferred-iterator shape (`(signal) => AsyncIterable&lt;unknown>`) keeps
     * the cancel signal pluggable per-call without coupling this signature to
     * the wire-frame loop in `handleStream`.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to dispatch via the generated function map
    protected executeStream(_functionPath: string, _args: Record<string, unknown>): null | { iterator: (signal: AbortSignal) => AsyncIterable<unknown> } {
        // eslint-disable-next-line unicorn/no-null -- base default: `null` = "no such streaming function"; the codegen subclass overrides and also returns null
        return null;
    }

    /**
     * Wrap a query handler in the reactive cache. The subclass passes the
     * function path, parsed args, and a `run` callback that resolves to the
     * handler's return value. When the cache is configured we key by
     * `(functionPath, stable-stringified args)`, allocate a fresh dep
     * tracker, store it on `this.currentTracker` so `getCtxDbReadHook` reads
     * stamp into it, and restore the prior tracker in `finally`. When the
     * cache is absent we just call `run()` — same shape, zero overhead.
     *
     * Subclasses should ALSO pass `getCtxDbReadHook()` as the `onRead`
     * option on their `createShardCtxDb(...)` call so the tracker actually
     * collects deps. Without that wiring the cache will memoize results
     * with empty dep sets, so writes never invalidate them and stale
     * results stick around — the {@link ReactiveCache} class is contract-
     * neutral about who fills `deps`.
     */
    protected async runCachedQuery<R>(functionPath: string, args: Record<string, unknown>, run: () => Promise<R>): Promise<R> {
        if (!this.reactiveCache) {
            return run();
        }

        // Snapshot the in-flight tracker BEFORE allocating a fresh one, so
        // the `finally` restores it correctly. The previous implementation
        // allocated inside `reactiveCache.run(...)` before capturing
        // `previous` in a separate `withTracker` helper, so `previous`
        // captured the just-allocated tracker and the leftover never got
        // cleared — a stray read between requests would land in the wrong
        // dep set and corrupt the next cache miss.
        const previous = this.currentTracker;
        const tracker = createDependencyTracker();

        this.currentTracker = tracker;

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

        try {
            const result = await this.reactiveCache.run(reactiveCacheKey(functionPath, args, identity), tracker.collect(), run);

            this.currentRequestCacheHit = this.reactiveCache.stats().hits > hitsBefore;
            this.currentRequestReadTables = tablesFromDeps(tracker.collect());

            return result;
        } finally {
            this.currentTracker = previous;
        }
    }

    /**
     * Returns an `onRead` callback suitable to hand to `createShardCtxDb`'s
     * `onRead` option. The returned function stamps the in-flight tracker (set
     * by `runCachedQuery`) when one exists and is a no-op otherwise — so
     * subclasses can wire this hook unconditionally without checking whether
     * the cache is enabled.
     *
     * It ALSO records the table into {@link currentScannedTables} whenever the
     * read was a full-table scan (the `SCAN_DEP` sentinel). That set is drained
     * into `recordFunctionCall` after dispatch to build the durable per-function
     * full-scan attribution — and unlike the tracker, it's collected even when
     * the reactive cache is off, since the causal signal is independent of
     * caching.
     */
    protected getCtxDbReadHook(): (table: string, idOrScan?: string) => void {
        return (table, idOrScan) => {
            this.currentTracker?.recordRead(table, idOrScan ?? SCAN_DEP);

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
     * Record that `table` was written during the current RPC. Wired into the
     * db adapter's `broadcast` callback by the generated subclass so that
     * `flushChangedTables` can re-run only the affected subscriptions.
     */
    protected recordChangedTable(table: string): void {
        this.pendingChangedTables ??= new Set<string>();
        this.pendingChangedTables.add(table);
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
        sink?: LogSink,
    ): void {
        // Correlate the line to its dispatch span from the inbound `traceparent`
        // the runtime forwarded — `traceId` is the trace, `parentSpanId` the RPC
        // server span. Absent on paths with no inbound trace context.
        const trace = parseTraceparent(this.getCurrentTraceparent());

        // One canonical event built once, fed to all three destinations. Only the
        // console event drops raw `args` (see emitLogEvent); the buffer and sink
        // get the full payload. Structured `fields` DO ride every destination.
        const event: LogEventInput = {
            args,
            fields,
            functionPath,
            level,
            message,
            shardKey: this.state.id?.name,
            spanId: trace?.parentSpanId,
            traceId: trace?.traceId,
            ts: Date.now(),
            userId: this.getCurrentUserId(),
        };

        this.logs.push({ fields, functionPath, level: BUFFER_LEVEL[level], message, timestamp: event.ts });

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
                sink.onLog(event, { waitUntil: this.state.waitUntil?.bind(this.state) });
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
    protected makeLogger(functionPath: string, sink?: LogSink, boundFields?: Record<string, unknown>): CtxLogger {
        const emit = (level: ContextLogLevel, args: unknown[]): void => {
            const { fields, message } = parseLogArgs(args, boundFields);

            this.recordUserLog(functionPath, level, args, message, fields, sink);
        };

        return {
            debug: (...args: unknown[]) => emit("debug", args),
            error: (...args: unknown[]) => emit("error", args),
            fatal: (...args: unknown[]) => emit("fatal", args),
            info: (...args: unknown[]) => emit("info", args),
            log: (...args: unknown[]) => emit("log", args),
            trace: (...args: unknown[]) => emit("trace", args),
            warn: (...args: unknown[]) => emit("warn", args),
            with: (fields: Record<string, unknown>) => this.makeLogger(functionPath, sink, boundFields ? { ...boundFields, ...fields } : fields),
        };
    }

    /**
     * Assemble the per-socket {@link LifecycleDispatchInfo} from its attachment:
     * the verified identity to replay and the {@link LifecycleEvent} the hooks
     * receive as their argument. `shardKey` is this DO's shard name.
     */
    private lifecycleInfo(attachment: SocketAttachment): LifecycleDispatchInfo {
        const event: LifecycleEvent = {
            connectionId: attachment.connectionId ?? "",
            shardKey: this.state.id?.name ?? ROOT_SHARD_NAME,
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
     */
    private collectMetrics(): {
        cache: null | { bytes: number; entries: number; evictions: number; hits: number; misses: number };
        databaseSize: null | number;
        errors: number;
        functions: FunctionCallStat[];
        history: (FunctionMetricBucket & { path: string })[];
        indexHits: FunctionMetricIndexHit[];
        queryStats: QueryStatEntry[];
        requests: number;
        shard: string;
        sinceMs: number;
        uptimeMs: number;
    } {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- structural state: a test double may omit `storage.sql` even though the type marks it required
        const size = this.state.storage.sql?.databaseSize;

        // Durable totals are the source of truth; fall back to the in-memory
        // counters only if the persisted read is unavailable.
        let { requests } = this.metrics;
        let { errors } = this.metrics;

        try {
            const totals = readFunctionMetricsTotals(this.state.storage.sql as unknown as SqlExec);

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
            indexHits = readFunctionMetricIndexHits(this.state.storage.sql as unknown as SqlExec);
        } catch {
            // No durable index-hit table yet — report an empty feed.
        }

        // Per-statement query aggregates for the slow-query leaderboard.
        // Best-effort: a missing/unmigrated sql handle yields an empty feed
        // rather than failing the metrics read.
        let queryStats: QueryStatEntry[] = [];

        try {
            queryStats = readQueryMetrics(this.state.storage.sql as unknown as SqlExec);
        } catch {
            // No durable query-metrics table yet — report an empty feed.
        }

        return {
            // eslint-disable-next-line unicorn/no-null -- metrics wire shape: `cache` is `null | {...}`, null reported when the reactive cache is disabled
            cache: this.reactiveCache ? this.reactiveCache.stats() : null,
            // eslint-disable-next-line unicorn/no-null -- metrics wire shape: `databaseSize` is `null | number`, null when the runtime doesn't expose a size
            databaseSize: typeof size === "number" ? size : null,
            errors,
            functions: this.collectFunctionStats().functions,
            history: this.collectFunctionMetricBuckets(),
            indexHits,
            queryStats,
            requests,
            shard: this.state.id?.name ?? ROOT_SHARD_NAME,
            sinceMs: this.metrics.sinceMs,
            uptimeMs: Date.now() - this.metrics.sinceMs,
        };
    }

    /**
     * Fold one dispatch into the per-function counters keyed by `functionPath`,
     * creating the entry on first sight. `errorMessage` is supplied only when
     * the handler threw, in which case the failure counters advance too.
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
            recordFunctionMetric(this.state.storage.sql as unknown as SqlExec, {
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
            this.functionStats.set(functionPath, stat);
        }
    }

    /**
     * Flush per-statement SQL samples accumulated during the current dispatch
     * into the durable `__lunora_metrics_queries` table. Called after
     * `recordFunctionCall` on both the success and error paths.
     *
     * Best-effort: a SQL failure (e.g. a test double without a usable `sql`
     * handle) must never fail the response, so every call is swallowed.
     * Clearing `currentStmtSamples` happens in the `finally` block of the
     * dispatch path, not here, so a partial flush (partial error) still
     * drains the correct slice.
     */
    private flushStmtSamples(): void {
        const samples = this.currentStmtSamples;

        if (!samples || samples.length === 0) {
            return;
        }

        try {
            const sqlHandle = this.state.storage.sql as unknown as SqlExec;

            for (const [rawSql, durationMs, rowsRead, rowsWritten] of samples) {
                try {
                    recordQueryMetric(sqlHandle, rawSql, durationMs, rowsRead, rowsWritten);
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
            const functions = readFunctionMetrics(this.state.storage.sql as unknown as SqlExec);

            return { functions, sinceMs: this.metrics.sinceMs };
        } catch {
            const functions = [...this.functionStats.values()].toSorted((a, b) => b.lastCalledAt - a.lastCalledAt);

            return { functions, sinceMs: this.metrics.sinceMs };
        }
    }

    /**
     * Per-function coarse time-series served additively by the metrics RPC, so
     * the studio can chart call/error history. Reads the durable
     * `__lunora_metrics_buckets` table; returns `[]` when persistence is
     * unavailable so the response stays well-formed.
     */
    private collectFunctionMetricBuckets(): (FunctionMetricBucket & { path: string })[] {
        try {
            return readFunctionMetricBuckets(this.state.storage.sql as unknown as SqlExec);
        } catch {
            return [];
        }
    }

    private maybeWarnRootSize(): void {
        if (ShardDO.rootSizeWarned) {
            return;
        }

        const idName = this.state.id?.name;

        if (idName !== ROOT_SHARD_NAME) {
            return;
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- structural state: a test double may omit `storage.sql` even though the type marks it required
        const size = this.state.storage.sql?.databaseSize;

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
     * Serve a reserved admin-introspection RPC (`__lunora_admin__:*`) for the
     * data browser. Gated by `env.LUNORA_ADMIN_TOKEN`: introspection is
     * **disabled unless the token is configured**, and when it is, the request
     * must present a matching `Authorization: Bearer` header. The blast radius
     * is raw table contents, so the default is closed — unlike the WebSocket
     * upgrade gate, which defaults open for local dev.
     */
    private async handleAdminRpc(request: Request, functionPath: string, args: Record<string, unknown>): Promise<Response> {
        if (!this.isAdminAuthorized(request)) {
            return jsonResponse({ error: { code: "ADMIN_FORBIDDEN", message: "admin introspection is disabled or the bearer token is invalid" } }, 403);
        }

        try {
            // Read-only introspection ops share their logic with the WS
            // subscription bridge (see readAdminOp / executeAdminSubscription),
            // so a live subscriber and a one-shot POST observe the same shape.
            const read = this.readAdminOp(functionPath, args);

            if (read) {
                return jsonResponse({ result: read.result }, 200);
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

                return jsonResponse({ result }, 200);
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

                return jsonResponse({ result: { rows } }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.importShard) {
                const parsed = parseImportShardArgs(args);
                const result = await this.runShardImport({ rows: parsed.rows, startLine: parsed.startLine });

                // The import inserts rows through the writer, which records
                // touched tables; flush so live subscribers re-run.
                await this.flushChangedTables();

                this.recordAudit("importShard", { detail: { conflicts: result.conflicts, errors: result.errors.length, inserted: result.inserted } });

                return jsonResponse({ result }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.writeRow) {
                const parsed = parseWriteRowArgs(args);
                const result = await this.runShardWrite(parsed);

                // The write went through the writer, which records the touched
                // table; flush so live subscribers re-run against the new value.
                await this.flushChangedTables();

                this.recordAudit("writeRow", { table: parsed.table, id: result.id ?? parsed.id, detail: { op: result.op } });

                return jsonResponse({ result }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.deleteRows) {
                const parsed = parseBulkDeleteArgs(args);
                const result = await this.runShardBulkDelete(parsed);

                // Every row was removed through the writer, which records each
                // touched table; flush so live subscribers re-run against the
                // shrunken set.
                await this.flushChangedTables();

                this.recordAudit("deleteRows", { table: parsed.table, detail: { deleted: result.deleted, hasMore: result.hasMore } });

                return jsonResponse({ result }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.clearTable) {
                const parsed = parseClearTableArgs(args);

                // `clearTable` is `deleteRows` with no predicate — the same
                // writer-routed bounded loop, matching every row.
                const result = await this.runShardBulkDelete(parsed);

                await this.flushChangedTables();

                this.recordAudit("clearTable", { table: parsed.table, detail: { deleted: result.deleted, hasMore: result.hasMore } });

                return jsonResponse({ result }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.rankBefore) {
                // Read-only: counts rows preceding `rowId` in the partition. No
                // writer mutation, so nothing to flush — the cross-shard
                // coordinator sums the `{before, total}` from every shard.
                const result = await this.runShardRankBefore(parseRankBeforeArgs(args));

                return jsonResponse({ result }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.rankPage) {
                // Read-only: this shard's local ranked slice, each row tagged
                // with its rank-key tuple. No writer mutation, so nothing to
                // flush — the cross-shard coordinator k-way merges the
                // `{ rows, hasMore }` slices from every shard into one page.
                const result = await this.runShardRankPage(parseRankPageArgs(args));

                return jsonResponse({ result }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.cdcSync) {
                // Read-only: page this shard's change-data-capture log past the
                // caller's per-shard cursor. The coordinator collects each
                // shard's `{ changes, cursor }` into one streaming-export batch.
                const result = this.runShardCdcSync(parseCdcSyncArgs(args));

                return jsonResponse({ result }, 200);
            }

            if (functionPath === ADMIN_FUNCTIONS.applyCdc) {
                // Replay a CDC batch into this shard (point-in-time recovery).
                // The writer mutates rows, so flush touched tables afterward.
                const result = await this.runShardApplyCdc(parseApplyCdcArgs(args));

                await this.flushChangedTables();

                this.recordAudit("applyCdc", { detail: { applied: result.applied } });

                return jsonResponse({ result }, 200);
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
     * doesn't handle inline: the auth-event + mail-capture writes and the native
     * PITR ops. Returns the op's `Response`, or `undefined` when `functionPath`
     * isn't one of these (so the caller answers 404). Kept out of
     * `handleAdminRpc` to hold that dispatcher under the complexity budget,
     * mirroring `handlePitrAdminOp`.
     */
    private async handleExtraAdminOp(functionPath: string, args: Record<string, unknown>): Promise<Response | undefined> {
        if (functionPath === ADMIN_FUNCTIONS.recordAuthEvent) {
            return this.handleRecordAuthEvent(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.recordContainerEvent) {
            return this.handleRecordContainerEvent(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.recordMail) {
            return this.handleRecordMail(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.clearCapturedMail) {
            return this.handleClearCapturedMail();
        }

        if (functionPath === ADMIN_FUNCTIONS.sendTestMail) {
            return this.handleSendTestMail(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.recordQueueMessage) {
            return this.handleRecordQueueMessage(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.clearQueueMessages) {
            return this.handleClearQueueMessages();
        }

        if (functionPath === ADMIN_FUNCTIONS.sendQueueMessage) {
            return this.handleSendQueueMessage(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.replayQueueMessage) {
            return this.handleReplayQueueMessage(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.createWorkflowInstance) {
            return this.handleCreateWorkflowInstance(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.getWorkflowInstanceStatus) {
            return this.handleGetWorkflowInstanceStatus(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.listFlags) {
            return this.handleListFlags(args);
        }

        return this.handlePitrAdminOp(functionPath, args);
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
            recordAuthEvent(this.state.storage.sql as unknown as SqlExec, { outcome: parsed.outcome, ts: Date.now() });
        } catch {
            // Best-effort: a metrics write must never fail the call.
        }

        return jsonResponse({ result: { recorded: true } }, 200);
    }

    /**
     * Append one container lifecycle event to the in-memory {@link LogBuffer}
     * the `getLogs` admin RPC reads, so a start/stop/error on a Container DO
     * surfaces in the Studio Logs panel — not just the dev terminal. The
     * Container DO pushes this best-effort (its `console` print stays the source
     * of truth), so a missing/garbage envelope is rejected up front (400) rather
     * than corrupting the buffer. Mapped to `functionPath: "container:&lt;name>"` so
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
                shardKey: this.state.id?.name,
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

        return jsonResponse({ result: { recorded: true } }, 200);
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
     * The studio only surfaces this tool behind a loopback-dev gate.
     */
    private async handleRunAs(args: Record<string, unknown>): Promise<Response> {
        const parsed = parseRunAsArgs(args);

        const result = await this.withRequestIdentity(parsed.userId, parsed.identity, () => this.handleRpc(parsed.functionPath, parsed.args));

        // The forged dispatch may have written through the writer (a mutation run
        // as the user); flush touched tables so live subscribers re-run, matching
        // the normal `/rpc` dispatch path.
        await this.flushChangedTables();

        this.recordAudit("runAs", { detail: { functionPath: parsed.functionPath, runAsUserId: parsed.userId } });

        return jsonResponse({ result }, 200);
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

        return jsonResponse({ result }, 200);
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

        return jsonResponse({ result }, 200);
    }
    /* eslint-enable no-secrets/no-secrets */

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

        return jsonResponse({ result }, 200);
    }

    /**
     * Run `run()` with the per-request identity pinned to (`userId`, `identity`),
     * then restore the prior values in a `finally` (even if `run()` throws), so the
     * forced identity can never leak into a later dispatch on this DO instance. The
     * generated `buildCtx` reads identity via `getCurrentUserId`/`getCurrentIdentity`,
     * so pinning the fields around the call makes the dispatched function observe the
     * chosen identity without threading it through the generated signature.
     *
     * The single caller is {@link handleRunAs} (pins a forged user — the dev
     * "Run as identity" tool), which runs synchronously on the request thread
     * with no intervening concurrent dispatch. Subscriptions deliberately do NOT
     * use this primitive: they run in deferred/interleaved contexts where
     * mutating the shared field would race a concurrent RPC, so they thread an
     * explicit {@link SubscriptionIdentity} into `executeSubscription` instead.
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
        const result = recordCapturedMail(this.state.storage.sql as unknown as SqlExec, parsed, Date.now());

        return jsonResponse({ result }, 200);
    }

    /** Empty the dev mail-catcher inbox (studio "clear inbox" action). Admin-gated by the caller. */
    private handleClearCapturedMail(): Response {
        const result = clearCapturedMail(this.state.storage.sql as unknown as SqlExec);

        return jsonResponse({ result }, 200);
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
        const result = recordCapturedMail(this.state.storage.sql as unknown as SqlExec, input, Date.now());

        return jsonResponse({ result }, 200);
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
        const result = recordQueueMessages(this.state.storage.sql as unknown as SqlExec, messages, Date.now());

        return jsonResponse({ result }, 200);
    }

    /** Empty the dev queue consumed-message log (studio "clear log" action). Admin-gated by the caller. */
    private handleClearQueueMessages(): Response {
        const result = clearQueueMessages(this.state.storage.sql as unknown as SqlExec);

        return jsonResponse({ result }, 200);
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

        return jsonResponse({ result: { sent } }, 200);
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
        const row = readQueueMessageById(this.state.storage.sql as unknown as SqlExec, parsed.id);

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

        return jsonResponse({ result: { sent: 1, target } }, 200);
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
        const sql = this.state.storage.sql as unknown as SqlExec;
        const userId = this.getCurrentUserId();
        const detail = userId === undefined ? fields.detail : { ...fields.detail, userId };

        appendAuditEntry(sql, { detail, id: fields.id, op, table: fields.table, ts: Date.now() });
    }

    /**
     * Append one structured entry to the durable request log (`request-log.ts`)
     * for a `/rpc` dispatch that just completed — the per-request readout
     * (`&lt;file>:&lt;function>`, shard key, acting user/identity, redacted args,
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
     * `tablesRead` and `cacheHit` are captured by `runCachedQuery`, so they are
     * present only for cached query paths — a write/action doesn't run through
     * the cache, and an instance with the reactive cache disabled never captures
     * them — and are left empty/`undefined` rather than recomputed here.
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
            cacheHit: this.currentRequestCacheHit,
            durationMs,
            errorMessage,
            functionPath,
            identity: this.currentRequestIdentity,
            outcome,
            redactedArgs: Object.keys(args).length === 0 ? undefined : args,
            shardKey: this.state.id?.name,
            tablesRead: this.currentRequestReadTables === undefined ? [] : [...this.currentRequestReadTables],
            tablesWritten,
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
            appendRequestLogEntry(this.state.storage.sql as unknown as SqlExec, entry, writeOptions);
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
            return jsonResponse({ result: await readBookmark(this.state.storage, time) }, 200);
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
        // proactive half (it takes effect immediately, before any `restart`);
        // the native restore itself reverts SQLite — including this epoch row —
        // so the post-restore safety net is `evaluateResume`'s `sinceSeq >
        // cursor` rollback guard. Best-effort: `cdcEnabled()` is false on a stub
        // `sql` handle or a pre-CDC shard, so the bump simply no-ops there.
        if (this.cdcEnabled()) {
            bumpCdcEpoch(this.sql as SqlExec);
        }

        this.recordAudit("pitrRestore", { detail: { restart, restoredTo: armed.restoredTo, undoBookmark: armed.undoBookmark } });

        const response = jsonResponse({ result: { ...armed, restarted: restart } }, 200);

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

        const sql = this.state.storage.sql as unknown as SqlExec;

        // The wildcard-bound counter/config reads aren't tied to a single table,
        // so they share one branch and the {@link ADMIN_WILDCARD} sentinel; a
        // live subscription on any of them re-runs on every write-flush (the
        // per-socket JSON memo still suppresses byte-identical pushes).
        const wildcardRead = this.readAdminWildcardOp(functionPath);

        if (wildcardRead !== undefined) {
            return { result: wildcardRead, tables: new Set([ADMIN_WILDCARD]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.getAuditLog) {
            return this.readAdminAuditLog(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.getRequestLog) {
            return this.readAdminRequestLog(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.getIssues) {
            return this.readAdminIssues(sql, args);
        }

        const durable = this.readAdminDurableSignal(functionPath, sql, args);

        if (durable) {
            return durable;
        }

        if (functionPath === ADMIN_FUNCTIONS.readTablePage) {
            return this.readAdminTablePage(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.facetColumn) {
            return this.readAdminFacetColumn(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.runSql) {
            return this.readAdminRunSql(sql, args);
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
     * (the migration ledger). The first two carry their `table` (or the
     * {@link ADMIN_WILDCARD} sentinel when unscoped); `migrationStatus` is
     * deployment-wide, so it always carries the wildcard. Returns `undefined` for
     * any other path so {@link readAdminOp} falls through; folded into one helper
     * to keep that dispatcher under its complexity budget.
     * @returns the read result and its table-dependency set, or `undefined` when the path is not owned by this resolver
     */
    private readAdminTableSignal(functionPath: string, sql: SqlExec, args: Record<string, unknown>): undefined | { result: unknown; tables: Set<string> } {
        if (functionPath === ADMIN_FUNCTIONS.listTableIndexes || functionPath === ADMIN_FUNCTIONS.describeTable) {
            const table = typeof args["table"] === "string" ? args["table"] : "";
            const result = functionPath === ADMIN_FUNCTIONS.describeTable ? { columns: this.tableColumns(table) } : { indexes: this.tableIndexes(table) };

            return { result, tables: new Set([table === "" ? ADMIN_WILDCARD : table]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.describeTables) {
            const requested = Array.isArray(args["tables"]) ? args["tables"].filter((table): table is string => typeof table === "string") : [];
            const columnsByTable: Record<string, ColumnMeta[]> = Object.fromEntries(requested.map((table) => [table, this.tableColumns(table)]));

            return { result: { columnsByTable }, tables: new Set(requested.length === 0 ? [ADMIN_WILDCARD] : requested) };
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
            return this.readAdminStorageReferences(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.storageOrphans) {
            return this.readAdminStorageOrphans(sql, args);
        }

        return undefined;
    }

    /**
     * Resolve a `storageReferences` admin read — the file browser's records↔files
     * join: given the object keys on the page, return the rows that reference each
     * (via a `v.storage()` column) plus the schema's declared storage columns.
     * Scans only those columns through {@link findStorageReferences}. Carries the
     * {@link ADMIN_WILDCARD} (it spans every storage table) so a live subscription
     * re-runs on any write.
     */
    private readAdminStorageReferences(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        const keys = Array.isArray(args["keys"]) ? args["keys"].filter((key): key is string => typeof key === "string") : [];

        return { result: findStorageReferences(sql, this.storageColumns(), keys), tables: new Set([ADMIN_WILDCARD]) };
    }

    /**
     * Resolve a `storageOrphans` admin read — the inverse of the records↔files
     * join: given the set of object keys that actually exist in the bucket
     * (`liveKeys`, the studio's enumerated listing), return every record
     * `v.storage()` field whose value points at a key the bucket DOES NOT have — a
     * **dangling reference**. CF's R2 browser can never make this join. Scans only
     * the schema's declared storage columns through {@link findDanglingReferences},
     * bounded with a `truncated` flag (logged once when set). Carries the
     * {@link ADMIN_WILDCARD} (it spans every storage table) so a live subscription
     * re-runs on any write.
     */
    private readAdminStorageOrphans(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        const liveKeys = Array.isArray(args["liveKeys"]) ? args["liveKeys"].filter((key): key is string => typeof key === "string") : [];
        const result = findDanglingReferences(sql, this.storageColumns(), liveKeys);

        if (result.truncated) {
            // eslint-disable-next-line no-console -- intentional operational notice: the dangling-reference scan was clipped by its bound, so the studio's view is partial
            console.warn(
                `[@lunora/do] storageOrphans scan truncated after checking ${String(result.scanned)} storage references; reporting the first ${String(result.references.length)} dangling reference(s).`,
            );
        }

        return { result, tables: new Set([ADMIN_WILDCARD]) };
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
    private readAdminWildcardOp(functionPath: string): unknown {
        if (functionPath === ADMIN_FUNCTIONS.listTables) {
            return listTables(this.state.storage.sql as unknown as SqlExec);
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
            return { entries: this.logs.entries() };
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
            return buildSecurityAudit(this.env);
        }

        if (functionPath === ADMIN_FUNCTIONS.getAdvisories) {
            // Static schema advisories (codegen-emitted, via `advisories()`) plus
            // runtime ones derived from observed signal (`unused_index`).
            // Deployment-wide, so it carries the wildcard like the other reads.
            return { advisories: [...this.advisories(), ...this.runtimeAdvisories()] };
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
        return summarizeSubscriptions(this.state.getWebSockets().map((ws) => this.readAttachment(ws)));
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
        const summary = summarizeFanoutTopics(this.state.getWebSockets().map((ws) => this.readAttachment(ws)));
        const relayCount = this.relay?.relayCount() ?? 0;

        return {
            ...summary,
            maxRelays: this.relay?.maxRelays() ?? DEFAULT_MAX_RELAYS,
            promoted: relayCount > 0,
            relayCount,
            shapePoke: this.fanout.shapePoke,
            sinceMs: this.metrics.sinceMs,
            whisper: this.fanout.whisper,
        };
    }

    /** Resolve a `getAuditLog` admin read, parsing the optional `limit`/`sinceSeq` cursor args and ensuring the reserved table first. */
    // eslint-disable-next-line class-methods-use-this -- kept an instance method for symmetry with the other `readAdmin*` resolvers and future per-instance state
    private readAdminAuditLog(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        // Defensive: the table may not exist yet on a shard that has never
        // recorded an admin op, so ensure it before the read.
        ensureAuditTable(sql);

        const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
        const sinceSeq = typeof args["sinceSeq"] === "number" ? args["sinceSeq"] : undefined;
        const result: AuditLogResult = { entries: readAuditLog(sql, { limit, sinceSeq }) };

        return { result, tables: new Set([ADMIN_WILDCARD]) };
    }

    /**
     * Resolve a `getRequestLog` admin read, parsing the optional correlation
     * filters (function-path prefix, exact userId/shardKey/outcome, table-touched)
     * plus the `limit`/`sinceSeq` cursor, and ensuring the reserved table first.
     * Carries the {@link ADMIN_WILDCARD} like the other log reads so a live Logs
     * subscription re-runs on every write-flush (the per-socket JSON memo still
     * suppresses byte-identical pushes).
     */
    // eslint-disable-next-line class-methods-use-this -- kept an instance method for symmetry with the other `readAdmin*` resolvers and future per-instance state
    private readAdminRequestLog(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        // Defensive: the table may not exist yet on a shard that has never
        // served a logged dispatch, so ensure it before the read.
        ensureRequestLogTable(sql);

        const outcome = args["outcome"] === "ok" || args["outcome"] === "error" ? args["outcome"] : undefined;
        const result: RequestLogResult = {
            entries: readRequestLog(sql, {
                functionPathPrefix: typeof args["functionPathPrefix"] === "string" ? args["functionPathPrefix"] : undefined,
                limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
                outcome,
                shardKey: typeof args["shardKey"] === "string" ? args["shardKey"] : undefined,
                sinceSeq: typeof args["sinceSeq"] === "number" ? args["sinceSeq"] : undefined,
                tableTouched: typeof args["tableTouched"] === "string" ? args["tableTouched"] : undefined,
                userId: typeof args["userId"] === "string" ? args["userId"] : undefined,
            }),
        };

        return { result, tables: new Set([ADMIN_WILDCARD]) };
    }

    /**
     * Resolve a `getIssues` admin read: fold the recent `error`-outcome
     * request-log rows into grouped {@link readErrorIssues Issues} by fingerprint,
     * accepting the same optional correlation filters as `getRequestLog`
     * (function-path prefix, exact shardKey/userId) plus a `limit` on rows
     * scanned. This is a read over the bounded reqlog readout — no new store —
     * so a self-hosted worker gets grouped error triage for free. Carries the
     * {@link ADMIN_WILDCARD} like the other log reads so a live Issues
     * subscription re-runs on every write-flush (the per-socket JSON memo still
     * suppresses byte-identical pushes).
     */
    // eslint-disable-next-line class-methods-use-this -- kept an instance method for symmetry with the other `readAdmin*` resolvers
    private readAdminIssues(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        // Defensive: the reqlog table may not exist yet on a shard that has never
        // served a logged dispatch, so ensure it before the read.
        ensureRequestLogTable(sql);

        const result: IssuesResult = {
            issues: readErrorIssues(sql, {
                functionPathPrefix: typeof args["functionPathPrefix"] === "string" ? args["functionPathPrefix"] : undefined,
                limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
                shardKey: typeof args["shardKey"] === "string" ? args["shardKey"] : undefined,
                userId: typeof args["userId"] === "string" ? args["userId"] : undefined,
            }),
        };

        return { result, tables: new Set([ADMIN_WILDCARD]) };
    }

    /**
     * Resolve a `getAuthMetrics` admin read: the durable app-level auth
     * attempt/failure counters + minute-bucketed history the studio SLO panel
     * charts (PLAN3 §2.3). Auth runs as a top-level `/api/auth/*` worker route,
     * NOT through lunora functions, so the worker records each attempt against
     * the root shard via `recordAuthEvent` and this read surfaces the rollup.
     *
     * Best-effort: a SQL failure (e.g. a test double without a real `sql`
     * handle) returns an empty all-zero {@link AuthMetrics} rather than throwing,
     * so the SLO signal is simply absent instead of breaking the studio.
     * Carries the {@link ADMIN_WILDCARD} like the other counter reads so a live
     * subscription re-runs on every write-flush (the per-socket JSON memo still
     * suppresses byte-identical pushes).
     */

    /**
     * Resolve the durable app-signal reads that aren't bound to a user table —
     * the auth-metrics rollup and the dev mail-catcher inbox. Returns the read's
     * `{ result, tables }`, or `undefined` for any path it doesn't own (so
     * `readAdminOp` falls through). Keeps `readAdminOp` under its complexity
     * budget by holding these two in one branch.
     * @returns the read result and its table-dependency set, or `undefined` when the path is not owned by this resolver
     */
    private readAdminDurableSignal(functionPath: string, sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } | undefined {
        if (functionPath === ADMIN_FUNCTIONS.getAuthMetrics) {
            return this.readAdminAuthMetrics(sql);
        }

        if (functionPath === ADMIN_FUNCTIONS.getCapturedMail) {
            return this.readAdminCapturedMail(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.getQueueMessages) {
            return this.readAdminQueueMessages(sql, args);
        }

        return undefined;
    }

    // eslint-disable-next-line class-methods-use-this -- kept an instance method for symmetry with the other `readAdmin*` resolvers
    private readAdminAuthMetrics(sql: SqlExec): { result: unknown; tables: Set<string> } {
        let result: AuthMetrics;

        try {
            result = readAuthMetrics(sql);
        } catch {
            result = { attempts: 0, failureRate: 0, failures: 0, history: [], sinceMs: 0 };
        }

        return { result, tables: new Set([ADMIN_WILDCARD]) };
    }

    /**
     * Resolve a `getCapturedMail` admin read — the dev mail catcher's inbox
     * (`mail-catcher.ts`), newest-first. Best-effort: a SQL failure returns an
     * empty inbox rather than throwing. Bound to the {@link MAIL_TABLE} so a live
     * studio subscription re-runs when a new message is recorded (the per-socket
     * JSON memo still suppresses byte-identical pushes).
     */
    // eslint-disable-next-line class-methods-use-this -- kept an instance method for symmetry with the other `readAdmin*` resolvers
    private readAdminCapturedMail(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
        let result: { entries: unknown[] };

        try {
            result = readCapturedMail(sql, { limit });
        } catch {
            result = { entries: [] };
        }

        return { result, tables: new Set([MAIL_TABLE]) };
    }

    /**
     * Resolve a `getQueueMessages` admin read — the dev queue catcher's consumed
     * message log (`queue-catcher.ts`), newest-first, optionally filtered to one
     * queue. Best-effort: a SQL failure returns an empty log rather than throwing.
     * Reported against the {@link QUEUE_TABLE} so this read participates in
     * table-scoped subscription invalidation, but new captures arrive via the
     * worker→root-shard `recordQueueMessage` write, which (like the mail catcher)
     * inserts directly without a `flushChangedTables` — so the panel refreshes on
     * its poll (`useAutoRefresh`) rather than a live push.
     */
    // eslint-disable-next-line class-methods-use-this -- kept an instance method for symmetry with the other `readAdmin*` resolvers
    private readAdminQueueMessages(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
        const queue = typeof args["queue"] === "string" ? args["queue"] : undefined;
        let result: { entries: unknown[] };

        try {
            result = readQueueMessages(sql, { limit, queue });
        } catch {
            result = { entries: [] };
        }

        return { result, tables: new Set([QUEUE_TABLE]) };
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
     * Resolve a `facetColumn` admin read — Datasette-style per-column value/count
     * summary over the active view. Reuses {@link readTablePage}'s predicate args
     * (`filters` + `search`) so the facet reflects exactly the previewed rows; the
     * `column` is validated + bound inside {@link facetColumn} (never interpolated).
     * Read-only `SELECT … GROUP BY`. Depends on its table like {@link readAdminTablePage}.
     */
    // eslint-disable-next-line class-methods-use-this -- instance method for symmetry with the other `readAdmin*` resolvers
    private readAdminFacetColumn(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        const table = typeof args["table"] === "string" ? args["table"] : "";
        const result = facetColumn(sql, {
            column: typeof args["column"] === "string" ? args["column"] : "",
            filters: parseTablePageFilters(args["filters"]),
            limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
            search: typeof args["search"] === "string" ? args["search"] : undefined,
            table,
        });

        return { result, tables: new Set([table === "" ? ADMIN_WILDCARD : table]) };
    }

    /**
     * Resolve a `runSql` admin read: execute a read-only SQL query against the
     * shard's SQLite via {@link runReadonlySql} (which rejects every mutating
     * statement). Carries the {@link ADMIN_WILDCARD} since an arbitrary query can
     * touch any table; it is a one-shot read, never a live subscription.
     */
    // eslint-disable-next-line class-methods-use-this -- instance method for symmetry with the other `readAdmin*` resolvers
    private readAdminRunSql(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        const query = typeof args["sql"] === "string" ? args["sql"] : "";

        return { result: runReadonlySql(sql, query), tables: new Set([ADMIN_WILDCARD]) };
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
     * different identity, so this predicate gates {@link resolveReactiveOutcomeDeduped}
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

    private async handleStream(ws: WebSocket, id: string, functionPath: string, args: Record<string, unknown>): Promise<void> {
        const iterable = this.executeStream(functionPath, args);

        if (!iterable) {
            ws.send(JSON.stringify({ error: { code: "NOT_FOUND", message: `stream not registered: ${functionPath}` }, id, type: "error" }));

            return;
        }

        let cancellers = this.streamCancellers.get(ws);

        if (!cancellers) {
            cancellers = new Map();
            this.streamCancellers.set(ws, cancellers);
        }

        // Enforce the per-socket in-flight cap before allocating any state
        // for the new stream. A rejected stream never lands in the
        // canceller map, so a flurry of rejections can't push the count
        // past the cap.
        if (cancellers.size >= ShardDO.MAX_STREAMS_PER_SOCKET) {
            try {
                ws.send(
                    JSON.stringify({
                        error: { code: "TOO_MANY_STREAMS", message: `stream cap of ${String(ShardDO.MAX_STREAMS_PER_SOCKET)} reached on this socket` },
                        id,
                        type: "error",
                    }),
                );
            } catch {
                /* socket may be closed */
            }

            return;
        }

        const controller = new AbortController();

        cancellers.set(id, controller);
        ws.send(JSON.stringify({ id, type: "ack" }));

        try {
            for await (const chunk of iterable.iterator(controller.signal)) {
                if (controller.signal.aborted) {
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

            ws.send(
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

        this.pendingChangedTables = undefined;

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
        if (typeof this.state.waitUntil === "function") {
            this.state.waitUntil(this.drainSubscriptionRefreshes());

            return;
        }

        await this.drainSubscriptionRefreshes();
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

        try {
            let batch = this.pendingRefreshTables;

            while (batch && batch.size > 0) {
                this.pendingRefreshTables = undefined;

                // Resolve the post-write cut once per coalesced batch; it covers
                // every write merged into this batch. Run the legacy refresh and
                // the shape poke fan-out together off the same watermark.
                const frameCursor = this.currentCdcCursor();
                const frameEpoch = this.currentCdcEpoch();

                // eslint-disable-next-line no-await-in-loop -- passes are intentionally sequential: each observes the prior pass's committed state and the tables merged while it ran
                await Promise.all([
                    this.refreshSubscriptions(batch),
                    this.pokeShapeSubscribers(batch, frameCursor, frameEpoch),
                    this.relay?.onFlush(batch, frameCursor ?? 0),
                ]);

                batch = this.pendingRefreshTables;
            }
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
     * The framework's INTENDED answer to this fan-out already exists: the opt-in
     * {@link ReactiveCache} (`ShardDOOptions.reactiveCache`). Refreshes run with
     * an explicit anonymous {@link SubscriptionIdentity}, so the cache key
     * `reactiveCacheKey(functionPath, args, null)` is identical across all
     * sockets — N identical subscriptions collapse to ONE handler run plus N
     * cache hits, with every per-run side effect honored exactly once by design.
     * Recommended remediation is to document/enable ReactiveCache for
     * high-fanout shards rather than bolt a second, semantically-divergent dedup
     * into this loop.
     */
    private async refreshSubscriptions(changed: Set<string>): Promise<void> {
        const sockets = [...this.state.getWebSockets()];

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

        const refreshOne = async (ws: WebSocket): Promise<void> => {
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

            for (const [subId, query] of Object.entries(attachment.subs)) {
                const { functionPath } = query;

                if (!functionPath) {
                    continue;
                }

                const isAdmin = functionPath.startsWith(ADMIN_FUNCTION_PREFIX);
                const memo = this.subMemos.get(ws)?.get(subId);

                // Skip when we already know this subscription's tables and none
                // of them changed. A missing memo means "unknown deps" — re-run
                // to be safe. A memo carrying the admin wildcard always re-runs
                // (its value isn't bound to any single table).
                if (memo && !memo.tables.has(ADMIN_WILDCARD) && !setsIntersect(memo.tables, changed)) {
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

                    this.pushSubscriptionData(ws, subId, outcome, frameCursor, frameEpoch);
                } catch {
                    // A throwing subscription must not abort the refresh of its
                    // siblings, nor fail the mutation that triggered it. The memo
                    // is left untouched ("unknown deps"), so this subscription
                    // re-runs on the next flush.
                    /* refresh error contained to this subscription */ continue;
                }
            }
        };

        // Bounded fan-out (default 8 in flight): each worker drains its sockets
        // one at a time so the per-subscription `awaitWsDrain` gate above paces a
        // slow consumer. See {@link runSocketPool}.
        await runSocketPool(sockets, refreshOne);
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
     */
    private async seedSubscription(ws: WebSocket, subId: string, query: SubscriptionQuery, functionPath: string, isAdmin: boolean): Promise<void> {
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
                ws.send(`{"type":"resume","id":${JSON.stringify(subId)}${cdcSuffix(resume.cursor ?? 0, epoch)}}`);
            } catch {
                /* socket may have closed between the ack and this seed */
            }

            return;
        }

        this.pushSubscriptionData(ws, subId, outcome, resume?.cursor ?? this.currentCdcCursor(), epoch);
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
    private async handleShapeSubscribe(ws: WebSocket, subId: string, shape: ShapeSubscriptionQuery): Promise<void> {
        const status = this.shapeSubscribe(ws, subId, shape);

        if (status !== "ok") {
            const code = status === "too_many" ? "TOO_MANY_SUBSCRIPTIONS" : "SUBSCRIPTION_PERSIST_FAILED";
            const message =
                status === "too_many"
                    ? `subscription cap of ${String(ShardDO.MAX_SUBSCRIPTIONS_PER_SOCKET)} reached on this socket`
                    : "failed to persist shape subscription attachment";

            this.sendShapeSubscribeError(ws, subId, code, message);

            return;
        }

        // Seed the fresh shape with its initial membership as one insert-poke (or a
        // catch-up diff when the client is still current). On a resolve failure,
        // roll back the just-persisted attachment and error instead of acking.
        const seed = await this.seedShapeSubscription(ws, subId, shape);

        if (seed !== "ok") {
            this.shapeUnsubscribe(ws, subId);
            this.sendShapeSubscribeError(ws, subId, seed.code, seed.message);

            return;
        }

        // Both persistence and seeding succeeded — ack last (the client keys pokes
        // by shape id, not the ack, so the seed poke arriving first is fine).
        try {
            ws.send(JSON.stringify({ id: subId, type: "ack" }));
        } catch {
            /* socket may already be closed; never throw out of webSocketMessage */
        }
    }

    /** Send a structured `error` frame for a failed `shape_subscribe`, swallowing a send on an already-closed socket. */
    // eslint-disable-next-line class-methods-use-this -- groups with the shape-subscribe flow; uses only its args + the socket
    private sendShapeSubscribeError(ws: WebSocket, subId: string, code: string, message: string): void {
        try {
            ws.send(JSON.stringify({ code, error: { code, message }, id: subId, type: "error" }));
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
    private async seedShapeSubscription(ws: WebSocket, subId: string, shape: ShapeSubscriptionQuery): Promise<"ok" | { code: string; message: string }> {
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

            return await this.seedOpLogShape(ws, subId, shape, resolved);
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
    private async seedOpLogShape(ws: WebSocket, subId: string, shape: ShapeSubscriptionQuery, resolved: ResolvedShape): Promise<"ok"> {
        const { baseCheckpoint, cursor, epoch, rowsPatch } = this.computeOpLogShapeSeed(shape, resolved);

        // Await drain before the (potentially large) seed poke so a slow consumer
        // can't grow this socket's outbound buffer without bound.
        await awaitWsDrain(ws);

        if (this.sendPoke(ws, [{ rowsPatch, shapeId: subId }], cursor, epoch, baseCheckpoint)) {
            this.recordShapeMemo(ws, subId, cursor);
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
     * @returns the cursor/epoch, the resume base (`baseCheckpoint`), and the membership patch
     */
    private computeOpLogShapeSeed(
        shape: ShapeSubscriptionQuery,
        resolved: ResolvedShape,
    ): { baseCheckpoint: number | undefined; cursor: number; epoch: string | undefined; rowsPatch: ShapeRowOp[] } {
        const sql = this.sql as SqlExec;
        const cursor = this.currentCdcCursor() ?? 0;
        const epoch = this.currentCdcEpoch();
        const floor = this.cdcEnabled() ? minCdcSeq(sql) : undefined;
        const canResume =
            this.cdcEnabled() &&
            shape.sinceSeq !== undefined &&
            shape.sinceEpoch === epoch &&
            shape.sinceSeq <= cursor &&
            (shape.sinceSeq === cursor || (floor !== undefined && floor <= shape.sinceSeq + 1));

        const rowsPatch =
            canResume && shape.sinceSeq !== undefined ? this.buildShapeDiff(sql, resolved, shape.sinceSeq, cursor) : this.buildShapeSeed(sql, resolved);

        return { baseCheckpoint: canResume ? shape.sinceSeq : undefined, cursor, epoch, rowsPatch };
    }

    /**
     * Fan the membership diff of every shape affected by this flush to its
     * subscribers — the partial-replication parallel to
     * {@link ShardDO.refreshSubscriptions}, called alongside it from
     * {@link ShardDO.flushChangedTables}. For each socket (bounded fan-out, same
     * concurrency + `awaitWsDrain` backpressure as the subscription path) it
     * resolves each shape under the socket's identity, diffs only the shapes
     * whose table changed in `(memoCursor, frameCursor]`, and emits one poke
     * carrying a part per changed shape. No-op when no socket holds a shape.
     */
    private async pokeShapeSubscribers(changed: Set<string>, frameCursor: number | undefined, frameEpoch: string | undefined): Promise<void> {
        const sockets = [...this.state.getWebSockets()];
        const checkpoint = frameCursor ?? this.currentCdcCursor() ?? 0;
        const sql = this.sql as SqlExec;

        // Flush-local op-range cache: every shape over the same `(table, sinceSeq,
        // upTo)` reads the identical changelog slice, so they share ONE drain this
        // flush instead of re-scanning the op-log per shape/socket. Created fresh
        // per flush so a slice is never reused across writes (it would go stale).
        const opRangeCache = new Map<string, Map<string, CdcChange>>();

        // Observability (plan 075 Phase 1): count sockets this flush actually
        // poked so `getFanoutMetrics` can report the delivered-vs-iterated split.
        // Pure measurement — it never alters which sockets are poked.
        let delivered = 0;

        const pokeOne = async (ws: WebSocket): Promise<void> => {
            if (this.isSocketExpired(ws)) {
                this.dropExpiredSocket(ws);

                return;
            }

            const attachment = this.readAttachment(ws);
            const { shapes } = attachment;

            if (!shapes) {
                return;
            }

            try {
                const identity: SubscriptionIdentity = { identity: attachment.identity, userId: attachment.userId };
                const { emptyAdvanced, partAdvanced, parts } = this.collectShapePokeParts(ws, shapes, identity, changed, checkpoint, sql, opRangeCache);

                // Empty-diff shapes advance regardless (nothing to deliver for them),
                // so the next flush doesn't re-scan the same op range.
                for (const subId of emptyAdvanced) {
                    this.recordShapeMemo(ws, subId, checkpoint);
                }

                // Await drain before the (potentially large) poke so a slow consumer
                // can't grow this socket's outbound buffer without bound — the same
                // backpressure the seed/refresh paths apply. Part-bearing shapes
                // advance only after the poke lands; a failed send leaves their memos
                // so the next flush re-emits the rows.
                if (parts.length > 0) {
                    await awaitWsDrain(ws);

                    if (this.sendPoke(ws, parts, checkpoint, frameEpoch, undefined)) {
                        delivered += 1;

                        for (const subId of partAdvanced) {
                            this.recordShapeMemo(ws, subId, checkpoint);
                        }
                    }
                }
            } catch {
                // A throwing socket (e.g. awaitWsDrain/sendPoke rejecting on a dead
                // connection) must not abort the poke fan-out to its siblings — the
                // bounded pool runs sockets in parallel and one bad socket would
                // otherwise reject the whole Promise.all. Memos are left untouched,
                // so the next flush re-pokes this socket. Mirrors refreshSubscriptions.
                /* poke error contained to this socket */
            }
        };

        // Bounded fan-out matching `refreshSubscriptions`: each worker drains its
        // sockets one at a time so the per-send `awaitWsDrain` gate above applies
        // backpressure on a slow consumer. See {@link runSocketPool}.
        const startMs = Date.now();

        await runSocketPool(sockets, pokeOne);

        // Record the fan-out cost of this flush (plan 075 Phase 1). `startMs` wraps
        // the whole pool, so the elapsed time captures the awaited drain/send I/O
        // across every socket; it is coarse (a DO clock advances only on I/O) but
        // the socket counts are exact. Recorded even for a zero-delivery flush so
        // the iterated-vs-delivered ratio reflects wasted work honestly.
        this.fanout.shapePoke = recordFanoutPass(this.fanout.shapePoke, sockets.length, delivered, Date.now() - startMs);
    }

    /**
     * Diff every op-log-backed shape a socket holds against this flush, splitting
     * the results into the poke parts to send and the per-shape memo advances. A
     * `.global()` shape (driven by the alarm poll loop, not this flush) and a shape
     * whose table didn't change are skipped; a shape whose resolve/diff throws is
     * logged and skipped with its memo unadvanced so a later flush retries. Empty
     * diffs advance unconditionally; part-bearing shapes advance only once the
     * caller confirms the poke was delivered.
     */
    private collectShapePokeParts(
        ws: WebSocket,
        shapes: Record<string, ShapeSubscriptionQuery>,
        identity: SubscriptionIdentity,
        changed: Set<string>,
        checkpoint: number,
        sql: SqlExec,
        opRangeCache: Map<string, Map<string, CdcChange>>,
    ): { emptyAdvanced: string[]; partAdvanced: string[]; parts: ShapePokePart[] } {
        const parts: ShapePokePart[] = [];
        const emptyAdvanced: string[] = [];
        const partAdvanced: string[] = [];

        for (const [subId, shape] of Object.entries(shapes)) {
            try {
                const resolved = this.resolveShape(shape.name, shape.args ?? {}, identity);

                if (!resolved || resolved.global || !changed.has(resolved.table)) {
                    continue;
                }

                const memoCursor = this.shapeMemos.get(ws)?.get(subId)?.cursor ?? 0;
                const rowsPatch = this.buildShapeDiff(sql, resolved, memoCursor, checkpoint, opRangeCache);

                if (rowsPatch.length > 0) {
                    parts.push({ rowsPatch, shapeId: subId });
                    partAdvanced.push(subId);
                } else {
                    emptyAdvanced.push(subId);
                }
            } catch (error) {
                this.recordShapeError(`shape:poke:${subId}`, error);
            }
        }

        return { emptyAdvanced, partAdvanced, parts };
    }

    /**
     * Drain the op-log range `(sinceSeq, upTo]` for `table` into the latest op per
     * row id (collapsing multiple ops on the same row to the newest). Within one
     * flush, every shape over the SAME `(table, sinceSeq, upTo)` reads the
     * identical changelog slice, so the drained map is memoized in the
     * caller-supplied `cache` (created fresh per flush) — N shapes on a table
     * share ONE changelog drain instead of re-scanning it per shape. The
     * per-shape membership probe still runs per shape (its predicate is
     * identity/args-specific), so only the shared op read is collapsed.
     */
    private readShapeOpRange(sql: SqlExec, table: string, sinceSeq: number, upTo: number, cache?: Map<string, Map<string, CdcChange>>): Map<string, CdcChange> {
        const key = `${table} ${String(sinceSeq)} ${String(upTo)}`;
        const cached = cache?.get(key);

        if (cached !== undefined) {
            return cached;
        }

        const latest = new Map<string, CdcChange>();
        const tables = new Set([table]);
        let from = sinceSeq;

        // Drain the op range so a flush larger than one CDC page is fully covered.
        for (;;) {
            const { changes, cursor } = this.readShapeCdcPage(sql, from, tables);

            for (const change of changes) {
                latest.set(change.id, change);
            }

            if (changes.length === 0 || cursor === from || cursor >= upTo) {
                break;
            }

            from = cursor;
        }

        cache?.set(key, latest);

        return latest;
    }

    /**
     * Read one page of the `__cdc_log` for a shape diff (table-scoped). A thin
     * protected seam over {@link readCdcChanges}: it isolates the single
     * changelog read that {@link readShapeOpRange} memoizes per flush, and gives
     * tests a point to count the reads the op-range cache collapses.
     */
    // eslint-disable-next-line class-methods-use-this, @typescript-eslint/member-ordering -- thin pass-through seam over the module-level reader; a protected method so the op-range cache + tests share one read point, co-located with the poke path it serves rather than hoisted away from its only caller
    protected readShapeCdcPage(sql: SqlExec, sinceSeq: number, tables: ReadonlySet<string>): { changes: CdcChange[]; cursor: number } {
        return readCdcChanges(sql, { sinceSeq, tables });
    }

    /**
     * Build the row-ops for a shape over the op range `(sinceSeq, upTo]`. Reads
     * the changelog (drained across pages via {@link readShapeOpRange}, shared
     * across same-range shapes in a flush), collapses to the latest op per row,
     * then runs ONE membership probe ({@link selectShapeMemberIds}) over the
     * changed ids: a row still in the set → upsert with its post-image doc
     * (projected to the shape's columns); a row that left the set, or any delete,
     * → `delete(key)` (a delete carries no post-image, so membership is
     * unknowable from the op alone — the client no-ops an unknown key).
     */
    private buildShapeDiff(
        sql: SqlExec,
        resolved: ResolvedShape,
        sinceSeq: number,
        upTo: number,
        opRangeCache?: Map<string, Map<string, CdcChange>>,
    ): ShapeRowOp[] {
        const latest = this.readShapeOpRange(sql, resolved.table, sinceSeq, upTo, opRangeCache);

        if (latest.size === 0) {
            return [];
        }

        const ids = [...latest.keys()];
        const members = selectShapeMemberIds(sql, resolved.table, resolved.effectiveWhere, ids);
        const ops: ShapeRowOp[] = [];

        for (const [id, change] of latest) {
            if (members.has(id)) {
                // Still a member ⇒ the row exists (a `delete` op can never be in
                // the live membership set), so its post-image is present: upsert it.
                if (change.doc !== undefined) {
                    ops.push({ key: id, op: change.op, table: resolved.table, value: projectColumns(change.doc, resolved.columns) });
                }

                continue;
            }

            // Not a member now. An `insert` that never matched the predicate was
            // never replicated to anyone, so emit nothing — pushing a `delete` for
            // it would spam every shape subscriber on the table with a no-op key.
            // An `update` that left the set, or a `delete`, DOES need a delete:
            // the pre-image is unknowable from the op alone, so we conservatively
            // tell the client to drop the key (a no-op if it never held it).
            if (change.op !== "insert") {
                ops.push({ key: id, op: "delete", table: resolved.table });
            }
        }

        return ops;
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
        ws: WebSocket,
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

        if (this.sendPoke(ws, [{ rowsPatch, shapeId: subId }], this.currentCdcCursor() ?? 0, this.currentCdcEpoch(), undefined)) {
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
        ws: WebSocket,
        subId: string,
        resolved: ResolvedShape,
        identity: SubscriptionIdentity,
        connectionId: string,
    ): Promise<void> {
        const rows = await this.readGlobalShapeRows(resolved, identity);

        // An over-cap membership: leave the prior snapshot untouched (so the diff
        // recovers if it later shrinks) and skip this tick rather than retaining it.
        if (!this.withinGlobalShapeBound(rows.length, `shape:poll:${subId}`, resolved.table)) {
            return;
        }

        const previous = this.readGlobalSnapshot(ws, subId, connectionId);
        const { next, rowsPatch } = diffGlobalMembership(rows, previous, { columns: resolved.columns, table: resolved.table });

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
        }
    }

    /**
     * Read a socket's global-shape baseline, preferring the hot in-memory cache
     * and falling back to the durable `__global_shape_snapshot` table on a miss (a
     * cold socket after a hibernation eviction). The loaded baseline repopulates
     * the cache so subsequent ticks in this wake hit memory. An empty
     * `connectionId` (a socket that never went through the lifecycle-aware upgrade,
     * e.g. a unit harness) skips the durable read and behaves as in-memory-only.
     */
    private readGlobalSnapshot(ws: WebSocket, subId: string, connectionId: string): Map<string, string> {
        const cached = this.globalShapeSnapshots.get(ws)?.get(subId);

        if (cached) {
            return cached;
        }

        const stored = this.loadGlobalSnapshot(connectionId, subId);

        this.recordGlobalSnapshot(ws, subId, stored);

        return stored;
    }

    /** Record a socket's latest global-shape membership snapshot in the in-memory cache (creating the per-socket map lazily). */
    private recordGlobalSnapshot(ws: WebSocket, subId: string, snapshot: Map<string, string>): void {
        let snapshots = this.globalShapeSnapshots.get(ws);

        if (!snapshots) {
            snapshots = new Map<string, Map<string, string>>();
            this.globalShapeSnapshots.set(ws, snapshots);
        }

        snapshots.set(subId, snapshot);
    }

    /**
     * Load a durable global-shape baseline from SQLite, or an empty map when none
     * is stored / the durable path is unavailable. A stub `sql` handle (unit
     * harness) or a missing table degrades to in-memory-only behavior rather than
     * failing the poll tick.
     */
    private loadGlobalSnapshot(connectionId: string, subId: string): Map<string, string> {
        if (connectionId === "") {
            return new Map<string, string>();
        }

        try {
            return readGlobalShapeSnapshot(this.sql as SqlExec, connectionId, subId);
        } catch {
            return new Map<string, string>();
        }
    }

    /**
     * Persist a socket's global-shape baseline to SQLite so the poll-loop diff
     * survives hibernation. A no-op for a connection-id-less socket or a stub
     * `sql` handle (the in-memory cache then carries the baseline for the DO's
     * lifetime, matching the pre-durable behavior).
     */
    private saveGlobalSnapshot(connectionId: string, subId: string, snapshot: Map<string, string>): void {
        if (connectionId === "") {
            return;
        }

        try {
            writeGlobalShapeSnapshot(this.sql as SqlExec, connectionId, subId, snapshot);
        } catch {
            /* stub sql / missing table — degrade to in-memory cache only */
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

        const { setAlarm } = this.state.storage;

        if (!setAlarm) {
            return;
        }

        this.globalPollScheduled = true;

        try {
            await setAlarm.call(this.state.storage, atMs ?? Date.now() + ShardDO.GLOBAL_SHAPE_POLL_INTERVAL_MS);
        } catch {
            // A failed arm clears the flag so a later seed/tick retries.
            this.globalPollScheduled = false;
        }
    }

    /**
     * Record a contained shape-tier error (poll / poke / seed) into the DO's log
     * ring without aborting the rest of the pass. The shape pipeline is a
     * best-effort fan-out: one socket's read or one shape's resolve failing must
     * never take down the others — so callers swallow the throw and surface it
     * here for diagnosis. `context` is a synthetic `shape:phase:subId` path.
     */
    private recordShapeError(context: string, error: unknown): void {
        this.logs.push({
            functionPath: context,
            level: "error",
            message: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
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
     * Refresh every `.global()`-table shape held across all live sockets, one
     * diff-poke per (socket, shape). Returns the number of global shapes still
     * subscribed so {@link ShardDO.alarm} knows whether to re-arm. Expired sockets
     * are dropped in passing (mirrors {@link ShardDO.pokeShapeSubscribers}).
     */
    private async pollGlobalShapes(): Promise<number> {
        const sockets = [...this.state.getWebSockets()];
        let remaining = 0;

        for (const ws of sockets) {
            if (this.isSocketExpired(ws)) {
                this.dropExpiredSocket(ws);

                continue;
            }

            const attachment = this.readAttachment(ws);
            const { shapes } = attachment;

            if (!shapes) {
                continue;
            }

            const identity: SubscriptionIdentity = { identity: attachment.identity, userId: attachment.userId };

            // eslint-disable-next-line no-await-in-loop -- per-socket reads are intentionally serialized to bound concurrent global reads per tick
            remaining += await this.pollSocketGlobalShapes(ws, shapes, identity, attachment.connectionId ?? "");
        }

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
        ws: WebSocket,
        shapes: Record<string, ShapeSubscriptionQuery>,
        identity: SubscriptionIdentity,
        connectionId: string,
    ): Promise<number> {
        let count = 0;

        for (const [subId, shape] of Object.entries(shapes)) {
            let resolved: ResolvedShape | undefined;

            try {
                resolved = this.resolveShape(shape.name, shape.args ?? {}, identity);
            } catch (error) {
                count += 1;
                this.recordShapeError(`shape:poll:${subId}`, error);

                continue;
            }

            if (!resolved?.global) {
                continue;
            }

            count += 1;

            try {
                // eslint-disable-next-line no-await-in-loop -- per-shape D1 reads serialized within a socket to bound concurrency
                await this.refreshGlobalShape(ws, subId, resolved, identity, connectionId);
            } catch (error) {
                this.recordShapeError(`shape:poll:${subId}`, error);
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
     */
    private sendPoke(
        ws: WebSocket,
        parts: ReadonlyArray<ShapePokePart>,
        checkpoint: number,
        epoch: string | undefined,
        baseCheckpoint: number | undefined,
    ): boolean {
        this.pokeSequence += 1;
        const pokeId = `poke-${String(this.pokeSequence)}`;
        const frames = buildPokeFrames(parts, { baseCheckpoint, checkpoint, epoch, lastMutationId: this.socketClientWatermark(ws), pokeId });

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
    private socketClientWatermark(ws: WebSocket): number | undefined {
        const attachment = this.readAttachment(ws);
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

    /** Record a shape's poke baseline cursor on a socket (creating the per-socket map lazily). */
    private recordShapeMemo(ws: WebSocket, subId: string, cursor: number): void {
        let memos = this.shapeMemos.get(ws);

        if (!memos) {
            memos = new Map<string, ShapeMemo>();
            this.shapeMemos.set(ws, memos);
        }

        memos.set(subId, { cursor });
    }

    /**
     * Record `outcome` as this socket's diff baseline for `subId` without
     * sending a frame. Used by the resume fast-path, where the client keeps its
     * cached value but the server still needs a baseline so the next
     * write-flush can diff against it.
     */
    private seedSubscriptionMemo(ws: WebSocket, subId: string, outcome: SubscriptionOutcome): void {
        let memos = this.subMemos.get(ws);

        if (!memos) {
            memos = new Map<string, SubscriptionMemo>();
            this.subMemos.set(ws, memos);
        }

        // eslint-disable-next-line unicorn/no-null -- mirrors pushSubscriptionData: an undefined result serializes to JSON null so the baseline matches the wire form
        memos.set(subId, { lastJson: JSON.stringify(encodeWire(outcome.result ?? null)), tables: outcome.tables });
    }

    /**
     * Memoise `outcome` for `(ws, subId)` and push it to the socket, unless an
     * identical result was already sent. Always refreshes the memo's table set
     * so dependency tracking stays current even when the value is unchanged.
     *
     * When the result is a diffable list (Convex-parity live-pagination, gap
     * #20), emit one `{type:"delta"}` frame per changed row instead of a full
     * `{type:"data"}` snapshot — see {@link subscriptionListDeltas} for the
     * five conditions under which deltas are safe. The first send (and any
     * non-list / large-change result) falls back to the snapshot. The memo is
     * always advanced to the new `lastJson`/`tables` regardless of path.
     *
     * `cursor` (when supplied) is the `__cdc_log` high-watermark this frame
     * covers; it is appended to the emitted `data`/`delta` JSON so a client can
     * persist its resume position and replay it as `sinceSeq` on reconnect
     * (Pillar 1b). Omitted on shards without CDC, keeping the wire byte-identical
     * to the pre-cursor format.
     */
    private pushSubscriptionData(ws: WebSocket, subId: string, outcome: SubscriptionOutcome, cursor?: number, epoch?: string): void {
        let memos = this.subMemos.get(ws);

        if (!memos) {
            memos = new Map<string, SubscriptionMemo>();
            this.subMemos.set(ws, memos);
        }

        const cursorSuffix = cdcSuffix(cursor, epoch);

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
            const settledWatermark = this.socketClientWatermark(ws);
            const watermarkField = settledWatermark === undefined ? "" : `,"lastMutationId":${String(settledWatermark)}`;

            trySendFrame(ws, `{"type":"settled","id":${JSON.stringify(subId)}${watermarkField}${cursorSuffix}}`);

            return;
        }

        // Try an incremental delta push when there's a prior list to diff
        // against. `undefined` => not diffable, fall back to the snapshot below.
        // `deltaFrames` receives the pre-serialized `delta` body for each delta
        // (finding #6) so we never re-`JSON.stringify` a row that the diff has
        // already fingerprinted.
        const deltaFrames: string[] = [];
        const deltas =
            existing === undefined
                ? undefined
                : subscriptionListDeltas(existing.lastJson, outcome.result, outcome.tables.values().next().value ?? "", deltaFrames);

        // At-least-once delivery: advance the diff BASELINE (`lastJson`) only once
        // the frame(s) for this value actually leave the socket. `ws.send` throws
        // when the socket has closed or its outbound buffer is gone. Advancing the
        // baseline unconditionally (the prior behavior) would diff the NEXT value
        // against a value the client never received, so a single dropped frame
        // silently lost that update until the client reconnected. By keeping the
        // last *delivered* baseline on failure, the next write-flush that touches a
        // read table re-sends — and the reconnect resume path (`evaluateResume`)
        // still covers a fully-gone socket. `tables` always advances so dependency
        // tracking stays accurate even when delivery failed.
        const delivered =
            deltas === undefined
                ? trySendFrame(ws, `{"type":"data","id":${JSON.stringify(subId)},"data":${json}${cursorSuffix}}`)
                : sendDeltaFrames(ws, subId, deltaFrames, cursorSuffix);

        memos.set(subId, { lastJson: delivered ? json : (existing?.lastJson ?? UNDELIVERED_BASELINE), tables: outcome.tables });
    }

    /**
     * Gate the upgrade request against two complementary controls:
     *
     * 1. Origin allowlist via `env.LUNORA_ALLOWED_ORIGINS` (comma-separated).
     * When unset, any origin is accepted — convenient for local dev,
     * not suitable for production.
     * 2. Bearer token via `env.LUNORA_WS_BEARER`. When set, the upgrade
     * must present a matching token. We accept either an
     * `Authorization: Bearer &lt;token>` header (preferred) or a
     * `?token=&lt;token>` query parameter (the only escape hatch for
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

            const list = allowedOrigins
                .split(",")
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);

            if (!list.includes(origin)) {
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
     * Enforcement: with `LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN` set
     * (`1`/`true`/`on`/`yes`/`enabled`), a raw master token in the
     * `?token=` query parameter is rejected — the query string is exactly
     * where it leaks. The `Authorization` header path still takes the master
     * token: browsers can't set it on a WS upgrade, so it never rides a URL.
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
        const requireEphemeral = REQUIRE_EPHEMERAL_ENV_VALUES.has((env.LUNORA_REQUIRE_EPHEMERAL_WS_TOKEN ?? "").trim().toLowerCase());

        if (fromQuery && requireEphemeral) {
            return false;
        }

        return constantTimeEqual(supplied, adminToken);
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

        this.state.acceptWebSocket(server);

        // Capture the verified identity the runtime forwarded on the upgrade
        // (`resolveIdentity` wired into the WS upgrade) and mint a stable
        // per-socket id. Both are stashed on the attachment so they survive
        // hibernation and can be replayed to the connection-lifecycle hooks at
        // connect/close — including `webSocketClose`, when the socket carries no
        // request of its own.
        const userId = request.headers.get("x-lunora-userid") ?? undefined;
        const identity = parseIdentityHeader(request.headers.get("x-lunora-identity"));
        // Optional credential expiry (epoch ms) forwarded by the runtime. A
        // malformed value is ignored (the socket simply never auto-expires).
        const expiresAtRaw = Number(request.headers.get("x-lunora-identity-exp"));
        const expiresAt = Number.isFinite(expiresAtRaw) && expiresAtRaw > 0 ? expiresAtRaw : undefined;

        // Stamp admin authorization onto the socket at upgrade so later
        // `__lunora_admin__:*` subscribe envelopes (which carry no credential of
        // their own) can be gated without re-checking a token per message.
        (server as HibernatableWebSocket).serializeAttachment?.({
            admin,
            connectionId: crypto.randomUUID(),
            subs: {},
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

    /** Whether `ws` carries a credential whose expiry (stamped at upgrade) is now past. */
    private isSocketExpired(ws: WebSocket): boolean {
        const { expiresAt } = this.readAttachment(ws);

        return typeof expiresAt === "number" && Date.now() >= expiresAt;
    }

    /**
     * Send the `TOKEN_EXPIRED` error frame and close the socket with code 4001 so
     * the client distinguishes an expired-credential drop from an ordinary one
     * and refreshes before reconnecting. Best-effort: a throw (socket already
     * gone) is swallowed — this must never escape the hibernation handlers.
     */
    // eslint-disable-next-line class-methods-use-this -- cohesive socket helper grouped with isSocketExpired; operates only on the passed socket
    private dropExpiredSocket(ws: WebSocket): void {
        try {
            ws.send(JSON.stringify({ code: "TOKEN_EXPIRED", error: { code: "TOKEN_EXPIRED", message: "authentication token expired" }, type: "error" }));
            ws.close(4001, "token_expired");
        } catch {
            /* socket already gone */
        }
    }

    /**
     * Join (`join = true`) or leave a whisper `topic` on this socket. Membership rides
     * the hibernation attachment, bounded by
     * {@link ShardDO.MAX_WHISPER_TOPICS_PER_SOCKET}. Best-effort and silent:
     * whispering is never acked, and an over-cap join or a serialize failure is
     * simply dropped (the join just doesn't take).
     */
    private setWhisperMembership(ws: WebSocket, topic: string, join: boolean): void {
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
    private allowWhisper(ws: WebSocket): boolean {
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
    private async broadcastWhisper(sender: WebSocket, topic: string, data: unknown): Promise<void> {
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
    private deliverWhisperLocal(topic: string, frame: string, exclude: undefined | WebSocket): number {
        let scanned = 0;
        let delivered = 0;

        for (const ws of this.state.getWebSockets()) {
            scanned += 1;

            if (ws === exclude || this.readAttachment(ws).whispers?.includes(topic) !== true) {
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
    private readAttachment(ws: WebSocket): SocketAttachment {
        const raw = (ws as HibernatableWebSocket).deserializeAttachment?.();

        if (raw && typeof raw === "object" && "subs" in raw && (raw as { subs?: unknown }).subs) {
            return raw as SocketAttachment;
        }

        return { subs: {} };
    }
}

export { ROOT_DO_SIZE_WARN_BYTES, ROOT_SHARD_NAME, ShardDO };
// Re-exported so existing import sites (`./index`, tests) keep their path; the
// canonical home is `./subscription-delivery`.
export { subscriptionListDeltas } from "./subscription-delivery";
export type {
    HibernatableWebSocket,
    LogSink,
    RunShardApplyCdcArgs,
    RunShardApplyCdcResult,
    RunShardBulkDeleteArgs,
    RunShardBulkDeleteResult,
    RunShardExportArgs,
    RunShardImportArgs,
    RunShardMigrationArgs,
    RunShardRankBeforeArgs,
    RunShardRankPageArgs,
    RunShardWriteArgs,
    RunShardWriteResult,
    ShardDOOptions,
    ShardDOState,
    SubscriptionOutcome,
};
