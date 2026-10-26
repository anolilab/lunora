import type { SchemaLike, TriggerEventLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import { createSqliteBatchHarness, makeSqliteDialect } from "./_helpers/sqlite";

/**
 * Pins the statements a `.global()` read or write sends, where a regression is a round trip rather than a wrong
 * answer. On D1 every statement here is a network call from the Worker, so the count is the latency.
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
