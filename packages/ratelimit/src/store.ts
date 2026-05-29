import type { RateLimitStore, RateLimitValue } from "./types.js";

/**
 * In-memory store. State lives for the lifetime of the process (or, inside a
 * Durable Object, the instance) — adequate for single-DO limits but not shared
 * across instances. Use {@link createSqlStore} for durable per-DO state.
 */
export const createMemoryStore = (): RateLimitStore => {
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
export interface SqlLike {
    exec: <Row = Record<string, unknown>>(query: string, ...params: unknown[]) => { toArray: () => Row[] };
}

export interface SqlStoreOptions {
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
 */
export const createSqlStore = (options: SqlStoreOptions): RateLimitStore => {
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
