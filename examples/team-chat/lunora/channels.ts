import { LunoraError } from "@lunora/errors";
import { rateLimit } from "lunorash/ratelimit";

import type { Doc as Document_, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";
import { requireMember } from "./membership.js";
import { makeRateLimiter } from "./ratelimit/schema.js";

/**
 * Everyone here is signed in, so limits are keyed by user rather than by IP —
 * one person on a shared network must not be able to exhaust another's budget.
 */
const mutationLimiter = (ctx: MutationCtx) => makeRateLimiter(ctx);
const byUser = { key: (ctx: { auth: { userId?: string | null }; ip?: string }): string => ctx.auth.userId ?? ctx.ip ?? "anon" };

/** Root-scoped, so no shard key: this is the list you read before you know which channel you want. */
export const list = query.query(async ({ ctx }): Promise<Document_<"channels">[]> => {
    if (!ctx.auth.userId) {
        return [];
    }

    return ctx.db.query("channels").withIndex("by_name").order("asc").collect();
});

/**
 * Create a channel. The `by_name` index is unique, so the duplicate check below
 * is a friendlier error, not the guarantee — two people creating `#general` at
 * the same moment cannot both win.
 */
export const create = mutation
    .use(rateLimit(mutationLimiter, "send", byUser))
    .input({ name: v.string().max(64) })
    .mutation(async ({ args: { name }, ctx }): Promise<{ id: Id<"channels">; name: string }> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to create a channel");
        }

        // `split("-").filter(Boolean).join("-")` rather than a trailing
        // `replaceAll(/^-+|-+$/gu, "")`: the alternation-of-quantifiers form is what a
        // ReDoS scanner flags, and this also collapses interior runs in the same pass.
        const slug = name
            .trim()
            .toLowerCase()
            .replaceAll(/[^a-z0-9-]+/gu, "-")
            .split("-")
            .filter(Boolean)
            .join("-");

        if (!slug) {
            throw new LunoraError("BAD_REQUEST", "channel name must contain a letter or a digit");
        }

        const existing = await ctx.db
            .query("channels")
            .withIndex("by_name", (q) => q.eq("name", slug))
            .first();

        if (existing) {
            throw new LunoraError("CONFLICT", `#${slug} already exists`);
        }

        ctx.log.info("channel created", { name: slug });

        return { id: await ctx.db.insert("channels", { createdBy: ctx.auth.userId, name: slug }), name: slug };
    });

/** Write the membership row if it is absent. */
const addMember = async (ctx: MutationCtx, channelId: string, userId: string): Promise<void> => {
    const existing = await ctx.db
        .query("members")
        .withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId))
        .first();

    if (!existing) {
        await ctx.db.insert("members", { channelId, joinedAt: Date.now(), userId });
    }
};

/**
 * Join a channel. Idempotent. The client calls this right after `create` (with
 * the channel's shard key), which is how the creator becomes a member.
 *
 * It does not check that the channel exists in the root `channels` table: a
 * channel shard cannot read that table. That is no wider than before, where
 * `messages.send` already accepts any channel id a signed-in caller names; a
 * membership row for an unknown name grants access to nothing.
 */
export const join = mutation
    .use(rateLimit(mutationLimiter, "send", byUser))
    .input({ channelId: v.string().max(128) })
    .mutation(async ({ args: { channelId }, ctx }): Promise<void> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to join a channel");
        }

        await addMember(ctx, channelId, ctx.auth.userId);

        ctx.log.info("channel joined", { channelId });
    });

/** Leave a channel. Removing the last member is allowed; the channel stays. */
export const leave = mutation
    .use(rateLimit(mutationLimiter, "send", byUser))
    .input({ channelId: v.string().max(128) })
    .mutation(async ({ args: { channelId }, ctx }): Promise<void> => {
        const { userId } = ctx.auth;

        if (!userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to leave a channel");
        }

        const existing = await ctx.db
            .query("members")
            .withIndex("by_channel_user", (q) => q.eq("channelId", channelId).eq("userId", userId))
            .first();

        if (existing) {
            await ctx.db.delete("members", existing._id);
        }

        // Without this the other members keep seeing the leaver online until the client-side TTL lapses,
        // and the leaver's own heartbeats now stop at the membership guard.
        const presence = await ctx.db
            .query("presence")
            .withIndex("by_channel_session", (q) => q.eq("channelId", channelId))
            .collect();

        await Promise.all(presence.filter((row) => row.userId === userId).map(async (row) => ctx.db.delete("presence", row._id)));

        ctx.log.info("channel left", { channelId });
    });

/** Whether the caller is a member, and how many members the channel has. Visible to any signed-in user, so they can decide to join. */
export const membership = query
    .input({ channelId: v.string().max(128) })
    .query(async ({ args: { channelId }, ctx }): Promise<{ isMember: boolean; memberCount: number }> => {
        const rows = await ctx.db
            .query("members")
            .withIndex("by_channel_user", (q) => q.eq("channelId", channelId))
            .collect();

        const isMember = Boolean(ctx.auth.userId) && rows.some((row) => row.userId === ctx.auth.userId);

        return { isMember, memberCount: rows.length };
    });

/** Member ids and join times for a channel. Member-only, so a non-member cannot enumerate who is in it. */
export const members = query
    .input({ channelId: v.string().max(128) })
    .query(async ({ args: { channelId }, ctx }): Promise<{ joinedAt: number; userId: string }[]> => {
        if (!ctx.auth.userId) {
            return [];
        }

        await requireMember(ctx, channelId);

        const rows = await ctx.db
            .query("members")
            .withIndex("by_channel_user", (q) => q.eq("channelId", channelId))
            .collect();

        return rows.map((row) => {
            return { joinedAt: row.joinedAt, userId: row.userId };
        });
    });
