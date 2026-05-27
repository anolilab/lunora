import type { Id } from "@cirrus/server";
import { mutation, query, v } from "@cirrus/server";

interface MessageDocument {
    _id: Id<"messages">;
    channelId: Id<"channels">;
    createdAt: number;
    text: string;
    userId: Id<"users">;
}

/**
 * List recent messages for a channel. The `shardBy("channelId")` on the
 * schema means the runtime routes this query to exactly the channel's DO —
 * no fan-out, full real-time subscriptions.
 */
export const list = query({
    args: { channelId: v.id("channels"), limit: v.optional(v.number()) },
    handler: async (context, { channelId, limit }): Promise<MessageDocument[]> => {
        const rows = await context.db
            .query("messages")
            .withIndex("by_channel_created", (q) => q.eq("channelId", channelId))
            .take(limit ?? 50);

        return rows as unknown as MessageDocument[];
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
