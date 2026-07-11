import { describe, expect, it } from "vitest";

import { toSearchResults } from "../src/agentic-memory";

describe(toSearchResults, () => {
    it("projects a RetrieveResult into ranked hits + sources, dropping the joined context", () => {
        const retrieved = {
            chunks: [
                { chunkIndex: 0, id: "doc-1#0", importance: 1, score: 0.9, sourceId: "doc-1", text: "short" },
                { chunkIndex: 1, id: "doc-1#1", importance: 1, score: 0.4, sourceId: "doc-1", text: "another" },
            ],
            context: "[source:doc-1#0]\nshort\n\n[source:doc-1#1]\nanother",
            sources: [{ id: "doc-1" }],
        };

        expect(toSearchResults(retrieved, 240)).toStrictEqual({
            results: [
                { id: "doc-1#0", score: 0.9, snippet: "short", sourceId: "doc-1" },
                { id: "doc-1#1", score: 0.4, snippet: "another", sourceId: "doc-1" },
            ],
            sources: [{ id: "doc-1" }],
        });
    });

    it("truncates a snippet to `snippetChars` with an ellipsis", () => {
        const retrieved = { chunks: [{ id: "d#0", score: 1, sourceId: "d", text: "abcdefghij" }], context: "", sources: [] };
        const projected = toSearchResults(retrieved, 4);

        expect(projected.results[0]?.snippet).toBe("abcd…");
    });

    it("degrades a mis-shaped source result to empty instead of throwing", () => {
        expect(toSearchResults(undefined, 240)).toStrictEqual({ results: [], sources: [] });
        expect(toSearchResults({ chunks: "nope", sources: 42 }, 240)).toStrictEqual({ results: [], sources: [] });
    });

    it("coerces missing/mistyped chunk fields to safe defaults", () => {
        const projected = toSearchResults({ chunks: [{}], sources: [] }, 240);

        expect(projected.results).toStrictEqual([{ id: "", score: 0, snippet: "", sourceId: "" }]);
    });
});
