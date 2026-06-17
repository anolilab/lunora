import { defineSchema, defineTable, v } from "lunora/server";

/**
 * realtime-cursors — multi-user cursor positions, sharded per room.
 *
 * `.shardBy("roomId")` means each distinct `roomId` gets its own ShardDO.
 * That keeps the WebSocket fan-out tight: a cursor update broadcasts to the
 * single DO that owns the room, not to every connected client globally.
 * Adding rooms scales horizontally for free.
 */
export default defineSchema({
    cursors: defineTable({
        roomId: v.string(),
        sessionId: v.string(),
        name: v.string(),
        color: v.string(),
        x: v.number(),
        y: v.number(),
        lastSeen: v.number(),
    })
        .shardBy("roomId")
        .index("by_room_session", ["roomId", "sessionId"], { unique: true }),
});
