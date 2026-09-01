import { MAX_INDEXED_TOKENS } from "@lunora/search-core";
import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import type { SqlDialect } from "@lunora/sql-store";
import { backfillSqlSearchIndexes, createSqlCtxDb, runSqlSearchMigrations } from "@lunora/sql-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { D1Exec } from "../src/d1-ctx-db";
import sqliteDialect from "../src/sqlite-dialect";
import { createD1Exec } from "./_helpers/node-sqlite-d1";

/**
 * The backfill's own behaviour, against a real SQLite engine without fts5 — so
 * the portable inverted companion is the one being filled.
 *
 * These cover what the "does the companion have rows?" heuristic used to get
 * wrong: a companion that writes have already populated still needs indexing, a
 * run that stops mid-table must resume rather than declare victory, and running
 * it twice must not double the stored occurrence counts (which would silently
 * skew every relevance score).
 */

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const tableOf = (searchIndexes: SchemaLike["tables"][string]["searchIndexes"]): SchemaLike => {
    return {
        tables: {
            docs: {
                indexes: [],
                searchIndexes,
                shape: { body: col("string"), channel: col("string") },
                shardMode: { kind: "global" },
            },
        },
    };
};

const plainSchema = tableOf([]);
const searchSchema = tableOf([{ field: "body", filterFields: ["channel"], name: "by_body" }]);
const stagedSchema = tableOf([{ field: "body", filterFields: ["channel"], name: "by_body", staged: true }]);
const englishSchema = tableOf([{ field: "body", filterFields: ["channel"], language: "en", name: "by_body" }]);

/**
 * The SQLite dialect with fts5 declared unavailable — the portable
 * `(token, id, occurrences)` layout Postgres and MySQL use. A dialect override
 * rather than a stubbed connection: the engine's capability is what actually
 * decides the layout, so saying so directly beats intercepting SQL.
 */
const invertedDialect: SqlDialect = { ...sqliteDialect, supportsFts5: false };

let harness: ReturnType<typeof createD1Exec>;
let exec: D1Exec;

const createDocsTable = (): void => {
    harness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT)`);
};

const writerFor = (schema: SchemaLike): DatabaseWriterLike => createSqlCtxDb({ clock: () => 1_700_000_000_000, dialect: invertedDialect, exec, schema });

const companionRows = async (): Promise<Record<string, unknown>[]> =>
    harness.exec.all(`SELECT "__token__", "__id__", "__n__" FROM "docs__fts_by_body" ORDER BY "__token__", "__id__"`, []);

describe("d1 ctx-db search backfill", () => {
    beforeEach(() => {
        harness = createD1Exec();
        exec = harness.exec;
        createDocsTable();
    });

    afterEach(() => {
        harness.close();
    });

    it("indexes rows that predate the index even though writes already populated the companion", async () => {
        expect.assertions(2);

        // Rows written before the index exists…
        const plain = writerFor(plainSchema);

        await plain.insert("docs", { _id: "old", body: "ancient history", channel: "x" }, { allowExplicitId: true });

        // …then the index is declared as staged (so migration indexes nothing)
        // and a later write populates the companion for that row alone.
        const staged = writerFor(stagedSchema);

        await staged.insert("docs", { _id: "new", body: "ancient news", channel: "x" }, { allowExplicitId: true });

        // A NEW index covers a growing PREFIX of the table, so a search over it
        // would return a confidently wrong subset — one row of two here. The
        // read refuses instead. (A REBUILDING index is the other case: it holds
        // every row under stale analysis, so it keeps serving.)
        const searchBeforeBackfill = staged
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "ancient"))
            .collect();

        await expect(searchBeforeBackfill).rejects.toThrow(/still backfilling/u);

        await backfillSqlSearchIndexes(exec, stagedSchema, invertedDialect);

        const after = await writerFor(stagedSchema)
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "ancient"))
            .collect();

        expect(after.map((document) => String(document["_id"])).toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["new", "old"]);
    });

    it("resumes across pages until the whole table is indexed", async () => {
        expect.assertions(2);

        // More rows than one backfill page covers, so completion requires the
        // recorded cursor to carry across passes.
        const plain = writerFor(plainSchema);
        const total = 250;

        for (let index = 0; index < total; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- ids must be deterministic and ordered for the keyset walk under test
            await plain.insert(
                "docs",
                { _id: `d${String(index).padStart(4, "0")}`, body: `needle${String(index)} common`, channel: "x" },
                { allowExplicitId: true },
            );
        }

        // One migration pass indexes a bounded page, not the whole table.
        await runSqlSearchMigrations(exec, searchSchema, invertedDialect);

        const afterOnePass = await harness.exec.all(`SELECT COUNT(DISTINCT "__id__") AS c FROM "docs__fts_by_body"`, []);

        // The explicit runner loops to completion.
        await backfillSqlSearchIndexes(exec, searchSchema, invertedDialect);

        const afterRunner = await harness.exec.all(`SELECT COUNT(DISTINCT "__id__") AS c FROM "docs__fts_by_body"`, []);

        expect(Number(afterOnePass[0]?.["c"])).toBeLessThan(total);
        expect(Number(afterRunner[0]?.["c"])).toBe(total);
    });

    it("is idempotent — a second run does not double the occurrence counts", async () => {
        expect.assertions(1);

        const plain = writerFor(plainSchema);

        await plain.insert("docs", { _id: "d1", body: "repeat repeat unique", channel: "x" }, { allowExplicitId: true });

        await backfillSqlSearchIndexes(exec, searchSchema, invertedDialect);

        const first = await companionRows();

        // Re-running must converge, not accumulate: doubled counts would skew
        // every relevance score, and duplicate rows would return the same
        // document twice on the fts5 path.
        await backfillSqlSearchIndexes(exec, searchSchema, invertedDialect);

        await expect(companionRows()).resolves.toStrictEqual(first);
    });

    it("caps the tokens one oversized document contributes", async () => {
        expect.assertions(1);

        const plain = writerFor(plainSchema);
        const body = Array.from({ length: MAX_INDEXED_TOKENS + 200 }, (_, index) => `token${String(index)}`).join(" ");

        await plain.insert("docs", { _id: "big", body, channel: "x" }, { allowExplicitId: true });

        await backfillSqlSearchIndexes(exec, searchSchema, invertedDialect);

        const rows = await harness.exec.all(`SELECT COUNT(*) AS c FROM "docs__fts_by_body" WHERE "__id__" = ?`, ["big"]);

        // Bounded, so one huge text column can't fan a single row write out into
        // hundreds of sequential statements.
        expect(Number(rows[0]?.["c"])).toBe(MAX_INDEXED_TOKENS);
    });

    it("rebuilds a companion whose recorded profile predates profile tracking", async () => {
        expect.assertions(2);

        const plain = writerFor(plainSchema);

        await plain.insert("docs", { _id: "d1", body: "quick fox", channel: "x" }, { allowExplicitId: true });
        await backfillSqlSearchIndexes(exec, searchSchema, invertedDialect);

        // A companion built before the profile column existed: the state row
        // says "finished", but a NULL profile means nothing records what
        // analyzed those tokens. The bogus row stands in for that unknown
        // analysis — treating the row as resumable would leave it there forever.
        await harness.exec.run(`INSERT INTO "docs__fts_by_body" ("__token__", "__id__", "__n__") VALUES (?, ?, ?)`, ["stale", "d1", 1]);
        await harness.exec.run(`UPDATE "__lunora_search_state" SET "profile" = NULL, "done" = 1`, []);

        await backfillSqlSearchIndexes(exec, searchSchema, invertedDialect);

        const tokens = await harness.exec.all(`SELECT "__token__" FROM "docs__fts_by_body" ORDER BY "__token__"`, []);

        expect(tokens.map((row) => row["__token__"])).toStrictEqual(["fox", "quick"]);

        // And the same for a *partial* legacy companion: a recorded cursor with
        // no profile must restart the walk rather than resume past rows whose
        // analysis is unknown, or the index stays half-analyzed forever.
        await harness.exec.run(`UPDATE "__lunora_search_state" SET "profile" = NULL, "done" = 0, "cursor" = ?`, ["d9"]);
        await harness.exec.run(`DELETE FROM "docs__fts_by_body"`, []);
        await backfillSqlSearchIndexes(exec, searchSchema, invertedDialect);

        const resumed = await harness.exec.all(`SELECT "__token__" FROM "docs__fts_by_body" ORDER BY "__token__"`, []);

        expect(resumed.map((row) => row["__token__"])).toStrictEqual(["fox", "quick"]);
    });

    it("rebuilds the companion when the analysis profile changes", async () => {
        expect.assertions(3);

        const plain = writerFor(plainSchema);

        await plain.insert("docs", { _id: "d1", body: "the quick fox", channel: "x" }, { allowExplicitId: true });
        await backfillSqlSearchIndexes(exec, searchSchema, invertedDialect);

        const folded = await harness.exec.all(`SELECT "__token__" FROM "docs__fts_by_body" ORDER BY "__token__"`, []);

        // Declaring a language changes what a token *is*, so rows indexed under
        // the old profile would half-match forever. The recorded profile catches
        // it and the companion is rebuilt.
        await backfillSqlSearchIndexes(exec, englishSchema, invertedDialect);

        const analyzed = await harness.exec.all(`SELECT "__token__" FROM "docs__fts_by_body" ORDER BY "__token__"`, []);

        expect(folded.map((row) => row["__token__"])).toStrictEqual(["fox", "quick", "the"]);
        expect(analyzed.map((row) => row["__token__"])).toStrictEqual(["fox", "quick"]);

        // And the stale "the" is gone rather than orphaned in the companion.
        const stale = await writerFor(englishSchema)
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "quick"))
            .collect();

        expect(stale.map((document) => document["_id"])).toStrictEqual(["d1"]);
    });

    it("drops stopwords from an English index but keeps them without a language", async () => {
        expect.assertions(2);

        const plain = writerFor(plainSchema);

        await plain.insert("docs", { _id: "d1", body: "the who", channel: "x" }, { allowExplicitId: true });

        await backfillSqlSearchIndexes(exec, englishSchema, invertedDialect);

        const stopwordOnly = await writerFor(englishSchema)
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "the"))
            .collect();
        const contentWord = await writerFor(englishSchema)
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "who"))
            .collect();

        // "the" analyzes to no terms at all, which is no match rather than
        // every match; "who" is not on the list and still finds the row.
        expect(stopwordOnly).toStrictEqual([]);
        expect(contentWord.map((document) => document["_id"])).toStrictEqual(["d1"]);
    });

    it("keeps a document's rows correct when it is rewritten during a staged rollout", async () => {
        expect.assertions(2);

        const writer = writerFor(searchSchema);

        await writer.insert("docs", { _id: "d1", body: "before", channel: "x" }, { allowExplicitId: true });
        await writer.patch("d1", { body: "after" });

        const stale = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "before"))
            .collect();
        const fresh = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "after"))
            .collect();

        expect(stale).toStrictEqual([]);
        expect(fresh.map((document) => document["_id"])).toStrictEqual(["d1"]);
    });
});
