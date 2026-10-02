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
 * same span cap and the same best-effort settle ({@link settleCall}) — but its
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

/**
 * The leading SQL keywords `ctx.sql` reports as `db.operation.name`. An
 * allowlist, not "whatever the first word is": the operation lands in a span
 * name and a summary key, both of which must stay low-cardinality, and a
 * statement that opens with something unexpected is reported as `OTHER`
 * rather than minting a new group. `WITH` is reported as-is — finding the
 * statement a CTE feeds would mean parsing past it, which this deliberately
 * never does.
 */
const SQL_OPERATIONS = new Set([
    "ALTER",
    "ANALYZE",
    "BEGIN",
    "CALL",
    "COMMIT",
    "COPY",
    "CREATE",
    "DEALLOCATE",
    "DELETE",
    "DESCRIBE",
    "DO",
    "DROP",
    "EXECUTE",
    "EXPLAIN",
    "GRANT",
    "INSERT",
    "LISTEN",
    "LOCK",
    "MERGE",
    "NOTIFY",
    "PREPARE",
    "REFRESH",
    "RELEASE",
    "REPLACE",
    "REVOKE",
    "ROLLBACK",
    "SAVEPOINT",
    "SELECT",
    "SET",
    "SHOW",
    "START",
    "TABLE",
    "TRUNCATE",
    "UNLISTEN",
    "UPDATE",
    "VACUUM",
    "VALUES",
    "WITH",
]);

/** `db.operation.name` for a statement whose leading keyword is not in {@link SQL_OPERATIONS}. */
const SQL_OPERATION_OTHER = "OTHER";

/** One leading keyword — applied to a bounded slice, so it never scans the statement. */
const SQL_KEYWORD = /^[a-z]+/iu;

/** Table name from a call's arguments, when the method takes it first. */
const tableOf = (method: string, arguments_: unknown[]): string | undefined => {
    if (!TABLE_FIRST_METHODS.has(method)) {
        return undefined;
    }

    const first = arguments_[0];

    return typeof first === "string" && first.length > 0 ? first : undefined;
};

/**
 * The statement's operation, from its LEADING keyword only (`SELECT`, `INSERT`,
 * …, else `OTHER`).
 *
 * Skips leading whitespace, `--` line comments, `/* … *\/` block comments (a
 * driver or ORM often prepends one) and opening parentheses, then reads one
 * keyword. Nothing past that keyword is examined, so no literal, identifier or
 * parameter from the statement can reach a span — the cheap parse is also the
 * safe one. A linear scan rather than a regex so a pathological comment run
 * cannot backtrack.
 */
const sqlOperationName = (text: unknown): string => {
    if (typeof text !== "string") {
        return SQL_OPERATION_OTHER;
    }

    let index = 0;

    while (index < text.length) {
        const char = text.charAt(index);

        if (char === "(" || char.trim() === "") {
            index += 1;
        } else if (text.startsWith("--", index)) {
            const end = text.indexOf("\n", index);

            if (end === -1) {
                return SQL_OPERATION_OTHER;
            }

            index = end + 1;
        } else if (text.startsWith("/*", index)) {
            const end = text.indexOf("*/", index + 2);

            if (end === -1) {
                return SQL_OPERATION_OTHER;
            }

            index = end + 2;
        } else {
            break;
        }
    }

    const keyword = SQL_KEYWORD.exec(text.slice(index, index + 16))?.[0].toUpperCase();

    return keyword !== undefined && SQL_OPERATIONS.has(keyword) ? keyword : SQL_OPERATION_OTHER;
};

/**
 * OTel `db.system.name` for a `ctx.sql` client: the system its driver adapter
 * stamped (`fromPostgresJs` / `fromNodePg` → `postgresql`, `fromMysql2` →
 * `mysql`), else the semconv's `other_sql` for a hand-built client that did not
 * say.
 */
const sqlSystemOf = (client: SqlClientLike): string => (client.dbSystem === "mysql" || client.dbSystem === "postgresql" ? client.dbSystem : "other_sql");

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
 * The fields every auto-instrumented span shares, whichever surface made the
 * call.
 *
 * CLIENT: from the handler's point of view the call goes OUT to a datastore,
 * which is what lets a collector render it as a dependency rather than as
 * internal computation.
 */
const clientSpanBase = (
    deps: DatabaseTelemetryDeps,
    startTs: number,
): Pick<SpanEvent, "functionPath" | "kind" | "parentSpanId" | "rayId" | "shardKey" | "spanId" | "startTs" | "traceId" | "userId"> => {
    return {
        functionPath: deps.functionPath,
        kind: "client",
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
 * Build the CLIENT span for one instrumented `ctx.db` call.
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
        ...clientSpanBase(deps, startTs),
        attributes: {
            "db.operation.name": operation,
            ...(table === undefined ? {} : { "db.collection.name": table }),
            "db.system.name": "sqlite",
        },
        durationMs,
        ...(failure === undefined ? {} : { error: { message: redactArgs(describeFailure(failure), deps.captureRaw) as string, type: toErrorType(failure) } }),
        name: table === undefined ? `db.${operation}` : `db.${operation} ${table}`,
        ok: failure === undefined,
    };
};

/**
 * Build the CLIENT span for one `ctx.sql` statement.
 *
 * Carries no statement text and no parameters — only the leading-keyword
 * operation, the system, and the returned row count. No `db.collection.name`
 * either: naming the table means parsing past `FROM`/`INTO` through joins,
 * CTEs and quoting, which is neither cheap nor safe.
 *
 * `error.message` is the error TYPE outside dev, not the redacted message
 * `ctx.db` records: an external database's error text routinely quotes the
 * offending row (Postgres's `Key (email)=(…) already exists`), and that is data
 * Lunora never owned and a PII pattern will not reliably catch. `captureRaw`
 * (dev only) records the driver's message verbatim.
 */
const buildSqlSpan = (input: {
    deps: DatabaseTelemetryDeps;
    durationMs: number;
    failure: unknown;
    operation: string;
    returnedRows: number | undefined;
    startTs: number;
    system: string;
}): SpanEvent => {
    const { deps, durationMs, failure, operation, returnedRows, startTs, system } = input;
    const errorType = failure === undefined ? undefined : toErrorType(failure);

    return {
        ...clientSpanBase(deps, startTs),
        attributes: {
            "db.operation.name": operation,
            ...(returnedRows === undefined ? {} : { "db.response.returned_rows": returnedRows }),
            "db.system.name": system,
        },
        durationMs,
        ...(errorType === undefined ? {} : { error: { message: deps.captureRaw === true ? describeFailure(failure) : errorType, type: errorType } }),
        name: `sql.${operation}`,
        ok: failure === undefined,
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
    /** OTel `db.system.name` the driver adapter stamped; see {@link sqlSystemOf}. */
    readonly dbSystem?: string;
    query: (text: string, params?: ReadonlyArray<unknown>) => Promise<unknown>;
}

/** What {@link instrumentDatabase} / {@link instrumentSqlClient} need to record what they observe. */
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
     * Per-call cost stays at a few integer increments — no object allocation, no
     * lookup — which matters because this is on the path of every query. Nothing
     * is written through the dispatch's `SpanHandle` either, so the wide-event
     * collector is never materialized by instrumentation alone: a dispatch that
     * ran queries gets a root span carrying these counters, but no `lunora.dispatch`
     * log record unless the handler actually opened `ctx.span`.
     */
    tally: DatabaseTally;

    /** Read lazily — the acting user is resolved per span. */
    userId: () => string | undefined;
}

/**
 * Account for one settled call: bump the tally, then — in `"spans"` mode and
 * under {@link MAX_DB_SPANS_PER_CTX} — record its span.
 *
 * Shared by the `ctx.db` and `ctx.sql` instrumenters so both surfaces have one
 * definition of the tally, the cap and the truncation flag. `buildSpan` is a
 * thunk so `"summary"` mode never allocates a span it would discard.
 */
const settleCall = (deps: DatabaseTelemetryDeps, operation: string, durationMs: number, failure: unknown, buildSpan: () => SpanEvent): void => {
    const { tally } = deps;

    tally.calls += 1;
    tally.durationMs += durationMs;
    tally.perOperation[operation] = (tally.perOperation[operation] ?? 0) + 1;

    if (failure !== undefined) {
        tally.errors += 1;
    }

    // Guarded as a whole: telemetry runs after the call already settled, so
    // letting it throw would turn a succeeded query into a failed one — and
    // replace the real error with a telemetry one on the failure path.
    try {
        if (deps.mode === "spans") {
            if (tally.spansEmitted >= MAX_DB_SPANS_PER_CTX) {
                tally.spansTruncated = true;
            } else {
                tally.spansEmitted += 1;

                deps.record(buildSpan());
            }
        }
    } catch {
        // Best-effort throughout — see the note above.
    }
};

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

                    settleCall(deps, property, durationMs, failure, () =>
                        buildDatabaseSpan({ deps, durationMs, failure, operation: property, startTs, table }),
                    );
                }
            };

            wrapped.set(property, instrumented);

            return instrumented;
        },
    });
};

/**
 * Wrap the action-only `ctx.sql` client so every `query` is instrumented — the
 * `ctx.sql` twin of {@link instrumentDatabase}, at the same levels and through
 * the same {@link settleCall}. `deps.tally` must be a tally of its own (folded
 * as `sql.*`), never `ctx.db`'s.
 *
 * `query` is the whole `SqlClient` surface: it has no transaction or batch
 * method to cover. Everything else on the client passes through the proxy
 * untouched, and `"off"` returns the client itself.
 */
const instrumentSqlClient = <T extends SqlClientLike>(client: T, deps: DatabaseTelemetryDeps): T => {
    if (deps.mode === "off") {
        return client;
    }

    const system = sqlSystemOf(client);
    let instrumented: ((...arguments_: unknown[]) => Promise<unknown>) | undefined;

    return new Proxy(client, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver) as unknown;

            if (property !== "query" || typeof value !== "function") {
                return value;
            }

            const original = value as (...arguments_: unknown[]) => Promise<unknown>;

            instrumented ??= async (...arguments_: unknown[]): Promise<unknown> => {
                const startTs = Date.now();
                const operation = sqlOperationName(arguments_[0]);
                let failure: unknown;
                let returnedRows: number | undefined;

                try {
                    const rows = await original.apply(target, arguments_);

                    returnedRows = Array.isArray(rows) ? rows.length : undefined;

                    return rows;
                } catch (error) {
                    failure = error;

                    // Re-thrown untouched: this is instrumentation, never flow control.
                    throw error;
                } finally {
                    const durationMs = Date.now() - startTs;

                    settleCall(deps, operation, durationMs, failure, () =>
                        buildSqlSpan({ deps, durationMs, failure, operation, returnedRows, startTs, system }),
                    );
                }
            };

            return instrumented;
        },
    });
};

/** A zero'd tally for one dispatch. */
const createDatabaseTally = (): DatabaseTally => {
    return { calls: 0, durationMs: 0, errors: 0, perOperation: {}, spansEmitted: 0, spansTruncated: false };
};

/**
 * Render the running tally as span attributes, under `prefix` — `db` for
 * `ctx.db` (the default), `sql` for `ctx.sql`.
 *
 * Called ONCE per dispatch, from the shard's root-span recorder — not per query.
 * Building this object on every call was pure waste on a hot path. It is a handful of keys, so the per-call cost is a small object
 * assignment — the property that makes `"summary"` mode scale to any call count.
 */
const formatTally = (tally: DatabaseTally, prefix: "db" | "sql" = "db"): LogFields => {
    const fields: LogFields = {
        [`${prefix}.calls`]: tally.calls,
        [`${prefix}.duration_ms`]: tally.durationMs,
    };

    if (tally.errors > 0) {
        fields[`${prefix}.errors`] = tally.errors;
    }

    if (tally.spansTruncated) {
        fields[`${prefix}.spans_truncated`] = true;
    }

    for (const [operation, count] of Object.entries(tally.perOperation)) {
        fields[`${prefix}.op.${operation}`] = count;
    }

    return fields;
};

export type { DatabaseInstrumentation, DatabaseTally, DatabaseTelemetryDeps, SqlClientLike };
export { createDatabaseTally, formatTally, instrumentDatabase, instrumentSqlClient, sqlOperationName };
