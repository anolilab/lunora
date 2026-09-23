import { mutation, query, v } from "./_generated/server.js";

export const list = query.input({ boardId: v.string() }).query(async ({ args, ctx }) => {
    return ctx.db
        .query("notes")
        .withIndex("by_board", (q) => q.eq("boardId", args.boardId))
        .collect();
});

export const add = mutation.input({ body: v.string(), boardId: v.string() }).mutation(async ({ args, ctx }) => {
    return ctx.db.insert("notes", { body: args.body, boardId: args.boardId, ownerId: ctx.auth.userId ?? "" });
});
