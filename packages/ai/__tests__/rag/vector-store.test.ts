import type { EmbeddingModel } from "ai";
import { describe, expect, it, vi } from "vitest";

import defineRag from "../../src/rag/define-rag";
import type { RagVectorQueryInput, RagVectorUpsertInput } from "../../src/rag/types";
import type { RagVectorStore, RagVectorStoreCapabilities } from "../../src/rag/vector-store";
import { VECTORIZE_CAPABILITIES, vectorizeStore } from "../../src/rag/vector-store";

/** Vector width is encoded in the model id, as in the dimensions suite. */
vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    const widthOf = (model: unknown): number => Number.parseInt(String((model as { modelId?: string }).modelId).replace("dim:", ""), 10);

    return {
        ...actual,
        embed: (async ({ model }: { model: EmbeddingModel }) => {
            return { embedding: Array.from<number>({ length: widthOf(model) }).fill(0.1), usage: { tokens: 1 } };
        }) as unknown as typeof actual.embed,
        embedMany: (async ({ model, values }: { model: EmbeddingModel; values: ReadonlyArray<string> }) => {
            return { embeddings: values.map(() => Array.from<number>({ length: widthOf(model) }).fill(0.1)), usage: { tokens: values.length } };
        }) as unknown as typeof actual.embedMany,
    };
});

const modelOfWidth = (width: number): EmbeddingModel => ({ modelId: `dim:${String(width)}` }) as unknown as EmbeddingModel;

/** A store with caller-chosen capabilities that records what it was asked to do. */
const fakeStore = (capabilities: RagVectorStoreCapabilities): { queries: RagVectorQueryInput[]; store: RagVectorStore; upserts: RagVectorUpsertInput[] } => {
    const queries: RagVectorQueryInput[] = [];
    const upserts: RagVectorUpsertInput[] = [];

    return {
        queries,
        store: {
            capabilities,
            deleteByIds: () => Promise.resolve(undefined),
            getByIds: () => Promise.resolve([]),
            query: async (input) => {
                queries.push(input);

                if (input.embed && input.input !== undefined) {
                    await input.embed(input.input);
                }

                return { count: 0, matches: [] };
            },
            upsert: async (input) => {
                upserts.push(input);

                if (input.embed) {
                    await input.embed(input.input);
                }

                return undefined;
            },
        },
        upserts,
    };
};

/** A store with no limits at all — what a pgvector-backed adapter would declare. */
const UNLIMITED: RagVectorStoreCapabilities = {
    maxDimensions: false,
    maxIdBytes: false,
    maxMetadataBytes: false,
    maxTopK: 1000,
    maxTopKWithMetadata: 1000,
};

describe("vectorizeStore", () => {
    it("declares Vectorize's documented limits", () => {
        expect.assertions(1);

        expect(VECTORIZE_CAPABILITIES).toStrictEqual({
            maxDimensions: 1536,
            maxIdBytes: 64,
            maxMetadataBytes: 10 * 1024,
            maxTopK: 100,
            maxTopKWithMetadata: 50,
        });
    });

    it("binds every operation to its index name", async () => {
        expect.assertions(4);

        const calls: string[] = [];
        const store = vectorizeStore(
            {
                deleteByIds: (index) => {
                    calls.push(`delete:${index}`);

                    return Promise.resolve(undefined);
                },
                getByIds: (index) => {
                    calls.push(`get:${index}`);

                    return Promise.resolve([]);
                },
                query: (index) => {
                    calls.push(`query:${index}`);

                    return Promise.resolve({ count: 0, matches: [] });
                },
                upsert: (index) => {
                    calls.push(`upsert:${index}`);

                    return Promise.resolve(undefined);
                },
            },
            "docs",
        );

        await store.getByIds(["a"]);
        await store.deleteByIds(["a"]);
        await store.query({});
        await store.upsert({ id: "a", input: "x" });

        expect(calls).toStrictEqual(["get:docs", "delete:docs", "query:docs", "upsert:docs"]);
        expect(store.capabilities.maxTopKWithMetadata).toBe(50);
        expect(store.capabilities.maxDimensions).toBe(1536);
        expect(store.capabilities.maxMetadataBytes).toBe(10 * 1024);
    });
});

describe("a custom store's capabilities replace Vectorize's", () => {
    it("lifts the topK ceiling", async () => {
        expect.assertions(1);

        const { queries, store } = fakeStore(UNLIMITED);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(768), index: "docs", store: () => store });

        await docs({}).retrieve("question", { topK: 400 });

        // Vectorize would have clamped this to 50.
        expect(queries[0]?.topK).toBe(400);
    });

    it("accepts an embedding model Vectorize could not hold", async () => {
        expect.assertions(1);

        const { store } = fakeStore(UNLIMITED);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(3072), index: "docs", store: () => store });

        // 3072 dims — rejected against Vectorize's 1536, fine here.
        await expect(docs({}).index({ id: "a", text: "hello world" })).resolves.toMatchObject({ chunks: 1 });
    });

    it("accepts metadata beyond Vectorize's 10 KiB budget", async () => {
        expect.assertions(1);

        const { store } = fakeStore(UNLIMITED);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(768), index: "docs", store: () => store });

        await expect(docs({}).index({ id: "a", metadata: { blob: "x".repeat(50_000) }, text: "hello" })).resolves.toMatchObject({
            chunks: 1,
        });
    });

    it("still enforces a limit the store does declare", async () => {
        expect.assertions(1);

        const { store } = fakeStore({ ...UNLIMITED, maxDimensions: 512 });
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: modelOfWidth(768), index: "docs", store: () => store });

        await expect(docs({}).index({ id: "a", text: "hello" })).rejects.toThrow(/produces 768-dimension vectors, over the 512-dimension ceiling/u);
    });

    it("lets an explicit maxEmbeddingDimensions override the store", async () => {
        expect.assertions(1);

        const { store } = fakeStore(UNLIMITED);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: modelOfWidth(768),
            index: "docs",
            maxEmbeddingDimensions: 256,
            store: () => store,
        });

        await expect(docs({}).index({ id: "a", text: "hello" })).rejects.toThrow(/over the 256-dimension ceiling/u);
    });

    it("is built once per bound context, with that context", () => {
        expect.assertions(2);

        const seen: unknown[] = [];
        const { store } = fakeStore(UNLIMITED);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: modelOfWidth(768),
            index: "docs",
            store: (context) => {
                seen.push(context.auth);

                return store;
            },
        });

        // A store needing per-request state (a pgvector connection off ctx.sql)
        // depends on getting the bound context, not the definition.
        docs({ auth: { orgId: "org-1" } });
        docs({ auth: { orgId: "org-2" } });

        expect(seen).toStrictEqual([{ orgId: "org-1" }, { orgId: "org-2" }]);
        expect(seen).toHaveLength(2);
    });

    it("skips the define-time chunkSize check that only Vectorize's budget justifies", () => {
        expect.assertions(1);

        const { store } = fakeStore(UNLIMITED);

        // A chunkSize past Vectorize's metadata budget is rejected at define
        // time on the default store; with a custom one the budget is unknown
        // until bind, so the check cannot apply.
        expect(() => defineRag({ chunkSize: 500_000, index: "docs", store: () => store })).not.toThrow();
    });
});
