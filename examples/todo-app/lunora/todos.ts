import type { Id } from "@lunora/server";
import { mutation, query, v } from "@lunora/server";

interface TodoDoc {
    _id: Id<"todos">;
    createdAt: number;
    done: boolean;
    text: string;
}

/**
 * List todos newest-first. Subscribers receive deltas the moment any of
 * `add` / `toggle` / `remove` mutate the table.
 */
export const list = query({
    args: {},
    handler: async (ctx): Promise<TodoDoc[]> => {
        const rows = (await ctx.db.query("todos").withIndex("by_creation").collect()) as unknown as TodoDoc[];

        return [...rows].sort((a, b) => b.createdAt - a.createdAt);
    },
});

export const add = mutation({
    args: { text: v.string() },
    handler: async (ctx, { text }): Promise<Id<"todos">> => ctx.db.insert("todos", { text, done: false, createdAt: Date.now() }),
});

export const toggle = mutation({
    args: { id: v.id("todos"), done: v.boolean() },
    handler: async (ctx, { id, done }): Promise<void> => {
        await ctx.db.patch(id, { done });
    },
});

export const remove = mutation({
    args: { id: v.id("todos") },
    handler: async (ctx, { id }): Promise<void> => {
        await ctx.db.delete(id);
    },
});
