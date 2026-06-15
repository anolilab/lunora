import type { Id } from "@lunora/server";
import { mutation, query, v } from "@lunora/server";

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
export const listCursors = query({
    args: { roomId: v.string() },
    handler: async (ctx, { roomId }): Promise<CursorDoc[]> => {
        const rows = (await ctx.db
            .query("cursors")
            .withIndex("by_room_session", (q) => q.eq("roomId", roomId))
            .collect()) as unknown as CursorDoc[];

        return rows;
    },
});

/**
 * Upsert a participant into the room. The mutation falls back to insert if
 * the session is new, otherwise it patches the existing row in place.
 */
export const joinRoom = mutation({
    args: {
        roomId: v.string(),
        sessionId: v.string(),
        name: v.string(),
        color: v.string(),
    },
    handler: async (ctx, { roomId, sessionId, name, color }): Promise<void> => {
        const existing = (await ctx.db
            .query("cursors")
            .withIndex("by_room_session", (q) => q.eq("roomId", roomId).eq("sessionId", sessionId))
            .first()) as { _id: Id<"cursors"> } | null;

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
    },
});

/**
 * Stream a single cursor position. Throttle on the client (`~30fps`) — the
 * server will broadcast every accepted write as a delta to every subscriber.
 */
export const updateCursor = mutation({
    args: {
        roomId: v.string(),
        sessionId: v.string(),
        x: v.number(),
        y: v.number(),
    },
    handler: async (ctx, { roomId, sessionId, x, y }): Promise<void> => {
        const existing = (await ctx.db
            .query("cursors")
            .withIndex("by_room_session", (q) => q.eq("roomId", roomId).eq("sessionId", sessionId))
            .first()) as { _id: Id<"cursors"> } | null;

        if (!existing) {
            return;
        }

        await ctx.db.patch(existing._id, { x, y, lastSeen: Date.now() });
    },
});
