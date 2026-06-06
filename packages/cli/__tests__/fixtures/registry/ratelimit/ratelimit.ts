import { mutation, v } from "@cirrus/server";

export const consume = mutation({
    args: { key: v.string() },
    handler: async (ctx, { key }) => {
        // Placeholder rate-limit logic — user-owned, edit freely.
        return { allowed: true, key };
    },
});
