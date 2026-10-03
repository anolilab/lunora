/**
 * Automatic instrumentation for `ctx.db` and the action-only `ctx.sql`
 * (Hyperdrive, `@lunora/hyperdrive`).
 *
 * Database work is the single largest unexplained gap in a typical trace: a
 * handler that spends 300ms in SQLite shows one opaque bar, because the only way
 * to see inside was to hand-wrap every call in `ctx.trace`. Nobody does that, so
 * in practice the most common cause of slowness is the least instrumented thing
 * in the system.
 *
 * **Why this is tiered rather than "always emit a span".** The obvious fix —
 * one span per database call — is right for a handler that makes five calls and
 * actively harmful for one that makes five hundred: the trace becomes unreadable,
 * the span buffer evicts the traces you actually wanted, and the export grows
 * without bound. So the DEFAULT is `"summary"`: no new spans, no new log
 * records, just a handful of aggregate attributes folded onto the wide event the
 * dispatch already emits (`db.calls`, `db.duration_ms`, and a per-operation
 * count). That answers "was this request database-bound, and doing what?" at
 * flat cost, however many calls it made. `"spans"` opts into the full waterfall
 * when you are actually chasing a specific slow query.
 *
 * **`ctx.sql` shares all of it but the tally.** Same three levels, same knob,
 * same span cap and the same best-effort settle ({@link observeCall}) — but its
 * own tally, folded as `sql.*` keys rather than merged into `db.*`. The two are
 * different cost classes: a `ctx.db` call is a local SQLite read inside the
 * Durable Object, a `ctx.sql` call is a network round trip to an external
 * Postgres/MySQL. Summing them into one `db.duration_ms` would hide exactly what
 * the summary exists to say — which of the two the request was bound on.
 */
import type { LogFields } from "../../../shared/log-fields";
import { otlpRandomHex } from "../../../shared/otlp";
import type { SpanEvent } from "../../../shared/span-event";
import type { TraceAnchor } from "./context-telemetry";
import { redactArgs } from "./request-log";
import { sqlOperationName, sqlSystemOf } from "./sql-operation";
import { toErrorType } from "./trace-context";

/**
 * Ceiling on spans emitted per ctx in `"spans"` mode. A handler that queries in
 * a loop would otherwise bury its own trace under thousands of near-identical
 * bars and evict every other trace from the bounded buffer. Past the cap the
 * calls still run and still count toward the summary tally — only their
 * individual spans are dropped, and `db.spans_truncated` (`sql.spans_truncated`
 * for `ctx.sql`) says so rather than leaving a silently partial waterfall.
 *
 * Counted per tally, so `ctx.db` and `ctx.sql` each get the full allowance — a
 * loop over one surface cannot starve the other's waterfall.
 */
const MAX_CLIENT_SPANS_PER_TALLY = 100;

/**
 * The `DatabaseWriterLike` methods worth instrumenting: the ones that reach
 * storage. Deliberately an allowlist rather than "wrap every function", because
 * the surface also carries synchronous helpers (`normalizeId`) and builder
 * factories (`query`, which returns a chainable reader and does no I/O itself) —
 * wrapping those would produce zero-duration spans that measure nothing and a
 * broken builder chain.
 */
const INSTRUMENTED_METHODS = new Set([
    "aggregate",
    "count",
    "delete",
    "deleteMany",
    "deleteWhere",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "get",
    "groupBy",
    "insert",
    "insertMany",
    "insertManyUnsafe",
    "lookupById",
    "patch",
    "patchMany",
    "patchWhere",
    "rank",
    "rankBefore",
    "rankPage",
    "rankPageRows",
    // Not in `TABLE_FIRST_METHODS`: a traversal's first argument is its start
    // node, and the tables it visits are discovered as it walks — so the span
    // carries no table name rather than a misleading one.
    "related",
    "replace",
    "restore",
]);

/**
 * Methods whose FIRST argument is the table name. Used only to give a span a
 * low-cardinality name (`db.findMany messages`); the id-first methods
 * (`get`/`patch`/`delete`) deliberately do NOT put the id in the name, because a
 * span name containing a row id makes every call its own group in a collector
 * and destroys the aggregate views the span exists to feed.
 *
 * Local on purpose, and NOT `@lunora/shard-engine`'s `LOOP_GATED_METHODS`: that
 * one records how the RLS guard wraps a method, so it omits `deleteWhere` and
 * `patchWhere` (gated inline instead) and includes `deleteAll`/`query`, which
 * take a table name but produce no span here. This set answers a pure arity
 * question — "is `arguments[0]` the table name?" — and the two memberships
 * differ. They were once the same identifier in two packages.
 */
const TABLE_FIRST_METHODS = new Set([
    "aggregate",
    "count",
    "deleteWhere",
    "findFirst",
    "findFirstOrThrow",
    "findMany",
    "groupBy",
    "insert",
    "insertMany",
    "insertManyUnsafe",
    "patchWhere",
    "rank",
    "rankBefore",
    "rankPage",
    "rankPageRows",
]);

/** Table name from a call's arguments, when the method takes it first. */
const tableOf = (method: string, arguments_: unknown[]): string | undefined => {
    if (!TABLE_FIRST_METHODS.has(method)) {
        return undefined;
    }

    const first = arguments_[0];

    return typeof first === "string" && first.length > 0 ? first : undefined;
};

/** Render a thrown value for a span's `error.message` without relying on `Object`'s default stringification. */
const describeFailure = (failure: unknown): string => {
    if (failure instanceof Error) {
        return failure.message;
    }

    if (typeof failure === "string") {
        return failure;
    }

    // `JSON.stringify` is typed `=> string` but returns `undefined` for a
    // function/symbol/undefined value — fall back to `String`, mirroring
    // `request-log.ts`'s `renderLogMessage`.
    const json = JSON.stringify(failure) as string | undefined;

    return json ?? String(failure);
};

/** Running totals for `"summary"` mode; created by the caller, read once at the dispatch boundary. */
interface DatabaseTally {
    calls: number;
    durationMs: number;
    errors: number;
    perOperation: Record<string, number>;
    spansEmitted: number;
    spansTruncated: boolean;
}

/**
 * Which instrumented surface a tally belongs to, and the key prefix
 * {@link formatTally} folds it under: `db` for `ctx.db`, `sql` for `ctx.sql`.
 */
type TallySurface = "db" | "sql";

/**
 * How much detail `ctx.db` / `ctx.sql` auto-instrumentation produces.
 *
 * `"summary"` (default) — aggregate counters on the dispatch's wide event: no
 * extra spans, no extra log records, and a cost that does not grow with call count.
 *
 * `"spans"` — one span per database call. The full waterfall, at the price of a
 * span per call; right when diagnosing, noisy as a permanent default.
 *
 * `"off"` — no database telemetry at all.
 */
type DatabaseInstrumentation = "off" | "spans" | "summary";

/**
 * The structural slice of `@lunora/hyperdrive`'s `SqlClient` the `ctx.sql`
 * instrumenter needs — declared here so this package takes no dependency on
 * hyperdrive.
 */
interface SqlClientLike {
    /** OTel `db.system.name` the driver adapter stamped; `other_sql` when absent. */
    readonly dbSystem?: string;
    query: (text: string, params?: ReadonlyArray<unknown>) => Promise<unknown>;
}

/** What {@link instrumentDatabase} / {@link instrumentSqlClient} need to record what they observe. */
interface DatabaseTelemetryDeps {
    /** The trace produced spans belong to (`"spans"` mode only). */
    anchor: TraceAnchor;

    /**
     * Whether to record a failed call's error message verbatim (`"spans"` mode
     * only) — the same dev-only escape hatch as `TracerDeps.captureRaw`. See
     * {@link failureMessage} for what each surface records without it.
     */
    captureRaw?: boolean;

    /** Function path spans and attributes are attributed to. */
    functionPath: string;
    /** Detail level; see {@link DatabaseInstrumentation}. */
    mode: DatabaseInstrumentation;
    /** Hand a finished span to the buffer + sink (`"spans"` mode only). */
    record: (span: SpanEvent) => void;

    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey: string | undefined;

    /**
     * Caller-supplied accumulator for `"summary"` mode. The instrumenter only ever
     * increments numbers on it; the shard reads it ONCE at the dispatch boundary
     * and formats it with {@link formatTally}.
     *
     * Per-call cost stays at a few integer increments — no object allocation, no
     * lookup — which matters because this is on the path of every query. Nothing
     * is written through the dispatch's `SpanHandle` either, so the wide-event
     * collector is never materialized by instrumentation alone: a dispatch that
     * ran queries gets a root span carrying these counters, but no `lunora.dispatch`
     * log record unless the handler actually opened `ctx.span`.
     */
    tally: DatabaseTally;

    /**
     * The acting user, read when a span is built. Callers resolve it ONCE, when
     * they instrument the client, and return that captured value: a span is
     * built after the call's await, and per-request shared state read by then
     * may already belong to a concurrent request.
     */
    userId: () => string | undefined;
}

/** How one observed call ended — what a span builder needs beyond its own operation. */
interface CallOutcome {
    durationMs: number;
    failure: unknown;
    result: unknown;
    startTs: number;
}

/**
 * The two error-message policies, side by side.
 *
 * `"redact"` (`ctx.db`): the message, PII-redacted unless `captureRaw` — the
 * request log's posture. A constraint-error message quotes the conflicting
 * row, but Lunora owns the store, so a redaction pass is trustworthy enough.
 *
 * `"type-only"` (`ctx.sql`): the error TYPE, unless `captureRaw` keeps the
 * driver's message verbatim. An external database's error text routinely
 * quotes the offending row (Postgres's `Key (email)=(…) already exists`) —
 * data Lunora never owned and a PII pattern will not reliably catch.
 */
const failureMessage = (failure: unknown, deps: DatabaseTelemetryDeps, policy: "redact" | "type-only"): string => {
    if (policy === "redact") {
        return redactArgs(describeFailure(failure), deps.captureRaw) as string;
    }

    return deps.captureRaw === true ? describeFailure(failure) : toErrorType(failure);
};

/**
 * The fields every auto-instrumented span shares, whichever surface made the
 * call.
 *
 * CLIENT: from the handler's point of view the call goes OUT to a datastore,
 * which is what lets a collector render it as a dependency rather than as
 * internal computation.
 */
const clientSpanBase = (
    deps: DatabaseTelemetryDeps,
    outcome: CallOutcome,
    policy: "redact" | "type-only",
): Pick<
    SpanEvent,
    "durationMs" | "error" | "functionPath" | "kind" | "ok" | "parentSpanId" | "rayId" | "shardKey" | "spanId" | "startTs" | "traceId" | "userId"
> => {
    const { durationMs, failure, startTs } = outcome;

    return {
        durationMs,
        ...(failure === undefined ? {} : { error: { message: failureMessage(failure, deps, policy), type: toErrorType(failure) } }),
        functionPath: deps.functionPath,
        kind: "client",
        ok: failure === undefined,
        parentSpanId: deps.anchor.rootSpanId,
        ...(deps.anchor.rayId === undefined ? {} : { rayId: deps.anchor.rayId }),
        shardKey: deps.shardKey,
        spanId: otlpRandomHex(8),
        startTs,
        traceId: deps.anchor.traceId,
        userId: deps.userId(),
    };
};

/**
 * Run one storage call under telemetry: time it, re-throw its failure
 * untouched, then bump the tally and — in `"spans"` mode and under
 * {@link MAX_CLIENT_SPANS_PER_TALLY} — record its span.
 *
 * The ONE place that enforces "telemetry never changes the outcome": the
 * caller gets exactly the value or the error `run` produced, and nothing the
 * accounting does after the call settled can turn a succeeded query into a
 * failed one or replace the real error with a telemetry one. `buildSpan` is a
 * callback so `"summary"` mode never allocates a span it would discard.
 */
const observeCall = async (
    deps: DatabaseTelemetryDeps,
    operation: string,
    run: () => unknown,
    buildSpan: (outcome: CallOutcome) => SpanEvent,
): Promise<unknown> => {
    const startTs = Date.now();
    let failure: unknown;
    let result: unknown;

    try {
        result = await run();

        return result;
    } catch (error) {
        failure = error;

        // Re-thrown untouched: this is instrumentation, never flow control.
        throw error;
    } finally {
        const durationMs = Date.now() - startTs;
        const { tally } = deps;

        tally.calls += 1;
        tally.durationMs += durationMs;
        tally.perOperation[operation] = (tally.perOperation[operation] ?? 0) + 1;

        if (failure !== undefined) {
            tally.errors += 1;
        }

        // Guarded as a whole — see the note above.
        try {
            if (deps.mode === "spans") {
                if (tally.spansEmitted >= MAX_CLIENT_SPANS_PER_TALLY) {
                    tally.spansTruncated = true;
                } else {
                    tally.spansEmitted += 1;

                    deps.record(buildSpan({ durationMs, failure, result, startTs }));
                }
            }
        } catch {
            // Best-effort throughout.
        }
    }
};

type AnyMethod = (...arguments_: unknown[]) => unknown;

/**
 * A view of `source` whose methods passing `shouldWrap` are replaced by
 * `wrap(name, original)`; every other member passes through.
 *
 * Proxies a throwaway target rather than `source`, and reads every member with
 * `source` as the receiver.
 *
 * A `get` trap on a frozen `source` (or any non-configurable, non-writable
 * method) may not return a different value — the Proxy invariant would make
 * every wrapped call throw a `TypeError`. The throwaway target has no such
 * properties to violate.
 *
 * A class-based client's `#private` accessors and methods need `this` to be
 * the real instance, never a proxy of it. `original` is bound to `source` for
 * the same reason.
 *
 * The prototype, `in`, and own-key enumeration are forwarded, so `instanceof`,
 * spread and `Object.keys` still see the real object. Wrapped methods are
 * memoized, so repeated access returns a stable function identity.
 */
const instrumentMethods = <T extends object>(source: T, shouldWrap: (name: string) => boolean, wrap: (name: string, original: AnyMethod) => AnyMethod): T => {
    const wrapped = new Map<string, AnyMethod>();

    return new Proxy({} as T, {
        get(_target, property) {
            const value = Reflect.get(source, property, source) as unknown;

            if (typeof property !== "string" || typeof value !== "function" || !shouldWrap(property)) {
                return value;
            }

            let instrumented = wrapped.get(property);

            if (instrumented === undefined) {
                instrumented = wrap(property, (value as AnyMethod).bind(source));
                wrapped.set(property, instrumented);
            }

            return instrumented;
        },
        getOwnPropertyDescriptor(_target, property) {
            const descriptor = Reflect.getOwnPropertyDescriptor(source, property);

            // Reported configurable: the throwaway target lacks the property, and
            // the invariant forbids reporting a missing one as non-configurable.
            return descriptor === undefined ? undefined : { ...descriptor, configurable: true };
        },
        getPrototypeOf() {
            return Reflect.getPrototypeOf(source);
        },
        has(_target, property) {
            return Reflect.has(source, property);
        },
        ownKeys() {
            return Reflect.ownKeys(source);
        },
    });
};

/**
 * Wrap a `ctx.db` writer so its storage-touching methods are instrumented.
 *
 * Returns the database unchanged when `mode` is `"off"`, so the default-disabled
 * path costs nothing — not even a proxy indirection.
 *
 * A proxy rather than an enumerated, rebound copy: `DatabaseWriterLike` has
 * optional members that a given backend may or may not implement, plus
 * properties (`system`) and builder factories (`query`) that must pass through
 * untouched. A proxy instruments exactly what it is asked to and is
 * transparently correct for everything else, including members added later —
 * an enumeration would silently stop covering them.
 */
const instrumentDatabase = <T extends object>(database: T, deps: DatabaseTelemetryDeps): T => {
    if (deps.mode === "off") {
        return database;
    }

    return instrumentMethods(
        database,
        (name) => INSTRUMENTED_METHODS.has(name),
        (operation, original) =>
            async (...arguments_: unknown[]) => {
                const table = tableOf(operation, arguments_);

                return observeCall(
                    deps,
                    operation,
                    () => original(...arguments_),
                    (outcome) => {
                        return {
                            ...clientSpanBase(deps, outcome, "redact"),
                            attributes: {
                                "db.operation.name": operation,
                                ...(table === undefined ? {} : { "db.collection.name": table }),
                                "db.system.name": "sqlite",
                            },
                            name: table === undefined ? `db.${operation}` : `db.${operation} ${table}`,
                        };
                    },
                );
            },
    );
};

/**
 * Wrap the action-only `ctx.sql` client so every `query` is instrumented — the
 * `ctx.sql` twin of {@link instrumentDatabase}, at the same levels and through
 * the same {@link observeCall}. `deps.tally` must be a tally of its own (folded
 * as `sql.*`), never `ctx.db`'s.
 *
 * Its span carries no statement text and no parameters — only the
 * leading-keyword operation, the system, and the returned row count. No
 * `db.collection.name` either: naming the table means parsing past
 * `FROM`/`INTO` through joins, CTEs and quoting, which is neither cheap nor
 * safe. A failure records its TYPE (see {@link failureMessage}).
 *
 * `query` is the whole `SqlClient` surface: there is no transaction or batch
 * method to cover. Everything else on the client passes through untouched, and
 * `"off"` returns the client itself.
 */
const instrumentSqlClient = <T extends SqlClientLike>(client: T, deps: DatabaseTelemetryDeps): T => {
    if (deps.mode === "off") {
        return client;
    }

    const system = sqlSystemOf(client.dbSystem);

    return instrumentMethods(
        client,
        (name) => name === "query",
        (_name, original) =>
            async (...arguments_: unknown[]) => {
                const operation = sqlOperationName(arguments_[0]);

                return observeCall(
                    deps,
                    operation,
                    () => original(...arguments_),
                    (outcome) => {
                        return {
                            ...clientSpanBase(deps, outcome, "type-only"),
                            attributes: {
                                "db.operation.name": operation,
                                ...(Array.isArray(outcome.result) ? { "db.response.returned_rows": outcome.result.length } : {}),
                                "db.system.name": system,
                            },
                            name: `sql.${operation}`,
                        };
                    },
                );
            },
    );
};

/** A zero'd tally for one dispatch. */
const createDatabaseTally = (): DatabaseTally => {
    return { calls: 0, durationMs: 0, errors: 0, perOperation: {}, spansEmitted: 0, spansTruncated: false };
};

/**
 * Render the running tally as span attributes, under its surface's prefix
 * ({@link TallySurface}).
 *
 * Called ONCE per dispatch, from the shard's root-span recorder — not per query.
 * It is a handful of keys, so the per-call cost is a small object assignment —
 * the property that makes `"summary"` mode scale to any call count.
 */
const formatTally = (tally: DatabaseTally, surface: TallySurface = "db"): LogFields => {
    const fields: LogFields = {
        [`${surface}.calls`]: tally.calls,
        [`${surface}.duration_ms`]: tally.durationMs,
    };

    if (tally.errors > 0) {
        fields[`${surface}.errors`] = tally.errors;
    }

    if (tally.spansTruncated) {
        fields[`${surface}.spans_truncated`] = true;
    }

    for (const [operation, count] of Object.entries(tally.perOperation)) {
        fields[`${surface}.op.${operation}`] = count;
    }

    return fields;
};

export type { DatabaseInstrumentation, DatabaseTally, DatabaseTelemetryDeps, SqlClientLike, TallySurface };
export { createDatabaseTally, formatTally, instrumentDatabase, instrumentSqlClient };
