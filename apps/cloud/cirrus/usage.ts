import { aggregateUsage } from "../src/billing/usage";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember, authorizeDeployKey } from "./authz";

/**
 * Platform resource metering (CLOUD-PLAN.md §4). `record` is written by the
 * metering ingestion endpoint (`POST /v1/usage`) and the Analytics-Engine
 * stream; `summary` rolls a period up for the dashboard/billing. The roll-up
 * logic is the pure `aggregateUsage`. (Distinct from `@cirrus/payment`'s usage
 * ledger, which meters billing features via `ctx.payments`.)
 */

const kind = v.union(v.literal("requests"), v.literal("cpuMs"), v.literal("storageBytes"));

/** Record a metered event. SYSTEM only (internalMutation — cron/metering writer). */
export const record = internalMutation({
    args: {
        deploymentId: v.optional(v.id("deployments")),
        kind,
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        quantity: v.number(),
    },
    handler: async (context, arguments_): Promise<Id<"platformUsage">> =>
        context.db.insert("platformUsage", {
            createdAt: Date.now(),
            deploymentId: arguments_.deploymentId,
            kind: arguments_.kind,
            organizationId: arguments_.organizationId,
            periodStart: arguments_.periodStart,
            quantity: arguments_.quantity,
        }),
});

/**
 * Ingest a metered event from the platform data plane (`POST /v1/usage`).
 * Public, but deploy-key authenticated: a valid, unrevoked key for the org is
 * the credential (no user session on the metering path, same as the deploy
 * path). The tenant Worker / metering sidecar reports requests/CPU/storage here.
 */
export const ingest = mutation({
    args: {
        deployKey: v.string(),
        deploymentId: v.optional(v.id("deployments")),
        kind,
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        quantity: v.number(),
    },
    handler: async (context, arguments_): Promise<Id<"platformUsage">> => {
        await authorizeDeployKey(context, arguments_.organizationId, arguments_.deployKey);

        return context.db.insert("platformUsage", {
            createdAt: Date.now(),
            deploymentId: arguments_.deploymentId,
            kind: arguments_.kind,
            organizationId: arguments_.organizationId,
            periodStart: arguments_.periodStart,
            quantity: arguments_.quantity,
        });
    },
});

interface PlatformUsageRow {
    _id: Id<"platformUsage">;
    kind: "cpuMs" | "requests" | "storageBytes";
    organizationId: Id<"organizations">;
    periodStart: number;
    quantity: number;
}

/** Epoch ms for the first instant of the current UTC month. */
const currentPeriodStart = (): number => {
    const now = new Date();

    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
};

/**
 * Compact closed-period metering events (CLOUD-PLAN.md §4). Per
 * (org, period, kind), collapse many raw rows from a *past* period into a single
 * summed row — bounding row growth while leaving `summary` (which sums) exact.
 * The current period is left untouched so live writes never race the compaction.
 * SYSTEM only (cron dispatch).
 */
export const rollup = internalMutation({
    args: {},
    handler: async (context): Promise<{ compacted: number }> => {
        const cutoff = currentPeriodStart();
        const { page } = await context.db.platformUsage.findMany({});
        const closed = (page as unknown as PlatformUsageRow[]).filter((row) => row.periodStart < cutoff);

        const groups = new Map<
            string,
            { kind: PlatformUsageRow["kind"]; organizationId: Id<"organizations">; periodStart: number; rows: PlatformUsageRow[]; total: number }
        >();

        for (const row of closed) {
            const groupKey = `${row.organizationId}|${String(row.periodStart)}|${row.kind}`;
            const group = groups.get(groupKey) ?? { kind: row.kind, organizationId: row.organizationId, periodStart: row.periodStart, rows: [], total: 0 };

            group.rows.push(row);
            group.total += row.quantity;
            groups.set(groupKey, group);
        }

        let compacted = 0;

        for (const group of groups.values()) {
            if (group.rows.length < 2) {
                continue;
            }

            // eslint-disable-next-line no-await-in-loop -- sequential keeps the writer simple; volumes are small
            await context.db.insert("platformUsage", {
                createdAt: Date.now(),
                kind: group.kind,
                organizationId: group.organizationId,
                periodStart: group.periodStart,
                quantity: group.total,
            });

            for (const row of group.rows) {
                // eslint-disable-next-line no-await-in-loop -- sequential delete of the now-summed rows
                await context.db.delete(row._id);
            }

            compacted += group.rows.length;
        }

        return { compacted };
    },
});

/** Summed usage for an org over a billing period (members only). */
export const summary = query({
    args: { organizationId: v.id("organizations"), periodStart: v.number() },
    handler: async (context, { organizationId, periodStart }): Promise<Record<"cpuMs" | "requests" | "storageBytes", number>> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.platformUsage.findMany({ where: { organizationId } });

        return aggregateUsage(page, periodStart);
    },
});
