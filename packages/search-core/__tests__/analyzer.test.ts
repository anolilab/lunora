import { describe, expect, it } from "vitest";

import { createSearchAnalyzer, MAX_TOKEN_LENGTH } from "../src/analyzer";
import { planSearchBackfillPass } from "../src/backfill";
import { SEARCH_LANGUAGES } from "../src/languages";

/**
 * Analysis is the one part of search that is *stored*, so these assertions are
 * effectively a format: changing them invalidates every index built under the
 * old behaviour, which is why the analyzer carries a version in its profile.
 */

describe("search analyzer", () => {
    describe("folding", () => {
        it("folds accents so an unaccented query finds accented text", () => {
            expect.assertions(2);

            const analyzer = createSearchAnalyzer(undefined);

            // The reason folding exists: without it MySQL matches these (its
            // default collation folds), Postgres doesn't (it compares bytes),
            // and FTS5 does (its tokenizer strips marks) — three backends, three
            // answers, from one corpus.
            expect(analyzer.document("café")).toStrictEqual(["cafe"]);
            expect(analyzer.query("CAFÉ")).toStrictEqual(["cafe"]);
        });

        it("folds a decomposed and a precomposed form to the same token", () => {
            expect.assertions(1);

            const analyzer = createSearchAnalyzer(undefined);
            const precomposed = "é";
            const decomposed = "é";

            expect(analyzer.document(precomposed)).toStrictEqual(analyzer.document(decomposed));
        });

        it("leaves non-Latin scripts intact, including marks that carry meaning", () => {
            expect.assertions(4);

            const analyzer = createSearchAnalyzer(undefined);

            expect(analyzer.document("東京 タワー")).toStrictEqual(["東京", "タワー"]);
            expect(analyzer.document("Привет мир")).toStrictEqual(["привет", "мир"]);
            // Japanese voiced sound marks are combining marks, but stripping
            // them merges distinct words — `が`/`か`, `パ`/`ハ`.
            expect(analyzer.document("がか パハ")).toStrictEqual(["がか", "パハ"]);
            // Hangul syllables decompose to jamo; the recompose puts them back.
            expect(analyzer.document("한국어")).toStrictEqual(["한국어"]);
        });

        it("does not fold ß, which has no combining decomposition", () => {
            expect.assertions(1);

            // Documented limitation rather than an accident: collapsing ß→ss
            // needs a case-folding table the analyzer deliberately doesn't ship.
            expect(createSearchAnalyzer("de").document("Straße")).toStrictEqual(["straße"]);
        });
    });

    describe("token length", () => {
        it("drops a token too long for the companion's key column", () => {
            expect.assertions(2);

            const analyzer = createSearchAnalyzer(undefined);
            const long = "a".repeat(MAX_TOKEN_LENGTH + 1);

            // Not a recall trade — a run this long is a hash or a base64 blob,
            // never a word. Keeping it fails the companion INSERT on MySQL
            // (`VARCHAR(768)`) and the btree insert on Postgres, which fails the
            // user's whole mutation rather than degrading their search.
            expect(analyzer.document(`hello ${long} world`)).toStrictEqual(["hello", "world"]);
            // Dropped on both sides, so the two agree about what is unindexable
            // instead of the query looking for something no document can hold.
            expect(analyzer.query(long)).toStrictEqual([]);
        });

        it("keeps a token exactly at the limit", () => {
            expect.assertions(1);

            const token = "a".repeat(MAX_TOKEN_LENGTH);

            expect(createSearchAnalyzer(undefined).document(token)).toStrictEqual([token]);
        });
    });

    describe("stopwords", () => {
        it("drops function words from documents and queries alike", () => {
            expect.assertions(2);

            const analyzer = createSearchAnalyzer("en");

            expect(analyzer.document("the quick brown fox")).toStrictEqual(["quick", "brown", "fox"]);
            expect(analyzer.query("the fox")).toStrictEqual(["fox"]);
        });

        it("keeps every word when no language is declared", () => {
            expect.assertions(1);

            expect(createSearchAnalyzer(undefined).document("the quick brown fox")).toStrictEqual(["the", "quick", "brown", "fox"]);
        });

        it("leaves a query of only stopwords with no terms to match", () => {
            expect.assertions(1);

            // Which the engines read as "no match" rather than "match everything".
            expect(createSearchAnalyzer("en").query("the and of")).toStrictEqual([]);
        });

        it("matches accented function words, which are folded like everything else", () => {
            expect.assertions(2);

            // The lists are written naturally (`für`, `même`); tokens arrive
            // folded, so the lists have to be folded too or these never match.
            expect(createSearchAnalyzer("de").document("für immer")).toStrictEqual(["immer"]);
            expect(createSearchAnalyzer("fr").document("même chose")).toStrictEqual(["chose"]);
        });

        it("applies the declared language's list, not English's", () => {
            expect.assertions(2);

            expect(createSearchAnalyzer("de").document("der schnelle fuchs")).toStrictEqual(["schnelle", "fuchs"]);
            // "der" is not a French function word, so French analysis keeps it.
            expect(createSearchAnalyzer("fr").document("der schnelle fuchs")).toStrictEqual(["der", "schnelle", "fuchs"]);
        });
    });

    describe("query tokens", () => {
        it("de-duplicates repeats, keeping the caller's final term final", () => {
            expect.assertions(2);

            const analyzer = createSearchAnalyzer(undefined);

            expect(analyzer.query("cat cat")).toStrictEqual(["cat"]);
            // The last term drives prefix matching, so a repeat must not steal
            // that position from the word the user is still typing.
            expect(analyzer.query("cat dog cat")).toStrictEqual(["dog", "cat"]);
        });

        it("keeps document repeats, because occurrences are the score", () => {
            expect.assertions(1);

            expect(createSearchAnalyzer(undefined).document("cat cat dog")).toStrictEqual(["cat", "cat", "dog"]);
        });
    });

    describe("profiles", () => {
        it("distinguishes languages, so a change is detectable", () => {
            expect.assertions(2);

            expect(createSearchAnalyzer("en").profile).not.toBe(createSearchAnalyzer("de").profile);
            expect(createSearchAnalyzer("en").profile).toBe(createSearchAnalyzer("en").profile);
        });

        it("treats an unknown language as folding-only rather than throwing on a read", () => {
            expect.assertions(1);

            // The schema builder rejects unknown languages up front; reaching
            // here means a hand-built schema, where degrading beats failing.
            expect(createSearchAnalyzer("klingon").profile).toBe(createSearchAnalyzer(undefined).profile);
        });

        it("exposes every language the schema builder accepts", () => {
            expect.assertions(1);

            expect([...SEARCH_LANGUAGES].toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
                "de",
                "en",
                "es",
                "fr",
                "it",
                "nl",
                "none",
                "pt",
            ]);
        });
    });
});

/**
 * The backfill's staleness policy. Pure, and shared by both engines — when each
 * owned a copy they disagreed about exactly the two cases below, so these lock
 * the decisions rather than either implementation.
 */
describe(planSearchBackfillPass, () => {
    it("starts a fresh index from the beginning without wiping anything", () => {
        expect.assertions(1);

        // Nothing recorded and nothing stored: a DELETE here would be a wasted
        // statement per index per deploy.
        expect(planSearchBackfillPass({ cursor: undefined, done: false, profile: undefined }, "en-v1")).toStrictEqual({
            cursor: undefined,
            finished: false,
            wipe: false,
        });
    });

    it("resumes from the recorded cursor under the same profile", () => {
        expect.assertions(1);

        expect(planSearchBackfillPass({ cursor: "d0042", done: false, profile: "en-v1" }, "en-v1")).toStrictEqual({
            cursor: "d0042",
            finished: false,
            wipe: false,
        });
    });

    it("reports finished only under the same profile", () => {
        expect.assertions(2);

        expect(planSearchBackfillPass({ cursor: "d9999", done: true, profile: "en-v1" }, "en-v1").finished).toBe(true);
        // A completed index whose analysis changed is not finished — it is stale.
        expect(planSearchBackfillPass({ cursor: "d9999", done: true, profile: "none-v1" }, "en-v1").finished).toBe(false);
    });

    it("wipes and restarts when the profile changed", () => {
        expect.assertions(1);

        expect(planSearchBackfillPass({ cursor: "d0042", done: false, profile: "none-v1" }, "en-v1")).toStrictEqual({
            cursor: undefined,
            finished: false,
            wipe: true,
        });
    });

    it("treats a row with no recorded profile as stale, not resumable", () => {
        expect.assertions(1);

        // Predates profile tracking: nothing says what analyzed those rows, so
        // resuming on top of them would leave the index half-analyzed forever.
        expect(planSearchBackfillPass({ cursor: "d0042", done: false, profile: undefined }, "none-v1")).toStrictEqual({
            cursor: undefined,
            finished: false,
            wipe: true,
        });
    });
});
