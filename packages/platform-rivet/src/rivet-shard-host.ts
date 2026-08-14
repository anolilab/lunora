/**
 * Rivet adapter: a Rivet Actor as the provider-neutral `@lunora/platform`
 * `ShardHost` — single-writer serialization, local SQL, durable transactions,
 * durable alarms, background continuation.
 *
 * Of the four contracts this package implements, `ShardHost` is the one Rivet
 * fits best and the one that needed the most work, for the same reason: an
 * actor *is* a shard, but its storage is asynchronous and the engine's is not.
 *
 * - **Single-writer** is free. Rivet serializes work on one actor already, so
 * `runSerialized` only has to preserve that guarantee across the promise
 * chain rather than establish it. The queue is still built here, because
 * `runSerialized` is also called from `onRequest` and `onWebSocket` handlers
 * that Rivet does *not* serialize against each other.
 * - **Local SQL** runs against the synchronous working copy (see
 * `./rivet-shard-state`), which is where the async/sync bridge lives.
 * - **Transactions** are the working copy's own `BEGIN`/`COMMIT`, followed by a
 * snapshot flush. The commit is not reported to the caller until the snapshot
 * is durable in Rivet's SQLite — otherwise `transaction()` would resolve on a
 * write that a sleep could still lose.
 * - **Alarms** are Rivet's own `c.schedule.at`, which is strictly better than
 * what a Node host can offer: it survives sleep, restart, upgrade and crash,
 * and Rivet wakes the actor to deliver it.
 */

import { LunoraError } from "@lunora/errors";
import type { ShardAlarms, ShardAsyncSqlExec, ShardHost, ShardSqlCursor, ShardSqlExec, SqlRow } from "@lunora/platform";
import type Database from "better-sqlite3";

import type { RivetActorLike } from "./rivet-context";
import type { RivetShardState } from "./rivet-shard-state";

/**
 * The Rivet action a shard alarm is delivered to.
 *
 * Rivet schedules invoke an **action on the same actor**, not a callback, so
 * the actor definition has to carry a handler under this name that calls
 * {@link RivetShardHost.deliverAlarm}. Exported so an app wires the name rather
 * than retyping the string — a typo there is an alarm that silently never
 * arrives.
 */
const RIVET_ALARM_ACTION = "__lunoraShardAlarm";

/**
 * A `better-sqlite3` binding value. `null` is the driver's own spelling of SQL
 * `NULL`; the engine routinely passes `undefined` for an omitted column, which
 * better-sqlite3 rejects outright.
 */
type SqliteBindable = bigint | Buffer | number | string | null;

// eslint-disable-next-line unicorn/no-null -- converting to better-sqlite3's NULL sentinel, not returning null from this package's own API
const normalizeBinding = (value: unknown): SqliteBindable => (value === undefined ? null : (value as SqliteBindable));

/**
 * Build the synchronous SQL executor over the working copy.
 *
 * Two *different* questions are asked of each statement, and conflating them
 * silently loses writes:
 *
 * - **"Does it produce rows?"** — `Statement.reader`, which picks `.all()` over
 * `.run()`.
 * - **"Does it change the database?"** — `Statement.readonly`, which decides
 * whether the shard is marked dirty and therefore whether the next boundary
 * snapshots it.
 *
 * `INSERT … RETURNING` is both: a reader *and* a writer. Deriving dirtiness
 * from `reader` (or from a "does the text start with SELECT" heuristic, which
 * is what a first cut usually reaches for) classifies it as a read, and the row
 * it inserted is then absent from the snapshot — a committed write that
 * disappears on the next sleep, with nothing failing in between.
 */
const createSql = (state: RivetShardState): ShardSqlExec => {
    const { database } = state;

    return {
        // A live getter, matching Cloudflare's "recomputed on each read, do not
        // cache" note. Here it also happens to be the number that predicts
        // snapshot cost, since a flush serializes exactly these bytes.
        get databaseSize(): number | undefined {
            const pageCount = database.pragma("page_count", { simple: true }) as number;
            const pageSize = database.pragma("page_size", { simple: true }) as number;

            return pageCount * pageSize;
        },
        exec: <Row = SqlRow>(query: string, ...bindings: ReadonlyArray<unknown>): ShardSqlCursor<Row> => {
            const statement = database.prepare(query);
            const normalized = bindings.map((value) => normalizeBinding(value));

            let rows: Row[];

            if (statement.reader) {
                rows = statement.all(...normalized) as Row[];
            } else {
                statement.run(...normalized);
                rows = [];
            }

            if (!statement.readonly) {
                state.markDirty();
            }

            return {
                [Symbol.iterator]: () => rows[Symbol.iterator](),
                one: () => {
                    if (rows.length !== 1) {
                        throw new LunoraError("INTERNAL_ERROR", `@lunora/platform-rivet: expected exactly one row, got ${String(rows.length)}`);
                    }

                    return rows[0] as Row;
                },
                toArray: () => [...rows],
            };
        },
    };
};

/**
 * The async executor the engine's higher-level paths use.
 *
 * Backed by the same working copy rather than by Rivet's `c.db`, and
 * deliberately so: the two must observe the same rows. Routing this half at
 * Rivet's database would give one shard two stores that agree only at flush
 * time, and a read here would miss a write made through `sql` in the same
 * transaction.
 */
const createAsyncSql = (state: RivetShardState): ShardAsyncSqlExec => {
    const { database } = state;

    return {
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract's async surface over a synchronous working copy; the Promise is the contract, not the implementation
        all: async (query, parameters) => database.prepare(query).all(...parameters.map((value) => normalizeBinding(value))) as SqlRow[],
        // eslint-disable-next-line @typescript-eslint/require-await -- see `all`
        run: async (query, parameters) => {
            const result = database.prepare(query).run(...parameters.map((value) => normalizeBinding(value)));

            state.markDirty();

            return { rowsAffected: result.changes };
        },
    };
};

/** Options for {@link createRivetShardHost}. */
interface RivetShardHostOptions {
    /**
     * Called when a shard alarm fires — this host's stand-in for the `alarm()`
     * method workerd invokes on a Durable Object.
     *
     * Delivery is driven by {@link RivetShardHost.deliverAlarm}, which the
     * actor's {@link RIVET_ALARM_ACTION} handler calls. A host given no
     * `onAlarm` still schedules and cancels correctly; the wakeup simply has
     * nowhere to land.
     */
    onAlarm?: () => Promise<void> | void;
}

/** The shard host plus the delivery entry point its Rivet action needs. */
interface RivetShardHost {
    /**
     * Deliver a fired alarm. Called from the actor's {@link RIVET_ALARM_ACTION}
     * handler.
     *
     * Clears the pending alarm **before** invoking `onAlarm`, because the
     * normal pattern for an alarm handler is to schedule the next one — a
     * handler that did so against a stale pending id would have its new alarm
     * overwritten by the bookkeeping of the one that just fired.
     */
    deliverAlarm: () => Promise<void>;

    /**
     * Wait for every promise handed to `waitUntil` to settle.
     *
     * Separate from Rivet's own `waitUntil`, which bounds the work against the
     * actor's sleep grace period: this resolves when the work is actually done,
     * which is what a graceful teardown and a deterministic test both need.
     */
    drain: () => Promise<void>;
    /** The `ShardHost` contract implementation. */
    host: ShardHost;
}

/**
 * Build a `ShardHost` over one Rivet actor and its working copy.
 *
 * `runSerialized` chains onto a single `tail` promise that is reset to a
 * never-rejecting version, so one closure's failure cannot wedge every closure
 * behind it. `transaction` runs on a **private** second chain of the same
 * shape: two overlapping bare `transaction()` calls must serialize against each
 * other (raw `BEGIN` inside an open transaction either throws or, worse, lets
 * one call's `COMMIT` commit another's uncommitted writes), while routing them
 * through `runSerialized` would deadlock the `runSerialized(() =>
 * transaction(work))` composition the engine already uses.
 */
const createRivetShardHost = (
    actor: Pick<RivetActorLike, "key" | "schedule" | "waitUntil">,
    state: RivetShardState,
    options: RivetShardHostOptions = {},
): RivetShardHost => {
    const sql = createSql(state);
    const asyncSql = createAsyncSql(state);

    /** The pending alarm, mirrored in memory so `get()` can answer synchronously. */
    let pendingAlarm: { id: string; timestamp: number } | undefined;

    const alarms: ShardAlarms = {
        delete: async () => {
            if (pendingAlarm !== undefined) {
                const { id } = pendingAlarm;

                pendingAlarm = undefined;
                await actor.schedule.cancel(id);
            }
        },
        // eslint-disable-next-line unicorn/no-null -- the platform contract's `get` is `number | null`
        get: () => pendingAlarm?.timestamp ?? null,
        set: async (timestamp: number | Date) => {
            const ms = typeof timestamp === "number" ? timestamp : timestamp.getTime();
            const previous = pendingAlarm;

            // `ShardAlarms` is a single slot; Rivet's scheduler is a list. Arm
            // the replacement first, then cancel the one it replaces — the
            // other order leaves a window where a crash loses both.
            const id = await actor.schedule.at(ms, RIVET_ALARM_ACTION);

            pendingAlarm = { id, timestamp: ms };

            if (previous !== undefined) {
                await actor.schedule.cancel(previous.id);
            }
        },
    };

    /**
     * Background work handed to `waitUntil`, retained until it settles so a
     * rejection cannot surface as an unhandled rejection, and so `drain()` has
     * something to await.
     */
    const background = new Set<Promise<unknown>>();

    let tail: Promise<unknown> = Promise.resolve();

    /**
     * Run `function_`, then make its writes durable.
     *
     * The flush is inside the boundary rather than after it because the whole
     * point of the boundary is that a caller who saw it resolve can rely on the
     * write. `flush()` is a no-op when nothing was written, so a read-only
     * closure pays nothing.
     */
    const runAndFlush = async <T>(function_: () => Promise<T>): Promise<T> => {
        const result = await function_();

        await state.flush();

        return result;
    };

    const runSerialized: ShardHost["runSerialized"] = <T>(function_: () => Promise<T>): Promise<T> => {
        const run = async (): Promise<T> => runAndFlush(function_);
        const started = tail.then(run, run);

        tail = started.then(
            () => undefined,
            () => undefined,
        );

        return started;
    };

    let transactionTail: Promise<unknown> = Promise.resolve();

    const runTransaction = async <T>(function_: () => Promise<T>): Promise<T> => {
        const { database } = state;

        database.exec("BEGIN");

        let result: T;

        try {
            result = await function_();
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }

        // Outside the try: a snapshot is taken of committed state only, and a
        // flush that fails must not roll back a transaction SQLite has already
        // committed. The write is durable in the working copy and the caller
        // is told the flush failed — which is the honest report, and which the
        // next boundary retries because `isDirty` is still set.
        await state.flush();

        return result;
    };

    const transaction: ShardHost["transaction"] = <T>(function_: () => Promise<T>): Promise<T> => {
        const run = async (): Promise<T> => runTransaction(function_);
        const started = transactionTail.then(run, run);

        transactionTail = started.then(
            () => undefined,
            () => undefined,
        );

        return started;
    };

    const host: ShardHost = {
        alarms,
        asyncSql,
        runSerialized,
        // Rivet keys are arrays (`["tenant", "42"]`); the contract wants one
        // human-readable name for telemetry attribution, never for routing.
        shardKey: actor.key.join("/"),
        sql,
        transaction,
        waitUntil: (promise) => {
            const tracked = promise
                .catch(() => {
                    // Background work that fails has no caller left to tell.
                })
                .finally(() => {
                    background.delete(tracked);
                });

            background.add(tracked);

            // Hand the same work to Rivet so the actor stays awake for it
            // rather than sleeping mid-flight. This is the half a Node host
            // cannot offer at all: there, `waitUntil` can only promise not to
            // drop the work.
            actor.waitUntil(tracked);
        },
    };

    return {
        deliverAlarm: async () => {
            pendingAlarm = undefined;

            await options.onAlarm?.();
        },
        drain: async () => {
            while (background.size > 0) {
                // eslint-disable-next-line no-await-in-loop -- sequential is the point: each pass drains the set as it stood, and work that spawned more work is picked up by the next iteration
                await Promise.all(background);
            }
        },
        host,
    };
};

/**
 * Re-attach the in-memory alarm mirror to whatever Rivet still has pending.
 *
 * Rivet's schedules outlive a sleep but this host's `pendingAlarm` does not, so
 * a freshly woken actor would report `null` from `alarms.get()` for an alarm
 * that is very much still armed — and would then leak the old schedule when the
 * engine set a new one. Called by the composition root on open.
 *
 * Exported (rather than folded into `createRivetShardHost`) because it costs a
 * `schedule.list()` round trip, and the conformance host builds many hosts over
 * a doubled scheduler where there is nothing to recover.
 */
const restoreRivetAlarm = async (actor: Pick<RivetActorLike, "schedule">, host: ShardHost): Promise<number | undefined> => {
    const pending = await actor.schedule.list();
    const alarm = pending
        .filter((entry) => entry.action === RIVET_ALARM_ACTION)
        .toSorted((left, right) => left.runAt - right.runAt)
        .at(0);

    if (alarm === undefined) {
        return undefined;
    }

    // Re-arming through the contract keeps one code path for "an alarm is
    // pending at T": the extra schedule this creates is cancelled by `set`
    // itself, which retires the entry it replaces.
    await host.alarms.set(alarm.runAt);
    await actor.schedule.cancel(alarm.id);

    return alarm.runAt;
};

/** Re-exported for tests that need to reach the working copy's driver type. */
type RivetShardDatabase = Database.Database;

export type { RivetShardDatabase, RivetShardHost, RivetShardHostOptions };
export { createRivetShardHost, restoreRivetAlarm, RIVET_ALARM_ACTION };
