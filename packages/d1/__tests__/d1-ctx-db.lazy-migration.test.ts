import type { AggregateIndexDefinitionLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { createSqlCtxDb } from "@lunora/sql-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { D1Exec } from "../src/d1-ctx-db";
import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import sqliteDialect from "../src/sqlite-dialect";
import { createD1Exec, FTS5_IN_BUILD } from "./_helpers/node-sqlite-d1";

/**
 * Audit-fix coverage for the D1 column dialect.
 *
 * Lazy companion migration: the writer's per-ctx-db `ensureMigrated()` must
 * CREATE the fts5 / `__agg_` / `__rank_` companions before the first write
 * touches them, WITHOUT the host having called the `runD1*Migrations` helpers.
 * Search writes must no longer hit "no such table"; aggregate reads must return
 * the maintained value rather than silently scanning.
 *
 * groupBy emptied-group pruning: when a group's last contributing source row is
 * removed, the companion row must be DELETED (not zeroed) so the indexed
 * `groupBy` walk omits it, matching a SQL `GROUP BY`.
 *
 * Non-numeric avg divisor: an `avg` index over a field whose value is
 * non-numeric on one row must exclude that row from the divisor, so the indexed
 * result equals the scan result.
 *
 * Forced scan path: `searchViaScan` is exercised deterministically via a
 * no-fts5 `D1Exec` double, so the LIKE-scan fallback is covered even on a
 * `node:sqlite` build that happens to ship fts5.
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

const makeAggregateSchema = (...indexes: AggregateIndexDefinitionLike[]): SchemaLike => {
    return {
        tables: {
            todos: {
                aggregateIndexes: indexes,
                indexes: [],
                shape: {
                    projectId: col("string"),
                    seq: col("number"),
                },
            },
        },
    };
};

const searchSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
            shape: {
                body: col("string"),
                channel: col("string"),
                title: col("string"),
            },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const createTodosTable = (): void => {
    harness.ddl(
        `CREATE TABLE "todos" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "projectId" TEXT,
            "seq" INTEGER
        )`,
    );
};

const createDocsTable = (exec: D1Exec) =>
    exec.run(
        `CREATE TABLE "docs" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "body" TEXT,
            "channel" TEXT,
            "title" TEXT
        )`,
        [],
    );

describe("d1 ctx-db lazy companion migration", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it.skipIf(!FTS5_IN_BUILD)("creates the fts companion lazily so search writes and reads work without an explicit migration", async () => {
        expect.assertions(2);

        // Works on both engine variants: where fts5 is present, ensureMigrated
        // creates the shadow table and the fts path answers; where it's absent,
        // runD1SearchMigrations no-ops (gated on isFtsAvailable) and the scan
        // fallback answers. Either way the write must not throw "no such table".
        await createDocsTable(harness.exec);

        // No runD1SearchMigrations call — the writer must create the fts table.
        const writer = createD1ContextDatabase({ exec: harness.exec, idGenerator: () => "d1", schema: searchSchema });

        // The write paths sync the fts5 shadow table; they must not throw.
        await expect(writer.insert("docs", { body: "hello world", channel: "x", title: "a" })).resolves.toBeDefined();

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .collect();

        expect(results.map((document) => document["title"])).toStrictEqual(["a"]);
    });

    it.skipIf(!FTS5_IN_BUILD)("patch and delete do not throw against a lazily-created fts companion", async () => {
        expect.assertions(2);

        await createDocsTable(harness.exec);

        const writer = createD1ContextDatabase({ exec: harness.exec, idGenerator: () => "d1", schema: searchSchema });

        const id = await writer.insert("docs", { body: "first", channel: "x", title: "a" });

        await expect(writer.patch(id, { body: "second" })).resolves.toBeUndefined();
        await expect(writer.delete(id)).resolves.toBeUndefined();
    });

    it("aggregate reads the maintained counter without an explicit aggregate migration", async () => {
        expect.assertions(2);

        createTodosTable();

        const schema = makeAggregateSchema(sumSeqByProject);
        // No runD1AggregateMigrations — the writer's ensureMigrated() creates
        // the `__agg_` companion, so the indexed sum path answers the read.
        const writer = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema });

        await writer.insert("todos", { _id: "t1", projectId: "p1", seq: 1 }, { allowExplicitId: true });
        await writer.insert("todos", { _id: "t2", projectId: "p1", seq: 2 }, { allowExplicitId: true });

        await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(3);

        // The companion table exists (proving the read used it, not a scan).
        // eslint-disable-next-line no-secrets/no-secrets -- high-entropy literal is just the deterministic companion-table name, not a secret
        const tables = await harness.exec.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, ["todos__agg_sumSeqByProject"]);

        expect(tables).toHaveLength(1);
    });
});

describe("d1 ctx-db groupBy emptied-group pruning", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    const seedTwoGroups = async (writer: DatabaseWriterLike): Promise<void> => {
        await writer.insert("todos", { _id: "t1", projectId: "p1", seq: 1 }, { allowExplicitId: true });
        await writer.insert("todos", { _id: "t2", projectId: "p1", seq: 2 }, { allowExplicitId: true });
        await writer.insert("todos", { _id: "t3", projectId: "p2", seq: 5 }, { allowExplicitId: true });
    };

    it("omits an emptied group from an indexed count groupBy (matches SQL GROUP BY)", async () => {
        expect.assertions(2);

        createTodosTable();

        const writer = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema: makeAggregateSchema(byProject) });

        await seedTwoGroups(writer);

        await writer.delete("t3"); // empties p2

        const groups = await writer.groupBy("todos", { by: ["projectId"] });
        const keys = groups.map((g) => g.key["projectId"]).toSorted((a, b) => String(a).localeCompare(String(b)));

        // p2 is omitted entirely — no phantom { p2, value: 0 } row.
        expect(keys).toStrictEqual(["p1"]);
        expect(Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]))).toStrictEqual({ p1: 2 });
    });

    it("omits an emptied group from an indexed sum groupBy", async () => {
        expect.assertions(2);

        createTodosTable();

        const writer = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema: makeAggregateSchema(sumSeqByProject) });

        await seedTwoGroups(writer);

        await writer.delete("t3"); // empties p2

        const groups = await writer.groupBy("todos", { agg: { field: "seq", op: "sum" }, by: ["projectId"] });
        const keys = groups.map((g) => g.key["projectId"]).toSorted((a, b) => String(a).localeCompare(String(b)));

        expect(keys).toStrictEqual(["p1"]);
        expect(Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]))).toStrictEqual({ p1: 3 });
    });

    it("omits a group emptied by a by-key move (patch decrements the old group to zero)", async () => {
        expect.assertions(1);

        createTodosTable();

        const writer = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema: makeAggregateSchema(byProject) });

        await seedTwoGroups(writer);

        await writer.patch("t3", { projectId: "p1" }); // p2's only row moves to p1 → p2 empties

        const groups = await writer.groupBy("todos", { by: ["projectId"] });

        // The move must prune the now-empty p2 companion row, not leave a phantom.
        expect(groups.map((g) => g.key["projectId"])).toStrictEqual(["p1"]);
    });

    it("a sum group with value 0 but rows present is NOT pruned", async () => {
        expect.assertions(1);

        createTodosTable();

        const writer = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema: makeAggregateSchema(sumSeqByProject) });

        // Two rows whose seq cancels to 0 — the group is non-empty (count 2),
        // so it must still appear with value 0.
        await writer.insert("todos", { _id: "t1", projectId: "p1", seq: 5 }, { allowExplicitId: true });
        await writer.insert("todos", { _id: "t2", projectId: "p1", seq: -5 }, { allowExplicitId: true });

        const groups = await writer.groupBy("todos", { agg: { field: "seq", op: "sum" }, by: ["projectId"] });

        expect(Object.fromEntries(groups.map((g) => [g.key["projectId"], g.value]))).toStrictEqual({ p1: 0 });
    });
});

describe("d1 ctx-db avg divisor excludes non-numeric fields", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("indexed avg matches the scan avg when one row's field is non-numeric", async () => {
        expect.assertions(2);

        createTodosTable();

        // Indexed writer maintains the `__agg_` companion; a separate scan
        // writer (no aggregate index) answers via SQL AVG. Both must agree.
        const indexedWriter = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema: makeAggregateSchema(avgSeqByProject) });

        // seq is non-numeric (null) on t2 — it contributes neither to the
        // running sum nor the avg divisor, on both the indexed path
        // (`coerceAggregateNumber(null)` is undefined) and the SQL `AVG` scan
        // (which skips NULLs). Numeric rows: 2, 4.
        await indexedWriter.insert("todos", { _id: "t1", projectId: "p1", seq: 2 }, { allowExplicitId: true });
        await indexedWriter.insert("todos", { _id: "t2", projectId: "p1", seq: null }, { allowExplicitId: true });
        await indexedWriter.insert("todos", { _id: "t3", projectId: "p1", seq: 4 }, { allowExplicitId: true });

        const indexed = await indexedWriter.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p1" } });

        // Scan reader over the same physical rows (no aggregate index → SQL AVG,
        // which also skips the non-numeric "oops" string).
        const scanWriter = createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec: harness.exec, schema: makeAggregateSchema() });
        const scan = await scanWriter.aggregate("todos", { field: "seq", op: "avg", where: { projectId: "p1" } });

        expect(indexed).toBe(3); // (2 + 4) / 2
        expect(indexed).toBe(scan);
    });
});

describe("d1 ctx-db search forced scan path", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    it("uses the portable inverted index when fts5 is unavailable", async () => {
        expect.assertions(2);

        const { exec } = harness;

        await createDocsTable(exec);

        let counter = 0;
        const idGenerator = (): string => {
            counter += 1;

            return `d${String(counter)}`;
        };

        // ensureMigrated() runs runD1SearchMigrations, which materializes the
        // portable `(token, id, occurrences)` companion on an engine without
        // fts5 — the shape Postgres and MySQL behind Hyperdrive use.
        const writer = createSqlCtxDb({ dialect: { ...sqliteDialect, supportsFts5: false }, exec, idGenerator, schema: searchSchema });

        await writer.insert("docs", { body: "alpha beta", channel: "x", title: "low" });
        await writer.insert("docs", { body: "alpha alpha alpha", channel: "x", title: "high" });

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "alpha"))
            .collect();

        // Term-frequency ranking, identical to the fts5 path: "high" outranks "low".
        expect(results.map((document) => document["title"])).toStrictEqual(["high", "low"]);

        // The companion holds one row per (token, document) — three for
        // "alpha beta" / "alpha alpha alpha".
        const tokens = await harness.exec.all(`SELECT "__token__", "__id__", "__n__" FROM "docs__fts_by_body" ORDER BY "__token__", "__id__"`, []);

        // Re-shaped into plain objects: `node:sqlite` hands back null-prototype rows.
        expect(
            tokens.map((row) => {
                return { id: row["__id__"], n: row["__n__"], token: row["__token__"] };
            }),
        ).toStrictEqual([
            { id: "d1", n: 1, token: "alpha" },
            { id: "d2", n: 3, token: "alpha" },
            { id: "d1", n: 1, token: "beta" },
        ]);
    });
});
