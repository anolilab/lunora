import { DatabaseSync } from "node:sqlite";

import { MAX_INDEXED_TOKENS } from "@lunora/search-core";
import type { SchemaLike, SearchIndexDefinitionLike, TableDefinitionLike, ValidatorLike } from "@lunora/shard-engine";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlDialect } from "../src/dialect";
import type { SearchLayout, SearchStage } from "../src/search-layout";
import {
    companionFor,
    companionProfile,
    fts5Layout,
    globalSearchIndexes,
    invertedLayout,
    nativeLayout,
    purgeDocument,
    resolveSearchLayout,
} from "../src/search-layout";
import type { SqlCtxExec } from "../src/sql-exec";

/**
 * The storage layouts a `.global()` search index can take, tested directly.
 *
 * These used to be reachable only through the two downstream adapters, which
 * meant the layout seam itself — the three-way resolution, the DDL each layout
 * emits, the rendering that differs per engine — was covered incidentally by
 * whichever backend a suite happened to stand up. Anything an adapter didn't
 * exercise (a MySQL key prefix, a second engine implementing the native
 * contract, the caps and the chunking) was covered by nobody.
 *
 * Everything runs against a real `node:sqlite`, except the per-engine rendering
 * checks, which use a recording exec because the point *is* the emitted SQL.
 */

/**
 * Whether this Node build's `node:sqlite` carries the FTS5 module. It was
 * switched on in 22.16.0 (nodejs/node#57621), so 22.15.x and older lack it
 * while 22.16+ and every 24.x have it — and `^22.15.0` is this repo's `engines`
 * floor, so the floor is exactly the build that skips the `fts5Layout` block
 * below. CI's `test` job probes the same thing per matrix leg and reports it,
 * so a green run says which Node exercised FTS5 rather than leaving it unsaid.
 */
const FTS5_IN_BUILD = ((): boolean => {
    const database = new DatabaseSync(":memory:");

    try {
        database.prepare(`CREATE VIRTUAL TABLE "__fts5_build_probe__" USING fts5(x)`).all();

        return true;
    } catch {
        return false;
    } finally {
        database.close();
    }
})();

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const notes = {
    indexes: [],
    searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
    shape: { body: col("string"), channel: col("string") },
    shardMode: { kind: "global" },
} as unknown as TableDefinitionLike;

const byBody = (notes as unknown as { searchIndexes: SearchIndexDefinitionLike[] }).searchIndexes[0]!;

const stageFor = (query: string, filters: { field: string; value: unknown }[] = [], index: SearchIndexDefinitionLike = byBody): SearchStage => {
    return { definition: index, field: index.field, filters, hasQuery: true, indexName: index.name, query };
};

const sqliteDialect = (overrides: Partial<SqlDialect> = {}): SqlDialect => {
    return {
        columnType: () => "TEXT",
        companionTypes: { autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT", integer: "INTEGER", key: "TEXT", real: "REAL", text: "TEXT" },
        frameworkColumns: () => [
            { name: "id", type: "TEXT PRIMARY KEY" },
            { name: "_creationTime", type: "REAL NOT NULL" },
        ],
        isUniqueViolation: (error) => error instanceof Error && /unique constraint failed/iu.test(error.message),
        name: "sqlite",
        supportsFts5: true,
        supportsReturning: true,
        tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
        ...overrides,
    };
};

const createHarness = (): { close: () => void; exec: SqlCtxExec; raw: (query: string, ...parameters: unknown[]) => Record<string, unknown>[] } => {
    const database = new DatabaseSync(":memory:");
    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => database.prepare(query).all(...(parameters as never[]));

    return {
        close: () => {
            database.close();
        },
        exec: {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        },
        raw: (query, ...parameters) => all(query, parameters),
    };
};

/**
 * A real `node:sqlite`-backed exec that additionally implements `batch`,
 * running every statement in the array against the same database and
 * counting how many times `batch` itself was called (vs `run`). Exercises the
 * write paths' batch seam against a genuine engine rather than a stub, so a
 * test asserting "one batch call" also proves the batched rows actually land.
 */
const createBatchingHarness = (): {
    batchCalls: () => number;
    close: () => void;
    exec: SqlCtxExec;
    raw: (query: string, ...parameters: unknown[]) => Record<string, unknown>[];
    runCalls: () => number;
} => {
    const database = new DatabaseSync(":memory:");
    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => database.prepare(query).all(...(parameters as never[]));
    let batches = 0;
    let runs = 0;

    return {
        batchCalls: () => batches,
        close: () => {
            database.close();
        },
        exec: {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            batch: (statements) => {
                batches += 1;

                for (const statement of statements) {
                    all(statement.sql, statement.params);
                }

                return Promise.resolve();
            },
            run: (query, parameters) => {
                runs += 1;
                all(query, parameters);

                return Promise.resolve();
            },
        },
        raw: (query, ...parameters) => all(query, parameters),
        runCalls: () => runs,
    };
};

/** An exec that records the SQL it is handed and returns nothing — for the rendering assertions. */
const recordingExec = (): { exec: SqlCtxExec; statements: string[] } => {
    const statements: string[] = [];

    return {
        exec: {
            all: (query) => {
                statements.push(query);

                return Promise.resolve([]);
            },
            run: (query) => {
                statements.push(query);

                return Promise.resolve();
            },
        },
        statements,
    };
};

let harness: ReturnType<typeof createHarness>;

const seedDocuments = (rows: { body: string; channel: string; id: string }[]): void => {
    harness.raw(`CREATE TABLE "notes" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "body" TEXT, "channel" TEXT)`);

    let creationTime = 1_700_000_000_000;

    for (const row of rows) {
        creationTime += 1000;
        harness.raw(`INSERT INTO "notes" ("id", "_creationTime", "body", "channel") VALUES (?, ?, ?, ?)`, row.id, creationTime, row.body, row.channel);
    }
};

/** Index every seeded row through a layout, the way the backfill does. */
const indexAll = async (layout: SearchLayout, dialect: SqlDialect, rows: { body: string; channel: string; id: string }[]): Promise<void> => {
    const companion = companionFor("notes", byBody);

    await layout.ensureCompanion(harness.exec, dialect, companion);

    for (const row of rows) {
        // eslint-disable-next-line no-await-in-loop -- companion writes are sequential on one connection, as in the real backfill
        await layout.indexDocument(harness.exec, dialect, companion, row.id, { body: row.body, channel: row.channel }, byBody);
    }
};

const CORPUS = [
    { body: "hello world", channel: "general", id: "a" },
    { body: "hello hello wonderful world", channel: "general", id: "b" },
    { body: "goodbye world", channel: "other", id: "c" },
    { body: "javascript", channel: "general", id: "d" },
];

// One outer block so the shared engine setup lives inside a describe, as the
// suite convention requires.
describe("search layouts", () => {
    beforeEach(() => {
        harness = createHarness();
    });

    afterEach(() => {
        harness.close();
    });

    /**
     * Which layout an index gets. Three inputs decide it — the declared strategy,
     * whether the dialect has a native full-text index, and whether the engine
     * ships FTS5 — and getting it wrong is not a degraded search but a companion
     * whose columns don't match the statements written against it.
     */
    describe("resolveSearchLayout", () => {
        const nativeCapable = sqliteDialect({
            nativeTextSearch: {
                createCompanion: (companion) => sql`CREATE TABLE ${sql.identifier(companion)} (x TEXT)`,
                createIndexes: () => [],
                indexDocument: (companion) => sql`INSERT INTO ${sql.identifier(companion)} (x) VALUES ('')`,
                matches: (companion) => sql`${sql.identifier(companion)}.x = ''`,
                rank: (companion) => sql`${sql.identifier(companion)}.x`,
            },
        });

        it("uses the engine's own index only when the schema asked for it and the dialect has one", () => {
            expect.assertions(2);

            expect(resolveSearchLayout({ field: "body", name: "by_body", strategy: "native" }, nativeCapable).name).toBe("native");
            // The same declaration on an engine with no native index must not route
            // there — the members would no-op and the index would silently hold
            // nothing rather than fall back to something that works.
            expect(resolveSearchLayout({ field: "body", name: "by_body", strategy: "native" }, sqliteDialect()).name).toBe("fts5");
        });

        it("falls back along the engine's capability when no strategy is declared", () => {
            expect.assertions(2);

            expect(resolveSearchLayout(byBody, sqliteDialect()).name).toBe("fts5");
            expect(resolveSearchLayout(byBody, sqliteDialect({ supportsFts5: false })).name).toBe("inverted");
        });

        it("treats an explicit portable strategy as 'not the engine's own', not as 'the inverted table'", () => {
            expect.assertions(2);

            // `portable` promises identical behaviour everywhere, which the FTS5
            // shadow also delivers — it is the *native* index that is opted into.
            expect(resolveSearchLayout({ field: "body", name: "by_body", strategy: "portable" }, nativeCapable).name).toBe("fts5");
            expect(resolveSearchLayout({ field: "body", name: "by_body", strategy: "portable" }, sqliteDialect({ supportsFts5: false })).name).toBe("inverted");
        });
    });

    /**
     * The profile recorded with a companion's backfill progress. It has to change
     * whenever the *meaning* of a stored row changes — analysis, the indexed
     * field, or the layout — because that mismatch is the only signal that
     * triggers the rebuild.
     */
    describe("companionProfile", () => {
        it("separates two indexes that differ only in layout", () => {
            expect.assertions(2);

            const fts5 = companionProfile(byBody, sqliteDialect());
            const inverted = companionProfile(byBody, sqliteDialect({ supportsFts5: false }));

            expect(fts5).not.toBe(inverted);
            // A companion built for one layout holds different columns than the
            // other, so writing into it would raise on a missing column.
            // Spelled out rather than derived: the profile is a stored format,
            // so a change here should be a visible edit that says "every index
            // built under the old rules now rebuilds", not a silent pass.
            expect([fts5, inverted]).toStrictEqual(["none-v2:body/fts5", "none-v2:body/inverted"]);
        });

        it("separates two indexes that differ only in the field they index", () => {
            expect.assertions(1);

            // Re-pointing an index at another column leaves every stored row
            // holding the text of the column that was abandoned. Recorded as
            // analysis-and-layout only, that went undetected: searching the
            // column you just declared returned nothing while the old one kept
            // matching, under an index reporting itself complete.
            expect(companionProfile({ ...byBody, field: "title" }, sqliteDialect())).not.toBe(companionProfile(byBody, sqliteDialect()));
        });

        it("ignores filterFields, which no companion stores", () => {
            expect.assertions(1);

            // `filterFields` is read only when a staged query validates which
            // columns `.eq()` may narrow by — it never reaches a companion row.
            // Rebuilding every index on the table for it would be pure cost.
            expect(companionProfile({ ...byBody, filterFields: ["channel"] }, sqliteDialect())).toBe(companionProfile(byBody, sqliteDialect()));
        });

        it("separates two indexes that differ only in analysis", () => {
            expect.assertions(1);

            const dialect = sqliteDialect();

            expect(companionProfile({ field: "body", language: "en", name: "by_body" }, dialect)).not.toBe(companionProfile(byBody, dialect));
        });
    });

    /**
     * Which tables get a companion. A `.shardBy()` table's rows live in the Durable
     * Objects, so a `.global()` companion over one could never be populated —
     * while a schema authored before the flag existed sets no `shardMode` at all
     * and must still get its index.
     */
    describe("globalSearchIndexes", () => {
        const schemaOf = (tables: Record<string, unknown>): SchemaLike => ({ tables }) as never;

        it("yields one entry per index on a global table", () => {
            expect.assertions(1);

            const schema = schemaOf({
                notes: {
                    indexes: [],
                    searchIndexes: [
                        { field: "body", name: "by_body" },
                        { field: "title", name: "by_title" },
                    ],
                    shape: {},
                    shardMode: { kind: "global" },
                },
            });

            expect([...globalSearchIndexes(schema)].map(([table, , index]) => `${table}.${index.name}`)).toStrictEqual(["notes.by_body", "notes.by_title"]);
        });

        it("includes a table with no declared shard mode, which predates the flag", () => {
            expect.assertions(1);

            const schema = schemaOf({ notes: { indexes: [], searchIndexes: [{ field: "body", name: "by_body" }], shape: {} } });

            expect([...globalSearchIndexes(schema)]).toHaveLength(1);
        });

        it("skips a sharded table and a table with no search index", () => {
            expect.assertions(1);

            const schema = schemaOf({
                plain: { indexes: [], shape: {}, shardMode: { kind: "global" } },
                sharded: { indexes: [], searchIndexes: [{ field: "body", name: "by_body" }], shape: {}, shardMode: { key: "userId", kind: "shard" } },
            });

            expect([...globalSearchIndexes(schema)]).toStrictEqual([]);
        });
    });

    describe("companionFor", () => {
        it("reserves the __fts_ infix so a companion can never collide with a user table", () => {
            expect.assertions(1);

            expect(companionFor("notes", byBody)).toBe("notes__fts_by_body");
        });
    });

    /**
     * The portable `(token, id, occurrences)` layout — the one every engine can
     * serve, and the only one that has to hand-roll matching and ranking in SQL.
     */
    describe("invertedLayout", () => {
        const dialect = sqliteDialect({ supportsFts5: false });
        const companion = companionFor("notes", byBody);

        const companionRows = (): Record<string, unknown>[] =>
            harness.raw(`SELECT "__token__", "__id__", "__n__" FROM "notes__fts_by_body" ORDER BY "__token__", "__id__"`);

        it("creates the companion and its indexes idempotently", async () => {
            expect.assertions(2);

            await invertedLayout.ensureCompanion(harness.exec, dialect, companion);
            // A second pass runs on every migration; it must not raise on the
            // already-created table or its already-created indexes.
            await invertedLayout.ensureCompanion(harness.exec, dialect, companion);

            expect(harness.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, companion)).toHaveLength(1);
            expect(
                harness.raw(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`, companion).map((row) => row["name"]),
            ).toStrictEqual(["notes__fts_by_body__btree", "notes__fts_by_body__by_id"]);
        });

        it("stores one row per distinct token, counting repeats as the score", async () => {
            expect.assertions(1);

            await invertedLayout.ensureCompanion(harness.exec, dialect, companion);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "b", { body: "hello hello world" }, byBody);

            // Mapped rather than compared whole: `node:sqlite` hands back
            // null-prototype rows, which `toStrictEqual` reads as a difference.
            expect(companionRows().map((row) => `${String(row["__token__"])}:${String(row["__id__"])}:${String(row["__n__"])}`)).toStrictEqual([
                "hello:b:2",
                "world:b:1",
            ]);
        });

        it("replaces a document's rows rather than adding to them", async () => {
            expect.assertions(1);

            await invertedLayout.ensureCompanion(harness.exec, dialect, companion);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "b", { body: "before" }, byBody);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "b", { body: "after" }, byBody);

            // Not a union of both versions: a stale token would keep serving text
            // the document no longer has.
            expect(companionRows().map((row) => row["__token__"])).toStrictEqual(["after"]);
        });

        it("writes every row of a document whose tokens span several insert chunks", async () => {
            expect.assertions(1);

            // The write path batches rows per statement; a document with more
            // distinct tokens than one chunk holds must still land whole.
            const body = Array.from({ length: 260 }, (_, index) => `token${String(index)}`).join(" ");

            await invertedLayout.ensureCompanion(harness.exec, dialect, companion);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "big", { body }, byBody);

            expect(companionRows()).toHaveLength(260);
        });

        it("issues one batch call (not one per chunk) when the exec supports batch", async () => {
            expect.assertions(3);

            const batching = createBatchingHarness();

            try {
                // 260 tokens spans 6 chunks at INSERT_CHUNK_ROWS = 50; without
                // the batch seam this would be 6 sequential `run()` calls.
                const body = Array.from({ length: 260 }, (_, index) => `token${String(index)}`).join(" ");

                await invertedLayout.ensureCompanion(batching.exec, dialect, companion);

                // ensureCompanion's DDL goes through `run`; `indexDocument`
                // itself still purges the old rows via `run` (a single
                // DELETE) before the chunked insert loop, which is the one
                // expected to move to `batch`.
                const runsBeforeIndexing = batching.runCalls();

                await invertedLayout.indexDocument(batching.exec, dialect, companion, "big", { body }, byBody);

                expect(batching.batchCalls()).toBe(1);
                expect(batching.raw(`SELECT "__token__" FROM "notes__fts_by_body" ORDER BY "__token__"`)).toHaveLength(260);
                expect(batching.runCalls()).toBe(runsBeforeIndexing + 1);
            } finally {
                batching.close();
            }
        });

        it("caps how many tokens one oversized document contributes", async () => {
            expect.assertions(1);

            const body = Array.from({ length: MAX_INDEXED_TOKENS + 200 }, (_, index) => `token${String(index)}`).join(" ");

            await invertedLayout.ensureCompanion(harness.exec, dialect, companion);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "big", { body }, byBody);

            expect(companionRows()).toHaveLength(MAX_INDEXED_TOKENS);
        });

        it("applies the index's declared language when it stores tokens", async () => {
            expect.assertions(1);

            const english: SearchIndexDefinitionLike = { field: "body", language: "en", name: "by_body" };

            await invertedLayout.ensureCompanion(harness.exec, dialect, companion);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "a", { body: "the quick fox" }, english);

            expect(companionRows().map((row) => row["__token__"])).toStrictEqual(["fox", "quick"]);
        });

        it("matches every query term, ranked by summed occurrences", async () => {
            expect.assertions(2);

            seedDocuments(CORPUS);
            await indexAll(invertedLayout, dialect, CORPUS);

            const all = await invertedLayout.runSearch(harness.exec, dialect, notes, "notes", stageFor("hello world"), 10);

            // b carries "hello" twice, so it outranks a; c has no "hello" at all.
            expect(all.map((document) => document["_id"])).toStrictEqual(["b", "a"]);

            const none = await invertedLayout.runSearch(harness.exec, dialect, notes, "notes", stageFor("hello javascript"), 10);

            expect(none).toStrictEqual([]);
        });

        it("keeps a document whose single token satisfies both an exact and the final prefix term", async () => {
            expect.assertions(1);

            seedDocuments(CORPUS);
            await indexAll(invertedLayout, dialect, CORPUS);

            // One companion row has to count for both terms. Slotting each row into
            // the first term it matches would drop this document.
            const rows = await invertedLayout.runSearch(harness.exec, dialect, notes, "notes", stageFor("javascript java"), 10);

            expect(rows.map((document) => document["_id"])).toStrictEqual(["d"]);
        });

        it("narrows by an .eq() filter and bounds the read by the limit", async () => {
            expect.assertions(2);

            seedDocuments(CORPUS);
            await indexAll(invertedLayout, dialect, CORPUS);

            const filtered = await invertedLayout.runSearch(
                harness.exec,
                dialect,
                notes,
                "notes",
                stageFor("world", [{ field: "channel", value: "other" }]),
                10,
            );

            expect(filtered.map((document) => document["_id"])).toStrictEqual(["c"]);

            // Every document scores 1 for a single "world", so the limit hands the
            // tiebreak the decision: newest creation time first, then id.
            const bounded = await invertedLayout.runSearch(harness.exec, dialect, notes, "notes", stageFor("world"), 1);

            expect(bounded.map((document) => document["_id"])).toStrictEqual(["c"]);
        });

        it("hides soft-deleted rows", async () => {
            expect.assertions(1);

            harness.raw(`CREATE TABLE "notes" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "body" TEXT, "channel" TEXT, "deletedAt" REAL)`);
            harness.raw(`INSERT INTO "notes" VALUES ('a', 1, 'hello world', 'general', NULL)`);
            harness.raw(`INSERT INTO "notes" VALUES ('b', 2, 'hello world', 'general', 99)`);

            await invertedLayout.ensureCompanion(harness.exec, dialect, companion);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "a", { body: "hello world" }, byBody);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "b", { body: "hello world" }, byBody);

            const softDeleting = { ...notes, softDeleteMode: { field: "deletedAt" } } as unknown as TableDefinitionLike;
            const rows = await invertedLayout.runSearch(harness.exec, dialect, softDeleting, "notes", stageFor("hello"), 10);

            // The companion still holds b's tokens — the row is deleted, not the
            // index entry — so the filter has to happen on the joined table.
            expect(rows.map((document) => document["_id"])).toStrictEqual(["a"]);
        });

        it("returns nothing for a query with no terms rather than matching everything", async () => {
            expect.assertions(1);

            seedDocuments(CORPUS);
            await indexAll(invertedLayout, dialect, CORPUS);

            await expect(invertedLayout.runSearch(harness.exec, dialect, notes, "notes", stageFor("   "), 10)).resolves.toStrictEqual([]);
        });
    });

    /** The FTS5 shadow: one row of *analyzed* text per document, matched with MATCH. */
    describe.skipIf(!FTS5_IN_BUILD)("fts5Layout", () => {
        const dialect = sqliteDialect();
        const companion = companionFor("notes", byBody);

        it("creates the virtual table idempotently", async () => {
            expect.assertions(1);

            await fts5Layout.ensureCompanion(harness.exec, dialect, companion);
            await fts5Layout.ensureCompanion(harness.exec, dialect, companion);

            expect(harness.raw(`SELECT name FROM sqlite_master WHERE name = ?`, companion)).not.toStrictEqual([]);
        });

        it("stores the analyzed token stream, not the raw field", async () => {
            expect.assertions(1);

            await fts5Layout.ensureCompanion(harness.exec, dialect, companion);
            await fts5Layout.indexDocument(
                harness.exec,
                dialect,
                companion,
                "a",
                { body: "The Café, Reopened!" },
                { field: "body", language: "en", name: "by_body" },
            );

            // Feeding FTS5 raw text would leave its own tokenizer to decide about
            // case, punctuation and accents — and it decides differently than we do.
            expect(harness.raw(`SELECT "__text__" FROM "notes__fts_by_body"`).map((row) => row["__text__"])).toStrictEqual(["cafe reopened"]);
        });

        it("replaces a document's row rather than adding a second one", async () => {
            expect.assertions(1);

            await fts5Layout.ensureCompanion(harness.exec, dialect, companion);
            await fts5Layout.indexDocument(harness.exec, dialect, companion, "a", { body: "before" }, byBody);
            await fts5Layout.indexDocument(harness.exec, dialect, companion, "a", { body: "after" }, byBody);

            // A duplicate here surfaces as the same document twice in a result set:
            // the MATCH query has no GROUP BY to collapse it.
            expect(harness.raw(`SELECT "__text__" FROM "notes__fts_by_body"`).map((row) => row["__text__"])).toStrictEqual(["after"]);
        });

        it("ranks by the shared scorer, so a repeated term outranks a single one", async () => {
            expect.assertions(1);

            seedDocuments(CORPUS);
            await indexAll(fts5Layout, dialect, CORPUS);

            const rows = await fts5Layout.runSearch(harness.exec, dialect, notes, "notes", stageFor("hello"), 10);

            expect(rows.map((document) => document["_id"])).toStrictEqual(["b", "a"]);
        });
    });

    /**
     * The engine's own index. No dialect in this repo implements the contract over
     * SQLite, so the test writes one — which is the point: if a second engine can
     * be dropped in through the five statement builders alone, the seam holds.
     */
    describe("nativeLayout", () => {
        /** A "native" full-text index over plain SQLite: one analyzed-text column, matched with LIKE. */
        const nativeDialect = sqliteDialect({
            nativeTextSearch: {
                createCompanion: (companion, keyType) =>
                    sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(companion)} (${sql.identifier("__id__")} ${sql.raw(keyType)} PRIMARY KEY, ${sql.identifier("__vector__")} TEXT)`,
                createIndexes: (companion) => [
                    sql`CREATE INDEX IF NOT EXISTS ${sql.identifier(`${companion}__vec`)} ON ${sql.identifier(companion)} (${sql.identifier("__vector__")})`,
                ],
                indexDocument: (companion, id, analyzed) =>
                    sql`INSERT INTO ${sql.identifier(companion)} (${sql.identifier("__id__")}, ${sql.identifier("__vector__")}) VALUES (${id}, ${analyzed})`,
                matches: (companion, terms) =>
                    sql.join(
                        terms.map((term) => sql`${sql.identifier(companion)}.${sql.identifier("__vector__")} LIKE ${`%${term}%`}`),
                        sql` AND `,
                    ),
                rank: (companion) => sql`LENGTH(${sql.identifier(companion)}.${sql.identifier("__vector__")})`,
            },
        });

        const companion = companionFor("notes", byBody);

        it("creates, writes and reads through the dialect's statement builders alone", async () => {
            expect.assertions(2);

            seedDocuments(CORPUS);
            await indexAll(nativeLayout, nativeDialect, CORPUS);

            expect(harness.raw(`SELECT "__id__", "__vector__" FROM "notes__fts_by_body" ORDER BY "__id__"`).map((row) => row["__vector__"])).toStrictEqual([
                "hello world",
                "hello hello wonderful world",
                "goodbye world",
                "javascript",
            ]);

            const rows = await nativeLayout.runSearch(harness.exec, nativeDialect, notes, "notes", stageFor("hello world"), 10);

            expect(rows.map((document) => document["_id"]).toSorted((left, right) => String(left).localeCompare(String(right)))).toStrictEqual(["a", "b"]);
        });

        it("narrows by an .eq() filter, which the layout owns rather than the dialect", async () => {
            expect.assertions(1);

            seedDocuments(CORPUS);
            await indexAll(nativeLayout, nativeDialect, CORPUS);

            const rows = await nativeLayout.runSearch(
                harness.exec,
                nativeDialect,
                notes,
                "notes",
                stageFor("world", [{ field: "channel", value: "other" }]),
                10,
            );

            expect(rows.map((document) => document["_id"])).toStrictEqual(["c"]);
        });

        it("degrades to a no-op on a dialect with no native index instead of emitting broken SQL", async () => {
            expect.assertions(3);

            const plain = sqliteDialect();

            // The resolver never routes here without `nativeTextSearch`, but a
            // half-migrated deployment reaching it must do nothing rather than run
            // DDL for a companion shape the dialect never described.
            await expect(nativeLayout.ensureCompanion(harness.exec, plain, companion)).resolves.toBeUndefined();
            await expect(nativeLayout.indexDocument(harness.exec, plain, companion, "a", { body: "hello" }, byBody)).resolves.toBeUndefined();
            await expect(nativeLayout.runSearch(harness.exec, plain, notes, "notes", stageFor("hello"), 10)).resolves.toStrictEqual([]);
        });
    });

    describe("purgeDocument", () => {
        it("drops one document's rows and leaves the rest", async () => {
            expect.assertions(1);

            const dialect = sqliteDialect({ supportsFts5: false });
            const companion = companionFor("notes", byBody);

            await invertedLayout.ensureCompanion(harness.exec, dialect, companion);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "a", { body: "keep me" }, byBody);
            await invertedLayout.indexDocument(harness.exec, dialect, companion, "b", { body: "drop me" }, byBody);

            await purgeDocument(harness.exec, dialect, companion, "b");

            expect(harness.raw(`SELECT DISTINCT "__id__" FROM "notes__fts_by_body"`).map((row) => row["__id__"])).toStrictEqual(["a"]);
        });
    });

    /**
     * The companion's btree is where the engines stop agreeing: MySQL needs a key
     * prefix to stay under InnoDB's 3072-byte index limit, and Postgres needs an
     * explicit operator class or the prefix `LIKE` that resolves a query's final
     * term cannot use the index at all. Both are invisible until the wrong engine
     * runs the DDL, so they are asserted on the emitted SQL.
     */
    describe("companion index DDL per engine", () => {
        const ddlFor = async (overrides: Partial<SqlDialect>): Promise<string[]> => {
            const recorder = recordingExec();

            await invertedLayout.ensureCompanion(recorder.exec, sqliteDialect({ supportsFts5: false, ...overrides }), "notes__fts_by_body");

            return recorder.statements.filter((statement) => statement.includes("CREATE INDEX"));
        };

        it("gives MySQL a key prefix on both indexed columns", async () => {
            expect.assertions(2);

            // Backticks, not double quotes: the dialect name also selects drizzle's
            // identifier quoting, so this asserts the MySQL renderer end to end.
            const [btree, byId] = await ddlFor({ name: "mysql" });

            expect(btree).toContain("`__token__`(191), `__id__`(191)");
            expect(byId).toContain("`__id__`(191)");
        });

        it("gives Postgres the pattern operator class its prefix scan needs", async () => {
            expect.assertions(1);

            const [btree] = await ddlFor({ name: "postgres", textPatternOperatorClass: "text_pattern_ops" });

            expect(btree).toContain(`"__token__" text_pattern_ops, "__id__" text_pattern_ops`);
        });

        it("leaves SQLite's columns bare, since neither adjustment applies", async () => {
            expect.assertions(1);

            const [btree] = await ddlFor({});

            expect(btree).toContain(`("__token__", "__id__")`);
        });

        it("tolerates MySQL re-creating an index it already has, but not a real failure", async () => {
            expect.assertions(2);

            const mysql = sqliteDialect({ name: "mysql", supportsFts5: false });
            // Real driver errors are Errors carrying `errno`, so the double is one
            // too — a bare object would let the guard pass for the wrong reason.
            /* eslint-disable promise/no-promise-in-callback -- the exec members *are* the async boundary here; the double stands in for a driver rejecting one statement */
            const failing = (error: Error): SqlCtxExec => {
                return {
                    all: () => Promise.resolve([]),
                    run: async (query) => {
                        if (query.includes("CREATE INDEX")) {
                            throw error;
                        }
                    },
                };
            };
            /* eslint-enable promise/no-promise-in-callback */

            // MySQL has no `CREATE INDEX IF NOT EXISTS`, so the duplicate-name error
            // is how a re-run reports success — but only that one.
            await expect(
                invertedLayout.ensureCompanion(failing(Object.assign(new Error("Duplicate key name"), { errno: 1061 })), mysql, "notes__fts_by_body"),
            ).resolves.toBeUndefined();
            await expect(invertedLayout.ensureCompanion(failing(new Error("disk full")), mysql, "notes__fts_by_body")).rejects.toThrow(/disk full/u);
        });
    });
});
