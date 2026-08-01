/**
 * Node adapter: turn a `better-sqlite3` database into the provider-neutral
 * `@lunora/platform` `ShardHost` contract — single-writer serialization, local
 * SQL, durable transactions, alarms.
 *
 * This is the same contract `@lunora/platform-cloudflare`'s `createShardHost`
 * satisfies over `DurableObjectState.storage`, and the same shape
 * `@lunora/platform`'s `node:sqlite` reference host satisfies for the TCK.
 * This version hardens toward a real implementation: a `better-sqlite3`
 * database backed by a real file (not `:memory:`), so state survives a
 * `close()`/reopen against the same path — the closest a single Node process
 * gets to Cloudflare's Durable Object recycle-and-rehydrate cycle.
 */

import type { ShardAlarms, ShardAsyncSqlExec, ShardHost, ShardSqlCursor, ShardSqlExec, SqlRow } from "@lunora/platform";
import Database from "better-sqlite3";

/**
 * A `better-sqlite3` binding value. `null` (not `undefined`) is the native
 * binding's own spelling of SQL `NULL` — the one place in this file that has
 * to use it, since better-sqlite3's FFI has no other way to write one.
 */
type SqliteBindable = bigint | Buffer | number | string | null;

/**
 * `better-sqlite3` rejects `undefined` bindings outright (`TypeError: … is
 * not supported`); the engine routinely passes `undefined` for an omitted
 * column. Same normalization the reference host applies to `node:sqlite`.
 */
const normalizeBinding = (value: unknown): SqliteBindable =>
    // eslint-disable-next-line unicorn/no-null -- converting to better-sqlite3's NULL sentinel, not returning null from this package's own API
    value === undefined ? null : (value as SqliteBindable);

/**
 * Build the `ShardSqlExec` (sync) and `ShardAsyncSqlExec` (promise-wrapped)
 * executors over one `better-sqlite3` connection.
 *
 * Unlike the `node:sqlite` reference host — which sniffs `select` off the
 * trimmed, lowercased query text to decide `.all()` vs `.run()` — this uses
 * `Statement.reader`, better-sqlite3's own classification of whether a
 * prepared statement produces rows. That is more correct (a `WITH … INSERT`
 * CTE, or `RETURNING`, is a writer that still lacks a leading `select`) and it
 * is the kind of hardening a real implementation earns over its own reference
 * host — a text-sniffing heuristic was good enough to unblock a TCK run, not
 * to ship.
 */
const createSql = (database: Database.Database): ShardSqlExec => {
    return {
        // A live getter: recomputed per read from PRAGMA, matching Cloudflare's
        // "recomputed on each read, do not cache" contract note.
        get databaseSize(): number | undefined {
            const pageCount = database.pragma("page_count", { simple: true }) as number;
            const pageSize = database.pragma("page_size", { simple: true }) as number;

            return pageCount * pageSize;
        },
        exec: <Row = SqlRow>(query: string, ...bindings: ReadonlyArray<unknown>): ShardSqlCursor<Row> => {
            const statement = database.prepare(query);
            const normalized = bindings.map((value) => normalizeBinding(value));

            const rows = (
                statement.reader
                    ? statement.all(...normalized)
                    : ((): unknown[] => {
                          statement.run(...normalized);

                          return [];
                      })()
            ) as Row[];

            return {
                [Symbol.iterator]: () => rows[Symbol.iterator](),
                one: () => {
                    if (rows.length !== 1) {
                        throw new Error(`expected exactly one row, got ${String(rows.length)}`);
                    }

                    return rows[0] as Row;
                },
                toArray: () => [...rows],
            };
        },
    };
};

const createAsyncSql = (database: Database.Database): ShardAsyncSqlExec => {
    return {
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract's async surface wraps a synchronous engine; no await needed, but the return type is a Promise
        all: async (query, params) => {
            const statement = database.prepare(query);

            return statement.all(...params.map((value) => normalizeBinding(value))) as SqlRow[];
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `all`
        run: async (query, params) => {
            const statement = database.prepare(query);
            const result = statement.run(...params.map((value) => normalizeBinding(value)));

            return { rowsAffected: result.changes };
        },
    };
};

/**
 * Build the `ShardAlarms` surface over an in-process `setTimeout`.
 *
 * This is the finding the spike's write-up leads with: an alarm that only
 * fires within the lifetime of the current Node process is not what
 * `ShardAlarms`'s docstring promises — "survive host recycling". SQLite could
 * persist the timestamp trivially — the gap is that nothing re-arms the timer
 * on process start, and a Node host has no host-level scheduler to do that for
 * it the way Cloudflare's runtime re-delivers alarms after an evicted DO
 * wakes. Persisting the timestamp without re-arming would be worse than not
 * persisting it: a caller reading `get()` after a restart would see a
 * "pending" alarm that will never fire.
 */
const createAlarms = (database: Database.Database): ShardAlarms => {
    let alarmAt: number | undefined;
    let alarmTimeout: ReturnType<typeof setTimeout> | undefined;

    database.exec("CREATE TABLE IF NOT EXISTS _lunora_alarm (id INTEGER PRIMARY KEY CHECK (id = 0), scheduled_for INTEGER NOT NULL)");

    const persist = (timestamp: number | undefined): void => {
        if (timestamp === undefined) {
            database.prepare("DELETE FROM _lunora_alarm WHERE id = 0").run();
        } else {
            database
                .prepare("INSERT INTO _lunora_alarm (id, scheduled_for) VALUES (0, ?) ON CONFLICT (id) DO UPDATE SET scheduled_for = excluded.scheduled_for")
                .run(timestamp);
        }
    };

    return {
        delete: () => {
            alarmAt = undefined;

            if (alarmTimeout !== undefined) {
                clearTimeout(alarmTimeout);
                alarmTimeout = undefined;
            }

            persist(undefined);
        },
        // The contract's `get` returns `number | null`, not `number | undefined`
        // — the one place this file's internal `undefined` convention has to
        // cross back over the contract boundary.
        // eslint-disable-next-line unicorn/no-null -- platform contract uses null
        get: () => alarmAt ?? null,
        set: (timestamp: number | Date) => {
            const ms = typeof timestamp === "number" ? timestamp : timestamp.getTime();

            alarmAt = ms;
            persist(ms);

            if (alarmTimeout !== undefined) {
                clearTimeout(alarmTimeout);
            }

            const delay = Math.max(0, ms - Date.now());

            alarmTimeout = setTimeout(() => {
                alarmAt = undefined;
                persist(undefined);
            }, delay);
        },
    };
};

/** Options for {@link createNodeShardHost}. */
interface NodeShardHostOptions {
    /**
     * SQLite database file. Defaults to `:memory:` (matching the reference
     * host) — pass a real path to exercise cross-process persistence, the one
     * axis the in-memory reference host cannot.
     */
    path?: string;

    /**
     * The shard key this host serves, threaded through to `ShardHost.shardKey`.
     * Cloudflare derives this from `state.id.name`; a Node host has no
     * equivalent addressing scheme, so the caller supplies it.
     */
    shardKey?: string;
}

/**
 * Build a `ShardHost` over a real `better-sqlite3` database.
 *
 * `runSerialized` chains onto a single `tail` promise rather than the
 * reference host's explicit job-array-plus-drain-loop: every queued closure
 * runs once `tail` settles, and `tail` is reset to a version that always
 * resolves (never rejects) so one job's failure cannot wedge the queue for
 * every job after it — the same "no two closures interleave" guarantee,
 * fewer moving parts to get wrong.
 *
 * `transaction` issues raw `BEGIN`/`COMMIT`/`ROLLBACK` — legal here (unlike
 * inside a Cloudflare Durable Object, where the runtime forbids it and
 * callers must use `storage.transaction`) because better-sqlite3 is a plain
 * embedded database with no platform-level transaction primitive layered over
 * it.
 */
const createNodeShardHost = (options: NodeShardHostOptions = {}): { database: Database.Database; host: ShardHost } => {
    const database = new Database(options.path ?? ":memory:");

    database.pragma("journal_mode = WAL");

    const sql = createSql(database);
    const asyncSql = createAsyncSql(database);
    const alarms = createAlarms(database);

    let tail: Promise<unknown> = Promise.resolve();

    const runSerialized: ShardHost["runSerialized"] = (function_) => {
        const started = tail.then(function_, function_);

        tail = started.then(
            () => undefined,
            () => undefined,
        );

        return started;
    };

    const transaction: ShardHost["transaction"] = async (function_) => {
        database.exec("BEGIN");

        try {
            const result = await function_();

            database.exec("COMMIT");

            return result;
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
    };

    const host: ShardHost = {
        alarms,
        asyncSql,
        runSerialized,
        shardKey: options.shardKey,
        sql,
        transaction,
        waitUntil: () => {
            // A Node process has no separate request/background lifetime split —
            // there is no response to return before background work finishes —
            // so, like the reference host, this is a documented no-op rather than
            // a fire-and-forget that could outlive the process silently.
        },
    };

    return { database, host };
};

export type { NodeShardHostOptions };
export { createNodeShardHost };
