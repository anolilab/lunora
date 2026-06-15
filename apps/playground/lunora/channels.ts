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

        return page;
    },
});

/**
 * Create a new channel. D1 enforces the `by_name` unique index — duplicate
 * names raise a constraint error the runtime translates into a LunoraError.
 *
 * Accepts an optional client-generated `id` so the offline outbox can key its
 * optimistic channel by the same id the persisted row carries.
 */
export const create = mutation({
    args: { id: v.optional(v.string()), name: v.string() },
    handler: async (context, { id, name }): Promise<Id<"channels">> => {
        const userId = (context.auth.userId ?? "anonymous") as Id<"users">;

        const channelId = await context.db.insert(
            "channels",
            {
                createdAt: Date.now(),
                createdBy: userId,
                name,
            },
            id ? { clientId: id } : undefined,
        );

        // Kick off the durable per-channel welcome sequence (see
        // lunora/workflows.ts). Fire-and-forget: the workflow runs on its own
        // schedule — it posts a greeting, sleeps a minute, then posts a tip.
        await context.workflows.get("channelWelcome").create({ params: { channelId } });

        return channelId;
    },
});
