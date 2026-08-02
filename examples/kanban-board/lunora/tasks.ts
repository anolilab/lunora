import { midpoint } from "./ordering.js";
import type { Doc } from "./_generated/dataModel.js";
import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

type Status = Doc<"tasks">["status"];

/** Cards on the board, in column-then-position order. Every browser subscribes to this one query. */
export const list = query.query(async ({ ctx }): Promise<Doc<"tasks">[]> => ctx.db.query("tasks").withIndex("by_status_and_order").order("asc").collect());

/**
 * Append a card to the bottom of a column. The order key is derived server-side
 * from the column's current tail inside the mutation's transaction, so two
 * people adding a card at the same moment cannot mint the same key.
 */
export const create = mutation
    .input({
        title: v.string().meta({ schema: { maxLength: 200 } }),
        status: v.optional(v.union(v.literal("todo"), v.literal("in-progress"), v.literal("done"), v.literal("archived"))),
    })
    .mutation(async ({ args: { title, status: column }, ctx }): Promise<Id<"tasks">> => {
        const target = (column ?? "todo") as Status;
        const cards = await ctx.db
            .query("tasks")
            .withIndex("by_status_and_order", (q) => q.eq("status", target))
            .order("asc")
            .collect();

        return ctx.db.insert("tasks", { order: midpoint(cards.at(-1)?.order ?? null, null), status: target, title });
    });

export const rename = mutation
    .input({ id: v.id("tasks"), title: v.string().meta({ schema: { maxLength: 200 } }) })
    .mutation(async ({ args: { id, title }, ctx }): Promise<void> => {
        await ctx.db.patch(id, { title });
    });

/**
 * Move a card to `index` within `status` — the drop position, not an order key.
 *
 * Resolving the key here rather than in the browser is the whole point of the
 * fractional index: the mutation reads the destination column and computes the
 * midpoint of the two cards that will surround the dropped one, all inside one
 * transaction. A client that dropped against a slightly stale board still lands
 * in the right place, and the write touches exactly one row.
 */
export const move = mutation
    .input({ id: v.id("tasks"), status: v.union(v.literal("todo"), v.literal("in-progress"), v.literal("done"), v.literal("archived")), index: v.number() })
    .mutation(async ({ args: { id, index, status: column }, ctx }): Promise<void> => {
        const card = await ctx.db.get(id);

        if (!card) {
            return;
        }

        const target = column as Status;
        const cards = await ctx.db
            .query("tasks")
            .withIndex("by_status_and_order", (q) => q.eq("status", target))
            .order("asc")
            .collect();

        // The dragged card never counts as its own neighbour.
        const neighbours = cards.filter((row) => row._id !== id);
        const position = Math.max(0, Math.min(Math.trunc(index), neighbours.length));

        await ctx.db.patch(id, { order: midpoint(neighbours[position - 1]?.order ?? null, neighbours[position]?.order ?? null), status: target });
    });

export const remove = mutation.input({ id: v.id("tasks") }).mutation(async ({ args: { id }, ctx }): Promise<void> => {
    await ctx.db.delete(id);
});
