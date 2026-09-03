import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

interface CursorDoc {
    _id: Id<"cursors">;
    color: string;
    lastSeen: number;
    name: string;
    roomId: string;
    sessionId: string;
    x: number;
    y: number;
}

/**
 * List every cursor in the room. Because the table is `.shardBy("roomId")`,
 * this query lands on the single DO that owns the room — there is no
 * cross-shard fan-out and every connected client subscribes to the same
 * stream of deltas.
 */
export const listCursors = query.input({ roomId: v.string().max(64) }).query(async ({ args: { roomId }, ctx }): Promise<CursorDoc[]> => {
    const rows = await ctx.db
        .query("cursors")
        .withIndex("by_room_session", (q) => q.eq("roomId", roomId))
        .collect();

    return rows;
});

/**
 * Upsert a participant into the room. The mutation falls back to insert if
 * the session is new, otherwise it patches the existing row in place.
 */
export const joinRoom = mutation
    .input({
        roomId: v.string().max(64),
        sessionId: v.string().max(64),
        name: v.string().max(80),
        color: v.string().max(32),
    })
    .mutation(async ({ args: { roomId, sessionId, name, color }, ctx }): Promise<void> => {
        const existing = await ctx.db
            .query("cursors")
            .withIndex("by_room_session", (q) => q.eq("roomId", roomId).eq("sessionId", sessionId))
            .first();

        if (existing) {
            await ctx.db.patch(existing._id, { name, color, lastSeen: Date.now() });

            return;
        }

        await ctx.db.insert("cursors", {
            roomId,
            sessionId,
            name,
            color,
            x: 0,
            y: 0,
            lastSeen: Date.now(),
        });
    });

/**
 * Stream a single cursor position. Throttle on the client (`~30fps`) — the
 * server will broadcast every accepted write as a delta to every subscriber.
 */
export const updateCursor = mutation
    .input({
        roomId: v.string().max(64),
        sessionId: v.string().max(64),
        x: v.number(),
        y: v.number(),
    })
    .mutation(async ({ args: { roomId, sessionId, x, y }, ctx }): Promise<void> => {
        const existing = await ctx.db
            .query("cursors")
            .withIndex("by_room_session", (q) => q.eq("roomId", roomId).eq("sessionId", sessionId))
            .first();

        if (!existing) {
            return;
        }

        await ctx.db.patch(existing._id, { x, y, lastSeen: Date.now() });
    });
