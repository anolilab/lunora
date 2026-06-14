import { aggregateUsage } from "../src/billing/usage";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

/**
 * Usage metering (CLOUD-PLAN.md §4). `record` is written by the platform (system
 * dispatch) from the Analytics-Engine stream; `summary` rolls a period up for
 * the dashboard/billing. The roll-up logic is the pure `aggregateUsage`.
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
    handler: async (context, arguments_): Promise<Id<"usageEvents">> =>
        context.db.insert("usageEvents", {
            createdAt: Date.now(),
            deploymentId: arguments_.deploymentId,
            kind: arguments_.kind,
            organizationId: arguments_.organizationId,
            periodStart: arguments_.periodStart,
            quantity: arguments_.quantity,
        }),
});

/** Summed usage for an org over a billing period (members only). */
export const summary = query({
    args: { organizationId: v.id("organizations"), periodStart: v.number() },
    handler: async (context, { organizationId, periodStart }): Promise<Record<"cpuMs" | "requests" | "storageBytes", number>> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.usageEvents.findMany({ where: { organizationId } });

        return aggregateUsage(page, periodStart);
    },
});
