import { mutation, query } from "./_generated/server.js";

const COUNTER_NAME = "global";

/**
 * Current count. Returns 0 until the first `increment`. Any client reading this
 * with `useQuery` is subscribed — when `increment` runs, every subscriber's
 * value updates over the WebSocket without a refetch.
 */
export const get = query.query(async ({ ctx }): Promise<number> => {
    const rows = await ctx.db.query("counter").withIndex("by_name").collect();

    return rows.find((row) => row.name === COUNTER_NAME)?.value ?? 0;
});

/** Bump the shared counter by one, inserting the row on first use. Returns the new value. */
export const increment = mutation.mutation(async ({ ctx }): Promise<number> => {
    const rows = await ctx.db.query("counter").withIndex("by_name").collect();
    const existing = rows.find((row) => row.name === COUNTER_NAME);

    if (existing) {
        const next = existing.value + 1;

        await ctx.db.patch(existing._id, { value: next });

        return next;
    }

    await ctx.db.insert("counter", { name: COUNTER_NAME, value: 1 });

    return 1;
});
