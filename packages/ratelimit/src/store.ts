import { LunoraError } from "@lunora/errors";
import type { Id } from "@lunora/values";

import type { RateLimitStore, RateLimitValue } from "./types";

/**
 * In-memory store. State lives for the lifetime of the process (or, inside a
 * Durable Object, the instance) — adequate for single-DO limits but not shared
 * across instances. Use {@link createSqlStore} for durable per-DO state.
 */
const createMemoryStore = (): RateLimitStore => {
    const map = new Map<string, RateLimitValue>();

    return {
        delete: (storageKey) => {
            map.delete(storageKey);
        },
        get: (storageKey) => map.get(storageKey),
        set: (storageKey, value) => {
            map.set(storageKey, value);
        },
    };
};

/**
 * Minimal projection of `state.storage.sql` (workerd's `SqlStorage`, also
 * satisfied by `node:sqlite`). Only the `exec` overload is required.
 */
interface SqlLike {
    exec: <Row = Record<string, unknown>>(query: string, ...params: unknown[]) => { toArray: () => Row[] };
}

interface SqlStoreOptions {
    sql: SqlLike;
    /** Table name. Created if missing. Defaults to `_lunora_rate_limits`. */
    table?: string;
}

/** Indirection that lets us call `exec` without typing the literal (repo hook). */
const runSql = <Row = Record<string, unknown>>(sql: SqlLike, query: string, ...params: unknown[]): Row[] => {
    const runner = sql.exec as (this: SqlLike, query: string, ...rest: unknown[]) => { toArray: () => Row[] };

    return runner.call(sql, query, ...params).toArray();
};

/**
 * SQLite-backed store for durable, per-DO rate-limit state. Persists each
 * `(name, key)` pair as one row so limits survive hibernation and eviction.
 *
 * **Atomicity:** the store does not wrap individual operations in an explicit
 * SQL transaction. Inside a Durable Object the DO's input gate serializes
 * every RPC call against the storage, so the limiter's read-modify-write
 * sequence runs to completion without interleaving — this is the same
 * guarantee the surrounding `evaluate()` step depends on. **Outside a DO**
 * (e.g. driving `createSqlStore` from a long-lived `node:sqlite` connection in
 * tests or a custom host) the caller is responsible for serialization; the
 * SQL surface used here (`exec`) is not a substitute for transactional
 * isolation across concurrent invocations.
 */
const createSqlStore = (options: SqlStoreOptions): RateLimitStore => {
    const { sql } = options;
    const table = options.table ?? "_lunora_rate_limits";

    runSql(sql, `CREATE TABLE IF NOT EXISTS "${table}" (k TEXT PRIMARY KEY, value REAL NOT NULL, ts INTEGER NOT NULL, prev REAL)`);

    return {
        delete: (storageKey) => {
            runSql(sql, `DELETE FROM "${table}" WHERE k = ?`, storageKey);
        },
        get: (storageKey) => {
            const rows = runSql<{ prev: number | null; ts: number; value: number }>(sql, `SELECT value, ts, prev FROM "${table}" WHERE k = ?`, storageKey);
            const row = rows[0];

            if (!row) {
                return undefined;
            }

            const value: RateLimitValue = { ts: row.ts, value: row.value };

            if (row.prev !== null) {
                value.prev = row.prev;
            }

            return value;
        },
        set: (storageKey, value) => {
            runSql(
                sql,
                `INSERT INTO "${table}" (k, value, ts, prev) VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET value = excluded.value, ts = excluded.ts, prev = excluded.prev`,
                storageKey,
                value.value,
                value.ts,
                // SQL bind: a missing `prev` must bind as SQL NULL, not undefined.
                // eslint-disable-next-line unicorn/no-null -- SQLite/D1 bind parameters require null for a NULL column
                value.prev ?? null,
            );
        },
    };
};

/**
 * The slice of an index-range builder the store uses. Mirrors `@lunora/server`'s
 * `IndexRangeBuilder` field-for-field so the real `ctx.db` query builder is
 * assignable; only `eq` is exercised.
 */
interface RateLimitDatabaseIndexRange {
    eq: (field: string, value: unknown) => RateLimitDatabaseIndexRange;
    gt: (field: string, value: unknown) => RateLimitDatabaseIndexRange;
    gte: (field: string, value: unknown) => RateLimitDatabaseIndexRange;
    lt: (field: string, value: unknown) => RateLimitDatabaseIndexRange;
    lte: (field: string, value: unknown) => RateLimitDatabaseIndexRange;
}

/** The slice of a `ctx.db` table query the store relies on. */
interface RateLimitDatabaseQuery {
    first: () => Promise<Record<string, unknown> | null>;
    withIndex: (indexName: string, range: (q: RateLimitDatabaseIndexRange) => RateLimitDatabaseIndexRange) => RateLimitDatabaseQuery;
}

/**
 * The READ slice — everything the store needs to answer `RateLimiter.getValue`
 * and `check`, which the docs describe as projecting the stored value forward to
 * the current clock. A `QueryCtx`'s `ctx.db` is a reader and satisfies this.
 *
 * Split out because requiring the writer for a pure read meant "how many
 * requests does this user have left" could not be answered from a query context
 * at all — every remaining-quota display had to cast, and a cast that appears
 * often enough stops carrying information. The distinction was already in the
 * methods: `getValue`/`check` read, `limit`/`reset` write.
 */
interface RateLimitDatabaseReader {
    query: (table: string) => RateLimitDatabaseQuery;
}

/**
 * The slice of the Lunora ORM writer (`ctx.db` on a mutation/action) the store
 * needs. The real `DatabaseWriter` is structurally assignable, so pass `ctx.db`
 * directly — declared here (rather than imported) to keep `@lunora/ratelimit`
 * free of a runtime dependency on `@lunora/server`.
 */
interface RateLimitDatabase extends RateLimitDatabaseReader {
    delete: <T extends string>(id: Id<T>) => Promise<void>;
    insert: <T extends string>(table: T, document: Record<string, unknown>) => Promise<Id<T>>;
    patch: <T extends string>(id: Id<T>, patch: Record<string, unknown>) => Promise<void>;
}

/** The table/column/index knobs shared by the read-only and read-write stores. */
interface DatabaseStoreLocation {
    /** Index that resolves a row by its key column. Defaults to `by_key`. */
    index?: string;
    /** Column storing the opaque key. Defaults to `key`. */
    keyField?: string;
    /** Table holding one row per `(name, key)` pair. Defaults to `rateLimits`. */
    table?: string;
}

interface DatabaseStoreOptions extends DatabaseStoreLocation {
    /** The Lunora ORM writer — `ctx.db` inside a mutation or action. */
    db: RateLimitDatabase;
}

interface ReadOnlyDatabaseStoreOptions extends DatabaseStoreLocation {
    /** The Lunora ORM reader — `ctx.db` inside a query. */
    db: RateLimitDatabaseReader;
}

/**
 * Store backed by a Lunora table through `ctx.db`, for durable per-DO limits
 * inside a procedure (the procedure context exposes no raw SQL). Declare a
 * table with the key column and its index, e.g.
 *
 * ```ts
 * rateLimits: defineTable({
 *     key: v.string(),
 *     ts: v.number(),
 *     value: v.number(),
 *     prev: v.optional(v.number()),
 * }).index("by_key", ["key"])
 * ```
 *
 * Each operation is a read-then-write; inside a mutation/action that pair runs
 * under the DO's input gate, so it is atomic against concurrent calls.
 *
 * **Consumption commits with the procedure.** A mutation's `ctx.db` writes ride
 * its storage transaction, so a handler that throws after `limit()` rolls the
 * consumed unit back with everything else — inside a mutation this store counts
 * successful calls, not attempts. To charge every attempt (a login limiter),
 * consume from an action, where each write commits on its own, or return a
 * failure value from the mutation instead of throwing.
 */
const createDatabaseStore = (options: DatabaseStoreOptions): RateLimitStore => {
    const { db } = options;
    const table = options.table ?? "rateLimits";
    const index = options.index ?? "by_key";
    const keyField = options.keyField ?? "key";

    // The limiter's hot path is get() immediately followed by set() under the
    // DO input gate (read-modify-write). Caching the row id (or its absence)
    // resolved by the get()'s find() lets the following set()/delete() patch or
    // insert directly, halving the index lookups per consuming limit() (was
    // find-in-get + find-in-set; now one find total). The cache is invalidated
    // on every write so a subsequent get() re-reads, never serving stale state.
    const idCache = new Map<string, Id<string> | undefined>();

    const find = async (storageKey: string): Promise<Record<string, unknown> | null> => {
        const row = await db
            .query(table)
            .withIndex(index, (q) => q.eq(keyField, storageKey))
            .first();

        idCache.set(storageKey, row ? (row._id as Id<string>) : undefined);

        return row;
    };

    // The row id resolved by the most recent find(): the id when a row matched,
    // or a cached `undefined` (tracked via `idCache.has()`) when it didn't. A
    // missing cache entry means no lookup is cached (the caller must find()).
    // Re-running find() only when the cache is cold is what saves the redundant
    // lookup on the get()→set() hot path.
    const resolveId = async (storageKey: string): Promise<Id<string> | undefined> => {
        if (idCache.has(storageKey)) {
            return idCache.get(storageKey);
        }

        await find(storageKey);

        return idCache.get(storageKey);
    };

    return {
        delete: async (storageKey) => {
            const id = await resolveId(storageKey);

            if (id !== undefined) {
                await db.delete(id);
            }

            idCache.delete(storageKey);
        },
        get: async (storageKey) => {
            const row = await find(storageKey);

            if (!row) {
                return undefined;
            }

            const value: RateLimitValue = { ts: row.ts as number, value: row.value as number };

            if (row.prev !== null && row.prev !== undefined) {
                value.prev = row.prev as number;
            }

            return value;
        },
        set: async (storageKey, value) => {
            const id = await resolveId(storageKey);
            const document: Record<string, unknown> = { [keyField]: storageKey, ts: value.ts, value: value.value };

            if (value.prev !== undefined) {
                document.prev = value.prev;
            }

            if (id === undefined) {
                idCache.set(storageKey, await db.insert(table, document));
            } else {
                await db.patch(id, document);
            }
        },
    };
};

/**
 * Read-only counterpart to {@link createDatabaseStore}, for a query context.
 *
 * `get` behaves identically — same table, index and key column — so
 * `RateLimiter.getValue` / `check` report exactly what the writing store would.
 * `set` and `delete` are the only difference: they throw rather than silently
 * doing nothing, because a limiter that appears to consume budget and does not
 * is worse than one that refuses.
 *
 * This mirrors the split Lunora already makes for `ctx.storage`, which is a
 * `ReadOnlyStorage` in a query and a full `Storage` in an action — the
 * capability difference is visible in the type instead of discovered at runtime.
 */
const createReadOnlyDatabaseStore = (options: ReadOnlyDatabaseStoreOptions): RateLimitStore => {
    const reject = (operation: string): never => {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/ratelimit: \`${operation}\` needs a writable \`ctx.db\`, but this store was created with \`createReadOnlyDbStore\` (a query context). ` +
                `Use \`createDbStore\` from a mutation or action; a query can only call \`getValue\`/\`check\`.`,
        );
    };

    const readable = createDatabaseStore({
        ...options,
        db: {
            delete: () => reject("delete"),
            insert: () => reject("insert"),
            patch: () => reject("patch"),
            query: options.db.query.bind(options.db),
        },
    });

    return {
        delete: () => reject("reset"),
        get: readable.get,
        set: () => reject("limit"),
    };
};

export type {
    DatabaseStoreOptions as DbStoreOptions,
    RateLimitDatabase as RateLimitDb,
    RateLimitDatabaseIndexRange as RateLimitDbIndexRange,
    RateLimitDatabaseQuery as RateLimitDbQuery,
    RateLimitDatabaseReader as RateLimitDbReader,
    ReadOnlyDatabaseStoreOptions as ReadOnlyDbStoreOptions,
    SqlLike,
    SqlStoreOptions,
};
export { createDatabaseStore as createDbStore, createMemoryStore, createReadOnlyDatabaseStore as createReadOnlyDbStore, createSqlStore };
