/**
 * Compile-time only: this file is included by `tsc --noEmit` to exercise the
 * type surface. It is also imported by a no-op test so vitest counts it.
 */
import { defineSchema, defineTable, mutation, query, v } from "../src/index.js";
import type { Id, Infer } from "../src/index.js";

type Assert<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

const schema = defineSchema({
    messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
    users: defineTable({ email: v.string() }).global(),
});

// schema.tables.messages.shape.text is the v.string validator.
export type _Check1 = Assert<Equal<Infer<typeof schema.tables.messages.shape.channelId>, Id<"channels">>>;

const list = query({
    args: { limit: v.number() },
    handler: (_context, args) => args.limit,
});

const send = mutation({
    args: { text: v.string() },
    handler: (_context, args) => args.text,
});

export type _Check2 = Assert<Equal<typeof list.kind, "query">>;
export type _Check3 = Assert<Equal<typeof send.kind, "mutation">>;
