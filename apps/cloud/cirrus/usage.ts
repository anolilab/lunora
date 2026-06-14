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

/** Summed usage for an org over a billing period (members only). */
export const summary = query({
    args: { organizationId: v.id("organizations"), periodStart: v.number() },
    handler: async (context, { organizationId, periodStart }): Promise<Record<"cpuMs" | "requests" | "storageBytes", number>> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.platformUsage.findMany({ where: { organizationId } });

        return aggregateUsage(page, periodStart);
    },
});
