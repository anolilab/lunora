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
import type { SpanEvent, SpanHandle } from "../../../shared/span-event";
import type { TraceAnchor } from "./context-telemetry";
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

/** Running totals for `"summary"` mode. */
interface DatabaseTally {
    calls: number;
    durationMs: number;
    errors: number;
    perOperation: Record<string, number>;
    spansEmitted: number;
    spansTruncated: boolean;
}

/** Table name from a call's arguments, when the method takes it first. */
const tableOf = (method: string, arguments_: unknown[]): string | undefined => {
    if (!TABLE_FIRST_METHODS.has(method)) {
        return undefined;
    }

    const first = arguments_[0];

    return typeof first === "string" && first.length > 0 ? first : undefined;
};

/**
 * Fold the running tally onto the dispatch's wide event.
 *
 * Called once, from the dispatch's end (see
 * {@link DatabaseTelemetryDeps.registerFlush}), not after every call. The totals
 * are cumulative and the handle is last-write-wins per key, so an intermediate
 * publish is always overwritten by the next one — N publishes and one publish
 * produce the same wide event, and only one of them puts an attribute-bag
 * allocation on every `ctx.db` call.
 */
const publishTally = (span: SpanHandle, tally: DatabaseTally): void => {
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

    span.setAttributes(fields);
};

/** Render a thrown value for a span's `error.message` without relying on `Object`'s default stringification. */
const describeFailure = (failure: unknown): string => {
    if (failure instanceof Error) {
        return failure.message;
    }

    return typeof failure === "string" ? failure : JSON.stringify(failure);
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
        ...(failure === undefined ? {} : { error: { message: describeFailure(failure), type: toErrorType(failure) } }),
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
export type DatabaseInstrumentation = "off" | "spans" | "summary";

/** What {@link instrumentDatabase} needs to record what it observes. */
export interface DatabaseTelemetryDeps {
    /** The trace produced spans belong to (`"spans"` mode only). */
    anchor: TraceAnchor;
    /** Function path spans and attributes are attributed to. */
    functionPath: string;
    /** Detail level; see {@link DatabaseInstrumentation}. */
    mode: DatabaseInstrumentation;
    /** Hand a finished span to the buffer + sink (`"spans"` mode only). */
    record: (span: SpanEvent) => void;

    /**
     * Register a callback the dispatch invokes exactly once, at its end, before
     * it decides whether the dispatch produced telemetry worth recording.
     *
     * The tally is published there rather than after every call. Both are
     * equivalent — the totals are cumulative and the handle is last-write-wins,
     * so every publish but the final one is overwritten — but the per-call form
     * rebuilt an attribute bag on each `ctx.db` call, which is dead weight on
     * exactly the path `"summary"` mode exists to keep cheap.
     *
     * "Before the gate" matters: a handler that touched only `ctx.db` has no
     * span collector yet, so folding after the gate would drop its tally.
     */
    registerFlush: (flush: () => void) => void;
    /** Shard key for single-shard calls; absent for the unnamed root DO. */
    shardKey: string | undefined;
    /** The dispatch's wide-event handle — where `"summary"` mode writes its tallies. */
    span: SpanHandle;
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
export const instrumentDatabase = <T extends object>(database: T, deps: DatabaseTelemetryDeps): T => {
    if (deps.mode === "off") {
        return database;
    }

    const tally: DatabaseTally = { calls: 0, durationMs: 0, errors: 0, perOperation: {}, spansEmitted: 0, spansTruncated: false };

    // No calls means nothing to say. Publishing an empty tally would attach
    // `db.calls: 0` to the wide event and, worse, force a span collector into
    // existence for a dispatch that never touched the database — which is what
    // the dispatch's gate reads to decide whether there is any telemetry at all.
    deps.registerFlush(() => {
        if (tally.calls > 0) {
            publishTally(deps.span, tally);
        }
    });

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
