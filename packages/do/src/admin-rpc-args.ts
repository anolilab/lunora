/**
 * Argument parsing and validation for `ShardDO`'s admin RPC surface.
 *
 * Every admin RPC arrives as `unknown` over the wire, so each one needs the same
 * shape of work: read a field, check its type, clamp or reject it, and hand back
 * something typed. That is ~1,100 lines of it, and none of it touches the
 * Durable Object — it is pure `unknown` → typed, throwing `badRequest` on a
 * violation.
 *
 * Lifted out of `shard-do.ts` verbatim. Plan 114 §5.2 asked for the god-file
 * split to be done "as a move-only refactor first (no logic edits), then the
 * host-interface cut" — this is that first step for the largest coherent block.
 * Nothing here changed except its file, which is what makes the diff reviewable
 * and the behaviour provably identical.
 */

import { LunoraError } from "@lunora/errors";
import type { IndexHit, IssueSeverity, IssueStatus, LogEntry, TraceAnchor } from "@lunora/observability";
import { ISSUE_SEVERITIES, ISSUE_STATUSES } from "@lunora/observability";
import type {
    CdcChange,
    ExportRow,
    FilterClause,
    FilterOperator,
    MigrationDirection,
    OrderByClause,
    QueueMessageOutcome,
    RecordMailInput,
    RecordQueueMessageInput,
    WorkflowInstanceStatusResult,
} from "@lunora/shard-engine";
import { ADMIN_FUNCTION_PREFIX, tableFromDepKey } from "@lunora/shard-engine";

import { BRANCH_MARKER_REJECTION, hasBranchMarker } from "../../../shared/branch-marker";
import { decodeIdentityHeader } from "../../../shared/identity-header";

/** Recovers the process exit code embedded in a container `stop` message as `(exit <n>)`. */
const CONTAINER_EXIT_CODE_PATTERN = /\(exit (\d+)\)/;

/**
 * The mapped {@link LogEntry} one container lifecycle event becomes once parsed.
 * `functionPath` is the synthetic `container:<name>` source so the Studio Logs
 * panel renders the row alongside `ctx.log` lines; `level` is folded to the
 * buffer's level set; `message` is a compact `<event>` / `<event>: <detail>`.
 */
type ContainerLogEntry = LogEntry & { functionPath: string };

/** The structured-filter operators accepted over the wire (mirrors `FilterOperator`). */
const FILTER_OPERATORS: ReadonlySet<string> = new Set<FilterOperator>(["contains", "eq", "gt", "gte", "lt", "lte", "ne"]);

/** Cloudflare Queues accepts 1–100 messages per `sendBatch` call (a 0 or >100 batch is a `BatchCountOutOfBounds` error). */
const MAX_QUEUE_SEND_BATCH = 100;

/** Default recipient for the studio "Send test" action when no `to` is supplied. */
const TEST_MAIL_DEFAULT_TO = "test@lunora.sh";

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

// An explicit `null` from the wire is the CLEAR sentinel (unassign / untag); the
// codebase otherwise avoids `null`.
// eslint-disable-next-line unicorn/no-null -- see above
const CLEAR = null;

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
 * The predicate half of every writer-routed bulk row op — "delete matching",
 * "clear table", "set column on matching". The matching rows are collected on the shard (via the same
 * `filters` + `search` predicate `readTablePage` previews), then removed one at
 * a time THROUGH the schema-aware writer — never raw `DELETE` — so the FTS /
 * aggregate / rank shadow tables and `onDelete` cascades stay in sync, exactly
 * like a user mutation would.
 *
 * Bounded by design: at most `SHARD_BULK_ROW_CAP` rows are removed per
 * call and the result reports `hasMore`, so the caller loops a single bounded
 * server round-trip rather than deleting an unbounded set in one transaction.
 * The `clearTable` op is the same path with no predicate (it matches every row).
 */
interface RunShardBulkRowArgs {
    filters?: FilterClause[];
    /** Per-call row cap; clamped server-side to `[1, SHARD_BULK_ROW_CAP]`. */
    limit?: number;
    search?: string;
    table: string;
}

/**
 * What every writer-routed bulk row op reports, engine-internal and on the wire
 * alike — one shape for `deleteRows`, `clearTable` and `patchRows`.
 *
 * `count` is deliberately not renamed to `deleted`/`patched` per op. The verb
 * belongs in the audit record, where a human reads it; on the wire a per-op name
 * would force every client to carry a union of shapes and to guess which field
 * holds the number.
 */
interface RunShardBulkRowResult {
    /** Rows the applier reached in this call. */
    count: number;

    /**
     * Last id scanned — the `after` for the next call. Present ONLY when this call
     * itself ran a keyset (ordered) scan: the last id of an UNORDERED scan is an
     * arbitrary point in id space, and resuming from it would skip every matching
     * row sorting below it.
     */
    cursor?: string;
    /** `true` when matching rows remain beyond this batch. */
    hasMore: boolean;
}

/**
 * The bulk patch behind the data browser's "set column on N matching rows"
 * action — the write half of the same predicate "delete matching" removes by.
 * `doc` is shallow-merged into every matching row THROUGH the schema-aware
 * writer (validators, FTS / aggregate / rank shadow tables, reactive
 * invalidation), never as a raw `UPDATE`.
 *
 * Bounded like the bulk delete, but it is the ONLY row op that carries `after`,
 * resuming from an explicit cursor rather than relying on the write shrinking its
 * own match set: a patch that leaves the row still matching (`priority = 1` →
 * `seen = true` while the filter is on `priority`) would otherwise re-read the
 * same first batch on every loop and never finish.
 *
 * `after` lives HERE and not on {@link RunShardBulkRowArgs} on purpose. The delete
 * ops must not resume — ordering their scan would cost them a sequential table
 * scan (see `selectMatchingIds`) — and a shared optional field that two of three
 * parsers silently decline to populate is an invariant held by omission. On this
 * type it is held by the type system.
 */
interface RunShardBulkPatchArgs extends RunShardBulkRowArgs {
    /**
     * Keyset cursor. Open a drain with `""` (which sorts below every real id) — its
     * PRESENCE is what puts the scan into ordered, resumable mode.
     */
    after?: string;
    /** Fields to shallow-merge into each matching row. Must be a non-empty object. */
    doc: Record<string, unknown>;
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

/**
 * The trailing `,"cursor":<n>,"epoch":"<e>"` fragment appended to a
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

/** Narrow an unknown to a valid {@link IssueStatus} (used to validate the `getIssues` `status` filter and triage writes). */
const isIssueStatus = (value: unknown): value is IssueStatus => typeof value === "string" && (ISSUE_STATUSES as ReadonlyArray<string>).includes(value);

/** Narrow an unknown to a valid {@link IssueSeverity}. */
const isIssueSeverity = (value: unknown): value is IssueSeverity => typeof value === "string" && (ISSUE_SEVERITIES as ReadonlyArray<string>).includes(value);

/** Extract the required non-empty fingerprint `hash` an issue-triage write targets, else 400. */
const parseIssueHash = (args: Record<string, unknown>): string => {
    const hash = typeof args["hash"] === "string" ? args["hash"].trim() : "";

    if (hash === "") {
        throw new LunoraError("BAD_REQUEST", "issue triage: `hash` is required");
    }

    return hash;
};

/** Parse the `assignee` arg of an `assignIssue` write: a non-empty string assigns, `null` clears, anything else is a 400. */
const parseAssigneeArgument = (args: Record<string, unknown>): null | string => {
    const raw = args["assignee"];

    if (raw === null) {
        return CLEAR;
    }

    if (typeof raw === "string" && raw.trim() !== "") {
        return raw;
    }

    throw new LunoraError("BAD_REQUEST", "assignIssue: `assignee` must be a non-empty string (assign) or null (unassign)");
};

/** Parse the `severity` arg of a `setIssueSeverity` write: a valid severity tags, `null` clears, anything else is a 400. */
const parseSeverityArgument = (args: Record<string, unknown>): IssueSeverity | null => {
    const raw = args["severity"];

    if (raw === null) {
        return CLEAR;
    }

    if (isIssueSeverity(raw)) {
        return raw;
    }

    throw new LunoraError("BAD_REQUEST", "setIssueSeverity: `severity` must be one of critical|high|medium|low, or null to clear");
};

/**
 * Minimal structural shape of a created/fetched workflow instance handle, mirrored
 * from `@lunora/workflow`'s WorkflowInstanceLike so `@lunora/do` stays free of a
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

/** Parsed `createWorkflowInstance` admin-RPC payload: which declared workflow to start, plus optional id/params. */
interface CreateWorkflowInstanceArgs {
    exportName: string;
    id?: string;
    params?: unknown;
}

/**
 * Validate the `createWorkflowInstance` admin-RPC payload. Requires a
 * non-empty `exportName` (the `lunora/workflows.ts` export the handle is addressed
 * by); `id` and `params` are optional. Throws a 400 `LunoraError` on a bad shape.
 */
const parseCreateWorkflowInstanceArgs = (args: Record<string, unknown>): CreateWorkflowInstanceArgs => {
    const exportName = typeof args["exportName"] === "string" ? args["exportName"].trim() : "";

    if (exportName === "") {
        throw new LunoraError("BAD_REQUEST", "createWorkflowInstance: `exportName` is required");
    }

    const id = typeof args["id"] === "string" && args["id"] !== "" ? args["id"] : undefined;

    // Admin-token-gated, but reject the reserved workflow branch-marker key for
    // uniformity with every other create surface — a forged marker could
    // otherwise reach a child's `event.payload` and spoof events into an
    // arbitrary workflow instance.
    if (hasBranchMarker(args["params"])) {
        throw new LunoraError("BAD_REQUEST", `createWorkflowInstance: params ${BRANCH_MARKER_REJECTION}`);
    }

    return { exportName, id, params: args["params"] };
};

/** Parsed getWorkflowInstanceStatus admin-RPC payload: which workflow and which instance to inspect. */
interface GetWorkflowInstanceStatusArgs {
    exportName: string;
    id: string;
}

/**
 * Validate the getWorkflowInstanceStatus admin-RPC payload. Requires both
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
 * `limit` passes through to be clamped against `SHARD_BULK_ROW_CAP`.
 * Throws a 400 `LunoraError` on a missing table, keeping the error shape uniform.
 */
const parseBulkDeleteArgs = (args: Record<string, unknown>): RunShardBulkRowArgs => {
    const table = typeof args["table"] === "string" ? args["table"] : "";

    if (table.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "deleteRows: `table` is required");
    }

    const filters = parseTablePageFilters(args["filters"]);
    const search = typeof args["search"] === "string" ? args["search"] : undefined;

    // A predicate is REQUIRED. Without one this op is indistinguishable from
    // `clearTable` — same effect, but reached through the path an operator
    // confirmed as "delete N matching" rather than the one that asks "clear all
    // N rows?". The studio could send it during its search debounce, when the
    // button was already on screen and the debounced value was still empty; that
    // half is fixed client-side, and this is the boundary that makes the two
    // operations distinguishable no matter who calls them.
    //
    // Same shape as `parseBulkPatchArgs` refusing an empty `doc` two functions
    // below, rather than treating it as a no-op.
    if ((filters === undefined || filters.length === 0) && (search === undefined || search === "")) {
        throw new LunoraError("BAD_REQUEST", "deleteRows: a predicate (`filters` or `search`) is required — use `clearTable` to empty the table");
    }

    return {
        filters,
        limit: typeof args["limit"] === "number" ? args["limit"] : undefined,
        search,
        table,
    };
};

/**
 * Validate the `__lunora_admin__:patchRows` payload. Mirrors
 * {@link parseBulkDeleteArgs}'s predicate args, plus the `doc` to merge and the
 * optional keyset `after` cursor.
 *
 * An EMPTY `doc` is rejected rather than treated as a no-op: the writer would
 * happily patch nothing onto every matching row, so the call would report
 * hundreds of "patched" rows having changed none of them, and it would still
 * fire an invalidation for each. A caller that means "touch every row" has to
 * say which field it is setting.
 */
const parseBulkPatchArgs = (args: Record<string, unknown>): RunShardBulkPatchArgs => {
    const table = typeof args["table"] === "string" ? args["table"] : "";

    if (table.trim() === "") {
        throw new LunoraError("BAD_REQUEST", "patchRows: `table` is required");
    }

    const raw = args["doc"];
    const fields = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;

    if (fields === undefined || Object.keys(fields).length === 0) {
        throw new LunoraError("BAD_REQUEST", "patchRows: `doc` must be a non-empty object of fields to set");
    }

    return {
        after: typeof args["after"] === "string" ? args["after"] : undefined,
        doc: fields,
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
const parseClearTableArgs = (args: Record<string, unknown>): RunShardBulkRowArgs => {
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
 * narrowed outcome `@lunora/observability`'s `recordAuthEvent` consumes.
 */
const parseRecordAuthEventArgs = (args: Record<string, unknown>): { outcome: "fail" | "ok" } => {
    const { outcome } = args;

    if (outcome !== "ok" && outcome !== "fail") {
        throw new LunoraError("BAD_REQUEST", 'recordAuthEvent: `outcome` must be "ok" or "fail"');
    }

    return { outcome };
};

/**
 * Validate the `__lunora_admin__:recordContainerEvent` payload — the Container
 * DO's best-effort push of one lifecycle transition (`@lunora/container`'s
 * `reportContainerLifecycle`). The reserved op carries the same envelope
 * `emitContainerLifecycle` prints to the dev terminal under `args.event`, so the
 * terminal and the Studio Logs panel never diverge. Maps it to a {@link LogEntry}
 * with `functionPath: "container:<name>"`. A malformed envelope throws a 400
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

/**
 * Key for `ShardDO`'s dispatch-span map: the anchor's full span identity, not its
 * trace id.
 *
 * `resolveTraceAnchor` takes `traceId` from the inbound `traceparent`, so two
 * concurrent RPCs forwarded under the SAME client trace share it while carrying
 * different `rootSpanId`s (the runtime mints a fresh span id per dispatch). Keyed
 * by `traceId` alone their wide events would merge into one collector, and
 * whichever dispatch finished first would delete the entry and drop the other's.
 *
 * `traceSampling` keying by `traceId` is correct because a sampling verdict IS
 * per-trace; a wide event is per-dispatch, which is the distinction this encodes.
 */
const dispatchSpanKey = (anchor: TraceAnchor): string => `${anchor.traceId}:${anchor.rootSpanId}`;

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

/** Narrow a required non-empty string admin arg or 400 with `<field> is required`. */
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
 * Decode the envelope shipped on the `x-lunora-identity` header. Malformed
 * payloads collapse to `undefined` rather than throwing — the shard should
 * still serve requests whose identity claims didn't round-trip.
 *
 * Delegates to {@link decodeIdentityHeader} (base64url-encoded, with a
 * fail-soft sniffing fallback for a legacy raw-JSON header value — see
 * shared/identity-header.ts). Kept as a named wrapper — rather than importing
 * `decodeIdentityHeader` directly at call sites — so this file's own
 * name/signature stays the stable public surface for `shard-do.ts` and
 * anything else depending on it.
 * @returns the decoded identity object, or `undefined` when the header is absent or malformed
 */
const parseIdentityHeader = (raw: string | null): Record<string, unknown> | undefined => decodeIdentityHeader(raw);

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
 * which the caller passes as `isDevEnvironment`, so a dev deployment
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

export {
    bookmarkHeaders,
    buildTestMailInput,
    cdcSuffix,
    decodeIndexHitKey,
    dispatchSpanKey,
    extractBearerToken,
    isIssueStatus,
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
};
export type {
    CreateWorkflowInstanceArgs,
    GetWorkflowInstanceStatusArgs,
    QueueBindingHandle,
    RunAsArgs,
    RunShardApplyCdcArgs,
    RunShardApplyCdcResult,
    RunShardBulkPatchArgs,
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
    SendQueueMessageArgs,
    WorkflowBindingHandle,
    WorkflowInstanceHandle,
};
