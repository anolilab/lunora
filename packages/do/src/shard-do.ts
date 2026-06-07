import type { DurableObjectStorage } from "@cloudflare/workers-types";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { drizzle as drizzleDO } from "drizzle-orm/durable-sqlite";

import type { ExportRow, ImportShardResult } from "./admin-export-import.js";
import { parseExportShardArgs, parseImportShardArgs } from "./admin-export-import.js";
import { appendAuditEntry, ensureAuditTable, readAuditLog } from "./audit-log.js";
import type { CdcChange, SqlExec } from "./ctx-db.js";
import { CDC_LOG_TABLE, readCdcChanges } from "./ctx-db.js";
import type { MigrationDirection, MigrationRunResult } from "./data-migration.js";
import { DATA_MIGRATION_STATE_TABLE, readMigrationStatus } from "./data-migration.js";
import type { DependencyTracker } from "./dependency-tracker.js";
import { createDependencyTracker, SCAN_DEP } from "./dependency-tracker.js";
import type { FunctionMetricBucket } from "./function-metrics.js";
import { readFunctionMetricBuckets, readFunctionMetrics, readFunctionMetricsTotals, recordFunctionMetric } from "./function-metrics.js";
import type { AuditLogResult, FilterClause, FilterOperator, FunctionCallStat, FunctionStatsResult, TableIndexInfo } from "./introspect.js";
import { ADMIN_FUNCTION_PREFIX, ADMIN_FUNCTIONS, listTables, readTablePage, selectMatchingIds } from "./introspect.js";
import { LogBuffer } from "./log-buffer.js";
import { armRestore, readBookmark } from "./pitr.js";
import type { ReactiveCacheOptions } from "./reactive-cache.js";
import { ReactiveCache, reactiveCacheKey } from "./reactive-cache.js";
import { buildSettings } from "./settings.js";
import type { TransactionSqlLike } from "./transaction.js";
import { ConflictError } from "./transaction.js";
import type { MutationDelta, RpcRequest, SocketAttachment, SubscriptionEnvelope, SubscriptionQuery } from "./types.js";

/**
 * Client→server text frame the runtime answers with {@link WS_KEEPALIVE_PONG}
 * via the DO Hibernation API's auto-response — see {@link ShardDO.armWebSocketKeepalive}.
 * The exchange never wakes the Durable Object, so an idle subscription socket
 * stays alive across hibernation without a billable request. Clients send this
 * payload on their heartbeat instead of an app-level ping.
 */
const WS_KEEPALIVE_PING = "cirrus-ping";
/** Canned reply the runtime returns for {@link WS_KEEPALIVE_PING}; never reaches a message handler. */
const WS_KEEPALIVE_PONG = "cirrus-pong";

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
     * land via the ctx-db write hooks (`@cirrus/do`'s `createShardCtxDb`
     * `cache` option) BEFORE the broadcast goes out, so subscribers that
     * re-run their queries in response always observe the post-write state.
     */
    reactiveCache?: ReactiveCacheOptions;
}

/** Arguments accepted by the `__cirrus_admin__:runMigration` admin RPC. */
interface RunShardMigrationArgs {
    batchSize?: number;
    direction?: MigrationDirection;
    dryRun?: boolean;
    id: string;
    maxBatches?: number;
}

/** Arguments accepted by the `__cirrus_admin__:exportShard` admin RPC. */
interface RunShardExportArgs {
    batchSize?: number;
    tables?: ReadonlyArray<string>;
}

/** Arguments accepted by the `__cirrus_admin__:importShard` admin RPC. */
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
 * Arguments accepted by the `__cirrus_admin__:rankBefore` admin RPC. The query
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

/** Per-subscription memo used to suppress no-op pushes. */
interface SubscriptionMemo {
    lastJson: string;
    tables: Set<string>;
}

/** Identity field every Cirrus document row carries. */
const ROW_ID_FIELD = "_id";

/**
 * Fallback table name stamped on a delta when the subscription's read-table
 * set is empty. The client only uses `table` for its structural guard
 * ({@link MutationDelta} recognition) — `key`/`row`/`op` drive the actual
 * merge — so any non-empty string is safe.
 */
const DELTA_FALLBACK_TABLE = "__cirrus__";

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
 * full new `row`; delete omits it (matching the wire contract `@cirrus/client`
 * parses). Deltas are ordered deletes-then-inserts/updates so the client never
 * sees a transient over-length page.
 */
const subscriptionListDeltas = (previousJson: string, nextResult: unknown, table: string): MutationDelta[] | undefined => {
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
    const deletes: MutationDelta[] = [];
    const upserts: MutationDelta[] = [];

    for (const id of previous.order) {
        if (!next.byId.has(id)) {
            deletes.push({ key: id, op: "delete", table: deltaTable });
        }
    }

    for (const id of next.order) {
        const nextRow = next.byId.get(id) as Record<string, unknown>;
        const previousRow = previous.byId.get(id);

        if (previousRow === undefined) {
            upserts.push({ key: id, op: "insert", row: nextRow, table: deltaTable });
        } else if (JSON.stringify(previousRow) !== JSON.stringify(nextRow)) {
            upserts.push({ key: id, op: "update", row: nextRow, table: deltaTable });
        }
    }

    const deltas = [...deletes, ...upserts];

    // (5): a near-total change is better sent as a single snapshot.
    return deltas.length > next.order.length ? undefined : deltas;
};

/**
 * Threshold at which a `__root__` DO triggers the size warning. 1 GiB —
 * exactly 10% of the 10 GiB per-DO SQLite ceiling, leaving plenty of runway
 * to plan a `.shardBy()` migration before the wall hits.
 */
const ROOT_DO_SIZE_WARN_BYTES = 1_073_741_824;

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
        throw Object.assign(new Error("runMigration: `id` is required"), { code: "MIGRATION_ID_REQUIRED", name: "CirrusError", status: 400 });
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
 * tells the caller to loop. Matches `readTablePage`'s `MAX_PAGE_SIZE` so one
 * "delete matching" batch drains exactly one full preview page's worth of rows.
 */
const SHARD_BULK_DELETE_CAP = 500;

/**
 * Validate the `__cirrus_admin__:writeRow` payload. Enforces that `id` is
 * present for ops that target an existing row and that `doc` is present for ops
 * that carry one, throwing a 400 `CirrusError` otherwise — the writer would
 * reject these too, but failing here keeps the error shape uniform.
 */
const parseWriteRowArgs = (args: Record<string, unknown>): RunShardWriteArgs => {
    const { op } = args;
    const table = typeof args["table"] === "string" ? args["table"] : "";

    if (op !== "insert" && op !== "patch" && op !== "replace" && op !== "delete") {
        throw Object.assign(new Error("writeRow: `op` must be insert|patch|replace|delete"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    if (table.trim() === "") {
        throw Object.assign(new Error("writeRow: `table` is required"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    const id = typeof args["id"] === "string" ? args["id"] : undefined;
    const record =
        typeof args["doc"] === "object" && args["doc"] !== null && !Array.isArray(args["doc"]) ? (args["doc"] as Record<string, unknown>) : undefined;

    if (op !== "insert" && (id === undefined || id === "")) {
        throw Object.assign(new Error(`writeRow: \`id\` is required for op "${op}"`), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    if (op !== "delete" && record === undefined) {
        throw Object.assign(new Error(`writeRow: \`doc\` is required for op "${op}"`), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    return { doc: record, id, op, table };
};

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
 * Validate the `__cirrus_admin__:deleteRows` payload. `table` must be a
 * non-empty string; `filters`/`search` mirror `readTablePage`'s predicate args
 * (so "delete matching" removes exactly the previewed rows) and a numeric
 * `limit` passes through to be clamped against {@link SHARD_BULK_DELETE_CAP}.
 * Throws a 400 `CirrusError` on a missing table, keeping the error shape uniform.
 */
const parseBulkDeleteArgs = (args: Record<string, unknown>): RunShardBulkDeleteArgs => {
    const table = typeof args["table"] === "string" ? args["table"] : "";

    if (table.trim() === "") {
        throw Object.assign(new Error("deleteRows: `table` is required"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    return {
        filters: parseTablePageFilters(args["filters"]),
        limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
        search: typeof args["search"] === "string" ? args["search"] : undefined,
        table,
    };
};

/**
 * Validate the `__cirrus_admin__:clearTable` payload — the "empty this table"
 * action. Only `table` is meaningful (clearTable carries no predicate: it
 * matches every row); a numeric `limit` passes through for the per-call cap.
 * Throws a 400 `CirrusError` on a missing table.
 */
const parseClearTableArgs = (args: Record<string, unknown>): RunShardBulkDeleteArgs => {
    const table = typeof args["table"] === "string" ? args["table"] : "";

    if (table.trim() === "") {
        throw Object.assign(new Error("clearTable: `table` is required"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    return { limit: typeof args["limit"] === "number" ? args["limit"] : undefined, table };
};

/**
 * Validate the `__cirrus_admin__:rankBefore` payload. `table`, `index`,
 * `partitionKey`, and `rowId` must be non-empty strings and `sortValues` must
 * be an array; anything else throws a 400 `CirrusError` so the cross-shard
 * coordinator surfaces a uniform error rather than a downstream SQL failure.
 */
const parseRankBeforeArgs = (args: Record<string, unknown>): RunShardRankBeforeArgs => {
    const table = typeof args["table"] === "string" ? args["table"] : "";
    const index = typeof args["index"] === "string" ? args["index"] : "";
    const rowId = typeof args["rowId"] === "string" ? args["rowId"] : "";

    if (table.trim() === "") {
        throw Object.assign(new Error("rankBefore: `table` is required"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    if (index.trim() === "") {
        throw Object.assign(new Error("rankBefore: `index` is required"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    // `partitionKey` is the encoded partition tuple — `""` is legitimate for a
    // rankIndex with no `partitionBy`, so only the type is enforced, not
    // non-emptiness.
    if (typeof args["partitionKey"] !== "string") {
        throw Object.assign(new Error("rankBefore: `partitionKey` must be a string"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    if (rowId.trim() === "") {
        throw Object.assign(new Error("rankBefore: `rowId` is required"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    if (!Array.isArray(args["sortValues"])) {
        throw Object.assign(new Error("rankBefore: `sortValues` must be an array"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    return { index, partitionKey: args["partitionKey"], rowId, sortValues: args["sortValues"], table };
};

/** Arguments accepted by the `__cirrus_admin__:cdcSync` admin RPC. */
interface RunShardCdcSyncArgs {
    limit?: number;
    sinceSeq: number;
}

/** Arguments accepted by the `__cirrus_admin__:applyCdc` admin RPC. */
interface RunShardApplyCdcArgs {
    changes: ReadonlyArray<CdcChange>;
}

/** Result of an `applyCdc` replay batch. */
interface RunShardApplyCdcResult {
    applied: number;
}

/**
 * Validate the `__cirrus_admin__:applyCdc` payload. `changes` must be an array
 * of CDC entries (`{ table, id, op, doc? }`); each is shape-checked just enough
 * to reject obvious garbage before it reaches the writer.
 */
const parseApplyCdcArgs = (args: Record<string, unknown>): RunShardApplyCdcArgs => {
    const raw = args["changes"];

    if (!Array.isArray(raw)) {
        throw Object.assign(new Error("applyCdc: `changes` must be an array"), { code: "BAD_REQUEST", name: "CirrusError", status: 400 });
    }

    const changes = raw.map((entry, index): CdcChange => {
        const record = entry as Record<string, unknown>;
        const { op } = record;
        const table = typeof record["table"] === "string" ? record["table"] : "";
        const id = typeof record["id"] === "string" ? record["id"] : "";

        if (table === "" || id === "" || (op !== "insert" && op !== "update" && op !== "delete")) {
            throw Object.assign(new Error(`applyCdc: changes[${String(index)}] must have a table, id, and op of insert|update|delete`), {
                code: "BAD_REQUEST",
                name: "CirrusError",
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
                name: "CirrusError",
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
                name: "CirrusError",
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
 * Validate the `__cirrus_admin__:cdcSync` payload. `sinceSeq` is the caller's
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
 * Decode the JSON envelope shipped on the `x-cirrus-identity` header.
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
     * 8 is generous for legitimate clients (the dashboard rarely opens more
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
     * `x-cirrus-userid` header. Surfaced to handlers via
     * `getCurrentUserId`. Cleared in the `finally` block of `fetch`
     * so a stale identity from a previous client never leaks into the
     * next request.
     */
    private currentRequestUserId: string | undefined;

    /**
     * Per-request identity envelope forwarded from the runtime via the
     * `x-cirrus-identity` JSON header. Stores claims like `email`,
     * `name`, or custom roles populated by `resolveIdentity` on the
     * worker. Surfaced to handlers via `getCurrentIdentity`.
     */
    private currentRequestIdentity: Record<string, unknown> | undefined;

    /**
     * Whether the in-flight `/rpc` call is a trusted server-initiated dispatch
     * (scheduler/cron), signalled by the `x-cirrus-system` header that only the
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
     * Lifetime request counters surfaced by the `__cirrus_admin__:getMetrics`
     * RPC. In-memory only — they reset when the DO hibernates or restarts, which
     * is the right granularity for a "since this instance woke" health readout
     * (durable aggregation would be a separate, heavier feature).
     */
    private readonly metrics = { errors: 0, requests: 0, sinceMs: Date.now() };

    /**
     * Per-function execution counters surfaced by the
     * `__cirrus_admin__:getFunctionStats` RPC, keyed by `&lt;file>:&lt;function>`
     * path. Shares the `metrics` lifecycle: in-memory, reset on
     * hibernation/restart. The map is naturally bounded by the app's registered
     * function count (a finite set), so no eviction is needed. Maintained by
     * `recordFunctionCall` at the one dispatch site that also bumps the
     * aggregate `metrics` counters.
     */
    private readonly functionStats = new Map<string, FunctionCallStat>();

    /**
     * Recent RPC errors on this shard instance, surfaced by the
     * `__cirrus_admin__:getLogs` RPC. In-memory only and bounded — like
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
     * `__cirrus_metrics_scans` attribution can pin a slow function to the
     * table(s) it scanned. Independent of `currentTracker` (which only exists
     * when the reactive cache is enabled), so the causal signal is collected
     * even on a cache-less shard. Stamped by `getCtxDbReadHook`.
     */
    private currentScannedTables: Set<string> | undefined;

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
     * shard-local RPC endpoint forwarded by `@cirrus/runtime`.
     */
    public async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (request.headers.get("Upgrade") === "websocket") {
            return this.handleWebSocketUpgrade(request);
        }

        if (url.pathname === "/rpc" && request.method === "POST") {
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
            this.currentRequestUserId = request.headers.get("x-cirrus-userid") ?? undefined;
            this.currentRequestIdentity = parseIdentityHeader(request.headers.get("x-cirrus-identity"));
            this.currentRequestSystem = request.headers.get("x-cirrus-system") === "1";

            this.metrics.requests += 1;
            const dispatchStartedAt = Date.now();

            // Collect the tables this dispatch full-scans (stamped by the
            // ctx-db read hook) so `recordFunctionCall` can persist the causal
            // attribution. Fresh per request; drained below.
            this.currentScannedTables = new Set<string>();

            try {
                const result = await this.handleRpc(payload.functionPath, payload.args ?? {});

                // Record the handler's own latency (before the subscription
                // write-flush below) against the per-function counters, along
                // with any tables it full-scanned (causal attribution).
                this.recordFunctionCall(payload.functionPath, Date.now() - dispatchStartedAt, undefined, this.currentScannedTables);

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
                const message = error instanceof Error ? error.message : String(error);

                this.recordFunctionCall(payload.functionPath, Date.now() - dispatchStartedAt, message, this.currentScannedTables);
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
                this.currentRequestIdentity = undefined;
                this.currentRequestSystem = false;
                this.currentScannedTables = undefined;
            }
        }

        return new Response("Not found", { status: 404 });
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

        if (envelope.type === "subscribe" && envelope.query) {
            const { functionPath } = envelope.query;
            const isAdmin = functionPath?.startsWith(ADMIN_FUNCTION_PREFIX) === true;

            // Admin introspection subscriptions read shard internals (raw rows,
            // metrics, logs), so they are gated by the same `CIRRUS_ADMIN_TOKEN`
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
                const seedArgs = envelope.query.args ?? {};
                const outcome = isAdmin
                    ? this.executeAdminSubscription(functionPath, seedArgs)
                    : await this.withAnonymousIdentity(() => this.executeSubscription(functionPath, seedArgs));

                if (outcome) {
                    this.pushSubscriptionData(ws, envelope.id, outcome);
                }
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
    // eslint-disable-next-line @typescript-eslint/require-await -- Workers hibernation handler: the platform invokes/awaits it; the signature must stay async even though this body is synchronous
    public async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
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
    protected get sql(): unknown {
        return this.state.storage.sql;
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
     * Nested calls are refused with a `CirrusError`-shaped object — SQLite
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
                name: "CirrusError",
                status: 500,
            });
        }

        const sqlHandle = this.state.storage.sql as TransactionSqlLike | undefined;

        if (!sqlHandle || typeof sqlHandle.exec !== "function") {
            throw Object.assign(new Error("storage.sql is not available on this ShardDO state"), {
                code: "SQL_UNAVAILABLE",
                name: "CirrusError",
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
     * client RPC (which never carries the `x-cirrus-system` header).
     */
    protected isSystemDispatch(): boolean {
        return this.currentRequestSystem;
    }

    /**
     * Run a data migration by id against this shard, returning the runner's
     * result. The base class can't reach the project's generated
     * `CIRRUS_MIGRATIONS` registry or build a schema-aware writer, so it reports
     * the migration as unknown; the codegen-generated subclass overrides this to
     * look the migration up and invoke `runDataMigration`.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to reach the generated migration registry
    protected runShardDataMigration(args: RunShardMigrationArgs): Promise<MigrationRunResult> {
        return Promise.reject(
            Object.assign(new Error(`data migration "${args.id}" is not registered`), { code: "MIGRATION_NOT_FOUND", name: "CirrusError", status: 404 }),
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
     * the schema viewer via `__cirrus_admin__:listTableIndexes`. Like
     * {@link tableRefs}, the base class can't see the user's `schema.ts`, so it
     * reports none; the codegen subclass overrides this with the schema-derived
     * list. Schema-sourced rather than read from SQLite because cirrus's physical
     * indexes are `json_extract` expressions whose field names PRAGMA can't recover.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this to read the generated schema's index metadata
    protected tableIndexes(_table: string): TableIndexInfo[] {
        return [];
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
        return Promise.reject(Object.assign(new Error(`unknown table: ${args.table}`), { code: "UNKNOWN_TABLE", name: "CirrusError", status: 404 }));
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
        return Promise.reject(Object.assign(new Error(`unknown table: ${_table}`), { code: "UNKNOWN_TABLE", name: "CirrusError", status: 404 }));
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
            Object.assign(new Error("rankBefore is not implemented in base ShardDO"), { code: "NOT_IMPLEMENTED", name: "CirrusError", status: 500 }),
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
     * Replay a batch of CDC changes into this shard (point-in-time recovery).
     * Schema-aware — it builds a `createShardCtxDb` writer — so the base class
     * can't implement it; the codegen-generated subclass overrides this to call
     * `applyCdcChanges(writer, args.changes)`.
     */
    // eslint-disable-next-line class-methods-use-this -- base-class override hook: the codegen subclass overrides this and uses `this` to build a schema-aware writer
    protected runShardApplyCdc(_args: RunShardApplyCdcArgs): Promise<RunShardApplyCdcResult> {
        return Promise.reject(
            Object.assign(new Error("applyCdc is not implemented in base ShardDO"), { code: "NOT_IMPLEMENTED", name: "CirrusError", status: 500 }),
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

        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- `subs` is a Record keyed by dynamic subscription id; removal is the intended unsubscribe
        delete attachment.subs[subId];
        (ws as HibernatableWebSocket).serializeAttachment?.(attachment);
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
     * subclass overrides this to dispatch via `CIRRUS_FUNCTIONS`; the base
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

        try {
            // Scope the cache entry to the caller's identity so a per-user /
            // RLS-filtered result is never served across users on a shared DO.
            // eslint-disable-next-line unicorn/no-null -- reactiveCacheKey's identity arg is `null | string`; null is the documented "anonymous caller" discriminator
            return await this.reactiveCache.run(reactiveCacheKey(functionPath, args, this.getCurrentUserId() ?? null), tracker.collect(), run);
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

            if (idOrScan === undefined || idOrScan === SCAN_DEP) {
                this.currentScannedTables?.add(table);
            }
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
     */
    private async withAnonymousIdentity<R>(run: () => Promise<R> | R): Promise<R> {
        const previousUserId = this.currentRequestUserId;
        const previousIdentity = this.currentRequestIdentity;

        this.currentRequestUserId = undefined;
        this.currentRequestIdentity = undefined;

        try {
            return await run();
        } finally {
            this.currentRequestUserId = previousUserId;
            this.currentRequestIdentity = previousIdentity;
        }
    }

    /**
     * Emit a one-shot console warning when the `__root__` DO's SQLite file
     * crosses {@link ROOT_DO_SIZE_WARN_BYTES} (1 GiB = 10% of the per-DO
     * ceiling). We deliberately avoid throwing — apps should keep working;
     * the warning is the migration signal.
     */

    /**
     * Assemble the health snapshot served by `__cirrus_admin__:getMetrics`:
     * lifetime request/error counts, the live SQLite size, and (when an opt-in
     * reactive cache is configured) its hit/miss stats.
     *
     * `requests`/`errors` now report the **durable** lifetime totals from the
     * `__cirrus_metrics` table (source of truth) so they survive
     * hibernation/restart; the in-memory counters are used only as a fallback
     * when the durable read throws. The response is extended additively with
     * `functions` (per-function persisted rows) and `history` (the coarse
     * time-series buckets) so the dashboard can read durable per-function
     * metrics and chart history without breaking the existing fields.
     */
    private collectMetrics(): {
        cache: null | { bytes: number; entries: number; evictions: number; hits: number; misses: number };
        databaseSize: null | number;
        errors: number;
        functions: FunctionCallStat[];
        history: (FunctionMetricBucket & { path: string })[];
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

        return {
            // eslint-disable-next-line unicorn/no-null -- metrics wire shape: `cache` is `null | {...}`, null reported when the reactive cache is disabled
            cache: this.reactiveCache ? this.reactiveCache.stats() : null,
            // eslint-disable-next-line unicorn/no-null -- metrics wire shape: `databaseSize` is `null | number`, null when the runtime doesn't expose a size
            databaseSize: typeof size === "number" ? size : null,
            errors,
            functions: this.collectFunctionStats().functions,
            history: this.collectFunctionMetricBuckets(),
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
     * `getCtxDbReadHook`), which advance the causal scan attribution. Called
     * once per `/rpc` dispatch alongside the aggregate `metrics` update.
     *
     * Two writes happen here. The in-memory {@link functionStats} map is kept
     * for the fast warm-instance path, and the durable `__cirrus_metrics`
     * table is upserted so the counters survive hibernation/restart — the
     * persisted table is the source of truth the admin RPCs read from. The
     * persist is best-effort: a SQL failure (e.g. a test double without a
     * `sql` handle) must never turn a successful dispatch into a failed one,
     * so it is swallowed and the in-memory counters still advance.
     */
    private recordFunctionCall(functionPath: string, durationMs: number, errorMessage?: string, scannedTables?: ReadonlySet<string>): void {
        const now = Date.now();
        const scanned = scannedTables ? [...scannedTables] : [];

        // Durable upsert on the hot path: two PK-keyed INSERT…ON CONFLICT
        // statements plus a bounded bucket trim, plus one upsert per scanned
        // table. Survives restart/hibernation.
        try {
            recordFunctionMetric(this.state.storage.sql as unknown as SqlExec, {
                durationMs,
                errored: errorMessage !== undefined,
                errorMessage,
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
        // the causal data too. One distinct table = one scan; per-table counts
        // accumulate in `scannedTables`, re-sorted busiest-first.
        if (scanned.length > 0) {
            stat.scans += scanned.length;

            for (const table of scanned) {
                const entry = stat.scannedTables.find((attribution) => attribution.table === table);

                if (entry === undefined) {
                    stat.scannedTables.push({ scans: 1, table });
                } else {
                    entry.scans += 1;
                }
            }

            stat.scannedTables.sort((a, b) => b.scans - a.scans || a.table.localeCompare(b.table));
        }

        if (errorMessage !== undefined) {
            stat.errors += 1;
            stat.lastErrorAt = now;
            stat.lastErrorMessage = errorMessage;
        }

        if (existing === undefined) {
            this.functionStats.set(functionPath, stat);
        }
    }

    /**
     * Assemble the per-function readout served by
     * `__cirrus_admin__:getFunctionStats`, sorted most-recently-called first so
     * the busiest functions surface at the top of the dashboard table.
     *
     * Reads from the durable `__cirrus_metrics` table — the source of truth —
     * so the counts reflect the function's lifetime, not just calls since this
     * instance woke. Falls back to the in-memory map only if the durable read
     * throws (e.g. a test double without a usable `sql` handle), keeping the
     * warm-instance counters available even then. The wire shape is unchanged
     * (`{ functions, sinceMs }`), so existing dashboard/runtime consumers keep
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
     * the dashboard can chart call/error history. Reads the durable
     * `__cirrus_metrics_buckets` table; returns `[]` when persistence is
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
            `[@cirrus/do] __root__ Durable Object SQLite size is ${String(size)} bytes (>= 1 GiB, 10% of the 10 GiB per-DO ceiling). Plan a \`.shardBy()\` migration before you hit the wall. See https://cirrus.dev/docs/concepts/sharding for guidance.`,
        );
    }

    /**
     * Map a thrown value to a JSON response. `ValidationError` from
     * `@cirrus/values` becomes a 400 with code `VALIDATION_ERROR`. A
     * `CirrusError` keeps its declared status/code. Everything else becomes
     * a 500 with code `RPC_FAILED`.
     */
    // eslint-disable-next-line class-methods-use-this -- cohesive DO instance method (groups with the request handlers); kept non-static so subclasses can override the error mapping
    private errorToResponse(error: unknown): Response {
        // Structural duck-typing so this package does not need a runtime
        // dependency on `@cirrus/values` or `@cirrus/runtime`. The shapes
        // below are the public surface of those error types.
        if (error instanceof ConflictError) {
            return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
        }

        if (error && typeof error === "object" && (error as { name?: string }).name === "ValidationError") {
            const message = error instanceof Error ? error.message : "validation failed";

            return jsonResponse({ error: { code: "VALIDATION_ERROR", message } }, 400);
        }

        if (error && typeof error === "object" && (error as { name?: string }).name === "CirrusError") {
            const cirrusError = error as { code?: string; message?: string; status?: number };
            const status = typeof cirrusError.status === "number" ? cirrusError.status : 500;

            return jsonResponse({ error: { code: cirrusError.code ?? "INTERNAL", message: cirrusError.message ?? "internal error" } }, status);
        }

        const message = error instanceof Error ? error.message : "unknown error";

        return jsonResponse({ error: { code: "RPC_FAILED", message } }, 500);
    }

    /**
     * Serve a reserved admin-introspection RPC (`__cirrus_admin__:*`) for the
     * data browser. Gated by `env.CIRRUS_ADMIN_TOKEN`: introspection is
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

            const pitr = await this.handlePitrAdminOp(functionPath, args);

            if (pitr) {
                return pitr;
            }

            return jsonResponse({ error: { code: "UNKNOWN_ADMIN_OP", message: `unknown admin op: ${functionPath}` } }, 404);
        } catch (error: unknown) {
            return this.errorToResponse(error);
        }
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
            this.state.abort?.("cirrus PITR restore");
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

        if (functionPath === ADMIN_FUNCTIONS.listTables) {
            return { result: listTables(sql), tables: new Set([ADMIN_WILDCARD]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.getMetrics) {
            return { result: this.collectMetrics(), tables: new Set([ADMIN_WILDCARD]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.getFunctionStats) {
            return { result: this.collectFunctionStats(), tables: new Set([ADMIN_WILDCARD]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.getAuditLog) {
            return this.readAdminAuditLog(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.getLogs) {
            return { result: { entries: this.logs.entries() }, tables: new Set([ADMIN_WILDCARD]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.getSettings) {
            // Read-only deployment config derived from the Worker `env` (the
            // bindings object). String values are masked server-side, so no raw
            // secret crosses the wire. Not bound to a table, so it carries the
            // wildcard like the other counter/config reads.
            return { result: buildSettings(this.env), tables: new Set([ADMIN_WILDCARD]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.readTablePage) {
            return this.readAdminTablePage(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.listTableIndexes) {
            const table = typeof args["table"] === "string" ? args["table"] : "";

            return { result: { indexes: this.tableIndexes(table) }, tables: new Set([table === "" ? ADMIN_WILDCARD : table]) };
        }

        if (functionPath === ADMIN_FUNCTIONS.migrationStatus) {
            const id = typeof args["id"] === "string" ? args["id"] : undefined;

            return { result: { migrations: readMigrationStatus(sql, id) }, tables: new Set([ADMIN_WILDCARD]) };
        }

        // eslint-disable-next-line unicorn/no-null -- `null` signals "not a recognized admin read", matching the subscription-outcome contract codegen subclasses implement
        return null;
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

    /** Resolve a `readTablePage` admin read, parsing the loosely-typed args into the reader's options. */
    private readAdminTablePage(sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } {
        const table = typeof args["table"] === "string" ? args["table"] : "";
        const page = readTablePage(sql, {
            filters: parseTablePageFilters(args["filters"]),
            limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
            offset: typeof args["offset"] === "number" ? args["offset"] : undefined,
            refs: this.tableRefs(table),
            search: typeof args["search"] === "string" ? args["search"] : undefined,
            table,
        });

        // An empty table name can't bind to a real dependency, so fall back
        // to the wildcard rather than a set that never intersects a write.
        return { result: page, tables: new Set([table === "" ? ADMIN_WILDCARD : table]) };
    }

    /**
     * Seed/refresh hook for `__cirrus_admin__:*` subscriptions, mirroring
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
     * Constant-time bearer check against `env.CIRRUS_ADMIN_TOKEN`. Returns
     * `false` (closed) when the token is unset so admin introspection is
     * opt-in rather than exposed by default.
     */
    private isAdminAuthorized(request: Request): boolean {
        const env = (this.env ?? {}) as { CIRRUS_ADMIN_TOKEN?: string };
        const token = env.CIRRUS_ADMIN_TOKEN;

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
     */
    private async refreshSubscriptions(changed: Set<string>): Promise<void> {
        const sockets = [...this.state.getWebSockets()];

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

                const outcome = isAdmin
                    ? this.executeAdminSubscription(functionPath, query.args ?? {})
                    : // eslint-disable-next-line no-await-in-loop -- subscriptions on a socket re-run sequentially; each shares the single SQLite handle
                      await this.withAnonymousIdentity(() => this.executeSubscription(functionPath, query.args ?? {}));

                if (!outcome) {
                    continue;
                }

                this.pushSubscriptionData(ws, subId, outcome);
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
     */
    private pushSubscriptionData(ws: WebSocket, subId: string, outcome: SubscriptionOutcome): void {
        let memos = this.subMemos.get(ws);

        if (!memos) {
            memos = new Map<string, SubscriptionMemo>();
            this.subMemos.set(ws, memos);
        }

        // eslint-disable-next-line unicorn/no-null -- WS frame payload: an undefined result serializes to JSON null so the delta frame carries an explicit value
        const json = JSON.stringify(outcome.result ?? null);
        const existing = memos.get(subId);

        if (existing?.lastJson === json) {
            existing.tables = outcome.tables;

            return;
        }

        // Try an incremental delta push when there's a prior list to diff
        // against. `undefined` => not diffable, fall back to the snapshot below.
        const deltas =
            existing === undefined ? undefined : subscriptionListDeltas(existing.lastJson, outcome.result, outcome.tables.values().next().value ?? "");

        memos.set(subId, { lastJson: json, tables: outcome.tables });

        if (deltas !== undefined) {
            const idJson = JSON.stringify(subId);

            for (const delta of deltas) {
                try {
                    ws.send(`{"type":"delta","id":${idJson},"delta":${JSON.stringify(delta)}}`);
                } catch {
                    /* socket may have been closed mid-flush */
                }
            }

            return;
        }

        try {
            ws.send(`{"type":"data","id":${JSON.stringify(subId)},"data":${json}}`);
        } catch {
            /* socket may have been closed between checks */
        }
    }

    /**
     * Gate the upgrade request against two complementary controls:
     *
     * 1. Origin allowlist via `env.CIRRUS_ALLOWED_ORIGINS` (comma-separated).
     * When unset, any origin is accepted — convenient for local dev,
     * not suitable for production.
     * 2. Bearer token via `env.CIRRUS_WS_BEARER`. When set, the upgrade
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
        const env = (this.env ?? {}) as { CIRRUS_ALLOWED_ORIGINS?: string; CIRRUS_WS_BEARER?: string };
        const allowedOrigins = env.CIRRUS_ALLOWED_ORIGINS;

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

        const expectedBearer = env.CIRRUS_WS_BEARER;

        if (expectedBearer && expectedBearer.length > 0) {
            const supplied = this.suppliedWsToken(request);

            // The admin token is accepted as an alternate credential so a
            // dashboard can open its socket even when `CIRRUS_WS_BEARER` gates
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
     * Whether the upgrade presented a token matching `CIRRUS_ADMIN_TOKEN`,
     * constant-time compared. Closed (returns `false`) when the admin token is
     * unset, mirroring `isAdminAuthorized` for the HTTP path so admin
     * streaming is opt-in rather than exposed by default.
     */
    private isAdminSocket(request: Request): boolean {
        const env = (this.env ?? {}) as { CIRRUS_ADMIN_TOKEN?: string };
        const adminToken = env.CIRRUS_ADMIN_TOKEN;

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
        // Stamp admin authorization onto the socket at upgrade so later
        // `__cirrus_admin__:*` subscribe envelopes (which carry no credential of
        // their own) can be gated without re-checking a token per message.
        (server as HibernatableWebSocket).serializeAttachment?.({ admin: this.isAdminSocket(request), subs: {} } satisfies SocketAttachment);

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
    RunShardApplyCdcArgs,
    RunShardApplyCdcResult,
    RunShardBulkDeleteArgs,
    RunShardBulkDeleteResult,
    RunShardExportArgs,
    RunShardImportArgs,
    RunShardMigrationArgs,
    RunShardRankBeforeArgs,
    RunShardWriteArgs,
    RunShardWriteResult,
    ShardDOOptions,
    ShardDOState,
    SubscriptionOutcome,
};
