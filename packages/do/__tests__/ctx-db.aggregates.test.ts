import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AggregateIndexDefinitionLike } from "../src/aggregates.js";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db.js";
import { backfillAggregateIndexes, createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

/**
 * Exercises the aggregate-index runtime — trigger-maintained counters, indexed
 * vs scan planning, the RLS coupling seam, and the lazy/explicit backfill paths
 * — against a real SQLite engine.
 */

const byProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "byProject",
    on: "todos",
    op: "count",
};

const byProjectArchived: AggregateIndexDefinitionLike = {
    by: ["projectId", "archived"],
    name: "byProjectArchived",
    on: "todos",
    op: "count",
};

/** Whole-table aggregate (no `by`). */
const totalTodos: AggregateIndexDefinitionLike = {
    by: [],
    name: "total",
    on: "todos",
    op: "count",
};

const activeByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "activeByProject",
    on: "todos",
    op: "count",
    where: { archived: false },
};

const makeSchema = (...indexes: AggregateIndexDefinitionLike[]): SchemaLike => {
 return {
    tables: {
        todos: {
            aggregateIndexes: indexes,
            indexes: [{ fields: ["projectId"], name: "by_project" }],
            shape: {
                archived: { kind: "boolean" },
                projectId: { kind: "string" },
                seq: { kind: "number" },
            },
        },
    },
};
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (schema: SchemaLike): DatabaseWriterLike => {
    runShardMigrations(harness.sql, schema);

    return createShardCtxDb({ clock: () => 1_700_000_000_000, schema, sql: harness.sql });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: false, projectId: "p1", seq: 1 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", archived: false, projectId: "p1", seq: 2 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", archived: true, projectId: "p1", seq: 3 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t4", archived: false, projectId: "p2", seq: 4 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t5", archived: false, projectId: "p1", seq: 0 }, { allowExplicitId: true });
};

describe("ctx-db aggregates", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("aggregateIndex trigger maintenance", () => {
        it("insert/update/delete keep the counter in step with row writes", async () => {
            expect.assertions(5);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            // Indexed counters now visible.
            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
            await expect(writer.count("todos", { projectId: "p2" })).resolves.toBe(1);

            await writer.patch("t4", { projectId: "p1" });

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(5);
            await expect(writer.count("todos", { projectId: "p2" })).resolves.toBe(0);

            await writer.delete("t1");

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        });

        it("replace updates the counter when the `by`-key changes", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            await writer.replace("t1", { archived: false, projectId: "p3", seq: 99 });

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(3);
            await expect(writer.count("todos", { projectId: "p3" })).resolves.toBe(1);
        });

        it("filtered aggregateIndex (.where) only counts matching rows", async () => {
            expect.assertions(3);

            const writer = setupWriter(makeSchema(activeByProject));

            await seed(writer);

            // The reader can't route this directly through the index for users
            // because the user request doesn't carry { archived: false }, but the
            // counter table still reflects only active rows. We verify the
            // structural counter by reading via aggregate scan with the same
            // baseline.
            await expect(writer.count("todos", { archived: false, projectId: "p1" })).resolves.toBe(3);
            await expect(writer.count("todos", { archived: false, projectId: "p2" })).resolves.toBe(1);

            await writer.patch("t1", { archived: true });

            await expect(writer.count("todos", { archived: false, projectId: "p1" })).resolves.toBe(2);
        });

        it("whole-table aggregate (empty `by`) keys on the empty tuple", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema(totalTodos));

            await seed(writer);

            await expect(writer.count("todos")).resolves.toBe(5);

            await writer.delete("t3");

            await expect(writer.count("todos")).resolves.toBe(4);
        });
    });

    describe("aggregateIndex planning", () => {
        it("matching by-key request hits the counter (no scan)", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProjectArchived));

            await seed(writer);

            // Drop the source rows behind the writer's back; if the counter is
            // routed correctly the read still returns the cached value.
            harness.raw(`DELETE FROM "todos"`);

            await expect(writer.count("todos", { archived: false, projectId: "p1" })).resolves.toBe(3);
        });

        it("non-equality filter falls back to a scan", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            // `seq > 1` isn't on a `by`-key — the planner must fall through to
            // SCAN even though `byProject` is declared.
            await expect(writer.count("todos", { seq: { gt: 1 } })).resolves.toBe(3);
        });

        it("partial by-key falls back when more-specific index is missing", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProjectArchived));

            await seed(writer);

            // Index is by (projectId, archived); request asks for only projectId.
            // Without a single-key index we must scan.
            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        });

        it("prefers narrower aggregateIndex when multiple match", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProject, byProjectArchived));

            await seed(writer);

            harness.raw(`DELETE FROM "todos"`);

            // Both indexes match; the planner picks `byProjectArchived` (longer by).
            await expect(writer.count("todos", { archived: false, projectId: "p1" })).resolves.toBe(3);
        });
    });

    describe("rLS coupling seam", () => {
        it("aND-merges baseWhere into the scan predicate", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema());

            await seed(writer);

            await expect(writer.count("todos", { baseWhere: { archived: false }, where: { projectId: "p1" } })).resolves.toBe(3);
        });

        it("restrictsCounts throws COUNT_RLS_UNSUPPORTED", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            await expect(writer.count("todos", { restrictsCounts: true, where: { projectId: "p1" } })).rejects.toMatchObject({
                code: "COUNT_RLS_UNSUPPORTED",
                name: "CirrusError",
            });
        });

        it("legacy bare where keeps working (no breakage)", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
            await expect(writer.count("todos")).resolves.toBe(5);
        });
    });

    describe("aggregate + groupBy", () => {
        it("aggregate(sum, field) reduces matching rows", async () => {
            expect.assertions(2);

            const writer = setupWriter(makeSchema());

            await seed(writer);

            await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
            await expect(writer.aggregate("todos", { field: "seq", op: "max" })).resolves.toBe(4);
        });

        it("aggregate({ op: count }) defers to count() and uses the index", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema(byProject));

            await seed(writer);

            harness.raw(`DELETE FROM "todos"`);

            await expect(writer.aggregate("todos", { op: "count", where: { projectId: "p1" } })).resolves.toBe(4);
        });

        it("groupBy(by, agg=count) tallies per group", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema());

            await seed(writer);

            const groups = await writer.groupBy("todos", { by: ["projectId"] });
            const tally = Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]));

            expect(tally).toEqual({ p1: 4, p2: 1 });
        });

        it("groupBy(by, agg=sum) reduces per group with a where", async () => {
            expect.assertions(1);

            const writer = setupWriter(makeSchema());

            await seed(writer);

            const groups = await writer.groupBy("todos", {
                agg: { field: "seq", op: "sum" },
                by: ["projectId"],
                where: { archived: false },
            });
            const tally = Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]));

            expect(tally).toEqual({ p1: 3, p2: 4 });
        });
    });

    describe("auto-backfill", () => {
        it("lazily backfills the counter on first read when the table already has rows", async () => {
            expect.assertions(2);

            // Phase 1: a writer with no aggregateIndex declarations. The counter
            // table does not exist yet.
            let writer = setupWriter(makeSchema());

            await seed(writer);

            // Phase 2: redeclare the schema with byProject and re-run migrations.
            // The counter table appears empty; the next read must backfill it.
            const schemaWithIndex = makeSchema(byProject);

            runShardMigrations(harness.sql, schemaWithIndex);
            writer = createShardCtxDb({ clock: () => 1_700_000_000_000, schema: schemaWithIndex, sql: harness.sql });

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);

            // Wipe the source rows to prove the second read goes through the now-
            // populated counter, not a fallback scan.
            harness.raw(`DELETE FROM "todos"`);

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        });

        it("backfillAggregateIndexes() populates counters up-front", async () => {
            expect.assertions(2);

            let writer = setupWriter(makeSchema());

            await seed(writer);

            const schemaWithIndex = makeSchema(byProject);

            runShardMigrations(harness.sql, schemaWithIndex);
            backfillAggregateIndexes(harness.sql, schemaWithIndex);

            // The counter table is now populated independently of any read.
            const rows = harness.raw(`SELECT "__key__", "__value__" FROM "todos__agg_byProject"`);

            expect(rows).toHaveLength(2);

            writer = createShardCtxDb({ clock: () => 1_700_000_000_000, schema: schemaWithIndex, sql: harness.sql });

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
        });
    });
});
