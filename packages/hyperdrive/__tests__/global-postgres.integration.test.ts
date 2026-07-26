import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { runSqlAggregateMigrations, runSqlGlobalTableMigrations, runSqlRankMigrations } from "@lunora/sql-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHyperdriveGlobalCtxDb } from "../src/global";
import { postgresDialect } from "../src/global-dialect";
import type { PgliteHarness } from "./_helpers/pglite-exec";
import createPgliteHarness from "./_helpers/pglite-exec";

/**
 * The store core (`createSqlCtxDb`) driven by the Postgres dialect against a
 * real embedded Postgres (`pglite`). This is the second real-engine gate
 * alongside the D1 suite's `node:sqlite` — it proves the Postgres SQL the core
 * generates (column types, `RETURNING` OCC, `ON CONFLICT`, value codec) actually
 * runs, and it backs the drizzle dialect rebuild.
 */
const FIXED_CLOCK = 1_700_000_000_000;

const col = (kind: string, column: Partial<ColumnMetaLike> = {}): ValidatorLike => {
    return {
        _meta: { column: { notNull: true, ...column } },
        kind,
    };
};

const todosSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: {
                archived: col("boolean"),
                priority: col("string"),
                projectId: col("string"),
                seq: col("number"),
            },
            shardMode: { kind: "global" },
        },
    },
};

let harness: PgliteHarness;

const setupTodos = async (): Promise<DatabaseWriterLike> => {
    await runSqlGlobalTableMigrations(harness.exec, todosSchema, postgresDialect);

    return createHyperdriveGlobalCtxDb({ clock: () => FIXED_CLOCK, engine: "postgres", exec: harness.exec, schema: todosSchema });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: false, priority: "high", projectId: "p1", seq: 1 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", archived: false, priority: "medium", projectId: "p1", seq: 2 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", archived: true, priority: "low", projectId: "p1", seq: 3 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t4", archived: false, priority: "high", projectId: "p2", seq: 4 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t5", archived: false, priority: "high", projectId: "p1", seq: 0 }, { allowExplicitId: true });
};

const ids = (docs: Record<string, unknown>[]): unknown[] => docs.map((document_) => document_["_id"]);

describe("hyperdrive global — Postgres (pglite) integration", () => {
    beforeEach(async () => {
        harness = await createPgliteHarness();
    });

    afterEach(async () => {
        await harness.close();
    });

    describe("findMany — where filtering", () => {
        it("filters by an equality field, defaulting to creation+id order", async () => {
            expect.assertions(3);

            const writer = await setupTodos();

            await seed(writer);

            const result = await writer.findMany("todos", { where: { projectId: "p1" } });

            expect(ids(result.page)).toEqual(["t1", "t2", "t3", "t5"]);
            expect(result.isDone).toBe(true);
            expect(result.continueCursor).toBeNull();
        });

        it("combines equality, boolean and `in` operators", async () => {
            expect.assertions(1);

            const writer = await setupTodos();

            await seed(writer);

            const result = await writer.findMany("todos", {
                where: { archived: false, priority: { in: ["high", "medium"] }, projectId: "p1" },
            });

            expect(ids(result.page)).toEqual(["t1", "t2", "t5"]);
        });

        it("decodes a stored boolean column back into a boolean", async () => {
            expect.assertions(2);

            const writer = await setupTodos();

            await seed(writer);

            const archived = await writer.findFirst("todos", { where: { _id: "t3" } });
            const active = await writer.findFirst("todos", { where: { _id: "t1" } });

            expect(archived?.["archived"]).toBe(true);
            expect(active?.["archived"]).toBe(false);
        });

        it("supports comparison and isNull operators", async () => {
            expect.assertions(2);

            const writer = await setupTodos();

            await seed(writer);

            const highSeq = await writer.findMany("todos", { where: { seq: { gt: 2 } } });

            expect(ids(highSeq.page).toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(["t3", "t4"]);

            const contains = await writer.findMany("todos", { where: { priority: { contains: "med" } } });

            expect(ids(contains.page)).toEqual(["t2"]);
        });
    });

    describe("mutations + OCC", () => {
        it("inserts, patches, replaces and deletes a row", async () => {
            expect.assertions(4);

            const writer = await setupTodos();

            const id = await writer.insert("todos", { archived: false, priority: "low", projectId: "p9", seq: 7 });

            await writer.patch(id, { priority: "high" });
            const patched = await writer.findFirst("todos", { where: { _id: id } });

            expect(patched?.["priority"]).toBe("high");

            await writer.replace(id, { archived: true, priority: "mid", projectId: "p9", seq: 8 });
            const replaced = await writer.findFirst("todos", { where: { _id: id } });

            expect(replaced?.["archived"]).toBe(true);
            expect(replaced?.["seq"]).toBe(8);

            await writer.delete(id);

            await expect(writer.findFirst("todos", { where: { _id: id } })).resolves.toBeNull();
        });

        it("rejects a duplicate explicit id as a conflict", async () => {
            expect.assertions(1);

            const writer = await setupTodos();

            await writer.insert("todos", { _id: "dup", archived: false, priority: "x", projectId: "p", seq: 1 }, { allowExplicitId: true });

            await expect(
                writer.insert("todos", { _id: "dup", archived: false, priority: "y", projectId: "p", seq: 2 }, { allowExplicitId: true }),
            ).rejects.toThrow(/unique constraint/u);
        });
    });

    describe("value codec round-trips (per kind)", () => {
        const typesSchema: SchemaLike = {
            tables: {
                things: {
                    indexes: [],
                    shape: {
                        big: col("bigint"),
                        blob: col("bytes"),
                        flag: col("boolean"),
                        meta: col("object"),
                        n: col("number"),
                        title: col("string"),
                    },
                    shardMode: { kind: "global" },
                },
            },
        };

        it("round-trips bigint, bytes, boolean, object, number and string through Postgres", async () => {
            expect.assertions(6);

            await runSqlGlobalTableMigrations(harness.exec, typesSchema, postgresDialect);
            const writer = createHyperdriveGlobalCtxDb({ clock: () => FIXED_CLOCK, engine: "postgres", exec: harness.exec, schema: typesSchema });

            const bytes = new Uint8Array([1, 2, 3, 250]);
            const id = await writer.insert("things", {
                big: 9_007_199_254_740_993n,
                blob: bytes,
                flag: true,
                meta: { a: 1, nested: ["x", "y"] },
                n: 3.5,
                title: "hello",
            });

            const row = await writer.findFirst("things", { where: { _id: id } });

            expect(row?.["big"]).toBe(9_007_199_254_740_993n);
            expect(row?.["flag"]).toBe(true);
            expect(row?.["n"]).toBe(3.5);
            expect(row?.["title"]).toBe("hello");
            expect(row?.["meta"]).toEqual({ a: 1, nested: ["x", "y"] });
            expect([...(row?.["blob"] as Uint8Array)]).toEqual([1, 2, 3, 250]);
        });
    });

    // Regression: the `tableExists` catalog probe (which backs the aggregate/rank
    // companion-existence checks) used to hand-build a `?`-placeholder string and
    // bypass renderSql — invalid on Postgres ($N only). Any global table with an
    // aggregate or rank index would throw on its first write/read. These exercise
    // both probe call sites (counterTableExists + rankTableExists) on real PG.
    describe("aggregate + rank companions (tableExists probe)", () => {
        const aggregateSchema: SchemaLike = {
            tables: {
                todos: {
                    aggregateIndexes: [{ by: ["projectId"], field: "seq", name: "sumSeqByProject", on: "todos", op: "sum" }],
                    indexes: [],
                    shape: { archived: col("boolean"), priority: col("string"), projectId: col("string"), seq: col("number") },
                    shardMode: { kind: "global" },
                },
            },
        };
        const rankSchema: SchemaLike = {
            tables: {
                todos: {
                    indexes: [],
                    rankIndexes: [{ name: "bySeq", on: "todos", partitionBy: ["projectId"], sortBy: [{ direction: "asc", field: "seq" }] }],
                    shape: { archived: col("boolean"), priority: col("string"), projectId: col("string"), seq: col("number") },
                    shardMode: { kind: "global" },
                },
            },
        };

        it("count() + aggregate() hit the indexed aggregate counter without a placeholder error", async () => {
            expect.assertions(2);

            await runSqlGlobalTableMigrations(harness.exec, aggregateSchema, postgresDialect);
            await runSqlAggregateMigrations(harness.exec, aggregateSchema, postgresDialect);
            const writer = createHyperdriveGlobalCtxDb({ clock: () => FIXED_CLOCK, engine: "postgres", exec: harness.exec, schema: aggregateSchema });

            await seed(writer);

            await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
            await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
        });

        it("rankPage() hits the indexed rank companion (sort-key storage + tableExists probe)", async () => {
            expect.assertions(1);

            await runSqlGlobalTableMigrations(harness.exec, rankSchema, postgresDialect);
            await runSqlRankMigrations(harness.exec, rankSchema, postgresDialect);
            const writer = createHyperdriveGlobalCtxDb({ clock: () => FIXED_CLOCK, engine: "postgres", exec: harness.exec, schema: rankSchema });

            await seed(writer);

            const page = await writer.rankPage("todos", "bySeq", { where: { projectId: "p1" } });

            expect(ids(page.page)).toEqual(["t5", "t1", "t2", "t3"]);
        });
    });

    describe("full-text search (portable inverted index)", () => {
        const searchSchema: SchemaLike = {
            tables: {
                notes: {
                    indexes: [],
                    searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
                    shape: { body: col("string"), channel: col("string"), title: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        };

        const setupNotes = async (): Promise<DatabaseWriterLike> => {
            await runSqlGlobalTableMigrations(harness.exec, searchSchema, postgresDialect);

            return createHyperdriveGlobalCtxDb({ clock: () => FIXED_CLOCK, engine: "postgres", exec: harness.exec, schema: searchSchema });
        };

        const seedNotes = async (writer: DatabaseWriterLike): Promise<void> => {
            await writer.insert("notes", { _id: "n1", body: "hello world", channel: "general", title: "one" }, { allowExplicitId: true });
            await writer.insert("notes", { _id: "n2", body: "hello hello wonderful world", channel: "general", title: "two" }, { allowExplicitId: true });
            await writer.insert("notes", { _id: "n3", body: "goodbye world", channel: "general", title: "three" }, { allowExplicitId: true });
            await writer.insert("notes", { _id: "n4", body: "hello world", channel: "other", title: "four" }, { allowExplicitId: true });
        };

        it("matches every term, prefix-matches the last, and ranks by occurrences", async () => {
            expect.assertions(1);

            const writer = await setupNotes();

            await seedNotes(writer);

            const results = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "hello wor"))
                .collect();

            // n2 outranks the others on occurrence count ("hello" twice, plus
            // "wonderful"/"world" both matching the prefix); n3 misses "hello".
            expect(ids(results)).toEqual(["n2", "n1", "n4"]);
        });

        it("narrows by an .eq() filter field", async () => {
            expect.assertions(1);

            const writer = await setupNotes();

            await seedNotes(writer);

            const results = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "hello").eq("channel", "other"))
                .collect();

            expect(ids(results)).toEqual(["n4"]);
        });

        it("keeps the companion in step with updates and deletes", async () => {
            expect.assertions(2);

            const writer = await setupNotes();

            await seedNotes(writer);
            await writer.patch("n1", { body: "totally rewritten" });
            await writer.delete("n4");

            const stale = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .collect();
            const fresh = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "rewritten"))
                .collect();

            expect(ids(stale)).toEqual(["n2"]);
            expect(ids(fresh)).toEqual(["n1"]);
        });

        it("indexes rows that predate the search index on first migration", async () => {
            expect.assertions(1);

            // Write the rows through a schema *without* the search index, so the
            // companion sees them only via the migration-time backfill.
            const plainSchema: SchemaLike = {
                tables: { notes: { ...searchSchema.tables["notes"]!, searchIndexes: [] } },
            };

            await runSqlGlobalTableMigrations(harness.exec, plainSchema, postgresDialect);

            const plainWriter = createHyperdriveGlobalCtxDb({ clock: () => FIXED_CLOCK, engine: "postgres", exec: harness.exec, schema: plainSchema });

            await seedNotes(plainWriter);

            const writer = createHyperdriveGlobalCtxDb({ clock: () => FIXED_CLOCK, engine: "postgres", exec: harness.exec, schema: searchSchema });
            const results = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "goodbye"))
                .collect();

            expect(ids(results)).toEqual(["n3"]);
        });

        it("pages through the relevance-ordered results", async () => {
            expect.assertions(3);

            const writer = await setupNotes();

            await seedNotes(writer);

            const firstPage = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "world"))
                .paginate({ numItems: 2 });

            expect(firstPage.isDone).toBe(false);
            expect(firstPage.page).toHaveLength(2);

            const secondPage = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "world"))
                .paginate({ cursor: firstPage.continueCursor, numItems: 2 });

            expect([...ids([...firstPage.page, ...secondPage.page])].toSorted((left, right) => String(left).localeCompare(String(right)))).toEqual([
                "n1",
                "n2",
                "n3",
                "n4",
            ]);
        });
    });
});
