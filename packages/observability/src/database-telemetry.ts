/**
 * Automatic instrumentation for `ctx.db`.
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
 */
import type { LogFields } from "../../../shared/log-fields";
import { otlpRandomHex } from "../../../shared/otlp";
import type { SpanEvent } from "../../../shared/span-event";
import type { TraceAnchor } from "./context-telemetry";
import { redactArgs } from "./request-log";
import { toErrorType } from "./trace-context";

/**
 * Ceiling on spans emitted per ctx in `"spans"` mode. A handler that queries in
 * a loop would otherwise bury its own trace under thousands of near-identical
 * bars and evict every other trace from the bounded buffer. Past the cap the
 * calls still run and still count toward the summary tally — only their
 * individual spans are dropped, and `db.spans_truncated` says so rather than
 * leaving a silently partial waterfall.
 */
const MAX_DB_SPANS_PER_CTX = 100;

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

/**
 * Build the CLIENT span for one instrumented database call.
 *
 * Extracted from the proxy trap so that trap stays a readable dispatch — the
 * span's shape is a data-mapping concern, not control flow.
 */
const buildDatabaseSpan = (input: {
    deps: DatabaseTelemetryDeps;
    durationMs: number;
    failure: unknown;
    operation: string;
    startTs: number;
    table: string | undefined;
}): SpanEvent => {
    const { deps, durationMs, failure, operation, startTs, table } = input;

    return {
        attributes: {
            "db.operation.name": operation,
            ...(table === undefined ? {} : { "db.collection.name": table }),
            "db.system.name": "sqlite",
        },
        durationMs,
        ...(failure === undefined ? {} : { error: { message: redactArgs(describeFailure(failure), deps.captureRaw) as string, type: toErrorType(failure) } }),
        functionPath: deps.functionPath,
        // CLIENT: from the handler's point of view this is a call OUT to a
        // datastore, which is what lets a collector render it as a dependency
        // rather than as internal computation.
        kind: "client",
        name: table === undefined ? `db.${operation}` : `db.${operation} ${table}`,
        ok: failure === undefined,
        parentSpanId: deps.anchor.rootSpanId,
        shardKey: deps.shardKey,
        spanId: otlpRandomHex(8),
        startTs,
        traceId: deps.anchor.traceId,
        userId: deps.userId(),
    };
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
 * How much detail `ctx.db` auto-instrumentation produces.
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

/** What {@link instrumentDatabase} needs to record what it observes. */
interface DatabaseTelemetryDeps {
    /** The trace produced spans belong to (`"spans"` mode only). */
    anchor: TraceAnchor;

    /**
     * Whether to record a failed call's error message verbatim rather than
     * redacted (`"spans"` mode only) — the same dev-only escape hatch as
     * `TracerDeps.captureRaw`. A constraint-error message quotes the
     * conflicting row, so this CLIENT span gets the same default-redacted
     * posture as the request log and function-metrics sinks.
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
     * Two properties fall out of that split. Per-call cost stays at a few integer
     * increments — no object allocation, no lookup — which matters because this is
     * on the path of every query. And because nothing is written through the
     * dispatch's `SpanHandle`, the wide-event collector is never materialized, so
     * a handler that instrumented nothing still doesn't trip the root-span gate.
     */
    tally: DatabaseTally;

    /** Read lazily — the acting user is resolved per span. */
    userId: () => string | undefined;
}

/**
 * Wrap a `ctx.db` writer so its storage-touching methods are instrumented.
 *
 * Returns the database unchanged when `mode` is `"off"`, so the default-disabled
 * path costs nothing — not even a proxy indirection.
 *
 * Implemented as a `Proxy` rather than by enumerating and rebinding methods:
 * `DatabaseWriterLike` has optional members that a given backend may or may not
 * implement, plus properties (`system`) and builder factories (`query`) that
 * must pass through untouched. A proxy instruments exactly what it is asked to
 * and is transparently correct for everything else, including members added
 * later — an enumeration would silently stop covering them.
 */
const instrumentDatabase = <T extends object>(database: T, deps: DatabaseTelemetryDeps): T => {
    if (deps.mode === "off") {
        return database;
    }

    const { tally } = deps;

    /** Wrapped methods are memoized so repeated property access returns a stable function identity. */
    const wrapped = new Map<string, unknown>();

    return new Proxy(database, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;

            if (typeof property !== "string" || typeof value !== "function" || !INSTRUMENTED_METHODS.has(property)) {
                return value;
            }

            const cached = wrapped.get(property);

            if (cached !== undefined) {
                return cached;
            }

            const original = value as (...arguments_: unknown[]) => unknown;

            const instrumented = async (...arguments_: unknown[]): Promise<unknown> => {
                const startTs = Date.now();
                const table = tableOf(property, arguments_);
                let failure: unknown;

                try {
                    return await original.apply(target, arguments_);
                } catch (error) {
                    failure = error;

                    // Re-thrown untouched: this is instrumentation, never flow control.
                    throw error;
                } finally {
                    const durationMs = Date.now() - startTs;

                    tally.calls += 1;
                    tally.durationMs += durationMs;
                    tally.perOperation[property] = (tally.perOperation[property] ?? 0) + 1;

                    if (failure !== undefined) {
                        tally.errors += 1;
                    }

                    // Guarded as a whole: telemetry runs after the call already
                    // settled, so letting it throw would turn a succeeded query
                    // into a failed one — and replace the real error with a
                    // telemetry one on the failure path.
                    try {
                        if (deps.mode === "spans") {
                            if (tally.spansEmitted >= MAX_DB_SPANS_PER_CTX) {
                                tally.spansTruncated = true;
                            } else {
                                tally.spansEmitted += 1;

                                deps.record(buildDatabaseSpan({ deps, durationMs, failure, operation: property, startTs, table }));
                            }
                        }
                    } catch {
                        // Best-effort throughout — see the note above.
                    }
                }
            };

            wrapped.set(property, instrumented);

            return instrumented;
        },
    });
};

/** A zero'd tally for one dispatch. */
const createDatabaseTally = (): DatabaseTally => {
    return { calls: 0, durationMs: 0, errors: 0, perOperation: {}, spansEmitted: 0, spansTruncated: false };
};

/**
 * Render the running tally as span attributes.
 *
 * Called ONCE per dispatch, from the shard's root-span recorder — not per query.
 * Building this object on every call was pure waste on a hot path. It is a handful of keys, so the per-call cost is a small object
 * assignment — the property that makes `"summary"` mode scale to any call count.
 */
const formatTally = (tally: DatabaseTally): LogFields => {
    const fields: LogFields = {
        "db.calls": tally.calls,
        "db.duration_ms": tally.durationMs,
    };

    if (tally.errors > 0) {
        fields["db.errors"] = tally.errors;
    }

    if (tally.spansTruncated) {
        fields["db.spans_truncated"] = true;
    }

    for (const [operation, count] of Object.entries(tally.perOperation)) {
        fields[`db.op.${operation}`] = count;
    }

    return fields;
};

export type { DatabaseInstrumentation, DatabaseTally, DatabaseTelemetryDeps };
export { createDatabaseTally, formatTally, instrumentDatabase };
