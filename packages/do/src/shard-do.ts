import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { drizzle as drizzleDO } from "drizzle-orm/durable-sqlite";

import type { ExportRow, ImportShardResult } from "./admin-export-import";
import { parseExportShardArgs, parseImportShardArgs } from "./admin-export-import";
import { appendAuditEntry, ensureAuditTable, readAuditLog } from "./audit-log";
import type { AuthMetrics } from "./auth-metrics";
import { readAuthMetrics, recordAuthEvent } from "./auth-metrics";
import type { CdcChange, SqlExec } from "./ctx-db";
import { CDC_LOG_TABLE, minCdcSeq, readCdcChanges, readCdcCursor, readIdempotent, trimIdempotent, writeIdempotent } from "./ctx-db";
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
    FilterClause,
    FilterOperator,
    FunctionCallStat,
    FunctionStatsResult,
    MaskPoliciesResult,
    OrderByClause,
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
    facetColumn,
    findStorageReferences,
    listTables,
    MAX_PAGE_SIZE,
    readTablePage,
    RELATION_FUNCTION_PREFIX,
    selectMatchingIds,
    summarizeSubscriptions,
} from "./introspect";
import type { LogEntry } from "./log-buffer";
import { LogBuffer } from "./log-buffer";
import type { RecordMailInput } from "./mail-catcher";
import { clearCapturedMail, MAIL_TABLE, readCapturedMail, recordCapturedMail } from "./mail-catcher";
import { armRestore, readBookmark } from "./pitr";
import type { QueryStatEntry } from "./query-metrics";
import { readQueryMetrics, recordQueryMetric } from "./query-metrics";
import type { ShardRankPageResult } from "./rank";
import type { ReactiveCacheOptions } from "./reactive-cache";
import { ReactiveCache, reactiveCacheKey } from "./reactive-cache";
import type { AppendRequestLogEntry, ContextLogLevel, LogEventInput, RequestLogResult, RequestLogWriteOptions } from "./request-log";
import { appendRequestLogEntry, emitLogEvent, emitRequestLogEvent, ensureRequestLogTable, readRequestLog, renderLogMessage } from "./request-log";
import { buildSecurityAudit } from "./security-audit";
import { buildSettings, isDevEnvironment } from "./settings";
import { runReadonlySql } from "./sql-console";
import { findDanglingReferences } from "./storage-correlation";
import type { TransactionSqlLike } from "./transaction";
import { ConflictError } from "./transaction";
import type { LifecycleDispatchInfo, LifecycleEvent, MutationDelta, RpcRequest, SocketAttachment, SubscriptionEnvelope, SubscriptionQuery } from "./types";

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
 * Optional programmatic log sink, resolved from `createShardDO({ observability })`.
 * Structurally a subset of `@lunora/runtime`'s `ObservabilitySink`, so a user can
 * pass the SAME sink object to `createWorker` (which drives `onRpc`) and
 * `createShardDO` (which drives `onLog` from `ctx.log`). Typed structurally so
 * `@lunora/do` takes no dependency on `@lunora/runtime`; the event is the same
 * {@link LogEventInput} shape `emitLogEvent` consumes, built once per call.
 */
interface LogSink {
    onLog?: (event: LogEventInput) => void;
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

/** Identity field every Lunora document row carries. */
const ROW_ID_FIELD = "_id";

/**
 * Fallback table name stamped on a delta when the subscription's read-table
 * set is empty. The client only uses `table` for its structural guard
 * ({@link MutationDelta} recognition) — `key`/`row`/`op` drive the actual
 * merge — so any non-empty string is safe.
 */
const DELTA_FALLBACK_TABLE = "__lunora__";

/** Read a row's `_id` as a string; `undefined` when the row isn't a plain object with a string `_id`. */
const readRowId = (row: unknown): string | undefined => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
        return undefined;
    }

    const id = (row as Record<string, unknown>)[ROW_ID_FIELD];

    return typeof id === "string" ? id : undefined;
};

/**
 * Index an array of rows by `_id`, preserving insertion order. Returns
 * `undefined` the moment any element lacks a string `_id` (the diff can't key
 * such a list) — the caller then falls back to a full snapshot.
 *
 * Also bails on a duplicate `_id`: the delta protocol keys rows by `_id`, so a
 * list carrying the same `_id` twice (e.g. a relational join that fans a parent
 * out across children) cannot be expressed as deltas — the client would merge
 * the collisions down to a single row and silently lose the duplicates, leaving
 * its view shorter than the snapshot path. Returning `undefined` here forces the
 * full-snapshot fallback so both paths agree.
 */
const indexRowsById = (rows: unknown[]): undefined | { byId: Map<string, Record<string, unknown>>; order: string[] } => {
    const byId = new Map<string, Record<string, unknown>>();
    const order: string[] = [];

    for (const row of rows) {
        const id = readRowId(row);

        if (id === undefined || byId.has(id)) {
            return undefined;
        }

        byId.set(id, row as Record<string, unknown>);
        order.push(id);
    }

    return { byId, order };
};

/**
 * True when the rows present in BOTH lists keep the same relative order. The
 * client merges updates in place and never reorders, so a survivor that moved
 * can't be expressed as deltas.
 */
const survivorsKeepOrder = (
    previous: { byId: Map<string, Record<string, unknown>>; order: string[] },
    next: { byId: Map<string, Record<string, unknown>>; order: string[] },
): boolean => {
    const survivingPrevious = previous.order.filter((id) => next.byId.has(id));
    const survivingNext = next.order.filter((id) => previous.byId.has(id));

    if (survivingPrevious.length !== survivingNext.length) {
        return false;
    }

    return survivingPrevious.every((id, index) => survivingNext[index] === id);
};

/** An `_id`-indexed row set: the lookup map plus the preserved insertion order. */
type RowIndex = { byId: Map<string, Record<string, unknown>>; order: string[] };

/** A diff delta paired with its pre-serialized `delta` frame body (`JSON.stringify(delta)`). */
type FramedDelta = { delta: MutationDelta; frame: string };

/**
 * Collect `delete` deltas for every prev row absent from `next`, in prev order.
 * Each delete's `frame` is byte-identical to `JSON.stringify({key, op, table})`.
 */
const collectDeleteDeltas = (previous: RowIndex, next: RowIndex, deltaTable: string, tableJson: string): FramedDelta[] => {
    const out: FramedDelta[] = [];

    for (const id of previous.order) {
        if (!next.byId.has(id)) {
            out.push({
                delta: { key: id, op: "delete", table: deltaTable },
                frame: `{"key":${JSON.stringify(id)},"op":"delete","table":${tableJson}}`,
            });
        }
    }

    return out;
};

/**
 * Collect `insert`/`update` deltas for every next row that is new or whose body
 * changed, in next order. Each next row is fingerprinted with a SINGLE
 * `JSON.stringify` (finding #6) reused for both the `prev !== next` compare and
 * the `row` slot of the frame; each prev row is fingerprinted once too. Frames
 * are byte-identical to `JSON.stringify({key, op, row, table})`.
 */
const collectUpsertDeltas = (previous: RowIndex, next: RowIndex, deltaTable: string, tableJson: string): FramedDelta[] => {
    const out: FramedDelta[] = [];

    for (const id of next.order) {
        const nextRow = next.byId.get(id) as Record<string, unknown>;
        const previousRow = previous.byId.get(id);
        const nextFingerprint = JSON.stringify(nextRow);
        const previousFingerprint = previousRow === undefined ? undefined : JSON.stringify(previousRow);

        if (previousFingerprint === nextFingerprint) {
            continue;
        }

        const op = previousFingerprint === undefined ? "insert" : "update";

        out.push({
            delta: { key: id, op, row: nextRow, table: deltaTable },
            frame: `{"key":${JSON.stringify(id)},"op":"${op}","row":${nextFingerprint},"table":${tableJson}}`,
        });
    }

    return out;
};

/**
 * Diff the previously-sent list snapshot (`previousJson`, the memo's
 * `lastJson`) against the new query result and produce per-row
 * {@link MutationDelta}s the client can merge in place via `applyDelta` —
 * Convex-parity live-pagination deltas (server half of gap #20).
 *
 * Returns `undefined` (caller falls back to a full `{type:"data"}` snapshot)
 * unless ALL of these hold:
 *
 * 1. `previousJson` parses to an array (there IS a previous list to diff against).
 * 2. `nextResult` is also an array.
 * 3. Every row in both arrays is a plain object carrying a string `_id`.
 * 4. Order preservation — rows present in BOTH arrays appear in the same relative order.
 * 5. Chattiness cap — the number of deltas does not exceed the new array length (a near-total change is cheaper as a snapshot).
 *
 * Diff is keyed by `_id`: rows only in prev → `delete`; rows only in next →
 * `insert`; rows in both whose JSON differs → `update`. Insert/update carry the
 * full new `row`; delete omits it (matching the wire contract `@lunora/client`
 * parses). Deltas are ordered deletes-then-inserts/updates so the client never
 * sees a transient over-length page.
 *
 * Per-row serialization is done exactly **once** per refresh (finding #6). Each
 * row is stringified a single time into a fingerprint reused for both the
 * `prev !== next` change-detection compare and — when the caller passes the
 * optional `frames` sink — the pre-serialized delta frame body. The returned
 * `MutationDelta[]` shape is unchanged; `frames`, when supplied, receives the
 * exact `JSON.stringify(delta)` string for each returned delta, in the same
 * order, so the caller can splice it straight into the `{type:"delta"}` frame
 * without serializing the delta (and the row inside it) a second time.
 */
const subscriptionListDeltas = (previousJson: string, nextResult: unknown, table: string, frames?: string[]): MutationDelta[] | undefined => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(previousJson);
    } catch {
        return undefined;
    }

    // (1) + (2): both sides must be arrays. (3): both must be id-keyable.
    if (!Array.isArray(parsed) || !Array.isArray(nextResult)) {
        return undefined;
    }

    const previous = indexRowsById(parsed);
    const next = indexRowsById(nextResult);

    if (previous === undefined || next === undefined) {
        return undefined;
    }

    // (4): survivors keep their relative order.
    if (!survivorsKeepOrder(previous, next)) {
        return undefined;
    }

    const deltaTable = table === "" ? DELTA_FALLBACK_TABLE : table;
    const tableJson = JSON.stringify(deltaTable);
    // Deletes precede upserts so the client never sees a transient over-length page.
    const framed = [...collectDeleteDeltas(previous, next, deltaTable, tableJson), ...collectUpsertDeltas(previous, next, deltaTable, tableJson)];

    // (5): a near-total change is better sent as a single snapshot.
    if (framed.length > next.order.length) {
        return undefined;
    }

    if (frames !== undefined) {
        for (const { frame } of framed) {
            frames.push(frame);
        }
    }

    return framed.map(({ delta }) => delta);
};

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
 * Defensive WS backpressure helper. When the runtime exposes
 * `bufferedAmount` on the socket, pause iteration whenever the outbound
 * buffer is past 1 MiB; otherwise treat the socket as drained. Capped at
 * 100 sleeps of 20 ms (≈ 2 s total) so a permanently-stuck buffer can't
 * pin the iterator forever — past that we drop through and let the next
 * `ws.send` surface the failure.
 */
const awaitWsDrain = async (ws: WebSocket): Promise<void> => {
    let attempts = 0;

    while (attempts < 100) {
        attempts += 1;

        const buffered = (ws as { bufferedAmount?: unknown }).bufferedAmount;

        if (typeof buffered !== "number" || buffered < 1_048_576) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- intentional backpressure poll: sleep, then re-check the drained buffer on the next iteration
        await new Promise((resolve) => {
            setTimeout(resolve, 20);
        });
    }
};

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
        throw Object.assign(new Error("runMigration: `id` is required"), { code: "MIGRATION_ID_REQUIRED", name: "LunoraError", status: 400 });
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
        throw Object.assign(new Error("writeRow: `op` must be insert|patch|replace|delete"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    if (table.trim() === "") {
        throw Object.assign(new Error("writeRow: `table` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    const id = typeof args["id"] === "string" ? args["id"] : undefined;
    const record =
        typeof args["doc"] === "object" && args["doc"] !== null && !Array.isArray(args["doc"]) ? (args["doc"] as Record<string, unknown>) : undefined;

    if (op !== "insert" && (id === undefined || id === "")) {
        throw Object.assign(new Error(`writeRow: \`id\` is required for op "${op}"`), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    if (op !== "delete" && record === undefined) {
        throw Object.assign(new Error(`writeRow: \`doc\` is required for op "${op}"`), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
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
        throw Object.assign(new Error("createWorkflowInstance: `exportName` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
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
        throw Object.assign(new Error("getWorkflowInstanceStatus: `exportName` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    if (id === "") {
        throw Object.assign(new Error("getWorkflowInstanceStatus: `id` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
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

/** Narrow an unknown `status()` error field into the `{ message, name }` wire shape, or `undefined` when absent. */
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
        throw Object.assign(new Error("deleteRows: `table` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
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
        throw Object.assign(new Error("clearTable: `table` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
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
        throw Object.assign(new Error('recordAuthEvent: `outcome` must be "ok" or "fail"'), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
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
        throw Object.assign(new Error("recordContainerEvent: `event` must be an object"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    const envelope = raw as Record<string, unknown>;
    const container = typeof envelope["container"] === "string" ? envelope["container"] : "";
    const event = typeof envelope["event"] === "string" ? envelope["event"] : "";

    if (container.trim() === "" || event.trim() === "") {
        throw Object.assign(new Error("recordContainerEvent: `event.container` and `event.event` are required"), {
            code: "BAD_REQUEST",
            name: "LunoraError",
            status: 400,
        });
    }

    // Fold the envelope's `error`/`info` level into the buffer's level set
    // (anything but `error` is informational, keeping the panel's filters stable).
    const level = envelope["level"] === "error" ? "error" : "info";
    const detail = typeof envelope["message"] === "string" ? envelope["message"] : undefined;
    const timestamp = typeof envelope["ts"] === "number" ? envelope["ts"] : Date.now();

    return {
        functionPath: `container:${container}`,
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
        throw Object.assign(new Error("runAs: `functionPath` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    if (functionPath.startsWith(ADMIN_FUNCTION_PREFIX)) {
        throw Object.assign(new Error("runAs: cannot target a reserved admin function"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    if (userId.trim() === "") {
        throw Object.assign(new Error("runAs: `userId` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    const rawArgs = args["args"];

    if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
        throw Object.assign(new Error("runAs: `args` must be an object"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    const rawIdentity = args["identity"];

    if (rawIdentity !== undefined && (typeof rawIdentity !== "object" || rawIdentity === null || Array.isArray(rawIdentity))) {
        throw Object.assign(new Error("runAs: `identity` must be an object"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
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
        throw Object.assign(new Error(`recordMail: ${message}`), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    };

    const { bcc, cc, from, headers, html, replyTo, subject, text, to } = args;

    if (typeof subject !== "string") {
        bad("`subject` must be a string");
    }

    const toOk = typeof to === "string" || (Array.isArray(to) && to.every((entry) => typeof entry === "string"));

    if (!toOk) {
        bad("`to` must be a string or string[]");
    }

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
        throw Object.assign(new Error("sendTestMail: `to` must be a string"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
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
        throw Object.assign(new Error("rankBefore: `table` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    if (index.trim() === "") {
        throw Object.assign(new Error("rankBefore: `index` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    // `partitionKey` is the encoded partition tuple — `""` is legitimate for a
    // rankIndex with no `partitionBy`, so only the type is enforced, not
    // non-emptiness.
    if (typeof args["partitionKey"] !== "string") {
        throw Object.assign(new Error("rankBefore: `partitionKey` must be a string"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    if (rowId.trim() === "") {
        throw Object.assign(new Error("rankBefore: `rowId` is required"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    if (!Array.isArray(args["sortValues"])) {
        throw Object.assign(new Error("rankBefore: `sortValues` must be an array"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    return { index, partitionKey: args["partitionKey"], rowId, sortValues: args["sortValues"], table };
};

/** Throw a uniform 400 `LunoraError` for a malformed admin payload field. */
const badRequest = (message: string): never => {
    throw Object.assign(new Error(message), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
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
        throw Object.assign(new Error("applyCdc: `changes` must be an array"), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
    }

    const changes = raw.map((entry, index): CdcChange => {
        const record = entry as Record<string, unknown>;
        const { op } = record;
        const table = typeof record["table"] === "string" ? record["table"] : "";
        const id = typeof record["id"] === "string" ? record["id"] : "";

        if (table === "" || id === "" || (op !== "insert" && op !== "update" && op !== "delete")) {
            throw Object.assign(new Error(`applyCdc: changes[${String(index)}] must have a table, id, and op of insert|update|delete`), {
                code: "BAD_REQUEST",
                name: "LunoraError",
                status: 400,
            });
        }

        const rawDocument = record["doc"];

        // `typeof [] === "object"`, so an explicit Array.isArray guard is
        // required to keep arrays out of the writer (which expects a
        // Record). Failing here surfaces the malformed change at the parse
        // boundary instead of mid-replay.
        if (rawDocument !== undefined && (typeof rawDocument !== "object" || rawDocument === null || Array.isArray(rawDocument))) {
            throw Object.assign(new Error(`applyCdc: changes[${String(index)}].doc must be an object`), {
                code: "BAD_REQUEST",
                name: "LunoraError",
                status: 400,
            });
        }

        const document = rawDocument as Record<string, unknown> | undefined;

        // When the post-image carries an id it must agree with the entry id,
        // otherwise the replay would write a row whose id contradicts the CDC
        // cursor — reject the inconsistency at the boundary.
        if (document !== undefined && typeof document["_id"] === "string" && document["_id"] !== id) {
            throw Object.assign(new Error(`applyCdc: changes[${String(index)}].doc._id must match the entry id`), {
                code: "BAD_REQUEST",
                name: "LunoraError",
                status: 400,
            });
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

const jsonResponse = (body: unknown, status = 200, bookmark?: string): Response => {
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (bookmark) {
        headers["x-d1-bookmark"] = bookmark;
    }

    return Response.json(body, { headers, status });
};

/**
 * Decode the JSON envelope shipped on the `x-lunora-identity` header.
 * Malformed payloads collapse to `undefined` rather than throwing — the
 * shard should still serve requests whose identity claims didn't round-trip.
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

/** Parse a positive-integer env override (e.g. `LUNORA_REQUEST_LOG_RETENTION`); `undefined` when unset/invalid so the caller keeps its default. */
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
 * Constant-time string equality. Compares full length (capped at the longer
 * input) so a shorter candidate can't short-circuit the loop. The
 * `lengthDiff` term folds a length mismatch into the result so unequal-length
 * strings still take the same number of XOR ops as equal-length ones.
 *
 * Keep in sync with `packages/runtime/src/create-worker.ts` constantTimeEqual —
 * the two packages don't import from each other to avoid a circular dep.
 */
const constantTimeEqual = (a: string, b: string): boolean => {
    const max = Math.max(a.length, b.length);
    // eslint-disable-next-line no-bitwise -- constant-time compare folds length + every code-unit delta into one accumulator
    let diff = a.length ^ b.length;

    for (let index = 0; index < max; index += 1) {
        // charCodeAt returns NaN past the end of the string; coerce to 0
        // so the XOR still folds into `diff` without poisoning it.
        // eslint-disable-next-line unicorn/prefer-code-point -- compare per UTF-16 code unit so timing stays independent of surrogate boundaries
        const charA = index < a.length ? a.charCodeAt(index) : 0;
        // eslint-disable-next-line unicorn/prefer-code-point -- compare per UTF-16 code unit so timing stays independent of surrogate boundaries
        const charB = index < b.length ? b.charCodeAt(index) : 0;

        // eslint-disable-next-line no-bitwise -- accumulate per-code-unit difference without branching to keep the compare constant-time
        diff |= charA ^ charB;
    }

    return diff === 0;
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
     * Last pushed result per `(socket, subId)`, keyed by socket. Lets
     * `refreshSubscriptions` skip re-running queries whose tables were
     * untouched and suppress pushes when the re-run result is unchanged. Held
     * in memory only — it does not survive hibernation, which is safe: a cold
     * memo simply forces one re-run and (at most) one redundant push.
     */
    private readonly subMemos = new WeakMap<WebSocket, Map<string, SubscriptionMemo>>();

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

        this.armWebSocketKeepalive();
    }

    /** SQLite handle scoped to this Durable Object. */

    /**
     * Worker-side fetch entry point. Handles WebSocket upgrades and the
     * shard-local RPC endpoint forwarded by `@lunora/runtime`.
     */
    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade(request);
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
        this.currentRequestIdentity = parseIdentityHeader(request.headers.get("x-lunora-identity"));
        this.currentRequestSystem = request.headers.get("x-lunora-system") === "1";
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

                return jsonResponse(value, 200, this.currentResponseBookmark);
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
                this.recordFunctionCall(payload.functionPath, Date.now() - dispatchStartedAt, undefined, this.currentScannedTables, this.currentIndexHits);

                return jsonResponse({ result: cached.value }, 200, this.currentResponseBookmark);
            }

            const result = await this.handleRpc(payload.functionPath, payload.args ?? {});

            // Mutation-replay dedup WRITE: now that the handler's writes have
            // auto-committed, record the result against this request's
            // `(identity, mutationId)` so a replay of the same id short-circuits
            // through the cached-read check above. No-op for queries / legacy
            // clients (no `x-lunora-mutation-id` header).
            this.persistIdempotentResult(result);

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
            // bookmark captured by the handler is preserved verbatim.
            const response = jsonResponse({ result }, 200, this.currentResponseBookmark);

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

            this.recordFunctionCall(payload.functionPath, durationMs, message, this.currentScannedTables, this.currentIndexHits, conflicted);
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

            return this.errorToResponse(error);
        } finally {
            this.currentRequestBookmark = undefined;
            this.currentResponseBookmark = undefined;
            this.currentRequestUserId = undefined;
            this.currentRequestMutationId = undefined;
            this.currentRequestIdentity = undefined;
            this.currentRequestSystem = false;
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

            const status = this.subscribe(ws, envelope.id, envelope.query);

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
                await this.seedSubscription(ws, envelope.id, envelope.query, functionPath, isAdmin);
            }

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
            this.handleStream(ws, envelope.id, envelope.query.functionPath, envelope.query.args ?? {}).catch(() => {
                /* socket already gone; nothing to report */
            });

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

        // Clear the attachment so a future reconnection starts clean.
        (ws as HibernatableWebSocket).serializeAttachment?.(undefined);
    }

    /** Hibernation API: invoked on socket error. */
    // eslint-disable-next-line class-methods-use-this -- Workers hibernation handler: the platform invokes it on the instance; the signature must stay an instance method
    public webSocketError(_ws: WebSocket, _error: unknown): void {
        // Subclasses can override with proper logging. Avoid throwing.
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
        throw Object.assign(new Error("__lunora_relation__: no schema bound — the base ShardDO cannot serve cross-shard relation reads"), {
            code: "NOT_IMPLEMENTED",
            name: "LunoraError",
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
            throw Object.assign(new Error("nested transactions are not supported in SQLite-in-DO"), {
                code: "NESTED_TRANSACTION",
                name: "LunoraError",
                status: 500,
            });
        }

        const sqlHandle = this.state.storage.sql as TransactionSqlLike | undefined;

        if (!sqlHandle || typeof sqlHandle.exec !== "function") {
            throw Object.assign(new Error("storage.sql is not available on this ShardDO state"), {
                code: "SQL_UNAVAILABLE",
                name: "LunoraError",
                status: 500,
            });
        }

        // Capture `exec` into a const so the nested closure below doesn't
        // re-widen `sqlHandle.exec` to a possibly-undefined function via
        // the narrowing-loss control flow has after the guard.
        const sqlExec = sqlHandle.exec.bind(sqlHandle);

        // Raw `BEGIN`/`COMMIT` via `sqlHandle.exec` is not isolated from
        // concurrent fetch dispatch — a sibling RPC running between the
        // two would observe (or worse, write through) the open
        // transaction. `blockConcurrencyWhile` serializes ALL requests to
        // this DO for the duration of the callback, which is what we need
        // here. The cost is real: every concurrent reader stalls for the
        // length of the transaction, not just writers. This is fine for
        // the workloads SQLite-in-DO is built for (one DO per shard;
        // bounded concurrency by design), but if a future workload is
        // contention-sensitive we should migrate to `storage.transactionSync`
        // (the platform's native, properly-scoped transaction primitive)
        // and drop this gate.
        // TODO(perf): switch to `state.storage.transactionSync(...)` once
        // the workers-types definitions and our async-handler contract are
        // both compatible — that primitive is sync-only today.
        const run = async (): Promise<T> => {
            this.transactionDepth = 1;
            sqlExec("BEGIN");

            try {
                const value = await handler();

                sqlExec("COMMIT");

                return value;
            } catch (error) {
                try {
                    sqlExec("ROLLBACK");
                } catch {
                    // The rollback itself may fail if the connection is in a
                    // bad state — swallow it so the original error propagates.
                }

                throw error;
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
        return Promise.reject(
            Object.assign(new Error(`data migration "${args.id}" is not registered`), { code: "MIGRATION_NOT_FOUND", name: "LunoraError", status: 404 }),
        );
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
        return { mail: false, payments: false, scheduler: false, storage: false, vectors: false, workflows: false };
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
        return Promise.reject(Object.assign(new Error(`unknown table: ${args.table}`), { code: "UNKNOWN_TABLE", name: "LunoraError", status: 404 }));
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
        return Promise.reject(Object.assign(new Error(`unknown table: ${_table}`), { code: "UNKNOWN_TABLE", name: "LunoraError", status: 404 }));
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
        return Promise.reject(
            Object.assign(new Error("rankBefore is not implemented in base ShardDO"), { code: "NOT_IMPLEMENTED", name: "LunoraError", status: 500 }),
        );
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
        return Promise.reject(
            Object.assign(new Error("rankPage is not implemented in base ShardDO"), { code: "NOT_IMPLEMENTED", name: "LunoraError", status: 500 }),
        );
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
        try {
            const sql = this.sql as SqlExec;
            const present = sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, CDC_LOG_TABLE).toArray().length > 0;

            return present ? readCdcCursor(sql) : undefined;
        } catch {
            // Stub `sql` handle (test double) or a pre-CDC shard — no cursor to
            // advertise; the frame simply omits it.
            return undefined;
        }
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
    protected evaluateResume(sinceSeq: number, readSet: Set<string>): { cursor: number | undefined; resumable: boolean } {
        const sql = this.sql as SqlExec;
        let present: boolean;

        try {
            present = sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, CDC_LOG_TABLE).toArray().length > 0;
        } catch {
            // Stub `sql` handle (test double): can't prove the client is current,
            // so fall back to a full snapshot.
            return { cursor: undefined, resumable: false };
        }

        if (!present) {
            return { cursor: undefined, resumable: false };
        }

        const cursor = readCdcCursor(sql);

        // Client already at (or somehow past) the high-watermark: nothing newer
        // exists, so it is trivially current regardless of the read-set.
        if (sinceSeq >= cursor) {
            return { cursor, resumable: true };
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
            return { cursor, resumable: false };
        }

        // An empty read-set means we never recorded which tables the query
        // depends on (unknown deps), so we can't prove it was untouched — force
        // a full snapshot rather than resuming blindly on stale data.
        if (readSet.size === 0) {
            return { cursor, resumable: false };
        }

        // Resumable iff no table the query reads changed since `sinceSeq`. We
        // read the missed changes (bounded) and test intersection with the
        // read-set.
        const { changes } = readCdcChanges(sql, { limit: CDC_RESUME_SCAN_LIMIT, sinceSeq });

        // Cap hit: more than `CDC_RESUME_SCAN_LIMIT` changes accumulated since
        // `sinceSeq`, so a touching change may sit beyond the page we scanned.
        // We can't prove the read-set is untouched — force a full snapshot.
        if (changes.length >= CDC_RESUME_SCAN_LIMIT) {
            return { cursor, resumable: false };
        }

        const touchedReadSet = changes.some((change) => readSet.has(change.table));

        return { cursor, resumable: !touchedReadSet };
    }

    /**
     * Look up a previously-committed mutation for the in-flight request's
     * `(identity, mutationId)`. Returns `{ value }` (the cached, JSON-decoded
     * handler result) on a hit so the dispatch path can short-circuit, or
     * `undefined` when `mutationId` is absent (queries / legacy clients) or the
     * mutation has not run yet. Tolerates a stub `sql` handle without the dedup
     * table (returns a miss) so unit harnesses that skip migrations still work.
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
     * Called on the live dispatch path right after the handler's writes have
     * auto-committed, through the same `this.sql` handle, so the dedup row is
     * durable iff those writes are. (The DO has no ambient BEGIN/COMMIT around a
     * mutation — `handleRpc` invokes the user handler directly — so this can't
     * piggyback on a surrounding transaction; it commits as its own statement
     * immediately after.) `INSERT OR IGNORE` keeps a concurrent double-dispatch
     * of the same id idempotent. Also runs the throttled dedup-table GC.
     */
    protected persistIdempotentResult(result: unknown): void {
        if (this.currentRequestMutationId === undefined) {
            return;
        }

        const now = Date.now();

        try {
            // `JSON.stringify(undefined)` is `undefined`, not a string — a void
            // mutation must still cache a non-null `result_json`, so fall back to
            // the literal `"null"`. (`JSON.stringify` is typed `=> string`, hence
            // the disable: the `??` is load-bearing at runtime despite the type.)
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON.stringify(undefined) returns undefined at runtime
            writeIdempotent(this.sql as SqlExec, this.currentRequestUserId ?? "", this.currentRequestMutationId, JSON.stringify(result) ?? "null", now);

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
     * Replay a batch of CDC changes into this shard (point-in-time recovery).
     * Schema-aware — it builds a `createShardCtxDb` writer — so the base class
     * can't implement it; the codegen-generated subclass overrides this to call
     * `applyCdcChanges(writer, args.changes)`.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected runShardApplyCdc(_args: RunShardApplyCdcArgs): Promise<RunShardApplyCdcResult> {
        return Promise.reject(
            Object.assign(new Error("applyCdc is not implemented in base ShardDO"), { code: "NOT_IMPLEMENTED", name: "LunoraError", status: 500 }),
        );
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

                try {
                    ws.send(`{"type":"delta","id":${JSON.stringify(subId)},"delta":${deltaJson}}`);
                } catch {
                    /* socket may have been closed mid-broadcast */
                }
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
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to dispatch via the generated function map
    protected executeSubscription(_functionPath: string, _args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
        // eslint-disable-next-line unicorn/no-null -- base default: `null` = "no such subscription"; the codegen subclass overrides and also returns null
        return Promise.resolve(null);
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

        try {
            // Scope the cache entry to the caller's identity so a per-user /
            // RLS-filtered result is never served across users on a shared DO.
            // eslint-disable-next-line unicorn/no-null -- reactiveCacheKey's identity arg is `null | string`; null is the documented "anonymous caller" discriminator
            const result = await this.reactiveCache.run(reactiveCacheKey(functionPath, args, this.getCurrentUserId() ?? null), tracker.collect(), run);

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
    protected recordUserLog(functionPath: string, level: ContextLogLevel, args: unknown[], sink?: LogSink): void {
        // One canonical event built once, fed to all three destinations. Only the
        // console event drops `args` (see emitLogEvent); the buffer and sink get
        // the full payload.
        const event: LogEventInput = {
            args,
            functionPath,
            level,
            message: renderLogMessage(args),
            shardKey: this.state.id?.name,
            ts: Date.now(),
            userId: this.getCurrentUserId(),
        };

        // The LogBuffer enum has no distinct `log` level; fold it into `info`
        // (console.log is informational), keeping the panel's level set stable.
        this.logs.push({ functionPath, level: level === "log" ? "info" : level, message: event.message, timestamp: event.ts });

        try {
            emitLogEvent(event);
        } catch {
            // Best-effort: never let log emission fail the handler.
        }

        if (sink?.onLog) {
            try {
                sink.onLog(event);
            } catch {
                // A buggy log sink must not break the handler — see emitLogEvent.
            }
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
     * Run a subscription query body with the per-request identity forced to
     * anonymous, then restore the prior values.
     *
     * Subscriptions are established over the WS handshake, which does NOT
     * resolve identity, so a subscription query must never observe a
     * `currentRequestUserId` left behind by — or interleaved with — an
     * authenticated `fetch` RPC. Reading the shared identity field from a
     * deferred/cross-request context (subscribe SEED + write-driven REFRESH)
     * would otherwise leak one user's identity-scoped view to every
     * subscriber. The generated `buildCtx` reads identity via
     * `getCurrentUserId`, so we pin it to anonymous around the call
     * rather than threading it through the generated signature.
     *
     * Developer-facing consequence: a query that authorizes or filters on
     * the caller's identity — via `.use(rls(...))` or by reading
     * `ctx.auth.userId` directly — evaluates as ANONYMOUS over the live
     * channel. Its one-shot `fetch` RPC carries identity and returns the
     * user's rows, but the WS subscription (seed + every write-driven
     * refresh) runs here under anonymous identity, so it fails CLOSED: an
     * empty/denied result rather than another user's data (no leak), but a
     * silent correctness mismatch between the initial fetch and the live
     * updates. For per-user live data, scope it by shard (`.shardBy(...)`)
     * or pass the identifier as an explicit query arg instead of relying on
     * `ctx.auth` inside a subscribed query. See the lunora-realtime skill
     * ("Authorization & live queries").
     */
    private async withAnonymousIdentity<R>(run: () => Promise<R> | R): Promise<R> {
        return this.withRequestIdentity(undefined, undefined, run);
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
        // Structural duck-typing so this package does not need a runtime
        // dependency on `@lunora/values` or `@lunora/runtime`. The shapes
        // below are the public surface of those error types.
        if (error instanceof ConflictError) {
            return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
        }

        if (error && typeof error === "object" && (error as { name?: string }).name === "ValidationError") {
            const message = error instanceof Error ? error.message : "validation failed";

            return jsonResponse({ error: { code: "VALIDATION_ERROR", message } }, 400);
        }

        if (error && typeof error === "object" && (error as { name?: string }).name === "LunoraError") {
            const lunoraError = error as { code?: string; message?: string; status?: number };
            const status = typeof lunoraError.status === "number" ? lunoraError.status : 500;

            return jsonResponse({ error: { code: lunoraError.code ?? "INTERNAL", message: lunoraError.message ?? "internal error" } }, status);
        }

        const message = error instanceof Error ? error.message : "unknown error";

        return jsonResponse({ error: { code: "RPC_FAILED", message } }, 500);
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

        if (functionPath === ADMIN_FUNCTIONS.createWorkflowInstance) {
            return this.handleCreateWorkflowInstance(args);
        }

        if (functionPath === ADMIN_FUNCTIONS.getWorkflowInstanceStatus) {
            return this.handleGetWorkflowInstanceStatus(args);
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
     */
    private handleRecordContainerEvent(args: Record<string, unknown>): Response {
        const entry = parseRecordContainerEventArgs(args);

        this.logs.push(entry);

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
            throw Object.assign(new Error(`workflow "${exportName}" is not declared`), { code: "BAD_REQUEST", name: "LunoraError", status: 400 });
        }

        const binding = (this.env as Record<string, unknown> | undefined)?.[metadata.binding];

        if (
            typeof binding !== "object" ||
            binding === null ||
            typeof (binding as WorkflowBindingHandle).create !== "function" ||
            typeof (binding as WorkflowBindingHandle).get !== "function"
        ) {
            throw Object.assign(new Error(`workflow binding "${metadata.binding}" is not available on this deployment`), {
                code: "BAD_REQUEST",
                name: "LunoraError",
                status: 400,
            });
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
     * Run `run()` with the per-request identity pinned to (`userId`, `identity`),
     * then restore the prior values in a `finally` (even if `run()` throws), so the
     * forced identity can never leak into a later dispatch on this DO instance. The
     * generated `buildCtx` reads identity via `getCurrentUserId`/`getCurrentIdentity`,
     * so pinning the fields around the call makes the dispatched function observe the
     * chosen identity without threading it through the generated signature.
     *
     * This is the single save/restore primitive for the two callers:
     * {@link withAnonymousIdentity} (pins both to `undefined` — anonymous subscription
     * seeds) and {@link handleRunAs} (pins a forged user — the dev "Run as identity"
     * tool). The security-load-bearing invariant lives here, in one place.
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

        const writeOptions: RequestLogWriteOptions = { captureRaw: config.captureRaw, retention: config.retention };

        try {
            appendRequestLogEntry(this.state.storage.sql as unknown as SqlExec, entry, writeOptions);
        } catch {
            // Best-effort: never let request-log persistence fail the request.
        }

        // Errors are always streamed to `console` (rare, high-value — they ride
        // CF Workers Logs at error level and the dev-server formats them in the
        // terminal), redacted in prod like any other event. The full per-dispatch
        // summary stream (successful OKs too) stays opt-in behind
        // `LUNORA_REQUEST_LOG_EMIT` so a hot shard doesn't emit a line per call.
        if (config.emit || outcome === "error") {
            try {
                emitRequestLogEvent(entry, writeOptions);
            } catch {
                // Best-effort: never let event emission fail the request.
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
     */
    private readAdminDurableSignal(functionPath: string, sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } | undefined {
        if (functionPath === ADMIN_FUNCTIONS.getAuthMetrics) {
            return this.readAdminAuthMetrics(sql);
        }

        if (functionPath === ADMIN_FUNCTIONS.getCapturedMail) {
            return this.readAdminCapturedMail(sql, args);
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

                ws.send(JSON.stringify({ data: chunk, id, type: "chunk" }));
            }

            if (!controller.signal.aborted) {
                ws.send(JSON.stringify({ id, type: "complete" }));
            }
        } catch (error: unknown) {
            const { code } = error as { code?: string };
            const message = error instanceof Error ? error.message : String(error);

            ws.send(
                JSON.stringify({
                    error: { code: typeof code === "string" ? code : "INTERNAL_SERVER_ERROR", message },
                    id,
                    type: "error",
                }),
            );
        } finally {
            cancellers.delete(id);
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

        // Subscription re-execution runs anonymously (see
        // `withAnonymousIdentity`, applied around every executeSubscription
        // call below). The shared identity field is no longer cleared here —
        // clobbering it without restore could disturb an interleaved fetch RPC;
        // the per-call wrapper pins anonymous identity for exactly the
        // subscription body instead.

        if (typeof this.state.waitUntil === "function") {
            this.state.waitUntil(this.refreshSubscriptions(changed));

            return;
        }

        await this.refreshSubscriptions(changed);
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
     * {@link ReactiveCache} (`ShardDOOptions.reactiveCache`). Refreshes run under
     * {@link ShardDO.withAnonymousIdentity}, so the cache key
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

        const refreshOne = async (ws: WebSocket): Promise<void> => {
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
                    const outcome = isAdmin
                        ? this.executeAdminSubscription(functionPath, query.args ?? {})
                        : // eslint-disable-next-line no-await-in-loop -- subscriptions on a socket re-run sequentially; each shares the single SQLite handle
                          await this.withAnonymousIdentity(() => this.executeSubscription(functionPath, query.args ?? {}));

                    if (!outcome) {
                        continue;
                    }

                    this.pushSubscriptionData(ws, subId, outcome, frameCursor);
                } catch {
                    // A throwing subscription must not abort the refresh of its
                    // siblings, nor fail the mutation that triggered it. The memo
                    // is left untouched ("unknown deps"), so this subscription
                    // re-runs on the next flush.
                    /* refresh error contained to this subscription */ continue;
                }
            }
        };

        // Bounded fan-out: at most 8 sockets refresh in parallel. Larger
        // batches don't help (subscription handlers spend their time on
        // SQLite, which is single-threaded inside the DO) and risk
        // exhausting the I/O budget.
        const concurrency = 8;
        let cursor = 0;
        const worker = async (): Promise<void> => {
            let socket = sockets[cursor];

            cursor += 1;

            while (socket !== undefined) {
                // eslint-disable-next-line no-await-in-loop -- each worker drains the shared cursor sequentially; parallelism comes from running `concurrency` workers
                await refreshOne(socket);
                socket = sockets[cursor];
                cursor += 1;
            }
        };

        await Promise.all(Array.from({ length: Math.min(concurrency, sockets.length) }, () => worker()));
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
        const outcome = isAdmin
            ? this.executeAdminSubscription(functionPath, seedArgs)
            : await this.withAnonymousIdentity(() => this.executeSubscription(functionPath, seedArgs));

        if (!outcome) {
            return;
        }

        const { sinceSeq } = query;
        const resume = isAdmin || sinceSeq === undefined ? undefined : this.evaluateResume(sinceSeq, outcome.tables);

        if (resume?.resumable) {
            // Keep the per-socket baseline current (so the next change diffs
            // cleanly) but send only the cursor — the client already holds an
            // equivalent value at `sinceSeq`.
            this.seedSubscriptionMemo(ws, subId, outcome);

            try {
                ws.send(`{"type":"resume","id":${JSON.stringify(subId)},"cursor":${String(resume.cursor ?? 0)}}`);
            } catch {
                /* socket may have closed between the ack and this seed */
            }

            return;
        }

        this.pushSubscriptionData(ws, subId, outcome, resume?.cursor ?? this.currentCdcCursor());
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
        memos.set(subId, { lastJson: JSON.stringify(outcome.result ?? null), tables: outcome.tables });
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
    private pushSubscriptionData(ws: WebSocket, subId: string, outcome: SubscriptionOutcome, cursor?: number): void {
        let memos = this.subMemos.get(ws);

        if (!memos) {
            memos = new Map<string, SubscriptionMemo>();
            this.subMemos.set(ws, memos);
        }

        const cursorSuffix = cursor === undefined ? "" : `,"cursor":${String(cursor)}`;

        // eslint-disable-next-line unicorn/no-null -- WS frame payload: an undefined result serializes to JSON null so the delta frame carries an explicit value
        const json = JSON.stringify(outcome.result ?? null);
        const existing = memos.get(subId);

        if (existing?.lastJson === json) {
            existing.tables = outcome.tables;

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

        memos.set(subId, { lastJson: json, tables: outcome.tables });

        if (deltas !== undefined) {
            const idJson = JSON.stringify(subId);

            for (const deltaBody of deltaFrames) {
                try {
                    ws.send(`{"type":"delta","id":${idJson},"delta":${deltaBody}${cursorSuffix}}`);
                } catch {
                    /* socket may have been closed mid-flush */
                }
            }

            return;
        }

        try {
            ws.send(`{"type":"data","id":${JSON.stringify(subId)},"data":${json}${cursorSuffix}}`);
        } catch {
            /* socket may have been closed between checks */
        }
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
     * secret.
     */
    private isUpgradeAllowed(request: Request): boolean {
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

            // The admin token is accepted as an alternate credential so a
            // studio can open its socket even when `LUNORA_WS_BEARER` gates
            // ordinary subscribers. The socket is flagged admin separately (see
            // `isAdminSocket`); matching the bearer alone never grants it.
            if (!supplied || (!constantTimeEqual(supplied, expectedBearer) && !this.isAdminSocket(request))) {
                return false;
            }
        }

        return true;
    }

    /**
     * Token presented on a WS upgrade: the `Authorization: Bearer` header when
     * present, else the `?token=` query parameter (the only channel a browser
     * `WebSocket` constructor can use). Returns `undefined` when neither is set.
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
     * Whether the upgrade presented a token matching `LUNORA_ADMIN_TOKEN`,
     * constant-time compared. Closed (returns `false`) when the admin token is
     * unset, mirroring `isAdminAuthorized` for the HTTP path so admin
     * streaming is opt-in rather than exposed by default.
     */
    private isAdminSocket(request: Request): boolean {
        const env = (this.env ?? {}) as { LUNORA_ADMIN_TOKEN?: string };
        const adminToken = env.LUNORA_ADMIN_TOKEN;

        if (!adminToken || adminToken.length === 0) {
            return false;
        }

        const supplied = this.suppliedWsToken(request);

        return supplied !== undefined && constantTimeEqual(supplied, adminToken);
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

    private handleWebSocketUpgrade(request: Request): Response {
        if (!this.isUpgradeAllowed(request)) {
            return new Response("Forbidden", { status: 403 });
        }

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

        // Stamp admin authorization onto the socket at upgrade so later
        // `__lunora_admin__:*` subscribe envelopes (which carry no credential of
        // their own) can be gated without re-checking a token per message.
        (server as HibernatableWebSocket).serializeAttachment?.({
            admin: this.isAdminSocket(request),
            connectionId: crypto.randomUUID(),
            subs: {},
            ...(identity === undefined ? {} : { identity }),
            ...(userId === undefined ? {} : { userId }),
        } satisfies SocketAttachment);

        // eslint-disable-next-line unicorn/no-null -- Web Response body for a 101 upgrade is `BodyInit | null`; null is the standard "no body" value
        return new Response(null, { status: 101, webSocket: client });
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

export { ROOT_DO_SIZE_WARN_BYTES, ROOT_SHARD_NAME, ShardDO, subscriptionListDeltas };
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
