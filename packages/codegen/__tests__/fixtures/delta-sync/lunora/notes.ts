// Procedures come from the generated `_generated/server` re-export, the way every
// template and example writes them — importing the bare builders from
// `@lunora/server` instead leaves the handler context untyped, which only shows
// up once something compiles the app (and until this fixture, nothing did).
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
