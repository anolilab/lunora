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
 * that Rivet does *not* serialize against each other — and it is the *same*
 * queue `transaction` uses, because both write the one working copy.
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

import { AsyncLocalStorage } from "node:async_hooks";

import { LunoraError } from "@lunora/errors";
import type { ShardAlarms, ShardHost, ShardSqlCursor, ShardSqlExec, SqlRow } from "@lunora/platform";

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
 * `runSerialized` and `transaction` share **one** boundary lock, because they
 * write **one** `better-sqlite3` connection. Two private tail chains — the shape
 * this host shipped with — serialize each entry point against itself and nothing
 * against the other, which silently destroys a committed write:
 *
 * 1. A bare `transaction()` runs `BEGIN` and awaits its closure.
 * 2. A `runSerialized()` closure on the other chain writes rows. It issues no
 * `BEGIN` of its own, so those rows land inside the transaction's.
 * 3. Its `flush()` finds `database.inTransaction` and skips the snapshot — it
 * has to, since `serialize()` would capture uncommitted rows. `runSerialized`
 * **resolves**, telling its caller the write is durable.
 * 4. The transaction's closure throws. `ROLLBACK` discards the other
 * boundary's rows from the working copy, and no snapshot ever held them.
 *
 * A write that reported success is then gone from memory *and* from Rivet's
 * SQLite, with nothing having failed in between. The mirror case is as bad: a
 * `COMMIT` landing mid-closure publishes another boundary's half-written state.
 *
 * ## Why the lock is re-entrant, and why `AsyncLocalStorage` is what makes it so
 *
 * The engine composes the two: `ShardRunner.runInTransaction` is
 * `runSerialized(() => transaction(work))` (`@lunora/shard-engine`), and
 * `ShardDO.fetch` wraps a mutation dispatch in a *further* `runSerialized` span.
 * A plain FIFO mutex deadlocks on both — the inner acquire waits on the outer
 * closure that is awaiting it.
 *
 * So the lock is skipped for a boundary opened from inside a boundary, and
 * `AsyncLocalStorage` is the only thing that can tell that case from the one
 * that must queue: its store follows a single call's own await chain (through
 * `Promise.all` branches included) without leaking into a sibling chain. A
 * held-boolean cannot — it reads `true` for an unrelated second top-level
 * `transaction()` too, and nests a raw `BEGIN`. This is the same distinction
 * workerd's `blockConcurrencyWhile` draws natively with "does not queue events
 * initiated as part of the callback itself", and the same `AsyncLocalStorage`
 * model `@lunora/do`'s idempotency suite verified against real workerd.
 */
const createRivetShardHost = (
    actor: Pick<RivetActorLike, "key" | "schedule" | "waitUntil">,
    state: RivetShardState,
    options: RivetShardHostOptions = {},
): RivetShardHost => {
    const sql = createSql(state);

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

            // `ShardAlarms` is a single slot; Rivet's scheduler is a list. Arm
            // the replacement first, then cancel the one it replaces — the
            // other order leaves a window where a crash loses both.
            const id = await actor.schedule.at(ms, RIVET_ALARM_ACTION);

            // Read AFTER the await, not before. Two overlapping `set` calls
            // that both sampled `pendingAlarm` up front would each see the same
            // predecessor, so one of the two schedules they armed would never
            // be cancelled — and would later fire a spurious `deliverAlarm()`
            // for an alarm the engine believes it replaced.
            const previous = pendingAlarm;

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

    /**
     * Set for the duration of a boundary's closure, and readable only from that
     * closure's own await chain. See this module's `createRivetShardHost`
     * docstring for why a plain boolean would be wrong here.
     */
    const insideBoundary = new AsyncLocalStorage<true>();

    /**
     * Tail of the one boundary queue. Only ever a `release` promise, so it cannot
     * reject and one failed boundary cannot wedge every boundary behind it.
     */
    let boundaryTail: Promise<void> = Promise.resolve();

    /**
     * Hold the boundary lock for `function_`, or run it in place when the caller
     * already holds it.
     *
     * The re-entrant branch takes no queue slot at all, so it cannot deadlock on
     * the lock its own caller is holding.
     */
    const withBoundary = async <T>(function_: () => Promise<T>): Promise<T> => {
        if (insideBoundary.getStore() === true) {
            return await function_();
        }

        const previous = boundaryTail;

        let release: () => void = () => {};

        boundaryTail = new Promise<void>((resolve) => {
            release = resolve;
        });

        await previous;

        try {
            // `return await`, not a bare `return`: the rejection has to reach the
            // `finally`, or a boundary whose closure threw never releases the
            // lock and the shard wedges for good. `await` re-throws by identity,
            // which the contract's error-identity leg pins.
            return await insideBoundary.run(true, function_);
        } finally {
            release();
        }
    };

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

    const runSerialized: ShardHost["runSerialized"] = <T>(function_: () => Promise<T>): Promise<T> => withBoundary(async () => runAndFlush(function_));

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

    const transaction: ShardHost["transaction"] = <T>(function_: () => Promise<T>): Promise<T> => withBoundary(async () => runTransaction(function_));

    const host: ShardHost = {
        alarms,
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
    const alarms = pending.filter((entry) => entry.action === RIVET_ALARM_ACTION).toSorted((left, right) => left.runAt - right.runAt);
    const alarm = alarms.at(0);

    if (alarm === undefined) {
        return undefined;
    }

    // Re-arming through the contract keeps one code path for "an alarm is
    // pending at T". The schedule it creates is not in `alarms`, which was read
    // first, so retiring every entry in that list leaves exactly one armed.
    //
    // Every entry, not just the earliest: `ShardAlarms` is a single slot, so a
    // second pending entry is by definition an alarm the engine no longer
    // believes in. Leaving it armed makes it fire a spurious `deliverAlarm()`,
    // and — because each wake would restore the earliest and re-ignore the
    // rest — it would survive every subsequent wake too.
    await host.alarms.set(alarm.runAt);

    for (const entry of alarms) {
        // eslint-disable-next-line no-await-in-loop -- one round trip per stale entry against one actor; the list is a single entry in every non-pathological case
        await actor.schedule.cancel(entry.id);
    }

    return alarm.runAt;
};

export type { RivetShardHost, RivetShardHostOptions };
export { createRivetShardHost, restoreRivetAlarm, RIVET_ALARM_ACTION };
