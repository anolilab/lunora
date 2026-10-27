import type { SchemaLike, TriggerEventLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

        await writer.patch(id, { body: "b" }, "notes");
        await writer.replace(id, { body: "c" }, "notes");
        await writer.delete(id, "notes");

        expect(statements.filter((statement) => isProbe(statement))).toStrictEqual([]);
        await expect(writer.get("notes", id)).resolves.toBeNull();
    });

    it("still treats an id from another table as absent (IDOR)", async () => {
        expect.assertions(4);

        const writer = createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema });
        const tagId = await writer.insert("tags", { label: "x" });

        await expect(writer.patch(tagId, { body: "b" }, "notes")).rejects.toThrow(`document not found: ${tagId}`);
        await expect(writer.replace(tagId, { body: "b" }, "notes")).rejects.toThrow(`document not found: ${tagId}`);

        await writer.delete(tagId, "notes");

        // A missing row is a no-op before any trigger runs.
        expect(deletes).toStrictEqual([]);
        await expect(writer.get("tags", tagId)).resolves.toMatchObject({ label: "x" });
    });

    it("refuses a pinned table that does not live in this store", async () => {
        expect.assertions(1);

        const writer = createSqlCtxDb({ clock: () => 1, dialect, exec: harness.exec, schema });
        const id = await writer.insert("notes", { body: "a" });

        await expect(writer.patch(id, { body: "b" }, "constructor")).rejects.toThrow(`document not found: ${id}`);
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
