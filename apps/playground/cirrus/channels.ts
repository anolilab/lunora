// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc } from "./_generated/dataModel.js";
import type { Id } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";

/**
 * List every channel — `.global()` so the read happens against D1, with
 * `withSession(bookmark)` consistency provided by the runtime adapter. Global
 * (D1) tables use the `findMany` reader rather than the shard-local fluent
 * `query()` chain (which isn't available on the D1 backend).
 */
export const list = query({
    args: {},
    handler: async (context): Promise<Doc<"channels">[]> => {
        const { page } = await context.db.channels.findMany();

        return page as unknown as Doc<"channels">[];
    },
});

/**
 * Create a new channel. D1 enforces the `by_name` unique index — duplicate
 * names raise a constraint error the runtime translates into a CirrusError.
 */
export const create = mutation({
    args: { name: v.string() },
    handler: async (context, { name }): Promise<Id<"channels">> => {
        const userId = (context.auth.userId ?? "anonymous") as Id<"users">;

        return context.db.insert("channels", {
            createdAt: Date.now(),
            createdBy: userId,
            name,
        });
    },
});
