import { internalMutation, mutation, query, v } from "@lunora/server";

export const list = query({
    args: { channelId: v.id("channels"), limit: v.optional(v.number()) },
    handler: async (_context, args) => {
        return { channelId: args.channelId, limit: args.limit ?? 50 };
    },
});

export const send = mutation({
    args: {
        channelId: v.id("channels"),
        text: v.string(),
        kind: v.union(v.literal("text"), v.literal("image")),
        tags: v.record(v.string(), v.string()),
    },
    handler: async (_context, args) => {
        return { channelId: args.channelId, text: args.text, kind: args.kind, tags: args.tags };
    },
});

export const purge = internalMutation({
    args: { channelId: v.id("channels") },
    handler: async (_context, args) => {
        return { channelId: args.channelId, purged: 0 };
    },
});

// Issue #688: a `v.optional(...)` wrapping an object that holds a bare `v.any()`.
// `v.any()` returns its input unchanged, so the runtime parses an absent field and
// `Infer` types the key `data?: unknown`; the emitted reference has to render the
// same optional key or a handler's own `args` stops being assignable to the
// reference of a procedure declaring the identical validator. Internal on purpose:
// the advisor's `public_arg_uses_any` lint skips internal functions.
export const probeSink = internalMutation({
    args: { shape: v.optional(v.object({ data: v.any(), id: v.string() })) },
    handler: async () => {
        return null;
    },
});
