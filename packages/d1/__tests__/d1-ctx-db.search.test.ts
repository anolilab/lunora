import type { DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase, runD1SearchMigrations } from "../src/d1-ctx-db";
import { createD1Exec, FTS5_IN_BUILD } from "./_helpers/node-sqlite-d1";

/**
 * Behavioral coverage of `.withSearchIndex().search()` against the D1 column
 * dialect. `node:sqlite` ships *without* FTS5, so this exercises the portable
 * LIKE-scan fallback end to end: AND semantics, prefix on the final token,
 * `.eq()` filter narrowing, term-frequency ranking, and the builder guards —
 * the D1 twin of `@lunora/do`'s `ctx-db.search.test.ts`. The FTS5 production
 * path (DDL + sync + MATCH SQL) is asserted separately in
 * `d1-ctx-db.search.fts.test.ts` via a recording double.
 */

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const searchSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
            shape: {
                body: col("string"),
                channel: col("string"),
                title: col("string"),
            },
        },
    },
};

let harness: ReturnType<typeof createD1Exec>;

const setupWriter = async (): Promise<DatabaseWriterLike> => {
    harness.ddl(
        `CREATE TABLE "docs" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "_version" INTEGER,
            "body" TEXT,
            "channel" TEXT,
            "title" TEXT
        )`,
    );

    // No-op under node:sqlite (no FTS5) — exercises the opt-in migration path
    // and proves it doesn't throw on an engine without fts5.
    await runD1SearchMigrations(harness.exec, searchSchema);

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

    return createD1ContextDatabase({ clock, exec: harness.exec, idGenerator, schema: searchSchema });
};

// Gated on the module actually being present: this suite runs the real D1
// factory, whose dialect declares FTS5 because D1 has it. A Node build without
// the module cannot stand in for D1 here — the parity and backfill suites,
// which override the dialect to the portable layout, cover it on every build.
describe.skipIf(!FTS5_IN_BUILD)("d1 ctx-db search", () => {
    beforeEach(() => {
        harness = createD1Exec();
    });

    afterEach(() => {
        harness.close();
    });

    describe("d1 ctx-db search — LIKE-scan fallback", () => {
        it("matches documents containing every query token (AND semantics)", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

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

            const writer = await setupWriter();

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

            const writer = await setupWriter();

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

            const writer = await setupWriter();

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

            const writer = await setupWriter();

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

            const writer = await setupWriter();

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

            const writer = await setupWriter();

            await writer.insert("docs", { body: "anything", channel: "x", title: "a" });

            const results = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "   "))
                .collect();

            expect(results).toStrictEqual([]);
        });

        it("reflects updates and deletes against the live table", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

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

            const writer = await setupWriter();

            await writer.insert("docs", { body: "rank rank rank", channel: "x", title: "top" });
            await writer.insert("docs", { body: "rank", channel: "x", title: "second" });

            const result = await writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "rank"))
                .first();

            expect(result?.["title"]).toBe("top");
        });
    });

    describe("d1 ctx-db search — builder guards", () => {
        it("throws on an unknown search index", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

            expect(() => writer.query("docs").withSearchIndex("nope", (q) => q.search("body", "x"))).toThrow(/unknown search index/u);
        });

        it("throws when .search targets a field the index does not index", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

            expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q.search("title", "x"))).toThrow(/indexes "body"/u);
        });

        it("throws when .eq targets a non-filter field", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

            expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q.search("body", "x").eq("title", "y"))).toThrow(/not a filter field/u);
        });

        it("throws when no .search() call is made", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

            expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q)).toThrow(/requires a \.search/u);
        });

        it("throws past the search-term cap", async () => {
            expect.assertions(1);

            const writer = await setupWriter();
            const term = Array.from({ length: 17 }, (_, index) => `t${String(index)}`).join(" ");

            expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q.search("body", term))).toThrow(/at most 16 search terms/u);
        });

        it("throws past the .eq() filter cap", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

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

    describe("d1 ctx-db search — pagination", () => {
        it("walks the relevance-ordered result set page by page", async () => {
            expect.assertions(4);

            const writer = await setupWriter();

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

        it("rejects a cursor that is not a search cursor", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "x"))
                    .paginate({ cursor: "not-a-cursor", numItems: 5 }),
            ).rejects.toThrow(/invalid cursor/u);
        });
    });

    describe("d1 ctx-db search — .unique()", () => {
        it("returns null when no document matches the search", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

            await writer.insert("docs", { body: "alpha", channel: "x", title: "a" });

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "absent"))
                    .unique(),
            ).resolves.toBeNull();
        });

        it("returns the single matching document", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

            await writer.insert("docs", { body: "unicorn", channel: "x", title: "solo" });
            await writer.insert("docs", { body: "horse", channel: "x", title: "other" });

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "unicorn"))
                    .unique(),
            ).resolves.toMatchObject({ title: "solo" });
        });

        it("throws when more than one document matches the search", async () => {
            expect.assertions(1);

            const writer = await setupWriter();

            await writer.insert("docs", { body: "shared term", channel: "x", title: "a" });
            await writer.insert("docs", { body: "shared term", channel: "x", title: "b" });

            await expect(
                writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "shared"))
                    .unique(),
            ).rejects.toThrow(/matched 2 documents/u);
        });
    });

    describe("d1 ctx-db — normalizeId", () => {
        it("validates an id structurally without reading the database", async () => {
            expect.assertions(4);

            const writer = await setupWriter();

            // Pure structural check — never inserted, yet a valid id round-trips.
            expect(writer.normalizeId("docs", "d_42")).toBe("d_42");
            expect(writer.normalizeId("docs", "")).toBeNull();
            expect(writer.normalizeId("docs", "has space")).toBeNull();
            expect(() => writer.normalizeId("missing", "x")).toThrow(/unknown table/u);
        });
    });
});
