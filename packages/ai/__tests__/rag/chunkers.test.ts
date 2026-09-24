import { describe, expect, it } from "vitest";

import { markdownChunker, sentenceChunker, tokenChunker } from "../../src/rag/chunkers";

/** Rough word-count tokenizer — deterministic, enough to drive the token budget in tests. */
const countWords = (text: string): number => text.split(/\s+/u).filter((word) => word.length > 0).length;

describe("sentenceChunker", () => {
    it("keeps sentences whole rather than cutting mid-clause", () => {
        expect.hasAssertions();

        const chunk = sentenceChunker({ overlap: 0, size: 60 });
        const chunks = chunk("The cat sat on the mat. The dog barked loudly. Birds flew away.");

        for (const piece of chunks) {
            expect(piece.endsWith(".")).toBe(true);
        }

        expect(chunks.join(" ")).toContain("The dog barked loudly.");
    });

    it("never exceeds `size`", () => {
        expect.hasAssertions();

        const chunk = sentenceChunker({ overlap: 10, size: 50 });
        const sentences = Array.from({ length: 30 }, (_, index) => `Sentence number ${String(index)} is here.`).join(" ");

        for (const piece of chunk(sentences)) {
            expect(piece.length).toBeLessThanOrEqual(50);
        }
    });

    it("hard-splits a single sentence that cannot fit", () => {
        expect.hasAssertions();

        const chunk = sentenceChunker({ overlap: 0, size: 20 });
        const chunks = chunk("x".repeat(95));

        expect(chunks.length).toBeGreaterThan(1);

        for (const piece of chunks) {
            expect(piece.length).toBeLessThanOrEqual(20);
        }
    });

    it("carries overlap onto a sentence boundary", () => {
        expect.hasAssertions();

        const chunk = sentenceChunker({ overlap: 16, size: 40 });
        const chunks = chunk("Alpha one here. Bravo two here. Charlie three here. Delta four here.");

        expect(chunks.length).toBeGreaterThan(1);

        // The carry is a strict suffix of the previous chunk, so each chunk
        // after the first re-opens with a whole sentence the previous one ended
        // on — assert the sharing rather than just the punctuation.
        const first = chunks[0] as string;
        const second = chunks[1] as string;

        expect(first.split(/(?<=[!.?])\s+/u).some((sentence) => second.startsWith(sentence))).toBe(true);
    });

    it("drops the overlap carry when it would leave no room for the next sentence", () => {
        expect.hasAssertions();

        // Uneven atoms: a window of [10, 10, 70] flushes, the carry covering an
        // overlap floor of 70 is the single 70-char sentence, and the incoming
        // 40-char sentence then cannot fit beside it (70 + 1 + 40 = 111 > 100).
        // The carry has to be dropped rather than emitted over budget.
        const chunk = sentenceChunker({ overlap: 70, size: 100 });
        const chunks = chunk([`${"a".repeat(9)}.`, `${"b".repeat(9)}.`, `${"c".repeat(69)}.`, `${"d".repeat(39)}.`].join(" "));

        expect(chunks.length).toBeGreaterThan(1);

        for (const piece of chunks) {
            expect(piece.length).toBeLessThanOrEqual(100);
        }
    });

    it("terminates instead of looping when overlap would re-emit the same window", () => {
        expect.hasAssertions();

        // One atom larger than the overlap floor: the carry must stay a strict
        // suffix, else the window never advances and this hangs.
        const chunk = sentenceChunker({ overlap: 90, size: 100 });
        const chunks = chunk(Array.from({ length: 12 }).fill("Some sentence of moderate length here.").join(" "));

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.length).toBeLessThan(100);
    });

    it("returns no chunks for blank input", () => {
        expect.hasAssertions();

        expect(sentenceChunker()("   \n  ")).toStrictEqual([]);
    });

    it("rejects an overlap that is not smaller than size", () => {
        expect.hasAssertions();

        expect(() => sentenceChunker({ overlap: 100, size: 100 })).toThrow(/`overlap` must be/u);
    });
});

describe("markdownChunker", () => {
    it("prefixes each chunk with its heading trail", () => {
        expect.hasAssertions();

        const chunk = markdownChunker({ overlap: 0, size: 200 });
        const chunks = chunk(["# Guide", "", "Intro prose here.", "", "## Auth", "", "### OAuth", "", "Use the OAuth flow."].join("\n"));

        const oauth = chunks.find((piece) => piece.includes("Use the OAuth flow."));

        expect(oauth).toBeDefined();
        expect(oauth).toContain("# Guide > ## Auth > ### OAuth");
    });

    it("truncates deeper levels when a sibling heading appears", () => {
        expect.hasAssertions();

        const chunk = markdownChunker({ overlap: 0, size: 200 });
        const chunks = chunk(["# Top", "", "## First", "", "### Deep", "", "deep body", "", "## Second", "", "second body"].join("\n"));

        const second = chunks.find((piece) => piece.includes("second body"));

        expect(second).toContain("# Top > ## Second");
        expect(second).not.toContain("Deep");
    });

    it("does not treat a `#` comment inside a code fence as a heading", () => {
        expect.hasAssertions();

        const chunk = markdownChunker({ overlap: 0, size: 400 });
        const chunks = chunk(["# Real", "", "```sh", "# not a heading", "echo hi", "```", "", "after the fence"].join("\n"));

        for (const piece of chunks) {
            expect(piece).not.toContain("> # not a heading");
        }

        expect(chunks.some((piece) => piece.includes("echo hi"))).toBe(true);
    });

    it("never exceeds `size`, prefix included", () => {
        expect.hasAssertions();

        const chunk = markdownChunker({ overlap: 20, size: 120 });
        const body = Array.from({ length: 20 }, (_, index) => `Body sentence ${String(index)} goes here.`).join(" ");
        const chunks = chunk(`# Heading One\n\n## Heading Two\n\n${body}`);

        for (const piece of chunks) {
            expect(piece.length).toBeLessThanOrEqual(120);
        }
    });

    it("drops the prefix rather than emit chunks that are all heading", () => {
        expect.hasAssertions();

        // A trail longer than the size budget leaves no room for prose.
        const chunk = markdownChunker({ overlap: 0, size: 40 });
        const chunks = chunk(`# ${"A".repeat(60)}\n\nShort body.`);

        expect(chunks.some((piece) => piece.includes("Short body."))).toBe(true);

        for (const piece of chunks) {
            expect(piece.length).toBeLessThanOrEqual(40);
        }
    });

    it("handles a document with no headings at all", () => {
        expect.hasAssertions();

        const chunk = markdownChunker({ overlap: 0, size: 100 });
        const chunks = chunk("Just prose. No headings anywhere. Still needs chunking.");

        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.join(" ")).toContain("Just prose.");
    });
});

describe("tokenChunker", () => {
    it("bounds chunks by the injected token count", () => {
        expect.hasAssertions();

        const chunk = tokenChunker({ countTokens: countWords, maxTokens: 8 });
        const chunks = chunk("One two three four. Five six seven eight. Nine ten eleven twelve.");

        for (const piece of chunks) {
            expect(countWords(piece)).toBeLessThanOrEqual(8);
        }
    });

    it("splits a single sentence that exceeds the budget", () => {
        expect.hasAssertions();

        const chunk = tokenChunker({ countTokens: countWords, maxTokens: 4 });
        const chunks = chunk(Array.from({ length: 20 }).fill("word").join(" "));

        expect(chunks.length).toBeGreaterThan(1);
    });

    // The character window is scaled by the atom's AVERAGE token density, so an
    // atom whose density is uneven — one very long token followed by many short
    // ones — used to emit pieces far over `maxTokens`, which is exactly the
    // silent truncation at the embedding model this chunker exists to prevent.
    it("keeps every piece of an unevenly dense oversized atom within maxTokens", () => {
        expect.hasAssertions();

        const chunk = tokenChunker({ countTokens: countWords, maxTokens: 26 });
        // 51 whitespace tokens, no sentence terminator: one 100-character word
        // followed by 50 one-character words.
        const atom = ["w".repeat(100), ...Array.from({ length: 50 }).fill("x")].join(" ");
        const chunks = chunk(atom);

        expect(chunks.length).toBeGreaterThan(1);

        for (const piece of chunks) {
            expect(countWords(piece)).toBeLessThanOrEqual(26);
        }
    });

    it("requires a token counter rather than guessing one", () => {
        expect.hasAssertions();

        // @ts-expect-error -- exercising the runtime guard for JS callers
        expect(() => tokenChunker({ maxTokens: 10 })).toThrow(/`countTokens` must be a function/u);
    });

    it("rejects an overlap that is not smaller than maxTokens", () => {
        expect.hasAssertions();

        expect(() => tokenChunker({ countTokens: countWords, maxTokens: 4, overlapTokens: 4 })).toThrow(/`overlapTokens` must be/u);
    });

    it("carries token overlap between chunks", () => {
        expect.hasAssertions();

        const chunk = tokenChunker({ countTokens: countWords, maxTokens: 8, overlapTokens: 3 });
        const chunks = chunk("Alpha one two. Bravo three four. Charlie five six. Delta seven eight.");

        expect(chunks.length).toBeGreaterThan(1);

        for (const piece of chunks) {
            expect(countWords(piece)).toBeLessThanOrEqual(11);
        }
    });
});
