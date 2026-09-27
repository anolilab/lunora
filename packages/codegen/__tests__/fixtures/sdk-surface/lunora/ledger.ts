// `v.bigint()` travels as a TAGGED wire value that no generated model field can
// produce, so every function here must reach the generated SDKs untyped — both
// directly and where the bigint hides in an array element or a nested object.
import { mutation, query, v } from "./_generated/server.js";

export const charge = mutation
    .input({ amount: v.bigint(), memo: v.optional(v.string()) })
    .output(v.bigint())
    .mutation(async ({ args }) => args.amount);

export const balances = query
    .input({ accounts: v.array(v.object({ id: v.string(), limit: v.optional(v.bigint()) })) })
    .output(v.object({ rows: v.array(v.object({ amount: v.bigint() })), total: v.bigint() }))
    .query(async () => {
        return { rows: [{ amount: 1n }], total: 1n };
    });
