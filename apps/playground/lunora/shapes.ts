import { defineShape, v } from "lunorash/server";

/**
 * Local-first replication shape — a client `subscribeShape("channelMessages", { channelId })`
 * live-syncs just that channel's messages (partial replication). The `where`
 * runs server-side under the socket's trusted identity, so which rows replicate
 * is a server decision (reads-as-permissions).
 */
export const channelMessages = defineShape({
    args: { channelId: v.id("channels") },
    columns: ["channelId", "text", "userId", "createdAt"],
    table: "messages",
    where: (_ctx, arguments_) => {
        return { channelId: arguments_.channelId };
    },
});
