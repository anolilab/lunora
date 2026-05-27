import type { Id } from "@cirrus/server";
import { mutation, query, v } from "@cirrus/server";

interface ChannelDocument {
    _id: Id<"channels">;
    createdAt: number;
    createdBy: Id<"users">;
    name: string;
}

/**
 * List every channel — `.global()` so the read happens against D1, with
 * `withSession(bookmark)` consistency provided by the runtime adapter.
 */
export const list = query({
    args: {},
    handler: async (context): Promise<ChannelDocument[]> => {
        const rows = await context.db.query("channels").collect();

        return rows as unknown as ChannelDocument[];
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
