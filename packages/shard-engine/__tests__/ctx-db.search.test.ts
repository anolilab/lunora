import { MAX_SEARCH_SCAN } from "@lunora/search-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";
import createSqliteExec from "./_helpers/node-sqlite";

/**
 * Behavioral coverage of `.withSearchIndex().search()` against a real SQLite
 * engine: AND semantics, prefix on the final token, `.eq()` filter narrowing,
 * term-frequency ranking, the builder guards, paging and the result cap.
 *
 * Every case runs **twice**, once per engine shape the ctx-db supports — the
 * FTS5 shadow table a Durable Object gets, and the LIKE scan over the document
 * table it falls back to where the engine has no FTS5. Which one a bare
 * `node:sqlite` gives depends on the Node build (22.14 has no FTS5, 22.23 and
 * 24 do), so leaving it ambient means one branch is under test and the other is
 * exercised by nobody. That is not hypothetical: an unguarded read-time
 * backfill passed here on Node 24 and threw "no such table" on every search
 * under 22.14, because the fallback creates no companion to back-fill.
 *
 * The FTS5 *emitted SQL* (DDL + sync + MATCH) is asserted separately in
 * `ctx-db.search.fts.test.ts` via a recording double.
 */

/** Whether this Node build's `node:sqlite` carries the FTS5 module at all. */
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
 * The engine shapes to run every case against. The fallback is always
 * reachable (the harness can refuse the fts5 DDL); the FTS5 leg needs the
 * module to actually be there, so it drops out on a build without it rather
 * than failing — CI's other Node runs it.
 */
const ENGINES: { label: string; withoutFts5: boolean }[] = [
    ...(FTS5_IN_BUILD ? [{ label: "FTS5 shadow table", withoutFts5: false }] : []),
    { label: "LIKE scan (no FTS5)", withoutFts5: true },
];

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

describe.each(ENGINES)("ctx-db search — $label", (engine) => {
    beforeEach(() => {
        harness = createSqliteExec({ withoutFts5: engine.withoutFts5 });
    });

    afterEach(() => {
        harness.close();
    });

    describe("query semantics", () => {
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

    describe("collectWithScores", () => {
        it("pairs each document with its relevance score, descending", async () => {
            expect.assertions(3);

            const writer = setupWriter();

            await writer.insert("docs", { body: "alpha beta", channel: "x", title: "low" });
            await writer.insert("docs", { body: "alpha alpha alpha", channel: "x", title: "high" });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "alpha"))
                .collectWithScores();

            expect(results.map((entry) => entry.document["title"])).toStrictEqual(["high", "low"]);
            // Higher term frequency scores higher, and it's strictly descending —
            // not just an order the fixture happens to already have.
            expect(results[0]?.score).toBeGreaterThan(results[1]?.score ?? 0);
            expect(typeof results[1]?.score).toBe("number");
        });

        it("returns the same documents .collect() would, unchanged", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "match one", channel: "x", title: "a" });
            await writer.insert("docs", { body: "match two", channel: "x", title: "b" });

            const bare = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "match"))
                .collect();
            const scored = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "match"))
                .collectWithScores();

            expect(scored.map((entry) => entry.document)).toStrictEqual(bare);
        });

        it("throws when called without a staged .withSearchIndex()/.withGeoIndex()", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await expect(writer.query("docs").collectWithScores()).rejects.toThrow(
                /collectWithScores\(\) requires a staged \.withSearchIndex\(\.\.\.\) or \.withGeoIndex\(\.\.\.\)/u,
            );
        });
    });

    describe("builder guards", () => {
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

    describe("pagination", () => {
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

    describe("result cap", () => {
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

    /**
     * Everything that narrows a search *after* the engine has ranked it. The
     * engine read is bounded by relevance, so a post-filter takes rows out of
     * that window rather than reaching for more — which is the documented
     * trade and the reason these need pinning rather than assuming.
     */
    describe("post-engine narrowing", () => {
        it("applies an in-memory .filter() to the ranked window", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await writer.insert("docs", { body: "hello world", channel: "x", title: "keep" });
            await writer.insert("docs", { body: "hello there", channel: "x", title: "drop" });

            const kept = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .filter((document) => document["title"] === "keep")
                .collect();

            expect(kept.map((document) => document["title"])).toStrictEqual(["keep"]);

            // The limit still bounds what comes back, counted *after* the
            // predicate — not before, which would return fewer than asked for
            // whenever the filter rejected anything in the window.
            const bounded = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .filter((document) => document["title"] !== "keep")
                .take(1);

            expect(bounded.map((document) => document["title"])).toStrictEqual(["drop"]);
        });

        // `@lunora/server`'s RLS middleware enforces a row policy by calling
        // `.filter(predicate)` on this exact reader and forwarding the SAME
        // object back (it never rebuilds a narrower one) — see
        // `packages/server/src/rls/middleware.ts`'s `query()`. That means
        // `.collectWithScores()` composes with RLS "for free" as long as it
        // respects `stage.inMemoryFilters` the same way `.collect()` does.
        // This pins that: a `.filter()` staged before `.collectWithScores()`
        // must narrow the scored window exactly like it narrows `.collect()`.
        it("respects a .filter() staged before it, same as .collect()", async () => {
            expect.assertions(1);

            const writer = setupWriter();

            await writer.insert("docs", { body: "hello world", channel: "x", title: "keep" });
            await writer.insert("docs", { body: "hello there", channel: "x", title: "drop" });

            const kept = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .filter((document) => document["title"] === "keep")
                .collectWithScores();

            expect(kept.map((entry) => entry.document["title"])).toStrictEqual(["keep"]);
        });

        it("hides soft-deleted rows without touching the companion", async () => {
            expect.assertions(2);

            const softSchema: SchemaLike = {
                tables: {
                    docs: {
                        indexes: [],
                        searchIndexes: [{ field: "body", name: "by_body" }],
                        shape: { body: { kind: "string" }, deletedAt: { kind: "number" } },
                        softDeleteMode: { field: "deletedAt" },
                    },
                },
            };

            runShardMigrations(harness.sql, softSchema);

            const writer = createShardContextDatabase({
                idGenerator: ((): (() => string) => {
                    let counter = 0;

                    return () => {
                        counter += 1;

                        return `d${String(counter)}`;
                    };
                })(),
                schema: softSchema,
                sql: harness.sql,
            });

            await writer.insert("docs", { body: "hello world" });
            await writer.insert("docs", { body: "hello there" });
            await writer.delete("d2", "docs");

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                .collect();

            // A soft delete is a column flip, not an index eviction — the
            // companion still holds d2's text, so the exclusion has to happen
            // where the documents are read.
            expect(results.map((document) => document["_id"])).toStrictEqual(["d1"]);

            // And a hard delete removes it from both.
            await writer.delete("d1", "docs", { hard: true });

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                    .collect(),
            ).resolves.toStrictEqual([]);
        });
    });

    /**
     * The cap's whole job is that a truncated result set is never handed back as
     * if it were the whole one. An unbounded read asks the engine for one row
     * past* the cap so it can tell "exactly the cap" from "more than the cap" —
     * so any layout that clamps its own query to the cap makes that probe row
     * unreachable and the guard dead, and 1024 rows come back looking complete.
     */
    describe("the over-cap probe", () => {
        it("refuses an unbounded read whose match set exceeds the cap", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            for (let index = 0; index < MAX_SEARCH_SCAN + 60; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- deterministic ids require sequential inserts
                await writer.insert("docs", { body: "needle", channel: "x", title: `t${String(index)}` });
            }

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "needle"))
                    .collect(),
            ).rejects.toThrow(/more than 1024 documents match/u);

            // A bounded read over the same corpus still answers, because the
            // caller asked for a slice rather than the whole set.
            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "needle"))
                    .take(3),
            ).resolves.toHaveLength(3);
        });
    });

    describe("corrupt documents", () => {
        it("skips an unreadable document instead of failing the whole surface", async () => {
            expect.assertions(2);

            const writer = setupWriter();

            await writer.insert("docs", { body: "readable one", channel: "x", title: "ok" });
            await writer.insert("docs", { body: "readable two", channel: "x", title: "also ok" });

            // A stored blob that no longer parses. `rowToDocument` throws on it,
            // and both engines walk every row: the FTS5 path re-indexes the
            // table on a fresh migration pass, the scan path reads every
            // document on every query. Either way one bad row must cost that row
            // and nothing else — an unhandled throw here takes down the shard's
            // cold start on one engine and every search on the other.
            harness.raw(`UPDATE "docs" SET "__doc__" = ? WHERE id = ?`, "{not json", "d1");
            harness.raw(`DROP TABLE IF EXISTS "docs__fts_by_body"`);
            harness.raw(`DELETE FROM "__lunora_search_state"`);

            expect(() => {
                runShardMigrations(harness.sql, searchSchema);
            }).not.toThrow();

            const results = await createShardContextDatabase({ schema: searchSchema, sql: harness.sql })
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "readable"))
                .collect();

            // The intact row is still found; only the unreadable one is lost.
            expect(results.map((document) => document["title"])).toStrictEqual(["also ok"]);
        });
    });

    describe("nested fields", () => {
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
