import { LunoraError } from "@lunora/errors";
import type { NotifyDefinition } from "@lunora/notify";
import type {
    ActionCtx,
    ArgsValidator,
    AuthState,
    InferArgs,
    MutationCtx,
    QueryCtx,
    RegisteredAction,
    RegisteredMutation,
    RegisteredQuery,
    Schema,
    TableDefinition,
} from "@lunora/server";
import { withDeferredSchedules } from "@lunora/server";
import { createInProcessRuntime, registeredFunctionKind, resolveInProcessIdentity, runRegisteredFunction } from "@lunora/server/in-process";

import type { RecordedWideEvent } from "./context-fakes";
import { createRecordingSpan, noopLog, noopMetrics, passthroughTrace, servicesContext, stubProxy } from "./context-fakes";
import type { FakeNotifyControls, NotifySurfaces } from "./fake-notify";
import { createFakeNotify } from "./fake-notify";
import type { FakeQueueControls, QueueSurface } from "./fake-queues";
import { createFakeQueues } from "./fake-queues";
import { createFakeScheduler } from "./fake-scheduler";
import type { FakeTopicControls, TopicSurface } from "./fake-topics";
import { createFakeTopics } from "./fake-topics";
import { createSqlExec } from "./node-sqlite";

/** The schema value produced by `@lunora/server`'s `defineSchema`. */
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
 * runtime it is sound (the fake scheduler passes `Record<string, unknown>` to
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
     * Enforce the secure-by-default RLS guard on the writer registered
     * procedures dispatch through (`query`/`mutation`/`action`, via
     * `reference.handler`) — the same `enforceRls: true` production's generated
     * `buildCtx` always passes. Under a `.rls("required")` schema, a procedure
     * that touches a known, non-`.public()` table without `.use(rls(...))` in
     * its chain rejects with `RlsRequiredError`, exactly as it would on first
     * dispatch in production. Defaults to `true` so a green suite means the
     * deploy is RLS-safe; the harness's other surfaces — `t.run` and any
     * `@lunora/seed` helper built on it — stay on the trusted, UNGUARDED writer
     * regardless of this flag (mirroring production's admin/migration system
     * paths).
     *
     * Set to `false` to opt back into the pre-guard permissive behaviour (every
     * `lunoraTest` release before this option existed): every procedure's
     * `ctx.db` goes unguarded even under a `.rls("required")` schema. This
     * forfeits the "a passing suite means the deploy is safe" guarantee — a
     * procedure that forgot `.use(rls(...))` will pass in tests and throw
     * `RlsRequiredError` on its first production request. No effect when the
     * schema does not declare `.rls("required")` (the guard is a no-op there
     * either way).
     * @default true
     * @example
     * ```ts
     * // Restores the old permissive behavior for a suite not yet migrated.
     * const t = lunoraTest(schema, { enforceRls: false });
     * ```
     */
    enforceRls?: boolean;

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
     * const fakeFetch = vi.fn(async () => Response.json({ ok: true }));
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
     * The app's `lunora/notify.ts` default export. Enables `ctx.notify` and its
     * `ctx.push` alias on every context, built by `@lunora/notify`'s own
     * `createNotify` — so register / list / unregister / broadcast behave as in
     * production, and channels are wired exactly when production wires them
     * (each factory is called with `options.env`; a push target for a transport
     * that resolved to nothing fails). Differences: deliveries are recorded and
     * report accepted instead of reaching a service (no send-time DNS re-check,
     * retry or circuit breaker), and subscriptions live in an in-memory store —
     * the definition's `store` is never called. Assert on deliveries with
     * `harness.notify.sent()`. Left unset, touching `ctx.notify` / `ctx.push` —
     * or calling `harness.notify.sent()` — throws, naming this option.
     * @example
     * ```ts
     * import notify from "../lunora/notify";
     *
     * const t = lunoraTest(schema, { notify });
     * await t.action(alertOwner, { orderId });
     * expect(t.notify.sent("push")).toHaveLength(1);
     * ```
     */
    notify?: NotifyDefinition;

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

    /**
     * The export names of the queues in `lunora/queues.ts` (the keys of
     * `ctx.queues`). Each gets a recording producer on mutation and action
     * contexts, behind `@lunora/queue`'s own validation (batch cap, delay
     * ceiling), so a send the platform would refuse rejects here too. A name not
     * listed rejects on use, as an undeclared queue does in production. Assert
     * on sends with `harness.queues.sent(name)`. Left unset, touching
     * `ctx.queues` — or calling `harness.queues.sent()` — throws, naming this
     * option.
     * @example
     * ```ts
     * const t = lunoraTest(schema, { queues: ["jobs"] });
     * await t.mutation(enqueueJob, { id: "a" });
     * expect(t.queues.sent("jobs")).toEqual([{ body: { id: "a" }, queue: "jobs" }]);
     * ```
     */
    queues?: ReadonlyArray<string>;

    /**
     * Fakes for `ctx.services` (the `lunora.config` `services` an app calls),
     * keyed like `ctx.services`. Set on action contexts only — queries and
     * mutations have no `ctx.services` at runtime either. A key with no fake
     * throws on use, naming the option to add it to.
     * @example
     * ```ts
     * const t = lunoraTest(schema, {
     *   services: { documentParser: { fetch: vi.fn(async () => Response.json({ text: "…" })) } },
     * });
     * ```
     */
    services?: Record<string, object>;

    /**
     * The export names of the topics in `lunora/queues.ts` (the keys of
     * `ctx.topics`). Each gets a recording publisher on mutation and action
     * contexts, built by `@lunora/queue`'s own `createTopicContext` — so the
     * batch cap, delay ceiling and reserved-key check reject as in production,
     * and a name not listed rejects on use. Bodies are recorded and size-checked
     * as `queues` records them, once per message however many subscriptions the
     * app declares; no subscription handler runs. Assert with
     * `harness.topics.published(name)`. Left unset, touching `ctx.topics` — or
     * calling `harness.topics.published()` — throws, naming this option.
     * @example
     * ```ts
     * const t = lunoraTest(schema, { topics: ["signups"] });
     * await t.mutation(signUp, { email: "a@example.test" });
     * expect(t.topics.published("signups")).toHaveLength(1);
     * ```
     */
    topics?: ReadonlyArray<string>;
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

    /**
     * What handlers delivered through `ctx.notify` / `ctx.push` (enabled by
     * `options.notify`): `sent(channel?)` in send order, `clear()` to reset.
     * Both throw when the option was not passed. Shared with any `withIdentity` view.
     */
    notify: FakeNotifyControls;
    /** Run a registered `query` (or an inline `async (context) => …`) against the harness. */
    query: {
        <A extends ArgsValidator, R>(reference: RegisteredQuery<A, R>, args: InferArgs<A>): Promise<R>;
        <R>(inline: InlineQueryFunction<R>): Promise<R>;
    };

    /**
     * What handlers enqueued through `ctx.queues` (declared by `options.queues`):
     * `sent(name?)` in send order, `clear()` to reset. Sends are not
     * transactional in production, so one made by a mutation that then threw is
     * recorded too. Both throw when the option was not passed. Shared with any
     * `withIdentity` view.
     */
    queues: FakeQueueControls;

    /**
     * Direct db access at mutation-level (read + write), mirroring `convexTest`'s
     * `run`. This is the harness's trusted escape hatch: `ctx.db` here is always
     * the UNGUARDED writer, regardless of `options.enforceRls` or the schema's
     * RLS mode — seeding/asserting against a protected table never trips the
     * secure-by-default guard. A `ctx.runMutation`/`ctx.runQuery` call from
     * inside the body still dispatches the target as a real registered
     * procedure, so it is guarded exactly as `t.mutation`/`t.query` would guard
     * it.
     */
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

    /**
     * What handlers published through `ctx.topics` (declared by `options.topics`):
     * `published(name?)` in publish order, `clear()` to reset. Like queue sends,
     * publishes are not transactional. Both throw when the option was not passed.
     * Shared with any `withIdentity` view.
     */
    topics: FakeTopicControls;

    /**
     * What handlers attached to `ctx.span` — the **wide event** — during this
     * harness's runs, so a test can assert the instrumentation itself:
     *
     * ```ts
     * await t.mutation(checkout, { items: 3 });
     * expect(t.wideEvent().attributes["cart.items"]).toBe(3);
     * ```
     *
     * Accumulates across calls on this view (it is not reset per run), mirroring
     * the harness's single shared database. Shared with any `withIdentity` view.
     */
    wideEvent: () => RecordedWideEvent;

    /** Return a harness view that shares this harness's db but reports the given identity on `ctx.auth`. */
    withIdentity: (identity: TestIdentity) => TestHarness;
}

type RunRegisteredFunction = typeof runRegisteredFunction;

/** The app-specific surfaces codegen adds to a mutation context (and an action's) on top of `MutationCtx`. */
type HarnessMutationContext = MutationCtx & NotifySurfaces & QueueSurface & TopicSurface;

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
 * `@lunora/shard-engine`'s `createShardCtxDb`, with the same `enforceRls: true`
 * production's generated `buildCtx` passes), and returns a harness whose
 * `query` / `mutation` / `action` execute a registered function's `handler`
 * directly — no Durable Object, no `wrangler`, no network. Under a
 * `.rls("required")` schema a procedure missing `.use(rls(...))` therefore
 * rejects here exactly as it would on its first production dispatch — see
 * `LunoraTestOptions.enforceRls` to opt out, and `run`'s doc for the trusted
 * escape hatch (always unguarded).
 *
 * **v1 surfaces now supported:**
 *
 * - `ctx.env` (all contexts): inject the validated env via `options.env`; unset it
 * stays `undefined`, matching the optional `ctx.env?` field.
 * - `ctx.fetch` (actions): inject a custom `fetch` via `options.fetch`.
 * - `ctx.scheduler` (mutations + actions): fully functional fake with virtual clock;
 * control via `harness.scheduler.advance(ms)` / `runPending()` / `list()`. As in
 * production it is transactional inside a mutation: a job scheduled by a mutation
 * that then throws never becomes pending.
 * - `ctx.queues` (mutations + actions): recording producers for `options.queues`;
 * inspect via `harness.queues.sent(name)`.
 * - `ctx.topics` (mutations + actions): recording publishers for `options.topics`;
 * inspect via `harness.topics.published(name)`.
 * - `ctx.notify` / `ctx.push` (all contexts): built from `options.notify` with
 * recorded deliveries and in-memory subscriptions; inspect via `harness.notify.sent()`.
 * - `harness.subscribe(query, args)`: async iterable that re-emits after mutations.
 *
 * **v1 stubs (still throwing):** `ctx.storage`, `ctx.vectors`, `ctx.workflows`.
 * These are clearly documented follow-ups.
 */
const lunoraTest = (schema: TestSchema, options?: LunoraTestOptions): TestHarness => {
    const { close, sql } = createSqlExec();

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

    /** Pass-through `.then` callback: notify subscription listeners after a successful top-level mutation entry. */
    const notifyAfter = <R>(result: R): R => {
        notifyMutationListeners();

        return result;
    };

    // The fake scheduler is created once per harness (not per makeHarness view).
    // The top-level dispatch and mutationContext are not available yet at
    // construction time, so we use thunks to resolve them lazily.
    type ScheduledDispatch = (kind: "action" | "mutation", reference: unknown, context: unknown, args: unknown) => Promise<unknown>;

    let scheduledDispatchRef: ScheduledDispatch | undefined;
    let mutationContextRef: unknown;
    let actionContextRef: unknown;

    // `ctx.now` for every context. Production captures it once per execution, so
    // the harness reads the clock when a handler touches `ctx.now` — not once when
    // the harness is built, which left a test that moved the clock with
    // `vi.setSystemTime` after setup reading a stale instant. A fixed
    // `options.now` still wins. The fake scheduler's virtual clock is seeded
    // from the same starting instant, so `ctx.scheduler.runAt(ctx.now + delay, …)`
    // schedules against the clock `ctx.now` reports.
    const currentNow = (): number => options?.now ?? Date.now();
    const schedulerSeedNow = currentNow();

    // The clock one top-level run reads. Production captures `ctx.now` once per
    // execution, so a top-level call takes the clock when it starts and holds it until
    // it settles. A nested `ctx.run*` inherits the outer run's clock, and the previous
    // value is restored afterwards.
    let runClock: number | undefined;
    // Generic over the function type, so the harness keeps each overload's signature.
    const inRun = <F extends (...args: never[]) => unknown>(run: F): F =>
        ((...args: never[]) => {
            const previous = runClock;

            runClock = currentNow();

            const result = (run as (...callArgs: never[]) => unknown)(...args);

            if (result instanceof Promise) {
                return result.finally(() => {
                    runClock = previous;
                });
            }

            runClock = previous;

            return result;
        }) as F;
    // One recorder per harness (shared by the query/mutation/action contexts, so a
    // `ctx.runMutation` from a query accumulates onto the same wide event the real
    // runtime would — a composed call reuses the outer dispatch's span).
    const dispatchSpan = createRecordingSpan();
    // Recorders shared by every view, like the scheduler: what one identity's
    // handler sends is visible from any `withIdentity` scope.
    const { controls: queueControls, surfaces: queueSurfaces } = createFakeQueues(options?.queues);
    const { controls: topicControls, surfaces: topicSurfaces } = createFakeTopics(options?.topics);
    const { controls: notifyControls, surfaces: notifySurfaces } = createFakeNotify(options?.notify, options?.env ?? {});

    /** Guard for the lazily-wired scheduler references: fail loudly if a sweep runs before harness construction completed. */
    const requireReference = <T>(value: T | undefined, name: string): T => {
        if (value === undefined) {
            throw new LunoraError("INTERNAL", `[fake-scheduler] ${name} not yet available — scheduler.advance called before harness construction completed`);
        }

        return value;
    };

    const { controls: schedulerControls, scheduler: fakeScheduler } = createFakeScheduler(
        () => requireReference(scheduledDispatchRef, "dispatch"),
        () => requireReference(mutationContextRef, "mutationContext"),
        () => requireReference(actionContextRef, "actionContext"),
        () => functionRegistryMap,
        schedulerSeedNow,
    );

    // `ctx.scheduler` as production installs it on a mutation/action ctx: the
    // deferral facade from `@lunora/server`, so a `runAfter`/`runAt` issued inside
    // a transaction is buffered and only reaches the scheduler once that
    // transaction commits (`runInTransaction` opens and settles the
    // window). Without it a rolled-back mutation still leaves its job pending, and
    // the harness would tell a test the opposite of what production does.
    const scheduler = withDeferredSchedules(fakeScheduler);

    // Schema → migrations → `ctx.db` writers → mutation transactions: the
    // in-process core from `@lunora/server/in-process`, here over `node:sqlite`. Every
    // mutation entry (`t.mutation`, `t.run`, a scheduled mutation, an action's
    // `ctx.runMutation`) goes through its `runInTransaction`, so a
    // mid-handler throw rolls back every write it made and the jobs it scheduled,
    // matching production; a mutation's own `ctx.run*` composition rides the
    // already-open span through `runInternal` instead.
    const { createWriters, resetHeadroom, runInTransaction } = createInProcessRuntime(schema, {
        enforceRls: options?.enforceRls,
        scheduler,
        sql,
    });

    const makeHarness = (identity: null | TestIdentity): TestHarness => {
        const resolved = resolveInProcessIdentity(identity);
        const auth: AuthState = {
            getIdentity: () => Promise.resolve(resolved.claims),
            userId: resolved.userId,
        };
        const { database, rawDatabase } = createWriters(resolved);

        const queryContext: NotifySurfaces & QueryCtx = {
            ...notifySurfaces,
            auth,
            db: database,
            env: options?.env,
            log: noopLog,
            metrics: noopMetrics,
            get now(): number {
                return runClock ?? currentNow();
            },
            newId: () => crypto.randomUUID(),
            span: dispatchSpan.handle,
            trace: passthroughTrace,

            runQuery: ((reference: never, args: never) =>
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: invoked only when a handler calls ctx.runQuery, after construction completes
                runInternal("query", reference, queryContext, args) as Promise<never>) as unknown as QueryCtx["runQuery"],
            secrets: stubProxy("secrets") as QueryCtx["secrets"],
            storage: stubProxy("storage") as QueryCtx["storage"],
            vectors: stubProxy("vectors") as QueryCtx["vectors"],
        };

        const mutationContext: HarnessMutationContext = {
            ...notifySurfaces,
            ...queueSurfaces,
            ...topicSurfaces,
            auth,
            db: database,
            env: options?.env,
            log: noopLog,
            metrics: noopMetrics,
            get now(): number {
                return runClock ?? currentNow();
            },
            newId: () => crypto.randomUUID(),
            span: dispatchSpan.handle,
            trace: passthroughTrace,

            runMutation: ((reference: never, args: never) =>
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: invoked only when a handler calls ctx.runMutation, after construction completes
                runInternal("mutation", reference, mutationContext, args) as Promise<never>) as unknown as MutationCtx["runMutation"],

            runQuery: ((reference: never, args: never) =>
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: invoked only when a handler calls ctx.runQuery, after construction completes
                runInternal("query", reference, queryContext, args) as Promise<never>) as unknown as QueryCtx["runQuery"],
            scheduler,
            secrets: stubProxy("secrets") as MutationCtx["secrets"],
            storage: stubProxy("storage") as MutationCtx["storage"],
            vectors: stubProxy("vectors") as MutationCtx["vectors"],
            workflows: stubProxy("workflows") as MutationCtx["workflows"],
        };

        // Wire the context references for the fake scheduler thunks.
        // Only set on the first call (the base harness); withIdentity views share the
        // same scheduler so the base mutationContext is the canonical one.
        mutationContextRef ??= mutationContext;

        // The trusted escape hatch's context: same auth/env/scheduler/runMutation/
        // runQuery as `mutationContext` (composed `ctx.runMutation`/`ctx.runQuery`
        // calls still dispatch registered procedures through the GUARDED
        // `mutationContext`/`queryContext` closures above — only DIRECT `ctx.db`
        // access from a `t.run` body is unguarded), but `db` is the raw writer.
        // Backs `harness.run` only — `query`/`mutation`/`action` dispatch (both the
        // registered-procedure and inline-callback forms) stays on the guarded
        // `queryContext`/`mutationContext`/`actionContext` above.
        const rawMutationContext: HarnessMutationContext = { ...mutationContext, db: rawDatabase };

        // `services` is not on the base ActionCtx: codegen adds it to the app's own
        // action context when `lunora.config` declares services.
        const actionContext: ActionCtx & NotifySurfaces & QueueSurface & TopicSurface & { services: Record<string, object> } = {
            ...notifySurfaces,
            ...queueSurfaces,
            ...topicSurfaces,
            auth,
            db: database,
            env: options?.env,
            // Use the injected fetch when provided; fall back to the v1 stub otherwise.
            fetch: options?.fetch ?? (stubProxy("fetch") as ActionCtx["fetch"]),
            log: noopLog,
            metrics: noopMetrics,
            get now(): number {
                return runClock ?? currentNow();
            },
            newId: () => crypto.randomUUID(),
            span: dispatchSpan.handle,
            trace: passthroughTrace,

            runAction: ((reference: never, args: never) =>
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: invoked only when a handler calls ctx.runAction, after construction completes
                runInternal("action", reference, actionContext, args) as Promise<never>) as unknown as ActionCtx["runAction"],

            // An action is not transactional, so a mutation it composes opens its
            // OWN BEGIN/COMMIT span — exactly as the generated shard's
            // `runMutationTransaction` does when `ctx.runMutation` is reached from a
            // non-mutation dispatch. Without it the composed handler's writes
            // autocommit one by one, so a mid-handler throw leaves the earlier ones
            // behind — the opposite of the atomicity the documented "do the
            // transactional work in a mutation and call it from the action" recipe
            // promises.
            runMutation: ((reference: never, args: never) =>
                runInTransaction(() =>
                    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: invoked only when a handler calls ctx.runMutation, after construction completes
                    runInternal("mutation", reference, mutationContext, args),
                ).then(notifyAfter) as Promise<never>) as unknown as MutationCtx["runMutation"],

            runQuery: ((reference: never, args: never) =>
                // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: invoked only when a handler calls ctx.runQuery, after construction completes
                runInternal("query", reference, queryContext, args) as Promise<never>) as unknown as QueryCtx["runQuery"],
            scheduler,
            secrets: stubProxy("secrets") as ActionCtx["secrets"],
            services: servicesContext(options?.services),
            storage: stubProxy("storage") as ActionCtx["storage"],
            vectors: stubProxy("vectors") as ActionCtx["vectors"],
            workflows: stubProxy("workflows") as ActionCtx["workflows"],
        };

        // Wire the action-context reference for the fake scheduler thunk (mirrors
        // mutationContextRef above): only set on the first call (the base harness);
        // withIdentity views share the same scheduler so the base actionContext is
        // the canonical one.
        actionContextRef ??= actionContext;

        // Internal (server-to-server) dispatch surface used by ctx.run*. Mirrors
        // prod's `isSystemDispatch()` branch: internal functions are reachable here.
        const runInternal = (expected: "action" | "mutation" | "query", reference: unknown, context: unknown, args: unknown): Promise<unknown> =>
            runRegisteredFunction(expected, reference as never, context, args, true);

        // Top-level dispatch for the fake scheduler. A scheduled job is a fresh
        // top-level entry (production dispatches it back to the Worker as its own
        // RPC), so a scheduled mutation runs inside its own BEGIN/COMMIT span and
        // notifies subscription listeners on success — mirroring a `t.mutation(...)`
        // call. A scheduled action runs unwrapped (no rollback semantics), exactly
        // as `runInternal` would. `internal*` targets are reachable here because the
        // scheduler is the trusted server-dispatch surface (allowInternal = true).
        scheduledDispatchRef ??= (kind, reference, context, args) => {
            if (kind === "mutation") {
                return runInTransaction(() => runRegisteredFunction("mutation", reference as never, context, args, true)).then(notifyAfter);
            }

            resetHeadroom();

            return runInternal("action", reference, context, args);
        };

        const query = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
            resetHeadroom();

            if (registeredFunctionKind(referenceOrInline)) {
                return runRegisteredFunction("query", referenceOrInline as never, queryContext, args, false);
            }

            return Promise.resolve((referenceOrInline as InlineQueryFunction<unknown>)(queryContext));
        }) as TestHarness["query"];

        const mutation = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
            const body = registeredFunctionKind(referenceOrInline)
                ? (): Promise<unknown> => runRegisteredFunction("mutation", referenceOrInline as never, mutationContext, args, false)
                : (): unknown => (referenceOrInline as InlineMutationFunction<unknown>)(mutationContext);

            return runInTransaction(body).then(notifyAfter);
        }) as TestHarness["mutation"];

        const action = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
            resetHeadroom();

            if (registeredFunctionKind(referenceOrInline)) {
                return runRegisteredFunction("action", referenceOrInline as never, actionContext, args, false);
            }

            return Promise.resolve((referenceOrInline as InlineActionFunction<unknown>)(actionContext));
        }) as TestHarness["action"];

        // A subscription re-run is its own top-level dispatch (production re-dispatches
        // the query), so it gets a fresh budget rather than accumulating onto the last one.
        const subscribe = buildSubscribe(
            (...parameters) => {
                resetHeadroom();

                return runRegisteredFunction(...parameters);
            },
            queryContext,
            mutationListeners,
        );

        // The inline `t.run` body, hoisted so the harness object stays shallow.
        const runTopLevelInline = (function_: InlineMutationFunction<unknown>): Promise<unknown> =>
            runInTransaction(() => function_(rawMutationContext)).then(notifyAfter);

        const harness: TestHarness = {
            action: inRun(action),
            close: closeDatabase,
            mutation: inRun(mutation),
            notify: notifyControls,
            query: inRun(query),
            queues: queueControls,
            run: inRun(runTopLevelInline) as TestHarness["run"],
            scheduler: schedulerControls,
            subscribe,
            topics: topicControls,
            wideEvent: () => dispatchSpan.recorded,
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
export type { RecordedWideEvent } from "./context-fakes";
export type { FakeNotifyControls, NotifyChannel, SentNotification } from "./fake-notify";
export type { FakeQueueControls, SentQueueMessage } from "./fake-queues";
export type { FakeScheduledJob, FakeSchedulerControls, ScheduledJobFailure, SweepOptions } from "./fake-scheduler";
export type { FakeTopicControls, PublishedTopicMessage } from "./fake-topics";
export type { FunctionRegistry, LunoraTestOptions, TestHarness, TestIdentity, TestSubscription };
