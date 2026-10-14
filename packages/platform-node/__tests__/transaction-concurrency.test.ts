import { describe, expect, it } from "vitest";

import { createNodeShardHost } from "../src/node-shard-host";

/**
 * Plan 267 §4/§5 (S4): `transaction` runs raw `BEGIN`/`COMMIT`/`ROLLBACK`
 * against a single shared connection. Two overlapping `transaction()` calls
 * used to race that connection directly — the second `BEGIN` while the first
 * was still open either threw `cannot start a transaction within a
 * transaction` or, worse, silently interleaved commits/rollbacks.
 *
 * The first fix gave `transaction` a private serialization lane of its own,
 * which closed the `transaction`-vs-`transaction` pair and left the **cross**
 * pair — `runSerialized` against `transaction` — unsynchronized. That is what
 * the second half of this file covers, plus the two compositions the engine
 * actually issues, which a shared lane has to keep working. Every cross-pair
 * test here fails on the two-lane host, one of them by deadlocking, so each
 * carries an explicit timeout: a deadlock has to surface as a red test rather
 * than a suite that never finishes.
 */
describe("createNodeShardHost transaction concurrency", () => {
    const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, ms);
        });

    /**
     * Record the transaction-control statements the host issues on the
     * connection.
     *
     * `Object.defineProperty` rather than an assignment because
     * better-sqlite3's `exec` lives on the prototype and the point is to shadow
     * it for this one connection, without ESLint reading it as a mutated
     * parameter.
     */
    const watchTransactionKeywords = (database: { exec: (source: string) => unknown }): string[] => {
        const keywords: string[] = [];
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

    it("serializes two overlapping bare transaction() calls instead of corrupting each other's commits", async () => {
        expect.assertions(1);

        const { dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");

            const first = host.transaction(async () => {
                host.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");

                await sleep(20);

                host.sql.exec("INSERT INTO rows_ (id) VALUES ('B')");
            });

            // Started without awaiting `first` — this is the overlap that
            // corrupts an un-serialized raw BEGIN/COMMIT.
            const second = host.transaction(async () => {
                host.sql.exec("INSERT INTO rows_ (id) VALUES ('C')");
            });

            await Promise.all([first, second]);

            const rows = host.sql.exec<{ id: string }>("SELECT id FROM rows_ ORDER BY id").toArray();

            expect(rows.map((row) => row.id)).toStrictEqual(["A", "B", "C"]);
        } finally {
            dispose();
        }
    });

    it("rolls back only the throwing transaction's own writes, leaving earlier committed rows intact", async () => {
        expect.assertions(2);

        const { dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");

            await host.transaction(async () => {
                host.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");
            });

            await expect(
                host.transaction(async () => {
                    host.sql.exec("INSERT INTO rows_ (id) VALUES ('D')");

                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");

            const rows = host.sql.exec<{ id: string }>("SELECT id FROM rows_ ORDER BY id").toArray();

            expect(rows.map((row) => row.id)).toStrictEqual(["A"]);
        } finally {
            dispose();
        }
    });

    it("keeps a serialized boundary whole when a bare transaction() opens across its await", async () => {
        expect.assertions(2);

        const { dispose, host } = createNodeShardHost();

        try {
            host.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");

            // The shape a `blockConcurrencyWhile` span takes on this host: two
            // writes with real work between them. On the two-lane host the
            // second write lands after an unrelated `BEGIN` has opened on the
            // other lane, so `assertOwnTurn` refuses it and the whole boundary
            // rejects — with the FIRST write already committed. A caller that
            // retries the rejection then re-applies it.
            const serialized = host.runSerialized(async () => {
                host.sql.exec("INSERT INTO rows_ (id) VALUES ('first')");

                await sleep(30);

                host.sql.exec("INSERT INTO rows_ (id) VALUES ('second')");

                return "whole";
            });

            // Started WITHOUT awaiting the boundary, and holding its `BEGIN`
            // open PAST the point where the boundary resumes — the overlap the
            // second lane permitted.
            await sleep(5);

            const committed = host.transaction(async () => {
                host.sql.exec("INSERT INTO rows_ (id) VALUES ('txn')");

                await sleep(40);
            });

            await expect(serialized).resolves.toBe("whole");

            await committed;

            expect(
                host.sql
                    .exec<{ id: string }>("SELECT id FROM rows_ ORDER BY id")
                    .toArray()
                    .map((row) => row.id),
            ).toStrictEqual(["first", "second", "txn"]);
        } finally {
            dispose();
        }
    }, 5000);

    it("keeps a serialized boundary's write out of a concurrent transaction's rollback", async () => {
        expect.assertions(3);

        const { database, dispose, host } = createNodeShardHost();

        try {
            const keywords = watchTransactionKeywords(database);

            host.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");

            let release = (): void => {};

            const held = new Promise<void>((resolve) => {
                release = resolve;
            });

            // A bare `transaction()` holding its `BEGIN` open across an await —
            // the shape an alarm or a `storage.transaction` bridge takes while
            // a socket frame drives a boundary of its own, which nothing on a
            // Node process serializes against it.
            const outcome = host
                .transaction(async () => {
                    host.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");

                    await held;

                    throw new Error("boom");
                })
                .then(
                    () => "committed",
                    () => "rolled-back",
                );

            const serialized = host.runSerialized(async () => {
                host.sql.exec("INSERT INTO rows_ (id) VALUES ('B')");
            });

            await sleep(20);

            release();

            await expect(outcome).resolves.toBe("rolled-back");

            await serialized;

            // On the two-lane host this row never existed: the write was
            // refused inside the foreign `BEGIN` and the boundary rejected.
            expect(
                host.sql
                    .exec<{ id: string }>("SELECT id FROM rows_ ORDER BY id")
                    .toArray()
                    .map((row) => row.id),
            ).toStrictEqual(["B"]);
            expect(nestsBegin(keywords)).toBe(false);
        } finally {
            dispose();
        }
    }, 5000);

    it("runs the engine's runSerialized(() => transaction(work)) composition in place", async () => {
        expect.assertions(2);

        const { dispose, host } = createNodeShardHost();

        try {
            // `ShardRunner.runInTransaction` verbatim. A shared lane that was
            // not re-entrant would deadlock here, which is the reason this host
            // grew a second lane in the first place.
            const result = await host.runSerialized(async () =>
                host.transaction(async () => {
                    host.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");
                    host.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");

                    return "done";
                }),
            );

            expect(result).toBe("done");
            expect(
                host.sql
                    .exec<{ id: string }>("SELECT id FROM rows_")
                    .toArray()
                    .map((row) => row.id),
            ).toStrictEqual(["A"]);
        } finally {
            dispose();
        }
    }, 5000);

    it("runs ShardDO's nested runSerialized span in place instead of deadlocking", async () => {
        expect.assertions(2);

        const { dispose, host } = createNodeShardHost();

        try {
            // Both compositions the engine stacks on a mutation carrying an
            // `x-lunora-mutation-id` header: `ShardDO.fetch` widens the dispatch
            // into a `runSerialized` span, and `ShardRunner.runInTransaction`
            // inside it is itself `runSerialized(() => transaction(work))`.
            //
            // The two-lane host hangs here forever — the inner `runSerialized`
            // waits on a `tail` that only settles when the outer closure
            // awaiting it resolves — and because nothing resets that `tail`, the
            // wedge outlives the request.
            const result = await host.runSerialized(async () =>
                host.runSerialized(async () =>
                    host.transaction(async () => {
                        host.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");
                        host.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");

                        return "done";
                    }),
                ),
            );

            expect(result).toBe("done");

            // The lock has to be released by the nesting too, or the next
            // boundary on this shard never runs.
            await expect(host.runSerialized(async () => "after")).resolves.toBe("after");
        } finally {
            dispose();
        }
    }, 5000);

    it("never nests a raw BEGIN when a second top-level transaction overlaps the first", async () => {
        expect.assertions(2);

        const { database, dispose, host } = createNodeShardHost();

        try {
            const keywords = watchTransactionKeywords(database);

            host.sql.exec("CREATE TABLE rows_ (id TEXT PRIMARY KEY)");

            // A re-entrancy check that only asked whether the lock is HELD —
            // a boolean rather than an `AsyncLocalStorage` store — would admit
            // this second bare `transaction()` in place and nest its `BEGIN`.
            // better-sqlite3 raises "cannot start a transaction within a
            // transaction", and on the branch where it does not, the first
            // call's `COMMIT` publishes the second's rows. A store scoped to a
            // single call's own await chain is what tells the two cases apart.
            await Promise.all([
                host.transaction(async () => {
                    host.sql.exec("INSERT INTO rows_ (id) VALUES ('A')");

                    await sleep(15);

                    host.sql.exec("INSERT INTO rows_ (id) VALUES ('B')");
                }),
                host.transaction(async () => {
                    host.sql.exec("INSERT INTO rows_ (id) VALUES ('C')");
                }),
                host.runSerialized(async () => {
                    host.sql.exec("INSERT INTO rows_ (id) VALUES ('D')");
                }),
            ]);

            expect(nestsBegin(keywords)).toBe(false);
            expect(
                host.sql
                    .exec<{ id: string }>("SELECT id FROM rows_ ORDER BY id")
                    .toArray()
                    .map((row) => row.id),
            ).toStrictEqual(["A", "B", "C", "D"]);
        } finally {
            dispose();
        }
    }, 5000);
});
