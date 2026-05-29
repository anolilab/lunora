import type { AggregateIndexDefinitionLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@cirrus/do";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createD1CtxDb, runD1AggregateMigrations } from "../src/d1-ctx-db.js";
import { createD1Exec } from "./_helpers/node-sqlite-d1.js";

/**
 * Mirror of `@cirrus/do`'s ctx-db.aggregates suite against the D1 column
 * dialect, covering trigger-maintained counters, indexed/scan planning, the
 * RLS coupling seam, and the migration helper that materializes counter
 * tables.
 */

const col = (kind: string): ValidatorLike => ({ _meta: { column: { notNull: true } }, kind });

const byProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "byProject",
    on: "todos",
    op: "count",
};

const makeSchema = (...indexes: AggregateIndexDefinitionLike[]): SchemaLike => ({
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
});

let harness: ReturnType<typeof createD1Exec>;

const setupWriter = async (schema: SchemaLike): Promise<DatabaseWriterLike> => {
    harness.ddl(
        `CREATE TABLE "todos" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "archived" INTEGER,
            "projectId" TEXT,
            "seq" INTEGER
        )`,
    );

    await runD1AggregateMigrations(harness.exec, schema);

    return createD1CtxDb({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: false, projectId: "p1", seq: 1 });
    await writer.insert("todos", { _id: "t2", archived: false, projectId: "p1", seq: 2 });
    await writer.insert("todos", { _id: "t3", archived: true, projectId: "p1", seq: 3 });
    await writer.insert("todos", { _id: "t4", archived: false, projectId: "p2", seq: 4 });
    await writer.insert("todos", { _id: "t5", archived: false, projectId: "p1", seq: 0 });
};

beforeEach(() => {
    harness = createD1Exec();
});

afterEach(() => {
    harness.close();
});

describe("D1 aggregateIndex parity", () => {
    test("trigger-maintained counter answers indexed reads", async () => {
        const writer = await setupWriter(makeSchema(byProject));

        await seed(writer);

        await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        await expect(writer.count("todos", { projectId: "p2" })).resolves.toBe(1);

        await writer.patch("t4", { projectId: "p1" });

        await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(5);
    });

    test("falls back to SCAN when the counter companion table is absent", async () => {
        // Skip runD1AggregateMigrations — counter table doesn't exist.
        harness.ddl(
            `CREATE TABLE "todos" (
                "id" TEXT PRIMARY KEY,
                "_creationTime" INTEGER NOT NULL,
                "archived" INTEGER,
                "projectId" TEXT,
                "seq" INTEGER
            )`,
        );

        const schema = makeSchema(byProject);
        const writer = createD1CtxDb({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });

        await seed(writer);

        // SCAN still returns the right answer.
        await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
    });

    test("aggregate(sum) reduces matching rows via SQL", async () => {
        const writer = await setupWriter(makeSchema());

        await seed(writer);

        await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
    });

    test("groupBy tallies per group via SQL", async () => {
        const writer = await setupWriter(makeSchema());

        await seed(writer);

        const groups = await writer.groupBy("todos", { by: ["projectId"] });
        const tally = Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]));

        expect(tally).toEqual({ p1: 4, p2: 1 });
    });

    test("restrictsCounts throws COUNT_RLS_UNSUPPORTED", async () => {
        const writer = await setupWriter(makeSchema(byProject));

        await seed(writer);

        await expect(writer.count("todos", { restrictsCounts: true, where: { projectId: "p1" } })).rejects.toMatchObject({
            code: "COUNT_RLS_UNSUPPORTED",
            name: "CirrusError",
        });
    });

    test("baseWhere is AND-merged into the SCAN predicate", async () => {
        const writer = await setupWriter(makeSchema());

        await seed(writer);

        await expect(writer.count("todos", { baseWhere: { archived: false }, where: { projectId: "p1" } })).resolves.toBe(3);
    });
});
