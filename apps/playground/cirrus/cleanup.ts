import type { Id } from "./_generated/server.js";
import { mutation } from "./_generated/server.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Daily cleanup job — purges messages older than 30 days. Registered as a
 * cron trigger in `wrangler.jsonc` and dispatched by the SchedulerDO at
 * 03:00 UTC every day.
 *
 * Because `messages` is shard-by-channel this mutation runs per-shard. The
 * runtime fans the call out to every active channel DO so the workload
 * stays close to its data.
 */
export const cleanupOldMessages = mutation({
    args: {},
    handler: async (context): Promise<{ deleted: number }> => {
        const cutoff = Date.now() - THIRTY_DAYS_MS;
        // Indexed range scan on `by_created` — reads only the stale rows
        // (`createdAt < cutoff`) instead of loading every message and filtering
        // in memory.
        const stale = (await context.db
            .query("messages")
            .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
            .collect()) as { _id: Id<"messages"> }[];

        for (const row of stale) {
            // eslint-disable-next-line no-await-in-loop -- deletes share one DB handle; parallelizing would interleave statements on a single connection.
            await context.db.delete(row._id);
        }

        return { deleted: stale.length };
    },
});
