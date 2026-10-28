import { internalAction } from "#lunora/_generated/server.js";

/**
 * Crons run on the root shard, and tenant rows live on tenant shards, so the
 * nightly job reads the `.global()` organisation list and queues one
 * maintenance message per tenant; the consumer runs the sweep on that tenant's
 * shard.
 */
export const fanOutMaintenance = internalAction.action(async ({ ctx }): Promise<{ queued: number }> => {
    const { page } = await ctx.db.saas_organizations.findMany({ where: { status: { ne: "deleted" } } });

    await Promise.all(page.map(async (organization) => ctx.queues.events.send({ kind: "maintenance.sweep", organizationId: organization.organizationId })));

    return { queued: page.length };
});
