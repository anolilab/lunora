import { ftsTableName } from "@lunora/search-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { backfillSearchIndexes, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import { isSearchIndexComplete } from "../src/ctx-db-backfill";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * A search index that is still backfilling must not answer.
 *
 * A `.searchIndex()` declared over a table that already holds rows is filled a
 * page at a time, in `id` order — so until it finishes it covers a PREFIX of the
 * table. A read served from that prefix is the worst possible answer: correctly
 * shaped, confidently returned, and missing every matching document past the
 * cursor, with nothing to tell the caller the index was not ready.
 *
 * These cases pin the refusal, that it lifts the moment the backfill completes,
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

/** Titles matching `term`, read the way an app would. */
const searchTitles = async (term: string): Promise<unknown[]> => {
    const results = await writerFor(indexedSchema)
        .query("docs")
        .withSearchIndex("by_body", (q) => q.search("body", term))
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
            expect(isSearchIndexComplete(harness.sql, "docs", indexedSchema.tables["docs"]!.searchIndexes![0]!)).toBe(false);
        });

        it("answers with every match once the backfill completes", async () => {
            expect.assertions(3);

            await seedThenDeployIndex();

            backfillSearchIndexes(harness.sql, indexedSchema);

            expect(indexedRows()).toBe(ROW_COUNT);
            expect(isSearchIndexComplete(harness.sql, "docs", indexedSchema.tables["docs"]!.searchIndexes![0]!)).toBe(true);
            // Newest first on equal score — and crucially `t100`, which the scan
            // fallback below cannot reach, is here.
            await expect(searchTitles("needle")).resolves.toStrictEqual([`t${String(NEW_NEEDLE)}`, `t${String(OLD_NEEDLE)}`]);
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
    });
});
