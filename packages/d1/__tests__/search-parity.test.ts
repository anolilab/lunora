import { DatabaseSync } from "node:sqlite";

import type { DatabaseWriterLike, SchemaLike, SqlCursor, SqlExec, ValidatorLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import type { SqlDialect } from "@lunora/sql-store";
import { createSqlCtxDb } from "@lunora/sql-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createD1CtxDb as createD1ContextDatabase } from "../src/d1-ctx-db";
import sqliteDialect from "../src/sqlite-dialect";
import { createD1Exec, FTS5_IN_BUILD } from "./_helpers/node-sqlite-d1";

/**
 * The parity gate.
 *
 * `.searchIndex()` promises one thing above all: the same corpus and the same
 * query return the same documents, in the same order, whichever backend stores
 * them. The two implementations share only the primitives in `search-text` /
 * `search-query` —
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
    // n and o exist to separate two *scores* that a naive engine would tie.
    // Both match `"javascript java"`; they only order correctly if a stored
    // token that satisfies two query terms is counted once for each.
    { body: "javascript javadoc javadoc javadoc", channel: "general", id: "n" },
    { body: "javascript javascript javascript", channel: "general", id: "o" },
];

/**
 * The SQLite dialect with fts5 declared unavailable — the portable
 * `(token, id, occurrences)` layout Postgres and MySQL use. Saying so through
 * the dialect is the honest lever: the engine's capability is what selects the
 * layout, and this Node build happens to ship fts5.
 */
const invertedDialect: SqlDialect = { ...sqliteDialect, supportsFts5: false };

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

    globalHarness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "body" TEXT, "channel" TEXT)`);

    const global = createD1ContextDatabase({ clock: clockFrom(), exec: globalHarness.exec, schema: globalSchema });

    invertedHarness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "body" TEXT, "channel" TEXT)`);

    const inverted = createSqlCtxDb({ clock: clockFrom(), dialect: invertedDialect, exec: invertedHarness.exec, schema: globalSchema });

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

// All three engines have to be standable-up for a three-way comparison, and one
// of them is the FTS5 shadow — which needs the module actually present in this
// Node build (22.14 has none; 22.23 and 24 do). Where it isn't, there is no
// meaningful parity gate to run, so it is skipped rather than quietly narrowed
// to two engines under the same name. CI runs it on the Node that has it.
describe.skipIf(!FTS5_IN_BUILD)("search parity — sharded DO vs .global()", () => {
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

    /**
     * `expectedIds` is what makes this a parity gate rather than a
     * they-agree-on-something gate: three engines can agree and all three be
     * wrong. The ids are derived from the corpus by hand under the documented
     * rules — AND over terms, the final term prefix-matching, score = summed
     * occurrences, ties broken by `_creationTime DESC` (later insert first) then
     * `id ASC` — so a change in ranking has to be argued for here, not absorbed.
     */
    const cases: { expectedIds: string[]; name: string; term: string }[] = [
        // b/h carry "hello" twice; the rest score 1 and fall back to the tiebreak.
        { expectedIds: ["h", "b", "i", "g", "d", "a"], name: "single term", term: "hello" },
        { expectedIds: ["h", "b", "i", "g", "d", "a"], name: "two terms, AND semantics", term: "hello world" },
        // "wor" prefix-matches "world" and "worldwide", but not "wonderful".
        { expectedIds: ["h", "b", "i", "g", "d", "a"], name: "prefix on the final term", term: "hello wor" },
        // "java" prefix-matches the same token "javascript" already matched
        // exactly — both terms are satisfied, so none of these may be dropped.
        // The *order* is the point. o holds `javascript` three times, so the
        // exact term counts 3 and the prefix term counts those same three
        // tokens again: 6. n scores 1 + 4 = 5, e scores 1 + 1 = 2. An engine
        // that counted each stored row once no matter how many terms it
        // satisfied would score o as 3 and n as 4 and invert the top two.
        { expectedIds: ["o", "n", "e"], name: "prefix shadowed by an earlier exact term", term: "javascript java" },
        // A bare prefix term: n and o rank on how many tokens extend it, then
        // f's whole word and e's prefix tie at one and fall to the tiebreak.
        { expectedIds: ["n", "o", "f", "e"], name: "prefix that is also a whole word", term: "java" },
        // The query side de-duplicates, so this is the single-term query.
        { expectedIds: ["h", "b", "i", "g", "d", "a"], name: "repeated term", term: "hello hello" },
        { expectedIds: [], name: "term matching nothing", term: "nonexistent" },
        { expectedIds: ["h", "b", "i", "g", "d", "a"], name: "mixed case query", term: "HeLLo WoRLd" },
        { expectedIds: ["h", "b", "i", "g", "d", "a"], name: "punctuation in the query", term: "hello, world!" },
        // No terms means no match, never "match everything".
        { expectedIds: [], name: "empty query", term: "" },
        { expectedIds: [], name: "whitespace-only query", term: "   " },
        { expectedIds: [], name: "punctuation-only query", term: "!!!" },
        // Folding is what makes these two find each other on every engine.
        { expectedIds: ["l", "k"], name: "accented query against unaccented text", term: "café" },
        { expectedIds: ["l", "k"], name: "unaccented query against accented text", term: "cafe" },
        { expectedIds: ["m"], name: "mixed diacritics", term: "unicode" },
    ];

    it.each(cases)("agrees on $name", async (searchCase) => {
        expect.assertions(3);

        const { global, inverted, shard } = await seedBoth();
        const run = async (writer: DatabaseWriterLike): Promise<unknown[]> =>
            idsOf(
                await writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", searchCase.term))
                    .collect(),
            );

        await expect(run(shard)).resolves.toStrictEqual(searchCase.expectedIds);
        await expect(run(global)).resolves.toStrictEqual(searchCase.expectedIds);
        // The third engine is the one that matters most here: it ranks with a
        // different mechanism than fts5, so a divergence shows up only when the
        // inverted layout is in the comparison.
        await expect(run(inverted)).resolves.toStrictEqual(searchCase.expectedIds);
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

    /**
     * The case that used to be impossible to hold, and is now structural.
     *
     * FTS5 orders by bm25, which penalises document length and common terms;
     * the contract orders by summed occurrences. While the FTS5 backends
     * selected a bm25 window and re-ranked it in memory, the documents the
     * contract ranks highest could sit outside that window entirely — so a
     * `.take(3)` over a corpus with more matches than the window holds returned
     * three arbitrary rows, and the two FTS5 backends did not even agree with
     * each other. All three score in SQL now, so the top-N is exact everywhere.
     */
    it("agrees on the top-N of a corpus larger than the scan cap", async () => {
        expect.assertions(3);

        const { global, inverted, shard } = await seedBoth();

        // Deliberately adversarial for bm25: three long documents that repeat
        // the needle, buried among far more short ones that mention it once.
        // Length normalisation ranks the short ones first, so a bm25-selected
        // window is exactly the wrong 1024 rows.
        const filler = Array.from({ length: 400 }, (_, index) => `filler${String(index)}`).join(" ");

        for (let index = 0; index < 1100; index += 1) {
            const body = index < 3 ? `${"needle ".repeat(20)}${filler}` : `needle short${String(index)}`;
            const row = { _id: `n${String(index).padStart(5, "0")}`, body, channel: "general" };

            // eslint-disable-next-line no-await-in-loop -- deterministic creation times require sequential inserts
            await shard.insert("docs", row, { allowExplicitId: true });
            // eslint-disable-next-line no-await-in-loop -- same, on the fts5 global twin
            await global.insert("docs", row, { allowExplicitId: true });
            // eslint-disable-next-line no-await-in-loop -- and on the inverted layout
            await inverted.insert("docs", row, { allowExplicitId: true });
        }

        const top = async (writer: DatabaseWriterLike): Promise<unknown[]> =>
            idsOf(
                await writer
                    .query("docs")
                    .withSearchIndex("by_body", (q) => q.search("body", "needle"))
                    .take(3),
            );

        // The three heavy documents, newest first — 20 occurrences each beats
        // every one-occurrence document regardless of length.
        const expected = ["n00002", "n00001", "n00000"];

        await expect(top(shard)).resolves.toStrictEqual(expected);
        await expect(top(global)).resolves.toStrictEqual(expected);
        await expect(top(inverted)).resolves.toStrictEqual(expected);
        // Seeding 1100 documents into three engines is the cost of a corpus
        // that actually exceeds the cap; the default 5s budget is not enough
        // for it when the suite runs alongside the rest of the repo.
    }, 30_000);

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
            globalHarness.ddl(`CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "body" TEXT, "channel" TEXT)`);
            invertedHarness.ddl(
                `CREATE TABLE "docs" ("id" TEXT PRIMARY KEY, "_creationTime" INTEGER NOT NULL, "_version" INTEGER, "body" TEXT, "channel" TEXT)`,
            );

            const shard = createShardContextDatabase({ schema: englishDoSchema, sql });
            const global = createD1ContextDatabase({ exec: globalHarness.exec, schema: englishGlobalSchema });
            const inverted = createSqlCtxDb({ dialect: invertedDialect, exec: invertedHarness.exec, schema: englishGlobalSchema });

            expect(refuses(shard, term)).toBe(expected);
            expect(refuses(global, term)).toBe(expected);
            expect(refuses(inverted, term)).toBe(expected);
        });
    });
});
