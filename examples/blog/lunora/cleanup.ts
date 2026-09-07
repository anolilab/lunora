import { internalMutation } from "./_generated/server.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Purges drafts that haven't been touched for 30 days.
 *
 * `internalMutation`, not `mutation`: this deletes every author's stale rows, so
 * it must not be reachable from a client. Internal functions are absent from the
 * generated `api` and are only dispatchable server-side, through `internal.*` —
 * `lunora/crons.ts` points the nightly trigger at it.
 */
export const purgeStaleDrafts = internalMutation.mutation(async ({ ctx }): Promise<{ deleted: number }> => {
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const stale = await ctx.db
        .query("drafts")
        .withIndex("by_updated", (range) => range.lt("updatedAt", cutoff))
        .collect();

    for (const draft of stale) {
        await ctx.db.delete(draft._id);
    }

    return { deleted: stale.length };
});
