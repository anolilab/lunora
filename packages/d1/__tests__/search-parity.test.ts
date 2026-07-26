import { DatabaseSync } from "node:sqlite";

import type { DatabaseWriterLike, SchemaLike, SqlCursor, SqlExec, ValidatorLike } from "@lunora/do";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/do";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import createD1Exec from "./_helpers/node-sqlite-d1";

/**
 * The parity gate.
 *
 * `.searchIndex()` promises one thing above all: the same corpus and the same
 * query return the same documents, in the same order, whichever backend stores
 * them. The two implementations share only the primitives in `search-text` —
 * the DO side scores in JS over a JSON blob, the `.global()` side aggregates in
 * SQL over an inverted companion — so nothing but a test comparing their actual
 * output can hold that promise.
 *
 * Every case below runs the identical corpus through both and asserts the two
 * result lists are equal, ids and order. A divergence here is a parity bug
 * regardless of which side is "right".
 */

interface Document {
    body: string;
    channel: string;
    id: string;
}

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

const doSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
            shape: { body: { kind: "string" }, channel: { kind: "string" } },
        },
    },
};

const globalSchema: SchemaLike = {
    tables: {
        docs: {
            indexes: [],
            searchIndexes: [{ field: "body", filterFields: ["channel"], name: "by_body" }],
            shape: { body: col("string"), channel: col("string") },
            shardMode: { kind: "global" },
        },
    },
};

const CORPUS: Document[] = [
    { body: "hello world", channel: "general", id: "a" },
    { body: "hello hello wonderful world", channel: "general", id: "b" },
    { body: "goodbye world", channel: "general", id: "c" },
    { body: "hello world", channel: "other", id: "d" },
    { body: "javascript", channel: "general", id: "e" },
    { body: "java jakarta", channel: "general", id: "f" },
    { body: "HELLO World", channel: "general", id: "g" },
    { body: "hello, world! hello?", channel: "general", id: "h" },
    { body: "worldwide hello", channel: "general", id: "i" },
    { body: "", channel: "general", id: "j" },
    { body: "café society", channel: "general", id: "k" },
    { body: "cafe society", channel: "general", id: "l" },
    { body: "Ünïcödé stress", channel: "general", id: "m" },
];

let doHarness: DatabaseSync;
let globalHarness: ReturnType<typeof createD1Exec>;

/**
 * The DO store's synchronous `SqlExec` over `node:sqlite`. The DO package keeps
 * its own harness in its own `__tests__`, which this package can't import, and
 * the adapter is six lines — cheaper to restate than to publish a test helper.
 */
const shardExec = (database: DatabaseSync): SqlExec => {
    return {
        exec: <Row = Record<string, unknown>>(query: string, ...parameters: unknown[]): SqlCursor<Row> => {
            const rows = database.prepare(query).all(...(parameters as never[])) as Row[];

            return {
                one() {
                    if (rows.length !== 1) {
                        throw new Error(`expected exactly one row, received ${String(rows.length)}`);
                    }

                    return rows[0]!;
                },
                [Symbol.iterator]() {
                    return rows[Symbol.iterator]();
                },
                toArray() {
                    return rows;
                },
            };
        },
    };
};

/** Seed both backends with the identical corpus, on the identical clock. */
const seedBoth = async (): Promise<{ global: DatabaseWriterLike; shard: DatabaseWriterLike }> => {
    const clockFrom = (): (() => number) => {
        let now = 1_700_000_000_000;

        return () => {
            now += 1000;

            return now;
        };
    };

    const sql = shardExec(doHarness);

    runShardMigrations(sql, doSchema);

    const shard = createShardContextDatabase({ clock: clockFrom(), schema: doSchema, sql });

    globalHarness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT)`);

    const global = createD1ContextDatabase({ clock: clockFrom(), exec: globalHarness.exec, schema: globalSchema });

    for (const document of CORPUS) {
        // eslint-disable-next-line no-await-in-loop -- deterministic creation times require sequential inserts
        await shard.insert("docs", { _id: document.id, body: document.body, channel: document.channel }, { allowExplicitId: true });
        // eslint-disable-next-line no-await-in-loop -- same, on the twin
        await global.insert("docs", { _id: document.id, body: document.body, channel: document.channel }, { allowExplicitId: true });
    }

    return { global, shard };
};

const idsOf = (documents: Record<string, unknown>[]): unknown[] => documents.map((document) => document["_id"]);

describe("search parity — sharded DO vs .global()", () => {
    beforeEach(() => {
        doHarness = new DatabaseSync(":memory:");
        globalHarness = createD1Exec();
    });

    afterEach(() => {
        doHarness.close();
        globalHarness.close();
    });

    const cases: { name: string; term: string }[] = [
        { name: "single term", term: "hello" },
        { name: "two terms, AND semantics", term: "hello world" },
        { name: "prefix on the final term", term: "hello wor" },
        { name: "prefix shadowed by an earlier exact term", term: "javascript java" },
        { name: "prefix that is also a whole word", term: "java" },
        { name: "repeated term", term: "hello hello" },
        { name: "term matching nothing", term: "nonexistent" },
        { name: "mixed case query", term: "HeLLo WoRLd" },
        { name: "punctuation in the query", term: "hello, world!" },
        { name: "empty query", term: "" },
        { name: "whitespace-only query", term: "   " },
        { name: "punctuation-only query", term: "!!!" },
        { name: "accented query against unaccented text", term: "café" },
        { name: "unaccented query against accented text", term: "cafe" },
        { name: "mixed diacritics", term: "unicode" },
    ];

    it.each(cases)("agrees on $name", async (searchCase) => {
        expect.assertions(1);

        const { global, shard } = await seedBoth();

        const shardResults = await shard
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", searchCase.term))
            .collect();
        const globalResults = await global
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", searchCase.term))
            .collect();

        expect(idsOf(globalResults)).toStrictEqual(idsOf(shardResults));
    });

    it("folds accents identically on both backends", async () => {
        expect.assertions(2);

        const { global, shard } = await seedBoth();

        // Both spellings must find both documents — the case that used to
        // depend on which engine's collation happened to be underneath.
        const shardResults = await shard
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "café"))
            .collect();
        const globalResults = await global
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "cafe"))
            .collect();

        expect(idsOf(shardResults).toSorted((left, right) => String(left).localeCompare(String(right)))).toStrictEqual(["k", "l"]);
        expect(idsOf(globalResults).toSorted((left, right) => String(left).localeCompare(String(right)))).toStrictEqual(["k", "l"]);
    });

    it("agrees when an .eq() filter narrows the match", async () => {
        expect.assertions(1);

        const { global, shard } = await seedBoth();

        const shardResults = await shard
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello").eq("channel", "other"))
            .collect();
        const globalResults = await global
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello").eq("channel", "other"))
            .collect();

        expect(idsOf(globalResults)).toStrictEqual(idsOf(shardResults));
    });

    it("agrees on the page boundary, including the cursor sequence", async () => {
        expect.assertions(3);

        const { global, shard } = await seedBoth();

        const shardPage = await shard
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .paginate({ numItems: 2 });
        const globalPage = await global
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .paginate({ numItems: 2 });

        expect(idsOf(globalPage.page)).toStrictEqual(idsOf(shardPage.page));
        expect(globalPage.continueCursor).toStrictEqual(shardPage.continueCursor);

        const shardNext = await shard
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .paginate({ cursor: shardPage.continueCursor, numItems: 2 });
        const globalNext = await global
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .paginate({ cursor: globalPage.continueCursor, numItems: 2 });

        expect(idsOf(globalNext.page)).toStrictEqual(idsOf(shardNext.page));
    });

    it("agrees after updates and deletes", async () => {
        expect.assertions(1);

        const { global, shard } = await seedBoth();

        await shard.patch("a", { body: "totally rewritten" });
        await global.patch("a", { body: "totally rewritten" });
        await shard.delete("b");
        await global.delete("b");

        const shardResults = await shard
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .collect();
        const globalResults = await global
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .collect();

        expect(idsOf(globalResults)).toStrictEqual(idsOf(shardResults));
    });

    it("agrees on a tie, which is what the id tiebreak exists for", async () => {
        expect.assertions(2);

        const { global, shard } = await seedBoth();

        // "hello world" scores identically for a, d and g (case-folded), and the
        // corpus gives them distinct creation times — so the order is fully
        // determined and both engines must produce it.
        const shardResults = await shard
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello world"))
            .collect();
        const globalResults = await global
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello world"))
            .collect();

        expect(idsOf(globalResults)).toStrictEqual(idsOf(shardResults));
        expect(idsOf(shardResults).length).toBeGreaterThan(1);
    });
});
