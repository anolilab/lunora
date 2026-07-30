import type { Validator } from "@lunora/values";

import { validateArgs } from "../functions";
import type { RlsTag } from "../rls/policy-tag";
import { readRlsTag } from "../rls/policy-tag";
import type {
    ActionCtx as ActionContext,
    ArgsValidator,
    ExposeConfig,
    FunctionKind,
    InferArgs,
    MutationCtx as MutationContext,
    QueryCtx as QueryContext,
    X402ProcedureConfig,
} from "../types";
import runMiddlewareChain from "./run-middleware";
import type {
    ActionBuilder,
    CreateOptions,
    DataModelInit,
    EmptyArgs,
    InternalActionBuilder,
    InternalMutationBuilder,
    InternalQueryBuilder,
    LunoraBuilders,
    Middleware,
    MutationBuilder,
    QueryBuilder,
} from "./types";

/** Accumulated builder state threaded through `.input()` / `.use()` / `.output()`. */
interface BuilderState {
    args: ArgsValidator;
    /** Public-surface tag set by `.expose({ rest: true })`; stamped onto the registered function as `fn.expose`. */
    expose?: ExposeConfig;
    /** Accumulated `.meta(...)` payload; merged across calls and stamped onto the registered function as `fn.meta`. */
    meta?: Record<string, unknown>;
    middlewares: ReadonlyArray<Middleware<unknown, unknown>>;
    /** Validator the handler's result is parsed through when `.output()` was called. */
    output?: Validator;
    /** Payment tag set by `.x402({ price })`; stamped onto the registered function as `fn.x402`. */
    x402?: X402ProcedureConfig;
}

/**
 * Seed `ctx.meta` with the procedure's declared `.meta(...)` payload so
 * middleware can read the policy it is supposed to enforce
 * (`ctx.meta.rateLimit`, …) instead of having it hard-wired at each `.use()`
 * site — see the `meta` builder member (LUNORA_ISSUES #6).
 *
 * A procedure without `.meta(...)` gets the context back untouched, so the
 * no-meta path is byte-identical.
 */
const withMeta = (context: unknown, meta: Record<string, unknown> | undefined): unknown => {
    if (meta === undefined || typeof context !== "object" || context === null) {
        return context;
    }

    return Object.assign(Object.create(Object.getPrototypeOf(context) as object | null) as object, context, { meta });
};

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
        meta?: Record<string, unknown>,
    ) =>
    async (context: unknown, rawArgs: InferArgs<Args>): Promise<Awaited<R>> => {
        const parsed = validateArgs(args, rawArgs as Record<string, unknown>);
        const resolvedContext = await runMiddleware(middlewares, withMeta(context, meta));
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
 * Hoist the read/write policies + roles carried by the chain's `.use(rls(...))`
 * steps onto the registered function as `fn.rls`. The local-first shape path
 * reads this to AND-compose a `defineShape` predicate with the table's RLS read
 * base-where — a shape runs no procedure, so without this surface its membership
 * reads would bypass the table's read policies (see `rls/shape-read-base.ts`).
 * Returns `undefined` when no `rls()` middleware is present, so a non-RLS
 * function carries no `rls` key.
 *
 * Each `rls()` step is preserved as its own `{ policies, roles }` tag rather than
 * flattened into shared arrays: a policy's `auth.can(...)` must resolve against
 * the role→permission map of the SAME middleware that declared it (exactly as the
 * request-time `rls()` path does). Flattening would let a permission registered on
 * one middleware satisfy another middleware's policy, replicating rows an
 * equivalent guarded query would deny.
 */
const collectRls = (middlewares: ReadonlyArray<Middleware<unknown, unknown>>): undefined | { tags: ReadonlyArray<RlsTag> } => {
    const tags: RlsTag[] = [];

    for (const middleware of middlewares) {
        const tag = readRlsTag(middleware);

        if (!tag) {
            continue;
        }

        tags.push(tag);
    }

    return tags.length > 0 ? { tags } : undefined;
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
 * Internal builders carry an extra `__lunoraVisibility: "internal"` brand and
 * stamp `visibility: "internal"` onto the registered function. Public builders
 * declare neither, so codegen distinguishes them by the brand's mere presence.
 */
const makeBuilder = (kind: FunctionKind, state: BuilderState, visibility?: "internal"): Record<string, unknown> => {
    return {
        __lunoraProcedure: kind,
        ...(visibility ? { __lunoraVisibility: visibility } : {}),
        input: (validators: ArgsValidator) => makeBuilder(kind, { ...state, args: { ...state.args, ...validators } }, visibility),
        [kind]: <R>(userHandler: (options: { args: Record<string, unknown>; ctx: unknown }) => Promise<R> | R) => {
            const rls = collectRls(state.middlewares);

            return {
                args: state.args,
                ...(state.expose ? { expose: state.expose } : {}),
                handler: makeHandler(state.args, state.middlewares, userHandler, state.output, state.meta),
                kind,
                ...(state.meta ? { meta: state.meta } : {}),
                ...(rls ? { rls } : {}),
                ...(visibility ? { visibility } : {}),
                ...(state.x402 ? { x402: state.x402 } : {}),
            };
        },
        // `.meta(obj)` MERGES so a shared base builder can set defaults a
        // specific procedure then extends, mirroring tRPC.
        meta: (value: Record<string, unknown>) => makeBuilder(kind, { ...state, meta: { ...state.meta, ...value } }, visibility),
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
                      const rls = collectRls(state.middlewares);

                      return {
                          args: state.args,
                          ...(state.expose ? { expose: state.expose } : {}),
                          handler: makeStreamHandler(state.args, state.middlewares, userHandler),
                          kind: "stream" as const,
                          ...(rls ? { rls } : {}),
                          ...(visibility ? { visibility } : {}),
                          ...(state.x402 ? { x402: state.x402 } : {}),
                      };
                  },
              }
            : {}),
        use: (middleware: Middleware<unknown, unknown>) => makeBuilder(kind, { ...state, middlewares: [...state.middlewares, middleware] }, visibility),
        // `.expose({ rest: true })` publishes a PUBLIC procedure on the REST surface
        // (plan 167). Public-only for the same reason as `.x402`: an internal
        // function is server-to-server and never reachable over HTTP, so there is
        // nothing to expose. Default-closed — omitting the modifier keeps the
        // procedure RPC-only.
        ...(visibility ? {} : { expose: (config: ExposeConfig) => makeBuilder(kind, { ...state, expose: config }, visibility) }),
        // `.x402({ price })` marks a public procedure as paid. It's public-only:
        // internal functions are server-to-server (cron/scheduler/`ctx.run*`) and
        // never reachable via a client RPC, so there's nothing to charge. Omitting
        // it on internal builders keeps the runtime shape aligned with the types.
        ...(visibility ? {} : { x402: (config: X402ProcedureConfig) => makeBuilder(kind, { ...state, x402: config }, visibility) }),
    };
};

/**
 * Entry point for the procedure builder. `dataModel&lt;DM>()` binds the generated
 * `DataModel` (phantom for now), and `.create()` yields the public root builders
 * plus their `internal*` counterparts.
 */
const initLunora = {
    dataModel: <DataModel>(): DataModelInit<DataModel> => {
        return {
            create: (_options?: CreateOptions): LunoraBuilders => {
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

export { initLunora };

export type {
    ActionBuilder,
    CreateOptions,
    DataModelInit,
    EmptyArgs,
    InternalActionBuilder,
    InternalMutationBuilder,
    InternalQueryBuilder,
    LunoraBuilders,
    Middleware,
    MiddlewareNext,
    MutationBuilder,
    QueryBuilder,
    TerminalKind,
} from "./types";
