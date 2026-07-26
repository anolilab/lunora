/* eslint-disable no-secrets/no-secrets -- companion table names like "__agg_todos_sumSeqByProject" trip the entropy heuristic; they're not secrets. */
import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { runSqlAggregateMigrations, runSqlGlobalTableMigrations, runSqlRankMigrations } from "@lunora/sql-store";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createHyperdriveGlobalCtxDb } from "../src/global";
import { mysqlDialect } from "../src/global-dialect";
import type { MysqlHarness } from "./_helpers/mysql-mem";
import { tryCreateMysqlHarness } from "./_helpers/mysql-mem";

/**
 * The store core (`createSqlCtxDb`) driven by the MySQL dialect against a **real
 * MySQL 8.0** (`mysql-memory-server`). The third real-engine gate, alongside the
 * D1 suite's `node:sqlite` and the pglite Postgres suite — it proves the MySQL
 * SQL the core renders through drizzle (backticks, `?`, `ON DUPLICATE KEY`,
 * affected-rows OCC with `CLIENT_FOUND_ROWS`) actually executes.
 *
 * mysqld download/start is slow, so the server is shared across the suite and
 * tables are dropped per test.
 *
 * `mysql-memory-server` downloads the MySQL binary on first use; in sandboxes
 * where that download is blocked (e.g. an egress proxy answering 403) the whole
 * suite skips — with the captured reason — instead of failing on an environment
 * limitation.
 */
const FIXED_CLOCK = 1_700_000_000_000;
const STARTUP_TIMEOUT = 180_000;
const TEST_TIMEOUT = 30_000;

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

let harness: MysqlHarness;
let mysqlUnavailable: string | undefined;

const writerFor = (schema: SchemaLike): DatabaseWriterLike =>
    createHyperdriveGlobalCtxDb({ clock: () => FIXED_CLOCK, engine: "mysql", exec: harness.exec, schema });

const setupTodos = async (): Promise<DatabaseWriterLike> => {
    await runSqlGlobalTableMigrations(harness.exec, todosSchema, mysqlDialect);

    return writerFor(todosSchema);
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("todos", { _id: "t1", archived: false, priority: "high", projectId: "p1", seq: 1 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t2", archived: false, priority: "medium", projectId: "p1", seq: 2 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t3", archived: true, priority: "low", projectId: "p1", seq: 3 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t4", archived: false, priority: "high", projectId: "p2", seq: 4 }, { allowExplicitId: true });
    await writer.insert("todos", { _id: "t5", archived: false, priority: "high", projectId: "p1", seq: 0 }, { allowExplicitId: true });
};

const ids = (docs: Record<string, unknown>[]): unknown[] => docs.map((document_) => document_["_id"]);

describe("hyperdrive global — MySQL (mysql-memory-server) integration", () => {
    beforeAll(async () => {
        const result = await tryCreateMysqlHarness();

        if (result.harness) {
            harness = result.harness;
        } else {
            mysqlUnavailable = result.unavailable;
        }
    }, STARTUP_TIMEOUT);

    beforeEach(async (context) => {
        if (mysqlUnavailable !== undefined) {
            context.skip(mysqlUnavailable);
        }

        await harness.query("DROP TABLE IF EXISTS `todos`");
        await harness.query("DROP TABLE IF EXISTS `things`");
        await harness.query("DROP TABLE IF EXISTS `__agg_todos_sumSeqByProject`");
        await harness.query("DROP TABLE IF EXISTS `__rank_todos_bySeq`");
    });

    afterAll(async () => {
        await harness?.close();
    });

    describe("findMany — where filtering + ordering", () => {
        it(
            "filters, orders, and decodes booleans through backtick-quoted MySQL SQL",
            async () => {
                expect.assertions(4);

                const writer = await setupTodos();

                await seed(writer);

                const page = await writer.findMany("todos", { where: { archived: false, priority: { in: ["high", "medium"] }, projectId: "p1" } });

                expect(ids(page.page)).toEqual(["t1", "t2", "t5"]);

                const ordered = await writer.findMany("todos", { where: { projectId: "p1" } });

                expect(ids(ordered.page)).toEqual(["t1", "t2", "t3", "t5"]);

                const archived = await writer.findFirst("todos", { where: { _id: "t3" } });

                expect(archived?.["archived"]).toBe(true);

                const contains = await writer.findMany("todos", { where: { priority: { contains: "med" } } });

                expect(ids(contains.page)).toEqual(["t2"]);
            },
            TEST_TIMEOUT,
        );
    });

    describe("mutations + OCC (affected-rows / FOUND_ROWS)", () => {
        it(
            "inserts, patches, replaces, deletes, and rejects a duplicate id",
            async () => {
                expect.assertions(4);

                const writer = await setupTodos();

                const id = await writer.insert("todos", { archived: false, priority: "low", projectId: "p9", seq: 7 });

                await writer.patch(id, { priority: "high" });
                const patched = await writer.findFirst("todos", { where: { _id: id } });

                expect(patched?.["priority"]).toBe("high");

                await writer.replace(id, { archived: true, priority: "mid", projectId: "p9", seq: 8 });
                const replaced = await writer.findFirst("todos", { where: { _id: id } });

                expect(replaced?.["seq"]).toBe(8);

                await writer.delete(id);

                await expect(writer.findFirst("todos", { where: { _id: id } })).resolves.toBeNull();

                await writer.insert("todos", { _id: "dup", archived: false, priority: "x", projectId: "p", seq: 1 }, { allowExplicitId: true });

                await expect(
                    writer.insert("todos", { _id: "dup", archived: false, priority: "y", projectId: "p", seq: 2 }, { allowExplicitId: true }),
                ).rejects.toThrow(/unique constraint/u);
            },
            TEST_TIMEOUT,
        );

        it(
            "an idempotent patch (same values) does NOT raise a spurious OCC conflict — proves CLIENT_FOUND_ROWS",
            async () => {
                expect.assertions(1);

                const writer = await setupTodos();
                const id = await writer.insert("todos", { archived: false, priority: "low", projectId: "p9", seq: 7 });

                // Re-writing identical values changes 0 rows; without CLIENT_FOUND_ROWS the
                // affected-rows OCC guard would see 0 and throw. With it, it sees the matched row.
                await expect(writer.patch(id, { priority: "low" })).resolves.not.toThrow();
            },
            TEST_TIMEOUT,
        );
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

        it(
            "round-trips bigint, bytes, boolean, object, number and string through MySQL",
            async () => {
                expect.assertions(6);

                await runSqlGlobalTableMigrations(harness.exec, typesSchema, mysqlDialect);
                const writer = writerFor(typesSchema);

                const id = await writer.insert("things", {
                    big: 9_007_199_254_740_993n,
                    blob: new Uint8Array([1, 2, 3, 250]),
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
            },
            TEST_TIMEOUT,
        );
    });

    describe("aggregate + rank companions", () => {
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

        it(
            "count() + aggregate() over the indexed aggregate counter",
            async () => {
                expect.assertions(2);

                await runSqlGlobalTableMigrations(harness.exec, aggregateSchema, mysqlDialect);
                await runSqlAggregateMigrations(harness.exec, aggregateSchema, mysqlDialect);
                const writer = writerFor(aggregateSchema);

                await seed(writer);

                await expect(writer.count("todos", { projectId: "p1" })).resolves.toBe(4);
                await expect(writer.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p1" } })).resolves.toBe(6);
            },
            TEST_TIMEOUT,
        );

        it(
            "rankPage() over the indexed rank companion (per-kind sort-key column)",
            async () => {
                expect.assertions(1);

                await runSqlGlobalTableMigrations(harness.exec, rankSchema, mysqlDialect);
                await runSqlRankMigrations(harness.exec, rankSchema, mysqlDialect);
                const writer = writerFor(rankSchema);

                await seed(writer);

                const page = await writer.rankPage("todos", "bySeq", { where: { projectId: "p1" } });

                expect(ids(page.page)).toEqual(["t5", "t1", "t2", "t3"]);
            },
            TEST_TIMEOUT,
        );
    });

    describe("composite string indexes (InnoDB 3072-byte key limit)", () => {
        const compositeIndexSchema: SchemaLike = {
            tables: {
                todos: {
                    // A [string, number] and a [string, string] index — the idiomatic
                    // `.index("by_project", ["projectId", "seq"])` shape. Each string column
                    // is LONGTEXT and gets a MySQL key prefix; at the old flat 768-char prefix
                    // (3072 bytes) a composite that also carries a string field renders a
                    // >3072-byte key and MySQL rejects CREATE INDEX with ER_TOO_LONG_KEY (1071).
                    indexes: [
                        { fields: ["projectId", "seq"], name: "by_project_seq" },
                        { fields: ["priority", "projectId"], name: "by_priority_project" },
                    ],
                    shape: { archived: col("boolean"), priority: col("string"), projectId: col("string"), seq: col("number") },
                    shardMode: { kind: "global" },
                },
            },
        };

        it(
            "migrates composite [string, number] and [string, string] indexes without ER_TOO_LONG_KEY",
            async () => {
                expect.assertions(2);

                await expect(runSqlGlobalTableMigrations(harness.exec, compositeIndexSchema, mysqlDialect)).resolves.toBeUndefined();

                const indexes = await harness.query("SHOW INDEX FROM `todos`");
                const names = new Set(indexes.map((row) => row["Key_name"]));

                expect(names.has("todos_by_project_seq") && names.has("todos_by_priority_project")).toBe(true);
            },
            TEST_TIMEOUT,
        );
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

        const seedNotes = async (writer: DatabaseWriterLike): Promise<void> => {
            await writer.insert("notes", { _id: "n1", body: "hello world", channel: "general", title: "one" }, { allowExplicitId: true });
            await writer.insert("notes", { _id: "n2", body: "hello hello wonderful world", channel: "general", title: "two" }, { allowExplicitId: true });
            await writer.insert("notes", { _id: "n3", body: "goodbye world", channel: "general", title: "three" }, { allowExplicitId: true });
            await writer.insert("notes", { _id: "n4", body: "hello world", channel: "other", title: "four" }, { allowExplicitId: true });
        };

        it(
            "creates the companion within the 3072-byte key limit and ranks by occurrences",
            async () => {
                expect.assertions(2);

                await harness.query("DROP TABLE IF EXISTS `notes__fts_by_body`");
                await harness.query("DROP TABLE IF EXISTS `notes`");
                await runSqlGlobalTableMigrations(harness.exec, searchSchema, mysqlDialect);

                const writer = writerFor(searchSchema);

                await seedNotes(writer);

                const results = await writer
                    .query("notes")
                    .withSearchIndex("by_body", (q) => q.search("body", "hello wor"))
                    .collect();

                // Both companion columns carry the dialect's VARCHAR(768) `key`
                // type, so the (token, id) btree only fits under a key prefix.
                const indexes = await harness.query("SHOW INDEX FROM `notes__fts_by_body`");

                expect(new Set(indexes.map((row) => row["Key_name"])).has("notes__fts_by_body__btree")).toBe(true);
                expect(ids(results)).toEqual(["n2", "n1", "n4"]);
            },
            TEST_TIMEOUT,
        );

        it(
            "narrows by an .eq() filter field and follows updates",
            async () => {
                expect.assertions(2);

                await harness.query("DROP TABLE IF EXISTS `notes__fts_by_body`");
                await harness.query("DROP TABLE IF EXISTS `notes`");
                await runSqlGlobalTableMigrations(harness.exec, searchSchema, mysqlDialect);

                const writer = writerFor(searchSchema);

                await seedNotes(writer);

                const scoped = await writer
                    .query("notes")
                    .withSearchIndex("by_body", (q) => q.search("body", "hello").eq("channel", "other"))
                    .collect();

                await writer.patch("n2", { body: "totally rewritten" });

                const fresh = await writer
                    .query("notes")
                    .withSearchIndex("by_body", (q) => q.search("body", "rewritten"))
                    .collect();

                expect(ids(scoped)).toEqual(["n4"]);
                expect(ids(fresh)).toEqual(["n2"]);
            },
            TEST_TIMEOUT,
        );
    });
});
