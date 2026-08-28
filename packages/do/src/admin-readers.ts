/**
 * The `this`-free half of the admin read surface.
 *
 * Every reader here takes the `SqlExec` it needs as an argument and touches no
 * instance state — they were free functions living as private methods on an
 * 11k-line class. Lifting them out is behaviour-preserving by construction:
 * the class keeps one-line delegations, nothing in the frozen surface moves
 * (all nine were `private`, which `api-snapshots/do.api.md` does not record),
 * and no test names them — the admin suite drives every one through `fetch`.
 *
 * The readers that DO touch `this` stay on the class. Threading their state out
 * would mean publishing a wide parameter bag to buy the same line count, which
 * is the trade a previous split of this file measured and rejected.
 */
import type { AuthMetrics, IssuesResult, RequestLogResult } from "@lunora/observability";
import { ensureRequestLogTable, findDanglingReferences, readAuthMetrics, readErrorIssues, readRequestLog } from "@lunora/observability";
import type { AuditLogResult, SqlExec } from "@lunora/shard-engine";
import {
    ADMIN_FUNCTIONS,
    ensureAuditTable,
    facetColumn,
    findStorageReferences,
    MAIL_TABLE,
    QUEUE_TABLE,
    readAuditLog,
    readCapturedMail,
    readQueueMessages,
    runReadonlySql,
} from "@lunora/shard-engine";

import { isIssueStatus, parseTablePageFilters } from "./admin-rpc-args";

/** Sentinel table name for an admin read that spans every table rather than naming one. */
const ADMIN_WILDCARD = "*";

/**
 * Shared shape behind `describeTables` and `listTablesIndexes`: read the
 * `tables` arg, run `lookup` (a cheap, synchronous, schema-sourced `this.*()`
 * hook) over each, and report the requested set as the read's table
 * dependency (or the {@link ADMIN_WILDCARD} sentinel when none were named).
 * Factored out so `readAdminTableSignal` states each batched RPC as one line
 * rather than duplicating the array-filter/fan-out shape per sibling.
 */
const batchedTableLookup = <T>(args: Record<string, unknown>, lookup: (table: string) => T): { byTable: Record<string, T>; tables: Set<string> } => {
    const requested = Array.isArray(args["tables"]) ? args["tables"].filter((table): table is string => typeof table === "string") : [];
    const byTable: Record<string, T> = Object.fromEntries(requested.map((table) => [table, lookup(table)]));

    return { byTable, tables: new Set(requested.length === 0 ? [ADMIN_WILDCARD] : requested) };
};

/** Resolve a `getAuditLog` admin read, parsing the optional `limit`/`sinceSeq` cursor args and ensuring the reserved table first. */
const readAdminAuditLog = (sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } => {
    // Defensive: the table may not exist yet on a shard that has never
    // recorded an admin op, so ensure it before the read.
    ensureAuditTable(sql);

    const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
    const sinceSeq = typeof args["sinceSeq"] === "number" ? args["sinceSeq"] : undefined;
    const result: AuditLogResult = { entries: readAuditLog(sql, { limit, sinceSeq }) };

    return { result, tables: new Set([ADMIN_WILDCARD]) };
};

/**
 * Resolve a `getRequestLog` admin read, parsing the optional correlation
 * filters (function-path prefix, exact userId/shardKey/outcome, table-touched)
 * plus the `limit`/`sinceSeq` cursor, and ensuring the reserved table first.
 * Carries the {@link ADMIN_WILDCARD} like the other log reads so a live Logs
 * subscription re-runs on every write-flush (the per-socket JSON memo still
 * suppresses byte-identical pushes).
 */
const readAdminRequestLog = (sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } => {
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
};

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
const readAdminIssues = (sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } => {
    // Defensive: the reqlog table may not exist yet on a shard that has never
    // served a logged dispatch, so ensure it before the read.
    ensureRequestLogTable(sql);

    const result: IssuesResult = {
        issues: readErrorIssues(sql, {
            functionPathPrefix: typeof args["functionPathPrefix"] === "string" ? args["functionPathPrefix"] : undefined,
            limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
            shardKey: typeof args["shardKey"] === "string" ? args["shardKey"] : undefined,
            status: isIssueStatus(args["status"]) ? args["status"] : undefined,
            userId: typeof args["userId"] === "string" ? args["userId"] : undefined,
        }),
    };

    return { result, tables: new Set([ADMIN_WILDCARD]) };
};

const readAdminAuthMetrics = (sql: SqlExec): { result: unknown; tables: Set<string> } => {
    let result: AuthMetrics;

    try {
        result = readAuthMetrics(sql);
    } catch {
        result = { attempts: 0, failureRate: 0, failures: 0, history: [], sinceMs: 0 };
    }

    return { result, tables: new Set([ADMIN_WILDCARD]) };
};

/**
 * Resolve a `getCapturedMail` admin read — the dev mail catcher's inbox
 * (`mail-catcher.ts`), newest-first. Best-effort: a SQL failure returns an
 * empty inbox rather than throwing. Bound to the {@link MAIL_TABLE} so a live
 * studio subscription re-runs when a new message is recorded (the per-socket
 * JSON memo still suppresses byte-identical pushes).
 */
const readAdminCapturedMail = (sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } => {
    const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
    let result: { entries: unknown[] };

    try {
        result = readCapturedMail(sql, { limit });
    } catch {
        result = { entries: [] };
    }

    return { result, tables: new Set([MAIL_TABLE]) };
};

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
const readAdminQueueMessages = (sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } => {
    const limit = typeof args["limit"] === "number" ? args["limit"] : undefined;
    const queue = typeof args["queue"] === "string" ? args["queue"] : undefined;
    let result: { entries: unknown[] };

    try {
        result = readQueueMessages(sql, { limit, queue });
    } catch {
        result = { entries: [] };
    }

    return { result, tables: new Set([QUEUE_TABLE]) };
};

/**
 * Resolve a `facetColumn` admin read — Datasette-style per-column value/count
 * summary over the active view. Reuses `readTablePage`'s predicate args
 * (`filters` + `search`) so the facet reflects exactly the previewed rows; the
 * `column` is validated + bound inside {@link facetColumn} (never interpolated).
 * Read-only `SELECT … GROUP BY`. Depends on its table like `readAdminTablePage`.
 */
const readAdminFacetColumn = (sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } => {
    const table = typeof args["table"] === "string" ? args["table"] : "";
    const result = facetColumn(sql, {
        column: typeof args["column"] === "string" ? args["column"] : "",
        filters: parseTablePageFilters(args["filters"]),
        limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
        search: typeof args["search"] === "string" ? args["search"] : undefined,
        table,
    });

    return { result, tables: new Set([table === "" ? ADMIN_WILDCARD : table]) };
};

/**
 * Resolve a `runSql` admin read: execute a read-only SQL query against the
 * shard's SQLite via {@link runReadonlySql} (which rejects every mutating
 * statement). Carries the {@link ADMIN_WILDCARD} since an arbitrary query can
 * touch any table; it is a one-shot read, never a live subscription.
 */
const readAdminRunSql = (sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } => {
    const query = typeof args["sql"] === "string" ? args["sql"] : "";

    return { result: runReadonlySql(sql, query), tables: new Set([ADMIN_WILDCARD]) };
};

/**
 * Resolve a `storageReferences` admin read — the file browser's records↔files
 * join: given the object keys on the page, return the rows that reference each
 * (via a `v.storage()` column) plus the schema's declared storage columns.
 * Scans only those columns through {@link findStorageReferences}. Carries the
 * {@link ADMIN_WILDCARD} (it spans every storage table) so a live subscription
 * re-runs on any write.
 */
const readAdminStorageReferences = (
    sql: SqlExec,
    args: Record<string, unknown>,
    storageColumns: Record<string, string[]>,
): { result: unknown; tables: Set<string> } => {
    const keys = Array.isArray(args["keys"]) ? args["keys"].filter((key): key is string => typeof key === "string") : [];

    return { result: findStorageReferences(sql, storageColumns, keys), tables: new Set([ADMIN_WILDCARD]) };
};

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
const readAdminStorageOrphans = (
    sql: SqlExec,
    args: Record<string, unknown>,
    storageColumns: Record<string, string[]>,
): { result: unknown; tables: Set<string> } => {
    const liveKeys = Array.isArray(args["liveKeys"]) ? args["liveKeys"].filter((key): key is string => typeof key === "string") : [];
    const result = findDanglingReferences(sql, storageColumns, liveKeys);

    if (result.truncated) {
        // eslint-disable-next-line no-console -- intentional operational notice: the dangling-reference scan was clipped by its bound, so the studio's view is partial
        console.warn(
            `[@lunora/do] storageOrphans scan truncated after checking ${String(result.scanned)} storage references; reporting the first ${String(result.references.length)} dangling reference(s).`,
        );
    }

    return { result, tables: new Set([ADMIN_WILDCARD]) };
};

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
const readAdminDurableSignal = (functionPath: string, sql: SqlExec, args: Record<string, unknown>): { result: unknown; tables: Set<string> } | undefined => {
        if (functionPath === ADMIN_FUNCTIONS.getAuthMetrics) {
            return readAdminAuthMetrics(sql);
        }

        if (functionPath === ADMIN_FUNCTIONS.getCapturedMail) {
            return readAdminCapturedMail(sql, args);
        }

        if (functionPath === ADMIN_FUNCTIONS.getQueueMessages) {
            return readAdminQueueMessages(sql, args);
        }

        return undefined;
    };

export {
    batchedTableLookup,
    readAdminAuditLog,
    readAdminAuthMetrics,
    readAdminCapturedMail,
    readAdminDurableSignal,
    readAdminFacetColumn,
    readAdminIssues,
    readAdminQueueMessages,
    readAdminRequestLog,
    readAdminRunSql,
    readAdminStorageOrphans,
    readAdminStorageReferences,
};
