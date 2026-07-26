import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Behavioral coverage of `.withSearchIndex().search()` against a real SQLite
 * engine. `node:sqlite` ships *without* FTS5, so this exercises the portable
 * LIKE-scan fallback end to end: AND semantics, prefix on the final token,
 * `.eq()` filter narrowing, term-frequency ranking, and the builder guards.
 * The FTS5 production path (DDL + sync + MATCH SQL) is asserted separately in
 * `ctx-db.search.fts.test.ts` via a recording double.
 */

const searchSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
            shape: {
                body: { kind: "string" },
                channel: { kind: "string" },
                title: { kind: "string" },
            },
        },
    },
};

let harness: ReturnType<typeof createSqliteExec>;

const setupWriter = (): DatabaseWriterLike => {
    runShardMigrations(harness.sql, searchSchema);

    let now = 1_700_000_000_000;
    let counter = 0;

    const clock = (): number => {
        now += 1;

        return now;
    };

    const idGenerator = (): string => {
        counter += 1;

        return `d${String(counter)}`;
    };

    return createShardContextDatabase({
        clock,
        idGenerator,
        schema: searchSchema,
        sql: harness.sql,
    });
};

describe("ctx-db search", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("ctx-db search — LIKE-scan fallback", () => {
        it("matches documents containing every query token (AND semantics)", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "hello world", channel: "x", title: "a" });
            await writer.insert("docs", { body: "hello there", channel: "x", title: "b" });
            await writer.insert("docs", { body: "goodbye world", channel: "x", title: "c" });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "hello world"))
                .collect();

            expect(results.map((document) => document["title"])).toStrictEqual(["a"]);
        });

        it("prefix-matches the final token", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "workshop", channel: "x", title: "a" });
            await writer.insert("docs", { body: "world", channel: "x", title: "b" });
            await writer.insert("docs", { body: "apple", channel: "x", title: "c" });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "wor"))
                .collect();

            expect(results.map((document) => document["title"]).toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual(["a", "b"]);
        });

        it("narrows by an .eq() filter field", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "shared term", channel: "x", title: "a" });
            await writer.insert("docs", { body: "shared term", channel: "y", title: "b" });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "shared").eq("channel", "x"))
                .collect();

            expect(results.map((document) => document["title"])).toStrictEqual(["a"]);
        });

        it("ranks higher term frequency first", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "alpha beta", channel: "x", title: "low" });
            await writer.insert("docs", { body: "alpha alpha alpha", channel: "x", title: "high" });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "alpha"))
                .collect();

            expect(results.map((document) => document["title"])).toStrictEqual(["high", "low"]);
        });

        it("breaks ranking ties by creation time, newest first", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "tie", channel: "x", title: "older" });
            await writer.insert("docs", { body: "tie", channel: "x", title: "newer" });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "tie"))
                .collect();

            expect(results.map((document) => document["title"])).toStrictEqual(["newer", "older"]);
        });

        it("take(n) caps the number of ranked results", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "match one", channel: "x", title: "a" });
            await writer.insert("docs", { body: "match two", channel: "x", title: "b" });
            await writer.insert("docs", { body: "match three", channel: "x", title: "c" });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "match"))
                .take(2);

            expect(results).toHaveLength(2);
        });

        it("returns nothing for an empty query", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "anything", channel: "x", title: "a" });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "   "))
                .collect();

            expect(results).toStrictEqual([]);
        });

        it("reflects updates and deletes against the live table", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            const matchId = await writer.insert("docs", { body: "keeper", channel: "x", title: "keep" });
            const morphId = await writer.insert("docs", { body: "stale", channel: "x", title: "morph" });
            const dropId = await writer.insert("docs", { body: "keeper", channel: "x", title: "drop" });

            await writer.patch(morphId, { body: "keeper now" });
            await writer.delete(dropId);

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "keeper"))
                .collect();

            expect(new Set(results.map((document) => document["_id"]))).toStrictEqual(new Set([matchId, morphId]));
        });

        it("first() returns the top-ranked match", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "rank rank rank", channel: "x", title: "top" });
            await writer.insert("docs", { body: "rank", channel: "x", title: "second" });

            const result = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "rank"))
                .first();

            expect(result?.["title"]).toBe("top");
        });
    });

    describe("ctx-db search — builder guards", () => {
        it("throws on an unknown search index", () => {
            expect.assertions(1);

            const writer = setupWriter();

            expect(() => writer.query("docs").withSearchIndex("nope", (q) => q.search("body", "x"))).toThrow(/unknown search index/u);
        });

        it("throws when .search targets a field the index does not index", () => {
            expect.assertions(1);

            const writer = setupWriter();

            expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q.search("title", "x"))).toThrow(/indexes "body"/u);
        });

        it("throws when .eq targets a non-filter field", () => {
            expect.assertions(1);

            const writer = setupWriter();

            expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q.search("body", "x").eq("title", "y"))).toThrow(/not a filter field/u);
        });

        it("throws when no .search() call is made", () => {
            expect.assertions(1);

            const writer = setupWriter();

            expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q)).toThrow(/requires a \.search/u);
        });

        it("throws past the search-term cap", () => {
            expect.assertions(1);

            const writer = setupWriter();
            const term = Array.from({ length: 17 }, (_, index) => `t${String(index)}`).join(" ");

            expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q.search("body", term))).toThrow(/at most 16 search terms/u);
        });

        it("counts repeated terms once against the search-term cap", () => {
            expect.assertions(1);

            const writer = setupWriter();
            const term = Array.from({ length: 40 }).fill("same").join(" ");

            expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q.search("body", term))).not.toThrow();
        });

        it("throws past the .eq() filter cap", () => {
            expect.assertions(1);

            const filterSchema: SchemaLike = {
                tables: {
                    docs: {
                        ...searchSchema.tables["docs"]!,
                        searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
                    },
                },
            };

            runShardMigrations(harness.sql, filterSchema);

            const writer = createShardContextDatabase({ schema: filterSchema, sql: harness.sql });

            expect(() =>
                writer.query("docs").withSearchIndex("by_body", (q) => {
                    let builder = q.search("body", "x");

                    for (let index = 0; index < 9; index += 1) {
                        builder = builder.eq("channel", "x");
                    }

                    return builder;
                }),
            ).toThrow(/at most 8 \.eq\(\) filters/u);
        });
    });

    describe("ctx-db search — pagination", () => {
        it("walks the relevance-ordered result set page by page", async () => {
            expect.assertions(4);

            const writer = setupWriter();

            // Descending occurrence counts give a deterministic relevance order.
            await writer.insert("docs", { body: "page page page", channel: "x", title: "first" });
            await writer.insert("docs", { body: "page page", channel: "x", title: "second" });
            await writer.insert("docs", { body: "page", channel: "x", title: "third" });

            const firstPage = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "page"))
                .paginate({ numItems: 2 });

            expect(firstPage.page.map((document) => document["title"])).toStrictEqual(["first", "second"]);
            expect(firstPage.isDone).toBe(false);

            const secondPage = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "page"))
                .paginate({ cursor: firstPage.continueCursor, numItems: 2 });

            expect(secondPage.page.map((document) => document["title"])).toStrictEqual(["third"]);
            expect(secondPage.isDone).toBe(true);
        });

        it("rejects a bounded (endCursor) search page", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "x"))
                    .paginate({ endCursor: "whatever", numItems: 5 }),
            ).rejects.toThrow(/bounded \(endCursor\) pagination is not supported/u);
        });

        it("terminates a zero-length page instead of echoing the cursor", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await writer.insert("docs", { body: "page", channel: "x", title: "only" });

            const page = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "page"))
                .paginate({ numItems: 0 });

            // A self-referential cursor with isDone false would spin a client loop.
            expect(page.isDone).toBe(true);
            expect(page.continueCursor).toBeNull();
        });

        it("refuses to page past the document cap", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "x"))
                    .paginate({ numItems: 2000 }),
            ).rejects.toThrow(/reaches past the 1024-document limit/u);
        });

        it("rejects a cursor that is not a search cursor", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "x"))
                    .paginate({ cursor: "not-a-cursor", numItems: 5 }),
            ).rejects.toThrow(/invalid cursor/u);
        });
    });

    describe("ctx-db search — result cap", () => {
        it("refuses a take() past the document cap rather than silently truncating", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "x"))
                    .take(5000),
            ).rejects.toThrow(/at most 1024 documents/u);
        });
    });

    describe("ctx-db search — backfill robustness", () => {
        it("skips a corrupt document instead of bricking the migration pass", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await writer.insert("docs", { body: "readable one", channel: "x", title: "ok" });
            await writer.insert("docs", { body: "readable two", channel: "x", title: "also ok" });

            // Corrupt one stored blob, then drop the companion so a fresh
            // migration pass has to re-index from scratch. `rowToDocument`
            // JSON.parses the blob and throws — inside `runShardMigrations`,
            // an unhandled throw would take the whole shard's cold start down.
            harness.raw(`UPDATE "docs" SET "__doc__" = ? WHERE id = ?`, "{not json", "d1");
            harness.raw(`DROP TABLE IF EXISTS "docs__fts_by_body"`);
            harness.raw(`DELETE FROM "__lunora_search_state"`);

            expect(() => { runShardMigrations(harness.sql, searchSchema); }).not.toThrow();

            const results = await createShardContextDatabase({ schema: searchSchema, sql: harness.sql })
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "readable"))
                .collect();

            // The intact row is still indexed; only the unreadable one is lost.
            expect(results.map((document) => document["title"])).toStrictEqual(["also ok"]);
        });
    });

    describe("ctx-db search — nested fields", () => {
        it("indexes a dot-separated path into a nested object", async () => {
            expect.assertions(1);

            const nestedSchema: SchemaLike = {
                tables: {
                    docs: {
                        indexes: [],
                        searchIndexes: [{ field: "properties.name", name: "by_name" }],
                        shape: {
                            properties: { kind: "object" },
                        },
                    },
                },
            };

            runShardMigrations(harness.sql, nestedSchema);

            const writer = createShardContextDatabase({ schema: nestedSchema, sql: harness.sql });

            await writer.insert("docs", { properties: { name: "hello nested world" } });
            await writer.insert("docs", { properties: { name: "unrelated" } });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_name", (q) => q.search("properties.name", "nested"))
                .collect();

            expect(results.map((document) => (document["properties"] as { name: string }).name)).toStrictEqual(["hello nested world"]);
        });
    });
});
