import { LunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { createSearchAnalyzer } from "../src/analyzer";
import type { SearchStageLike } from "../src/query";
import {
    assertSearchWithinCap,
    buildFtsMatch,
    createSearchBuilder,
    encodeSearchCursor,
    finishSearchPage,
    MAX_SEARCH_FILTERS,
    MAX_SEARCH_SCAN,
    MAX_SEARCH_TERMS,
    parseSearchCursor,
    planSearchPage,
    resolveSearchScan,
    scoreDocument,
    searchPageScan,
    searchTermRange,
} from "../src/query";

/**
 * The read side of `.searchIndex()`: caps, the builder's guards, ranking and the
 * paging algebra. Shared by every backend, so these pin the one behaviour both
 * engines must reproduce rather than either implementation.
 */

describe("caps", () => {
    it("matches Convex's documented limits", () => {
        expect.assertions(3);

        expect(MAX_SEARCH_TERMS).toBe(16);
        expect(MAX_SEARCH_FILTERS).toBe(8);
        expect(MAX_SEARCH_SCAN).toBe(1024);
    });
});

describe("search cursors", () => {
    it("round-trips an offset through encode/decode", () => {
        expect.assertions(3);

        expect(parseSearchCursor(encodeSearchCursor(0))).toBe(0);
        expect(parseSearchCursor(encodeSearchCursor(42))).toBe(42);
        expect(parseSearchCursor(encodeSearchCursor(MAX_SEARCH_SCAN))).toBe(MAX_SEARCH_SCAN);
    });

    it("reads a bare 'search:' prefix (no digits) as offset 0", () => {
        expect.assertions(1);

        // Number("") === 0, and 0 is a valid integer offset — so a cursor whose
        // numeric suffix is empty decodes to the start of the result window
        // rather than being rejected.
        const bareCursor = btoa("search:");

        expect(parseSearchCursor(bareCursor)).toBe(0);
    });

    it("rejects a cursor that isn't base64 at all", () => {
        expect.assertions(1);

        expect(parseSearchCursor("not valid base64!!")).toBeUndefined();
    });

    it("rejects a cursor with the wrong prefix", () => {
        expect.assertions(1);

        expect(parseSearchCursor(btoa("keyset:5"))).toBeUndefined();
    });

    it("rejects a negative or non-integer offset", () => {
        expect.assertions(2);

        expect(parseSearchCursor(btoa("search:-1"))).toBeUndefined();
        expect(parseSearchCursor(btoa("search:1.5"))).toBeUndefined();
    });
});

describe(finishSearchPage, () => {
    it("is terminal when numItems is 0, even with rows in the window", () => {
        expect.assertions(1);

        expect(finishSearchPage([{ id: 1 }, { id: 2 }, { id: 3 }], { numItems: 0, offset: 0 })).toStrictEqual({
            continueCursor: null,
            isDone: true,
            page: [],
        });
    });

    it("reports hasMore when the window holds a row past the page", () => {
        expect.assertions(1);

        const window = [{ id: 1 }, { id: 2 }, { id: 3 }];

        expect(finishSearchPage(window, { numItems: 2, offset: 0 })).toStrictEqual({
            continueCursor: encodeSearchCursor(2),
            isDone: false,
            page: [{ id: 1 }, { id: 2 }],
        });
    });

    it("is terminal when the window ends exactly at the page boundary", () => {
        expect.assertions(1);

        const window = [{ id: 1 }, { id: 2 }];

        expect(finishSearchPage(window, { numItems: 2, offset: 0 })).toStrictEqual({
            continueCursor: null,
            isDone: true,
            page: [{ id: 1 }, { id: 2 }],
        });
    });
});

describe(resolveSearchScan, () => {
    it("reads an absent limit as one past the cap, so a capped read is detectable", () => {
        expect.assertions(1);

        expect(resolveSearchScan(undefined)).toBe(MAX_SEARCH_SCAN + 1);
    });

    it("clamps a non-finite limit (Infinity) to the cap", () => {
        expect.assertions(1);

        expect(resolveSearchScan(Number.POSITIVE_INFINITY)).toBe(MAX_SEARCH_SCAN);
    });

    it("passes through a limit within the cap", () => {
        expect.assertions(1);

        expect(resolveSearchScan(10)).toBe(10);
    });

    it("throws rather than silently truncating a limit past the cap", () => {
        expect.assertions(1);

        expect(() => resolveSearchScan(MAX_SEARCH_SCAN + 1)).toThrow(LunoraError);
    });
});

describe(planSearchPage, () => {
    it("accepts a page that reaches exactly the cap", () => {
        expect.assertions(1);

        expect(planSearchPage({ cursor: null, numItems: MAX_SEARCH_SCAN })).toStrictEqual({
            numItems: MAX_SEARCH_SCAN,
            offset: 0,
        });
    });

    it("rejects a page that reaches one row past the cap", () => {
        expect.assertions(1);

        expect(() => planSearchPage({ cursor: null, numItems: MAX_SEARCH_SCAN + 1 })).toThrow(LunoraError);
    });

    it("rejects bounded (endCursor) pagination", () => {
        expect.assertions(1);

        expect(() => planSearchPage({ endCursor: "anything", numItems: 10 })).toThrow(LunoraError);
    });

    it("rejects an unparseable cursor", () => {
        expect.assertions(1);

        expect(() => planSearchPage({ cursor: "garbage", numItems: 10 })).toThrow(LunoraError);
    });

    it("resumes from a previously encoded offset", () => {
        expect.assertions(1);

        expect(planSearchPage({ cursor: encodeSearchCursor(500), numItems: 10 })).toStrictEqual({ numItems: 10, offset: 500 });
    });
});

describe(searchPageScan, () => {
    it("never scans past the cap even when offset + numItems + 1 would exceed it", () => {
        expect.assertions(1);

        expect(searchPageScan({ numItems: 10, offset: MAX_SEARCH_SCAN - 5 })).toBe(MAX_SEARCH_SCAN);
    });

    it("otherwise scans one row past the requested page, to detect hasMore", () => {
        expect.assertions(1);

        expect(searchPageScan({ numItems: 10, offset: 0 })).toBe(11);
    });
});

describe(assertSearchWithinCap, () => {
    it("passes silently at exactly the cap", () => {
        expect.assertions(1);

        expect(() => {
            assertSearchWithinCap(Array.from({ length: MAX_SEARCH_SCAN }));
        }).not.toThrow();
    });

    it("throws one row past the cap, rather than truncating", () => {
        expect.assertions(1);

        expect(() => {
            assertSearchWithinCap(Array.from({ length: MAX_SEARCH_SCAN + 1 }));
        }).toThrow(LunoraError);
    });
});

describe(searchTermRange, () => {
    it("returns an exact (non-prefix) range for a non-final term", () => {
        expect.assertions(1);

        expect(searchTermRange("cat", false)).toStrictEqual({ exact: true, lower: "cat", upper: "cat" });
    });

    it("returns a half-open range for the prefix-matching final term", () => {
        expect.assertions(1);

        expect(searchTermRange("cat", true)).toStrictEqual({ exact: false, lower: "cat", upper: "cau" });
    });

    it("increments the last *code point*, not the last UTF-16 code unit, for an astral-plane final token", () => {
        expect.assertions(1);

        // U+1F600 (😀, code point 128512) is a surrogate pair in UTF-16. A
        // range bound that incremented the trailing code unit in isolation
        // could produce an invalid lone surrogate; the codepoint-aware bound
        // instead lands on U+1F601 (😁, 128513), the very next code point,
        // keeping the range a valid string on both ends.
        const emojiCodePoint = 128_512;
        const token = `emoji${String.fromCodePoint(emojiCodePoint)}`;

        expect(searchTermRange(token, true)).toStrictEqual({
            exact: false,
            lower: token,
            upper: `emoji${String.fromCodePoint(emojiCodePoint + 1)}`,
        });
    });

    // Plan 272: `codePointAt(token.length - 1)` is a code-*unit* index, so for a
    // token ending in a surrogate pair it reads the lone low surrogate rather
    // than the character. The 😀 case above happens to produce the right
    // answer anyway (the low surrogate's increment stays inside the surrogate
    // block, so the pair re-forms by luck) — these cases pin the ones where
    // that luck runs out.

    it("increments the true last code point for U+10437 (𐐷, DESERET SMALL LETTER YEE) — a case where the code-unit bug happens to still land right", () => {
        expect.assertions(2);

        const codePoint = 0x1_04_37;
        const token = String.fromCodePoint(codePoint);
        const result = searchTermRange(token, true);

        expect(result).toStrictEqual({ exact: false, lower: token, upper: String.fromCodePoint(codePoint + 1) });
        // No lone surrogate anywhere in the bound — spreading a string iterates by
        // code point, so a well-formed trailing astral character spreads to
        // exactly one element (a lone surrogate would instead spread to one
        // element per unpaired UTF-16 unit only by coincidence of length, so this
        // is a coarse but sufficient smoke check alongside the exact-value assertion above).
        // eslint-disable-next-line @typescript-eslint/no-misused-spread -- intentional: code-point iteration is the property under test
        expect([...result.upper]).toHaveLength(1);
    });

    it('increments the true last code point when the astral character is not the whole token ("a𐐷")', () => {
        expect.assertions(1);

        const codePoint = 0x1_04_37;
        const token = `a${String.fromCodePoint(codePoint)}`;

        expect(searchTermRange(token, true)).toStrictEqual({ exact: false, lower: token, upper: `a${String.fromCodePoint(codePoint + 1)}` });
    });

    it("increments the true last code point for a token ending at the UTF-16 low-surrogate boundary (U+103FF → U+10400)", () => {
        expect.assertions(2);

        // U+103FF's UTF-16 low surrogate is 0xDFFF — the top of the low-surrogate
        // range. The CODE-UNIT bug reads that raw code unit via
        // `codePointAt(token.length - 1)` and increments it in isolation,
        // escaping the surrogate block entirely (0xE000, a real BMP character)
        // and stranding the high surrogate — producing an invalid lone
        // high-surrogate bound (`\uD800` followed by ``). Reading the
        // true *code point* instead (0x103FF) increments correctly to its
        // real successor, U+10400 — an ordinary astral code point, not a
        // surrogate-range value, so this is a normal widen, not a refusal.
        const codePoint = 0x1_03_ff;
        const token = String.fromCodePoint(codePoint);
        const result = searchTermRange(token, true);

        expect(result).toStrictEqual({ exact: false, lower: token, upper: String.fromCodePoint(codePoint + 1) });
        // No lone surrogate in the bound: spreading a well-formed string yields
        // one element per code point, so a single trailing astral character
        // spreads to exactly one element.
        // eslint-disable-next-line @typescript-eslint/no-misused-spread -- intentional: code-point iteration is the property under test
        expect([...result.upper]).toHaveLength(1);
    });

    it("refuses to widen (falls back to exact match) for a token ending at the Hangul block boundary (U+D7FF), whose successor is the surrogate block", () => {
        expect.assertions(1);

        const codePoint = 0xd7_ff;
        const token = `x${String.fromCodePoint(codePoint)}`;

        expect(searchTermRange(token, true)).toStrictEqual({ exact: true, lower: token, upper: token });
    });
});

describe(scoreDocument, () => {
    const analyzer = createSearchAnalyzer(undefined);

    it("sums occurrences across every AND'ed term when all are present", () => {
        expect.assertions(1);

        // "quick" is required exact and appears twice; "fo" is the final term
        // and prefix-matches "fox" once.
        const text = "quick fox jumps over the quick dog";

        expect(scoreDocument(text, ["quick", "fo"], analyzer)).toBe(3);
    });

    it("prefix-matches only the final term, not earlier ones", () => {
        expect.assertions(2);

        const text = "quick fox";

        // "qu" as a non-final term must match exactly, so it finds nothing.
        expect(scoreDocument(text, ["qu", "fox"], analyzer)).toBe(0);
        // The same "qu" as the final term prefix-matches "quick" (1) on top of
        // the exact match on "fox" (1).
        expect(scoreDocument(text, ["fox", "qu"], analyzer)).toBe(2);
    });

    it("returns 0 (AND semantics) when any required term is absent", () => {
        expect.assertions(1);

        const text = "quick brown fox";

        expect(scoreDocument(text, ["quick", "zzz"], analyzer)).toBe(0);
    });

    it("returns 0 for text that analyzes to no tokens", () => {
        expect.assertions(1);

        expect(scoreDocument("   ", ["anything"], analyzer)).toBe(0);
    });
});

describe(buildFtsMatch, () => {
    it("ands quoted terms together, with prefix matching only on the final term", () => {
        expect.assertions(1);

        expect(buildFtsMatch(["quick", "fo"])).toBe('"quick" AND "fo"*');
    });

    it("still applies the trailing prefix star to a single term", () => {
        expect.assertions(1);

        expect(buildFtsMatch(["quick"])).toBe('"quick"*');
    });
});

describe(createSearchBuilder, () => {
    const makeStage = (): SearchStageLike => {
        return {
            definition: { field: "text", filterFields: ["status"] },
            field: "text",
            filters: [],
            hasQuery: false,
            indexName: "by_text",
            query: "",
        };
    };

    it("stages a .search() call against the indexed field", () => {
        expect.assertions(1);

        const stage = makeStage();

        createSearchBuilder(stage, "messages", createSearchAnalyzer(undefined)).search("text", "hello world");

        expect(stage).toMatchObject({ field: "text", hasQuery: true, query: "hello world" });
    });

    it("rejects .search() against a field the index doesn't cover", () => {
        expect.assertions(1);

        const stage = makeStage();
        const builder = createSearchBuilder(stage, "messages", createSearchAnalyzer(undefined));

        expect(() => builder.search("other", "hello")).toThrow(LunoraError);
    });

    it("rejects .search() past the term cap", () => {
        expect.assertions(1);

        const stage = makeStage();
        const builder = createSearchBuilder(stage, "messages", createSearchAnalyzer(undefined));
        const tooManyTerms = Array.from({ length: MAX_SEARCH_TERMS + 1 }, (_unused, index) => `term${String(index)}`).join(" ");

        expect(() => builder.search("text", tooManyTerms)).toThrow(LunoraError);
    });

    it("stages a .eq() filter against a declared filter field", () => {
        expect.assertions(1);

        const stage = makeStage();

        createSearchBuilder(stage, "messages", createSearchAnalyzer(undefined)).eq("status", "open");

        expect(stage.filters).toStrictEqual([{ field: "status", value: "open" }]);
    });

    it("rejects .eq() against a field that isn't a declared filter field", () => {
        expect.assertions(1);

        const stage = makeStage();
        const builder = createSearchBuilder(stage, "messages", createSearchAnalyzer(undefined));

        expect(() => builder.eq("unknown", "value")).toThrow(LunoraError);
    });

    it("rejects .eq() past the filter cap", () => {
        expect.assertions(1);

        const stage: SearchStageLike = {
            definition: { field: "text", filterFields: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] },
            field: "text",
            filters: [],
            hasQuery: false,
            indexName: "by_text",
            query: "",
        };
        const builder = createSearchBuilder(stage, "messages", createSearchAnalyzer(undefined));

        for (const field of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
            builder.eq(field, 1);
        }

        expect(() => builder.eq("i", 1)).toThrow(LunoraError);
    });
});
