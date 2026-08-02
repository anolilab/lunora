import type { Doc } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";

/**
 * Everyone with a presence row in this channel, stale rows included.
 *
 * Presence is `.shardBy("channelId")` alongside `messages`, so the heartbeat
 * write and the message write land in the same Durable Object — one place, one
 * serialized order, one poke.
 *
 * The staleness cut deliberately lives in the client, not here. A live query is
 * re-evaluated when the shard pokes it, not on a clock, so a `Date.now()`
 * filter in this handler would return whatever the last write happened to make
 * true and then sit there — the roster would only refresh when someone else
 * typed. Heartbeats already poke every subscriber; the client applies the TTL
 * as it renders, and nothing has to sweep expired rows on an alarm.
 */
export const list = query
    .input({ channelId: v.string().meta({ schema: { maxLength: 128 } }) })
    .query(async ({ args: { channelId }, ctx }): Promise<Doc<"presence">[]> =>
        ctx.db
            .query("presence")
            .withIndex("by_channel_session", (q) => q.eq("channelId", channelId))
            .collect(),
    );

/** Called by every open tab on an interval, and once on channel switch. */
export const heartbeat = mutation
    .input({
        channelId: v.string().meta({ schema: { maxLength: 128 } }),
        sessionId: v.string().meta({ schema: { maxLength: 64 } }),
        name: v.string().meta({ schema: { maxLength: 80 } }),
    })
    .mutation(async ({ args: { channelId, name, sessionId }, ctx }): Promise<void> => {
        if (!ctx.auth.userId) {
            return;
        }

        const existing = await ctx.db
            .query("presence")
            .withIndex("by_channel_session", (q) => q.eq("channelId", channelId).eq("sessionId", sessionId))
            .first();

        if (existing) {
            await ctx.db.patch(existing._id, { lastSeen: Date.now(), name });

            return;
        }

        await ctx.db.insert("presence", { channelId, lastSeen: Date.now(), name, sessionId, userId: ctx.auth.userId });
    });

/** Best-effort goodbye on tab close, so the roster updates without waiting out the TTL. */
export const leave = mutation
    .input({ channelId: v.string().meta({ schema: { maxLength: 128 } }), sessionId: v.string().meta({ schema: { maxLength: 64 } }) })
    .mutation(async ({ args: { channelId, sessionId }, ctx }): Promise<void> => {
        const existing = await ctx.db
            .query("presence")
            .withIndex("by_channel_session", (q) => q.eq("channelId", channelId).eq("sessionId", sessionId))
            .first();

        if (existing) {
            await ctx.db.delete(existing._id);
        }
    });
