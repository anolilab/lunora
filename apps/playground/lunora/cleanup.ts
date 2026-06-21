import { internalMutation, v } from "./_generated/server.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Daily cleanup job — purges messages older than 30 days. Modelled as an
 * `internalMutation` (callable only server-side via `ctx.runMutation` / a cron),
 * never from a client, so bulk deletes can't be triggered over the public API.
 *
 * Because `messages` is shard-by-channel this mutation runs per-shard. The
 * runtime fans the call out to every active channel DO so the workload
 * stays close to its data.
 *
 * `now` is taken as an arg rather than read from `Date.now()` here — a mutation
 * handler must be deterministic, so the dispatcher stamps the wall-clock time
 * (the same place a cron job supplies its args) and the handler derives the
 * 30-day cutoff from it.
 */
export const cleanupOldMessages = internalMutation.input({ now: v.number() }).mutation(async ({ args, ctx }): Promise<{ deleted: number }> => {
    const cutoff = args.now - THIRTY_DAYS_MS;
    // Indexed range scan on `by_created` — reads only the stale rows
    // (`createdAt < cutoff`) instead of loading every message and filtering
    // in memory. `collect()` is typed to `Doc<"messages">[]`, so `row._id` is
    // already an `Id<"messages">` — no cast needed.
    const stale = await ctx.db
        .query("messages")
        .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
        .collect();

    for (const row of stale) {
        // eslint-disable-next-line no-await-in-loop -- deletes share one DB handle; parallelizing would interleave statements on a single connection.
        await ctx.db.delete(row._id);
    }

    return { deleted: stale.length };
});
