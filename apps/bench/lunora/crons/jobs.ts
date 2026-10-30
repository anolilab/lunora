import { internalAction, v } from "#lunora/_generated/server.js";

/**
 * Crons run on the root shard, and tenant rows live on tenant shards, so each
 * job reads the `.global()` organisation list and queues one message of `kind`
 * per tenant; the `events` consumer runs the work on that tenant's shard.
 */
export const fanOutMaintenance = internalAction
    .input({ kind: v.union(v.literal("maintenance.sweep"), v.literal("headline.refresh")) })
    .action(async ({ args, ctx }): Promise<{ queued: number }> => {
        const { page } = await ctx.db.saas_organizations.findMany({ where: { status: { ne: "deleted" } } });

        await Promise.all(page.map(async (organization) => ctx.queues.events.send({ kind: args.kind, organizationId: organization.organizationId })));

        return { queued: page.length };
    });
