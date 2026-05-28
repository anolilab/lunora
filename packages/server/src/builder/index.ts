import { validateArgs } from "../functions.js";
import type { ActionCtx, ArgsValidator, FunctionKind, InferArgs, MutationCtx, QueryCtx } from "../types.js";
import type {
    ActionBuilder,
    CirrusBuilders,
    CreateOptions,
    DataModelInit,
    EmptyArgs,
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
    Middleware,
    MiddlewareNext,
    MutationBuilder,
    QueryBuilder,
    TerminalKind,
} from "./types.js";

/** Accumulated builder state threaded through `.input()` / `.use()`. */
interface BuilderState {
    args: ArgsValidator;
    middlewares: ReadonlyArray<Middleware<unknown, unknown>>;
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
 * is interchangeable with one from `query()` / `mutation()` / `action()`.
 */
const makeHandler
    = <Args extends ArgsValidator, Ctx, R>(
        args: Args,
        middlewares: ReadonlyArray<Middleware<unknown, unknown>>,
        userHandler: (options: { args: InferArgs<Args>; ctx: Ctx }) => Promise<R> | R,
    ) =>
        async (context: unknown, rawArgs: InferArgs<Args>): Promise<Awaited<R>> => {
            const parsed = validateArgs(args, rawArgs as Record<string, unknown>);
            const ctx = await runMiddleware(middlewares, context);

            return (await userHandler({ args: parsed, ctx: ctx as Ctx })) as Awaited<R>;
        };

/**
 * Construct a kind-specific builder. The terminal method is keyed by the kind
 * (`query` / `mutation` / `action`) so codegen reads the kind from the call
 * expression's property name without tracing the builder across files.
 */
const makeBuilder = (kind: FunctionKind, state: BuilderState): Record<string, unknown> => ({
    __cirrusProcedure: kind,
    [kind]: <R>(userHandler: (options: { args: Record<string, unknown>; ctx: unknown }) => Promise<R> | R) => ({
        args: state.args,
        handler: makeHandler(state.args, state.middlewares, userHandler),
        kind,
    }),
    input: (validators: ArgsValidator) => makeBuilder(kind, { args: { ...state.args, ...validators }, middlewares: state.middlewares }),
    use: (middleware: Middleware<unknown, unknown>) => makeBuilder(kind, { args: state.args, middlewares: [...state.middlewares, middleware] }),
});

/**
 * Entry point for the procedure builder. `dataModel<DM>()` binds the generated
 * `DataModel` (phantom for now), and `.create()` yields the three root builders.
 */
export const initCirrus = {
    dataModel: <DataModel>(): DataModelInit<DataModel> => ({
        create: (_options?: CreateOptions): CirrusBuilders => ({
            action: makeBuilder("action", { args: {}, middlewares: [] }) as unknown as ActionBuilder<ActionCtx, EmptyArgs>,
            mutation: makeBuilder("mutation", { args: {}, middlewares: [] }) as unknown as MutationBuilder<MutationCtx, EmptyArgs>,
            query: makeBuilder("query", { args: {}, middlewares: [] }) as unknown as QueryBuilder<QueryCtx, EmptyArgs>,
        }),
    }),
};
