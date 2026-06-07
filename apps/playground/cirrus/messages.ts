// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc } from "./_generated/dataModel.js";
import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/**
 * List recent messages for a channel. The `shardBy("channelId")` on the
 * schema means the runtime routes this query to exactly the channel's DO —
 * no fan-out, full real-time subscriptions.
 */
export const list = query({
    args: { channelId: v.id("channels"), limit: v.optional(v.number()) },
    handler: async (context, { channelId, limit }): Promise<Doc<"messages">[]> => {
        const rows = await context.db
            .query("messages")
            .withIndex("by_channel_created", (q) => q.eq("channelId", channelId))
            .take(limit ?? 50);

        return rows as unknown as Doc<"messages">[];
    },
});

/**
 * Send a message into a channel. Broadcasts a delta to every subscriber on
 * the channel's shard via `ShardDO.broadcastDelta`.
 */
export const send = mutation({
    args: { channelId: v.id("channels"), text: v.string() },
    handler: async (context, { channelId, text }): Promise<Id<"messages">> => {
        const userId = (context.auth.userId ?? "anonymous") as Id<"users">;

        return context.db.insert("messages", {
            channelId,
            createdAt: Date.now(),
            text,
            userId,
        });
    },
});
