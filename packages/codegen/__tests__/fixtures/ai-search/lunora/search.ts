// `ctx.aiSearch` is read here and nowhere else, so this file alone is what flips
// the usage probe: no `@lunora/bindings/ai-search` import, exactly how an app
// written against the generated `server.ts` reaches it.
import { action, query, v } from "./_generated/server.js";

export const ask = action.input({ query: v.string() }).action(async ({ args, ctx }) => {
    const result = await ctx.aiSearch.get("docs").search({ query: args.query });

    return result.chunks.map((chunk) => chunk.text);
});

export const count = query.input({}).query(async ({ ctx }) => {
    // @ts-expect-error -- `ctx.aiSearch` is ActionCtx-only: billed, non-deterministic network I/O never rides a query.
    void ctx.aiSearch;

    return (await ctx.db.query("questions").collect()).length;
});
