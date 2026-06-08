import type { Validator } from "@cirrus/values";

import { validateArgs } from "../functions.js";
import type { ActionCtx as ActionContext, ArgsValidator, FunctionKind, InferArgs, MutationCtx as MutationContext, QueryCtx as QueryContext } from "../types.js";
import runMiddlewareChain from "./run-middleware.js";
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
    MutationBuilder,
    QueryBuilder,
} from "./types.js";

/** Accumulated builder state threaded through `.input()` / `.use()` / `.output()`. */
interface BuilderState {
    args: ArgsValidator;
    middlewares: ReadonlyArray<Middleware<unknown, unknown>>;
    /** Validator the handler's result is parsed through when `.output()` was called. */
    output?: Validator;
}

/**
 * Run the builder's middleware chain and return the fully resolved context. The
 * onion executor itself lives in {@link runMiddlewareChain} (shared with the
 * plugin-middleware composer so both honour the same double-`next()` guard); the
 * builder's terminal simply returns the accumulated context unchanged.
 */
const runMiddleware = (middlewares: ReadonlyArray<Middleware<unknown, unknown>>, baseContext: unknown): Promise<unknown> =>
    runMiddlewareChain(middlewares, baseContext, (context) => context);

/**
 * Adapt a user handler (`{ args, ctx }`) to the registered dispatch contract
 * (`(context, args)`). Args are revalidated here so a builder-produced function
 * is interchangeable with one from `query()` / `mutation()` / `action()`. When
 * `.output()` declared a validator, the handler's result is parsed through it
 * so a contract violation surfaces as a `ValidationError` at the source rather
 * than as malformed data downstream.
 */
const makeHandler =
    <Args extends ArgsValidator, R>(
        args: Args,
        middlewares: ReadonlyArray<Middleware<unknown, unknown>>,
        userHandler: (options: { args: InferArgs<Args>; ctx: unknown }) => Promise<R> | R,
        output?: Validator,
    ) =>
    async (context: unknown, rawArgs: InferArgs<Args>): Promise<Awaited<R>> => {
        const parsed = validateArgs(args, rawArgs as Record<string, unknown>);
        const resolvedContext = await runMiddleware(middlewares, context);
        const result = await userHandler({ args: parsed, ctx: resolvedContext });

        return (output ? output.parse(result) : result) as Awaited<R>;
    };

/**
 * Wrap a streaming user handler in the same arg-validation + middleware shell
 * as `makeHandler`, but return the user's `AsyncIterable&lt;R>` directly so the
 * runtime can drive it frame-by-frame. The handler receives an `AbortSignal`
 * the caller flips when they unsubscribe; it's the user's responsibility to
 * honour it (or to wire it into any awaited I/O).
 */
const makeStreamHandler =
    <Args extends ArgsValidator, R>(
        args: Args,
        middlewares: ReadonlyArray<Middleware<unknown, unknown>>,
        userHandler: (options: { args: InferArgs<Args>; ctx: unknown; signal: AbortSignal }) => AsyncGenerator<R, void, void> | AsyncIterable<R>,
    ) =>
    (context: unknown, rawArgs: InferArgs<Args>, signal: AbortSignal): AsyncIterable<R> => {
        // Args validation runs synchronously at call time so a bad envelope
        // surfaces before the iterator is consumed.
        const parsed = validateArgs(args, rawArgs as Record<string, unknown>);

        // The middleware chain may be async, but we don't want to block the
        // caller before returning an iterable — defer the chain to the first
        // `next()` pump by wrapping the iterator with an outer async generator.
        return (async function* drive(): AsyncGenerator<R, void, void> {
            const resolvedContext = await runMiddleware(middlewares, context);
            const source = userHandler({ args: parsed, ctx: resolvedContext, signal });
            // Drive the source through an explicit iterator so the abort check
            // can gate each `.next()` *before* the producer is resumed — a
            // `for await` would pull (and thus resume the producer for one more
            // step) before we ever observe the cancel, letting user side effects
            // run after the client has gone away.
            const iterator = source[Symbol.asyncIterator]();

            try {
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite pump loop; exits via the abort/`done` returns below
                while (true) {
                    if (signal.aborted) {
                        return;
                    }

                    // eslint-disable-next-line no-await-in-loop -- sequential by nature: each chunk must be produced and forwarded before the next is pulled
                    const next = await iterator.next();

                    if (next.done) {
                        return;
                    }

                    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `iterator.next()` above may have flipped `aborted`; TS can't model the side effect so it sees this as always-false
                    if (signal.aborted) {
                        return;
                    }

                    yield next.value;
                }
            } finally {
                // Close the producer so its `finally`/cleanup runs when we bail
                // early (abort) or the consumer stops iterating.
                await iterator.return?.();
            }
        })();
    };

/**
 * Construct a kind-specific builder. The terminal method is keyed by the kind
 * (`query` / `mutation` / `action`) so codegen reads the kind from the call
 * expression's property name without tracing the builder across files.
 * `QueryBuilder` (and `InternalQueryBuilder`) also expose a `.stream()` terminal
 * that produces a `RegisteredStream` — codegen reads `"stream"` from the
 * terminal name and the runtime routes the registration through the WS stream
 * dispatcher instead of the request/response one.
 *
 * Internal builders carry an extra `__cirrusVisibility: "internal"` brand and
 * stamp `visibility: "internal"` onto the registered function. Public builders
 * declare neither, so codegen distinguishes them by the brand's mere presence.
 */
const makeBuilder = (kind: FunctionKind, state: BuilderState, visibility?: "internal"): Record<string, unknown> => {
    return {
        __cirrusProcedure: kind,
        ...(visibility ? { __cirrusVisibility: visibility } : {}),
        input: (validators: ArgsValidator) => makeBuilder(kind, { ...state, args: { ...state.args, ...validators } }, visibility),
        [kind]: <R>(userHandler: (options: { args: Record<string, unknown>; ctx: unknown }) => Promise<R> | R) => {
            return {
                args: state.args,
                handler: makeHandler(state.args, state.middlewares, userHandler, state.output),
                kind,
                ...(visibility ? { visibility } : {}),
            };
        },
        output: (validator: Validator) => makeBuilder(kind, { ...state, output: validator }, visibility),
        // `.stream()` is meaningful only on query builders. It's harmless to expose
        // on every builder shape (callers can't hit it from action/mutation builders
        // anyway since the type system narrows it away), but emitting it
        // unconditionally keeps the runtime free of per-kind branching.
        ...(kind === "query"
            ? {
                  stream: <R>(
                      userHandler: (options: {
                          args: Record<string, unknown>;
                          ctx: unknown;
                          signal: AbortSignal;
                      }) => AsyncGenerator<R, void, void> | AsyncIterable<R>,
                  ) => {
                      return {
                          args: state.args,
                          handler: makeStreamHandler(state.args, state.middlewares, userHandler),
                          kind: "stream" as const,
                          ...(visibility ? { visibility } : {}),
                      };
                  },
              }
            : {}),
        use: (middleware: Middleware<unknown, unknown>) => makeBuilder(kind, { ...state, middlewares: [...state.middlewares, middleware] }, visibility),
    };
};

/**
 * Entry point for the procedure builder. `dataModel&lt;DM>()` binds the generated
 * `DataModel` (phantom for now), and `.create()` yields the public root builders
 * plus their `internal*` counterparts.
 */
const initCirrus = {
    dataModel: <DataModel>(): DataModelInit<DataModel> => {
        return {
            create: (_options?: CreateOptions): CirrusBuilders => {
                return {
                    action: makeBuilder("action", { args: {}, middlewares: [] }) as unknown as ActionBuilder<ActionContext, EmptyArgs>,
                    internalAction: makeBuilder("action", { args: {}, middlewares: [] }, "internal") as unknown as InternalActionBuilder<
                        ActionContext,
                        EmptyArgs
                    >,
                    internalMutation: makeBuilder("mutation", { args: {}, middlewares: [] }, "internal") as unknown as InternalMutationBuilder<
                        MutationContext,
                        EmptyArgs
                    >,
                    internalQuery: makeBuilder("query", { args: {}, middlewares: [] }, "internal") as unknown as InternalQueryBuilder<QueryContext, EmptyArgs>,
                    mutation: makeBuilder("mutation", { args: {}, middlewares: [] }) as unknown as MutationBuilder<MutationContext, EmptyArgs>,
                    query: makeBuilder("query", { args: {}, middlewares: [] }) as unknown as QueryBuilder<QueryContext, EmptyArgs>,
                };
            },
        };
    },
};

export { initCirrus };

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
