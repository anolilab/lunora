import type { EmbeddingModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import defineRag from "../../src/rag/define-rag";
import type { RagContext, RagVectorQueryInput, RagVectors, RagVectorUpsertInput } from "../../src/rag/types";

/**
 * Partial-mock the AI SDK so `embed` returns a vector of a controllable width.
 * The width is read from the model's `modelId` (`"dim:<n>"`), which keeps every
 * case in this file driven by the model rather than by mock bookkeeping.
 */
vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        embed: (async ({ model }: { model: EmbeddingModel }) => {
            const width = Number.parseInt(String((model as { modelId?: string }).modelId).replace("dim:", ""), 10);

            return { embedding: Array.from<number>({ length: width }).fill(0.1), usage: { tokens: 1 } };
        }) as unknown as typeof actual.embed,
    };
});

/** A stand-in AI SDK embedding model whose id encodes the vector width it returns. */
const modelOfWidth = (width: number): EmbeddingModel => ({ modelId: `dim:${String(width)}` }) as unknown as EmbeddingModel;

const stubVectors = (): { queries: RagVectorQueryInput[]; upserts: RagVectorUpsertInput[]; vectors: RagVectors } => {
    const upserts: RagVectorUpsertInput[] = [];
    const queries: RagVectorQueryInput[] = [];

    const vectors: RagVectors = {
        deleteByIds: () => Promise.resolve(undefined),
        getByIds: () => Promise.resolve([]),
        query: async (_index, input) => {
            queries.push(input);

            // Exercise the caller's embedder so a dimension breach surfaces on
            // the retrieve path too, not only on index.
            if (input.embed && input.input !== undefined) {
                await input.embed(input.input);
            }

            return { count: 0, matches: [] };
        },
        upsert: async (_index, input) => {
            upserts.push(input);

            if (input.embed) {
                await input.embed(input.input);
            }

            return undefined;
        },
    };

    return { queries, upserts, vectors };
};

const contextFor = (vectors: RagVectors): RagContext => {
    return { vectors };
};

describe("embedding dimension ceiling", () => {
    it("accepts a model at Vectorize's 1536 limit", async () => {
        expect.hasAssertions();

        const { vectors } = stubVectors();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(1536), index: "docs" });

        await expect(docs(contextFor(vectors)).index({ id: "a", text: "hello world" })).resolves.toMatchObject({ chunks: 1 });
    });

    it("refuses a 3072-dimension model, naming the ceiling and both escapes", async () => {
        expect.hasAssertions();

        const { vectors } = stubVectors();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(3072), index: "docs" });

        await expect(docs(contextFor(vectors)).index({ id: "a", text: "hello world" })).rejects.toThrow(
            /produces 3072-dimension vectors, over the 1536-dimension ceiling of index "docs"/u,
        );
    });

    it("names the offending model in the error", async () => {
        expect.hasAssertions();

        const { vectors } = stubVectors();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(4096), index: "docs" });

        await expect(docs(contextFor(vectors)).index({ id: "a", text: "hi" })).rejects.toThrow(/"dim:4096"/u);
    });

    it("points at both remedies", async () => {
        expect.hasAssertions();

        const { vectors } = stubVectors();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(3072), index: "docs" });

        await expect(docs(contextFor(vectors)).index({ id: "a", text: "hi" })).rejects.toThrow(/`dimensions` option[\s\S]*maxEmbeddingDimensions: false/u);
    });

    it("catches the breach on the retrieve path too", async () => {
        expect.hasAssertions();

        const { vectors } = stubVectors();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(3072), index: "docs" });

        await expect(docs(contextFor(vectors)).retrieve("a question")).rejects.toThrow(/over the 1536-dimension ceiling/u);
    });

    it("allows a wider model when the check is disabled for a non-Vectorize store", async () => {
        expect.hasAssertions();

        const { vectors } = stubVectors();
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: modelOfWidth(4096),
            index: "docs",
            maxEmbeddingDimensions: false,
        });

        await expect(docs(contextFor(vectors)).index({ id: "a", text: "hello world" })).resolves.toMatchObject({ chunks: 1 });
    });

    it("honours a custom ceiling", async () => {
        expect.hasAssertions();

        const { vectors } = stubVectors();
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: modelOfWidth(1024),
            index: "docs",
            maxEmbeddingDimensions: 768,
        });

        await expect(docs(contextFor(vectors)).index({ id: "a", text: "hi" })).rejects.toThrow(/over the 768-dimension ceiling/u);
    });

    it("checks once per bound context, not once per chunk", async () => {
        expect.hasAssertions();

        const { vectors } = stubVectors();
        const docs = defineRag({
            allowSharedNamespace: true,
            chunkOverlap: 0,
            chunkSize: 10,
            embeddingModel: modelOfWidth(1536),
            index: "docs",
        });

        // Many chunks, all fine — the point is that a passing check does not
        // re-run and cannot start failing partway through a document.
        await expect(docs(contextFor(vectors)).index({ id: "a", text: "a".repeat(200) })).resolves.toMatchObject({ chunks: 20 });
    });

    it("rejects a non-positive ceiling at define time", () => {
        expect.hasAssertions();

        expect(() => defineRag({ index: "docs", maxEmbeddingDimensions: 0 })).toThrow(/`maxEmbeddingDimensions` must be a positive integer/u);
    });
});

describe("topK ceiling", () => {
    it("allows Vectorize V2's 50 in metadata mode, where the old cap was 20", async () => {
        expect.hasAssertions();

        const { queries, vectors } = stubVectors();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(768), index: "docs" });

        await docs(contextFor(vectors)).retrieve("question", { topK: 50 });

        expect(queries[0]?.topK).toBe(50);
        expect(queries[0]?.returnMetadata).toBe("all");
    });

    it("still clamps metadata mode at 50", async () => {
        expect.hasAssertions();

        const { queries, vectors } = stubVectors();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(768), index: "docs" });

        await docs(contextFor(vectors)).retrieve("question", { topK: 100 });

        expect(queries[0]?.topK).toBe(50);
    });

    it("keeps the 100 ceiling in text-store mode", async () => {
        expect.hasAssertions();

        const { queries, vectors } = stubVectors();
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: modelOfWidth(768),
            index: "docs",
            textStore: { getMany: (ids) => Promise.resolve(ids.map(() => "text")), put: () => Promise.resolve() },
        });

        await docs(contextFor(vectors)).retrieve("question", { topK: 100 });

        expect(queries[0]?.topK).toBe(100);
        expect(queries[0]?.returnMetadata).toBe("indexed");
    });
});
