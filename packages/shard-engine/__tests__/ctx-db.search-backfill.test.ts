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

/** Titles matching `term` through the staged index, read the way an app would. */
const searchTitles = async (term: string): Promise<unknown[]> => {
    const results = await writerFor(stagedSchema)
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

        await expect(searchTitles("hello")).resolves.toStrictEqual([]);

        backfillSearchIndexes(harness.sql, stagedSchema);

        await expect(searchTitles("hello")).resolves.toStrictEqual(["a"]);
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
        // rather than the loop having quietly run to completion.
        await expect(searchTitles("needle")).resolves.toStrictEqual([]);

        const second = backfillSearchIndexes(harness.sql, stagedSchema, { maxPages: 5 });

        expect(second.done).toBe(true);
        await expect(searchTitles("needle")).resolves.toStrictEqual(["t610"]);
    });
});
