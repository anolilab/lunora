// eslint-disable-next-line unicorn/prevent-abbreviations -- "Doc" is the generated dataModel type name; aliasing it breaks codegen
import type { Doc } from "./_generated/dataModel.js";
import { query } from "./_generated/server.js";

/**
 * List every user (id + display name only — never the email). `.global()` so the
 * read hits D1; the client mirrors it into a TanStack DB collection and joins it
 * against `messages` to render author names instead of raw ids.
 */
export const list = query({
    args: {},
    handler: async (context): Promise<Pick<Doc<"users">, "_id" | "name">[]> => {
        const { page } = await context.db.users.findMany();

        return page.map((user) => {
            return { _id: user._id, name: user.name };
        });
    },
});
