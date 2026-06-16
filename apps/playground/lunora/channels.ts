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
 *
 * `createdAt` is taken as an arg rather than read from `Date.now()` here — a
 * mutation handler must be deterministic, so the client stamps it (its optimistic
 * row carries the same value, so optimistic and persisted rows agree).
 */
export const create = mutation({
    args: {
        createdAt: v.number(),
        id: v.optional(v.string().meta({ schema: { maxLength: 64 } })),
        name: v.string().meta({ schema: { maxLength: 128 } }),
    },
    handler: async (context, { createdAt, id, name }): Promise<Id<"channels">> => {
        const userId = (context.auth.userId ?? "anonymous") as Id<"users">;

        const channelId = await context.db.insert(
            "channels",
            {
                createdAt,
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
