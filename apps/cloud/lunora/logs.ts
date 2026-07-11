import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember, authorizeDeployKey } from "./authz";

/**
 * Tenant runtime logs (GAPS.md B2). The dispatch-namespace tail worker batches
 * console/exception events to `POST /v1/logs/ingest` (deploy-key authorized,
 * like usage metering); the dashboard tails a deployment through the
 * cursor-paginated {@link list}. Retention is enforced by {@link prune}.
 */

interface TenantLogRow {
    _id: Id<"tenantLogs">;
    createdAt: number;
    level: "error" | "log" | "warn";
    line: string;
    organizationId: Id<"organizations">;
    scriptName: string;
}

/** Logs older than this are pruned (48 h — enough to debug yesterday's incident). */
export const LOG_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Batch cap per ingest call — the tail worker flushes well below this. */
const MAX_BATCH = 500;

/** Line length cap; longer lines are truncated, never rejected (mid-incident logs must land). */
const MAX_LINE_LENGTH = 4096;

/**
 * Ingest a batch of tenant log lines (deploy-key authorized — the tail worker
 * holds an org deploy key). Lines are truncated to {@link MAX_LINE_LENGTH};
 * batches over {@link MAX_BATCH} are rejected outright.
 */
export const ingest = mutation
    .input({
        deployKey: v.string(),
        lines: v.array(
            v.object({ createdAt: v.optional(v.number()), level: v.union(v.literal("log"), v.literal("warn"), v.literal("error")), line: v.string() }),
        ),
        organizationId: v.id("organizations"),
        scriptName: v.string(),
    })
    .mutation(async ({ ctx: context, args: { deployKey, lines, organizationId, scriptName } }): Promise<{ ingested: number }> => {
        await authorizeDeployKey(context, organizationId, deployKey);

        if (lines.length > MAX_BATCH) {
            throw new LunoraError("BAD_REQUEST", `batch too large (max ${String(MAX_BATCH)} lines)`);
        }

        const now = Date.now();

        for (const entry of lines) {
            // eslint-disable-next-line no-await-in-loop -- bounded batch; sequential keeps the writer simple
            await context.db.insert("tenantLogs", {
                createdAt: entry.createdAt ?? now,
                level: entry.level,
                line: entry.line.length > MAX_LINE_LENGTH ? `${entry.line.slice(0, MAX_LINE_LENGTH)}…` : entry.line,
                organizationId,
                scriptName,
            });
        }

        return { ingested: lines.length };
    });

/**
 * A script's log lines after `afterCreatedAt` (cursor pagination — the
 * dashboard tails by repeatedly passing the last timestamp it saw). Members.
 */
export const list = query
    .input({ afterCreatedAt: v.optional(v.number()), organizationId: v.id("organizations"), scriptName: v.string() })
    .query(
        async ({
            ctx: context,
            args: { afterCreatedAt, organizationId, scriptName },
        }): Promise<{ createdAt: number; level: "error" | "log" | "warn"; line: string }[]> => {
            await assertMember(context, organizationId);

            const { page } = await context.db.tenantLogs.findMany({ where: { organizationId, scriptName } });
            const cursor = afterCreatedAt ?? 0;

            return (page as unknown as TenantLogRow[])
                .filter((row) => row.createdAt > cursor)
                .toSorted((a, b) => a.createdAt - b.createdAt)
                .map((row) => {
                    return { createdAt: row.createdAt, level: row.level, line: row.line };
                });
        },
    );

/** Delete log lines past retention (GAPS.md B2). SYSTEM only (cron dispatch). */
export const prune = internalMutation.mutation(async ({ ctx: context }): Promise<{ pruned: number }> => {
    const cutoff = Date.now() - LOG_RETENTION_MS;
    const { page } = await context.db.tenantLogs.findMany({});
    const stale = (page as unknown as TenantLogRow[]).filter((row) => row.createdAt < cutoff);

    for (const row of stale) {
        // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
        await context.db.delete(row._id);
    }

    return { pruned: stale.length };
});
