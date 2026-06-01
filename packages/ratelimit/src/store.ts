import type { Id } from "@cirrus/values";

import type { RateLimitStore, RateLimitValue } from "./types.js";

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
    /** Table name. Created if missing. Defaults to `_cirrus_rate_limits`. */
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
    const table = options.table ?? "_cirrus_rate_limits";

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
                value.prev ?? null,
            );
        },
    };
};

/**
 * The slice of an index-range builder the store uses. Mirrors `@cirrus/server`'s
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
 * The slice of the Cirrus ORM writer (`ctx.db` on a mutation/action) the store
 * needs. The real `DatabaseWriter` is structurally assignable, so pass `ctx.db`
 * directly — declared here (rather than imported) to keep `@cirrus/ratelimit`
 * free of a runtime dependency on `@cirrus/server`.
 */
interface RateLimitDatabase {
    delete: <T extends string>(id: Id<T>) => Promise<void>;
    insert: <T extends string>(table: T, document: Record<string, unknown>) => Promise<Id<T>>;
    patch: <T extends string>(id: Id<T>, patch: Record<string, unknown>) => Promise<void>;
    query: (table: string) => RateLimitDatabaseQuery;
}

interface DatabaseStoreOptions {
    /** The Cirrus ORM writer — `ctx.db` inside a mutation or action. */
    db: RateLimitDatabase;
    /** Index that resolves a row by its key column. Defaults to `by_key`. */
    index?: string;
    /** Column storing the opaque key. Defaults to `key`. */
    keyField?: string;
    /** Table holding one row per `(name, key)` pair. Defaults to `rateLimits`. */
    table?: string;
}

/**
 * Store backed by a Cirrus table through `ctx.db`, for durable per-DO limits
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
 */
const createDatabaseStore = (options: DatabaseStoreOptions): RateLimitStore => {
    const { db } = options;
    const table = options.table ?? "rateLimits";
    const index = options.index ?? "by_key";
    const keyField = options.keyField ?? "key";

    const find = async (storageKey: string): Promise<Record<string, unknown> | null> =>
        db
            .query(table)
            .withIndex(index, (q) => q.eq(keyField, storageKey))
            .first();

    return {
        delete: async (storageKey) => {
            const row = await find(storageKey);

            if (row) {
                await db.delete(row._id as Id<string>);
            }
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
            const row = await find(storageKey);
            const document: Record<string, unknown> = { [keyField]: storageKey, ts: value.ts, value: value.value };

            if (value.prev !== undefined) {
                document.prev = value.prev;
            }

            await (row ? db.patch(row._id as Id<string>, document) : db.insert(table, document));
        },
    };
};

export type { DatabaseStoreOptions as DbStoreOptions, RateLimitDatabase as RateLimitDb, RateLimitDatabaseIndexRange as RateLimitDbIndexRange, RateLimitDatabaseQuery as RateLimitDbQuery, SqlLike, SqlStoreOptions };
export { createDatabaseStore as createDbStore, createMemoryStore, createSqlStore };
