import { LunoraError } from "@lunora/errors";
import { rateLimit } from "lunorash/ratelimit";

import type { Doc as Document_ } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";
import { makeRateLimiter } from "./ratelimit/schema.js";

/** Signed-in app, so limits key on the user rather than the IP. */
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byUser = { key: (ctx: { auth: { userId?: string | null }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

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
    .input({ channelId: v.string().max(128) })
    .query(async ({ args: { channelId }, ctx }): Promise<Omit<Document_<"presence">, "sessionId">[]> => {
        const rows = await ctx.db
            .query("presence")
            .withIndex("by_channel_session", (q) => q.eq("channelId", channelId))
            .collect();

        // `sessionId` stays server-side. It is the key `heartbeat` and `leave`
        // address a row by, so handing every member everyone else's is handing
        // them the handle to someone else's presence.
        return rows.map(({ sessionId: _sessionId, ...row }) => row);
    });

/**
 * The caller's own presence row for this session, or `undefined` when there is
 * none. A row under this `sessionId` that belongs to someone else is refused
 * rather than returned: `sessionId` is client-chosen, so without the check any
 * member could rename or remove another member's presence by reusing theirs.
 */
const ownPresence = async (ctx: MutationCtx, channelId: string, sessionId: string, userId: string): Promise<Document_<"presence"> | undefined> => {
    const existing = await ctx.db
        .query("presence")
        .withIndex("by_channel_session", (q) => q.eq("channelId", channelId).eq("sessionId", sessionId))
        .first();

    if (existing && existing.userId !== userId) {
        throw new LunoraError("FORBIDDEN", "that presence session belongs to another member");
    }

    return existing ?? undefined;
};

/** Called by every open tab on an interval, and once on channel switch. */
export const heartbeat = mutation
    .use(rateLimit(mutationLimiter, "presence", byUser))
    .input({
        channelId: v.string().max(128),
        sessionId: v.string().max(64),
        name: v.string().max(80),
    })
    .mutation(async ({ args: { channelId, name, sessionId }, ctx }): Promise<void> => {
        if (!ctx.auth.userId) {
            return;
        }

        const existing = await ownPresence(ctx, channelId, sessionId, ctx.auth.userId);

        if (existing) {
            await ctx.db.patch(existing._id, { lastSeen: Date.now(), name });

            return;
        }

        ctx.log.info("presence joined", { channelId, sessionId });
        await ctx.db.insert("presence", { channelId, lastSeen: Date.now(), name, sessionId, userId: ctx.auth.userId });
    });

/** Best-effort goodbye on tab close, so the roster updates without waiting out the TTL. */
export const leave = mutation
    .use(rateLimit(mutationLimiter, "presence", byUser))
    .input({ channelId: v.string().max(128), sessionId: v.string().max(64) })
    .mutation(async ({ args: { channelId, sessionId }, ctx }): Promise<void> => {
        if (!ctx.auth.userId) {
            return;
        }

        const existing = await ownPresence(ctx, channelId, sessionId, ctx.auth.userId);

        if (existing) {
            await ctx.db.delete(existing._id);
        }
    });
