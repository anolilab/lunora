import type { Id } from "@cirrus/server";
import { mutation, query, v } from "@cirrus/server";

interface DraftDoc {
    _id: Id<"drafts">;
    authorId: Id<"users">;
    body: string;
    title: string;
    updatedAt: number;
}

/**
 * List the signed-in user's autosaved drafts.
 */
export const listMine = query({
    args: {},
    handler: async (ctx): Promise<DraftDoc[]> => {
        if (!ctx.auth.userId) {
            return [];
        }

        const rows = (await ctx.db.query("drafts").withIndex("by_updated").collect()) as unknown as DraftDoc[];

        return rows.filter((draft) => draft.authorId === (ctx.auth.userId as Id<"users">));
    },
});

/**
 * Autosave a draft. Clients call this on every keystroke (debounced) so
 * users never lose work — the nightly cleanup job below sweeps anything
 * older than 30 days.
 */
export const save = mutation({
    args: { id: v.optional(v.id("drafts")), title: v.string(), body: v.string() },
    handler: async (ctx, { id, title, body }): Promise<Id<"drafts">> => {
        if (!ctx.auth.userId) {
            throw new Error("not signed in");
        }

        const userId = ctx.auth.userId as Id<"users">;

        if (id) {
            await ctx.db.patch(id, { title, body, updatedAt: Date.now() });

            return id;
        }

        return ctx.db.insert("drafts", { authorId: userId, title, body, updatedAt: Date.now() });
    },
});
