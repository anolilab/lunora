/**
 * Compile-time only: this file is included by `tsc --noEmit` to exercise the
 * type surface. It is also imported by a no-op test so vitest counts it.
 */
import type { Id, Infer } from "../src/index.js";
import { defineSchema, defineTable, initCirrus, mutation, query, v } from "../src/index.js";

type Assert<T extends true> = T;
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

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

const c = initCirrus.dataModel<Record<string, never>>().create();

// The builder terminal re-states the kind as a literal type.
const builderList = c.query.input({ limit: v.number() }).query(({ args }) => args.limit);

export type _Check4 = Assert<Equal<typeof builderList.kind, "query">>;

// `.input()` flows the validator's inferred type into the handler's `args`.
const builderArgs = c.query.input({ channelId: v.id("channels") }).query(({ args }) => args.channelId);

type BuilderArgs = Parameters<typeof builderArgs.handler>[1];

export type _Check5 = Assert<Equal<BuilderArgs["channelId"], Id<"channels">>>;

// `.use()` returning `next({ ctx })` widens the context the handler sees — if
// the extension weren't threaded through, `ctx.userId` wouldn't type-check.
const builderCtx = c.query.use(async ({ next }) => next({ ctx: { userId: "u" as string } })).query(({ ctx }) => ctx.userId);

export type _Check6 = Assert<Equal<Awaited<ReturnType<typeof builderCtx.handler>>, string>>;
