/**
 * Compile-time only: this file is included by `tsc --noEmit` to exercise the
 * type surface. It is also imported by a no-op test so vitest counts it.
 *
 * All builder chains under test live inside the `check` function body so their
 * inferred (generic-builder) types stay function-local — not part of the
 * module's declaration output — which keeps the file `--isolatedDeclarations`-
 * clean without hand-annotating each builder's complex inferred return type.
 */
import type {
    ActionCtx,
    EmptyArgs,
    Id,
    Infer,
    LunoraRouteHandler,
    QueryCtx,
    RegisteredQuery,
    ScheduledFunctionDoc,
    StorageMetadata,
    TableReader,
} from "../src/index";
import { defineSchema, defineTable, httpRoute, initLunora, v } from "../src/index";

type Assert<T extends true> = T;
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- canonical type-equality idiom; each fresh `T` in the two function signatures is structurally load-bearing (relaxing it breaks the invariance check).
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// Server-to-server callers: `ctx.runQuery` / `runMutation` infer both the args
// type and the result type from the passed function reference. Ambient (`declare`)
// so they can't live inside the function body.

/**
 * Structural stand-in for `@lunora/client`'s `FunctionReference`, matching what
 * codegen emits into `_generated/api.ts`. Declared locally because
 * `@lunora/server` deliberately carries no dependency on the client package —
 * the compatibility this asserts is structural, so a local mirror is the
 * honest way to test it.
 */
interface FunctionReferenceLike<Kind extends "action" | "mutation" | "query" | "stream", Args, Return> {
    readonly __lunoraPhantom?: { args: Args; kind: Kind; returns: Return };
    readonly __lunoraRef: string;
}

declare const actionCtx: ActionCtx;
declare const queryCtx: QueryCtx;

/**
 * A reader bound the way codegen binds it: the table's declared index names,
 * not `string`. This is what turns a stale index name into a compile error
 * instead of a runtime throw or a silent full-table scan.
 */
declare const boundReader: TableReader<{ channelId: string; text: string }, "by_channel" | "by_created", "by_text", never>;

/** A reader for a table that declares no indexes of any kind — every name is rejected. */
declare const unindexedReader: TableReader<{ text: string }, never, never, never>;

const check = (): void => {
    const { mutation, query } = initLunora.dataModel().create();

    const schema = defineSchema({
        messages: defineTable({ channelId: v.id("channels"), text: v.string() }).shardBy("channelId"),
        users: defineTable({ email: v.string() }).global(),
    });

    // schema.tables.messages.shape.text is the v.string validator.
    type Check1 = Assert<Equal<Infer<typeof schema.tables.messages.shape.channelId>, Id<"channels">>>;

    const list = query.input({ limit: v.number() }).query(({ args }) => args.limit);

    const send = mutation.input({ text: v.string() }).mutation(({ args }) => args.text);

    type Check2 = Assert<Equal<typeof list.kind, "query">>;
    type Check3 = Assert<Equal<typeof send.kind, "mutation">>;

    const c = initLunora.dataModel<Record<string, never>>().create();

    // The builder terminal re-states the kind as a literal type.
    const builderList = c.query.input({ limit: v.number() }).query(({ args }) => args.limit);

    type Check4 = Assert<Equal<typeof builderList.kind, "query">>;

    // `.input()` flows the validator's inferred type into the handler's `args`.
    const builderArgs = c.query.input({ channelId: v.id("channels") }).query(({ args }) => args.channelId);

    type BuilderArgs = Parameters<typeof builderArgs.handler>[1];

    type Check5 = Assert<Equal<BuilderArgs["channelId"], Id<"channels">>>;

    // `.use()` returning `next({ ctx })` widens the context the handler sees — if
    // the extension weren't threaded through, `ctx.userId` wouldn't type-check.
    const builderContext = c.query.use(async ({ next }) => next({ ctx: { userId: "u" } })).query(({ ctx }) => ctx.userId);

    type Check6 = Assert<Equal<Awaited<ReturnType<typeof builderContext.handler>>, string>>;

    // `.output(validator)` narrows the registered return type to the validator's
    // inferred type, regardless of what the handler body would infer on its own.
    const outputValidator = v.object({ count: v.number() });
    const builderOutput = c.query.output(outputValidator).query(() => {
        return { count: 1 };
    });

    type Check7 = Assert<Equal<typeof builderOutput, RegisteredQuery<EmptyArgs, Infer<typeof outputValidator>>>>;

    // `.output()` composes with `.input()` in either order: args stay typed and the
    // declared output type wins for the registered return.
    const builderInputOutput = c.mutation
        .input({ text: v.string() })
        .output(v.string())
        .mutation(({ args }) => args.text);

    type Check8 = Assert<Equal<Awaited<ReturnType<typeof builderInputOutput.handler>>, string>>;

    // A handler whose return type doesn't satisfy `.output()` is a compile error.
    // @ts-expect-error - handler returns string, but .output declares { count: number }
    const builderOutputMismatch = c.query.output(v.object({ count: v.number() })).query(() => "nope");

    type Check9 = Assert<Equal<typeof builderOutputMismatch.kind, "query">>;

    // `httpRoute`: `.searchParams()` / `.body()` / `.params()` flow the validator
    // maps into the handler's typed `{ searchParams, body, params }`.
    const itemsRoute = httpRoute.get("/api/items/:id").searchParams({ limit: v.number() }).body({ text: v.string() }).params({ id: v.string() });

    type ItemsOptions = Parameters<Parameters<typeof itemsRoute.handler>[0]>[0];

    type Check10 = Assert<Equal<ItemsOptions["searchParams"]["limit"], number>>;
    type Check11 = Assert<Equal<ItemsOptions["body"]["text"], string>>;
    type Check11b = Assert<Equal<ItemsOptions["params"]["id"], string>>;

    // The terminal `.handler()` yields a `LunoraRouteHandler`, mountable on `httpRouter`.
    const pingRoute = httpRoute.get("/api/ping").handler(() => {
        return { ok: true };
    });

    type Check12 = Assert<Equal<typeof pingRoute, LunoraRouteHandler>>;

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

    type Check13 = Assert<Equal<typeof routeOutputMismatch, LunoraRouteHandler>>;

    const ranQuery = actionCtx.runQuery(list, { limit: 3 });
    const ranMutation = actionCtx.runMutation(send, { text: "hi" });

    type Check14 = Assert<Equal<Awaited<typeof ranQuery>, number>>;
    type Check15 = Assert<Equal<Awaited<typeof ranMutation>, string>>;

    // A wrong arg type is a compile error now that args are inferred from the
    // reference's validator (the result type still flows, hence Check16).
    // @ts-expect-error - limit must be a number, per the query's args validator
    const ranBadArgs = actionCtx.runQuery(list, { limit: "nope" });

    type Check16 = Assert<Equal<Awaited<typeof ranBadArgs>, number>>;

    // `_generated/api.ts` types every entry as a
    // `FunctionReference` — the CLIENT-side handle — but `ctx.run*` only
    // accepted `RegisteredQuery`, the server-side registration object. So the
    // documented example (`ctx.runQuery(api.todos.list, args)`, from this
    // package's own JSDoc) did not typecheck, and there was no user-side fix
    // short of a cast at every call site.
    //
    // `apiList` stands in for what codegen emits: the phantom carries the args
    // and return types, and `__lunoraRef` is the runtime `<file>:<fn>` id.
    const apiList = { __lunoraRef: "todos:list" } as FunctionReferenceLike<"query", { limit: number }, number>;
    const apiSend = { __lunoraRef: "todos:send" } as FunctionReferenceLike<"mutation", { text: string }, string>;

    const ranQueryByReference = actionCtx.runQuery(apiList, { limit: 3 });
    const ranMutationByReference = actionCtx.runMutation(apiSend, { text: "hi" });

    type Check19 = Assert<Equal<Awaited<typeof ranQueryByReference>, number>>;
    type Check20 = Assert<Equal<Awaited<typeof ranMutationByReference>, string>>;

    // Args stay checked through the reference form too — widening the parameter
    // must not cost the inference that made the registration form useful.
    // @ts-expect-error - limit must be a number, per the reference's phantom args
    const ranReferenceBadArgs = actionCtx.runQuery(apiList, { limit: "nope" });

    // The `@ts-expect-error` above IS the assertion; this only keeps the binding
    // referenced. Overload resolution fails on the bad args, so the result type is
    // whatever the last overload widened to — not something worth pinning.
    type Check21 = Assert<typeof ranReferenceBadArgs extends Promise<unknown> ? true : false>;

    // `ctx.scheduler` takes the same generated reference every doc page and setup
    // skill passes it (`runAfter(ms, internal.billing.endTrial, args)`) — the
    // runtime always resolved it off `__lunoraRef`, only the type refused it,
    // pushing every caller to `as any`. The path-string form still works.
    const scheduledByReference = actionCtx.scheduler.runAfter(1000, apiSend, { text: "hi" });
    const scheduledByPath = actionCtx.scheduler.runAfter(1000, "todos:send", { text: "hi" });

    type Check22 = Assert<Equal<Awaited<typeof scheduledByReference>, string>>;
    type Check23 = Assert<Equal<Awaited<typeof scheduledByPath>, string>>;

    // A `query` is not schedulable — a deferred job exists to have an effect.
    // @ts-expect-error - `apiList` is a query reference
    const scheduledQuery = actionCtx.scheduler.runAt(Date.now(), apiList, { limit: 3 });

    type Check24 = Assert<Equal<Awaited<typeof scheduledQuery>, string>>;

    // `ctx.db.system` — read-only system tables. The overloaded `query`/`get`
    // resolve the per-table doc type (`_scheduled_functions` → ScheduledFunctionDoc,
    // `_storage` → StorageMetadata), so these awaited results are exactly typed.
    const systemScheduled = queryCtx.db.system.query("_scheduled_functions").collect();
    const systemStorageGet = queryCtx.db.system.get("_storage", "logo.png");

    type Check17 = Assert<Equal<Awaited<typeof systemScheduled>, ScheduledFunctionDoc[]>>;
    type Check18 = Assert<Equal<Awaited<typeof systemStorageGet>, StorageMetadata | null>>;

    // A declared index name is accepted, and the chain keeps its index binding
    // so a second `.withIndex()` after `.filter()`/`.order()` is still checked.
    boundReader.withIndex("by_channel", (q) => q.eq("channelId", "c1"));
    boundReader
        .order("desc")
        .filter(() => true)
        .withIndex("by_created");
    boundReader.withSearchIndex("by_text", (q) => q.search("text", "hello"));

    // @ts-expect-error -- "by_TYPO" is not a declared index on this table
    boundReader.withIndex("by_TYPO");

    // @ts-expect-error -- "by_channel" is an index, not a SEARCH index
    boundReader.withSearchIndex("by_channel", (q) => q.search("text", "hello"));

    // @ts-expect-error -- the table declares no geo index, so the parameter is `never`
    boundReader.withGeoIndex("by_location", (q) => q);

    // @ts-expect-error -- a table with no indexes accepts no index name at all
    unindexedReader.withIndex("by_anything");

    // A BOUND reader must stay assignable to the unbound published type. This is
    // the compatibility direction the narrowing could silently have broken: a
    // helper factored as `(reader: TableReader<Doc>) => …` is the obvious way to
    // share query logic, and it is handed exactly what `ctx.db.query(t)` returns.
    // It holds only because the three `with*` members are METHOD signatures
    // (bivariant); as function properties, `strictFunctionTypes` would reject it.
    const acceptsUnbound = (_reader: TableReader<{ channelId: string; text: string }>): void => {};
    const acceptsUnboundTextRow = (_reader: TableReader<{ text: string }>): void => {};

    acceptsUnbound(boundReader);
    // Also holds for the `never` end of the range — a table declaring no indexes.
    acceptsUnboundTextRow(unindexedReader);

    // Reference every compile-time assertion so the unused-local lint can't strip
    // the checks; each `Check*` fails at its definition if the equality regresses.
    const assertions = null as unknown as [
        Check1,
        Check2,
        Check3,
        Check4,
        Check5,
        Check6,
        Check7,
        Check8,
        Check9,
        Check10,
        Check11,
        Check11b,
        Check12,
        Check13,
        Check14,
        Check15,
        Check16,
        Check17,
        Check18,
        Check19,
        Check20,
        Check21,
        Check22,
        Check23,
        Check24,
    ];

    // eslint-disable-next-line no-void, sonarjs/void-use -- marks the type-assertion tuple as used so its `@ts-expect-error`/`Equal<>` checks are evaluated
    void assertions;
};

export default check;
