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

import { AsyncLocalStorage } from "node:async_hooks";

import { LunoraError } from "@lunora/errors";
import type { ShardAlarms, ShardHost, ShardSqlCursor, ShardSqlExec, SqlRow } from "@lunora/platform";
import Database from "better-sqlite3";

/**
 * Largest delay `setTimeout` accepts as a 32-bit signed integer. Any delay
 * above this (~24.8 days) is clamped to 1 ms with a `TimeoutOverflowWarning`,
 * which would fire an alarm or job far ahead of its target timestamp.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * How many times a throwing alarm handler is re-delivered before the wakeup is
 * abandoned, and the first backoff step. workerd retries a Durable Object's
 * `alarm()` with exponential backoff and gives up after a bounded number of
 * attempts; this host mirrors the shape, not the constants — its backoff starts
 * an order of magnitude shorter because a redelivery here is a `setTimeout` in
 * a process that is already warm, not a cold object wake.
 */
const ALARM_RETRY_LIMIT = 6;
const ALARM_RETRY_BASE_MS = 100;

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
 * Build the `ShardSqlExec` (sync) executor over one `better-sqlite3`
 * connection.
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
const createSql = (database: Database.Database, assertOwnTurn: (action: string) => void): ShardSqlExec => {
    return {
        // A live getter: recomputed per read from PRAGMA, matching Cloudflare's
        // "recomputed on each read, do not cache" contract note.
        get databaseSize(): number | undefined {
            const pageCount = database.pragma("page_count", { simple: true }) as number;
            const pageSize = database.pragma("page_size", { simple: true }) as number;

            return pageCount * pageSize;
        },
        exec: <Row = SqlRow>(query: string, ...bindings: ReadonlyArray<unknown>): ShardSqlCursor<Row> => {
            assertOwnTurn("run SQL");

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

/**
 * Build the `ShardAlarms` surface: a timestamp persisted to SQLite, an
 * in-process `setTimeout` that delivers it, and — the part that makes the two
 * add up to the contract — a re-arm on construction.
 *
 * `ShardAlarms`'s docstring promises alarms "survive host recycling and fire at
 * the requested timestamp". Cloudflare gets both halves from the runtime: DO
 * storage holds the timestamp and workerd re-delivers `alarm()` to a freshly
 * woken object. A Node process has no runtime to lean on, so this host owns
 * both halves itself — the row in `_lunora_alarm` is the durable half, and
 * reading it back when a host is constructed over the same database file is the
 * delivery half. An alarm whose timestamp already elapsed while the process was
 * down fires immediately on the next construction rather than being dropped,
 * which is the at-least-once behavior a caller that scheduled it is owed.
 *
 * Delivery goes to `onAlarm`, because `ShardAlarms` deliberately has no
 * callback of its own — on Cloudflare the runtime invokes the DO's `alarm()`
 * method, so the contract models scheduling and leaves delivery to the host.
 * A caller that supplies no `onAlarm` still gets the durable timestamp and the
 * `get()`-clears-on-fire transition; it simply has nowhere for the wakeup to
 * land.
 *
 * Two things follow from owning delivery that a host leaning on a runtime gets
 * for free, and this one used to get wrong: a handler that throws is
 * re-delivered with backoff rather than dropped, and an alarm mutation made
 * inside a `transaction` lands with that transaction rather than ahead of it.
 */
const createAlarms = (
    database: Database.Database,
    transaction: { assertOwnTurn: (action: string) => void; inside: () => boolean },
    onAlarm?: () => Promise<void> | void,
): { alarms: ShardAlarms; commit: () => void; dispose: () => void; rollback: () => void } => {
    let alarmAt: number | undefined;
    let alarmTimeout: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;

    /**
     * An alarm mutation made inside a `transaction`, held until it commits.
     *
     * The durable row is written through the caller's open transaction and
     * rolls back with it, but the in-memory timestamp and the `setTimeout` are
     * process state with no rollback of their own — arming them eagerly left a
     * shard that fired an alarm this process still believed in and no restart
     * would ever re-deliver. Deferring the arm to commit makes the two halves
     * agree; `get()` still reads the pending value, because a transaction must
     * observe its own writes.
     */
    let pending: undefined | { at: number | undefined };

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

    const clearAlarmTimeout = (): void => {
        if (alarmTimeout !== undefined) {
            clearTimeout(alarmTimeout);
            alarmTimeout = undefined;
        }
    };

    /**
     * Arm the in-process timer for `ms`. Shared by `set` and by the
     * construction-time re-arm below, so a restored alarm fires through exactly
     * the same path as a freshly scheduled one.
     */
    const arm = (ms: number): void => {
        clearAlarmTimeout();

        const delay = Math.max(0, ms - Date.now());

        // `setTimeout` clamps any delay above 2^31 - 1 ms (~24.8 days) down to
        // 1 ms and warns (`TimeoutOverflowWarning`), so an alarm set further
        // out would fire immediately — the durable row deleted, the wakeup
        // weeks early, the original timestamp unrecoverable. Re-arm in
        // maximum-sized chunks until the target is close enough to pass whole.
        if (delay > MAX_TIMEOUT_MS) {
            alarmTimeout = setTimeout(() => {
                arm(ms);
            }, MAX_TIMEOUT_MS);

            return;
        }

        alarmTimeout = setTimeout(() => {
            alarmAt = undefined;
            alarmTimeout = undefined;

            // A caller may close the database before this timer fires — e.g.
            // it set a future alarm, then tore the platform down (process
            // shutdown, test cleanup). `persist` runs a prepared statement
            // against `database`; on a closed better-sqlite3 connection that
            // throws synchronously *inside* the `setTimeout` callback, which
            // is an uncaught exception Node has no way to route back to a
            // caller's try/catch — it crashes the process. Guard on the
            // connection's own open/closed state rather than trying to track
            // "did dispose() already run" separately, since `close()` is the
            // one fact that actually determines whether `.run()` is safe.
            if (!database.open) {
                return;
            }

            // Clear the durable row BEFORE delivering. An `onAlarm` that throws
            // (or that itself schedules the next alarm, which is the normal
            // pattern) must not race a stale row: the timestamp this timer just
            // consumed is spent either way, and leaving it behind would re-fire
            // it on the next construction over this database.
            persist(undefined);

            (async (): Promise<void> => {
                await onAlarm?.();
                attempts = 0;
            })().catch(() => {
                // A throwing handler must not become an unhandled rejection
                // that takes the process down — but it must not lose the wakeup
                // either. workerd isolates a throwing `alarm()` AND re-delivers
                // it with backoff; a host that only isolated it deleted the row
                // before delivery and then swallowed the rejection, so nothing
                // re-armed and the loop that alarm drives (a TTL sweep, a
                // global-shape poll, a scheduler GC) stopped for good.
                if (!database.open || alarmAt !== undefined) {
                    // Nothing to retry against, or the handler rescheduled
                    // before it failed — that alarm owns the next wakeup.
                    return;
                }

                attempts += 1;

                if (attempts > ALARM_RETRY_LIMIT) {
                    attempts = 0;

                    return;
                }

                const retryAt = Date.now() + ALARM_RETRY_BASE_MS * 2 ** (attempts - 1);

                alarmAt = retryAt;
                persist(retryAt);
                arm(retryAt);
            });
        }, delay);
    };

    const alarms: ShardAlarms = {
        delete: () => {
            // The connection's own open state IS closed-ness (see the module
            // docstring below and `dispose`'s callback comment) — checked
            // BEFORE any mutation, so a closed platform's alarm state is never
            // touched by a call that is about to throw.
            if (!database.open) {
                throw new Error("platform closed: cannot delete an alarm");
            }

            transaction.assertOwnTurn("delete an alarm");

            attempts = 0;
            persist(undefined);

            if (transaction.inside()) {
                pending = { at: undefined };

                return;
            }

            alarmAt = undefined;
            clearAlarmTimeout();
        },
        // The contract's `get` returns `number | null`, not `number | undefined`
        // — the one place this file's internal `undefined` convention has to
        // cross back over the contract boundary.
        // eslint-disable-next-line unicorn/no-null -- platform contract uses null
        get: () => (pending === undefined ? alarmAt : pending.at) ?? null,
        set: (timestamp: number | Date) => {
            if (!database.open) {
                throw new Error("platform closed: cannot set an alarm");
            }

            transaction.assertOwnTurn("set an alarm");

            const ms = typeof timestamp === "number" ? timestamp : timestamp.getTime();

            attempts = 0;
            persist(ms);

            if (transaction.inside()) {
                pending = { at: ms };

                return;
            }

            alarmAt = ms;
            arm(ms);
        },
    };

    /** Apply an alarm mutation the enclosing transaction just committed. */
    const commit = (): void => {
        if (pending === undefined) {
            return;
        }

        const { at } = pending;

        pending = undefined;

        if (at === undefined) {
            alarmAt = undefined;
            clearAlarmTimeout();

            return;
        }

        alarmAt = at;
        arm(at);
    };

    /**
     * Discard an alarm mutation whose transaction rolled back. The durable row
     * rolled back with it and the in-memory state was never touched, so
     * dropping the pending value is the whole undo.
     */
    const rollback = (): void => {
        pending = undefined;
    };

    // Re-arm whatever the last process left behind. `Math.max(0, …)` inside
    // `arm` means an alarm whose time passed while nothing was running fires on
    // the next tick rather than never — late, but delivered.
    const restored = database.prepare<[], { scheduled_for: number }>("SELECT scheduled_for FROM _lunora_alarm WHERE id = 0").get();

    if (restored !== undefined) {
        alarmAt = restored.scheduled_for;
        arm(restored.scheduled_for);
    }

    return { alarms, commit, dispose: clearAlarmTimeout, rollback };
};

/** Options for {@link createNodeShardHost}. */
interface NodeShardHostOptions {
    /**
     * Called when a durable alarm comes due — this host's stand-in for the
     * `alarm()` method workerd invokes on a Durable Object. Fires for alarms
     * set during this process's lifetime AND for one restored from
     * `_lunora_alarm` when the host is constructed over an existing database,
     * including an alarm whose time elapsed while nothing was running.
     *
     * A handler that throws is isolated to its own delivery — it never reaches
     * the caller that set the alarm, because by then that call has long
     * returned — and the wakeup is then re-delivered with backoff up to
     * {@link ALARM_RETRY_LIMIT} times, the way workerd retries a throwing
     * `alarm()`. Delivery is at-least-once, so the handler must tolerate
     * running twice for one scheduled timestamp.
     */
    onAlarm?: () => Promise<void> | void;

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
 * it. It runs on its own private `transactionTail` chain, the same shape as
 * `runSerialized`'s but never shared with it: two bare, overlapping
 * `transaction()` calls on this host serialize against each other rather than
 * corrupting each other's commits (raw `BEGIN` on a connection already inside
 * a transaction throws, or worse, interleaves). Routing `transaction` through
 * `runSerialized` itself would deadlock, since the engine already composes
 * `runSerialized(() => transaction(work))` — the inner enqueue would then wait
 * on the outer closure awaiting it.
 *
 * The returned `dispose()` is this host's lifecycle owner: it clears the
 * pending alarm `setTimeout` (so it can never fire against a connection this
 * call is about to close) and then closes the database. Call it whenever a
 * caller is done with the host — composition roots (`createNodePlatform`,
 * the conformance host) route their own `close()`/`cleanup()` through it
 * rather than closing `database` directly, so the alarm timer and the
 * connection are always retired together.
 */
const createNodeShardHost = (
    options: NodeShardHostOptions = {},
): { database: Database.Database; dispose: () => void; drain: () => Promise<void>; host: ShardHost } => {
    const database = new Database(options.path ?? ":memory:");

    database.pragma("journal_mode = WAL");

    /**
     * Whether the caller is running inside this host's own `transaction`.
     *
     * Cloudflare's isolation here is the input gate: while a mutation holds
     * `blockConcurrencyWhile`, no other event is delivered to the object, so
     * nothing else can read the transaction's uncommitted rows. A Node process
     * has no such gate — dispatch never enters this host — and every caller
     * shares one `better-sqlite3` connection, on which an open `BEGIN`'s writes
     * are visible to any read issued from another task while the mutation
     * awaits real I/O. `ShardSqlExec.exec` is synchronous and so cannot be
     * queued behind the closure the way Cloudflare queues the whole dispatch;
     * what it CAN do is refuse, which keeps `ShardHost`'s "no partial writes are
     * observable" true instead of answering with rows that are about to roll
     * back.
     *
     * The refusal is `SHARD_UNAVAILABLE`/503 — catalogued and retryable —
     * rather than a bare `Error`. A query dispatch is deliberately NOT inside
     * the transaction's scope, so on this host every read that lands while a
     * mutation is mid-await is refused; an uncatalogued throw is redacted to an
     * `INTERNAL` 500 by `toErrorBody`, which no client retries, turning an
     * ordinary "not this instant" into a hard failure. `SHARD_UNAVAILABLE` is
     * already in the runtime's and the client's transient set.
     */
    const transactionScope = new AsyncLocalStorage<true>();
    let transactionOpen = false;

    const assertOwnTurn = (action: string): void => {
        if (transactionOpen && transactionScope.getStore() !== true) {
            throw new LunoraError("SHARD_UNAVAILABLE", `shard busy: cannot ${action} while another task holds this shard's transaction`);
        }
    };

    const sql = createSql(database, assertOwnTurn);
    const {
        alarms,
        commit: commitAlarms,
        dispose: disposeAlarms,
        rollback: rollbackAlarms,
    } = createAlarms(database, { assertOwnTurn, inside: () => transactionScope.getStore() === true }, options.onAlarm);

    /**
     * Background work handed to `waitUntil`, held until it settles.
     *
     * Retaining the promise is the whole job: a Node process has no
     * request/response boundary to extend past, so the only thing the contract's
     * `waitUntil` can meaningfully do here is make sure the work is not
     * dropped*. A bare no-op left a rejected background promise with no
     * handler attached, which Node surfaces as an unhandled rejection and — on
     * the default `--unhandled-rejections=throw` — kills the process. The set
     * also gives `drain()` something to await on shutdown.
     */
    const background = new Set<Promise<unknown>>();

    let tail: Promise<unknown> = Promise.resolve();

    const runSerialized: ShardHost["runSerialized"] = (function_) => {
        const started = tail.then(function_, function_);

        tail = started.then(
            () => undefined,
            () => undefined,
        );

        return started;
    };

    // A second, private tail chain of the exact same shape as `runSerialized`
    // above, used ONLY by `transaction`. Raw BEGIN/COMMIT/ROLLBACK on a shared
    // connection is not safe under overlap — a second `transaction()` call
    // that starts before the first commits either throws "cannot start a
    // transaction within a transaction" on the second BEGIN, or (worse) its
    // COMMIT commits the first's uncommitted writes and the first's ROLLBACK
    // then discards work that already reported success.
    //
    // Routing `transaction` through the SAME `runSerialized`/`tail` chain
    // would deadlock: the engine composes them as
    // `runSerialized(() => transaction(work))` (`shard-runner.ts`), so the
    // inner enqueue would wait on the outer closure that is awaiting it. This
    // dedicated lane serializes bare, overlapping `transaction()` calls
    // against each other (the actual bug) while leaving `runInTransaction`'s
    // composition free of self-deadlock (the outer gate is `runSerialized`,
    // the inner lane is always empty when it runs).
    let transactionTail: Promise<unknown> = Promise.resolve();

    const runTransaction = async <T>(function_: () => Promise<T>): Promise<T> => {
        database.exec("BEGIN");
        transactionOpen = true;

        try {
            const result = await transactionScope.run(true, function_);

            database.exec("COMMIT");
            transactionOpen = false;
            commitAlarms();

            return result;
        } catch (error) {
            transactionOpen = false;
            rollbackAlarms();

            try {
                database.exec("ROLLBACK");
            } catch {
                // A failed rollback (a handle closed mid-transaction by a teardown
                // racing an in-flight mutation, or inner work that already ended
                // the transaction) must not mask the original throw — the caller
                // needs the real failure, not the cleanup's. `@lunora/testing`'s
                // harness copy of this guards it; the two host copies did not.
            }

            throw error;
        }
    };

    const transaction: ShardHost["transaction"] = <T>(function_: () => Promise<T>): Promise<T> => {
        const started = transactionTail.then(
            () => runTransaction(function_),
            () => runTransaction(function_),
        );

        transactionTail = started.then(
            () => undefined,
            () => undefined,
        );

        return started;
    };

    const host: ShardHost = {
        alarms,
        runSerialized,
        shardKey: options.shardKey,
        sql,
        transaction,
        waitUntil: (promise) => {
            const tracked = promise
                .catch(() => {
                    // Swallowed on purpose — see `background`. Background work
                    // that fails has no caller left to tell.
                })
                .finally(() => {
                    background.delete(tracked);
                });

            background.add(tracked);
        },
    };

    /**
     * Wait for every promise handed to `waitUntil` to settle.
     *
     * Kept separate from `dispose()` because the two answer different
     * questions: `dispose()` releases handles and must stay synchronous (it
     * backs `Symbol.dispose`), while draining is inherently awaitable. A
     * graceful shutdown does `await drain()` then `dispose()`; a test that only
     * needs the file handle back calls `dispose()` alone. Re-entrant by
     * construction: each pass awaits the set as it stood, and background work
     * that spawns more background work is picked up by the next loop.
     */
    const drain = async (): Promise<void> => {
        while (background.size > 0) {
            // eslint-disable-next-line no-await-in-loop -- sequential is the point: each pass drains the set as it stood, and background work that spawned more background work is picked up by the next iteration. Hoisting the await out would settle only the first generation.
            await Promise.all(background);
        }
    };

    const dispose = (): void => {
        disposeAlarms();

        if (database.open) {
            database.close();
        }
    };

    return { database, dispose, drain, host };
};

export type { NodeShardHostOptions };
export { createNodeShardHost };
