import { mutation } from "./_generated/server.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Daily cron job — purges drafts that haven't been touched for 30 days.
 *
 * `wrangler.jsonc` declares the cron trigger (`0 3 * * *`); the
 * `SchedulerDO` from `@lunora/scheduler` fans the run-out to every shard,
 * so each per-author DO clears its own stale rows close to the data.
 */
export const purgeStaleDrafts = mutation.mutation(async ({ ctx }): Promise<{ deleted: number }> => {
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const stale = await ctx.db
        .query("drafts")
        .filter((doc) => typeof doc.updatedAt === "number" && doc.updatedAt < cutoff)
        .collect();

    for (const draft of stale) {
        await ctx.db.delete(draft._id);
    }

    return { deleted: stale.length };
});
