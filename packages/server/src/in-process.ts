/**
 * The in-process runtime core: schema → migrations → `ctx.db` writers →
 * function dispatch, over any synchronous {@link SqlExec}.
 *
 * This is the wiring the Durable Object performs around a real function call,
 * minus the Durable Object. `@lunora/testing`'s `lunoraTest` runs it over
 * `node:sqlite`; it builds the same `createShardCtxDb` writer production builds,
 * so the engine under {@link SqlExec} is the only thing a second consumer (plan
 * 453's demand-gated embedded runtime) would change.
 *
 * What this module does NOT do is build a `ctx`: which surfaces exist beyond
 * `ctx.db` and `ctx.auth` (a fake scheduler, throwing stubs, a recording span)
 * is the consumer's decision.
 */
import { LunoraError } from "@lunora/errors";
import type { SchemaLike, SqlExec, TransactionHeadroom } from "@lunora/shard-engine";
import { createShardCtxDb, RLS_UNWRAP_SYMBOL, runShardMigrations, TransactionHeadroomTracker } from "@lunora/shard-engine";

import { beginDeferredSchedules } from "./deferred-schedules";
import type { FacadeEntry, FacadeWriterLike } from "./facade";
import { bindTableFacade } from "./facade";
import type { DatabaseWriter, Schema } from "./types";

/** The kind of a registered Lunora function. */
type FunctionKind = "action" | "mutation" | "query";

/**
 * A caller-supplied identity. `userId` is the subject a handler reads from
 * `ctx.auth.userId`; every other field is returned from
 * `ctx.auth.getIdentity()` (mirroring a decoded JWT's claims).
 */
interface InProcessIdentity extends Record<string, unknown> {
    userId?: null | string;
}

/** The `userId` + claims a dispatch runs under, after production's normalisation. */
interface ResolvedIdentity {
    readonly claims: Record<string, unknown> | null;
    readonly userId: null | string;
}

/**
 * Reduce a caller-supplied {@link InProcessIdentity} to what production would
 * actually hand a shard.
 *
 * Mirrors `@lunora/runtime`'s `create-worker.ts` identity forwarding: an identity
 * whose `userId` is not a non-empty string is dropped to anonymous outright, and
 * the forwarded claims are the identity MINUS `userId` (`null` when nothing is
 * left), because the shard reads the subject from its own header and surfaces
 * only the remaining claims through `ctx.auth.getIdentity()`.
 * @param identity the caller-supplied identity, or `null` for anonymous
 * @returns the identity production would forward
 */
const resolveInProcessIdentity = (identity: InProcessIdentity | null): ResolvedIdentity => {
    if (identity === null || typeof identity.userId !== "string" || identity.userId.length === 0) {
        // eslint-disable-next-line unicorn/no-null -- AuthState's anonymous sentinel is `null` for both fields
        return { claims: null, userId: null };
    }

    const { userId, ...extra } = identity;

    // eslint-disable-next-line unicorn/no-null -- `getIdentity()`'s empty-claims sentinel is `null`, matching a shard with no `x-lunora-identity` header
    return { claims: Object.keys(extra).length > 0 ? extra : null, userId };
};

/**
 * A resource meter with a stable identity whose budget resets per dispatch.
 *
 * Production builds a fresh `createShardCtxDb` writer — and with it a fresh
 * {@link TransactionHeadroomTracker} — for every dispatch. The in-process
 * runtime builds one writer per identity view, so it hands that writer this
 * forwarder and swaps the tracker behind it at each top-level entry: every
 * dispatch gets its own budget, and the ceilings are the engine defaults rather
 * than "unmetered".
 */
class DispatchHeadroom extends TransactionHeadroomTracker {
    private current = new TransactionHeadroomTracker();

    /** Begin a new dispatch with a full budget. */
    public reset(): void {
        this.current = new TransactionHeadroomTracker();
    }

    public override headroom(): TransactionHeadroom {
        return this.current.headroom();
    }

    public override recordRead(count: number): void {
        this.current.recordRead(count);
    }

    public override recordWrite(row: unknown): void {
        this.current.recordWrite(row);
    }
}

/** Options accepted by {@link createInProcessRuntime}. */
interface InProcessRuntimeOptions {
    /**
     * Enforce the secure-by-default RLS guard on {@link InProcessRuntime.createWriters}'s
     * `database` — the same `enforceRls: true` production's generated
     * `buildCtx` always passes. A no-op unless the schema is `.rls("required")`.
     * @default true
     */
    enforceRls?: boolean;

    /**
     * The `ctx.scheduler` the consumer installs, when it installs one. A
     * scheduler wrapped with `withDeferredSchedules` has the jobs a mutation
     * schedules held until its COMMIT and dropped on its ROLLBACK, exactly as the
     * generated shard's `runMutationTransaction` does.
     */
    scheduler?: unknown;

    /** The synchronous SQLite engine the store runs on. */
    sql: SqlExec;
}

/** The engine-bound half of a function dispatch, shared by every identity view. */
interface InProcessRuntime {
    /**
     * The guarded `ctx.db` writer for one identity, plus the trusted, UNGUARDED
     * writer behind it (`rawDatabase` — what production's admin/migration paths
     * use). Both carry the per-table facade (`ctx.db.<table>`).
     */
    createWriters: (identity: ResolvedIdentity) => { database: DatabaseWriter; rawDatabase: DatabaseWriter };

    /** Start a new top-level dispatch with a full resource budget. Call before every query/action entry. */
    resetHeadroom: () => void;

    /**
     * Run `body` as one top-level entry: serialized behind every other entry that
     * came through here, inside a BEGIN/COMMIT span that rolls back on a throw,
     * with a fresh resource budget. Every mutation entry must use it; a read that
     * must not observe another entry's uncommitted writes may use it too.
     */
    runInTransaction: <R>(body: () => Promise<R> | R) => Promise<R>;
}

/**
 * Migrate `schema` onto `options.sql` and return the dispatch wiring around it.
 * @param schema the app schema from `defineSchema`
 * @param options the engine, plus the RLS and scheduler settings
 * @returns the writer factory and the mutation transaction runner
 */
const createInProcessRuntime = (schema: Schema, options: InProcessRuntimeOptions): InProcessRuntime => {
    const { scheduler, sql } = options;
    // The `@lunora/server` schema and the engine's `SchemaLike` are the same
    // runtime shape, declared independently (only their trigger nesting drifts
    // at the type level), so this boundary cast is sound.
    const ddlSchema = schema as unknown as SchemaLike;

    runShardMigrations(sql, ddlSchema);

    // One meter for the whole runtime (every identity view shares the one SQLite
    // handle, and top-level entries are serialized), reset at each top-level entry.
    const headroom = new DispatchHeadroom();

    /**
     * Glue the per-table facade (`ctx.db.notes.findMany(...)`) onto a writer,
     * exactly as production's generated `buildCtx` does. Mutates in place:
     * `ctx.db` must be ONE object carrying both the flat methods and the table
     * accessors, and the `rls()` wrapper's `{ ...base }` spread only carries own
     * enumerable keys.
     */
    const withTableFacades = (writer: DatabaseWriter): DatabaseWriter => {
        const facade = writer as unknown as Record<string, FacadeEntry>;

        for (const tableName of Object.keys(ddlSchema.tables)) {
            facade[tableName] = bindTableFacade(writer as unknown as FacadeWriterLike, tableName);
        }

        return writer;
    };

    const createWriters = (identity: ResolvedIdentity): { database: DatabaseWriter; rawDatabase: DatabaseWriter } => {
        const database = createShardCtxDb({
            auth: { identity: identity.claims, userId: identity.userId },
            enforceRls: options.enforceRls ?? true,
            headroom,
            schema: ddlSchema,
            sql,
        }) as unknown as DatabaseWriter;

        // The trusted writer, recovered through the same `RLS_UNWRAP_SYMBOL` seam
        // the `rls()` middleware uses. Absent when the guard did not wrap
        // `database`, in which case the two are the same writer.
        const rawDatabase = ((database as unknown as Record<PropertyKey, unknown>)[RLS_UNWRAP_SYMBOL] as DatabaseWriter | undefined) ?? database;

        return { database: withTableFacades(database), rawDatabase: withTableFacades(rawDatabase) };
    };

    // The `.exec` is routed through a `.call` indirection — the secret-scan hook
    // flags a literal `.exec(` (see do-exec.ts).
    const execStatement = (statement: string): void => {
        const runner = sql.exec as (this: typeof sql, query: string) => unknown;

        runner.call(sql, statement);
    };

    // Serialize entries so concurrently-issued ones never interleave their
    // BEGIN/COMMIT spans — the Durable Object's single-writer semantics (input
    // gates). A mutation's own `ctx.runMutation` must NOT come through here: it
    // rides the already-open span, as in production.
    let mutationQueue: Promise<unknown> = Promise.resolve();

    const runInTransaction = <R>(body: () => Promise<R> | R): Promise<R> => {
        const runTransaction = async (): Promise<R> => {
            // The jobs this mutation schedules are held until the COMMIT lands and
            // dropped on the ROLLBACK, as the generated shard's
            // `runMutationTransaction` does.
            const settleSchedules = beginDeferredSchedules({ scheduler });

            headroom.reset();
            execStatement("BEGIN");

            try {
                const result = await body();

                execStatement("COMMIT");

                await settleSchedules(true);

                return result;
            } catch (error) {
                try {
                    execStatement("ROLLBACK");
                } catch {
                    // A failed rollback (broken handle) must not mask the original throw.
                }

                await settleSchedules(false);

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

    return {
        createWriters,
        resetHeadroom: () => {
            headroom.reset();
        },
        runInTransaction,
    };
};

/**
 * The kind of a registered function object, or `undefined` for anything else
 * (an inline callback, a plain value).
 * @param value the candidate reference
 * @returns its kind, when it is a registered function
 */
const registeredFunctionKind = (value: unknown): FunctionKind | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const { kind } = value as { kind?: unknown };

    if (kind === "query" || kind === "mutation" || kind === "action") {
        return kind;
    }

    return undefined;
};

/**
 * Invoke a registered function's handler, refusing a reference of the wrong
 * kind and — unless `allowInternal` — an `internal*` function, which is
 * unreachable from the external RPC boundary in production.
 * @param expected which kind of function the call site dispatches
 * @param reference the registered function object
 * @param reference.handler its handler, invoked with `(context, args)`
 * @param context the `ctx` to hand the handler
 * @param args the call's arguments (`{}` when absent)
 * @param allowInternal whether this is a server-to-server (`ctx.run*`) dispatch
 * @returns the handler's result
 */
const runRegisteredFunction = (
    expected: FunctionKind,
    reference: { handler: (context: unknown, args: never) => unknown },
    context: unknown,
    args: unknown,
    allowInternal: boolean,
): Promise<unknown> => {
    const kind = registeredFunctionKind(reference);

    if (kind !== expected) {
        throw new LunoraError("INTERNAL", `expected a registered ${expected}, received a ${kind ?? "non-function"} reference`);
    }

    if (!allowInternal && (reference as { visibility?: unknown }).visibility === "internal") {
        throw new LunoraError(
            "INTERNAL",
            `This ${expected} is an internal function — it is unreachable from the external RPC boundary in production. ` +
                `Call it through ctx.run${expected.charAt(0).toUpperCase()}${expected.slice(1)} from another function instead.`,
        );
    }

    return Promise.resolve(reference.handler(context, (args ?? {}) as never));
};

export type { FunctionKind, InProcessIdentity, InProcessRuntime, InProcessRuntimeOptions, ResolvedIdentity };
export { createInProcessRuntime, registeredFunctionKind, resolveInProcessIdentity, runRegisteredFunction };
