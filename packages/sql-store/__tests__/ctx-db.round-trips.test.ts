import type { SchemaLike, TriggerEventLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb, sweepSqlCdcRetention } from "../src/ctx-db";
import { createSqliteBatchHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * Pins the statements a `.global()` read or write sends, and the plan of the one polled every tick, where a
 * regression is a round trip or a full scan rather than a wrong answer. On D1 every statement here is a network
 * call from the Worker, so the count is the latency.
 */

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const dialect = makeSqliteDialect();

/** Every statement the exec receives, `batch` elements included. */
const recording = (exec: SqlCtxExec): { exec: SqlCtxExec; statements: string[] } => {
    const statements: string[] = [];

    return {
        exec: {
            all: (query, parameters) => {
                statements.push(query);

                return exec.all(query, parameters);
            },
            batch: (batch) => {
                statements.push(...batch.map((statement) => statement.sql));

                return (exec.batch as NonNullable<SqlCtxExec["batch"]>)(batch);
            },
            run: (query, parameters) => {
                statements.push(query);

                return exec.run(query, parameters);
            },
        },
        statements,
    };
};

/** A whole-companion truncate: the first step of a counter or rank rebuild, and only of a rebuild. */
const isRebuild = (statement: string): boolean => /^DELETE FROM "[^"]+"$/u.test(statement.trim());

/** The keyset page a rebuild walks the source table with. */
const isSourcePage = (statement: string): boolean => /ORDER BY "notes"\."id" ASC LIMIT/u.test(statement);

const companionSchema: SchemaLike = {
    tables: {
        notes: {
            aggregateIndexes: [{ by: ["org"], name: "count_by_org", on: "notes", op: "count" }],
            indexes: [],
            rankIndexes: [{ name: "byScore", on: "notes", partitionBy: ["org"], sortBy: [{ direction: "desc", field: "score" }] }],
            shape: { org: col("string"), score: col("number") },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — companion rebuilds", () => {
    let harness: ReturnType<typeof createSqliteBatchHarness>;

    beforeEach(() => {
        harness = createSqliteBatchHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("rebuilds the counter and rank companions once per scope, not once per writer", async () => {
        // Hosts build a writer per request. Keyed per writer, the rebuild — a scan
        // of the whole table plus a rewrite of the companion — ran on the first
        // aggregate read or write of every request.
        expect.assertions(4);

        const provisionScope = {};
        const first = recording(harness.exec);
        const firstWriter = createSqlCtxDb({ clock: () => 1, dialect, exec: first.exec, provisionScope, schema: companionSchema });

        await firstWriter.insert("notes", { org: "a", score: 1 });

        expect(first.statements.filter((statement) => isRebuild(statement))).toHaveLength(2);

        const second = recording(harness.exec);
        const secondWriter = createSqlCtxDb({ clock: () => 2, dialect, exec: second.exec, provisionScope, schema: companionSchema });
        const id = await secondWriter.insert("notes", { org: "a", score: 5 });

        // The second writer's counter and rank are still exact: the per-write deltas maintain them.
        await expect(secondWriter.count("notes", { org: "a" })).resolves.toBe(2);
        await expect(secondWriter.rank("notes", "byScore", { row: id })).resolves.toStrictEqual({ position: 1, total: 2 });

        expect(second.statements.filter((statement) => isRebuild(statement) || isSourcePage(statement))).toStrictEqual([]);
    });

    it("single-flights concurrent first callers onto one rebuild", async () => {
        // Two concurrent rebuilds interleave DELETE-then-INSERT over one companion,
        // and the second INSERT of a key the first already wrote breaks its primary key.
        expect.assertions(2);

        const seed = createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema: companionSchema });

        await seed.insert("notes", { org: "a", score: 1 });

        const provisionScope = {};
        const { exec, statements } = recording(harness.exec);
        const writers = [0, 1].map(() => createSqlCtxDb({ clock: () => 2, dialect, exec, provisionScope, schema: companionSchema }));

        await expect(Promise.all(writers.map((writer) => writer.count("notes", { org: "a" })))).resolves.toStrictEqual([1, 1]);

        expect(statements.filter((statement) => isRebuild(statement))).toHaveLength(1);
    });

    it("keeps an aggregate and a rank index whose names would join to the same key apart", async () => {
        // Keyed as `${table}::${name}` and `${table}::rank::${name}`, the counter
        // `rank::leaderboard` and the rank `leaderboard` shared one entry, and the
        // counter's rebuild stood in for the rank's.
        expect.assertions(2);

        const collidingSchema = {
            tables: {
                notes: {
                    aggregateIndexes: [{ by: [], name: "rank::leaderboard", on: "notes", op: "count" }],
                    indexes: [],
                    rankIndexes: [{ name: "leaderboard", on: "notes", sortBy: [{ direction: "desc", field: "score" }] }],
                    shape: { org: col("string"), score: col("number") },
                    shardMode: { kind: "global" },
                },
            },
        } as never;
        const seed = createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema: collidingSchema });
        const id = await seed.insert("notes", { org: "a", score: 1 });

        // Empty both companions behind the store's back so only a rebuild can fill them.
        harness.database.exec(`DELETE FROM "notes__agg_rank::leaderboard"; DELETE FROM "notes__rank_leaderboard"`);

        const writer = createSqlCtxDb({ clock: () => 2, dialect, exec: harness.exec, provisionScope: {}, schema: collidingSchema });

        await expect(writer.count("notes")).resolves.toBe(1);
        await expect(writer.rank("notes", "leaderboard", { row: id })).resolves.toStrictEqual({ position: 1, total: 1 });
    });

    it("rebuilds the companions after a write whose companion batch failed", async () => {
        // The row commits before its companion statements run. A failed batch leaves the counter one short, and a
        // settled rebuild kept for the scope would keep it that way for every later writer.
        expect.assertions(2);

        const provisionScope = {};
        let failCounter = false;
        const exec: SqlCtxExec = {
            ...harness.exec,
            batch: async (statements) => {
                if (failCounter && statements.some((statement) => statement.sql.includes(`"notes__agg_count_by_org"`))) {
                    throw new Error("connection reset");
                }

                await (harness.exec.batch as NonNullable<SqlCtxExec["batch"]>)(statements);
            },
            run: async (query, parameters) => {
                if (failCounter && query.includes(`"notes__agg_count_by_org"`)) {
                    throw new Error("connection reset");
                }

                return await harness.exec.run(query, parameters);
            },
        };
        const failing = createSqlCtxDb({ clock: () => 1, dialect, exec, provisionScope, schema: companionSchema });

        await failing.insert("notes", { org: "a", score: 1 });

        failCounter = true;

        await expect(failing.insert("notes", { org: "a", score: 2 })).rejects.toThrow("connection reset");

        failCounter = false;

        const next = createSqlCtxDb({ clock: () => 2, dialect, exec: harness.exec, provisionScope, schema: companionSchema });

        await expect(next.count("notes", { org: "a" })).resolves.toBe(2);
    });

    it("stops waiting on another writer's rebuild that never settles", async () => {
        // On Workers a request cancelled mid-rebuild can leave its run pending forever; every later writer in the
        // isolate would wait on it with it.
        expect.assertions(1);

        vi.useFakeTimers();

        try {
            const provisionScope = {};
            const stuck: SqlCtxExec = {
                ...harness.exec,
                all: async (query, parameters) => {
                    if (isSourcePage(query)) {
                        // Never settles, like a rebuild whose request was cancelled.
                        return await new Promise<never>(() => {});
                    }

                    return await harness.exec.all(query, parameters);
                },
            };
            const abandoned = createSqlCtxDb({ clock: () => 1, dialect, exec: stuck, provisionScope, schema: companionSchema });

            abandoned.count("notes", { org: "a" }).catch(() => undefined);

            const next = createSqlCtxDb({ clock: () => 2, dialect, exec: harness.exec, provisionScope, schema: companionSchema });
            const counted = next.count("notes", { org: "a" });

            await vi.advanceTimersByTimeAsync(30_000);

            await expect(counted).resolves.toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not record a companion as missing when patchIf runs before provisioning", async () => {
        // patchIf reached the companion check without provisioning first, so on a
        // store that had not created the counter yet it recorded "missing" for the
        // whole scope and every later write skipped the counter's deltas.
        expect.assertions(2);

        const plainSchema = { tables: { notes: { ...companionSchema.tables["notes"], aggregateIndexes: [], rankIndexes: [] } } } as never;
        const id = await createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema: plainSchema }).insert("notes", { org: "a", score: 1 });

        const { exec, statements } = recording(harness.exec);
        const writer = createSqlCtxDb({ clock: () => 2, dialect, exec, provisionScope: {}, schema: companionSchema });

        await expect(writer.patchIf?.("notes", id, { patch: { score: 2 }, where: { org: "a" } })).resolves.toMatchObject({ applied: true });

        statements.length = 0;
        await writer.count("notes", { org: "a" });

        // Read from the counter, not the scan fallback a "missing" record leaves behind.
        expect(statements.filter((statement) => statement.includes("COUNT(*)"))).toStrictEqual([]);
    });
});

describe("createSqlCtxDb — by-id writes pinned to a table", () => {
    let harness: ReturnType<typeof createSqliteBatchHarness>;
    let deletes: TriggerEventLike[];

    const schema: SchemaLike = {
        tables: {
            notes: {
                indexes: [],
                shape: { body: col("string") },
                shardMode: { kind: "global" },
                triggerMap: {
                    beforeDelete: {
                        handler: (_context: unknown, event: TriggerEventLike) => {
                            deletes.push(event);
                        },
                        op: "delete",
                        timing: "before",
                    },
                },
            },
            tags: { indexes: [], shape: { label: col("string") }, shardMode: { kind: "global" } },
        },
    } as never;

    beforeEach(() => {
        harness = createSqliteBatchHarness();
        deletes = [];
    });

    afterEach(() => {
        harness.close();
    });

    /** The id probe `tableNameFromId` fans out across tables. */
    const isProbe = (statement: string): boolean => statement.startsWith("SELECT 1 FROM");

    it("reads the row once, with no id probe ahead of it", async () => {
        // The row read that every pinned write does anyway answers whether the id
        // exists, so a `SELECT 1` probe first was a second round trip per write.
        expect.assertions(2);

        const { exec, statements } = recording(harness.exec);
        const writer = createSqlCtxDb({ clock: () => 1, dialect, exec, schema });
        const id = await writer.insert("notes", { body: "a" });

        await writer.patch("notes", id, { body: "b" });
        await writer.replace("notes", id, { body: "c" });
        await writer.delete("notes", id);

        expect(statements.filter((statement) => isProbe(statement))).toStrictEqual([]);
        await expect(writer.get("notes", id)).resolves.toBeNull();
    });

    it("still treats an id from another table as absent (IDOR)", async () => {
        expect.assertions(4);

        const writer = createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema });
        const tagId = await writer.insert("tags", { label: "x" });

        await expect(writer.patch("notes", tagId, { body: "b" })).rejects.toThrow(`document not found: ${tagId}`);
        await expect(writer.replace("notes", tagId, { body: "b" })).rejects.toThrow(`document not found: ${tagId}`);

        await writer.delete("notes", tagId);

        // A missing row is a no-op before any trigger runs.
        expect(deletes).toStrictEqual([]);
        await expect(writer.get("tags", tagId)).resolves.toMatchObject({ label: "x" });
    });

    it("refuses a pinned table that does not live in this store", async () => {
        expect.assertions(1);

        const writer = createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema });
        const id = await writer.insert("notes", { body: "a" });

        await expect(writer.patch("constructor", id, { body: "b" })).rejects.toThrow(`"constructor" is not a table in this schema`);
    });
});

describe("createSqlCtxDb — the changed-tables poll", () => {
    const LOG_ROWS = 2000;
    const LOG_TABLES = ["alpha", "beta", "gamma"];

    let harness: ReturnType<typeof createSqliteBatchHarness>;

    const schema: SchemaLike = {
        tables: Object.fromEntries(LOG_TABLES.map((table) => [table, { indexes: [], shape: { body: col("string") }, shardMode: { kind: "global" } }])),
    } as never;

    beforeEach(async () => {
        harness = createSqliteBatchHarness();

        // Provision the log through the store, then fill it directly: the rows are setup.
        await createSqlCtxDb({ cdc: true, clock: () => 1, dialect, exec: harness.exec, schema }).count("alpha");

        const append = harness.database.prepare(`INSERT INTO "__cdc_log" ("ts", "table", "id", "op", "doc") VALUES (?, ?, ?, 'insert', '{}')`);

        for (let index = 0; index < LOG_ROWS; index += 1) {
            append.run(index, LOG_TABLES[index % LOG_TABLES.length] as string, `x${String(index)}`);
        }
    });

    afterEach(() => {
        harness.close();
    });

    it("seeks each table in the log index rather than walking all of it", async () => {
        // The `GROUP BY "table"` form this replaced was planned as `SCAN __cdc_log USING COVERING INDEX`
        // without statistics (D1 keeps none): every poll read every row of the log for a delta of a few rows.
        expect.assertions(2);

        const { exec, statements } = recording(harness.exec);

        await createSqlCtxDb({ cdc: true, clock: () => 1, dialect, exec, schema }).cdcChangedTables?.(LOG_ROWS - 5);

        const poll = statements.find((statement) => statement.includes("WITH RECURSIVE")) as string;
        const plan = harness.database
            .prepare(`EXPLAIN QUERY PLAN ${poll}`)
            .all(LOG_ROWS - 5)
            .map((step) => String(step["detail"]));

        expect(plan.some((step) => step.includes("__cdc_log_table_seq (table=? AND seq>?)"))).toBe(true);
        expect(plan.filter((step) => step.startsWith("SCAN __cdc_log"))).toStrictEqual([]);
    });

    it("skips the retention DELETE with one index seek when nothing has expired", async () => {
        // The DELETE's `WHERE ts <= ? ORDER BY seq LIMIT` walks the log in `seq` order, so with nothing expired it
        // read every row of the log to delete none.
        expect.assertions(3);

        const { exec, statements } = recording(harness.exec);

        // Every row's `ts` is in [0, LOG_ROWS), so a cutoff of -1 expires none of them.
        await sweepSqlCdcRetention(exec, dialect, 10_000, 9999);

        expect(statements.filter((statement) => statement.trim().startsWith("DELETE"))).toStrictEqual([]);

        const probe = statements.find((statement) => statement.includes("LIMIT 1")) as string;
        const plan = harness.database
            .prepare(`EXPLAIN QUERY PLAN ${probe}`)
            .all(-1)
            .map((step) => String(step["detail"]));

        expect(plan).toStrictEqual(["SEARCH __cdc_log USING COVERING INDEX __cdc_log_ts (ts<?)"]);
        expect({ ...harness.database.prepare(`SELECT COUNT(*) AS n FROM "__cdc_log"`).get() }).toStrictEqual({ n: LOG_ROWS });
    });

    it("leaves the log without a ts index until a retention sweep runs", async () => {
        // Only the sweep's probe reads it; a log kept forever should not pay for it on every append.
        expect.assertions(2);

        const tsIndex = (): unknown =>
            harness.database.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = '__cdc_log_ts'`).get()?.["n"];

        expect(tsIndex()).toBe(0);

        await sweepSqlCdcRetention(harness.exec, dialect, 10_000, 9999);

        expect(tsIndex()).toBe(1);
    });

    it("drops and rebuilds a ts index a failed concurrent Postgres build left invalid", async () => {
        // `IF NOT EXISTS` takes an invalid index for the real one, and the planner never uses it. Both catalog
        // reads go through the table, and the drop names the index the catalog found on it: a bare name resolves
        // through `search_path` and can reach a same-named index on another schema's table.
        expect.assertions(2);

        const ddl: string[] = [];
        const lookups: unknown[][] = [];
        const postgres = { ...dialect, name: "postgres" } as typeof dialect;
        const exec: SqlCtxExec = {
            ...harness.exec,
            all: async (query, parameters) => {
                if (query.includes("pg_index")) {
                    lookups.push([...parameters]);

                    if (query.includes("::regclass::text")) {
                        ddl.push("lookup");

                        return [{ qualified: `"audit"."__cdc_log_ts"` }];
                    }

                    ddl.push("state");

                    return [{ indisvalid: false }];
                }

                return await harness.exec.all(query, parameters);
            },
            run: async (query, parameters) => {
                if (query.includes(" INDEX ")) {
                    ddl.push(query.replace(/ ON .*/u, ""));

                    return undefined;
                }

                return await harness.exec.run(query, parameters);
            },
        };

        await sweepSqlCdcRetention(exec, postgres, 10_000, 9999);

        expect(ddl).toStrictEqual(["state", "lookup", `DROP INDEX IF EXISTS "audit"."__cdc_log_ts"`, `CREATE INDEX CONCURRENTLY IF NOT EXISTS "__cdc_log_ts"`]);
        expect(lookups).toStrictEqual([
            ["__cdc_log", "__cdc_log_ts"],
            ["__cdc_log", "__cdc_log_ts"],
        ]);
    });

    it("still runs the bounded DELETE when the ts index cannot be built", async () => {
        // A build that keeps failing must not stop retention for as long as it fails.
        expect.assertions(2);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const exec: SqlCtxExec = {
            ...harness.exec,
            run: async (query, parameters) => {
                if (query.startsWith("CREATE INDEX")) {
                    throw new Error("out of disk");
                }

                return await harness.exec.run(query, parameters);
            },
        };

        // cutoff = 99: rows stamped 0..99 expire.
        await sweepSqlCdcRetention(exec, dialect, 10_000, 10_099);

        expect({ ...harness.database.prepare(`SELECT COUNT(*) AS n FROM "__cdc_log"`).get() }).toStrictEqual({ n: LOG_ROWS - 100 });
        expect(warn).toHaveBeenCalledTimes(1);

        warn.mockRestore();
    });

    it("still deletes the expired rows", async () => {
        expect.assertions(1);

        // cutoff = 99: rows stamped 0..99 expire.
        await sweepSqlCdcRetention(harness.exec, dialect, 10_000, 10_099);

        expect({ ...harness.database.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS oldest FROM "__cdc_log"`).get() }).toStrictEqual({
            n: LOG_ROWS - 100,
            oldest: 100,
        });
    });

    it("deletes expired rows behind a head stamped by a clock running ahead", async () => {
        // Writers stamp `ts` with their own clocks, so the lowest `seq` is not the oldest entry.
        expect.assertions(1);

        harness.database.prepare(`UPDATE "__cdc_log" SET "ts" = 1e12 WHERE "seq" = 1`).run();

        // cutoff = 99: rows stamped 1..99 expire; the head does not.
        await sweepSqlCdcRetention(harness.exec, dialect, 10_000, 10_099);

        expect({ ...harness.database.prepare(`SELECT COUNT(*) AS n, MIN(seq) AS head FROM "__cdc_log"`).get() }).toStrictEqual({
            head: 1,
            n: LOG_ROWS - 99,
        });
    });

    it("reports the same tables and cursor as grouping the log", async () => {
        expect.assertions(4);

        const writer = createSqlCtxDb({ cdc: true, clock: () => 1, dialect, exec: harness.exec, schema });
        const grouped = harness.database.prepare(`SELECT "table", MAX(seq) AS seq FROM "__cdc_log" WHERE seq > ? GROUP BY "table"`);

        for (const since of [0, LOG_ROWS - 2, LOG_ROWS - 1, LOG_ROWS]) {
            const expected = grouped.all(since);
            const cursor = Math.max(since, ...expected.map((row) => Number(row["seq"])));

            // eslint-disable-next-line no-await-in-loop -- one poll per cursor, compared in turn
            await expect(writer.cdcChangedTables?.(since)).resolves.toMatchObject({ cursor, tables: expected.map((row) => row["table"]) });
        }
    });
});
