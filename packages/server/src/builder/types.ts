import type {
    ActionCtx,
    ArgsValidator,
    FunctionKind,
    InferArgs,
    MutationCtx,
    QueryCtx,
    RegisteredAction,
    RegisteredMutation,
    RegisteredQuery,
} from "../types.js";

/** Builder discriminator. Codegen reads this kind. */
export type TerminalKind = FunctionKind;

/** Initial (empty) accumulated args for a fresh builder. */
export type EmptyArgs = Record<never, never>;

/**
 * `next()` advances the middleware chain. Called with no argument it forwards
 * the current context unchanged; called with `{ ctx }` it shallow-merges the
 * extension, and the result type reflects the widened context.
 */
export interface MiddlewareNext<CtxIn> {
    (): Promise<CtxIn>;
    <Extension extends Record<string, unknown>>(options: { ctx: Extension }): Promise<CtxIn & Extension>;
}

/**
 * A middleware receives the current context and a `next` continuation. Its
 * return type becomes the builder's new context, so `return next({ ctx })`
 * propagates the extension into every downstream `.use()` and the handler.
 */
export type Middleware<CtxIn, CtxOut> = (options: { ctx: CtxIn; next: MiddlewareNext<CtxIn> }) => CtxOut | Promise<CtxOut>;

/** Options accepted by `initCirrus.dataModel<DM>().create(...)`. Reserved for transformer/error-formatter wiring. */
export type CreateOptions = Record<never, never>;

export interface QueryBuilder<Ctx, Args extends ArgsValidator> {
    readonly __cirrusProcedure: "query";
    input: <A extends ArgsValidator>(validators: A) => QueryBuilder<Ctx, A & Args>;
    query: <R>(handler: (options: { args: InferArgs<Args>; ctx: Ctx }) => Promise<R> | R) => RegisteredQuery<Args, Awaited<R>>;
    use: <CtxOut>(middleware: Middleware<Ctx, CtxOut>) => QueryBuilder<CtxOut, Args>;
}

export interface MutationBuilder<Ctx, Args extends ArgsValidator> {
    readonly __cirrusProcedure: "mutation";
    input: <A extends ArgsValidator>(validators: A) => MutationBuilder<Ctx, A & Args>;
    mutation: <R>(handler: (options: { args: InferArgs<Args>; ctx: Ctx }) => Promise<R> | R) => RegisteredMutation<Args, Awaited<R>>;
    use: <CtxOut>(middleware: Middleware<Ctx, CtxOut>) => MutationBuilder<CtxOut, Args>;
}

export interface ActionBuilder<Ctx, Args extends ArgsValidator> {
    readonly __cirrusProcedure: "action";
    action: <R>(handler: (options: { args: InferArgs<Args>; ctx: Ctx }) => Promise<R> | R) => RegisteredAction<Args, Awaited<R>>;
    input: <A extends ArgsValidator>(validators: A) => ActionBuilder<Ctx, A & Args>;
    use: <CtxOut>(middleware: Middleware<Ctx, CtxOut>) => ActionBuilder<CtxOut, Args>;
}

/**
 * Internal builder variants. Identical to their public counterparts but carry
 * the `__cirrusVisibility: "internal"` brand codegen keys off to route the
 * registration into the `internal` object (and keep it off `api`). `input`/`use`
 * return the internal builder type so the brand survives the whole chain.
 */
export interface InternalQueryBuilder<Ctx, Args extends ArgsValidator> {
    readonly __cirrusProcedure: "query";
    readonly __cirrusVisibility: "internal";
    input: <A extends ArgsValidator>(validators: A) => InternalQueryBuilder<Ctx, A & Args>;
    query: <R>(handler: (options: { args: InferArgs<Args>; ctx: Ctx }) => Promise<R> | R) => RegisteredQuery<Args, Awaited<R>>;
    use: <CtxOut>(middleware: Middleware<Ctx, CtxOut>) => InternalQueryBuilder<CtxOut, Args>;
}

export interface InternalMutationBuilder<Ctx, Args extends ArgsValidator> {
    readonly __cirrusProcedure: "mutation";
    readonly __cirrusVisibility: "internal";
    input: <A extends ArgsValidator>(validators: A) => InternalMutationBuilder<Ctx, A & Args>;
    mutation: <R>(handler: (options: { args: InferArgs<Args>; ctx: Ctx }) => Promise<R> | R) => RegisteredMutation<Args, Awaited<R>>;
    use: <CtxOut>(middleware: Middleware<Ctx, CtxOut>) => InternalMutationBuilder<CtxOut, Args>;
}

export interface InternalActionBuilder<Ctx, Args extends ArgsValidator> {
    readonly __cirrusProcedure: "action";
    readonly __cirrusVisibility: "internal";
    action: <R>(handler: (options: { args: InferArgs<Args>; ctx: Ctx }) => Promise<R> | R) => RegisteredAction<Args, Awaited<R>>;
    input: <A extends ArgsValidator>(validators: A) => InternalActionBuilder<Ctx, A & Args>;
    use: <CtxOut>(middleware: Middleware<Ctx, CtxOut>) => InternalActionBuilder<CtxOut, Args>;
}

/** The public root builders plus their `internal*` counterparts, returned by `.create()`. */
export interface CirrusBuilders {
    action: ActionBuilder<ActionCtx, EmptyArgs>;
    internalAction: InternalActionBuilder<ActionCtx, EmptyArgs>;
    internalMutation: InternalMutationBuilder<MutationCtx, EmptyArgs>;
    internalQuery: InternalQueryBuilder<QueryCtx, EmptyArgs>;
    mutation: MutationBuilder<MutationCtx, EmptyArgs>;
    query: QueryBuilder<QueryCtx, EmptyArgs>;
}

export interface DataModelInit<DataModel> {
    /** Phantom carrier for the generated `DataModel`; reserved for typed `ctx.db` (Plan2 1.2.7). */
    readonly __dataModel?: DataModel;
    create: (options?: CreateOptions) => CirrusBuilders;
}
