import { describe, expect, it } from "vitest";

import { collectAgenticMemoryTools, toSearchResults } from "../src/agentic-memory";
import type { AgentMemoryOptions, AgentToolContext } from "../src/types";

/** A minimal `AgentToolContext` whose `run` records the dispatched args and returns a canned result. */
const captureContext = (calls: { args: Record<string, unknown> | undefined }[], retrieved: unknown): AgentToolContext => {
    return {
        env: {},
        getState: async () => undefined,
        idempotencyKey: "tool:searchMemory:call_1",
        reportProgress: () => {},
        run: async (_reference, args) => {
            calls.push({ args });

            return retrieved;
        },
        setState: async () => {},
        threadKey: "thread-1",
        toolCallId: "call_1",
    };
};

/** Mint the default `searchMemory` tool for an agentic memory source. */
const mintSearchTool = (memory: AgentMemoryOptions) => collectAgenticMemoryTools({ memory, model: "m" }, [])["searchMemory"];

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

describe(collectAgenticMemoryTools, () => {
    it("clamps a model-supplied topK above the ceiling to MAX_SEARCH_TOPK", async () => {
        const calls: { args: Record<string, unknown> | undefined }[] = [];
        const tool = mintSearchTool({ mode: "agentic", source: "rag:searchDocs" });

        await tool?.execute?.({ query: "q", topK: 9999 }, captureContext(calls, { chunks: [], sources: [] }));

        expect(calls[0]?.args?.["topK"]).toBe(50);
    });

    it("floors a zero/negative model-supplied topK to 1", async () => {
        const calls: { args: Record<string, unknown> | undefined }[] = [];
        const tool = mintSearchTool({ mode: "agentic", source: "rag:searchDocs" });

        await tool?.execute?.({ query: "q", topK: 0 }, captureContext(calls, { chunks: [], sources: [] }));

        expect(calls[0]?.args?.["topK"]).toBe(1);
    });

    it("falls back to the author-configured topK for an absent model topK", async () => {
        const calls: { args: Record<string, unknown> | undefined }[] = [];
        const tool = mintSearchTool({ mode: "agentic", source: "rag:searchDocs", topK: 7 });

        await tool?.execute?.({ query: "q" }, captureContext(calls, { chunks: [], sources: [] }));

        expect(calls[0]?.args?.["topK"]).toBe(7);
    });

    it("ignores a non-finite model topK, deferring to the configured topK", async () => {
        const calls: { args: Record<string, unknown> | undefined }[] = [];
        const tool = mintSearchTool({ mode: "agentic", source: "rag:searchDocs", topK: 3 });

        await tool?.execute?.({ query: "q", topK: Number.NaN }, captureContext(calls, { chunks: [], sources: [] }));

        expect(calls[0]?.args?.["topK"]).toBe(3);
    });

    it("floors `snippetChars: 0` to a one-char snippet instead of a bare ellipsis", async () => {
        const calls: { args: Record<string, unknown> | undefined }[] = [];
        const tool = mintSearchTool({ mode: "agentic", snippetChars: 0, source: "rag:searchDocs" });

        const result = (await tool?.execute?.(
            { query: "q" },
            captureContext(calls, { chunks: [{ id: "d#0", score: 1, sourceId: "d", text: "abcde" }], sources: [] }),
        )) as { results: { snippet: string }[] };

        expect(result.results[0]?.snippet).toBe("a…");
    });
});
