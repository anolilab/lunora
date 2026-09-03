import type { AggregateIndexDefinitionLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase, runD1AggregateMigrations } from "../src/d1-ctx-db";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * Mirror of `@lunora/do`'s ctx-db.aggregates suite against the D1 column
 * dialect, covering trigger-maintained counters, indexed/scan planning, the
 * RLS coupling seam, and the migration helper that materializes counter
 * tables.
 */

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const byProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "byProject",
    on: "todos",
    op: "count",
};

const sumSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "sumSeqByProject",
    on: "todos",
    op: "sum",
};

const avgSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "avgSeqByProject",
    on: "todos",
    op: "avg",
};

const minSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "minSeqByProject",
    on: "todos",
    op: "min",
};

const maxSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "maxSeqByProject",
    on: "todos",
    op: "max",
};

const activeSumSeqByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "activeSumSeqByProject",
    on: "todos",
    op: "sum",
    where: { archived: false },
};

const makeSchema = (...indexes: AggregateIndexDefinitionLike[]): SchemaLike => {
    return {
        tables: {
            todos: {
                aggregateIndexes: indexes,
                indexes: [],
                shape: {
                    archived: col("boolean"),
                    projectId: col("string"),
                    seq: col("number"),
                },
            },
        },
    };
};

let harness: ReturnType<typeof createD1Exec>;

const setupWriter = async (schema: SchemaLike): Promise<DatabaseWriterLike> => {
    harness.ddl(
        `CREATE TABLE "todos" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "archived" INTEGER,
            "projectId" TEXT,
            "seq" INTEGER
        )`,
    );

    await runD1AggregateMigrations(harness.exec, schema);

    return createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: false, projectId: "p1", seq: 1 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", archived: false, projectId: "p1", seq: 2 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", archived: true, projectId: "p1", seq: 3 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t4", archived: false, projectId: "p2", seq: 4 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t5", archived: false, projectId: "p1", seq: 0 }, { allowExplicitId: true });
};

describe("d1 aggregateIndex parity", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("trigger-maintained counter answers indexed reads", async () => {
        expect.assertions(3);

        const writer = await setupWriter(makeSchema(byProject));

        await seed(writer);

        await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        await expect(writer.count("todos", { projectId: "p2" })).resolves.toBe(1);

        await writer.patch("t4", { projectId: "p1" });

        await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(5);
    });

    it("falls back to SCAN when the counter companion table is absent", async () => {
        expect.assertions(1);

        // Skip runD1AggregateMigrations — counter table doesn't exist.
        harness.ddl(
            `CREATE TABLE "todos" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "_version" INTEGER,
                "archived" INTEGER,
                "projectId" TEXT,
                "seq" INTEGER
            )`,
        );

        const schema = makeSchema(byProject);
        const writer = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });

        await seed(writer);

        // SCAN still returns the right answer.
        await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
    });

    it("aggregate(sum) reduces matching rows via SQL", async () => {
        expect.assertions(1);

        const writer = await setupWriter(makeSchema());

        await seed(writer);

        await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
    });

    it("groupBy tallies per group via SQL", async () => {
        expect.assertions(1);

        const writer = await setupWriter(makeSchema());

        await seed(writer);

        const groups = await writer.groupBy("todos", { by: ["projectId"] });
        const tally = Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]));

        expect(tally).toEqual({ p1: 4, p2: 1 });
    });

    it("restrictsCounts throws COUNT_RLS_UNSUPPORTED", async () => {
        expect.assertions(1);

        const writer = await setupWriter(makeSchema(byProject));

        await seed(writer);

        await expect(writer.count("todos", { restrictsCounts: true, where: { projectId: "p1" } })).rejects.toMatchObject({
            code: "COUNT_RLS_UNSUPPORTED",
            name: "LunoraError",
        });
    });

    it("baseWhere is AND-merged into the SCAN predicate", async () => {
        expect.assertions(1);

        const writer = await setupWriter(makeSchema());

        await seed(writer);

        await expect(writer.count("todos", { baseWhere: { archived: false }, where: { projectId: "p1" } })).resolves.toBe(3);
    });

    describe("reducer-aware aggregate indexes (D1 column dialect)", () => {
        it("aggregate(sum) reads the maintained running sum, no scan", async () => {
            expect.assertions(2);

            const writer = await setupWriter(makeSchema(sumSeqByProject));

            await seed(writer);

            await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);

            await writer.patch("t1", { seq: 10 }); // p1: 6 - 1 + 10 = 15

            await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(15);
        });

        it("aggregate(sum) honors the index static `where`", async () => {
            expect.assertions(1);

            const writer = await setupWriter(makeSchema(activeSumSeqByProject));

            await seed(writer);

            // Active p1 rows (seq 1,2,0) → 3 (archived t3 excluded).
            await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(3);
        });

        it("aggregate(avg) reads sum/count as the maintained average", async () => {
            expect.assertions(2);

            const writer = await setupWriter(makeSchema(avgSeqByProject));

            await seed(writer);

            await expect(writer.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p1" } })).resolves.toBe(1.5);

            await writer.delete("t4"); // p2 empties

            await expect(writer.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p2" } })).resolves.toBeNull();
        });

        it("aggregate(min/max) maintains the extreme across delete + shrinking update", async () => {
            expect.assertions(4);

            const writer = await setupWriter(makeSchema(minSeqByProject, maxSeqByProject));

            await seed(writer);

            await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p1" } })).resolves.toBe(0);
            await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(3);

            await writer.delete("t5"); // removes the p1 min (0) → new min is 1
            await writer.patch("t3", { seq: 1 }); // the p1 max (3) shrinks to 1 → new max is 2

            await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p1" } })).resolves.toBe(1);
            await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(2);
        });

        it("aggregate(min) returns null when the group empties", async () => {
            expect.assertions(1);

            const writer = await setupWriter(makeSchema(minSeqByProject));

            await seed(writer);

            await writer.delete("t4"); // p2's only row

            await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p2" } })).resolves.toBeNull();
        });

        it("groupBy reads each group's maintained value per op", async () => {
            expect.assertions(4);

            const writer = await setupWriter(makeSchema(sumSeqByProject, avgSeqByProject, minSeqByProject, maxSeqByProject));

            await seed(writer);

            const sums = await writer.groupBy("todos", { agg: { field: "seq", op: "sum" }, by: ["projectId"] });
            const avgs = await writer.groupBy("todos", { agg: { field: "seq", op: "avg" }, by: ["projectId"] });
            const mins = await writer.groupBy("todos", { agg: { field: "seq", op: "min" }, by: ["projectId"] });
            const maxes = await writer.groupBy("todos", { agg: { field: "seq", op: "max" }, by: ["projectId"] });

            expect(Object.fromEntries(sums.map((g) => [g.key["projectId"], g.value]))).toEqual({ p1: 6, p2: 4 });
            expect(Object.fromEntries(avgs.map((g) => [g.key["projectId"], g.value]))).toEqual({ p1: 1.5, p2: 4 });
            expect(Object.fromEntries(mins.map((g) => [g.key["projectId"], g.value]))).toEqual({ p1: 0, p2: 4 });
            expect(Object.fromEntries(maxes.map((g) => [g.key["projectId"], g.value]))).toEqual({ p1: 3, p2: 4 });
        });

        it("lazy backfill computes per-op values on first read", async () => {
            expect.assertions(4);

            const schema = makeSchema(sumSeqByProject, avgSeqByProject, minSeqByProject, maxSeqByProject);
            const writer = await setupWriter(schema);

            // Seed through a writer that never declared the indexes, then read
            // through one that does — the read must backfill the companions.
            const seedWriter = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema: makeSchema() });

            await seed(seedWriter);

            await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
            await expect(writer.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p1" } })).resolves.toBe(1.5);
            await expect(writer.aggregate("todos", { field: "seq", op: "min", where: { projectId: "p1" } })).resolves.toBe(0);
            await expect(writer.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p1" } })).resolves.toBe(3);
        });

        it("falls back to SCAN for sum when the companion table is absent", async () => {
            expect.assertions(1);

            // Skip runD1AggregateMigrations — companion doesn't exist; the SCAN
            // path must still answer correctly.
            harness.ddl(
                `CREATE TABLE "todos" (
                    "id" TEXT PRIMARY KEY,
                    "_creationTime" INTEGER NOT NULL,
                    "_version" INTEGER,
                    "archived" INTEGER,
                    "projectId" TEXT,
                    "seq" INTEGER
                )`,
            );

            const schema = makeSchema(sumSeqByProject);
            const writer = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });

            await seed(writer);

            await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
        });
    });
});
