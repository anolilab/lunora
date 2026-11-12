import { LunoraError } from "@lunora/errors";

import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server.js";

/**
 * Refuse unless the signed-in caller is a member of this channel.
 *
 * Reads `members` inside the channel's own shard, so the check and the data it
 * protects are in one serialized place. Not exported as a procedure: it is a
 * guard every channel procedure calls first.
 */
export const requireMember = async (ctx: QueryCtx | MutationCtx | ActionCtx, channelId: string): Promise<void> => {
    const userId = ctx.auth.userId;

    if (!userId) {
        throw new LunoraError("UNAUTHENTICATED", "sign in to use channels");
    }

    const row = await ctx.db
        .query("members")
        .withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId))
        .first();

    if (!row) {
        throw new LunoraError("FORBIDDEN", `join #${channelId} first`);
    }
};
