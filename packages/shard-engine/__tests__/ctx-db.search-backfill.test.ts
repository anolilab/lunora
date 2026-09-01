import { ftsTableName } from "@lunora/search-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { backfillSearchIndexes, createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * `staged: true` and its exit.
 *
 * A staged search index is skipped by every migration pass by design — the
 * option exists for tables too large to walk during a cold start — so the rows
 * that predate the index stay out of the companion until something runs
 * {@link backfillSearchIndexes}. These cases pin both halves: that the skip is
 * real (a pre-existing row is genuinely unsearchable), and that the backfill is
 * what makes it searchable, page-bounded and resumable.
 *
 * FTS5-only. Without the module the reader falls back to a LIKE scan over the
 * document table, which never consults a companion — so there is no staleness
 * to observe and nothing here to assert.
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

/** The schema as it was BEFORE the search index was declared — how the pre-existing rows got written. */
const priorSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            shape: { body: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

/** The same table after a `.searchIndex(..., { staged: true })` is added and deployed. */
const stagedSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", name: "by_body", staged: true }],
            shape: { body: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

/** The same index re-declared under a different analysis language, which invalidates every stored token. */
const reanalyzedSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", language: "de", name: "by_body", staged: true }],
            shape: { body: { kind: "string" }, title: { kind: "string" } },
        },
    },
};

/** Two staged indexes over the same rows, so one call has to cross from a budget-exhausted index to a fresh one. */
const twoStagedSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [
                { field: "body", name: "by_body", staged: true },
                { field: "title", name: "by_title", staged: true },
            ],
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

/** How many rows the `by_body` companion currently holds — the index's coverage, independent of any analyzer. */
const indexedRows = (): number => Number(harness.raw(`SELECT COUNT(*) AS count FROM "${ftsTableName("docs", "by_body")}"`)[0]?.["count"]);

/** Titles matching `term` through the staged index, read the way an app would, under `schema`'s analysis. */
const searchTitles = async (term: string, schema: SchemaLike = stagedSchema): Promise<unknown[]> => {
    const results = await writerFor(schema)
        .query("docs")
        .withSearchIndex("by_body", (q) => q.search("body", term))
        .collect();

    return results.map((document) => document["title"]);
};

describe.runIf(FTS5_IN_BUILD)("staged search index backfill", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("leaves rows that predate the index unsearchable until the backfill runs", async () => {
        expect.assertions(2);

        // Deploy 1: no search index yet, so these rows are written with nothing
        // syncing them into a companion.
        runShardMigrations(harness.sql, priorSchema);

        const before = writerFor(priorSchema);

        await before.insert("docs", { body: "hello world", title: "a" });
        await before.insert("docs", { body: "goodbye world", title: "b" });

        // Deploy 2: the staged index arrives. Migration provisions the companion
        // but skips the backfill, which is the whole point of `staged`.
        runShardMigrations(harness.sql, stagedSchema);

        // Refused, not answered with the empty set: an index that covers none of
        // the table is still an index covering a *prefix* of it, and serving a
        // result set from that prefix is exactly the silently-partial answer the
        // reader now declines to give. `ctx-db.search-incomplete-index.test.ts`
        // pins the non-empty version of the same refusal.
        await expect(searchTitles("hello")).rejects.toThrow(/still backfilling/u);

        backfillSearchIndexes(harness.sql, stagedSchema);

        await expect(searchTitles("hello")).resolves.toStrictEqual(["a"]);
    });

    it("serves a staged index declared on a table with nothing to backfill", async () => {
        expect.assertions(2);

        // `staged` is about keeping a large table's walk out of the cold start.
        // Declared with the table, there is no walk: the write path fills the
        // companion from the first row. Skipping it anyway would leave no recorded
        // coverage, so every search would refuse until an operator ran a backfill
        // that has nothing to do.
        runShardMigrations(harness.sql, stagedSchema);

        const writer = writerFor(stagedSchema);

        await writer.insert("docs", { body: "hello world", title: "a" });

        await expect(searchTitles("hello")).resolves.toStrictEqual(["a"]);
        // And it cost no walk: the empty page recorded completion, so the operator
        // backfill still has nothing to charge for.
        expect(backfillSearchIndexes(harness.sql, stagedSchema)).toStrictEqual({ done: true, pages: 0 });
    });

    it("reports the pages it ran and charges nothing for an index already complete", async () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, priorSchema);

        await writerFor(priorSchema).insert("docs", { body: "hello world", title: "a" });

        runShardMigrations(harness.sql, stagedSchema);

        // One page covers a table this small, so the first call finishes it.
        expect(backfillSearchIndexes(harness.sql, stagedSchema)).toStrictEqual({ done: true, pages: 1 });
        // The second finds recorded completion and returns without touching the
        // store — a page budget must not be spent re-confirming finished work,
        // or a schema whose finished indexes outnumber the budget could never
        // reach the one that still needs it.
        expect(backfillSearchIndexes(harness.sql, stagedSchema)).toStrictEqual({ done: true, pages: 0 });
    });

    it("stops at the page budget and resumes from where it stopped", async () => {
        expect.assertions(4);

        runShardMigrations(harness.sql, priorSchema);

        const before = writerFor(priorSchema);

        // Two full pages plus a remainder: the 500-row page size is internal, so
        // this only has to be comfortably more than one page.
        for (let index = 0; index < 620; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding; the writer is single-connection
            await before.insert("docs", { body: index === 610 ? "needle in the haystack" : "filler text", title: `t${String(index)}` });
        }

        runShardMigrations(harness.sql, stagedSchema);

        const first = backfillSearchIndexes(harness.sql, stagedSchema, { maxPages: 1 });

        expect(first).toStrictEqual({ done: false, pages: 1 });
        // The row past the first page is still unindexed — proof the cap bit
        // rather than the loop having quietly run to completion. The read
        // refuses while that is true instead of answering from the 500 rows it
        // does cover.
        await expect(searchTitles("needle")).rejects.toThrow(/still backfilling/u);

        const second = backfillSearchIndexes(harness.sql, stagedSchema, { maxPages: 5 });

        expect(second.done).toBe(true);
        await expect(searchTitles("needle")).resolves.toStrictEqual(["t610"]);
    });

    it("keeps serving a complete index while a changed analyzer profile rebuilds it", async () => {
        expect.assertions(4);

        runShardMigrations(harness.sql, priorSchema);

        const before = writerFor(priorSchema);

        // More than one 500-row page, so a rebuild cannot finish in one pass —
        // which is the only way the gap is observable. One needle inside the
        // first page and one past it, so a read mid-rebuild has to answer from
        // rows under BOTH analyses to return them both.
        for (let index = 0; index < 620; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding; the writer is single-connection
            await before.insert("docs", { body: index === 10 || index === 610 ? "needle in the haystack" : "filler text", title: `t${String(index)}` });
        }

        runShardMigrations(harness.sql, stagedSchema);
        backfillSearchIndexes(harness.sql, stagedSchema);

        expect(indexedRows()).toBe(620);

        /*
         * Changing `language` invalidates every stored token, so the next pass
         * re-walks the table from the top. It used to `DELETE FROM` the companion
         * first: a COMPLETE index dropped to zero rows and came back 500 at a
         * time, while the read path queried it regardless — on a 1M-row table,
         * thousands of requests answered from a fraction of the rows.
         */
        const first = backfillSearchIndexes(harness.sql, reanalyzedSchema, { maxPages: 1 });

        expect(first).toStrictEqual({ done: false, pages: 1 });
        // Every row is still in the index: the walked prefix carries the new
        // analysis, the rest still carries the old one.
        expect(indexedRows()).toBe(620);
        // And "serving" is the point of keeping them: a read mid-rebuild returns
        // both needles — `t10` re-analyzed under `de`, `t610` still under `en`.
        // Refusing until the walk finished would be the deleted DELETE by another
        // route: the rows are all there, nothing about them is missing.
        await expect(searchTitles("needle", reanalyzedSchema)).resolves.toStrictEqual(["t610", "t10"]);
    });

    it("refuses a half-built index whose profile changes, staged so no read advances it", async () => {
        expect.assertions(2);

        runShardMigrations(harness.sql, priorSchema);

        const before = writerFor(priorSchema);

        for (let index = 0; index < 620; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding; the writer is single-connection
            await before.insert("docs", { body: index === 610 ? "needle in the haystack" : "filler text", title: `t${String(index)}` });
        }

        runShardMigrations(harness.sql, stagedSchema);

        // One page in, so the companion holds rows 1-500 and has NEVER held 501-620.
        expect(backfillSearchIndexes(harness.sql, stagedSchema, { maxPages: 1 })).toStrictEqual({ done: false, pages: 1 });

        // Then the analyzer profile changes. Prior progress exists and the walk is
        // about to restart from the top — which is exactly the shape of a rebuild,
        // and is not one: the rows past the cursor were never indexed, and the
        // re-walk reaches them no sooner than the first walk would have. Staged, so
        // no read advances the backfill and the pre-restart state is what the read
        // actually sees. `t610` is still missing, so the read still refuses.
        runShardMigrations(harness.sql, reanalyzedSchema);

        await expect(searchTitles("needle", reanalyzedSchema)).rejects.toThrow(/still backfilling/u);
    });

    it("does not walk one more page for the next index once the budget is spent", async () => {
        expect.assertions(1);

        runShardMigrations(harness.sql, priorSchema);

        const before = writerFor(priorSchema);

        // More than one page, so neither index can finish inside the budget.
        for (let index = 0; index < 620; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding; the writer is single-connection
            await before.insert("docs", { body: "filler text", title: `t${String(index)}` });
        }

        runShardMigrations(harness.sql, twoStagedSchema);

        // 620 rows is exactly two 500-row pages, so `by_body` FINISHES on the
        // last page the budget allows and `by_title` is reached with nothing
        // left. Deciding the budget after the page let it walk one anyway — 500
        // more row writes than the caller sized its request for.
        expect(backfillSearchIndexes(harness.sql, twoStagedSchema, { maxPages: 2 })).toStrictEqual({ done: false, pages: 2 });
    });
});
