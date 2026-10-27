import { LunoraError } from "@lunora/errors";
import type { Id } from "@lunora/values";

import type { RateLimitStore, RateLimitValue } from "./types";

/**
 * In-memory store. State lives for the lifetime of the process (or, inside a
 * Durable Object, the instance) — adequate for single-DO limits but not shared
 * across instances. Use {@link createSqlStore} for durable per-DO state.
 *
 * A store may be shared by several limiters: each sweep evicts only the keys its
 * limiter owns, by that limiter's horizon (see `RateLimitStore.sweep`).
 */
const createMemoryStore = (): RateLimitStore => {
    const map = new Map<string, RateLimitValue>();

    return {
        delete: (storageKey) => {
            map.delete(storageKey);
        },
        get: (storageKey) => map.get(storageKey),
        set: (storageKey, value) => {
            // Delete first so a rewritten key moves to the end: insertion order then
            // tracks write time, and the oldest entries sit at the front for `sweep`.
            map.delete(storageKey);
            map.set(storageKey, value);
        },
        sweep: (olderThanTs, limit, owns) => {
            let examined = 0;

            for (const [storageKey, value] of map) {
                if (examined >= limit) {
                    break;
                }

                examined += 1;
                map.delete(storageKey);

                // An entry is kept when it is a reserved debt (which outlives any age bound,
                // since reserves stack), or belongs to another limiter sharing this store. A
                // kept entry moves to the end, so it cannot stop the sweep from reaching the
                // entries behind it. ponytail: a debt key stays until a consume rewrites it
                // or reset; add a debt-aware bound if abandoned debts show up in memory profiles.
                if (value.value < 0 || value.ts > olderThanTs || owns?.(storageKey) === false) {
                    map.set(storageKey, value);
                }
            }
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
 * **Retention:** the limiter calls `sweep` after each write, which deletes up to 32
 * rows older than its horizon. The index on `ts` covers only rows with a
 * non-negative `value`, so a reserved debt (never swept) adds nothing to the scan.
 * The table holds the live keys plus the expired ones not yet swept. Limiters may
 * share the table: each sweep deletes only the keys its own limiter owns, so a
 * shorter-window limiter cannot evict a longer-window one's rows. A sweep reads
 * candidates by `ts` before filtering by owner, so a long run of another limiter's
 * expired rows can use up the window for a while.
 *
 * **Atomicity:** `exec` is synchronous and the limiter does not yield between a
 * synchronous store's read and its write, so one consume's read, decision and
 * write run as a single JavaScript step. No other call on the same isolate can
 * interleave, which is what makes concurrent consumes admit exactly the
 * configured rate. Two isolates sharing one SQLite file (not a Durable Object
 * case) are not covered; serialize those yourself.
 */
const createSqlStore = (options: SqlStoreOptions): RateLimitStore => {
    const { sql } = options;
    const table = options.table ?? "_lunora_rate_limits";

    runSql(sql, `CREATE TABLE IF NOT EXISTS "${table}" (k TEXT PRIMARY KEY, value REAL NOT NULL, ts INTEGER NOT NULL, prev REAL)`);
    // Table shape change: the sweep's range scan on `ts`. Partial on `value >= 0` so a debt row is never indexed.
    runSql(sql, `CREATE INDEX IF NOT EXISTS "${table}_ts" ON "${table}" (ts) WHERE value >= 0`);

    return {
        delete: (storageKey) => {
            runSql(sql, `DELETE FROM "${table}" WHERE k = ?`, storageKey);
        },
        // The `value >= 0` must stay literal so the planner can use the partial index.
        // The limit is a bound parameter, not inlined. Ownership is checked in JS, so a
        // row another limiter wrote is never deleted.
        sweep: (olderThanTs, limit, owns) => {
            const candidates = runSql<{ k: string }>(sql, `SELECT k FROM "${table}" WHERE ts <= ? AND value >= 0 ORDER BY ts LIMIT ?`, olderThanTs, limit);

            for (const { k } of candidates) {
                if (owns?.(k) !== false) {
                    runSql(sql, `DELETE FROM "${table}" WHERE k = ?`, k);
                }
            }
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
 * The READ slice — everything the store needs to answer `RateLimiter.getValue`
 * and `check`, which the docs describe as projecting the stored value forward to
 * the current clock. A `QueryCtx`'s `ctx.db` is a reader and satisfies this.
 *
 * Split out because requiring the writer for a pure read meant "how many
 * requests does this user have left" could not be answered from a query context
 * at all — every remaining-quota display had to cast, and a cast that appears
 * often enough stops carrying information. The distinction was already in the
 * methods: `getValue`/`check` read, `limit`/`reset` write.
 *
 * `findFirst` rather than `query(table).withIndex(...)`: a `.global()` table's
 * reader has no `withIndex`, so the indexed builder failed every read there.
 * `findFirst` routes to whichever backend owns the table, and an equality on the
 * key column still uses its index.
 */
interface RateLimitDatabaseReader {
    findFirst: (table: string, args?: { where?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>;
}

/**
 * The slice of the Lunora ORM writer (`ctx.db` on a mutation/action) the store
 * needs. The real `DatabaseWriter` is structurally assignable, so pass `ctx.db`
 * directly — declared here (rather than imported) to keep `@lunora/ratelimit`
 * free of a runtime dependency on `@lunora/server`.
 */
interface RateLimitDatabase extends RateLimitDatabaseReader {
    delete: <T extends string>(table: T, id: Id<T>) => Promise<void>;

    /**
     * Used by `sweep` only: rows matching `where`, at most `limit`. Optional in the
     * type because the public `DatabaseWriter` does not declare it; the framework's
     * `ctx.db` implements it, and `sweep` throws if an adapter does not.
     */
    findMany?: (
        table: string,
        args: { limit?: number; orderBy?: Record<string, "asc" | "desc">[]; where?: Record<string, unknown> },
    ) => Promise<{ page: Record<string, unknown>[] }>;

    insert: <T extends string>(table: T, document: Record<string, unknown>, options?: { clientId?: string }) => Promise<Id<T>>;
    patchIf: <T extends string>(
        table: T,
        id: Id<T>,
        args: { patch: Record<string, unknown>; where: Record<string, unknown> },
    ) => Promise<{ applied: boolean; doc: Record<string, unknown> | null }>;
}

/** The table/column knobs shared by the read-only and read-write stores. */
interface DatabaseStoreLocation {
    /** Column storing the opaque key. Defaults to `key`. Index it: every consume reads by it. */
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

const toHex = (byte: number): string => byte.toString(16).padStart(2, "0");

/**
 * The row id a `(table, storageKey)` pair is created under: a UUID (version 8,
 * RFC 9562's custom layout) taken from the pair's SHA-256. Concurrent first
 * consumes for one key then insert the SAME primary key, so the engine admits
 * one and refuses the rest, where random ids let every one of them create a row.
 */
const rowIdFor = async (table: string, storageKey: string): Promise<string> => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${table}\u0000${storageKey}`)));
    const bytes = [...digest.subarray(0, 16)];

    // Version 8 in the high nibble of byte 6, variant 10 in the top bits of byte 8.
    bytes[6] = 0x80 + ((bytes[6] as number) % 16);
    bytes[8] = 0x80 + ((bytes[8] as number) % 64);

    const hex = bytes.map((byte) => toHex(byte)).join("");

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const isConflict = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === "CONFLICT";

/**
 * Store backed by a Lunora table through `ctx.db`, for durable limits inside a
 * procedure (the procedure context exposes no raw SQL). Works on a shard-local
 * table and on a `.global()` one. Declare a table with the key column and its
 * index, e.g.
 *
 * ```ts
 * rateLimits: defineTable({
 *     key: v.string(),
 *     ts: v.number(),
 *     value: v.number(),
 *     prev: v.optional(v.number()),
 * })
 *     .index("by_key", ["key"])
 *     .index("by_ts", ["ts"])
 * ```
 *
 * **Table shape change:** `by_ts` is new. The sweep finds expired rows through it.
 * A table declared without it still works, but each sweep scans every row. Apps
 * that already declared the table add the index. The sweep deletes at most 32
 * expired rows per write; a reserved debt (negative `value`) is never deleted.
 * The ORM index cannot be partial, so debts stay in it: many old debts make each
 * sweep read past them. Reserves are rare, so this is accepted.
 *
 * **Ceiling:** the sweep deletes only a row whose `ts`, `value` and `prev` still match
 * what it read, but the framework resolves that match and deletes in two steps.
 * On a `.global()` table another shard can rewrite the row between them, so the
 * row is deleted live and its bucket resets. Closing that needs a conditional
 * delete on `ctx.db`, which does not exist yet. A shard-local table is not exposed:
 * the Durable Object's input gate holds across the sweep's storage operations.
 *
 * **Soft delete:** the sweep deletes with `ctx.db.delete`, which has no hard-delete
 * option. Declare the table without `.softDelete()`: a tombstoned row keeps its
 * deterministic id, so the next consume for that key conflicts forever.
 *
 * **Atomic against concurrent consumes.** `setIf` writes only if the row still
 * holds the value `get` returned: an existing row through `ctx.db.patchIf` with
 * that value as its `where`, a new row through an `insert` under an id derived
 * from the key, which a concurrent creator's insert collides with. A consume
 * that loses either race gets `false` back and the limiter reads and decides
 * again, so a limit of 1 admits one caller however many arrive together — on a
 * `.global()` table too, where D1 calls do not hold the Durable Object's input
 * gate.
 *
 * **Consumption commits with the procedure.** A mutation's `ctx.db` writes ride
 * its storage transaction, so a handler that throws after `limit()` rolls the
 * consumed unit back with everything else — inside a mutation this store counts
 * successful calls, not attempts. To charge every attempt (a login limiter),
 * consume from an action, where each write commits on its own, or return a
 * failure value from the mutation instead of throwing. A `.global()` table's
 * row lives in D1, outside the DO transaction, so there the unit stays spent.
 */
const createDatabaseStore = (options: DatabaseStoreOptions): RateLimitStore => {
    const { db } = options;
    const table = options.table ?? "rateLimits";
    const keyField = options.keyField ?? "key";

    // The limiter's hot path is get() immediately followed by set(). Caching the
    // row id (or its absence) resolved by get()'s find() lets set()/delete()
    // write directly instead of repeating the lookup. A lost race or a write
    // drops the entry, so the next get() re-reads.
    const idCache = new Map<string, Id<string> | undefined>();

    // Set once the sweep has found an adapter it cannot use; see `sweep`.
    let warnedUnsweepable = false;

    const find = async (storageKey: string): Promise<Record<string, unknown> | null> => {
        const row = await db.findFirst(table, { where: { [keyField]: storageKey } });

        idCache.set(storageKey, row ? (row._id as Id<string>) : undefined);

        return row;
    };

    // The row id resolved by the most recent find(): the id when a row matched,
    // or a cached `undefined` (tracked via `idCache.has()`) when it didn't.
    const resolveId = async (storageKey: string): Promise<Id<string> | undefined> => {
        if (!idCache.has(storageKey)) {
            await find(storageKey);
        }

        return idCache.get(storageKey);
    };

    const documentFor = (storageKey: string, value: RateLimitValue): Record<string, unknown> => {
        const document: Record<string, unknown> = { [keyField]: storageKey, ts: value.ts, value: value.value };

        if (value.prev !== undefined) {
            document.prev = value.prev;
        }

        return document;
    };

    const create = async (storageKey: string, document: Record<string, unknown>): Promise<boolean> => {
        try {
            idCache.set(storageKey, await db.insert(table, document, { clientId: await rowIdFor(table, storageKey) }));

            return true;
        } catch (error) {
            if (isConflict(error)) {
                idCache.delete(storageKey);

                return false;
            }

            throw error;
        }
    };

    return {
        delete: async (storageKey) => {
            const id = await resolveId(storageKey);

            if (id !== undefined) {
                await db.delete(table, id);
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
            const document = documentFor(storageKey, value);
            let id = await resolveId(storageKey);

            if (id === undefined) {
                if (await create(storageKey, document)) {
                    return;
                }

                // Someone else created the row first: overwrite it, as `set` always does.
                await find(storageKey);
                id = idCache.get(storageKey);
            }

            if (id !== undefined) {
                await db.patchIf(table, id, { patch: document, where: {} });
            }
        },
        setIf: async (storageKey, value, prior) => {
            const document = documentFor(storageKey, value);

            if (prior === undefined) {
                // No row was read: create it, or lose to whoever did.
                return create(storageKey, document);
            }

            const id = await resolveId(storageKey);

            if (id === undefined) {
                return false;
            }

            const { applied } = await db.patchIf(table, id, {
                patch: document,
                // eslint-disable-next-line unicorn/no-null -- an absent `prev` is stored as SQL NULL, and only a null filter matches it
                where: { prev: prior.prev ?? null, ts: prior.ts, value: prior.value },
            });

            if (!applied) {
                idCache.delete(storageKey);
            }

            return applied;
        },
        sweep: async (olderThanTs, limit, owns) => {
            if (db.findMany === undefined) {
                // An adapter without a batch read cannot sweep. Say so once, not after every write.
                if (!warnedUnsweepable) {
                    warnedUnsweepable = true;
                    // eslint-disable-next-line no-console -- intentional: the store has no logger; a missing sweep is a one-time configuration notice
                    console.warn(`@lunora/ratelimit: table "${table}" is not swept: the adapter has no findMany. Pass the framework's ctx.db.`);
                }

                return;
            }

            const { page } = await db.findMany(table, {
                limit,
                orderBy: [{ ts: "asc" }],
                where: { ts: { lte: olderThanTs }, value: { gte: 0 } },
            });

            const owned = page.filter((row) => owns?.(String(row[keyField])) !== false);

            await Promise.all(
                owned.map(async (row) => {
                    // Delete only the row the sweep read: a consume that refreshed it since then
                    // changed ts, value or prev, so the re-read finds nothing and the row is kept.
                    // That is still a read followed by a delete, so on `.global()` a refresh
                    // between the two steps is lost (see the JSDoc ceiling).
                    // eslint-disable-next-line unicorn/no-null -- an absent `prev` is stored as SQL NULL, and only a null filter matches it
                    const current = await db.findFirst(table, { where: { _id: row["_id"], prev: row["prev"] ?? null, ts: row["ts"], value: row["value"] } });

                    if (current !== null) {
                        await db.delete(table, row["_id"] as Id<string>);
                    }
                }),
            );
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
            findFirst: options.db.findFirst.bind(options.db),
            insert: () => reject("insert"),
            patchIf: () => reject("patchIf"),
        },
    });

    return {
        delete: () => reject("reset"),
        get: readable.get,
        set: () => reject("limit"),
        setIf: () => reject("limit"),
    };
};

export type {
    DatabaseStoreOptions as DbStoreOptions,
    RateLimitDatabase as RateLimitDb,
    RateLimitDatabaseReader as RateLimitDbReader,
    ReadOnlyDatabaseStoreOptions as ReadOnlyDbStoreOptions,
    SqlLike,
    SqlStoreOptions,
};
export { createDatabaseStore as createDbStore, createMemoryStore, createReadOnlyDatabaseStore as createReadOnlyDbStore, createSqlStore };
