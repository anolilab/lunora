import type { SchemaLike } from "@cirrus/do";
import { createShardCtxDb, runShardMigrations } from "@cirrus/do";
import type {
    ActionCtx,
    ArgsValidator,
    AuthState,
    CirrusLogger,
    DatabaseWriter,
    InferArgs,
    MutationCtx,
    QueryCtx,
    RegisteredAction,
    RegisteredMutation,
    RegisteredQuery,
    Schema,
    TableDefinition,
} from "@cirrus/server";

import { createSqlExec } from "./node-sqlite";

/**
 * The schema value produced by `@cirrus/server`'s `defineSchema`. Accepted
 * structurally; internally it is handed to `@cirrus/do`'s `runShardMigrations` /
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

/** An inline handler accepted by `query` / `mutation` / `run`, given direct context access. */
type InlineQueryFunction<R> = (context: QueryCtx) => Promise<R> | R;
type InlineMutationFunction<R> = (context: MutationCtx) => Promise<R> | R;
type InlineActionFunction<R> = (context: ActionCtx) => Promise<R> | R;

/**
 * The in-memory test harness returned by {@link cirrusTest}. Mirrors the first
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
    throw new Error(`ctx.${surface} is not available in the in-memory @cirrus/testing harness (v1)`);
};

const stubProxy = (surface: string): unknown =>
    new Proxy(
        {},
        {
            apply: () => unavailable(surface),
            get: () => unavailable(surface),
        },
    );

const noopLog: CirrusLogger = {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    log: () => undefined,
    warn: () => undefined,
};

/**
 * Spin up an in-memory Cirrus function harness for `schema`.
 *
 * `cirrusTest(schema)` runs the migrations against a fresh `node:sqlite`
 * database, builds the same `ctx.db` writer the real Durable Object builds (via
 * `@cirrus/do`'s `createShardCtxDb`), and returns a harness whose `query` /
 * `mutation` / `action` / `run` execute a registered function's `handler`
 * directly — no Durable Object, no `wrangler`, no network.
 *
 * v1 stubs `ctx.storage`, `ctx.scheduler`, `ctx.vectors`, and action `ctx.fetch`:
 * each throws a clear error the first time a handler touches it.
 */
const cirrusTest = (schema: TestSchema): TestHarness => {
    const { close, sql } = createSqlExec();
    const ddlSchema = schema as unknown as SchemaLike;

    runShardMigrations(sql, ddlSchema);

    const database = createShardCtxDb({ schema: ddlSchema, sql }) as unknown as DatabaseWriter;

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
            log: noopLog,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runQuery, after construction completes
            runQuery: (reference, args) => runInternal("query", reference, queryContext, args) as Promise<never>,
            storage: stubProxy("storage") as QueryCtx["storage"],
            vectors: stubProxy("vectors") as QueryCtx["vectors"],
        };

        const mutationContext: MutationCtx = {
            auth,
            db: database,
            log: noopLog,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runMutation, after construction completes
            runMutation: (reference, args) => runInternal("mutation", reference, mutationContext, args) as Promise<never>,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runQuery, after construction completes
            runQuery: (reference, args) => runInternal("query", reference, queryContext, args) as Promise<never>,
            scheduler: stubProxy("scheduler") as MutationCtx["scheduler"],
            storage: stubProxy("storage") as MutationCtx["storage"],
            vectors: stubProxy("vectors") as MutationCtx["vectors"],
        };

        const actionContext: ActionCtx = {
            auth,
            db: database,
            fetch: stubProxy("fetch") as ActionCtx["fetch"],
            log: noopLog,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runAction, after construction completes
            runAction: (reference, args) => runInternal("action", reference, actionContext, args) as Promise<never>,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runMutation, after construction completes
            runMutation: (reference, args) => runInternal("mutation", reference, mutationContext, args) as Promise<never>,
            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- lazy closure: `runInternal` is invoked only when a handler calls ctx.runQuery, after construction completes
            runQuery: (reference, args) => runInternal("query", reference, queryContext, args) as Promise<never>,
            scheduler: stubProxy("scheduler") as ActionCtx["scheduler"],
            storage: stubProxy("storage") as ActionCtx["storage"],
            vectors: stubProxy("vectors") as ActionCtx["vectors"],
        };

        const runRegistered = (
            expected: "action" | "mutation" | "query",
            reference: { handler: (context: unknown, args: never) => unknown },
            context: unknown,
            args: unknown,
            allowInternal: boolean,
        ): Promise<unknown> => {
            const kind = registeredFunctionKind(reference);

            if (kind !== expected) {
                throw new Error(`expected a registered ${expected}, received a ${kind ?? "non-function"} reference`);
            }

            if (!allowInternal && registeredFunctionVisibility(reference) === "internal") {
                throw new Error(
                    `"${expected}" is an internal function — it is unreachable from the external RPC boundary in production. ` +
                        `Call it through ctx.run${expected.charAt(0).toUpperCase()}${expected.slice(1)} from another function instead.`,
                );
            }

            return Promise.resolve(reference.handler(context, (args ?? {}) as never));
        };

        // Internal (server-to-server) dispatch surface used by ctx.run*. Mirrors
        // prod's `isSystemDispatch()` branch: internal functions are reachable here.
        const runInternal = (
            expected: "action" | "mutation" | "query",
            reference: unknown,
            context: unknown,
            args: unknown,
        ): Promise<unknown> => runRegistered(expected, reference as never, context, args, true);

        const query = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
            if (registeredFunctionKind(referenceOrInline)) {
                return runRegistered("query", referenceOrInline as never, queryContext, args, false);
            }

            return Promise.resolve((referenceOrInline as InlineQueryFunction<unknown>)(queryContext));
        }) as TestHarness["query"];

        const mutation = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
            if (registeredFunctionKind(referenceOrInline)) {
                return runRegistered("mutation", referenceOrInline as never, mutationContext, args, false);
            }

            return Promise.resolve((referenceOrInline as InlineMutationFunction<unknown>)(mutationContext));
        }) as TestHarness["mutation"];

        const action = ((referenceOrInline: unknown, args?: unknown): Promise<unknown> => {
            if (registeredFunctionKind(referenceOrInline)) {
                return runRegistered("action", referenceOrInline as never, actionContext, args, false);
            }

            return Promise.resolve((referenceOrInline as InlineActionFunction<unknown>)(actionContext));
        }) as TestHarness["action"];

        const harness: TestHarness = {
            action,
            close: closeDatabase,
            mutation,
            query,
            run: (function_) => Promise.resolve(function_(mutationContext)),
            // A scoped view shares the SAME sql/db handle (created once above), so
            // writes performed under an identity persist for every accessor.
            withIdentity: (next) => makeHarness(next),
        };

        return harness;
    };

    // eslint-disable-next-line unicorn/no-null -- a fresh harness has no identity; `null` is AuthState's anonymous sentinel
    return makeHarness(null);
};

export { cirrusTest };
export type { TestHarness, TestIdentity };
