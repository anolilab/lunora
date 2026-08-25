/**
 * An in-memory stand-in for a Rivet actor context.
 *
 * The adapters in this package are written against the `*Like` projections in
 * `../rivet-context`, not against `rivetkit` itself, so they can be exercised
 * without a Rivet engine. This is what exercises them: a faithful-enough
 * implementation of that projection over `better-sqlite3` and `setTimeout`,
 * used by the conformance host and by this package's unit tests.
 *
 * **It is a double, and the distinction matters when reading a green suite.**
 * What it proves is that the adapters satisfy `@lunora/platform`'s contracts
 * given a context that behaves the way Rivet documents. What it cannot prove is
 * that Rivet behaves that way — schedule delivery semantics under sleep, the
 * exact serde shape of a bound parameter, hibernation wake ordering. Those need
 * a live engine, and `plans/rivet-host-findings.md` lists them as open.
 *
 * Two behaviours are modelled deliberately rather than conveniently:
 *
 * 1. **Every database entry point is async**, even though the underlying
 * `better-sqlite3` handle is not. That asymmetry *is* the thing this
 * package exists to bridge, so a double that quietly resolved synchronously
 * would hide the bug class the working copy was built to avoid.
 * 2. **Schedules deliver to an action by name**, exactly as Rivet's do, rather
 * than to a callback. A double that invoked a closure would let an adapter
 * forget the action-name indirection that a real actor definition has to
 * wire up by hand.
 */

import Database from "better-sqlite3";

import type { RivetActorLike, RivetCronSetOptions, RivetRawDatabaseLike, RivetScheduledEventLike } from "../rivet-context";

/** Largest delay `setTimeout` accepts before it clamps to 1 ms and warns. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** A handler registered under a Rivet action name. */
type RivetActionHandler = (...args: unknown[]) => unknown;

/** A recurring job the double has been asked to register. */
interface RivetDoubleCronJob {
    action: string;
    args: ReadonlyArray<unknown>;
    expression: string;
    name: string;
}

/** The actor double, plus the hooks a test needs to drive it. */
interface RivetActorDouble extends RivetActorLike {
    /**
     * Action handlers, by name. Mutable and filled *after* construction,
     * because the handlers need the platform and the platform needs the actor
     * — the same knot a real actor definition ties with `c.vars`.
     */
    readonly actions: Map<string, RivetActionHandler>;
    /** Release every armed timer and close the database. */
    cleanup: () => void;
    /** Recurring jobs registered through `cron.set`, by name. */
    readonly crons: Map<string, RivetDoubleCronJob>;
    /** Resolve once every promise handed to `waitUntil` has settled. */
    settle: () => Promise<void>;
}

/** Options for {@link createRivetActorDouble}. */
interface RivetActorDoubleOptions {
    /** The actor's key. Defaults to `["conformance"]`. */
    key?: ReadonlyArray<string>;

    /**
     * A `better-sqlite3` path for the actor's durable database. Defaults to
     * `":memory:"`; pass a real file to exercise a wake over state a previous
     * double left behind.
     */
    path?: string;
}

/** Wrap a synchronous `better-sqlite3` connection in Rivet's async database shape. */
const createDatabaseFacade = (database: Database.Database): RivetRawDatabaseLike => {
    const execute = async <Row extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> => {
        // Rivet accepts either positional arguments or one named-bindings
        // object; better-sqlite3 accepts both too, so the arguments pass
        // straight through — except for `undefined`, which better-sqlite3
        // rejects outright and which the adapters do pass for an absent value.

        const bindings = args.map((value) => (value === undefined ? null : value));
        const statement = database.prepare(query);

        if (!statement.reader) {
            statement.run(...(bindings as never[]));

            return [];
        }

        return statement.all(...(bindings as never[])) as Row[];
    };

    return { execute };
};

/**
 * Build an in-memory Rivet actor context.
 *
 * Schedules fire through real timers, so a test waits for wall-clock time the
 * same way it would against a live actor — no virtual clock to keep in sync
 * with the adapter's own `Date.now()` arithmetic.
 */
const createRivetActorDouble = (options: RivetActorDoubleOptions = {}): RivetActorDouble => {
    const database = new Database(options.path ?? ":memory:");
    const db = createDatabaseFacade(database);

    const actions = new Map<string, RivetActionHandler>();
    const crons = new Map<string, RivetDoubleCronJob>();
    const pending = new Map<string, { entry: RivetScheduledEventLike; timer: ReturnType<typeof setTimeout> }>();
    const background = new Set<Promise<unknown>>();

    let closed = false;

    /**
     * Invoke a scheduled action. Failures are swallowed here rather than
     * escalated, because Rivet isolates a failed run to that run — the retry
     * ladder is the scheduler adapter's business, and it learns about the
     * failure from `onDispatch` throwing inside its own delivery path.
     */
    const fire = (id: string): void => {
        const record = pending.get(id);

        if (record === undefined || closed) {
            return;
        }

        pending.delete(id);

        const handler = actions.get(record.entry.action);

        if (handler === undefined) {
            return;
        }

        const delivered = (async () => {
            await handler(...record.entry.args);
        })();

        delivered.catch(() => {
            // See above: a failed run does not take the actor down.
        });
    };

    const arm = (id: string, runAt: number): ReturnType<typeof setTimeout> => {
        const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, runAt - Date.now()));

        return setTimeout(() => {
            fire(id);
        }, delay);
    };

    const at = async (timestamp: number, action: string, ...args: unknown[]): Promise<string> => {
        const id = crypto.randomUUID();

        pending.set(id, { entry: { action, args: [...args], id, runAt: timestamp }, timer: arm(id, timestamp) });

        return id;
    };

    return {
        actions,
        cleanup: () => {
            closed = true;

            for (const { timer } of pending.values()) {
                clearTimeout(timer);
            }

            pending.clear();

            if (database.open) {
                database.close();
            }
        },
        cron: {
            set: async (job: RivetCronSetOptions) => {
                crons.set(job.name, { action: job.action, args: [...(job.args ?? [])], expression: job.expression, name: job.name });
            },
        },
        crons,
        db,
        key: options.key ?? ["conformance"],
        schedule: {
            at,
            cancel: async (id) => {
                const record = pending.get(id);

                if (record === undefined) {
                    return false;
                }

                clearTimeout(record.timer);
                pending.delete(id);

                return true;
            },
            list: async () => [...pending.values()].map((record) => record.entry),
        },
        settle: async () => {
            while (background.size > 0) {
                // eslint-disable-next-line no-await-in-loop -- each pass drains the set as it stood; work that spawned more work is picked up next iteration
                await Promise.all(background);
            }
        },
        waitUntil: (promise) => {
            const tracked = promise.catch(() => undefined).finally(() => background.delete(tracked));

            background.add(tracked);
        },
    };
};

export type { RivetActionHandler, RivetActorDouble, RivetActorDoubleOptions, RivetDoubleCronJob };
export { createRivetActorDouble };
