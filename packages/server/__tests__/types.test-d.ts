/**
 * Compile-time only: this file is included by `tsc --noEmit` to exercise the
 * type surface. It is also imported by a no-op test so vitest counts it.
 */
import type { CirrusRouteHandler, EmptyArgs, Id, Infer, RegisteredQuery } from "../src/index.js";
import { defineSchema, defineTable, httpRoute, initCirrus, mutation, query, v } from "../src/index.js";

type Assert<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- canonical type-equality idiom; each fresh `T` in the two function signatures is structurally load-bearing (relaxing it breaks the invariance check).
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
const builderCtx = c.query.use(async ({ next }) => next({ ctx: { userId: "u" } })).query(({ ctx }) => ctx.userId);

export type _Check6 = Assert<Equal<Awaited<ReturnType<typeof builderCtx.handler>>, string>>;

// `.output(validator)` narrows the registered return type to the validator's
// inferred type, regardless of what the handler body would infer on its own.
const outputValidator = v.object({ count: v.number() });
const builderOutput = c.query.output(outputValidator).query(() => {
    return { count: 1 };
});

export type _Check7 = Assert<Equal<typeof builderOutput, RegisteredQuery<EmptyArgs, Infer<typeof outputValidator>>>>;

// `.output()` composes with `.input()` in either order: args stay typed and the
// declared output type wins for the registered return.
const builderInputOutput = c.mutation
    .input({ text: v.string() })
    .output(v.string())
    .mutation(({ args }) => args.text);

export type _Check8 = Assert<Equal<Awaited<ReturnType<typeof builderInputOutput.handler>>, string>>;

// A handler whose return type doesn't satisfy `.output()` is a compile error.
// @ts-expect-error - handler returns string, but .output declares { count: number }
const builderOutputMismatch = c.query.output(v.object({ count: v.number() })).query(() => "nope");

export type _Check9 = Assert<Equal<typeof builderOutputMismatch.kind, "query">>;

// `httpRoute`: `.searchParams()` / `.body()` / `.params()` flow the validator
// maps into the handler's typed `{ searchParams, body, params }`.
const itemsRoute = httpRoute.get("/api/items/:id").searchParams({ limit: v.number() }).body({ text: v.string() }).params({ id: v.string() });

type ItemsOptions = Parameters<Parameters<typeof itemsRoute.handler>[0]>[0];

export type _Check10 = Assert<Equal<ItemsOptions["searchParams"]["limit"], number>>;
export type _Check11 = Assert<Equal<ItemsOptions["body"]["text"], string>>;
export type _Check11b = Assert<Equal<ItemsOptions["params"]["id"], string>>;

// The terminal `.handler()` yields a `CirrusRouteHandler`, mountable on `httpRouter`.
const pingRoute = httpRoute.get("/api/ping").handler(() => {
    return { ok: true };
});

export type _Check12 = Assert<Equal<typeof pingRoute, CirrusRouteHandler>>;

// `.output()` constrains the handler's return — a mismatch is a compile error.
// The directive sits immediately before `.handler(() => 42)` because TypeScript
// attributes the type error to that specific line within the multi-line chain;
// prettier re-splits long chains, so an above-the-const placement won't survive
// the pre-commit hook.
const routeOutputMismatch = httpRoute
    .get("/api/x")
    .output(v.string())
    // @ts-expect-error - handler returns number, but .output declares string
    .handler(() => 42);

export type _Check13 = Assert<Equal<typeof routeOutputMismatch, CirrusRouteHandler>>;
