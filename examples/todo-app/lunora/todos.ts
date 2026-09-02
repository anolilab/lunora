import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

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
export const list = query.query(async ({ ctx }): Promise<TodoDoc[]> => {
    const rows = await ctx.db.query("todos").withIndex("by_creation").collect();

    return [...rows].sort((a, b) => b.createdAt - a.createdAt);
});

export const add = mutation
    .input({ text: v.string().max(4096) })
    .mutation(async ({ args: { text }, ctx }): Promise<Id<"todos">> => ctx.db.insert("todos", { text, done: false, createdAt: Date.now() }));

export const toggle = mutation.input({ id: v.id("todos"), done: v.boolean() }).mutation(async ({ args: { id, done }, ctx }): Promise<void> => {
    await ctx.db.patch(id, { done });
});

export const remove = mutation.input({ id: v.id("todos") }).mutation(async ({ args: { id }, ctx }): Promise<void> => {
    await ctx.db.delete(id);
});
