// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc } from "./_generated/dataModel.js";
import type { Id } from "./_generated/server.js";
import { internalMutation, query, v } from "./_generated/server.js";

/**
 * List every user (id + display name only — never the email). `.global()` so the
 * read hits D1; the client mirrors it into a TanStack DB collection and joins it
 * against `messages` to render author names instead of raw ids.
 */
export const list = query.query(async ({ ctx }): Promise<Pick<Doc<"users">, "_id" | "name">[]> => {
    const { page } = await ctx.db.users.findMany();

    return page.map((user) => {
        return { _id: user._id, name: user.name };
    });
});

/**
 * Mirror one better-auth user into `users`, keyed by the better-auth id so the
 * client's `messages.userId → users._id` join resolves.
 *
 * Called from the worker's better-auth `databaseHooks` (see
 * `src/server/index.ts`), never from a client — hence internal. An upsert, so a
 * hook that re-runs (or a later `update`) converges instead of colliding on the
 * primary key. The explicit `_id` needs the trusted `insertManyUnsafe` path:
 * `insert`'s `clientId` only accepts UUIDs, and better-auth ids are not.
 */
export const mirrorAuthUser = internalMutation
    .input({ email: v.string().max(320), id: v.string().max(128), name: v.string().max(256) })
    .mutation(async ({ args: { email, id, name }, ctx }): Promise<void> => {
        const existing = await ctx.db.users.findFirst({ where: { _id: id as Id<"users"> } });

        if (existing) {
            await ctx.db.users.patch(existing._id, { email, name });

            return;
        }

        await ctx.db.insertManyUnsafe("users", [{ _id: id, email, name }], { allowExplicitId: true });
    });
