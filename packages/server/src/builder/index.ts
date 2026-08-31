import type { Validator } from "@lunora/values";

import applyOutput from "../apply-output";
import { validateArgs } from "../functions";
import { unionMaskColumns } from "../mask/policy-tag";
import type { RlsTag } from "../rls/policy-tag";
import { readRlsTags } from "../rls/policy-tag";
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
    /** Accumulated `.meta(...)` payload; merged across calls and surfaced to middleware as `ctx.meta`. */
    meta?: Record<string, unknown>;
    middlewares: ReadonlyArray<Middleware<unknown, unknown>>;
    /** Validator the handler's result is parsed through when `.output()` was called. */
    output?: Validator;
    /** Payment tag set by `.x402({ price })`; stamped onto the registered function as `fn.x402`. */
    x402?: X402ProcedureConfig;
}

/* eslint-disable jsdoc/check-indentation -- intentional bullet list naming each field the decorated context adds */

/**
 * Decorate the per-call context for the middleware chain with the two things a
 * `.use()` step needs and the raw dispatch context does not carry:
 *
 * - `ctx.meta` — the procedure's declared `.meta(...)` payload, so middleware
 *   reads the policy it is supposed to enforce (`ctx.meta.rateLimit`, …)
 *   instead of having it hard-wired at each `.use()` site.
 * - `ctx.args` — the call's arguments, so a middleware can gate on the payload
 *   (`@lunora/auth`'s Turnstile and email-gate middlewares both read a field
 *   out of it). Without this a `.use()` step is blind to what it is guarding.
 *
 * A procedure with at least one `.use()` step or a `.meta()` payload gets this
 * clone, so `ctx` inside its handler is a spread copy rather than the dispatch
 * context object. Harmless for the generated context (own enumerable data
 * properties only); a host that put a getter or a non-enumerable property on it
 * would not see that survive the spread. Procedures with neither are handed the
 * dispatch context unchanged.
 *
 * `args` is the **validated** result of {@link validateArgs}, never the raw wire
 * object: middleware — including security middleware — must not be handed input
 * that has not crossed the validator. It is a frozen shallow COPY, so a
 * middleware cannot rewrite what the handler then receives; nested objects stay
 * shared with the handler's `args`.
 * ponytail: shallow freeze; deep-freeze (as `.meta()` does) only if a nested
 * write from middleware ever turns up as a real problem — that costs a clone
 * per call, this does not.
 */
/* eslint-enable jsdoc/check-indentation */
const withCallContext = (context: unknown, meta: Record<string, unknown> | undefined, args: Record<string, unknown>, middlewareCount: number): unknown => {
    // Nothing can read `ctx.args`/`ctx.meta` without a `.use()` step — the
    // handler receives `args` as its own parameter — so a procedure with no
    // middleware and no `.meta()` skips the clone entirely. This is the dispatch
    // floor every query and mutation pays, and cloning it unconditionally cost
    // ~20% there.
    if (middlewareCount === 0 && meta === undefined) {
        return context;
    }

    if (typeof context !== "object" || context === null) {
        return context;
    }

    return Object.assign(Object.create(Object.getPrototypeOf(context) as object | null) as object, context, {
        args: Object.freeze({ ...args }),
        ...(meta === undefined ? {} : { meta }),
    });
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
 * `.output()` declared a validator, the handler's result is parsed through
 * {@link applyOutput} so a contract violation surfaces as an internal error at
 * the source rather than as malformed data downstream.
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
        const resolvedContext = await runMiddleware(middlewares, withCallContext(context, meta, parsed, middlewares.length));
        const result = await userHandler({ args: parsed, ctx: resolvedContext });

        return (output ? applyOutput(output, result) : result) as Awaited<R>;
    };

/**
 * Wrap a streaming user handler in the same arg-validation + middleware shell
 * as `makeHandler`, but return the user's `AsyncIterable<R>` directly so the
 * runtime can drive it frame-by-frame. The handler receives an `AbortSignal`
 * the caller flips when they unsubscribe; it's the user's responsibility to
 * honour it (or to wire it into any awaited I/O).
 */
const makeStreamHandler =
    <Args extends ArgsValidator, R>(
        args: Args,
        middlewares: ReadonlyArray<Middleware<unknown, unknown>>,
        userHandler: (options: { args: InferArgs<Args>; ctx: unknown; signal: AbortSignal }) => AsyncGenerator<R, void, void> | AsyncIterable<R>,
        meta?: Record<string, unknown>,
    ) =>
    (context: unknown, rawArgs: InferArgs<Args>, signal: AbortSignal): AsyncIterable<R> => {
        // Args validation runs synchronously at call time so a bad envelope
        // surfaces before the iterator is consumed.
        const parsed = validateArgs(args, rawArgs as Record<string, unknown>);

        // The middleware chain may be async, but we don't want to block the
        // caller before returning an iterable — defer the chain to the first
        // `next()` pump by wrapping the iterator with an outer async generator.
        return (async function* drive(): AsyncGenerator<R, void, void> {
            const resolvedContext = await runMiddleware(middlewares, withCallContext(context, meta, parsed, middlewares.length));
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
    const tags = middlewares.flatMap((middleware) => readRlsTags(middleware));

    return tags.length > 0 ? { tags } : undefined;
};

/**
 * Shadow the mutators `Object.freeze` cannot reach.
 *
 * A frozen `Map`/`Set` still accepts `.set()` / `.add()` / `.delete()` /
 * `.clear()` — the entries live in internal slots, not in properties. The
 * collection here is part of {@link freezeMeta}'s own private clone, so
 * replacing the methods on the instance is safe and makes the immutability
 * promise hold for every value kind rather than only for plain objects.
 */
const lockCollection = (collection: Map<unknown, unknown> | Set<unknown>): void => {
    for (const name of ["add", "clear", "delete", "set"]) {
        if (typeof (collection as unknown as Record<string, unknown>)[name] !== "function") {
            continue;
        }

        Object.defineProperty(collection, name, {
            configurable: false,
            enumerable: false,
            value: () => {
                throw new TypeError(`Cannot mutate a frozen .meta() declaration (${collection.constructor.name}.${name})`);
            },
            writable: false,
        });
    }
};

/** Recursively freeze a value already known to be private to us — see {@link freezeMeta}. */
const deepFreeze = <T>(value: T, seen: WeakSet<object>): T => {
    if (value === null || typeof value !== "object" || seen.has(value)) {
        return value;
    }

    seen.add(value);

    if (value instanceof Map) {
        for (const [key, entry] of value) {
            deepFreeze(key, seen);
            deepFreeze(entry, seen);
        }

        lockCollection(value);
    } else if (value instanceof Set) {
        for (const entry of value) {
            deepFreeze(entry, seen);
        }

        lockCollection(value);
    }

    for (const nested of Object.values(value)) {
        deepFreeze(nested, seen);
    }

    Object.freeze(value);

    return value;
};

/**
 * Copy a `.meta()` declaration into a private, deeply immutable graph.
 *
 * Two things have to hold at once. First, the SAME object reaches every
 * invocation's `ctx.meta`, so a middleware writing `ctx.meta.rateLimit.hits += 1`
 * would edit the procedure's module-level static declaration and have the
 * accumulated value observed by every later request in the isolate. Only a DEEP
 * freeze stops that — `.meta({ rateLimit: { hits: 0 } })` is exactly the nested
 * shape the surface invites, and a shallow `Object.freeze` guards only the half
 * that was never at risk. Second, freezing is a side effect on data the caller
 * still owns: `const shared = { hits: 0 }; c.query.meta({ rateLimit: shared })`
 * must not make `shared.hits += 1` throw in unrelated module scope.
 *
 * So the freeze runs over a `structuredClone`, never over the argument. That
 * also settles the `Map`/`Set` corner a plain walk leaves half-true: entries are
 * copied rather than shared with the caller, and `lockCollection` above makes
 * `ctx.meta.seen.add(x)` throw instead of silently accumulating for the
 * isolate's life.
 *
 * `.meta()` therefore takes structured-cloneable DATA: a function, class
 * instance, or other non-cloneable value is rejected by the runtime with
 * `DataCloneError` at declaration time — the right answer for a surface
 * documented as static metadata, and a build-time failure rather than a
 * request-time one.
 */
const freezeMeta = (meta: Record<string, unknown>): Record<string, unknown> => deepFreeze(structuredClone(meta), new WeakSet());

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
            const maskedTables = unionMaskColumns(state.middlewares);

            return {
                args: state.args,
                ...(state.expose ? { expose: state.expose } : {}),
                handler: makeHandler(state.args, state.middlewares, userHandler, state.output, state.meta),
                kind,
                ...(maskedTables ? { maskedTables } : {}),
                ...(rls ? { rls } : {}),
                ...(visibility ? { visibility } : {}),
                ...(state.x402 ? { x402: state.x402 } : {}),
            };
        },
        // `.meta(obj)` MERGES so a shared base builder can set defaults a
        // specific procedure then extends, mirroring tRPC.
        //
        // Copied and DEEP-frozen because the SAME object reaches every
        // invocation's `ctx.meta` — a middleware writing `ctx.meta.x = 1` (or
        // `ctx.meta.rateLimit.hits += 1`) would otherwise edit the procedure's
        // static declaration and have it observed by every later request in the
        // isolate — and because the caller keeps owning what they passed (see
        // `freezeMeta`). A later `.meta()` still extends it: the spread below
        // reads out of the frozen copy into a fresh object.
        meta: (value: Record<string, unknown>) => makeBuilder(kind, { ...state, meta: freezeMeta({ ...state.meta, ...value }) }, visibility),
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
                      streamOptions?: { durable?: boolean | { ttlMs?: number } },
                  ) => {
                      const rls = collectRls(state.middlewares);
                      const maskedTables = unionMaskColumns(state.middlewares);
                      // `durable: true` and `durable: { … }` are the same thing to
                      // the runtime — normalise here so it only ever sees the object
                      // (and `false`/omitted collapse to "not durable").
                      const durable = streamOptions?.durable === true ? {} : streamOptions?.durable;

                      return {
                          args: state.args,
                          ...(durable ? { durable } : {}),
                          ...(state.expose ? { expose: state.expose } : {}),
                          handler: makeStreamHandler(state.args, state.middlewares, userHandler, state.meta),
                          kind: "stream" as const,
                          ...(maskedTables ? { maskedTables } : {}),
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
 * Entry point for the procedure builder. `dataModel<DM>()` binds the generated
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
    MiddlewareContext,
    MiddlewareNext,
    MutationBuilder,
    QueryBuilder,
    TerminalKind,
} from "./types";
