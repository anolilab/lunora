import { describe, expect, it } from "vitest";

import { createRivetActorDouble } from "../src/conformance/rivet-actor-double";
import type { RivetRawDatabaseLike } from "../src/rivet-context";
import { createRivetShardHost } from "../src/rivet-shard-host";
import type { RivetShardState } from "../src/rivet-shard-state";
import { openRivetShardState } from "../src/rivet-shard-state";

/**
 * The legs where two boundaries — or two snapshots — are in the air at once.
 *
 * The shared TCK drives `runSerialized` against `runSerialized` and
 * `transaction` against `transaction`, which two private tail chains already
 * satisfied. What it never drives is the **cross** pair, and that is where this
 * host lost committed writes: one working copy, one snapshot row per slot, and
 * (before the fix) three unsynchronized callers reaching for them —
 * `runSerialized`, `transaction`, and the public `RivetPlatform.flush` the sleep
 * path calls.
 *
 * Every test here fails on the pre-fix host, and two of them fail by *hanging*,
 * so each carries an explicit timeout: a deadlock has to surface as a red test
 * rather than a suite that never finishes.
 */

/** Resolve after `ms` of real time. */
const delay = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Record the transaction-control statements the host issues on the working copy.
 *
 * `Object.defineProperty` rather than an assignment because better-sqlite3's
 * `exec` lives on the prototype and the point is to shadow it for this one
 * connection, without ESLint reading it as a mutated parameter.
 */
const watchTransactionKeywords = (state: RivetShardState): string[] => {
    const keywords: string[] = [];
    const { database } = state;
    const original = database.exec.bind(database);

    Object.defineProperty(database, "exec", {
        configurable: true,
        value: (source: string) => {
            if (source === "BEGIN" || source === "COMMIT" || source === "ROLLBACK") {
                keywords.push(source);
            }

            return original(source);
        },
        writable: true,
    });

    return keywords;
};

/** Whether a `BEGIN` was ever issued while another was still open. */
const nestsBegin = (keywords: ReadonlyArray<string>): boolean => {
    let depth = 0;

    for (const keyword of keywords) {
        if (keyword === "BEGIN") {
            depth += 1;

            if (depth > 1) {
                return true;
            }
        } else {
            depth -= 1;
        }
    }

    return false;
};

/**
 * Wrap Rivet's async database so a snapshot write can be made to land **out of
 * order** — the first queued delay applies to the first `execute`, and so on.
 *
 * Rivet reaches its actor SQLite through the runtime and promises no ordering
 * between two concurrent statements, so an older snapshot landing after a newer
 * one is a legal thing for it to do. The actor double resolves `execute`
 * synchronously and can therefore never exhibit it, which is exactly why the
 * un-queued flush looked correct under the existing suite.
 */
const reorderingDatabase = (database: RivetRawDatabaseLike, delaysMs: number[]): RivetRawDatabaseLike => {
    return {
        execute: async <Row extends Record<string, unknown> = Record<string, unknown>>(query: string, ...args: unknown[]): Promise<Row[]> => {
            const ms = delaysMs.shift();

            if (ms !== undefined) {
                await delay(ms);
            }

            return await database.execute<Row>(query, ...args);
        },
    };
};

describe("rivet shard host concurrency", () => {
    it("keeps a serialized boundary's write out of a concurrent transaction", async () => {
        expect.assertions(4);

        const actor = createRivetActorDouble();

        try {
            const state = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, state);
            const keywords = watchTransactionKeywords(state);

            await host.runSerialized(async () => {
                host.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
            });

            let release: () => void = () => {};

            const held = new Promise<void>((resolve) => {
                release = resolve;
            });

            // A bare `transaction()` holding its `BEGIN` open across an
            // await — the shape an action takes while an `onWebSocket` frame
            // drives a boundary of its own, which Rivet does not serialize
            // against it.
            const outcome = host
                .transaction(async () => {
                    host.sql.exec("INSERT INTO notes (id) VALUES (1)");

                    await held;

                    throw new Error("boom");
                })
                .then(
                    () => "committed",
                    () => "rolled-back",
                );

            // Started WITHOUT awaiting that transaction. On the pre-fix host
            // this closure runs on the other tail chain, so its write lands
            // inside the open `BEGIN`, its flush is skipped for
            // `inTransaction`, and `runSerialized` still resolves — then the
            // `ROLLBACK` below destroys the write it reported as durable.
            const serialized = host.runSerialized(async () => {
                host.sql.exec("INSERT INTO notes (id) VALUES (2)");
            });

            await delay(10);

            release();

            await expect(outcome).resolves.toBe("rolled-back");

            await serialized;

            expect(host.sql.exec("SELECT id FROM notes ORDER BY id").toArray()).toStrictEqual([{ id: 2 }]);
            expect(nestsBegin(keywords)).toBe(false);

            state.close();

            // The half that only shows up after a sleep: the write has to be
            // in the snapshot too, not just in the working copy.
            const woken = await openRivetShardState(actor);

            expect(woken.database.prepare("SELECT id FROM notes ORDER BY id").all()).toStrictEqual([{ id: 2 }]);

            woken.close();
        } finally {
            actor.cleanup();
        }
    }, 5000);

    it("runs nested boundaries in place instead of deadlocking on the shared lock", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const state = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, state);

            // Both compositions the engine actually uses, stacked:
            // `ShardDO.fetch` widens a mutation dispatch into a
            // `runSerialized` span, and `ShardRunner.runInTransaction`
            // inside it is itself `runSerialized(() => transaction(work))`.
            const result = await host.runSerialized(async () =>
                host.runSerialized(async () =>
                    host.transaction(async () => {
                        host.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
                        host.sql.exec("INSERT INTO notes (id) VALUES (1)");

                        return "done";
                    }),
                ),
            );

            expect(result).toBe("done");
            expect(state.isDirty).toBe(false);

            state.close();
        } finally {
            actor.cleanup();
        }
    }, 5000);

    it("never nests a raw BEGIN when three boundaries overlap", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            const state = await openRivetShardState(actor);
            const { host } = createRivetShardHost(actor, state);
            const keywords = watchTransactionKeywords(state);

            await host.runSerialized(async () => {
                host.sql.exec("CREATE TABLE notes (id TEXT PRIMARY KEY)");
            });

            // A re-entrancy check that only looks at whether the lock is
            // held would admit the second bare `transaction()` in place and
            // nest its `BEGIN` — better-sqlite3 raises "cannot start a
            // transaction within a transaction" and the first call's
            // `COMMIT` would publish the second's rows.
            await Promise.all([
                host.transaction(async () => {
                    host.sql.exec("INSERT INTO notes (id) VALUES ('a')");

                    await delay(15);

                    host.sql.exec("INSERT INTO notes (id) VALUES ('b')");
                }),
                host.transaction(async () => {
                    host.sql.exec("INSERT INTO notes (id) VALUES ('c')");
                }),
                host.runSerialized(async () => {
                    host.sql.exec("INSERT INTO notes (id) VALUES ('d')");
                }),
            ]);

            expect(nestsBegin(keywords)).toBe(false);
            expect(
                host.sql
                    .exec<{ id: string }>("SELECT id FROM notes ORDER BY id")
                    .toArray()
                    .map((row) => row.id),
            ).toStrictEqual(["a", "b", "c", "d"]);

            state.close();
        } finally {
            actor.cleanup();
        }
    }, 5000);

    it("persists the newest snapshot when an older flush lands last", async () => {
        expect.assertions(2);

        const actor = createRivetActorDouble();

        try {
            // Empty while the state opens, so its own `CREATE TABLE`/`SELECT`
            // run undelayed; the two snapshot writes below are what gets
            // reordered.
            const delaysMs: number[] = [];
            const state = await openRivetShardState({ db: reorderingDatabase(actor.db, delaysMs) });

            state.database.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
            state.markDirty();

            // The first snapshot write takes 30 ms, the second none — so without
            // a queue the older bytes overwrite the newer ones, and the newer
            // flush has already cleared `dirty` for a snapshot no longer in the
            // row. Nothing then owes a retry.
            delaysMs.push(30, 0);

            const first = state.flush();

            // Long enough that `first` has serialized and is waiting on its
            // durable write, short enough that it has not landed.
            await delay(5);

            state.database.exec("INSERT INTO notes (id) VALUES (1)");
            state.markDirty();

            const second = state.flush();

            await Promise.all([first, second]);

            expect(state.isDirty).toBe(false);

            state.close();

            const woken = await openRivetShardState(actor);

            expect(woken.database.prepare("SELECT id FROM notes").all()).toStrictEqual([{ id: 1 }]);

            woken.close();
        } finally {
            actor.cleanup();
        }
    });
});
