/**
 * `ShardHost` — the provider-neutral contract for a single-writer, durable
 * shard execution slot. On Cloudflare this is backed by one Durable Object
 * instance (`state.storage` + `state.blockConcurrencyWhile`); on another
 * provider it may be an actor, a container, or a single-node process.
 *
 * The contract encodes the guarantees the Lunora reactive engine relies on:
 * 1. **Single-writer serialization** — mutations for one shard key never
 * interleave; they are serialized through {@link ShardHost.runSerialized}.
 * 2. **Transactional durability** — a mutation either commits fully or rolls
 * back; no partial writes are observable.
 * 3. **Local SQL execution** — the shard can run synchronous-ish SQL against
 * co-located storage (SQLite on Cloudflare; another embedded or local DB
 * elsewhere). Reads must observe the current transaction's writes.
 * 4. **Alarms / scheduled wakeup** — the shard can schedule a future wakeup
 * for background work (timers, retries, TTL cleanup).
 * 5. **Background continuation** — `waitUntil` lets work outlive the request
 * without blocking the response.
 *
 * This is an internal contract. User code never sees it; only the runtime,
 * the shard engine, and host adapters consume it.
 */

/**
 * Minimal SQL cursor/row shape returned by the local SQL executor. Kept
 * generic so a host can wrap SQLite, libSQL, or another embedded store.
 */
export type SqlRow = Record<string, unknown>;

/**
 * The result of one statement: a cursor over its rows.
 *
 * Every member here is required, because the engine uses all three and a host
 * that omits one fails at runtime rather than at compile time. That is not
 * hypothetical — an earlier revision of this contract made `toArray` optional
 * and offered a `rowsAffected` nothing reads, which meant a host could satisfy
 * the type and still be unusable.
 *
 * Iteration is part of the contract because read paths stream cursors directly
 * rather than buffering; `toArray` is the buffered form, and `one` is the
 * exactly-one-row form used by lookups and aggregates.
 */
export interface ShardSqlCursor<Row = SqlRow> extends Iterable<Row> {
    /**
     * The single row this statement produced.
     * @throws when the result does not hold exactly one row.
     */
    one: () => Row;
    /** Buffer every row. */
    toArray: () => Row[];
}

/**
 * The local, synchronous-ish SQL executor available inside a shard — the
 * engine's hot path. Mirrors the shape the DO's `state.storage.sql` exposes.
 *
 * Implementations may be sync (Cloudflare `SqlStorage`) or async-backed with
 * a sync facade; the engine treats it as fire-and-forget within a
 * {@link ShardHost.transaction} closure.
 */
export interface ShardSqlExec {
    /**
     * Size of the shard's local database in bytes, when the host can report it
     * cheaply. Optional: it is used for storage telemetry and quota warnings,
     * never for correctness, so a host without the number simply omits it.
     *
     * Read as a live getter where the host provides one — do not cache it.
     */
    readonly databaseSize?: number;

    /** Execute a SQL statement with optional bound parameters. */
    exec: <Row = SqlRow>(query: string, ...bindings: ReadonlyArray<unknown>) => ShardSqlCursor<Row>;
}

/**
 * Async SQL executor used by the engine's higher-level paths (global tables,
 * metrics, auth). Already defined in `@lunora/sql-store` as `SqlExec`; this
 * alias keeps the platform contract self-contained.
 */
export interface ShardAsyncSqlExec {
    all: (sql: string, params: ReadonlyArray<unknown>) => Promise<SqlRow[]>;
    run: (sql: string, params: ReadonlyArray<unknown>) => Promise<{ rowsAffected: number }>;
}

/**
 * Alarm scheduling for a shard. Alarms are durable: they survive host
 * recycling and fire at the requested timestamp.
 */
export interface ShardAlarms {
    /** Delete any pending alarm. */
    delete: () => Promise<void> | void;
    /** Read the currently scheduled alarm timestamp, if any. */
    get: () => Promise<number | null> | number | null;

    /**
     * Schedule the next alarm. Call {@link ShardAlarms.delete} to clear a
     * pending alarm — `set` always schedules and never clears.
     */
    set: (timestamp: number | Date) => Promise<void> | void;
}

/**
 * The core shard host contract. One instance per shard key.
 */
export interface ShardHost {
    /** Durable alarm scheduling for the shard. */
    alarms: ShardAlarms;

    /**
     * Async SQL executor for engine paths that need promise-based row access
     * (global tables, metrics, auth). Hosts may implement this over the same
     * underlying storage as `sql`.
     */
    asyncSql?: ShardAsyncSqlExec;

    /**
     * Run `fn` with exclusive ownership of the shard. Concurrent calls are
     * queued; no two closures run at once for the same shard key. On
     * Cloudflare this maps to `state.blockConcurrencyWhile`.
     */
    runSerialized: <T>(function_: () => Promise<T>) => Promise<T>;

    /**
     * The shard key this host serves — the name the directory resolved to reach
     * it. Used for telemetry attribution and log correlation ("which shard
     * emitted this?"), never for routing: the host is already the shard.
     *
     * Optional because a host may address a shard by an opaque id with no
     * human-readable name (Cloudflare's `newUniqueId()` objects have none).
     * Callers must tolerate `undefined` rather than assume a key exists.
     */
    readonly shardKey?: string;

    /**
     * The shard's local SQL executor. Reads and writes inside a `transaction`
     * closure observe the transaction's isolation.
     */
    sql: ShardSqlExec;

    /**
     * Run `fn` inside a durable transaction. If `fn` throws, all writes roll
     * back. Raw `BEGIN`/`COMMIT`/`ROLLBACK` are forbidden inside the closure;
     * the host manages the transaction boundary.
     */
    transaction: <T>(function_: () => Promise<T>) => Promise<T>;

    /**
     * Extend the lifetime of background work past the response. Optional on
     * hosts that don't distinguish request/background lifetimes.
     */
    waitUntil?: (promise: Promise<unknown>) => void;
}
