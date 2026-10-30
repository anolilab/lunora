import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import { reconcileSearchRow } from "../src/ctx-db-search";
import type { QueryTimer } from "../src/query-timeout";
import { SqlQueryTimeoutError } from "../src/query-timeout";
import { companionFor } from "../src/search-layout";
import { createSqliteBatchHarness, createSqliteHarness, makeSqliteDialect } from "./_helpers/sqlite";

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const schema: SchemaLike = { tables: { notes: { indexes: [], shape: { body: col("string") }, shardMode: { kind: "global" } } } } as never;

/** A timer whose deadlines fire only when the test says so. */
const manualTimer = (): { armed: Map<number, () => void>; timer: QueryTimer } => {
    const armed = new Map<number, () => void>();
    let next = 0;

    return {
        armed,
        timer: (fire) => {
            const handle = next;

            next += 1;
            armed.set(handle, fire);

            return () => {
                armed.delete(handle);
            };
        },
    };
};

/** How many search entries `companion` holds for the row `n1`. */
const searchEntries = async (exec: SqlCtxExec, companion: string): Promise<number> => {
    const [row] = await exec.all(`SELECT COUNT(*) AS n FROM "${companion}" WHERE "__id__" = ?`, ["n1"]);

    return Number(row?.["n"]);
};

describe("createSqlCtxDb — statement deadline", () => {
    let harness: ReturnType<typeof createSqliteBatchHarness>;

    beforeEach(() => {
        harness = createSqliteBatchHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("abandons a statement the engine never answers with a retryable timeout", async () => {
        expect.assertions(3);

        const { armed, timer } = manualTimer();
        let hang = false;
        let reachedHang: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reachedHang = resolve;
        });
        const exec: SqlCtxExec = {
            ...harness.exec,
            all: async (query, parameters) => {
                if (hang && query.startsWith('SELECT * FROM "notes"')) {
                    reachedHang();

                    return await new Promise<never>(() => {});
                }

                return await harness.exec.all(query, parameters);
            },
        };
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, queryTimeoutMs: 5000, queryTimer: timer, schema });
        const id = await writer.insert("notes", { body: "a" });

        // Every statement so far answered, so none left a deadline armed.
        expect(armed.size).toBe(0);

        hang = true;

        const read = writer.get("notes", id);

        await hung;

        for (const fire of armed.values()) {
            fire();
        }

        await expect(read).rejects.toBeInstanceOf(SqlQueryTimeoutError);
        await expect(read).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    });

    it("releases the caller when the transaction itself never settles", async () => {
        expect.assertions(1);

        const { armed, timer } = manualTimer();
        let begun: () => void = () => undefined;
        const begin = new Promise<void>((resolve) => {
            begun = resolve;
        });
        // A BEGIN (or a connection checkout) that never answers: `work` is never even called.
        const exec: SqlCtxExec = {
            ...harness.exec,
            transaction: async () => {
                begun();

                return await new Promise<never>(() => {});
            },
        };
        // A table with an aggregate index, so its writes open a transaction at all.
        const counted = {
            tables: { notes: { ...schema.tables["notes"], aggregateIndexes: [{ by: ["body"], name: "byBody", on: "notes", op: "count" }] } },
        } as unknown as SchemaLike;
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, queryTimeoutMs: 5000, queryTimer: timer, schema: counted });
        const write = writer.insert("notes", { body: "a" });

        await begin;

        for (const fire of armed.values()) {
            fire();
        }

        await expect(write).rejects.toBeInstanceOf(SqlQueryTimeoutError);
    });

    it("runs schema DDL without the statement deadline", async () => {
        expect.assertions(2);

        const { armed, timer } = manualTimer();
        let reachedDdl: () => void = () => undefined;
        const ddl = new Promise<void>((resolve) => {
            reachedDdl = resolve;
        });
        let finishDdl: () => void = () => undefined;
        const slow = new Promise<void>((resolve) => {
            finishDdl = resolve;
        });
        let held = false;
        const exec: SqlCtxExec = {
            ...harness.exec,
            run: async (query, parameters) => {
                if (!held && query.startsWith("CREATE TABLE")) {
                    held = true;
                    reachedDdl();
                    await slow;
                }

                await harness.exec.run(query, parameters);
            },
        };
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, queryTimeoutMs: 5000, queryTimer: timer, schema });
        const write = writer.insert("notes", { body: "a" });

        await ddl;

        // A long index build is not a hung engine: no deadline is armed over it.
        expect(armed.size).toBe(0);

        finishDdl();

        await expect(write).resolves.toBeTypeOf("string");
    });

    it("rebuilds the counters after a row write abandoned without a transaction lands late", async () => {
        expect.assertions(3);

        const counted = {
            tables: {
                tallies: {
                    aggregateIndexes: [{ by: ["org"], name: "countByOrg", on: "tallies", op: "count" }],
                    indexes: [],
                    shape: { org: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        } as unknown as SchemaLike;
        const { armed, timer } = manualTimer();
        let hang = false;
        let reachedHang: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reachedHang = resolve;
        });
        let land: () => void = () => undefined;
        const late = new Promise<void>((resolve) => {
            land = resolve;
        });
        let landed: Promise<unknown> = Promise.resolve();
        // The engine answers the row INSERT only after its deadline, then applies it: no `transaction`, as on D1.
        const delay = <T>(query: string, run: () => Promise<T>): Promise<T> => {
            if (hang && query.startsWith('INSERT INTO "tallies"')) {
                hang = false;
                reachedHang();

                const result = late.then(run);

                landed = result;

                return result;
            }

            return run();
        };
        const exec: SqlCtxExec = {
            ...harness.exec,
            all: async (query, parameters) => await delay(query, async () => await harness.exec.all(query, parameters)),
            run: async (query, parameters) => await delay(query, async () => await harness.exec.run(query, parameters)),
        };
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, queryTimeoutMs: 5000, queryTimer: timer, schema: counted });

        await writer.insert("tallies", { org: "a" });

        await expect(writer.count("tallies", { org: "a" })).resolves.toBe(1);

        hang = true;

        const write = writer.insert("tallies", { org: "a" });

        await hung;

        for (const fire of armed.values()) {
            fire();
        }

        await write.catch(() => undefined);

        // A rebuild that runs before the row lands tallies the table without it, and is memoised as settled.
        await expect(writer.count("tallies", { org: "a" })).resolves.toBe(1);

        land();
        await landed;

        // The late row is in the table; the memo is dropped again once it lands, so the counter is rebuilt from it.
        await expect(writer.count("tallies", { org: "a" })).resolves.toBe(2);
    });

    it("rebuilds the counters after a lone companion statement resolves past its deadline", async () => {
        expect.assertions(2);

        // Two counters, so the statements after the abandoned one are the second counter's.
        const twoCounters = {
            tables: {
                tallies: {
                    aggregateIndexes: [
                        { by: ["org"], name: "aByOrg", on: "tallies", op: "count" },
                        { by: ["kind"], name: "bByKind", on: "tallies", op: "count" },
                    ],
                    indexes: [],
                    shape: { kind: col("string"), org: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        } as unknown as SchemaLike;
        // No `batch` and no `transaction`, as node-pg or a single mysql2 connection: companions run one at a time.
        const plain = createSqliteHarness();
        const { armed, timer } = manualTimer();
        let hang = false;
        let reached: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reached = resolve;
        });
        let land: () => void = () => undefined;
        const late = new Promise<void>((resolve) => {
            land = resolve;
        });
        let landed: Promise<unknown> = Promise.resolve();
        const exec: SqlCtxExec = {
            all: async (query, parameters) => await plain.exec.all(query, parameters),
            run: async (query, parameters) => {
                if (hang && query.includes("aByOrg")) {
                    hang = false;
                    reached();
                    landed = (async () => {
                        await late;

                        return await plain.exec.run(query, parameters);
                    })();

                    return await (landed as ReturnType<SqlCtxExec["run"]>);
                }

                return await plain.exec.run(query, parameters);
            },
        };

        try {
            const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, queryTimeoutMs: 5000, queryTimer: timer, schema: twoCounters });

            await writer.insert("tallies", { kind: "k", org: "a" });

            await expect(writer.count("tallies", { kind: "k" })).resolves.toBe(1);

            hang = true;

            const write = writer.insert("tallies", { kind: "k", org: "a" });

            await hung;

            for (const fire of armed.values()) {
                fire();
            }

            await write.catch(() => undefined);
            land();
            await landed;
            // The eviction runs once the abandoned statement has settled.
            await Promise.resolve();

            // The second counter's step never ran; it is rebuilt from the table rather than left one behind.
            await expect(writer.count("tallies", { kind: "k" })).resolves.toBe(2);
        } finally {
            plain.close();
        }
    });

    it("re-indexes a row whose abandoned search purge lands after the row came back", async () => {
        expect.assertions(2);

        const index = { field: "body", name: "by_body" };
        const searched = {
            tables: { notes: { indexes: [], searchIndexes: [index], shape: { body: col("string") }, shardMode: { kind: "global" } } },
        } as unknown as SchemaLike;
        const companion = companionFor("notes", index);
        const plain = createSqliteHarness();
        const { armed, timer } = manualTimer();
        let hang = false;
        let reached: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reached = resolve;
        });
        let land: () => void = () => undefined;
        const late = new Promise<void>((resolve) => {
            land = resolve;
        });
        let landed = false;
        let reindexed: () => void = () => undefined;
        const reconciled = new Promise<void>((resolve) => {
            reindexed = resolve;
        });
        const entries = async (): Promise<number> => await searchEntries(plain.exec, companion);
        const exec: SqlCtxExec = {
            all: async (query, parameters) => await plain.exec.all(query, parameters),
            run: async (query, parameters) => {
                if (hang && query.startsWith(`DELETE FROM "${companion}"`)) {
                    hang = false;
                    reached();
                    await late;
                    // Postgres runs the purge's guard at the statement's snapshot, from before the row came back, so the
                    // late purge drops the new entry; emulated here by deleting it unguarded.
                    await plain.exec.run(`DELETE FROM "${companion}" WHERE "__id__" = ?`, ["n1"]);
                    landed = true;

                    return;
                }

                await plain.exec.run(query, parameters);

                if (landed && query.startsWith(`INSERT INTO "${companion}"`)) {
                    reindexed();
                }
            },
        };

        try {
            const writer = createSqlCtxDb({
                clock: () => 1,
                dialect: { ...makeSqliteDialect(), supportsFts5: false },
                exec,
                queryTimeoutMs: 5000,
                queryTimer: timer,
                schema: searched,
            });

            await writer.insert("notes", { _id: "n1", body: "hello" }, { allowExplicitId: true });

            hang = true;

            const removal = writer.delete("notes", "n1");

            await hung;

            for (const fire of armed.values()) {
                fire();
            }

            await expect(removal).rejects.toBeInstanceOf(SqlQueryTimeoutError);

            // The row comes back under the same id while the abandoned purge is still running.
            await writer.insert("notes", { _id: "n1", body: "hello" }, { allowExplicitId: true });
            land();
            await reconciled;

            await expect(entries()).resolves.toBeGreaterThan(0);
        } finally {
            plain.close();
        }
    });

    it("re-indexes a row that came back while reconciliation purged its entry", async () => {
        expect.assertions(1);

        const index = { field: "body", name: "by_body" };
        const searched = {
            tables: { notes: { indexes: [], searchIndexes: [index], shape: { body: col("string") }, shardMode: { kind: "global" } } },
        } as unknown as SchemaLike;
        const companion = companionFor("notes", index);
        const plain = createSqliteHarness();
        const dialect = { ...makeSqliteDialect(), supportsFts5: false };
        const entries = async (): Promise<number> => await searchEntries(plain.exec, companion);

        try {
            const writer = createSqlCtxDb({ clock: () => 1, dialect, exec: plain.exec, queryTimeoutMs: 0, schema: searched });

            await writer.insert("notes", { _id: "n1", body: "hello" }, { allowExplicitId: true });

            const [stored] = await plain.exec.all('SELECT * FROM "notes" WHERE "id" = ?', ["n1"]);
            const columns = Object.keys(stored as object);

            // The source row is gone but its entry is stale, so reconciliation reads the row as absent and purges.
            await plain.exec.run('DELETE FROM "notes" WHERE "id" = ?', ["n1"]);

            let reinserted = false;
            const exec: SqlCtxExec = {
                all: async (query, parameters) => await plain.exec.all(query, parameters),
                run: async (query, parameters) => {
                    if (!reinserted && query.startsWith(`DELETE FROM "${companion}"`)) {
                        reinserted = true;
                        // The row returns while the purge runs. Postgres reads the purge's guard at an earlier snapshot, so it still
                        // drops the entry: emulated by deleting it unguarded.
                        await plain.exec.run(
                            `INSERT INTO "notes" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
                            columns.map((column) => (stored as Record<string, never>)[column]),
                        );
                        await plain.exec.run(`DELETE FROM "${companion}" WHERE "__id__" = ?`, ["n1"]);

                        return { rowsAffected: 1 };
                    }

                    return await plain.exec.run(query, parameters);
                },
            };

            await reconcileSearchRow({ dialect, exec, schema: searched }, "notes", "n1");

            await expect(entries()).resolves.toBeGreaterThan(0);
        } finally {
            plain.close();
        }
    });

    it("rebuilds a counter whose fence claim a late claim overwrote mid-rebuild", async () => {
        expect.assertions(2);

        const shape = { org: col("string") };
        const bare = { tables: { tallies: { indexes: [], shape, shardMode: { kind: "global" } } } } as unknown as SchemaLike;
        const counted = {
            tables: {
                tallies: {
                    aggregateIndexes: [{ by: ["org"], name: "countByOrg", on: "tallies", op: "count" }],
                    indexes: [],
                    shape,
                    shardMode: { kind: "global" },
                },
            },
        } as unknown as SchemaLike;
        const plain = createSqliteHarness();
        let overwritten = false;
        const exec: SqlCtxExec = {
            all: async (query, parameters) => await plain.exec.all(query, parameters),
            run: async (query, parameters) => {
                if (!overwritten && query.startsWith("DELETE FROM") && query.includes("__lunora_companion_fence")) {
                    overwritten = true;
                    // A claim that was abandoned at its deadline lands after this rebuild's: this rebuild no longer holds the fence.
                    await plain.exec.run('UPDATE "__lunora_companion_fence" SET "token" = ?', ["late-claim"]);
                }

                return await plain.exec.run(query, parameters);
            },
        };

        try {
            const seed = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: plain.exec, queryTimeoutMs: 0, schema: bare });

            await seed.insert("tallies", { org: "a" });
            await seed.insert("tallies", { org: "a" });

            const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, queryTimeoutMs: 0, schema: counted });

            // The first rebuild's guarded writes were no-ops; the counter must not be memoised empty.
            await expect(writer.count("tallies", { org: "a" })).resolves.toBe(2);
            expect(overwritten).toBe(true);
        } finally {
            plain.close();
        }
    });

    it("drops a rebuild that settled while a transaction held a row whose delta it skipped", async () => {
        expect.assertions(2);

        const shape = { org: col("string") };
        const index = { by: ["org"], name: "countByOrg", on: "tallies", op: "count" };
        const definition = (extra: object): SchemaLike =>
            ({
                tables: { tallies: { aggregateIndexes: [{ ...index, ...extra }], indexes: [], shape, shardMode: { kind: "global" } } },
            }) as unknown as SchemaLike;
        const plain = createSqliteBatchHarness();
        const scope = {};
        // No `batch`: the rivals run while the write's transaction is open on the same connection.
        const bare: SqlCtxExec = { all: plain.exec.all, run: plain.exec.run };
        let rebuilds = 0;
        let inTransaction = false;
        let rivalsRan = false;
        const rival = createSqlCtxDb({
            clock: () => 1,
            dialect: makeSqliteDialect(),
            exec: bare,
            provisionScope: scope,
            queryTimeoutMs: 0,
            schema: definition({ rival: 1 }),
        });
        const sameDefinition = createSqlCtxDb({
            clock: () => 1,
            dialect: makeSqliteDialect(),
            exec: bare,
            provisionScope: scope,
            queryTimeoutMs: 0,
            schema: definition({}),
        });
        const count = (statement: string): void => {
            if (statement.startsWith("DELETE FROM") && statement.includes("__lunora_companion_fence")) {
                rebuilds += 1;
            }
        };
        const afterStatement = async (query: string): Promise<void> => {
            if (inTransaction && !rivalsRan && query.startsWith('INSERT INTO "tallies"')) {
                rivalsRan = true;
                // A writer of another definition replaces the settled rebuild, so this write's delta is skipped.
                await rival.count("tallies", { org: "a" });
            }
        };
        const exec: SqlCtxExec = {
            all: async (query, parameters) => {
                count(query);

                const rows = await plain.exec.all(query, parameters);

                await afterStatement(query);

                return rows;
            },
            run: async (query, parameters) => {
                count(query);

                const result = await plain.exec.run(query, parameters);

                await afterStatement(query);

                return result;
            },
            transaction: async (work) => {
                plain.database.exec("BEGIN");
                inTransaction = true;

                try {
                    const result = await work(exec);

                    // A writer rebuilds in the window before the commit, from rows the commit has not yet published.
                    await sameDefinition.count("tallies", { org: "a" });
                    plain.database.exec("COMMIT");

                    return result;
                } catch (error) {
                    plain.database.exec("ROLLBACK");

                    throw error;
                } finally {
                    inTransaction = false;
                }
            },
        };

        try {
            const writer = createSqlCtxDb({
                clock: () => 1,
                dialect: makeSqliteDialect(),
                exec,
                provisionScope: scope,
                queryTimeoutMs: 0,
                schema: definition({}),
            });

            await writer.insert("tallies", { org: "a" });

            const before = rebuilds;

            // The rebuild that settled before the commit is not trusted: the next read rebuilds from the committed table.
            await expect(writer.count("tallies", { org: "a" })).resolves.toBe(1);
            expect(rebuilds).toBe(before + 1);
        } finally {
            plain.close();
        }
    });

    it("reconciles the search indexes after the one that timed out", async () => {
        expect.assertions(2);

        const first = { field: "body", name: "first" };
        const second = { field: "body", name: "second" };
        const searched = {
            tables: { notes: { indexes: [], searchIndexes: [first, second], shape: { body: col("string") }, shardMode: { kind: "global" } } },
        } as unknown as SchemaLike;
        const firstCompanion = companionFor("notes", first);
        const secondCompanion = companionFor("notes", second);
        const plain = createSqliteHarness();
        const { armed, timer } = manualTimer();
        let hang = false;
        let abandoned = false;
        let reached: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reached = resolve;
        });
        let land: () => void = () => undefined;
        const late = new Promise<void>((resolve) => {
            land = resolve;
        });
        let secondIndexed: () => void = () => undefined;
        const reconciled = new Promise<void>((resolve) => {
            secondIndexed = resolve;
        });
        const exec: SqlCtxExec = {
            all: async (query, parameters) => await plain.exec.all(query, parameters),
            run: async (query, parameters) => {
                if (hang && query.startsWith(`INSERT INTO "${firstCompanion}"`)) {
                    hang = false;
                    reached();
                    await late;
                }

                await plain.exec.run(query, parameters);

                if (abandoned && query.startsWith(`INSERT INTO "${secondCompanion}"`)) {
                    secondIndexed();
                }
            },
        };

        try {
            const writer = createSqlCtxDb({
                clock: () => 1,
                dialect: { ...makeSqliteDialect(), supportsFts5: false },
                exec,
                queryTimeoutMs: 5000,
                queryTimer: timer,
                schema: searched,
            });

            await writer.insert("notes", { _id: "n1", body: "seed" }, { allowExplicitId: true });

            hang = true;

            const update = writer.patch("notes", "n1", { body: "hello" });

            await hung;

            for (const fire of armed.values()) {
                fire();
            }

            await expect(update).rejects.toBeInstanceOf(SqlQueryTimeoutError);

            abandoned = true;

            // The row write committed, and the write threw before it reached the second index.
            land();
            await reconciled;

            expect(abandoned).toBe(true);
        } finally {
            plain.close();
        }
    });

    it("rebuilds a min counter at once when the read that prepares its delta never answers", async () => {
        expect.assertions(3);

        const extremes = {
            tables: {
                scores: {
                    aggregateIndexes: [{ by: ["org"], field: "points", name: "lowest", on: "scores", op: "min" }],
                    indexes: [],
                    shape: { org: col("string"), points: col("number") },
                    shardMode: { kind: "global" },
                },
            },
        } as unknown as SchemaLike;
        const plain = createSqliteHarness();
        const { armed, timer } = manualTimer();
        let hang = false;
        let reached: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reached = resolve;
        });
        let rebuilds = 0;
        const exec: SqlCtxExec = {
            all: async (query, parameters) => {
                // The recompute of the group's extreme: it reads the source table after the delete committed.
                if (hang && query.startsWith('SELECT MIN("points")')) {
                    hang = false;
                    reached();

                    return await new Promise<never>(() => {});
                }

                return await plain.exec.all(query, parameters);
            },
            run: async (query, parameters) => {
                if (query.startsWith("DELETE FROM") && query.includes("__lunora_companion_fence")) {
                    rebuilds += 1;
                }

                return await plain.exec.run(query, parameters);
            },
        };

        try {
            const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec, queryTimeoutMs: 5000, queryTimer: timer, schema: extremes });
            const low = await writer.insert("scores", { org: "a", points: 1 });

            await writer.insert("scores", { org: "a", points: 5 });

            await expect(writer.aggregate("scores", { field: "points", op: "min", where: { org: "a" } })).resolves.toBe(1);

            hang = true;

            const removal = writer.delete("scores", low);

            await hung;

            for (const fire of armed.values()) {
                fire();
            }

            await expect(removal).rejects.toBeInstanceOf(SqlQueryTimeoutError);

            // The delete committed and no delta was dispatched. The read never answers, so waiting for it would leave
            // the stale minimum trusted: the memo has to be gone already.
            const before = rebuilds;

            await writer.aggregate("scores", { field: "points", op: "min", where: { org: "a" } });

            expect(rebuilds).toBeGreaterThan(before);
        } finally {
            plain.close();
        }
    });

    it("indexes a row for search when its write commits after the deadline abandoned it", async () => {
        expect.assertions(2);

        const index = { field: "body", name: "by_body" };
        const searched = {
            tables: { notes: { indexes: [], searchIndexes: [index], shape: { body: col("string") }, shardMode: { kind: "global" } } },
        } as unknown as SchemaLike;
        const companion = companionFor("notes", index);
        const plain = createSqliteHarness();
        const { armed, timer } = manualTimer();
        let hang = false;
        let reached: () => void = () => undefined;
        const hung = new Promise<void>((resolve) => {
            reached = resolve;
        });
        let land: () => void = () => undefined;
        const late = new Promise<void>((resolve) => {
            land = resolve;
        });
        let indexed: () => void = () => undefined;
        const reconciled = new Promise<void>((resolve) => {
            indexed = resolve;
        });
        let landed = false;
        const exec: SqlCtxExec = {
            all: async (query, parameters) => await plain.exec.all(query, parameters),
            run: async (query, parameters) => {
                if (hang && query.startsWith('INSERT INTO "notes"')) {
                    hang = false;
                    reached();
                    await late;
                    await plain.exec.run(query, parameters);
                    landed = true;

                    return;
                }

                await plain.exec.run(query, parameters);

                if (landed && query.startsWith(`INSERT INTO "${companion}"`)) {
                    indexed();
                }
            },
        };

        try {
            const writer = createSqlCtxDb({
                clock: () => 1,
                dialect: { ...makeSqliteDialect(), supportsFts5: false },
                exec,
                queryTimeoutMs: 5000,
                queryTimer: timer,
                schema: searched,
            });

            // Provision first, so the only statement left to hang is the row write itself.
            await writer.insert("notes", { _id: "n0", body: "first" }, { allowExplicitId: true });

            hang = true;

            const write = writer.insert("notes", { _id: "n1", body: "hello" }, { allowExplicitId: true });

            await hung;

            for (const fire of armed.values()) {
                fire();
            }

            await expect(write).rejects.toBeInstanceOf(SqlQueryTimeoutError);

            land();
            await reconciled;

            const [row] = await plain.exec.all(`SELECT COUNT(*) AS n FROM "${companion}" WHERE "__id__" = ?`, ["n1"]);

            expect(Number(row?.["n"])).toBeGreaterThan(0);
        } finally {
            plain.close();
        }
    });
});
