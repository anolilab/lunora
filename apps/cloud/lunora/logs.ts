import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { assertMember, authorizeTelemetryKey } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * Tenant runtime logs (GAPS.md B2) — full log management. The dispatch-namespace
 * tail worker (`src/tail/worker.ts`) maps each tenant `ctx.log` console event
 * (`{ source: "lunora", type: "log" }`) onto a batch and POSTs it to
 * `POST /v1/logs/ingest` (deploy-key authorized, like usage metering). Every
 * line keeps its full shape — the seven-tier severity, the rendered message, the
 * structured `fields`, and the `traceId`/`spanId` for log↔trace correlation — so
 * the dashboard can filter, search, and link a line back to its dispatch trace
 * (and, for an error/fatal line, the OTLP-derived Issue). Retention is enforced
 * by {@link prune}.
 */

/** The seven-tier `ctx.log` severity ramp — matches the framework's `ContextLogLevel`. */
const logLevel = v.union(
    v.literal("trace"),
    v.literal("debug"),
    v.literal("info"),
    v.literal("log"),
    v.literal("warn"),
    v.literal("error"),
    v.literal("fatal"),
);

type LogLevel = "debug" | "error" | "fatal" | "info" | "log" | "trace" | "warn";

/** One persisted log row as stored (a superset of {@link TenantLogView}). */
interface TenantLogRow {
    _id: Id<"tenantLogs">;
    createdAt: number;
    fields?: Record<string, unknown>;
    functionPath?: string;
    level: LogLevel;
    message: string;
    organizationId: Id<"organizations">;
    scriptName: string;
    shardKey?: string;
    spanId?: string;
    traceId?: string;
    userId?: string;
}

/** One log row as the dashboard consumes it (the persisted row minus internal keys). */
interface TenantLogView {
    createdAt: number;
    fields?: Record<string, unknown>;
    functionPath?: string;
    level: LogLevel;
    message: string;
    shardKey?: string;
    spanId?: string;
    traceId?: string;
    userId?: string;
}

/** Logs older than this are pruned (48 h — enough to debug yesterday's incident). */
export const LOG_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Rows one prune tick deletes. Bounds a single mutation; a backlog drains over ticks. */
const PRUNE_BATCH = 1000;

/** Batch cap per ingest call — the tail worker flushes well below this. */
const MAX_BATCH = 500;

/** Message length cap; longer messages are truncated, never rejected (mid-incident logs must land). */
const MAX_MESSAGE_LENGTH = 4096;

/** Default number of lines {@link list} returns when the caller gives no `limit`. */
const DEFAULT_LIMIT = 200;

/** Hard cap on `list` output — bounds the response even against a chatty script. */
const MAX_LIMIT = 1000;

/** One line accepted by {@link ingest} — the framework's `type:"log"` event, minus the transport keys. */
const logEntry = v.object({
    createdAt: v.optional(v.number()),
    fields: v.optional(v.record(v.string(), v.any())),
    functionPath: v.optional(v.string()),
    level: logLevel,
    message: v.string(),
    shardKey: v.optional(v.string()),
    spanId: v.optional(v.string()),
    traceId: v.optional(v.string()),
    userId: v.optional(v.string()),
});

/** One decoded line, as both {@link ingest} (deploy-key) and {@link ingestInternal} (tail route) receive it. */
interface LogEntry {
    createdAt?: number;
    fields?: Record<string, unknown>;
    functionPath?: string;
    level: LogLevel;
    message: string;
    shardKey?: string;
    spanId?: string;
    traceId?: string;
    userId?: string;
}

/**
 * Insert one batch of already-authorized lines into `tenantLogs` (shared by both
 * ingest paths). Exported so codegen's write-side discovery — which only walks
 * exported declarations — can attribute the `ctx.db.insert("tenantLogs", …)`.
 */
export const insertLines = async (context: MutationContext, organizationId: Id<"organizations">, scriptName: string, lines: LogEntry[]): Promise<void> => {
    const { now } = context;

    for (const entry of lines) {
        // eslint-disable-next-line no-await-in-loop -- bounded batch; sequential keeps the writer simple
        await context.db.insert("tenantLogs", {
            createdAt: entry.createdAt ?? now,
            fields: entry.fields,
            functionPath: entry.functionPath,
            level: entry.level,
            message: entry.message.length > MAX_MESSAGE_LENGTH ? `${entry.message.slice(0, MAX_MESSAGE_LENGTH)}…` : entry.message,
            organizationId,
            scriptName,
            shardKey: entry.shardKey,
            spanId: entry.spanId,
            traceId: entry.traceId,
            userId: entry.userId,
        });
    }
};

/** Project a stored row to the dashboard view (drop `_id`/`organizationId`/`scriptName`). */
const toView = (row: TenantLogRow): TenantLogView => {
    return {
        createdAt: row.createdAt,
        fields: row.fields,
        functionPath: row.functionPath,
        level: row.level,
        message: row.message,
        shardKey: row.shardKey,
        spanId: row.spanId,
        traceId: row.traceId,
        userId: row.userId,
    };
};

/** True when the line matches the case-insensitive `needle` over its message, function path, or field values. */
const matchesSearch = (row: TenantLogRow, needle: string): boolean => {
    if (row.message.toLowerCase().includes(needle)) {
        return true;
    }

    if ((row.functionPath ?? "").toLowerCase().includes(needle)) {
        return true;
    }

    if (row.fields) {
        for (const value of Object.values(row.fields)) {
            if (String(value).toLowerCase().includes(needle)) {
                return true;
            }
        }
    }

    return false;
};

/**
 * Ingest a batch of tenant log lines (deploy-key authorized — the tail worker
 * holds an org deploy key). Each line keeps its full structured shape; messages
 * are truncated to {@link MAX_MESSAGE_LENGTH}; batches over {@link MAX_BATCH} are
 * rejected outright.
 */
export const ingest = mutation
    .use(rateLimit("ingest"))
    .input({
        deployKey: boundedString(LIMITS.token),
        lines: v.array(logEntry),
        organizationId: v.id("organizations"),
        scriptName: boundedString(LIMITS.name),
    })
    .mutation(async ({ ctx: context, args: { deployKey, lines, organizationId, scriptName } }): Promise<{ ingested: number }> => {
        await authorizeTelemetryKey(context, organizationId, deployKey);

        if (lines.length > MAX_BATCH) {
            throw new LunoraError("BAD_REQUEST", `batch too large (max ${String(MAX_BATCH)} lines)`);
        }

        await insertLines(context, organizationId, scriptName, lines);

        return { ingested: lines.length };
    });

/**
 * Resolve a dispatch-namespace script id → its owning org, via the immutable
 * `deployments.by_script` index. Used by the platform tail route to attribute a
 * batch of tail-captured lines (which carry only a `scriptName`) to an org
 * without holding that org's deploy key. Returns `null` for an unknown script
 * (e.g. a superseded/destroyed release the tail lags behind). SYSTEM only.
 */
export const orgForScript = internalQuery
    .input({ scriptName: boundedString(LIMITS.name) })
    .query(async ({ ctx: context, args: { scriptName } }): Promise<{ organizationId: Id<"organizations"> } | null> => {
        const { page } = await context.db.deployments.findMany({ where: { scriptName } });
        const row = page[0];

        return row ? { organizationId: row.organizationId } : null;
    });

/**
 * Platform-authorized ingest for the tail route (`src/tail/worker.ts` →
 * `POST /v1/logs/tail`). The tail worker holds a single platform secret and
 * cannot present each org's deploy key, so this skips deploy-key auth — the edge
 * route is secret-gated instead, and the org is resolved from the script id via
 * {@link orgForScript}. SYSTEM only (internal dispatch).
 */
export const ingestInternal = internalMutation
    .input({
        lines: v.array(logEntry),
        organizationId: v.id("organizations"),
        scriptName: boundedString(LIMITS.name),
    })
    .mutation(async ({ ctx: context, args: { lines, organizationId, scriptName } }): Promise<{ ingested: number }> => {
        if (lines.length > MAX_BATCH) {
            throw new LunoraError("BAD_REQUEST", `batch too large (max ${String(MAX_BATCH)} lines)`);
        }

        await insertLines(context, organizationId, scriptName, lines);

        return { ingested: lines.length };
    });

/**
 * A script's log lines, newest first, with server-side filtering: `levels`
 * (severity allow-set), `functionPath` (exact), `traceId` (exact — every line in
 * one trace), `search` (case-insensitive over message / function / field
 * values), `afterCreatedAt` (only newer than a cursor, for incremental tailing),
 * and a `from`/`to` time window (the shared dashboard time-range picker — lines
 * created within `[from, to]`). Bounded by `limit` (default {@link DEFAULT_LIMIT},
 * capped at {@link MAX_LIMIT}). Members only.
 */
export const list = query
    .input({
        afterCreatedAt: v.optional(v.number()),
        from: v.optional(v.number()),
        functionPath: v.optional(boundedString(LIMITS.token)),
        levels: v.optional(v.array(logLevel)),
        limit: v.optional(v.number()),
        organizationId: v.id("organizations"),
        scriptName: boundedString(LIMITS.name),
        search: v.optional(boundedString(LIMITS.token)),
        to: v.optional(v.number()),
        traceId: v.optional(boundedString(LIMITS.id)),
    })
    .query(async ({ ctx: context, args }): Promise<TenantLogView[]> => {
        await assertMember(context, args.organizationId);

        const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

        // Exact-match filters push to the query (`traceId` rides the `by_trace`
        // index); the rest — level allow-set, text search, cursor — are applied
        // over the bounded, newest-first page below.
        const where: { functionPath?: string; organizationId: Id<"organizations">; scriptName: string; traceId?: string } = {
            organizationId: args.organizationId,
            scriptName: args.scriptName,
        };

        if (args.traceId !== undefined) {
            where.traceId = args.traceId;
        }

        if (args.functionPath !== undefined) {
            where.functionPath = args.functionPath;
        }

        const { page } = await context.db.tenantLogs.findMany({ limit: MAX_LIMIT, orderBy: [{ createdAt: "desc" }], where });

        const cursor = args.afterCreatedAt ?? Number.NEGATIVE_INFINITY;
        const from = args.from ?? Number.NEGATIVE_INFINITY;
        const to = args.to ?? Number.POSITIVE_INFINITY;
        const levelSet = args.levels && args.levels.length > 0 ? new Set<LogLevel>(args.levels) : undefined;
        const needle = args.search?.trim().toLowerCase();

        // One predicate for the in-memory half of the filter, so the walk below is
        // just "take the first `limit` that pass".
        const keep = (row: TenantLogRow): boolean => {
            if (row.createdAt <= cursor || row.createdAt < from || row.createdAt > to) {
                return false;
            }

            if (levelSet && !levelSet.has(row.level)) {
                return false;
            }

            return needle === undefined || needle === "" || matchesSearch(row, needle);
        };

        const rows: TenantLogView[] = [];

        for (const row of page) {
            if (keep(row)) {
                rows.push(toView(row));
            }

            if (rows.length >= limit) {
                break;
            }
        }

        return rows;
    });

/** Delete log lines past retention (GAPS.md B2). SYSTEM only (cron dispatch). */
export const prune = internalMutation.mutation(async ({ ctx: context }): Promise<{ pruned: number }> => {
    const cutoff = context.now - LOG_RETENTION_MS;
    // Filter in the QUERY, not after it: the cutoff is a `where` predicate, so every
    // row on the page is a row to delete and the sweep can never fill its page with
    // rows it does not want. Oldest-first keeps a backlog draining in cutoff order,
    // and PRUNE_BATCH bounds the work one cron tick does — a table far past retention
    // converges over several ticks instead of timing out on one.
    const { page: stale } = await context.db.tenantLogs.findMany({ limit: PRUNE_BATCH, orderBy: [{ createdAt: "asc" }], where: { createdAt: { lt: cutoff } } });

    for (const row of stale) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
        await context.db.delete(row._id);
    }

    return { pruned: stale.length };
});
