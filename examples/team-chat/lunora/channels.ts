import { LunoraError } from "@lunora/errors";

import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";

/** Root-scoped, so no shard key: this is the list you read before you know which channel you want. */
export const list = query.query(async ({ ctx }): Promise<Doc<"channels">[]> => {
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
    .input({ name: v.string().meta({ schema: { maxLength: 64 } }) })
    .mutation(async ({ args: { name }, ctx }): Promise<Id<"channels">> => {
        if (!ctx.auth.userId) {
            throw new LunoraError("UNAUTHENTICATED", "sign in to create a channel");
        }

        const slug = name
            .trim()
            .toLowerCase()
            .replaceAll(/[^a-z0-9-]+/gu, "-")
            .replaceAll(/^-+|-+$/gu, "");

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

        return ctx.db.insert("channels", { createdBy: ctx.auth.userId, name: slug });
    });
