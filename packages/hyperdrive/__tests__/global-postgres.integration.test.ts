import type { ColumnMetaLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import {
    backfillSqlSearchIndexes,
    readSqlCdcChangedTables,
    readSqlCdcChanges,
    runSqlAggregateMigrations,
    runSqlCdcMigration,
    runSqlGlobalTableMigrations,
    runSqlRankMigrations,
    sweepSqlCdcRetention,
} from "@lunora/sql-store";
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

// Distinct, increasing creation times: relevance ties are resolved by
// `_creationTime DESC` then id, and a fixed clock would collapse that
// tiebreak into engine-defined row order — a flaky assertion.
const tickingClock = (): (() => number) => {
    let now = FIXED_CLOCK;

    return () => {
        now += 1000;

        return now;
    };
};

/** The shared notes corpus, used by every search suite below. */
const seedNotes = async (writer: DatabaseWriterLike): Promise<void> => {
    await writer.insert("notes", { _id: "n1", body: "hello world", channel: "general", title: "one" }, { allowExplicitId: true });
    await writer.insert("notes", { _id: "n2", body: "hello hello wonderful world", channel: "general", title: "two" }, { allowExplicitId: true });
    await writer.insert("notes", { _id: "n3", body: "goodbye world", channel: "general", title: "three" }, { allowExplicitId: true });
    await writer.insert("notes", { _id: "n4", body: "hello world", channel: "other", title: "four" }, { allowExplicitId: true });
};

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

    describe("`.global()` changelog retention sweep", () => {
        /** A CDC-enabled writer over a migrated changelog, with a clock the test drives. */
        const setupCdc = async (now: () => number): Promise<DatabaseWriterLike> => {
            await runSqlGlobalTableMigrations(harness.exec, todosSchema, postgresDialect);
            await runSqlCdcMigration(harness.exec, postgresDialect);

            return createHyperdriveGlobalCtxDb({ cdc: true, clock: now, engine: "postgres", exec: harness.exec, schema: todosSchema });
        };

        it("sweeps by age and reports the retained floor", async () => {
            expect.assertions(3);

            let clock = FIXED_CLOCK;
            const writer = await setupCdc(() => clock);

            await writer.insert("todos", { _id: "t1", archived: false, priority: "hi", projectId: "p1", seq: 1 }, { allowExplicitId: true });
            clock = FIXED_CLOCK + 10_000;
            await writer.insert("todos", { _id: "t2", archived: false, priority: "hi", projectId: "p1", seq: 2 }, { allowExplicitId: true });

            await sweepSqlCdcRetention(harness.exec, postgresDialect, 5000, clock);

            // The older row is past the window; the newer one is inside it.
            const remaining = await readSqlCdcChanges(harness.exec, { sinceSeq: 1 }, postgresDialect);

            expect(remaining.changes.map((change) => change.id)).toEqual(["t2"]);

            // The floor is what a `.global()` shape poller reads to tell "nothing
            // changed" from "what changed was swept away" — so it has to survive
            // the dialect, not just SQLite.
            const probe = await readSqlCdcChangedTables(harness.exec, 0, postgresDialect, { retained: true });

            expect(probe.floor).toBe(2);

            // And a consumer below the floor is refused rather than handed the tail.
            await expect(readSqlCdcChanges(harness.exec, { sinceSeq: 0 }, postgresDialect)).rejects.toThrow(/trimmed/u);
        });

        it("hands the lease to exactly one sweeper per window", async () => {
            expect.assertions(1);

            let clock = FIXED_CLOCK;
            const writer = await setupCdc(() => clock);

            await writer.insert("todos", { _id: "t1", archived: false, priority: "hi", projectId: "p1", seq: 1 }, { allowExplicitId: true });
            clock = FIXED_CLOCK + 10_000;
            await writer.insert("todos", { _id: "t2", archived: false, priority: "hi", projectId: "p1", seq: 2 }, { allowExplicitId: true });

            // The lease is the whole of the cross-shard coordination — every shard
            // in every region writes this log, so without it they would all sweep
            // at once. On Postgres the claim rides `RETURNING`; the MySQL twin
            // takes the affected-rows branch instead, which is why both engines
            // carry this test.
            await sweepSqlCdcRetention(harness.exec, postgresDialect, 5000, clock);
            // A second sweeper inside the same window finds the lease held, so a
            // 0ms window that would otherwise delete everything does nothing.
            await sweepSqlCdcRetention(harness.exec, postgresDialect, 0, clock);

            const remaining = await readSqlCdcChanges(harness.exec, { sinceSeq: 1 }, postgresDialect);

            expect(remaining.changes.map((change) => change.id)).toEqual(["t2"]);
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
            expect.assertions(7);

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
            // node-postgres hands a BYTEA back as a Buffer; the decoder normalizes it
            // to a genuine ArrayBuffer so `v.bytes()`'s `instanceof ArrayBuffer` check
            // passes on this driver too — the round-trip is only real if the TYPE
            // survives as well as the bytes.
            expect(row?.["blob"]).toBeInstanceOf(ArrayBuffer);
            expect([...new Uint8Array(row?.["blob"] as ArrayBuffer)]).toEqual([1, 2, 3, 250]);
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

            return createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema: searchSchema });
        };

        it("matches every term, prefix-matches the last, and ranks by occurrences", async () => {
            expect.assertions(1);

            const writer = await setupNotes();

            await seedNotes(writer);

            const results = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "hello wor"))
                .collect();

            // n2 outranks on occurrence count ("hello" twice, plus
            // "wonderful"/"world" both matching the prefix); n1 and n4 tie on
            // score, so the newest wins. n3 misses "hello" entirely.
            expect(ids(results)).toEqual(["n2", "n4", "n1"]);
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

            const plainWriter = createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema: plainSchema });

            await seedNotes(plainWriter);

            const writer = createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema: searchSchema });
            const results = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "goodbye"))
                .collect();

            expect(ids(results)).toEqual(["n3"]);
        });

        it("matches a document whose only token satisfies both an exact and the prefix term", async () => {
            expect.assertions(1);

            const writer = await setupNotes();

            await writer.insert("notes", { _id: "n9", body: "javascript", channel: "general", title: "nine" }, { allowExplicitId: true });

            // "java" is the final (prefix) term and "javascript" the exact one;
            // the single stored token satisfies both. A shared first-match CASE
            // would count it once, fail the "matched every term" test, and drop
            // the row — while FTS5 and the JS scorer both match it.
            const results = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "javascript java"))
                .collect();

            expect(ids(results)).toEqual(["n9"]);
        });

        it("backfills a staged companion that writes have already populated", async () => {
            expect.assertions(2);

            // The realistic upgrade path: rows exist, the index is declared
            // later as `staged` (so the migration deliberately indexes nothing),
            // and a write lands before the host runs the backfill. Inferring
            // "already backfilled" from the companion having rows would strand
            // every pre-index row permanently — including from the explicit
            // runner, which is the documented remedy.
            const stagedSchema: SchemaLike = {
                tables: {
                    notes: {
                        ...searchSchema.tables["notes"]!,
                        searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body", staged: true }],
                    },
                },
            };
            const plainSchema: SchemaLike = {
                tables: { notes: { ...searchSchema.tables["notes"]!, searchIndexes: [] } },
            };

            await runSqlGlobalTableMigrations(harness.exec, plainSchema, postgresDialect);
            await seedNotes(createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema: plainSchema }));

            const writer = createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema: stagedSchema });

            // This write populates the companion for n5 alone…
            await writer.insert("notes", { _id: "n5", body: "goodbye latecomer", channel: "general", title: "five" }, { allowExplicitId: true });

            // A NEW index covers a growing PREFIX of the table, so a search over
            // it would return a confidently wrong subset — n5 alone here. The
            // read refuses instead. (A REBUILDING index is the other case: it
            // holds every row under stale analysis, so it keeps serving.)
            const beforeBackfill = writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "goodbye"))
                .collect();

            await expect(beforeBackfill).rejects.toThrow(/still backfilling/u);

            // …and the out-of-band backfill still reaches the pre-index rows.
            await backfillSqlSearchIndexes(harness.exec, stagedSchema, postgresDialect);

            const afterBackfill = await createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema: stagedSchema })
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "goodbye"))
                .collect();

            expect([...ids(afterBackfill)].toSorted((left, right) => String(left).localeCompare(String(right)))).toEqual(["n3", "n5"]);
        });

        it("applies an in-memory filter (the shape RLS installs) to search results", async () => {
            expect.assertions(1);

            const writer = await setupNotes();

            await seedNotes(writer);

            const results = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "world"))
                .filter((document) => document["title"] === "three")
                .collect();

            expect(ids(results)).toEqual(["n3"]);
        });

        it("refuses a page that reaches past the document cap, rather than reporting isDone", async () => {
            expect.assertions(1);

            const writer = await setupNotes();

            await seedNotes(writer);

            await expect(
                writer
                    .query("notes")
                    .withSearchIndex("by_body", (q) => q.search("body", "world"))
                    .paginate({ numItems: 1025 }),
            ).rejects.toThrow(/reaches the 1024-document limit/u);
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

    describe("full-text search (native Postgres strategy)", () => {
        const nativeSchema: SchemaLike = {
            tables: {
                notes: {
                    indexes: [],
                    searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body", strategy: "native" }],
                    shape: { body: col("string"), channel: col("string"), title: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        };

        const nativeWriter = async (): Promise<DatabaseWriterLike> => {
            await runSqlGlobalTableMigrations(harness.exec, nativeSchema, postgresDialect);

            return createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema: nativeSchema });
        };

        it("matches the same documents as the portable path", async () => {
            expect.assertions(3);

            const writer = await nativeWriter();

            await seedNotes(writer);

            // Matching must agree with every other backend — only the ordering
            // is the engine's. The vector is built from the same analyzed
            // tokens, so `simple` adds no stemming or stopwords of its own.
            const both = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "hello world"))
                .collect();
            const prefix = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "hello wor"))
                .collect();
            const missing = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "nonexistent"))
                .collect();

            expect([...ids(both)].toSorted((left, right) => String(left).localeCompare(String(right)))).toEqual(["n1", "n2", "n4"]);
            expect([...ids(prefix)].toSorted((left, right) => String(left).localeCompare(String(right)))).toEqual(["n1", "n2", "n4"]);
            expect(ids(missing)).toEqual([]);
        });

        it("narrows by an .eq() filter and follows updates and deletes", async () => {
            expect.assertions(3);

            const writer = await nativeWriter();

            await seedNotes(writer);

            const scoped = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "hello").eq("channel", "other"))
                .collect();

            await writer.patch("n1", { body: "totally rewritten" });
            await writer.delete("n2");

            const stale = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .collect();
            const fresh = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "rewritten"))
                .collect();

            expect(ids(scoped)).toEqual(["n4"]);
            expect(ids(stale)).toEqual(["n4"]);
            expect(ids(fresh)).toEqual(["n1"]);
        });

        it("folds accents through the engine index, because we hand it folded tokens", async () => {
            expect.assertions(1);

            const writer = await nativeWriter();

            await writer.insert("notes", { _id: "n9", body: "café society", channel: "general", title: "nine" }, { allowExplicitId: true });

            // Postgres compares bytes; this matches only because the analyzer
            // folded before the vector was built.
            const results = await writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "cafe"))
                .collect();

            expect(ids(results)).toEqual(["n9"]);
        });

        it("caps an oversized document instead of blowing tsvector's size limit", async () => {
            expect.assertions(1);

            const writer = await nativeWriter();
            // ~900 KB of prose. `to_tsvector` refuses a value over ~1 MB and
            // inflates roughly 1.5x on the way, so an uncapped column turns the
            // write into a raw Postgres error rather than a partial index.
            const body = Array.from({ length: 60_000 }, (_, index) => `word${String(index % 5000)}`).join(" ");

            await expect(writer.insert("notes", { body, channel: "general", title: "huge" })).resolves.toBeDefined();
        });

        it("indexes rows that predate the index through the same backfill", async () => {
            expect.assertions(1);

            const plainSchema: SchemaLike = {
                tables: { notes: { ...nativeSchema.tables["notes"]!, searchIndexes: [] } },
            };

            await runSqlGlobalTableMigrations(harness.exec, plainSchema, postgresDialect);
            await seedNotes(createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema: plainSchema }));

            const results = await createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema: nativeSchema })
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "goodbye"))
                .collect();

            expect(ids(results)).toEqual(["n3"]);
        });
    });

    describe("switching an index between layouts", () => {
        const portableSchema: SchemaLike = {
            tables: {
                notes: {
                    indexes: [],
                    searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
                    shape: { body: col("string"), channel: col("string"), title: col("string") },
                    shardMode: { kind: "global" },
                },
            },
        };
        const nativeSchema: SchemaLike = {
            tables: {
                notes: {
                    ...portableSchema.tables["notes"]!,
                    searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body", strategy: "native" }],
                },
            },
        };

        const writerFor = (schema: SchemaLike): DatabaseWriterLike =>
            createHyperdriveGlobalCtxDb({ clock: tickingClock(), engine: "postgres", exec: harness.exec, schema });

        it("rebuilds the companion instead of running DDL against the wrong shape", async () => {
            expect.assertions(3);

            await runSqlGlobalTableMigrations(harness.exec, portableSchema, postgresDialect);

            const portable = writerFor(portableSchema);

            await portable.insert("notes", { _id: "n1", body: "hello world", channel: "general", title: "one" }, { allowExplicitId: true });

            // The companion now holds (token, id, occurrences) rows. Flipping to
            // native must not leave that shape in place: the GIN DDL would then
            // reference a column that doesn't exist, and the throw escapes
            // `ensureMigrated` — taking every read and write down, not just search.
            const native = writerFor(nativeSchema);

            await expect(
                native
                    .query("notes")
                    .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                    .collect(),
            ).resolves.toStrictEqual([expect.objectContaining({ _id: "n1" })]);

            // Plain reads and writes keep working through the switch.
            await expect(native.get("n1")).resolves.toMatchObject({ title: "one" });
            await expect(native.insert("notes", { body: "after the flip", channel: "general", title: "two" })).resolves.toBeDefined();
        });

        it("rebuilds again when switching back", async () => {
            expect.assertions(1);

            await runSqlGlobalTableMigrations(harness.exec, nativeSchema, postgresDialect);

            const native = writerFor(nativeSchema);

            await native.insert("notes", { _id: "n1", body: "hello world", channel: "general", title: "one" }, { allowExplicitId: true });

            const results = await writerFor(portableSchema)
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .collect();

            expect(ids(results)).toEqual(["n1"]);
        });
    });
});
