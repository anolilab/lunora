import type { Infer, Validator } from "@lunora/values";

import type {
    ActionCtx as ActionContext,
    ArgsValidator,
    ExposeConfig,
    FunctionKind,
    InferArgs,
    MutationCtx as MutationContext,
    QueryCtx as QueryContext,
    RegisteredAction,
    RegisteredMutation,
    RegisteredQuery,
    RegisteredStream,
    X402ProcedureConfig,
} from "../types";

/** Builder discriminator. Codegen reads this kind. */
export type TerminalKind = FunctionKind;

/** Initial (empty) accumulated args for a fresh builder. */
export type EmptyArgs = Record<never, never>;

/**
 * `next()` advances the middleware chain. Called with no argument it forwards
 * the current context unchanged; called with `{ ctx }` it shallow-merges the
 * extension, and the result type reflects the widened context.
 */
export interface MiddlewareNext<ContextIn> {
    (): Promise<ContextIn>;
    <Extension extends Record<string, unknown>>(options: { ctx: Extension }): Promise<ContextIn & Extension>;
}

/**
 * A middleware receives the current context and a `next` continuation. Its
 * return type becomes the builder's new context, so `return next({ ctx })`
 * propagates the extension into every downstream `.use()` and the handler.
 */
export type Middleware<ContextIn, ContextOut> = (options: { ctx: ContextIn; next: MiddlewareNext<ContextIn> }) => ContextOut | Promise<ContextOut>;

/** Options accepted by `initLunora.dataModel<DM>().create(...)`. Reserved for transformer/error-formatter wiring. */
export type CreateOptions = Record<never, never>;

/**
 * `Output` carries the type declared by `.output(validator)`. It defaults to
 * the `undefined` sentinel meaning "not declared": in that state the terminal
 * stays generic over the handler's own return type. Once `.output()` sets it to
 * a concrete type, the terminal requires the handler to return that type and
 * the registration is typed to it (the runtime parses the result through the
 * validator). `[Output] extends [undefined]` is wrapped in a tuple so a union
 * `Output` doesn't distribute and so the test is for the exact sentinel.
 */
export interface QueryBuilder<Context, Args extends ArgsValidator, Output = undefined> {
    readonly __lunoraProcedure: "query";

    /**
     * Publish this query on the opt-in public REST surface (plan 167) — the
     * runtime mints `GET /_lunora/rest/<namespace>/<fn>` (and `POST`), dispatching
     * THROUGH the procedure so `ctx.auth` / RLS / validators are enforced, and the
     * generated OpenAPI describes it. Default-closed: omit to keep it RPC-only.
     */
    expose: (config: ExposeConfig) => QueryBuilder<Context, Args, Output>;
    input: <A extends ArgsValidator>(validators: A) => QueryBuilder<Context, A & Args, Output>;

    /**
     * Attach static, per-procedure metadata. Merges across calls, is readable
     * from middleware as `ctx.meta`, and is stamped onto the registration as
     * `fn.meta` so codegen and other tooling can enumerate it.
     *
     * The point is policy that is DATA rather than a call: `.meta({ rateLimit:
     * "pins/create" })` can be walked to generate a rate-limit registry or docs,
     * where the same policy expressed only as `.use(rateLimit("pins/create"))`
     * can only be executed. Mirrors tRPC's `.meta()`.
     */
    meta: (value: Record<string, unknown>) => QueryBuilder<Context, Args, Output>;
    output: <V extends Validator>(validator: V) => QueryBuilder<Context, Args, Infer<V>>;
    query: [Output] extends [undefined]
        ? <R>(handler: (options: { args: InferArgs<Args>; ctx: Context }) => Promise<R> | R) => RegisteredQuery<Args, Awaited<R>>
        : (handler: (options: { args: InferArgs<Args>; ctx: Context }) => Output | Promise<Output>) => RegisteredQuery<Args, Output>;

    /**
     * Terminal: declare this procedure as a streaming query. The handler is an
     * async generator (or any function returning an `AsyncIterable<R>`) that
     * yields one chunk per server-pushed frame. The third `signal` argument is
     * tripped when the client cancels — break out of the loop or check
     * `signal.aborted` between yields. `.output()` does not apply: per-chunk
     * validation is opt-in via the handler itself.
     */
    stream: <R>(
        handler: (options: { args: InferArgs<Args>; ctx: Context; signal: AbortSignal }) => AsyncGenerator<R, void, void> | AsyncIterable<R>,
    ) => RegisteredStream<Args, R>;
    use: <ContextOut>(middleware: Middleware<Context, ContextOut>) => QueryBuilder<ContextOut, Args, Output>;

    /**
     * Mark this query as paid. The origin worker answers an unpaid client RPC
     * with HTTP 402, verifies + settles the x402 payment, then dispatches. `price`
     * is USD (a number of dollars or a `"0.01"`/`"$0.01"` string); the network,
     * recipient, and facilitator come from the worker-level x402 charge config.
     */
    x402: (config: X402ProcedureConfig) => QueryBuilder<Context, Args, Output>;
}

export interface MutationBuilder<Context, Args extends ArgsValidator, Output = undefined> {
    readonly __lunoraProcedure: "mutation";

    /**
     * Publish this mutation on the opt-in public REST surface (plan 167) — the
     * runtime mints `POST /_lunora/rest/<namespace>/<fn>`, dispatching THROUGH the
     * procedure so `ctx.auth` / RLS / validators are enforced, and the generated
     * OpenAPI describes it. Default-closed: omit to keep it RPC-only.
     */
    expose: (config: ExposeConfig) => MutationBuilder<Context, Args, Output>;
    input: <A extends ArgsValidator>(validators: A) => MutationBuilder<Context, A & Args, Output>;

    /**
     * Attach static, per-procedure metadata. Merges across calls, is readable
     * from middleware as `ctx.meta`, and is stamped onto the registration as
     * `fn.meta` so codegen and other tooling can enumerate it.
     *
     * The point is policy that is DATA rather than a call: `.meta({ rateLimit:
     * "pins/create" })` can be walked to generate a rate-limit registry or docs,
     * where the same policy expressed only as `.use(rateLimit("pins/create"))`
     * can only be executed. Mirrors tRPC's `.meta()`.
     */
    meta: (value: Record<string, unknown>) => MutationBuilder<Context, Args, Output>;
    mutation: [Output] extends [undefined]
        ? <R>(handler: (options: { args: InferArgs<Args>; ctx: Context }) => Promise<R> | R) => RegisteredMutation<Args, Awaited<R>>
        : (handler: (options: { args: InferArgs<Args>; ctx: Context }) => Output | Promise<Output>) => RegisteredMutation<Args, Output>;
    output: <V extends Validator>(validator: V) => MutationBuilder<Context, Args, Infer<V>>;
    use: <ContextOut>(middleware: Middleware<Context, ContextOut>) => MutationBuilder<ContextOut, Args, Output>;

    /**
     * Mark this mutation as paid. The origin worker answers an unpaid client RPC
     * with HTTP 402, verifies + settles the x402 payment, then dispatches. `price`
     * is USD (a number of dollars or a `"0.01"`/`"$0.01"` string); the network,
     * recipient, and facilitator come from the worker-level x402 charge config.
     */
    x402: (config: X402ProcedureConfig) => MutationBuilder<Context, Args, Output>;
}

export interface ActionBuilder<Context, Args extends ArgsValidator, Output = undefined> {
    readonly __lunoraProcedure: "action";
    action: [Output] extends [undefined]
        ? <R>(handler: (options: { args: InferArgs<Args>; ctx: Context }) => Promise<R> | R) => RegisteredAction<Args, Awaited<R>>
        : (handler: (options: { args: InferArgs<Args>; ctx: Context }) => Output | Promise<Output>) => RegisteredAction<Args, Output>;

    /**
     * Publish this action on the opt-in public REST surface (plan 167) — the
     * runtime mints `POST /_lunora/rest/<namespace>/<fn>`, dispatching THROUGH the
     * procedure so `ctx.auth` / RLS / validators are enforced, and the generated
     * OpenAPI describes it. Default-closed: omit to keep it RPC-only.
     */
    expose: (config: ExposeConfig) => ActionBuilder<Context, Args, Output>;
    input: <A extends ArgsValidator>(validators: A) => ActionBuilder<Context, A & Args, Output>;

    /**
     * Attach static, per-procedure metadata. Merges across calls, is readable
     * from middleware as `ctx.meta`, and is stamped onto the registration as
     * `fn.meta` so codegen and other tooling can enumerate it.
     *
     * The point is policy that is DATA rather than a call: `.meta({ rateLimit:
     * "pins/create" })` can be walked to generate a rate-limit registry or docs,
     * where the same policy expressed only as `.use(rateLimit("pins/create"))`
     * can only be executed. Mirrors tRPC's `.meta()`.
     */
    meta: (value: Record<string, unknown>) => ActionBuilder<Context, Args, Output>;
    output: <V extends Validator>(validator: V) => ActionBuilder<Context, Args, Infer<V>>;
    use: <ContextOut>(middleware: Middleware<Context, ContextOut>) => ActionBuilder<ContextOut, Args, Output>;

    /**
     * Mark this action as paid. The origin worker answers an unpaid client RPC
     * with HTTP 402, verifies + settles the x402 payment, then dispatches. `price`
     * is USD (a number of dollars or a `"0.01"`/`"$0.01"` string); the network,
     * recipient, and facilitator come from the worker-level x402 charge config.
     */
    x402: (config: X402ProcedureConfig) => ActionBuilder<Context, Args, Output>;
}

/**
 * Internal builder variants. Identical to their public counterparts but carry
 * the `__lunoraVisibility: "internal"` brand codegen keys off to route the
 * registration into the `internal` object (and keep it off `api`). `input`/`use`
 * return the internal builder type so the brand survives the whole chain.
 */
export interface InternalQueryBuilder<Context, Args extends ArgsValidator, Output = undefined> {
    readonly __lunoraProcedure: "query";
    readonly __lunoraVisibility: "internal";
    input: <A extends ArgsValidator>(validators: A) => InternalQueryBuilder<Context, A & Args, Output>;

    /**
     * Attach static, per-procedure metadata. Merges across calls, is readable
     * from middleware as `ctx.meta`, and is stamped onto the registration as
     * `fn.meta` so codegen and other tooling can enumerate it.
     *
     * The point is policy that is DATA rather than a call: `.meta({ rateLimit:
     * "pins/create" })` can be walked to generate a rate-limit registry or docs,
     * where the same policy expressed only as `.use(rateLimit("pins/create"))`
     * can only be executed. Mirrors tRPC's `.meta()`.
     */
    meta: (value: Record<string, unknown>) => InternalQueryBuilder<Context, Args, Output>;
    output: <V extends Validator>(validator: V) => InternalQueryBuilder<Context, Args, Infer<V>>;
    query: [Output] extends [undefined]
        ? <R>(handler: (options: { args: InferArgs<Args>; ctx: Context }) => Promise<R> | R) => RegisteredQuery<Args, Awaited<R>>
        : (handler: (options: { args: InferArgs<Args>; ctx: Context }) => Output | Promise<Output>) => RegisteredQuery<Args, Output>;
    /** See {@link QueryBuilder.stream}; the internal variant routes the registration into `internal` instead of `api`. */
    stream: <R>(
        handler: (options: { args: InferArgs<Args>; ctx: Context; signal: AbortSignal }) => AsyncGenerator<R, void, void> | AsyncIterable<R>,
    ) => RegisteredStream<Args, R>;
    use: <ContextOut>(middleware: Middleware<Context, ContextOut>) => InternalQueryBuilder<ContextOut, Args, Output>;
}

export interface InternalMutationBuilder<Context, Args extends ArgsValidator, Output = undefined> {
    readonly __lunoraProcedure: "mutation";
    readonly __lunoraVisibility: "internal";
    input: <A extends ArgsValidator>(validators: A) => InternalMutationBuilder<Context, A & Args, Output>;

    /**
     * Attach static, per-procedure metadata. Merges across calls, is readable
     * from middleware as `ctx.meta`, and is stamped onto the registration as
     * `fn.meta` so codegen and other tooling can enumerate it.
     *
     * The point is policy that is DATA rather than a call: `.meta({ rateLimit:
     * "pins/create" })` can be walked to generate a rate-limit registry or docs,
     * where the same policy expressed only as `.use(rateLimit("pins/create"))`
     * can only be executed. Mirrors tRPC's `.meta()`.
     */
    meta: (value: Record<string, unknown>) => InternalMutationBuilder<Context, Args, Output>;
    mutation: [Output] extends [undefined]
        ? <R>(handler: (options: { args: InferArgs<Args>; ctx: Context }) => Promise<R> | R) => RegisteredMutation<Args, Awaited<R>>
        : (handler: (options: { args: InferArgs<Args>; ctx: Context }) => Output | Promise<Output>) => RegisteredMutation<Args, Output>;
    output: <V extends Validator>(validator: V) => InternalMutationBuilder<Context, Args, Infer<V>>;
    use: <ContextOut>(middleware: Middleware<Context, ContextOut>) => InternalMutationBuilder<ContextOut, Args, Output>;
}

export interface InternalActionBuilder<Context, Args extends ArgsValidator, Output = undefined> {
    readonly __lunoraProcedure: "action";
    readonly __lunoraVisibility: "internal";
    action: [Output] extends [undefined]
        ? <R>(handler: (options: { args: InferArgs<Args>; ctx: Context }) => Promise<R> | R) => RegisteredAction<Args, Awaited<R>>
        : (handler: (options: { args: InferArgs<Args>; ctx: Context }) => Output | Promise<Output>) => RegisteredAction<Args, Output>;
    input: <A extends ArgsValidator>(validators: A) => InternalActionBuilder<Context, A & Args, Output>;

    /**
     * Attach static, per-procedure metadata. Merges across calls, is readable
     * from middleware as `ctx.meta`, and is stamped onto the registration as
     * `fn.meta` so codegen and other tooling can enumerate it.
     *
     * The point is policy that is DATA rather than a call: `.meta({ rateLimit:
     * "pins/create" })` can be walked to generate a rate-limit registry or docs,
     * where the same policy expressed only as `.use(rateLimit("pins/create"))`
     * can only be executed. Mirrors tRPC's `.meta()`.
     */
    meta: (value: Record<string, unknown>) => InternalActionBuilder<Context, Args, Output>;
    output: <V extends Validator>(validator: V) => InternalActionBuilder<Context, Args, Infer<V>>;
    use: <ContextOut>(middleware: Middleware<Context, ContextOut>) => InternalActionBuilder<ContextOut, Args, Output>;
}

/** The public root builders plus their `internal*` counterparts, returned by `.create()`. */
export interface LunoraBuilders {
    action: ActionBuilder<ActionContext, EmptyArgs>;
    internalAction: InternalActionBuilder<ActionContext, EmptyArgs>;
    internalMutation: InternalMutationBuilder<MutationContext, EmptyArgs>;
    internalQuery: InternalQueryBuilder<QueryContext, EmptyArgs>;
    mutation: MutationBuilder<MutationContext, EmptyArgs>;
    query: QueryBuilder<QueryContext, EmptyArgs>;
}

export interface DataModelInit<DataModel> {
    /** Phantom carrier for the generated `DataModel`; reserved for typed `ctx.db` (Plan2 1.2.7). */
    readonly __dataModel?: DataModel;
    create: (options?: CreateOptions) => LunoraBuilders;
}
