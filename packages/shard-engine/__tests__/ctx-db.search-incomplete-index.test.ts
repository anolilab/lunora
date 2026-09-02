import { ftsTableName } from "@lunora/search-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { backfillSearchIndexes, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { searchIndexCoversTable } from "../src/ctx-db-backfill";
import { SEARCH_STATE_TABLE } from "../src/ctx-db-search-state";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A search index that is still backfilling must not answer — unless every row is
 * already in it.
 *
 * Two states look alike from the backfill's cursor and deserve opposite answers.
 *
 * A NEW `.searchIndex()` declared over a table that already holds rows is filled
 * a page at a time, in `id` order, so until it finishes it covers a PREFIX of the
 * table. A read served from that prefix is the worst possible answer: correctly
 * shaped, confidently returned, and missing every matching document past the
 * cursor, with nothing to tell the caller the index was not ready. It refuses.
 *
 * A REBUILDING index — one whose analyzer profile changed — has every row in the
 * companion already; the re-walk overwrites each row's analysis in place. It
 * serves: stale analysis on the shrinking suffix beats refusing every search for
 * as long as the walk takes, which on a large table is thousands of reads.
 *
 * These cases pin both, that the refusal lifts the moment the backfill completes,
 * and — the reason the reader refuses rather than falling back to the scan — that
 * the scan is NOT an equivalent answer at this scale.
 */

/** Whether this Node build's `node:sqlite` carries the FTS5 module (22.14 does not, 22.23 and 24 do). */
const FTS5_IN_BUILD = ((): boolean => {
    const probe = createSqliteExec();

    try {
        probe.raw(`CREATE VIRTUAL TABLE "__fts5_build_probe__" USING fts5(x)`);

        return true;
    } catch {
        return false;
    } finally {
        probe.close();
    }
})();

/**
 * Rows to seed. Comfortably past two 500-row backfill pages AND past
 * `MAX_SEARCH_SCAN` (1024), which is what makes a prefix distinguishable from a
 * complete index and what makes the scan fallback's window observable.
 */
const ROW_COUNT = 1200;

/** An OLD matching row: inside the backfilled prefix, outside the scan's newest-first window. */
const OLD_NEEDLE = 100;

/** A NEW matching row: outside the backfilled prefix, inside the scan's newest-first window. */
const NEW_NEEDLE = 1100;

/** The schema as it was BEFORE the search index was declared — how the existing rows got written. */
const priorSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            shape: { body: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

/** The same table after a `.searchIndex()` is added and deployed over the rows already there. */
const indexedSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", name: "by_body" }],
            shape: { body: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

/**
 * The same index re-declared under a different analysis language. Nothing about
 * the table or the companion changes — only the analyzer profile recorded with
 * the backfill's progress, which is what marks every stored row's analysis stale
 * and starts a re-walk from the top.
 */
const reanalyzedSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", language: "de", name: "by_body" }],
            shape: { body: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

/**
 * The same index re-POINTED at another column. Unlike a language change this
 * makes every stored row an answer about a column the index no longer covers.
 */
const refieldedSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "title", name: "by_body" }],
            shape: { body: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

/** A writer over `schema`, with a deterministic clock/ids so ordering is stable across runs. */
const writerFor = (schema: SchemaLike): DatabaseWriterLike => {
    let now = 1_700_000_000_000;
    let counter = 0;

    return createShardContextDatabase({
        clock: () => {
            now += 1;

            return now;
        },
        idGenerator: () => {
            counter += 1;

            // Zero-padded so lexicographic `id` order — what the backfill pages
            // on — matches insertion order for any row count.
            return `d${String(counter).padStart(6, "0")}`;
        },
        schema,
        sql: harness.sql,
    });
};

/** How many rows the companion currently holds — the index's coverage, independent of any analyzer. */
const indexedRows = (): number => Number(harness.raw(`SELECT COUNT(*) AS count FROM "${ftsTableName("docs", "by_body")}"`)[0]?.["count"]);

/** Titles matching `term`, read the way an app would, under `schema`'s analysis and declared field. */
const searchTitles = async (term: string, schema: SchemaLike = indexedSchema): Promise<unknown[]> => {
    const { field } = schema.tables["docs"]!.searchIndexes![0]!;
    const results = await writerFor(schema)
        .query("docs")
        .withSearchIndex("by_body", (q) => q.search(field, term))
        .collect();

    return results.map((document) => document["title"]);
};

/**
 * Seed {@link ROW_COUNT} rows under `priorSchema`, then deploy the search index.
 * Migration indexes its first page and stops, which is the state under test.
 */
const seedThenDeployIndex = async (): Promise<void> => {
    runShardMigrations(harness.sql, priorSchema);

    const before = writerFor(priorSchema);

    for (let index = 0; index < ROW_COUNT; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seeding; the writer is single-connection
        await before.insert("docs", {
            body: index === OLD_NEEDLE || index === NEW_NEEDLE ? "needle in the haystack" : "filler text",
            title: `t${String(index)}`,
        });
    }

    runShardMigrations(harness.sql, indexedSchema);
};

describe("search over a still-backfilling index", () => {
    afterEach(() => {
        harness.close();
    });

    describe.runIf(FTS5_IN_BUILD)("with FTS5", () => {
        beforeEach(() => {
            harness = createSqliteExec();
        });

        it("refuses instead of answering from the indexed prefix", async () => {
            expect.assertions(3);

            await seedThenDeployIndex();

            // Both needles exist and both match. The prefix holds `t100` and not
            // `t1100`, so the pre-fix reader answered `["t100"]` — a complete-looking
            // result set silently missing half its matches.
            await expect(searchTitles("needle")).rejects.toThrow(/still backfilling/u);

            // Proof the prefix is real and partial: migration indexed rows 1-500 and
            // the refused read still advanced a page (501-1000) before checking, so
            // 200 rows — `t1100` among them — remain uncovered.
            expect(indexedRows()).toBe(1000);
            expect(searchIndexCoversTable(harness.sql, "docs", indexedSchema.tables["docs"]!.searchIndexes![0]!)).toBe(false);
        });

        it("answers with every match once the backfill completes", async () => {
            expect.assertions(3);

            await seedThenDeployIndex();

            backfillSearchIndexes(harness.sql, indexedSchema);

            expect(indexedRows()).toBe(ROW_COUNT);
            expect(searchIndexCoversTable(harness.sql, "docs", indexedSchema.tables["docs"]!.searchIndexes![0]!)).toBe(true);
            // Newest first on equal score — and crucially `t100`, which the scan
            // fallback below cannot reach, is here.
            await expect(searchTitles("needle")).resolves.toStrictEqual([`t${String(NEW_NEEDLE)}`, `t${String(OLD_NEEDLE)}`]);
        });

        it("keeps answering while a changed analyzer profile rebuilds a complete index", async () => {
            expect.assertions(4);

            await seedThenDeployIndex();
            backfillSearchIndexes(harness.sql, indexedSchema);

            // The deploy that changes `language`: the recorded profile no longer
            // matches, so the next pass re-walks the table from the top. The
            // companion is NOT emptied — each row is rewritten in place as the
            // walk reaches it — so every row is still in the index throughout.
            runShardMigrations(harness.sql, reanalyzedSchema);

            expect(indexedRows()).toBe(ROW_COUNT);

            // Mid-rebuild, and every row is present: the walked prefix carries the
            // new analysis, the rest still carries the old one. Refusing here would
            // take the whole table's search offline for the length of the re-walk —
            // 500 rows per read, thousands of reads on a large table — to protect
            // against staleness the rows do not have.
            await expect(searchTitles("needle", reanalyzedSchema)).resolves.toStrictEqual([`t${String(NEW_NEEDLE)}`, `t${String(OLD_NEEDLE)}`]);
            expect(searchIndexCoversTable(harness.sql, "docs", reanalyzedSchema.tables["docs"]!.searchIndexes![0]!)).toBe(true);

            backfillSearchIndexes(harness.sql, reanalyzedSchema);

            await expect(searchTitles("needle", reanalyzedSchema)).resolves.toStrictEqual([`t${String(NEW_NEEDLE)}`, `t${String(OLD_NEEDLE)}`]);
        });

        it("refuses for the length of one re-walk after an upgrade from before profile tracking", async () => {
            expect.assertions(5);

            await seedThenDeployIndex();
            backfillSearchIndexes(harness.sql, indexedSchema);

            // Exactly what `migrateSearchState` leaves on a deployment whose rows
            // predate the `profile` column: finished, latched covered, and nothing
            // recorded about what analyzed them or over which field. No schema
            // change is involved — this is the upgrade itself.
            harness.raw(`UPDATE "${SEARCH_STATE_TABLE}" SET "profile" = NULL`);

            expect(searchIndexCoversTable(harness.sql, "docs", indexedSchema.tables["docs"]!.searchIndexes![0]!)).toBe(true);

            // …and the first read flips it. The absent profile reads as a
            // mismatch, so the pass restarts at the top, and the write of its
            // first page cannot vouch for what the stored rows are about — the
            // field could have moved in the same deploy that added tracking, and
            // no record survives to say it did not. `covered` drops and stays
            // down until the re-walk finishes.
            //
            // THE COST, which is the whole point of this case: every search on
            // this index answers 503 `SEARCH_INDEX_BUILDING` for the length of
            // that walk — 500 rows per request-driven pass — where the build
            // before this one kept serving. It is bounded, loud, and closed in
            // one call by the `backfillSearch` admin op named in the error; the
            // alternative is serving matches over a column nothing can confirm.
            await expect(searchTitles("needle")).rejects.toThrow(/still backfilling/u);
            expect(searchIndexCoversTable(harness.sql, "docs", indexedSchema.tables["docs"]!.searchIndexes![0]!)).toBe(false);

            // Nothing was emptied — every row is still in the companion. The
            // refusal is a judgement about what those rows can be trusted to
            // mean, not a gap in them.
            expect(indexedRows()).toBe(ROW_COUNT);

            backfillSearchIndexes(harness.sql, indexedSchema);

            await expect(searchTitles("needle")).resolves.toStrictEqual([`t${String(NEW_NEEDLE)}`, `t${String(OLD_NEEDLE)}`]);
        });

        it("refuses again while a re-POINTED index rebuilds, instead of serving the abandoned column", async () => {
            expect.assertions(3);

            await seedThenDeployIndex();
            backfillSearchIndexes(harness.sql, indexedSchema);

            // A COMPLETE index over `body`, then a deploy that points it at
            // `title`. The companion still holds a row per document — but the text
            // in those rows is the body, so `covered` latching on the finished
            // `body` walk had the reader answer a `title` search with `body`
            // matches for the whole re-walk. That is not stale analysis; it is a
            // different column's answer.
            runShardMigrations(harness.sql, refieldedSchema);

            expect(indexedRows()).toBe(ROW_COUNT);
            // `needle` is in the BODY of two rows and in no title at all, so this
            // answered a title search with body matches from past the re-walk's cursor.
            await expect(searchTitles("needle", refieldedSchema)).rejects.toThrow(/still backfilling/u);
            expect(searchIndexCoversTable(harness.sql, "docs", refieldedSchema.tables["docs"]!.searchIndexes![0]!)).toBe(false);
        });

        it("still refuses when the profile changes before the FIRST walk ever finished", async () => {
            expect.assertions(2);

            // The prefix case and the rebuild case at once: a NEW index 500 rows
            // into its first walk, and then the analyzer profile changes. There is
            // prior progress recorded — so "has this companion been walked before?"
            // is the wrong question to ask — but no walk has ever reached the end
            // of the table, so rows past the cursor were never in the companion and
            // the re-walk does not put them there any sooner. Refuse.
            await seedThenDeployIndex();
            runShardMigrations(harness.sql, reanalyzedSchema);

            expect(searchIndexCoversTable(harness.sql, "docs", reanalyzedSchema.tables["docs"]!.searchIndexes![0]!)).toBe(false);
            await expect(searchTitles("needle", reanalyzedSchema)).rejects.toThrow(/still backfilling/u);
        });
    });

    describe("without FTS5", () => {
        beforeEach(() => {
            harness = createSqliteExec({ withoutFts5: true });
        });

        it("answers from the scan, which is why the scan is not the mid-backfill fallback", async () => {
            expect.assertions(1);

            await seedThenDeployIndex();

            // No companion exists, so there is no coverage to consult and the read
            // goes straight to the scan — unaffected by the refusal above.
            //
            // It returns ONE of the two matches. The scan has no relevance index to
            // order by, so it scores a `MAX_SEARCH_SCAN`-sized newest-first window
            // and `t100` falls outside it. That is the whole reason a mid-backfill
            // read refuses rather than falling back here: on a table large enough
            // for the backfill to page, the scan trades the prefix's silent partial
            // answer for a suffix's silent partial answer.
            await expect(searchTitles("needle")).resolves.toStrictEqual([`t${String(NEW_NEEDLE)}`]);
        });

        it("is unaffected by an analyzer profile change, having no companion to rebuild", async () => {
            expect.assertions(1);

            await seedThenDeployIndex();
            runShardMigrations(harness.sql, reanalyzedSchema);

            // The coverage check is FTS5-only — there is no companion here, so the
            // rebuild the branch above serves through does not exist and the scan
            // answers exactly as it did before. Pinned so the two engines' answers
            // to a profile change are both under test on any Node build.
            await expect(searchTitles("needle", reanalyzedSchema)).resolves.toStrictEqual([`t${String(NEW_NEEDLE)}`]);
        });
    });
});
