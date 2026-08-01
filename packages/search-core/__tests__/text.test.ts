import { describe, expect, it } from "vitest";

import { createSearchAnalyzer } from "../src/analyzer";
import {
    analyzedSearchText,
    countSearchTokens,
    FTS_COUNT_COLUMN,
    FTS_ID_COLUMN,
    FTS_TEXT_COLUMN,
    FTS_TOKEN_COLUMN,
    ftsTableName,
    MAX_INDEXED_TOKENS,
    resolveSearchField,
    searchTextUnchanged,
    splitSearchTokens,
    stringifySearchText,
} from "../src/text";

/**
 * The indexing side of `.searchIndex()`: what gets written into a companion
 * table, and whether a write can skip re-indexing entirely. Frozen into stored
 * indexes, so these pin the current, load-bearing behaviour.
 */

describe(ftsTableName, () => {
    it("namespaces the companion table under the reserved __fts_ infix", () => {
        expect.assertions(1);

        expect(ftsTableName("messages", "by_body")).toBe("messages__fts_by_body");
    });
});

describe("companion column names", () => {
    it("stay stable, since they are load-bearing schema identifiers", () => {
        expect.assertions(4);

        expect(FTS_TEXT_COLUMN).toBe("__text__");
        expect(FTS_ID_COLUMN).toBe("__id__");
        expect(FTS_TOKEN_COLUMN).toBe("__token__");
        expect(FTS_COUNT_COLUMN).toBe("__n__");
    });
});

describe(resolveSearchField, () => {
    it("reads a top-level field directly", () => {
        expect.assertions(1);

        expect(resolveSearchField({ title: "hello" }, "title")).toBe("hello");
    });

    it("resolves a dot-separated nested path", () => {
        expect.assertions(1);

        expect(resolveSearchField({ properties: { name: "Ada" } }, "properties.name")).toBe("Ada");
    });

    it("returns undefined for a missing segment", () => {
        expect.assertions(1);

        expect(resolveSearchField({ properties: {} }, "properties.name")).toBeUndefined();
    });

    it("returns undefined when a path segment is not an object", () => {
        expect.assertions(1);

        expect(resolveSearchField({ properties: "not an object" }, "properties.name")).toBeUndefined();
    });

    it("returns undefined when a path segment is an array", () => {
        expect.assertions(1);

        expect(resolveSearchField({ properties: ["a", "b"] }, "properties.name")).toBeUndefined();
    });
});

describe(stringifySearchText, () => {
    it("passes a string value through unchanged", () => {
        expect.assertions(1);

        expect(stringifySearchText("hello")).toBe("hello");
    });

    it("coerces null and undefined to the empty string", () => {
        expect.assertions(2);

        expect(stringifySearchText(null)).toBe("");
        expect(stringifySearchText(undefined)).toBe("");
    });

    it("stringifies numbers, bigints and booleans with String()", () => {
        expect.assertions(3);

        expect(stringifySearchText(42)).toBe("42");
        expect(stringifySearchText(10n)).toBe("10");
        expect(stringifySearchText(true)).toBe("true");
    });

    it("serializes objects and arrays as JSON instead of yielding [object Object]", () => {
        expect.assertions(2);

        expect(stringifySearchText({ a: 1 })).toBe('{"a":1}');
        expect(stringifySearchText([1, 2, 3])).toBe("[1,2,3]");
    });
});

describe(searchTextUnchanged, () => {
    const index = { field: "title" };

    it("is true when the indexed field's value is identical across the write", () => {
        expect.assertions(1);

        expect(searchTextUnchanged({ title: "same" }, { title: "same" }, index)).toBe(true);
    });

    it("is false when the indexed field's value differs", () => {
        expect.assertions(1);

        expect(searchTextUnchanged({ title: "old" }, { title: "new" }, index)).toBe(false);
    });

    it("is false on an insert (no previous document)", () => {
        expect.assertions(1);

        expect(searchTextUnchanged(undefined, { title: "new" }, index)).toBe(false);
    });

    it("is false on a delete (no next document)", () => {
        expect.assertions(1);

        expect(searchTextUnchanged({ title: "old" }, undefined, index)).toBe(false);
    });

    it("is false when the indexed field itself is a re-created but deep-equal object, the safe direction to be wrong in", () => {
        expect.assertions(1);

        // The indexed field resolves to the object itself (not a leaf
        // primitive), so a fresh-but-equal object compares unequal under ===
        // and the write is treated as changed rather than skipped.
        const objectFieldIndex = { field: "properties" };

        expect(searchTextUnchanged({ properties: { name: "Ada" } }, { properties: { name: "Ada" } }, objectFieldIndex)).toBe(false);
    });
});

describe(splitSearchTokens, () => {
    it("delegates to the analyzer's document-side tokenizer, keeping repeats", () => {
        expect.assertions(1);

        expect(splitSearchTokens("cat cat dog", createSearchAnalyzer(undefined))).toStrictEqual(["cat", "cat", "dog"]);
    });
});

describe(analyzedSearchText, () => {
    it("joins the analyzed tokens with a single space", () => {
        expect.assertions(1);

        expect(analyzedSearchText({ title: "The Quick Brown Fox" }, { field: "title", language: "en" })).toBe("quick brown fox");
    });

    it("caps the stored text at MAX_INDEXED_TOKENS tokens", () => {
        expect.assertions(1);

        const words = Array.from({ length: MAX_INDEXED_TOKENS + 10 }, (_unused, index) => `word${String(index)}`);

        expect(analyzedSearchText({ body: words.join(" ") }, { field: "body" }).split(" ")).toHaveLength(MAX_INDEXED_TOKENS);
    });

    it("resolves a nested field path before analyzing", () => {
        expect.assertions(1);

        expect(analyzedSearchText({ properties: { name: "Café" } }, { field: "properties.name" })).toBe("cafe");
    });

    it("indexes an empty string for a document that doesn't carry the field", () => {
        expect.assertions(1);

        expect(analyzedSearchText({}, { field: "title" })).toBe("");
    });
});

describe(countSearchTokens, () => {
    it("tallies occurrences per distinct token", () => {
        expect.assertions(1);

        const analyzer = createSearchAnalyzer(undefined);

        expect(countSearchTokens("cat cat dog", analyzer)).toStrictEqual(
            new Map([
                ["cat", 2],
                ["dog", 1],
            ]),
        );
    });

    it("returns an empty map for text with nothing to index", () => {
        expect.assertions(1);

        expect(countSearchTokens("", createSearchAnalyzer(undefined))).toStrictEqual(new Map());
    });
});
