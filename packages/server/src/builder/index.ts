import type { Validator } from "@cirrus/values";

import { validateArgs } from "../functions.js";
import type { ActionCtx, ArgsValidator, FunctionKind, InferArgs, MutationCtx, QueryCtx } from "../types.js";
import type {
    ActionBuilder,
    CirrusBuilders,
    CreateOptions,
    DataModelInit,
    EmptyArgs,
    InternalActionBuilder,
    InternalMutationBuilder,
    InternalQueryBuilder,
    Middleware,
    MiddlewareNext,
    MutationBuilder,
    QueryBuilder,
} from "./types.js";

export type {
    ActionBuilder,
    CirrusBuilders,
    CreateOptions,
    DataModelInit,
    EmptyArgs,
    InternalActionBuilder,
    InternalMutationBuilder,
    InternalQueryBuilder,
    Middleware,
    MiddlewareNext,
    MutationBuilder,
    QueryBuilder,
    TerminalKind,
} from "./types.js";

/** Accumulated builder state threaded through `.input()` / `.use()` / `.output()`. */
interface BuilderState {
    args: ArgsValidator;
    middlewares: ReadonlyArray<Middleware<unknown, unknown>>;
    /** Validator the handler's result is parsed through when `.output()` was called. */
    output?: Validator;
}

/**
 * Onion executor for the middleware chain. Each middleware receives `next`,
 * which advances to the following link; calling it twice for the same link is
 * a programming error and throws. A `{ ctx }` argument shallow-merges into the
 * context handed to the rest of the chain.
 */
const runMiddleware = async (middlewares: ReadonlyArray<Middleware<unknown, unknown>>, baseCtx: unknown): Promise<unknown> => {
    let lastIndex = -1;

    const dispatch = async (index: number, ctx: unknown): Promise<unknown> => {
        if (index <= lastIndex) {
            throw new Error("middleware next() called multiple times");
        }

        lastIndex = index;

        const middleware = middlewares[index];

        if (!middleware) {
            return ctx;
        }

        const next = ((options?: { ctx: Record<string, unknown> }) =>
            dispatch(index + 1, options?.ctx ? { ...(ctx as Record<string, unknown>), ...options.ctx } : ctx)) as MiddlewareNext<unknown>;

        return middleware({ ctx, next });
    };

    return dispatch(0, baseCtx);
};

/**
 * Adapt a user handler (`{ args, ctx }`) to the registered dispatch contract
 * (`(context, args)`). Args are revalidated here so a builder-produced function
 * is interchangeable with one from `query()` / `mutation()` / `action()`. When
 * `.output()` declared a validator, the handler's result is parsed through it
 * so a contract violation surfaces as a `ValidationError` at the source rather
 * than as malformed data downstream.
 */
const makeHandler
    = <Args extends ArgsValidator, Ctx, R>(
        args: Args,
        middlewares: ReadonlyArray<Middleware<unknown, unknown>>,
        userHandler: (options: { args: InferArgs<Args>; ctx: Ctx }) => Promise<R> | R,
        output?: Validator,
    ) =>
        async (context: unknown, rawArgs: InferArgs<Args>): Promise<Awaited<R>> => {
            const parsed = validateArgs(args, rawArgs as Record<string, unknown>);
            const ctx = await runMiddleware(middlewares, context);
            const result = await userHandler({ args: parsed, ctx: ctx as Ctx });

            return (output ? output.parse(result) : result) as Awaited<R>;
        };

/**
 * Construct a kind-specific builder. The terminal method is keyed by the kind
 * (`query` / `mutation` / `action`) so codegen reads the kind from the call
 * expression's property name without tracing the builder across files.
 *
 * Internal builders carry an extra `__cirrusVisibility: "internal"` brand and
 * stamp `visibility: "internal"` onto the registered function. Public builders
 * declare neither, so codegen distinguishes them by the brand's mere presence.
 */
const makeBuilder = (kind: FunctionKind, state: BuilderState, visibility?: "internal"): Record<string, unknown> => ({
    __cirrusProcedure: kind,
    ...visibility ? { __cirrusVisibility: visibility } : {},
    [kind]: <R>(userHandler: (options: { args: Record<string, unknown>; ctx: unknown }) => Promise<R> | R) => ({
        args: state.args,
        handler: makeHandler(state.args, state.middlewares, userHandler, state.output),
        kind,
        ...visibility ? { visibility } : {},
    }),
    input: (validators: ArgsValidator) => makeBuilder(kind, { ...state, args: { ...state.args, ...validators } }, visibility),
    output: (validator: Validator) => makeBuilder(kind, { ...state, output: validator }, visibility),
    use: (middleware: Middleware<unknown, unknown>) => makeBuilder(kind, { ...state, middlewares: [...state.middlewares, middleware] }, visibility),
});

/**
 * Entry point for the procedure builder. `dataModel<DM>()` binds the generated
 * `DataModel` (phantom for now), and `.create()` yields the public root builders
 * plus their `internal*` counterparts.
 */
export const initCirrus = {
    dataModel: <DataModel>(): DataModelInit<DataModel> => ({
        create: (_options?: CreateOptions): CirrusBuilders => ({
            action: makeBuilder("action", { args: {}, middlewares: [] }) as unknown as ActionBuilder<ActionCtx, EmptyArgs>,
            internalAction: makeBuilder("action", { args: {}, middlewares: [] }, "internal") as unknown as InternalActionBuilder<ActionCtx, EmptyArgs>,
            internalMutation: makeBuilder("mutation", { args: {}, middlewares: [] }, "internal") as unknown as InternalMutationBuilder<MutationCtx, EmptyArgs>,
            internalQuery: makeBuilder("query", { args: {}, middlewares: [] }, "internal") as unknown as InternalQueryBuilder<QueryCtx, EmptyArgs>,
            mutation: makeBuilder("mutation", { args: {}, middlewares: [] }) as unknown as MutationBuilder<MutationCtx, EmptyArgs>,
            query: makeBuilder("query", { args: {}, middlewares: [] }) as unknown as QueryBuilder<QueryCtx, EmptyArgs>,
        }),
    }),
};
