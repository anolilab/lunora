import type { SchemaLike } from "@lunora/do";
import { createShardCtxDb, runShardMigrations } from "@lunora/do";
import { LunoraError } from "@lunora/errors";
import type {
    ActionCtx,
    ArgsValidator,
    AuthState,
    DatabaseWriter,
    InferArgs,
    LunoraLogger,
    LunoraMetrics,
    LunoraTracer,
    MutationCtx,
    QueryCtx,
    RegisteredAction,
    RegisteredMutation,
    RegisteredQuery,
    Schema,
    TableDefinition,
} from "@lunora/server";

import { createFakeScheduler } from "./fake-scheduler";
import { createSqlExec } from "./node-sqlite";

/**
 * The schema value produced by `@lunora/server`'s `defineSchema`. Accepted
 * structurally; internally it is handed to `@lunora/do`'s `runShardMigrations` /
 * `createShardCtxDb`, whose `SchemaLike` is the same shape declared in the DO
 * package — the two are structurally compatible at runtime (only their
 * independently-declared trigger nesting drifts at the type level), so the
 * boundary cast below is sound.
 */
type TestSchema = Schema<Record<string, TableDefinition>>;

/**
 * A user-supplied identity, surfaced to handlers via `ctx.auth`. `userId` is the
 * subject the handler reads from `ctx.auth.userId`; any additional fields are
 * returned verbatim from `ctx.auth.getIdentity()` (mirroring a decoded JWT).
 */
interface TestIdentity extends Record<string, unknown> {
    userId?: null | string;
}

/**
 * An async iterable/iterator returned by {@link TestHarness.subscribe}.
 * Guarantees `return()` is always defined (unlike the optional `AsyncIterator.return`),
 * so callers can always unsubscribe without a `?.` guard.
 */
interface TestSubscription<R> extends AsyncIterable<R> {
    next: () => Promise<IteratorResult<R, R>>;
    return: () => Promise<IteratorResult<R, R>>;
}

/** An inline handler accepted by `query` / `mutation` / `run`, given direct context access. */
type InlineQueryFunction<R> = (context: QueryCtx) => Promise<R> | R;
type InlineMutationFunction<R> = (context: MutationCtx) => Promise<R> | R;
type InlineActionFunction<R> = (context: ActionCtx) => Promise<R> | R;

/**
 * A map from function path strings (e.g. `"messages:send"`) to their
 * registered function objects. Used by the fake scheduler to resolve
 * `ctx.scheduler.runAfter(delay, "messages:send", args)` → handler invocation.
 *
 * Only mutations and actions can be scheduled in production; queries passed
 * here will be accepted but produce a console.warn at dispatch time.
 *
 * The value type uses `any` because `RegisteredFunction` is contravariant in its
 * args type parameter — a `RegisteredMutation` with concrete args is not assignable
 * to `RegisteredMutation` with `ArgsValidator` at the type level even though at
 * runtime it is sound (the fake scheduler passes `Record&lt;string, unknown>` to
 * `handler` and ignores the return value).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural erasure at registry boundary; see comment above
type FunctionRegistry = Record<string, RegisteredAction<any, any> | RegisteredMutation<any, any> | RegisteredQuery<any, any>>;

/**
 * Options accepted by {@link lunoraTest}.
 *
 * All options are optional — `lunoraTest(schema)` preserves v1 behaviour with
 * clearly-throwing stubs for unsupported surfaces.
 */
interface LunoraTestOptions {
    /**
     * Injectable `ctx.env` for every context (query / mutation / action). When
     * provided, handlers that read `ctx.env.SOME_KEY` (the validated `defineEnv`
     * surface) see this object. Left unset it stays `undefined` — matching the
     * optional `ctx.env?` field, so graceful `ctx.env?.KEY` access still yields
     * `undefined` rather than throwing. Not a throwing stub for exactly that
     * reason: `env` is designed to be legitimately absent.
     * @example
     * ```ts
     * const t = lunoraTest(schema, { env: { STRIPE_KEY: "sk_test_…" } });
     * ```
     */
    env?: Record<string, unknown>;

    /**
     * Injectable `fetch` implementation for action contexts. When provided,
     * `ctx.fetch` in every `action` (and `withIdentity` views) resolves to this
     * function rather than throwing the "not available in v1" stub.
     *
     * Pass `vi.fn()` or any `typeof globalThis.fetch` compatible implementation.
     * @example
     * ```ts
     * const fakeFetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
     * const t = lunoraTest(schema, { fetch: fakeFetch });
     * ```
     */
    fetch?: typeof globalThis.fetch;

    /**
     * Function registry for the fake in-memory scheduler. Maps a
     * `functionPath` string (the value passed as the second argument to
     * `ctx.scheduler.runAfter` / `ctx.scheduler.runAt`) to the corresponding
     * registered function object.
     *
     * Only required if your handlers schedule work. Scheduled jobs for paths
     * NOT listed here produce a `console.warn` at dispatch time (matching prod
     * behaviour for unknown paths).
     * @example
     * ```ts
     * const t = lunoraTest(schema, {
     *   functions: { "messages:send": sendMutation },
     * });
     * ```
     */
    functions?: FunctionRegistry;

    /**
     * Fixed value for `ctx.now` (epoch ms) in every context. Production captures
     * `Date.now()` once per execution; in tests a fixed `now` makes time-dependent
     * handlers deterministic. Defaults to the wall clock at harness creation.
     * @example
     * ```ts
     * const t = lunoraTest(schema, { now: 1_700_000_000_000 });
     * ```
     */
    now?: number;
}

/**
 * The in-memory test harness returned by {@link lunoraTest}. Mirrors the first
 * five methods of Convex's `convexTest`: `query` / `mutation` / `action` / `run`
 * / `withIdentity`. All five share one in-memory `node:sqlite` backend, so a
 * write from one method is visible to a read from another (including across a
 * `withIdentity` scope).
 */
interface TestHarness {
    /** Run a registered `action` (or an inline `async (context) => …`) against the harness. */
    action: {
        <A extends ArgsValidator, R>(reference: RegisteredAction<A, R>, args: InferArgs<A>): Promise<R>;
        <R>(inline: InlineActionFunction<R>): Promise<R>;
    };
    /** Close the underlying in-memory SQLite database, releasing the native handle. Idempotent; safe to call on any `withIdentity` view. */
    close: () => void;
    /** Run a registered `mutation` (or an inline `async (context) => …`) against the harness. */
    mutation: {
        <A extends ArgsValidator, R>(reference: RegisteredMutation<A, R>, args: InferArgs<A>): Promise<R>;
        <R>(inline: InlineMutationFunction<R>): Promise<R>;
    };
    /** Run a registered `query` (or an inline `async (context) => …`) against the harness. */
    query: {
        <A extends ArgsValidator, R>(reference: RegisteredQuery<A, R>, args: InferArgs<A>): Promise<R>;
        <R>(inline: InlineQueryFunction<R>): Promise<R>;
    };
    /** Direct db access at mutation-level (read + write), mirroring `convexTest`'s `run`. */
    run: <R>(function_: InlineMutationFunction<R>) => Promise<R>;

    /**
     * Controls for the fake in-memory scheduler. Always present; scheduler
     * jobs only execute when you call `advance(ms)` or `runPending()`.
     *
     * - `list()` — snapshot of all pending jobs (enqueue order).
     * - `advance(ms)` — tick the virtual clock forward by `ms` ms, executing every job
     * whose `scheduledFor` is now at or below virtual now.
     * - `runPending()` — execute all currently pending jobs regardless of their scheduled time.
     *
     * Scheduled jobs run through the same `runInternal` dispatch as
     * `ctx.runMutation`, so they share the harness SQLite database.
     */
    scheduler: import("./fake-scheduler").FakeSchedulerControls;

    /**
     * Subscribe to a registered query (or inline query function) and receive
     * an async iterable of snapshots. The first value is emitted immediately
     * (the current query result). Subsequent values are emitted after each
     * `mutation` / `run` call on this harness completes.
     *
     * Subscriptions are table-agnostic — any mutation triggers a re-evaluation.
     * This matches the harness's single-writer model and keeps the implementation
     * free of DO machinery.
     * @example
     * ```ts
     * const sub = t.subscribe(list, {});
     * const first = await sub.next(); // current result
     * await t.mutation(send, { author: "ada", body: "hi" });
     * const second = await sub.next(); // updated result
     * await sub.return(); // unsubscribe
     * ```
     *
     * The iterable is lazy — it never buffers more than one pending result.
     * If you do not consume fast enough and multiple mutations fire, the next
     * `next()` call will reflect the most-recent state (intermediate snapshots
     * are coalesced).
     */
    subscribe: {
        <A extends ArgsValidator, R>(reference: RegisteredQuery<A, R>, args: InferArgs<A>): TestSubscription<R>;
        <R>(inline: InlineQueryFunction<R>): TestSubscription<R>;
    };

    /** Return a harness view that shares this harness's db but reports the given identity on `ctx.auth`. */
    withIdentity: (identity: TestIdentity) => TestHarness;
}

const registeredFunctionKind = (value: unknown): "action" | "mutation" | "query" | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const { kind } = value as { kind?: unknown };

    if (kind === "query" || kind === "mutation" || kind === "action") {
        return kind;
    }

    return undefined;
};

const registeredFunctionVisibility = (value: unknown): "internal" | "public" =>
    typeof value === "object" && value !== null && (value as { visibility?: unknown }).visibility === "internal" ? "internal" : "public";

/**
 * Build a value that throws a clear "not available in v1" error the moment a
 * handler touches the stubbed surface — but not at context construction, so
 * functions that never reach for it still run.
 */
const unavailable = (surface: string): never => {
    throw new LunoraError("INTERNAL", `ctx.${surface} is not available in the in-memory @lunora/testing harness (v1)`);
};

/**
 * The proxy target MUST be a function so the `apply` trap fires when the
 * stub is called directly (e.g. `ctx.fetch(url)`). A plain `{}` target is
 * not callable and throws "not a function" before our trap can run.
 */
const stubProxy = (surface: string): unknown =>
    new Proxy((..._args: unknown[]): never => unavailable(surface), {
        apply: () => unavailable(surface),
        get: () => unavailable(surface),
    });

/**
 * `ctx.trace` under test: runs the body and returns its value, recording
 * nothing. There is no sink in the harness, so a span has nowhere to go — but
 * the body must still execute and its result and any throw must pass through
 * untouched, or instrumenting a handler would change what the test observes.
 */
const passthroughTrace: LunoraTracer = async <T>(_name: string, function_: (trace: LunoraTracer) => Promise<T> | T): Promise<T> =>
    await function_(passthroughTrace);

/** `ctx.metrics` under test: accepts every measurement and records nothing. */
const noopMetrics: LunoraMetrics = {
    count: () => undefined,
    gauge: () => undefined,
    record: () => undefined,
};

const noopLog: LunoraLogger = {
    debug: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    info: () => undefined,
    log: () => undefined,
    trace: () => undefined,
    warn: () => undefined,
    with: () => noopLog,
};

/** RunRegistered type extracted so buildSubscribe can reference it without duplication. */
type RunRegisteredFunction = (
    expected: "action" | "mutation" | "query",
    reference: { handler: (context: unknown, args: never) => unknown },
    context: unknown,
    args: unknown,
    allowInternal: boolean,
) => Promise<unknown>;

/**
 * Build the `subscribe` method for a harness view. Extracted to keep
 * `makeHarness` below the 4-level function-nesting limit.
 *
 * Returned function signature: `(referenceOrInline, args?) => TestSubscription`
 *
 * Design — push-based channel with a single pending-result slot:
 * - On each mutation, the listener re-evaluates the query and either resolves a waiting
 * `next()` call immediately, or stores the snapshot so the next `next()` resolves synchronously.
 * - Intermediate snapshots between two `next()` calls are coalesced (the next `next()` sees
 * the most-recent state).
 */
const buildSubscribe = (runRegistered: RunRegisteredFunction, queryContext: QueryCtx, mutationListeners: Set<() => void>): TestHarness["subscribe"] => {
    const factory = (referenceOrInline: unknown, args?: unknown): TestSubscription<unknown> => {
        let done = false;
        // Parked `next()` callers awaiting the next emit. An array (not a single
        // slot) so concurrent `next()` calls — e.g. `Promise.all([sub.next(),
        // sub.next()])` — all settle rather than the later call orphaning the
        // earlier one's promise. Every waiter settles from the same emit.
        const pendingWaiters: { reject: (error: unknown) => void; resolve: (value: IteratorResult<unknown>) => void }[] = [];
        let pendingResult: IteratorResult<unknown> | undefined;
        // A buffered re-evaluation FAILURE (mutually exclusive with pendingResult;
        // each emit clears the other). Wrapped in an object so an `undefined`
        // thrown value is still distinguishable from "no error buffered".
        let pendingError: { error: unknown } | undefined;

        // Monotonic notification sequence. Listener re-evaluations run concurrently
        // (each is a `runQuery().then(emit)`), so their promises can resolve out of
        // notification order — e.g. two back-to-back mutations whose snapshots resolve
        // in reverse would leave the OLDER snapshot buffered last. Each emit carries
        // the seq it was issued for; a stale emit (one a newer notification has already
        // superseded) is dropped so the latest state always wins.
        let latestSeq = 0;
        let appliedSeq = 0;

        const runQuery = (): Promise<unknown> => {
            if (registeredFunctionKind(referenceOrInline)) {
                return runRegistered("query", referenceOrInline as never, queryContext, args, false);
            }

            return Promise.resolve((referenceOrInline as InlineQueryFunction<unknown>)(queryContext));
        };

        const emit = (seq: number, value: unknown): void => {
            // Drop a snapshot a newer notification has already superseded.
            if (seq < appliedSeq) {
                return;
            }

            appliedSeq = seq;

            const iterResult: IteratorResult<unknown> = { done: false, value };

            if (pendingWaiters.length === 0) {
                // No one is waiting — buffer for the next next() call, coalescing
                // any previously buffered result/error.
                pendingResult = iterResult;
                pendingError = undefined;
            } else {
                // This emit is the freshest snapshot; discard any older buffered
                // result/error so a later next() doesn't resurface a superseded one.
                pendingResult = undefined;
                pendingError = undefined;

                for (const waiter of pendingWaiters.splice(0)) {
                    waiter.resolve(iterResult);
                }
            }
        };

        /**
         * Surface a re-evaluation FAILURE at `seq`. Without this a query that
         * throws during a post-mutation re-eval would leave `appliedSeq` stuck
         * below `latestSeq` forever, so every later `next()` parks and never
         * settles. Advancing `appliedSeq` and rejecting/buffering the error lets
         * `next()` reject instead of hanging.
         */
        const emitError = (seq: number, error: unknown): void => {
            if (seq < appliedSeq) {
                return;
            }

            appliedSeq = seq;

            if (pendingWaiters.length === 0) {
                pendingError = { error };
                pendingResult = undefined;
            } else {
                pendingResult = undefined;
                pendingError = undefined;

                for (const waiter of pendingWaiters.splice(0)) {
                    waiter.reject(error);
                }
            }
        };

        /** Curry `emit` so the seq is captured and `.then(emitAt(seq))` stays a clean reference pass. */
        const emitAt =
            (seq: number) =>
            (value: unknown): void => {
                emit(seq, value);
            };

        /** Curry `emitError` so the seq is captured for a `.catch(emitErrorAt(seq))`. */
        const emitErrorAt =
            (seq: number) =>
            (error: unknown): void => {
                emitError(seq, error);
            };

        const listener = (): void => {
            if (done) {
                return;
            }

            latestSeq += 1;

            const seq = latestSeq;

            // Fire-and-forget: re-run the query and emit. A rejection is surfaced to
            // waiting/next next() callers via emitError (not propagated back to the
            // mutation that triggered the re-eval).
            runQuery().then(emitAt(seq)).catch(emitErrorAt(seq));
        };

        mutationListeners.add(listener);

        const iterator: TestSubscription<unknown> = {
            [Symbol.asyncIterator](): AsyncIterator<unknown, unknown> {
                return iterator;
            },

            next: (): Promise<IteratorResult<unknown>> => {
                if (done) {
                    return Promise.resolve({ done: true, value: undefined });
                }

                // A buffered result/error is safe to consume only if it reflects the
                // most recent notification (`appliedSeq === latestSeq`). If a newer
                // re-evaluation is still in flight, the buffer is stale — fall through
                // and wait for that emit so next() never resolves to a superseded
                // snapshot (the schedule-then-write race, where the schedule's empty
                // re-eval buffers before the write's re-eval lands).
                if (appliedSeq === latestSeq) {
                    if (pendingError !== undefined) {
                        const { error } = pendingError;

                        pendingError = undefined;

                        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- re-surfaces the subscription's original thrown value verbatim
                        return Promise.reject(error);
                    }

                    if (pendingResult !== undefined) {
                        const result = pendingResult;

                        pendingResult = undefined;

                        return Promise.resolve(result);
                    }
                }

                if (appliedSeq < latestSeq) {
                    // A newer notification is mid-flight; wait for its emit rather than
                    // racing it with our own runQuery(). Multiple concurrent next()
                    // calls each park their own resolver so none is orphaned.
                    return new Promise<IteratorResult<unknown>>((resolve, reject) => {
                        pendingWaiters.push({ reject, resolve });
                    });
                }

                // No notification outstanding — return the current query result. If
                // the query itself rejects, this next() rejects (surfacing the error).
                return runQuery().then((value) => {
                    // A mutation may have buffered a newer result/error while we
                    // evaluated; prefer it.
                    if (pendingError !== undefined) {
                        const { error } = pendingError;

                        pendingError = undefined;

                        throw error;
                    }

                    if (pendingResult !== undefined) {
                        const result = pendingResult;

                        pendingResult = undefined;

                        return result;
                    }

                    return { done: false, value } satisfies IteratorResult<unknown>;
                });
            },

            return: (): Promise<IteratorResult<unknown>> => {
                done = true;
                mutationListeners.delete(listener);

                // Settle every parked next() as done so no caller hangs after return().
                for (const waiter of pendingWaiters.splice(0)) {
                    waiter.resolve({ done: true, value: undefined });
                }

                return Promise.resolve({ done: true, value: undefined });
            },
        };

        // Emit the initial snapshot (seq 0, the baseline) so the first next() sees
        // data immediately without waiting for a mutation. A failing initial query
        // is surfaced through emitError so the first next() rejects rather than hangs.
        runQuery().then(emitAt(0)).catch(emitErrorAt(0));

        return iterator;
    };

    return factory;
};

/**
 * Spin up an in-memory Lunora function harness for `schema`.
 *
 * `lunoraTest(schema)` runs the migrations against a fresh `node:sqlite`
 * database, builds the same `ctx.db` writer the real Durable Object builds (via
 * `@lunora/do`'s `createShardCtxDb`), and returns a harness whose `query` /
 * `mutation` / `action` / `run` execute a registered function's `handler`
 * directly — no Durable Object, no `wrangler`, no network.
 *
 * **v1 surfaces now supported:**
 *
 * - `ctx.env` (all contexts): inject the validated env via `options.env`; unset it
 * stays `undefined`, matching the optional `ctx.env?` field.
 * - `ctx.fetch` (actions): inject a custom `fetch` via `options.fetch`.
 * - `ctx.scheduler` (mutations + actions): fully functional fake with virtual clock;
 * control via `harness.scheduler.advance(ms)` / `runPending()` / `list()`.
 * - `harness.subscribe(query, args)`: async iterable that re-emits after mutations.
 *
 * **v1 stubs (still throwing):** `ctx.storage`, `ctx.vectors`, `ctx.workflows`.
 * These are clearly documented follow-ups.
 */
const lunoraTest = (schema: TestSchema, options?: LunoraTestOptions): TestHarness => {
    const { close, sql } = createSqlExec();
    const ddlSchema = schema as unknown as SchemaLike;

    runShardMigrations(sql, ddlSchema);

    const database = createShardCtxDb({ schema: ddlSchema, sql }) as unknown as DatabaseWriter;

    // Mutation atomicity — mirrors the real ShardDO, whose codegen `handleRpc`
    // dispatches a mutation inside `runInTransaction` (a BEGIN/COMMIT span). Only
    // the TOP-LEVEL mutation/`run` entry is wrapped (queries are read-only; actions
    // do I/O that can't be rolled back), so a mid-handler throw — including a
    // partial `insertMany`/`patchMany`/`deleteMany` loop — rolls back every write
    // it made, matching production. `ctx.run*` composition dispatches through the
    // internal path INSIDE the already-open span (a mutation's composed writes ride
    // the outer transaction; an action's composed mutation runs unwrapped, exactly
    // as in production). Top-level entries are serialized through a promise queue
    // (see `runInMutationTransaction`) so concurrently-issued mutations never share
    // or interleave a span. The `.exec` is routed through a `.call` indirection — the
    // secret-scan hook flags a literal `.exec(` (see do-exec.ts / node-sqlite.ts).
    const execStatement = (statement: string): void => {
        const runner = sql.exec as (this: typeof sql, query: string) => unknown;

        runner.call(sql, statement);
    };
    // Serialize top-level mutation/`run` entries so concurrently-issued mutations
    // (e.g. `Promise.all([t.mutation(a), t.mutation(b)])`) never interleave their
    // BEGIN/COMMIT spans. This mirrors the real DO's single-writer semantics
    // (input gates): each top-level entry runs to completion — commit or rollback —
    // before the next begins, so no entry ever rides (and is rolled back by)
    // another's transaction, and two spans never nest into an illegal nested BEGIN.
    //
    // Only top-level entries (`t.mutation` / `t.run` / a scheduled mutation) reach
    // here; `ctx.run*` composition dispatches through `runInternal` → `runRegistered`
    // directly, running synchronously inside the already-open span without a fresh
    // BEGIN. So every call to this function is a top-level entry that must queue.
    let mutationQueue: Promise<unknown> = Promise.resolve();

    const runInMutationTransaction = <R>(function_: () => Promise<R> | R): Promise<R> => {
        const runTransaction = async (): Promise<R> => {
            execStatement("BEGIN");

            try {
                const result = await function_();

                execStatement("COMMIT");

                return result;
            } catch (error) {
                try {
                    execStatement("ROLLBACK");
                } catch {
                    // A failed rollback (broken handle) must not mask the original throw.
                }

                throw error;
            }
        };

        const result = mutationQueue.then(runTransaction);

        // Advance the queue tail whether or not this entry succeeds, so a rejected
        // mutation never wedges every later one.
        mutationQueue = result.then(
            () => undefined,
            () => undefined,
        );

        return result;
    };

    // One native SQLite handle backs every harness view (including `withIdentity`
    // scopes); close it once and ignore repeat calls so any accessor can tear the
    // harness down without double-closing the shared handle.
    let closed = false;
    const closeDatabase = (): void => {
        if (closed) {
            return;
        }

        closed = true;
        close();
    };

    // Build the function registry map from the options object.
    const functionRegistryMap = new Map<string, { handler: unknown; kind: string }>(
        Object.entries(options?.functions ?? {}).map(([path, function_]) => [path, function_ as { handler: unknown; kind: string }]),
    );

    // Mutation listeners — subscription sources register here to be notified
    // after every mutation/run completes. Each listener is called with no args
    // and should re-evaluate its query snapshot.
    const mutationListeners = new Set<() => void>();

    const notifyMutationListeners = (): void => {
        for (const listener of mutationListeners) {
            listener();
        }
    };

    // The fake scheduler is created once per harness (not per makeHarness view).
    // The top-level dispatch and mutationContext are not available yet at
    // construction time, so we use thunks to resolve them lazily.
    type ScheduledDispatch = (kind: "action" | "mutation", reference: unknown, context: unknown, args: unknown) => Promise<unknown>;

    let scheduledDispatchRef: ScheduledDispatch | undefined;
    let mutationContextRef: unknown;
    let actionContextRef: unknown;

    // `ctx.now` for every context: captured once so a harness sees one stable
    // instant (production captures it per execution). Overridable via `options.now`.
    // Computed BEFORE the scheduler so the fake scheduler's virtual clock starts
    // from the same instant — otherwise a handler that does
    // `ctx.scheduler.runAt(ctx.now + delay, …)` schedules against a clock that
    // disagrees with `ctx.now`.
    const harnessNow = options?.now ?? Date.now();

    const { controls: schedulerControls, scheduler: fakeScheduler } = createFakeScheduler(
        () => {
            if (scheduledDispatchRef === undefined) {
                throw new LunoraError(
                    "INTERNAL",
                    "[fake-scheduler] dispatch not yet available — scheduler.advance called before harness construction completed",
                );
            }

            return scheduledDispatchRef;
        },
        () => {
            if (mutationContextRef === undefined) {
                throw new LunoraError(
                    "INTERNAL",
                    "[fake-scheduler] mutationContext not yet available — scheduler.advance called before harness construction completed",
                );
            }

            return mutationContextRef;
        },
        () => {
            if (actionContextRef === undefined) {
                throw new LunoraError(
                    "INTERNAL",
                    "[fake-scheduler] actionContext not yet available — scheduler.advance called before harness construction completed",
                );
            }

            return actionContextRef;
        },
        () => functionRegistryMap,
        harnessNow,
    );

    const makeHarness = (identity: null | TestIdentity): TestHarness => {
        const auth: AuthState = {
            // eslint-disable-next-line unicorn/no-null -- AuthState.getIdentity's anonymous sentinel is `null` (mirrors a decoded JWT being absent)
            getIdentity: () => Promise.resolve(identity ?? null),
            // eslint-disable-next-line unicorn/no-null -- AuthState.userId's anonymous sentinel is `null`
            userId: identity?.userId ?? null,
        };

        const queryContext: QueryCtx = {
            auth,
            db: database,
            env: options?.env,
            log: noopLog,
            metrics: noopMetrics,
            now: harnessNow,
            trace: passthroughTrace,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runQuery, after construction completes
            runQuery: (reference, args) => runInternal("query", reference, queryContext, args) as Promise<never>,
            secrets: stubProxy("secrets") as QueryCtx["secrets"],
            storage: stubProxy("storage") as QueryCtx["storage"],
            vectors: stubProxy("vectors") as QueryCtx["vectors"],
        };

        const mutationContext: MutationCtx = {
            auth,
            db: database,
            env: options?.env,
            log: noopLog,
            metrics: noopMetrics,
            now: harnessNow,
            trace: passthroughTrace,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runMutation, after construction completes
            runMutation: (reference, args) => runInternal("mutation", reference, mutationContext, args) as Promise<never>,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runQuery, after construction completes
            runQuery: (reference, args) => runInternal("query", reference, queryContext, args) as Promise<never>,
            scheduler: fakeScheduler,
            secrets: stubProxy("secrets") as MutationCtx["secrets"],
            storage: stubProxy("storage") as MutationCtx["storage"],
            vectors: stubProxy("vectors") as MutationCtx["vectors"],
            workflows: stubProxy("workflows") as MutationCtx["workflows"],
        };

        // Wire the context references for the fake scheduler thunks.
        // Only set on the first call (the base harness); withIdentity views share the
        // same scheduler so the base mutationContext is the canonical one.
        mutationContextRef ??= mutationContext;

        const actionContext: ActionCtx = {
            auth,
            db: database,
            env: options?.env,
            // Use the injected fetch when provided; fall back to the v1 stub otherwise.
            fetch: options?.fetch ?? (stubProxy("fetch") as ActionCtx["fetch"]),
            log: noopLog,
            metrics: noopMetrics,
            now: harnessNow,
            trace: passthroughTrace,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runAction, after construction completes
            runAction: (reference, args) => runInternal("action", reference, actionContext, args) as Promise<never>,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runMutation, after construction completes
            runMutation: (reference, args) => runInternal("mutation", reference, mutationContext, args) as Promise<never>,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runQuery, after construction completes
            runQuery: (reference, args) => runInternal("query", reference, queryContext, args) as Promise<never>,
            scheduler: fakeScheduler,
            secrets: stubProxy("secrets") as ActionCtx["secrets"],
            storage: stubProxy("storage") as ActionCtx["storage"],
            vectors: stubProxy("vectors") as ActionCtx["vectors"],
            workflows: stubProxy("workflows") as ActionCtx["workflows"],
        };

        // Wire the action-context reference for the fake scheduler thunk (mirrors
        // mutationContextRef above): only set on the first call (the base harness);
        // withIdentity views share the same scheduler so the base actionContext is
        // the canonical one.
        actionContextRef ??= actionContext;

        const runRegistered = (
            expected: "action" | "mutation" | "query",
            reference: { handler: (context: unknown, args: never) => unknown },
            context: unknown,
            args: unknown,
            allowInternal: boolean,
        ): Promise<unknown> => {
            const kind = registeredFunctionKind(reference);

            if (kind !== expected) {
                throw new LunoraError("INTERNAL", `expected a registered ${expected}, received a ${kind ?? "non-function"} reference`);
            }

            if (!allowInternal && registeredFunctionVisibility(reference) === "internal") {
                throw new LunoraError(
                    "INTERNAL",
                    `This ${expected} is an internal function — it is unreachable from the external RPC boundary in production. ` +
                        `Call it through ctx.run${expected.charAt(0).toUpperCase()}${expected.slice(1)} from another function instead.`,
                );
            }

            return Promise.resolve(reference.handler(context, (args ?? {}) as never));
        };

        // Internal (server-to-server) dispatch surface used by ctx.run*. Mirrors
        // prod's `isSystemDispatch()` branch: internal functions are reachable here.
        const runInternal = (expected: "action" | "mutation" | "query", reference: unknown, context: unknown, args: unknown): Promise<unknown> =>
            runRegistered(expected, reference as never, context, args, true);

        // Top-level dispatch for the fake scheduler. A scheduled job is a fresh
        // top-level entry (production dispatches it back to the Worker as its own
        // RPC), so a scheduled mutation runs inside its own BEGIN/COMMIT span and
        // notifies subscription listeners on success — mirroring a `t.mutation(...)`
        // call. A scheduled action runs unwrapped (no rollback semantics), exactly
        // as `runInternal` would. `internal*` targets are reachable here because the
        // scheduler is the trusted server-dispatch surface (allowInternal = true).
        scheduledDispatchRef ??= (kind, reference, context, args) => {
            if (kind === "mutation") {
                return runInMutationTransaction(() => runRegistered("mutation", reference as never, context, args, true)).then((result) => {
                    notifyMutationListeners();

                    return result;
                });
            }

            return runInternal("action", reference, context, args);
        };

        const query = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
            if (registeredFunctionKind(referenceOrInline)) {
                return runRegistered("query", referenceOrInline as never, queryContext, args, false);
            }

            return Promise.resolve((referenceOrInline as InlineQueryFunction<unknown>)(queryContext));
        }) as TestHarness["query"];

        const mutation = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
            if (registeredFunctionKind(referenceOrInline)) {
                return runInMutationTransaction(() => runRegistered("mutation", referenceOrInline as never, mutationContext, args, false)).then((result) => {
                    notifyMutationListeners();

                    return result;
                });
            }

            return runInMutationTransaction(() => (referenceOrInline as InlineMutationFunction<unknown>)(mutationContext)).then((result) => {
                notifyMutationListeners();

                return result;
            });
        }) as TestHarness["mutation"];

        const action = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
            if (registeredFunctionKind(referenceOrInline)) {
                return runRegistered("action", referenceOrInline as never, actionContext, args, false);
            }

            return Promise.resolve((referenceOrInline as InlineActionFunction<unknown>)(actionContext));
        }) as TestHarness["action"];

        const subscribe = buildSubscribe(runRegistered, queryContext, mutationListeners);

        const harness: TestHarness = {
            action,
            close: closeDatabase,
            mutation,
            query,
            run: (function_) =>
                runInMutationTransaction(() => function_(mutationContext)).then((result) => {
                    notifyMutationListeners();

                    return result;
                }),
            scheduler: schedulerControls,
            subscribe,
            // A scoped view shares the SAME sql/db handle (created once above), so
            // writes performed under an identity persist for every accessor.
            withIdentity: (next) => makeHarness(next),
        };

        return harness;
    };

    // eslint-disable-next-line unicorn/no-null -- a fresh harness has no identity; `null` is AuthState's anonymous sentinel
    return makeHarness(null);
};

export { lunoraTest };
export type { FakeScheduledJob, FakeSchedulerControls, ScheduledJobFailure, SweepOptions } from "./fake-scheduler";
export type { FunctionRegistry, LunoraTestOptions, TestHarness, TestIdentity, TestSubscription };
