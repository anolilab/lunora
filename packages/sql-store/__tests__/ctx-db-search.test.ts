import { DatabaseSync } from "node:sqlite";

import type { SchemaLike, SearchIndexDefinitionLike, TableDefinitionLike, ValidatorLike } from "@lunora/shard-engine";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqlCtxDb } from "../src/ctx-db";
import type { SearchStage } from "../src/ctx-db-search";
import { backfillSqlSearchIndexes, createSearchSync, runSqlSearch, runSqlSearchMigrations } from "../src/ctx-db-search";
import type { SqlDialect } from "../src/dialect";
import { companionFor } from "../src/search-layout";
import type { SqlCtxExec } from "../src/sql-exec";

/**
 * Provisioning, backfill and the write-path hook for `.global()` search — the
 * layout-agnostic half of the search stack.
 *
 * The pieces here are the ones whose failure is silent rather than loud: a
 * staged index that never gets backfilled, a companion whose stored rows were
 * analyzed by rules the query side no longer uses, a write that re-indexes a
 * document it didn't change. None of those raise; they just return the wrong
 * documents, or return them slowly, forever.
 *
 * Runs against a real `node:sqlite` with FTS5 declared unavailable, so the
 * portable inverted companion is the one being provisioned — the layout every
 * engine can serve, and the one whose contents are inspectable row by row.
 */

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const tableWith = (searchIndexes: SearchIndexDefinitionLike[]): SchemaLike =>
    ({
        tables: {
            notes: {
                indexes: [],
                searchIndexes,
                shape: { body: col("string"), channel: col("string") },
                shardMode: { kind: "global" },
            },
        },
    }) as never;

const BY_BODY: SearchIndexDefinitionLike = { field: "body", filterFields: ["channel"], name: "by_body" };
const COMPANION = companionFor("notes", BY_BODY);

const plainSchema = tableWith([]);
const searchSchema = tableWith([BY_BODY]);
const stagedSchema = tableWith([{ ...BY_BODY, staged: true }]);
const englishSchema = tableWith([{ ...BY_BODY, language: "en" }]);

const dialect: SqlDialect = {
    columnType: () => "TEXT",
    companionTypes: { autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT", integer: "INTEGER", key: "TEXT", real: "REAL", text: "TEXT" },
    frameworkColumns: () => [
        { name: "id", type: "TEXT PRIMARY KEY" },
        { name: "_creationTime", type: "REAL NOT NULL" },
    ],
    isUniqueViolation: (error) => error instanceof Error && /unique constraint failed/iu.test(error.message),
    name: "sqlite",
    // The portable layout, so the companion's rows can be read back directly.
    supportsFts5: false,
    supportsReturning: true,
    tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
};

let database: DatabaseSync;
let exec: SqlCtxExec;
let statements: string[];

const raw = (query: string, ...parameters: unknown[]): Record<string, unknown>[] => database.prepare(query).all(...(parameters as never[]));

const createNotesTable = (): void => {
    raw(`CREATE TABLE "notes" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "body" TEXT, "channel" TEXT)`);
};

const insertNote = (id: string, body: string, channel = "general"): void => {
    raw(`INSERT INTO "notes" ("id", "_creationTime", "body", "channel") VALUES (?, ?, ?, ?)`, id, 1_700_000_000_000, body, channel);
};

const tokensFor = (id?: string): string[] =>
    (id === undefined
        ? raw(`SELECT "__token__" FROM ${JSON.stringify(COMPANION)} ORDER BY "__token__"`)
        : raw(`SELECT "__token__" FROM ${JSON.stringify(COMPANION)} WHERE "__id__" = ? ORDER BY "__token__"`, id)
    ).map((row) => String(row["__token__"]));

/** A staged `by_body` search, as the reader hands one to `runSqlSearch`. */
const bodyStage = (query: string, definition: SearchIndexDefinitionLike = BY_BODY): SearchStage => {
    return {
        definition,
        field: "body",
        filters: [],
        hasQuery: true,
        indexName: "by_body",
        query,
    };
};

/**
 * More rows than one backfill page holds, so a pass that indexed only a prefix
 * is distinguishable from one that indexed the table. At the one-row scale the
 * rebuild tests used to run at, the whole backfill finishes inside the first
 * pass and the window this file exists to pin is invisible.
 */
const insertPastOnePage = (): void => {
    for (let index = 0; index < 250; index += 1) {
        insertNote(`d${String(index).padStart(4, "0")}`, `hello note${String(index)}`);
    }
};

/** Documents the companion currently holds a row for. */
const companionDocumentCount = (): number => Number(raw(`SELECT COUNT(DISTINCT "__id__") AS c FROM ${JSON.stringify(COMPANION)}`)[0]?.["c"]);

const notesDefinition = (searchSchema as unknown as { tables: Record<string, TableDefinitionLike> }).tables["notes"]!;

// One outer block so the shared engine setup lives inside a describe, as the
// suite convention requires.
describe("global search provisioning", () => {
    beforeEach(() => {
        database = new DatabaseSync(":memory:");
        statements = [];
        exec = {
            all: (query, parameters) => {
                statements.push(query);

                return Promise.resolve(raw(query, ...parameters));
            },
            run: (query, parameters) => {
                statements.push(query);
                raw(query, ...parameters);

                return Promise.resolve();
            },
        };
    });

    afterEach(() => {
        database.close();
    });

    describe("runSqlSearchMigrations", () => {
        it("provisions the companion and indexes the rows that predate the index", async () => {
            expect.assertions(2);

            createNotesTable();
            insertNote("a", "hello world");

            await runSqlSearchMigrations(exec, searchSchema, dialect);

            expect(raw(`SELECT name FROM sqlite_master WHERE name = ?`, COMPANION)).toHaveLength(1);
            // The whole point of the migration-time backfill: a search index added
            // to a table that already holds data works on the first request.
            expect(tokensFor()).toStrictEqual(["hello", "world"]);
        });

        it("leaves a staged index provisioned but empty, for an out-of-band run", async () => {
            expect.assertions(2);

            createNotesTable();
            insertNote("a", "hello world");

            await runSqlSearchMigrations(exec, stagedSchema, dialect);

            // The companion exists (writes need somewhere to go) but the walk over
            // a table too large to index in one request is the host's to schedule.
            expect(raw(`SELECT name FROM sqlite_master WHERE name = ?`, COMPANION)).toHaveLength(1);
            expect(tokensFor()).toStrictEqual([]);
        });

        it("records a missing source table as done rather than probing it every request", async () => {
            expect.assertions(2);

            // A host that manages its own DDL may not have created the table the
            // schema declares. Without the completion record this probe would run
            // on every migration pass, forever.
            await runSqlSearchMigrations(exec, searchSchema, dialect);

            const state = raw(`SELECT "done" FROM "__lunora_search_state" WHERE "companion" = ?`, COMPANION);

            expect(state).toHaveLength(1);
            expect(Number(state[0]?.["done"])).toBe(1);
        });

        it("is idempotent — a second pass does not double the stored occurrences", async () => {
            expect.assertions(1);

            createNotesTable();
            insertNote("a", "hello hello world");

            await runSqlSearchMigrations(exec, searchSchema, dialect);
            await runSqlSearchMigrations(exec, searchSchema, dialect);

            // Doubled counts would not fail anything — they would just quietly skew
            // every relevance score on the table.
            expect(raw(`SELECT "__n__" FROM ${JSON.stringify(COMPANION)} WHERE "__token__" = 'hello'`).map((row) => Number(row["__n__"]))).toStrictEqual([2]);
        });
    });

    describe("companion rebuilds", () => {
        it("rebuilds when the analysis profile changes", async () => {
            expect.assertions(2);

            createNotesTable();
            insertNote("a", "the quick fox");

            await runSqlSearchMigrations(exec, searchSchema, dialect);

            expect(tokensFor()).toStrictEqual(["fox", "quick", "the"]);

            // Declaring a language changes what a token *is*. Rows indexed under the
            // old profile would half-match forever, so the mismatch is detected and
            // the companion re-walked.
            await runSqlSearchMigrations(exec, englishSchema, dialect);

            expect(tokensFor()).toStrictEqual(["fox", "quick"]);
        });

        it("drops and recreates the companion when the layout changes under it", async () => {
            expect.assertions(2);

            createNotesTable();
            insertNote("a", "hello world");

            await runSqlSearchMigrations(exec, searchSchema, dialect);

            const invertedColumns = raw(`PRAGMA table_info(${JSON.stringify(COMPANION)})`).map((row) => String(row["name"]));

            expect(invertedColumns).toStrictEqual(["__token__", "__id__", "__n__"]);

            // A companion built for one layout holds different *columns* than
            // another, and `CREATE TABLE IF NOT EXISTS` would leave the old shape in
            // place — after which the statements written against it reference a
            // column that isn't there, and the throw escapes migration and takes
            // every read and write on the binding down, not just search.
            const nativeDialect: SqlDialect = {
                ...dialect,
                nativeTextSearch: {
                    createCompanion: (companion, keyType) =>
                        sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(companion)} (${sql.identifier("__id__")} ${sql.raw(keyType)} PRIMARY KEY, ${sql.identifier("__vector__")} TEXT)`,
                    createIndexes: () => [],
                    indexDocument: (companion, id, analyzed) =>
                        sql`INSERT INTO ${sql.identifier(companion)} (${sql.identifier("__id__")}, ${sql.identifier("__vector__")}) VALUES (${id}, ${analyzed})`,
                    matches: (companion) => sql`${sql.identifier(companion)}.${sql.identifier("__vector__")} <> ''`,
                    rank: (companion) => sql`LENGTH(${sql.identifier(companion)}.${sql.identifier("__vector__")})`,
                },
            };

            await runSqlSearchMigrations(exec, tableWith([{ ...BY_BODY, strategy: "native" }]), nativeDialect);

            expect(raw(`PRAGMA table_info(${JSON.stringify(COMPANION)})`).map((row) => String(row["name"]))).toStrictEqual(["__id__", "__vector__"]);
        });

        it("rebuilds when the indexed field changes", async () => {
            expect.assertions(2);

            createNotesTable();
            insertNote("a", "aaa", "zzz");

            await runSqlSearchMigrations(exec, searchSchema, dialect);

            expect(tokensFor()).toStrictEqual(["aaa"]);

            // Re-pointing an index at another column changes what the companion
            // holds just as surely as changing the analyzer does. Recorded as
            // analysis-only, the mismatch goes undetected: searching the column
            // you just declared returns nothing while the abandoned one keeps
            // matching, under an index that reports itself complete.
            await runSqlSearchMigrations(exec, tableWith([{ ...BY_BODY, field: "channel" }]), dialect);

            expect(tokensFor()).toStrictEqual(["zzz"]);
        });

        it("keeps every row served while an analysis change rebuilds the companion", async () => {
            expect.assertions(2);

            createNotesTable();
            insertPastOnePage();

            await backfillSqlSearchIndexes(exec, searchSchema, dialect);

            // A rebuild re-walks the table under the new analysis, and must
            // rewrite each row in place rather than empty the companion first:
            // emptying takes a COMPLETE index down to nothing and refills it one
            // page per request, so a large table serves a fraction of its rows
            // for thousands of requests — with no error either way.
            await runSqlSearchMigrations(exec, englishSchema, dialect);

            expect(companionDocumentCount()).toBe(250);

            const rows = await runSqlSearch(exec, dialect, notesDefinition, "notes", bodyStage("hello", { ...BY_BODY, language: "en" }), 300);

            expect(rows).toHaveLength(250);
        });

        it("leaves a staged index populated when its analysis changes", async () => {
            expect.assertions(1);

            createNotesTable();
            insertPastOnePage();

            await backfillSqlSearchIndexes(exec, stagedSchema, dialect);

            // The migration pass skips a staged index's backfill entirely, so a
            // companion emptied here has nothing to refill it: every request
            // afterwards searches an empty table and returns zero hits, forever,
            // until a host happens to re-run the out-of-band backfill.
            const stagedEnglish = { ...BY_BODY, language: "en", staged: true };

            await runSqlSearchMigrations(exec, tableWith([stagedEnglish]), dialect);
            await runSqlSearchMigrations(exec, tableWith([stagedEnglish]), dialect);
            await runSqlSearchMigrations(exec, tableWith([stagedEnglish]), dialect);

            const rows = await runSqlSearch(exec, dialect, notesDefinition, "notes", bodyStage("hello", stagedEnglish), 300);

            expect(rows).toHaveLength(250);
        });
    });

    describe("coverage gate", () => {
        it("refuses a read against an index that covers only part of the table", async () => {
            expect.assertions(2);

            createNotesTable();
            insertPastOnePage();

            // One migration pass indexes one page, and `ensureMigrated` is
            // memoised per ctx-db — so the table sits at 200 of 250 rows for the
            // rest of the request. Every layout queries the companion regardless,
            // so a matching document past the cursor is simply absent from a
            // result set that looks complete.
            await runSqlSearchMigrations(exec, searchSchema, dialect);

            expect(companionDocumentCount()).toBe(200);

            await expect(runSqlSearch(exec, dialect, notesDefinition, "notes", bodyStage("hello"), 300)).rejects.toThrow(/still backfilling/u);
        });

        it("serves a staged index declared over an empty table", async () => {
            expect.assertions(2);

            createNotesTable();

            // `staged` defers the backfill of rows that PREDATE the index, and an
            // empty table has none. With no progress row written the plan said
            // "not finished" and the coverage flag said "not covered", so every
            // search refused — permanently, because the migration pass never
            // backfills a staged index. Declaring one alongside a new table took
            // search on that table offline for good.
            await runSqlSearchMigrations(exec, stagedSchema, dialect);

            const sync = createSearchSync({ dialect, exec, schema: stagedSchema });

            insertNote("n1", "hello world");
            await sync("notes", "n1", { body: "hello world" });

            const rows = await runSqlSearch(exec, dialect, notesDefinition, "notes", bodyStage("hello", { ...BY_BODY, staged: true }), 300);

            expect(rows).toHaveLength(1);
            expect(rows[0]?.["body"]).toBe("hello world");
        });

        it("still refuses a staged index over a table that already held rows", async () => {
            expect.assertions(1);

            createNotesTable();
            insertNote("old", "hello ancient");

            // The other half: the deferral is real when there IS a backfill to
            // defer, so the gate must still hold until the host runs it.
            await runSqlSearchMigrations(exec, stagedSchema, dialect);

            await expect(runSqlSearch(exec, dialect, notesDefinition, "notes", bodyStage("hello", { ...BY_BODY, staged: true }), 300)).rejects.toThrow(
                /still backfilling/u,
            );
        });

        it("refuses again while a re-POINTED index rebuilds, instead of answering from the old column", async () => {
            expect.assertions(2);

            createNotesTable();

            for (let index = 0; index < 250; index += 1) {
                insertNote(`d${String(index).padStart(4, "0")}`, `hello note${String(index)}`, `channel${String(index)}`);
            }

            await backfillSqlSearchIndexes(exec, searchSchema, dialect);

            // Re-point the index at `channel`. Same companion, same columns, but
            // every stored row now holds the text of the column the index was just
            // pointed AWAY from — so until the re-walk finishes, matching on `hello`
            // returns rows the new declaration says nothing about. `covered` latched
            // on the completed `body` walk and kept the reader serving them.
            const byChannel: SearchIndexDefinitionLike = { ...BY_BODY, field: "channel" };

            await runSqlSearchMigrations(exec, tableWith([byChannel]), dialect);

            expect(companionDocumentCount()).toBe(250);

            await expect(runSqlSearch(exec, dialect, notesDefinition, "notes", { ...bodyStage("hello", byChannel), field: "channel" }, 300)).rejects.toThrow(
                /still backfilling/u,
            );
        });

        it("keeps serving while only the ANALYSIS rebuilds — the rows still answer about the right column", async () => {
            expect.assertions(1);

            createNotesTable();
            insertPastOnePage();

            await backfillSqlSearchIndexes(exec, searchSchema, dialect);
            await runSqlSearchMigrations(exec, englishSchema, dialect);

            const rows = await runSqlSearch(exec, dialect, notesDefinition, "notes", bodyStage("hello", { ...BY_BODY, language: "en" }), 300);

            expect(rows).toHaveLength(250);
        });

        it("serves a fully indexed table without refusing", async () => {
            expect.assertions(1);

            createNotesTable();
            insertPastOnePage();

            await backfillSqlSearchIndexes(exec, searchSchema, dialect);

            const rows = await runSqlSearch(exec, dialect, notesDefinition, "notes", bodyStage("hello"), 300);

            expect(rows).toHaveLength(250);
        });
    });

    describe("backfillSqlSearchIndexes", () => {
        it("runs a staged index through to completion, including rows writes already covered", async () => {
            expect.assertions(1);

            createNotesTable();
            insertNote("old", "ancient history");

            await runSqlSearchMigrations(exec, stagedSchema, dialect);

            // A live write populates the companion for one row. "Has rows" would
            // read that as "already backfilled" and strand every row that predates
            // the index — the exact case staging exists for.
            const sync = createSearchSync({ dialect, exec, schema: stagedSchema });

            await sync("notes", "new", { body: "ancient news" });
            await backfillSqlSearchIndexes(exec, stagedSchema, dialect);

            expect(tokensFor("old")).toStrictEqual(["ancient", "history"]);
        });

        it("provisions what it needs, so a host can call it before anything has migrated", async () => {
            expect.assertions(1);

            createNotesTable();
            insertNote("a", "hello world");

            // "The documented remedy throws unless you happened to migrate first"
            // is not a remedy.
            await expect(backfillSqlSearchIndexes(exec, stagedSchema, dialect)).resolves.toBeUndefined();
        });

        it("walks a table larger than one backfill page", async () => {
            expect.assertions(1);

            createNotesTable();

            // Past the per-pass row budget, so finishing requires the recorded
            // cursor to carry across passes rather than restarting or stopping.
            for (let index = 0; index < 250; index += 1) {
                insertNote(`d${String(index).padStart(4, "0")}`, `needle${String(index)}`);
            }

            await backfillSqlSearchIndexes(exec, searchSchema, dialect);

            expect(raw(`SELECT COUNT(DISTINCT "__id__") AS c FROM ${JSON.stringify(COMPANION)}`).map((row) => Number(row["c"]))).toStrictEqual([250]);
        });
    });

    describe("createSearchSync", () => {
        it("indexes a written document and purges a removed one", async () => {
            expect.assertions(2);

            createNotesTable();
            await runSqlSearchMigrations(exec, searchSchema, dialect);

            const sync = createSearchSync({ dialect, exec, schema: searchSchema });

            await sync("notes", "a", { body: "hello world" });

            expect(tokensFor("a")).toStrictEqual(["hello", "world"]);

            // `document === undefined` is a row removal: delete only, no re-insert.
            await sync("notes", "a", undefined);

            expect(tokensFor("a")).toStrictEqual([]);
        });

        it("skips the companion entirely when the write left the indexed text alone", async () => {
            expect.assertions(2);

            createNotesTable();
            await runSqlSearchMigrations(exec, searchSchema, dialect);

            const sync = createSearchSync({ dialect, exec, schema: searchSchema });

            await sync("notes", "a", { body: "hello world", channel: "general" });

            statements = [];

            // Most writes touch a column the index doesn't cover — a status flip, a
            // counter, an `$onUpdateFn` timestamp. Re-tokenizing for those is a
            // DELETE plus an INSERT per chunk, every time, over a remote connection.
            await sync("notes", "a", { body: "hello world", channel: "other" }, { body: "hello world", channel: "general" });

            expect(statements).toStrictEqual([]);

            // A real edit still re-indexes.
            await sync("notes", "a", { body: "goodbye world" }, { body: "hello world" });

            expect(tokensFor("a")).toStrictEqual(["goodbye", "world"]);
        });

        it("does nothing for a table that declares no search index", async () => {
            expect.assertions(1);

            createNotesTable();

            const sync = createSearchSync({ dialect, exec, schema: plainSchema });

            await sync("notes", "a", { body: "hello world" });

            expect(statements).toStrictEqual([]);
        });
    });

    describe("runSqlSearch", () => {
        it("routes to whichever layout the index resolved to", async () => {
            expect.assertions(1);

            createNotesTable();
            insertNote("a", "hello world");
            insertNote("b", "goodbye world", "other");

            await runSqlSearchMigrations(exec, searchSchema, dialect);

            const rows = await runSqlSearch(
                exec,
                dialect,
                notesDefinition,
                "notes",
                { definition: BY_BODY, field: "body", filters: [{ field: "channel", value: "other" }], hasQuery: true, indexName: "by_body", query: "world" },
                10,
            );

            expect(rows.map((document) => document["_id"])).toStrictEqual(["b"]);
        });

        it("matches every term of a multi-token query, the last one as a prefix", async () => {
            expect.assertions(2);

            // The one shape the inverted layout's `WHERE` mixes predicate forms
            // in: the leading terms compile to equalities and the final one to a
            // half-open range, all OR'd together, with a `HAVING` that requires
            // each to have matched. A document holding only some of the terms
            // must not come back.
            createNotesTable();
            insertNote("a", "hello wonderful world");
            insertNote("b", "hello there");
            insertNote("c", "wandering alone");

            await runSqlSearchMigrations(exec, searchSchema, dialect);

            const both = await runSqlSearch(
                exec,
                dialect,
                notesDefinition,
                "notes",
                { definition: BY_BODY, field: "body", filters: [], hasQuery: true, indexName: "by_body", query: "hello wo" },
                10,
            );

            expect(both.map((document) => document["_id"])).toStrictEqual(["a"]);

            // And the prefix term alone still matches the document holding both
            // of its tokens ("wonderful", "world"), so the range half is doing
            // work rather than silently matching nothing. "wandering" is outside
            // the `wo` range, so document "c" must not come back.
            const prefixOnly = await runSqlSearch(
                exec,
                dialect,
                notesDefinition,
                "notes",
                { definition: BY_BODY, field: "body", filters: [], hasQuery: true, indexName: "by_body", query: "wo" },
                10,
            );

            expect(prefixOnly.map((document) => document["_id"])).toStrictEqual(["a"]);
        });

        it("prefix-matches a final token ending in an astral (surrogate-pair) character (plan 272)", async () => {
            expect.assertions(1);

            // U+10437 (𐐷, DESERET SMALL LETTER YEE) is a surrogate pair in
            // UTF-16 — the exact shape `searchTermRange` must derive a
            // code-point-correct upper bound for, not a code-unit one.
            const astral = String.fromCodePoint(0x1_04_37);

            createNotesTable();
            insertNote("a", `${astral}ord some other text`);
            insertNote("b", "unrelated document");

            await runSqlSearchMigrations(exec, searchSchema, dialect);

            const rows = await runSqlSearch(
                exec,
                dialect,
                notesDefinition,
                "notes",
                { definition: BY_BODY, field: "body", filters: [], hasQuery: true, indexName: "by_body", query: astral },
                10,
            );

            expect(rows.map((document) => document["_id"])).toStrictEqual(["a"]);
        });
    });

    // Plan 269: RLS installs a `.filter()` predicate at `query()` time, BEFORE
    // the caller can chain `.withSearchIndex(...)` — so the predicate must be
    // chainable on the bare (stage-less) reader and still apply once a search
    // stage is chosen. These exercise the full `createSqlCtxDb` reader (not the
    // lower-level `runSqlSearch` helper above) since the bug lives in the
    // reader's `filter` member, not in the search execution itself.
    describe("query() reader — filter() before withSearchIndex() (plan 269)", () => {
        const makeWriter = () => createSqlCtxDb({ clock: () => 1, dialect, exec, schema: searchSchema });

        it("carries a pre-stage filter into a staged search (the RLS repro)", async () => {
            expect.assertions(1);

            createNotesTable();

            const writer = makeWriter();

            await writer.insert("notes", { body: "hello world", channel: "general" });
            await writer.insert("notes", { body: "hello world", channel: "other" });

            const rows = await writer
                .query("notes")
                .filter((document) => document["channel"] === "general")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .collect();

            expect(rows.map((row) => row["channel"])).toStrictEqual(["general"]);
        });

        it("honours the pre-stage predicate on every terminal", async () => {
            expect.assertions(3);

            createNotesTable();

            const writer = makeWriter();

            await writer.insert("notes", { body: "hello world", channel: "general" });
            await writer.insert("notes", { body: "hello world", channel: "other" });

            const chain = () =>
                writer
                    .query("notes")
                    .filter((document) => document["channel"] === "general")
                    .withSearchIndex("by_body", (q) => q.search("body", "hello"));

            const taken = await chain().take(10);

            expect(taken.map((row) => row["channel"])).toStrictEqual(["general"]);

            const first = await chain().first();

            expect(first?.["channel"]).toBe("general");

            const paged = await chain().paginate({ numItems: 10 });

            expect(paged.page.map((row) => row["channel"])).toStrictEqual(["general"]);
        });

        it("applies filters staged both before and after withSearchIndex()", async () => {
            expect.assertions(1);

            createNotesTable();

            const writer = makeWriter();

            await writer.insert("notes", { body: "hello world", channel: "general" });
            await writer.insert("notes", { body: "hello world", channel: "other" });
            await writer.insert("notes", { body: "hello moon", channel: "general" });

            const rows = await writer
                .query("notes")
                .filter((document) => document["channel"] === "general")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .filter((document) => (document["body"] as string).includes("world"))
                .collect();

            expect(rows.map((row) => row["body"])).toStrictEqual(["hello world"]);
        });

        it("still throws LEGACY_READER_ERROR on a stage-less chain (no regression)", async () => {
            expect.assertions(3);

            createNotesTable();

            const writer = makeWriter();

            await writer.insert("notes", { body: "hello world", channel: "general" });

            // A `.filter()` with no `.withSearchIndex()` staged is still not a
            // real reader — only the throw moves from `.filter()` (eagerly) to
            // the terminal.
            await expect(
                writer
                    .query("notes")
                    .filter(() => true)
                    .collect(),
            ).rejects.toThrow(/legacy query\(\)\/withIndex\(\) reader is not available/u);

            // `.withIndex()` keeps throwing immediately — untouched by this fix.
            expect(() => writer.query("notes").withIndex("by_body")).toThrow(/legacy query\(\)\/withIndex\(\) reader is not available/u);

            // The async iterator on a stage-less chain rejects too — advance it
            // once directly rather than looping, since the throw happens before
            // any value would ever be yielded.
            await expect(
                writer
                    .query("notes")
                    .filter(() => true)
                    [Symbol.asyncIterator]() // eslint-disable-line no-unexpected-multiline -- continues the chain above, not a new statement; Prettier owns this line-wrap
                    .next(),
            ).rejects.toThrow(/legacy query\(\)\/withIndex\(\) reader is not available/u);
        });
    });
});
