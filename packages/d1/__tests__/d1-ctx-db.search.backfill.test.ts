import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { D1Exec } from "../src/d1-ctx-db";
import { backfillD1SearchIndexes, createD1CtxDb as createD1ContextDatabase, runD1SearchMigrations } from "../src/d1-ctx-db";
import createD1Exec from "./_helpers/node-sqlite-d1";

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
 * Force the portable inverted companion by failing the fts5 probe, whether or
 * not this Node build happens to ship fts5 — these assertions are about the
 * `(token, id, occurrences)` layout Postgres and MySQL use.
 */
const withoutFts5 = (inner: D1Exec): D1Exec => {
    return {
        all: (sql, parameters) => inner.all(sql, parameters),
        run: (sql, parameters) => {
            if (sql.includes("__lunora_fts_probe") && sql.includes("CREATE")) {
                return Promise.reject(new Error("fts5 unavailable (forced)"));
            }

            return inner.run(sql, parameters);
        },
    };
};

let harness: ReturnType<typeof createD1Exec>;
let exec: D1Exec;

const createDocsTable = (): void => {
    harness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT)`);
};

const writerFor = (schema: SchemaLike): DatabaseWriterLike => createD1ContextDatabase({ clock: () => 1_700_000_000_000, exec, schema });

const companionRows = async (): Promise<Record<string, unknown>[]> =>
    harness.exec.all(`SELECT "__token__", "__id__", "__n__" FROM "docs__fts_by_body" ORDER BY "__token__", "__id__"`, []);

describe("d1 ctx-db search backfill", () => {
    beforeEach(() => {
        harness = createD1Exec();
        exec = withoutFts5(harness.exec);
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

        const before = await staged
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "ancient"))
            .collect();

        await backfillD1SearchIndexes(exec, stagedSchema);

        const after = await writerFor(stagedSchema)
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "ancient"))
            .collect();

        expect(before.map((document) => document["_id"])).toStrictEqual(["new"]);
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
        await runD1SearchMigrations(exec, searchSchema);

        const afterOnePass = await harness.exec.all(`SELECT COUNT(DISTINCT "__id__") AS c FROM "docs__fts_by_body"`, []);

        // The explicit runner loops to completion.
        await backfillD1SearchIndexes(exec, searchSchema);

        const afterRunner = await harness.exec.all(`SELECT COUNT(DISTINCT "__id__") AS c FROM "docs__fts_by_body"`, []);

        expect(Number(afterOnePass[0]?.["c"])).toBeLessThan(total);
        expect(Number(afterRunner[0]?.["c"])).toBe(total);
    });

    it("is idempotent — a second run does not double the occurrence counts", async () => {
        expect.assertions(1);

        const plain = writerFor(plainSchema);

        await plain.insert("docs", { _id: "d1", body: "repeat repeat unique", channel: "x" }, { allowExplicitId: true });

        await backfillD1SearchIndexes(exec, searchSchema);

        const first = await companionRows();

        // Re-running must converge, not accumulate: doubled counts would skew
        // every relevance score, and duplicate rows would return the same
        // document twice on the fts5 path.
        await backfillD1SearchIndexes(exec, searchSchema);

        await expect(companionRows()).resolves.toStrictEqual(first);
    });

    it("caps the tokens one oversized document contributes", async () => {
        expect.assertions(1);

        const plain = writerFor(plainSchema);
        const body = Array.from({ length: 1200 }, (_, index) => `token${String(index)}`).join(" ");

        await plain.insert("docs", { _id: "big", body, channel: "x" }, { allowExplicitId: true });

        await backfillD1SearchIndexes(exec, searchSchema);

        const rows = await harness.exec.all(`SELECT COUNT(*) AS c FROM "docs__fts_by_body" WHERE "__id__" = ?`, ["big"]);

        // Bounded, so one huge text column can't fan a single row write out into
        // hundreds of sequential statements.
        expect(Number(rows[0]?.["c"])).toBe(1000);
    });

    it("rebuilds the companion when the analysis profile changes", async () => {
        expect.assertions(3);

        const plain = writerFor(plainSchema);

        await plain.insert("docs", { _id: "d1", body: "the quick fox", channel: "x" }, { allowExplicitId: true });
        await backfillD1SearchIndexes(exec, searchSchema);

        const folded = await harness.exec.all(`SELECT "__token__" FROM "docs__fts_by_body" ORDER BY "__token__"`, []);

        // Declaring a language changes what a token *is*, so rows indexed under
        // the old profile would half-match forever. The recorded profile catches
        // it and the companion is rebuilt.
        await backfillD1SearchIndexes(exec, englishSchema);

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

        await backfillD1SearchIndexes(exec, englishSchema);

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
