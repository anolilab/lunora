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
 * The local, synchronous-ish SQL executor available inside a shard. Mirrors
 * the shape the DO's `state.storage.sql` exposes: `exec` runs a statement and
 * returns rows (for reads) or an affected-row count (for writes).
 *
 * Implementations may be sync (Cloudflare `SqlStorage`) or async-backed with
 * a sync facade; the engine treats it as fire-and-forget within a
 * {@link ShardHost.transaction} closure.
 */
export interface ShardSqlExec {
    /**
     * Execute a SQL statement with optional bound parameters.
     * Returns rows for `SELECT`, or an object with `rowsAffected` for writes.
     */
    exec: (
        query: string,
        ...bindings: ReadonlyArray<unknown>
    ) => {
        rowsAffected?: number;
        toArray?: () => SqlRow[];
    };
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
    /** Schedule the next alarm. `null` clears any pending alarm. */
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
