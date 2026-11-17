import { internalAction, v } from "#lunora/_generated/server.js";

/** Cloudflare Queues takes at most 100 messages per `sendBatch`. */
const PAGE_SIZE = 100;

/**
 * Crons run on the root shard, and tenant rows live on tenant shards, so each
 * job reads the `.global()` organisation list and queues one message of `kind`
 * per tenant; the `events` consumer runs the work on that tenant's shard.
 *
 * A page at a time, one batch send per page, so neither the read nor the
 * in-flight sends grow with the tenant count.
 */
export const fanOutMaintenance = internalAction
    .input({ kind: v.union(v.literal("maintenance.sweep"), v.literal("headline.refresh")) })
    .action(async ({ args, ctx }): Promise<{ queued: number }> => {
        const activePage = async (cursor: string | undefined) =>
            ctx.db.saas_organizations.findMany({ cursor, limit: PAGE_SIZE, where: { status: { ne: "deleted" } } });
        let cursor: string | undefined;
        let queued = 0;

        do {
            // eslint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
            const result = await activePage(cursor);

            if (result.page.length > 0) {
                // eslint-disable-next-line no-await-in-loop -- one batch in flight at a time bounds the concurrency
                await ctx.queues.events.sendBatch(
                    result.page.map((organization) => {
                        return { body: { kind: args.kind, organizationId: organization.organizationId } };
                    }),
                );
                queued += result.page.length;
            }

            cursor = result.isDone ? undefined : (result.continueCursor ?? undefined);
        } while (cursor !== undefined);

        return { queued };
    });
