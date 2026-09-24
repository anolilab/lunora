import { rateLimit } from "lunorash/ratelimit";

import type { Id, MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";
import { makeRateLimiter } from "./ratelimit/schema.js";

/**
 * The limiter comes from `lunora/ratelimit/schema.ts`, which owns both named
 * limits — `join` for the once-per-session upsert, `move` for the position
 * stream. See that file for why `move` is deliberately loose.
 *
 * There is no sign-in here, so `ctx.ip` keys the buckets. Never key on
 * `args.sessionId`: a client picks that value and can rotate it per request, so
 * it would never share a bucket with itself. `ctx.ip` is Cloudflare's
 * server-side `CF-Connecting-IP` and is `undefined` off Cloudflare, where every
 * caller then shares the one `"anon"` bucket.
 */
const limiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byCaller = { key: (ctx: { ip?: string }): string => ctx.ip ?? "anon" };

interface CursorDocument {
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
export const listCursors = query.input({ roomId: v.string().max(64) }).query(async ({ args: { roomId }, ctx }): Promise<CursorDocument[]> => {
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
    .use(rateLimit(limiter, "join", byCaller))
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
    .use(rateLimit(limiter, "move", byCaller))
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
