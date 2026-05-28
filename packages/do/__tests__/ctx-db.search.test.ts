import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db.js";
import { createShardCtxDb, runShardMigrations } from "../src/ctx-db.js";
import { createSqliteExec } from "./_helpers/node-sqlite.js";

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

        return `d${counter}`;
    };

    return createShardCtxDb({
        clock,
        idGenerator,
        schema: searchSchema,
        sql: harness.sql,
    });
};

beforeEach(() => {
    harness = createSqliteExec();
});

afterEach(() => {
    harness.close();
});

describe("ctx-db search — LIKE-scan fallback", () => {
    test("matches documents containing every query token (AND semantics)", async () => {
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

    test("prefix-matches the final token", async () => {
        const writer = setupWriter();

        await writer.insert("docs", { body: "workshop", channel: "x", title: "a" });
        await writer.insert("docs", { body: "world", channel: "x", title: "b" });
        await writer.insert("docs", { body: "apple", channel: "x", title: "c" });

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "wor"))
            .collect();

        expect(results.map((document) => document["title"]).sort()).toStrictEqual(["a", "b"]);
    });

    test("narrows by an .eq() filter field", async () => {
        const writer = setupWriter();

        await writer.insert("docs", { body: "shared term", channel: "x", title: "a" });
        await writer.insert("docs", { body: "shared term", channel: "y", title: "b" });

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "shared").eq("channel", "x"))
            .collect();

        expect(results.map((document) => document["title"])).toStrictEqual(["a"]);
    });

    test("ranks higher term frequency first", async () => {
        const writer = setupWriter();

        await writer.insert("docs", { body: "alpha beta", channel: "x", title: "low" });
        await writer.insert("docs", { body: "alpha alpha alpha", channel: "x", title: "high" });

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "alpha"))
            .collect();

        expect(results.map((document) => document["title"])).toStrictEqual(["high", "low"]);
    });

    test("breaks ranking ties by creation time, newest first", async () => {
        const writer = setupWriter();

        await writer.insert("docs", { body: "tie", channel: "x", title: "older" });
        await writer.insert("docs", { body: "tie", channel: "x", title: "newer" });

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "tie"))
            .collect();

        expect(results.map((document) => document["title"])).toStrictEqual(["newer", "older"]);
    });

    test("take(n) caps the number of ranked results", async () => {
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

    test("returns nothing for an empty query", async () => {
        const writer = setupWriter();

        await writer.insert("docs", { body: "anything", channel: "x", title: "a" });

        const results = await writer
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "   "))
            .collect();

        expect(results).toStrictEqual([]);
    });

    test("reflects updates and deletes against the live table", async () => {
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

    test("first() returns the top-ranked match", async () => {
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
    test("throws on an unknown search index", () => {
        const writer = setupWriter();

        expect(() => writer.query("docs").withSearchIndex("nope", (q) => q.search("body", "x"))).toThrow(/unknown search index/u);
    });

    test("throws when .search targets a field the index does not index", () => {
        const writer = setupWriter();

        expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q.search("title", "x"))).toThrow(/indexes "body"/u);
    });

    test("throws when .eq targets a non-filter field", () => {
        const writer = setupWriter();

        expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q.search("body", "x").eq("title", "y"))).toThrow(/not a filter field/u);
    });

    test("throws when no .search() call is made", () => {
        const writer = setupWriter();

        expect(() => writer.query("docs").withSearchIndex("by_body", (q) => q)).toThrow(/requires a \.search/u);
    });

    test("throws when paginate() is called on a search query", async () => {
        const writer = setupWriter();

        await expect(
            writer
                .query("docs")
                .withSearchIndex("by_body", (q) => q.search("body", "x"))
                .paginate({ numItems: 5 }),
        ).rejects.toThrow(/pagination is not supported/u);
    });
});
