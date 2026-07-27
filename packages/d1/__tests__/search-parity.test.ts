import { DatabaseSync } from "node:sqlite";

import type { DatabaseWriterLike, SchemaLike, SqlCursor, SqlExec, ValidatorLike } from "@lunora/do";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/do";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { D1Exec } from "../src/d1-ctx-db";
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
let invertedHarness: ReturnType<typeof createD1Exec>;

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

/**
 * Force the portable inverted companion by failing the fts5 probe. Without this
 * every harness here runs on fts5 (this Node build ships it), so the comparison
 * would be fts5-against-fts5 and would never exercise the layout Postgres and
 * MySQL actually use.
 */
const withoutFts5 = (inner: D1Exec): D1Exec => {
    return {
        all: (sql, parameters) => inner.all(sql, parameters),
        run: (sql, parameters) =>
            sql.includes("__lunora_fts_probe") && sql.includes("CREATE") ? Promise.reject(new Error("fts5 unavailable (forced)")) : inner.run(sql, parameters),
    };
};

/** Seed all three engines with the identical corpus, on the identical clock. */
const seedBoth = async (): Promise<{ global: DatabaseWriterLike; inverted: DatabaseWriterLike; shard: DatabaseWriterLike }> => {
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

    invertedHarness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT)`);

    const inverted = createD1ContextDatabase({ clock: clockFrom(), exec: withoutFts5(invertedHarness.exec), schema: globalSchema });

    for (const document of CORPUS) {
        const row = { _id: document.id, body: document.body, channel: document.channel };

        // eslint-disable-next-line no-await-in-loop -- deterministic creation times require sequential inserts
        await shard.insert("docs", row, { allowExplicitId: true });
        // eslint-disable-next-line no-await-in-loop -- same, on the fts5 global twin
        await global.insert("docs", row, { allowExplicitId: true });
        // eslint-disable-next-line no-await-in-loop -- and on the inverted (Postgres/MySQL) layout
        await inverted.insert("docs", row, { allowExplicitId: true });
    }

    return { global, inverted, shard };
};

const idsOf = (documents: Record<string, unknown>[]): unknown[] => documents.map((document) => document["_id"]);

describe("search parity — sharded DO vs .global()", () => {
    beforeEach(() => {
        doHarness = new DatabaseSync(":memory:");
        globalHarness = createD1Exec();
        invertedHarness = createD1Exec();
    });

    afterEach(() => {
        doHarness.close();
        globalHarness.close();
        invertedHarness.close();
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
        expect.assertions(2);

        const { global, inverted, shard } = await seedBoth();
        const run = async (writer: DatabaseWriterLike): Promise<unknown[]> =>
            idsOf(
                await writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", searchCase.term))
                    .collect(),
            );

        const shardResults = await run(shard);

        await expect(run(global)).resolves.toStrictEqual(shardResults);
        // The third engine is the one that matters most here: it ranks with a
        // different mechanism than fts5, so a divergence shows up only when the
        // inverted layout is in the comparison.
        await expect(run(inverted)).resolves.toStrictEqual(shardResults);
    });

    it("folds accents identically on every backend", async () => {
        expect.assertions(3);

        const { global, inverted, shard } = await seedBoth();
        const sorted = async (writer: DatabaseWriterLike, term: string): Promise<unknown[]> =>
            idsOf(
                await writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", term))
                    .collect(),
            ).toSorted((left, right) => String(left).localeCompare(String(right)));

        // Both spellings must find both documents on all three engines — the
        // case that used to depend on which collation happened to be underneath.
        await expect(sorted(shard, "café")).resolves.toStrictEqual(["k", "l"]);
        await expect(sorted(global, "cafe")).resolves.toStrictEqual(["k", "l"]);
        await expect(sorted(inverted, "cafe")).resolves.toStrictEqual(["k", "l"]);
    });

    it("agrees when an .eq() filter narrows the match", async () => {
        expect.assertions(3);

        const { global, inverted, shard } = await seedBoth();
        const run = async (writer: DatabaseWriterLike): Promise<unknown[]> =>
            idsOf(
                await writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "hello").eq("channel", "other"))
                    .collect(),
            );

        // The filter narrows differently per layout — a WHERE on the joined doc
        // table for fts5, the same but past a GROUP BY for the inverted one.
        await expect(run(shard)).resolves.toStrictEqual(["d"]);
        await expect(run(global)).resolves.toStrictEqual(["d"]);
        await expect(run(inverted)).resolves.toStrictEqual(["d"]);
    });

    it("agrees on the page boundary, including the cursor sequence", async () => {
        expect.assertions(5);

        const { global, inverted, shard } = await seedBoth();

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

        // The inverted layout pages over a different query shape (offset into a
        // GROUP BY result), so it gets the same walk rather than an assumption.
        const invertedPage = await inverted
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .paginate({ numItems: 2 });
        const invertedNext = await inverted
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello"))
            .paginate({ cursor: invertedPage.continueCursor, numItems: 2 });

        expect(idsOf(invertedPage.page)).toStrictEqual(idsOf(shardPage.page));
        expect(idsOf(invertedNext.page)).toStrictEqual(idsOf(shardNext.page));
    });

    it("agrees after updates and deletes", async () => {
        expect.assertions(2);

        const { global, inverted, shard } = await seedBoth();

        for (const writer of [shard, global, inverted]) {
            // eslint-disable-next-line no-await-in-loop -- the three engines must see the same writes in the same order
            await writer.patch("a", { body: "totally rewritten" });
            // eslint-disable-next-line no-await-in-loop -- same
            await writer.delete("b");
        }

        const run = async (writer: DatabaseWriterLike): Promise<unknown[]> =>
            idsOf(
                await writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                    .collect(),
            );
        const shardResults = await run(shard);

        await expect(run(global)).resolves.toStrictEqual(shardResults);
        // Delete-then-insert on the inverted layout touches N token rows rather
        // than one shadow row, which is where a stale-row bug would show.
        await expect(run(inverted)).resolves.toStrictEqual(shardResults);
    });

    it("agrees on a tie, which is what the id tiebreak exists for", async () => {
        expect.assertions(3);

        const { global, inverted, shard } = await seedBoth();

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

        const invertedResults = await inverted
            .query("docs")
            .withSearchIndex("by_body", (q) => q.search("body", "hello world"))
            .collect();

        expect(idsOf(globalResults)).toStrictEqual(idsOf(shardResults));
        expect(idsOf(invertedResults)).toStrictEqual(idsOf(shardResults));
        expect(idsOf(shardResults).length).toBeGreaterThan(1);
    });

    it("agrees on bounded reads, where a limit decides which rows survive", async () => {
        expect.assertions(10);

        const { global, inverted, shard } = await seedBoth();
        const take = async (writer: DatabaseWriterLike, n: number): Promise<unknown[]> =>
            idsOf(
                await writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "hello"))
                    .take(n),
            );

        // The case a `.collect()` comparison cannot see: on fts5 the engine's
        // own ranking decides which rows come back before the shared scorer
        // re-ranks them, so a narrow `.take(n)` used to return a *different set*
        // of documents than the portable layout — not merely a different order.
        for (const n of [1, 2, 3, 4, 5]) {
            // eslint-disable-next-line no-await-in-loop -- each bound is a separate read against all three engines
            const expected = await take(shard, n);

            // eslint-disable-next-line no-await-in-loop -- same
            await expect(take(global, n)).resolves.toStrictEqual(expected);
            // eslint-disable-next-line no-await-in-loop -- same
            await expect(take(inverted, n)).resolves.toStrictEqual(expected);
        }
    });

    describe("query-surface limits", () => {
        // Declares a language, so analysis *changes the term count* — which is
        // the whole point: the cap counts analyzed terms, and a backend that
        // counted raw ones would accept a query the other refuses.
        const englishDoSchema: SchemaLike = {
            tables: {
                docs: {
                    ...doSchema.tables["docs"]!,
                    searchIndexes: [{ field: "body", filterFields: ["channel"], language: "en", name: "by_body" }],
                },
            },
        };
        const englishGlobalSchema: SchemaLike = {
            tables: {
                docs: {
                    ...globalSchema.tables["docs"]!,
                    searchIndexes: [{ field: "body", filterFields: ["channel"], language: "en", name: "by_body" }],
                },
            },
        };

        const refuses = (writer: DatabaseWriterLike, term: string): boolean => {
            try {
                writer.query("docs").withSearchIndex("by_body", (q) => q.search("body", term));

                return false;
            } catch {
                return true;
            }
        };

        it.each([
            // 17 content words: over the cap under any analysis.
            { expected: true, name: "a query over the cap under any analysis", term: Array.from({ length: 17 }, (_, index) => `t${String(index)}`).join(" ") },
            // 19 raw words, 16 once English stopwords are dropped. Counting raw
            // terms refuses this; counting analyzed terms accepts it — and the
            // two backends must not disagree about which.
            {
                expected: false,
                name: "a query only the analyzer brings under the cap",
                term: `the and of ${Array.from({ length: 16 }, (_, index) => `t${String(index)}`).join(" ")}`,
            },
        ])("agrees on $name", async ({ expected, term }) => {
            expect.assertions(3);

            const sql = shardExec(doHarness);

            runShardMigrations(sql, englishDoSchema);
            globalHarness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT)`);
            invertedHarness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "body" TEXT, "channel" TEXT)`);

            const shard = createShardContextDatabase({ schema: englishDoSchema, sql });
            const global = createD1ContextDatabase({ exec: globalHarness.exec, schema: englishGlobalSchema });
            const inverted = createD1ContextDatabase({ exec: withoutFts5(invertedHarness.exec), schema: englishGlobalSchema });

            expect(refuses(shard, term)).toBe(expected);
            expect(refuses(global, term)).toBe(expected);
            expect(refuses(inverted, term)).toBe(expected);
        });
    });
});
