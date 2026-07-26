import { describe, expect, it } from "vitest";

import { createSearchAnalyzer, SEARCH_LANGUAGES } from "../src/search-analyzer";

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

        it("keeps non-Latin scripts intact", () => {
            expect.assertions(2);

            const analyzer = createSearchAnalyzer(undefined);

            expect(analyzer.document("東京 タワー")).toStrictEqual(["東京", "タワー"]);
            expect(analyzer.document("Привет мир")).toStrictEqual(["привет", "мир"]);
        });

        it("does not fold ß, which has no combining decomposition", () => {
            expect.assertions(1);

            // Documented limitation rather than an accident: collapsing ß→ss
            // needs a case-folding table the analyzer deliberately doesn't ship.
            expect(createSearchAnalyzer("de").document("Straße")).toStrictEqual(["straße"]);
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
