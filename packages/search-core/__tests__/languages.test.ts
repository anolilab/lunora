import { describe, expect, it } from "vitest";

import { isSearchLanguage, isSearchStrategy, SEARCH_LANGUAGES, SEARCH_STRATEGIES } from "../src/languages";

describe("search languages and strategies", () => {
    it("accepts every declared language and strategy and nothing else", () => {
        expect.assertions(4);

        expect(SEARCH_LANGUAGES.every((language) => isSearchLanguage(language))).toBe(true);
        expect(SEARCH_STRATEGIES.every((strategy) => isSearchStrategy(strategy))).toBe(true);
        expect(isSearchLanguage("xx")).toBe(false);
        expect(isSearchStrategy("hybrid")).toBe(false);
    });

    it("keeps the language list sorted so the docs table and the validator error read the same way", () => {
        expect.assertions(1);

        expect([...SEARCH_LANGUAGES]).toStrictEqual([...SEARCH_LANGUAGES].toSorted((left, right) => left.localeCompare(right, "en")));
    });
});
