import type { EmbeddingModel } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import defineRag from "../../src/rag/define-rag";
import { batchReranker, scoreReranker } from "../../src/rag/rerank";
import type { RagVectorQueryInput, RagVectors, RetrievedChunk } from "../../src/rag/types";

/** Counters for the two AI SDK embed entry points, reset per test. */
const counters = { embed: 0, embedMany: 0 };

/** Deterministic embedder — the ranking here is driven by the stub store, not by vectors. */
vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    return {
        ...actual,
        embed: (async () => {
            counters.embed += 1;

            return { embedding: [0.1, 0.2, 0.3], usage: { tokens: 1 } };
        }) as unknown as typeof actual.embed,
        embedMany: (async ({ values }: { values: ReadonlyArray<string> }) => {
            counters.embedMany += 1;

            return { embeddings: values.map(() => [0.1, 0.2, 0.3]), usage: { tokens: values.length } };
        }) as unknown as typeof actual.embedMany,
    };
});

const model = { modelId: "stub-embed" } as unknown as EmbeddingModel;

/**
 * A store holding `count` chunks whose ids are `doc#0…doc#n`, returned in id
 * order and truncated to the query's `topK`. Records every query so tests can
 * assert the candidate pool depth.
 */
const stubStore = (count: number): { queries: RagVectorQueryInput[]; vectors: RagVectors } => {
    const queries: RagVectorQueryInput[] = [];
    const all = Array.from({ length: count }, (_, index) => {
        return {
            id: `doc#${String(index)}`,
            metadata: { __ragChunk: index, __ragSource: "doc", __ragText: `chunk ${String(index)}` },
            score: 1 - index / 100,
        };
    });

    return {
        queries,
        vectors: {
            deleteByIds: () => Promise.resolve(undefined),
            getByIds: () => Promise.resolve([]),
            query: (_index, input) => {
                queries.push(input);

                const matches = all.slice(0, input.topK ?? 5);

                return Promise.resolve({ count: matches.length, matches });
            },
            upsert: () => Promise.resolve(undefined),
        },
    };
};

describe("rerank", () => {
    it("reorders the candidate pool and trims to topK", async () => {
        expect.assertions(2);

        const { queries, vectors } = stubStore(20);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            index: "docs",
            // Reverse the pool: the worst vector hit becomes the best.
            rerank: (_query, chunks) => chunks.toReversed(),
        });

        const result = await docs({ vectors }).retrieve("question", { topK: 3 });

        // The pool was widened to topK * 4 so the reranker had something to work with.
        expect(queries[0]?.topK).toBe(12);
        expect(result.chunks.map((chunk) => chunk.id)).toStrictEqual(["doc#11", "doc#10", "doc#9"]);
    });

    it("honours an explicit `candidates` pool size", async () => {
        expect.assertions(1);

        const { queries, vectors } = stubStore(30);
        const docs = defineRag({
            allowSharedNamespace: true,
            candidates: 25,
            embeddingModel: model,
            index: "docs",
            rerank: (_query, chunks) => chunks,
        });

        await docs({ vectors }).retrieve("question", { topK: 2 });

        expect(queries[0]?.topK).toBe(25);
    });

    it("clamps the candidate pool to the store ceiling", async () => {
        expect.assertions(1);

        const { queries, vectors } = stubStore(80);
        const docs = defineRag({
            allowSharedNamespace: true,
            candidates: 400,
            embeddingModel: model,
            index: "docs",
            rerank: (_query, chunks) => chunks,
        });

        await docs({ vectors }).retrieve("question", { topK: 5 });

        expect(queries[0]?.topK).toBe(50);
    });

    it("can be skipped per call for a latency-sensitive path", async () => {
        expect.assertions(2);

        const rerank = vi.fn<(query: string, chunks: ReadonlyArray<RetrievedChunk>) => ReadonlyArray<RetrievedChunk>>((_query, chunks) => chunks.toReversed());
        const { queries, vectors } = stubStore(20);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", rerank });

        await docs({ vectors }).retrieve("question", { rerank: false, topK: 3 });

        expect(rerank).not.toHaveBeenCalled();
        // Without a reranker the pool is not widened either.
        expect(queries[0]?.topK).toBe(3);
    });

    it("does not widen the pool when nothing reorders", async () => {
        expect.assertions(1);

        const { queries, vectors } = stubStore(20);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs" });

        await docs({ vectors }).retrieve("question", { topK: 4 });

        expect(queries[0]?.topK).toBe(4);
    });

    it("rejects a non-positive `candidates` at define time", () => {
        expect.assertions(1);

        expect(() => defineRag({ candidates: 0, index: "docs" })).toThrow(/`candidates` must be a positive integer/u);
    });
});

describe("scoreReranker", () => {
    it("orders by the injected scorer, descending", async () => {
        expect.assertions(1);

        const { vectors } = stubStore(8);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            index: "docs",
            // Score by trailing digit: "chunk 7" scores highest.
            rerank: scoreReranker({ score: (_query, text) => Number(text.split(" ")[1]) }),
        });

        const result = await docs({ vectors }).retrieve("question", { topK: 3 });

        expect(result.chunks.map((chunk) => chunk.text)).toStrictEqual(["chunk 7", "chunk 6", "chunk 5"]);
    });

    it("drops candidates under `minScore`", async () => {
        expect.assertions(1);

        const { vectors } = stubStore(8);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            index: "docs",
            rerank: scoreReranker({ minScore: 6, score: (_query, text) => Number(text.split(" ")[1]) }),
        });

        const result = await docs({ vectors }).retrieve("question", { topK: 5 });

        expect(result.chunks.map((chunk) => chunk.text)).toStrictEqual(["chunk 7", "chunk 6"]);
    });

    it("replaces the retrieval score with the reranker's", async () => {
        expect.assertions(1);

        const rerank = scoreReranker({ score: () => 42 });
        const reranked = await rerank("q", [{ chunkIndex: 0, id: "a#0", importance: 1, score: 0.9, sourceId: "a", text: "x" }]);

        expect(reranked[0]?.score).toBe(42);
    });

    it("requires a scorer function", () => {
        expect.assertions(1);

        // @ts-expect-error -- exercising the runtime guard for JS callers
        expect(() => scoreReranker({})).toThrow(/`score` must be a function/u);
    });
});

describe("batchReranker", () => {
    it("scores the whole pool in one call", async () => {
        expect.assertions(2);

        const scoreAll = vi.fn<(query: string, texts: ReadonlyArray<string>) => ReadonlyArray<number>>((_query, texts) =>
            texts.map((text) => Number(text.split(" ")[1])),
        );
        const { vectors } = stubStore(8);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", rerank: batchReranker({ scoreAll }) });

        const result = await docs({ vectors }).retrieve("question", { topK: 2 });

        expect(scoreAll).toHaveBeenCalledTimes(1);
        expect(result.chunks.map((chunk) => chunk.text)).toStrictEqual(["chunk 7", "chunk 6"]);
    });

    it("refuses a score list that does not line up with the passages", async () => {
        expect.assertions(1);

        const rerank = batchReranker({ scoreAll: () => [1] });

        await expect(
            rerank("q", [
                { chunkIndex: 0, id: "a#0", importance: 1, score: 1, sourceId: "a", text: "x" },
                { chunkIndex: 1, id: "a#1", importance: 1, score: 1, sourceId: "a", text: "y" },
            ]),
        ).rejects.toThrow(/returned 1 scores for 2 passages/u);
    });
});

describe("transformQuery", () => {
    it("rewrites the query before embedding", async () => {
        expect.assertions(1);

        const { queries, vectors } = stubStore(10);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            index: "docs",
            transformQuery: (query) => `rewritten: ${query}`,
        });

        await docs({ vectors }).retrieve("what about the other one?");

        expect(queries[0]?.input).toBe("rewritten: what about the other one?");
    });

    it("runs one retrieval per expanded query and fuses them", async () => {
        expect.assertions(2);

        const { queries, vectors } = stubStore(10);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            index: "docs",
            transformQuery: () => ["first phrasing", "second phrasing", "third phrasing"],
        });

        const result = await docs({ vectors }).retrieve("original", { topK: 2 });

        expect(queries.map((entry) => entry.input)).toStrictEqual(["first phrasing", "second phrasing", "third phrasing"]);
        expect(result.chunks).toHaveLength(2);
    });

    it("receives the conversation id so a follow-up can be rewritten in context", async () => {
        expect.assertions(1);

        const seen: (string | undefined)[] = [];
        const { vectors } = stubStore(5);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            index: "docs",
            transformQuery: (query, info) => {
                seen.push(info.conversationId);

                return query;
            },
        });

        await docs({ conversationId: "thread-7", vectors }).retrieve("and the other?");

        expect(seen).toStrictEqual(["thread-7"]);
    });

    it("falls back to the original query when the transform returns nothing usable", async () => {
        expect.assertions(1);

        const { queries, vectors } = stubStore(5);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", transformQuery: () => ["", "   "] });

        await docs({ vectors }).retrieve("the real question");

        // An empty query matches everything and nothing — never search for it.
        expect(queries[0]?.input).toBe("the real question");
    });

    it("can be skipped per call", async () => {
        expect.assertions(1);

        const { queries, vectors } = stubStore(5);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs", transformQuery: () => "rewritten" });

        await docs({ vectors }).retrieve("original", { transformQuery: false });

        expect(queries[0]?.input).toBe("original");
    });
});

describe("topK trimming", () => {
    it("trims the fused union to topK instead of returning everything both legs found", async () => {
        expect.assertions(1);

        const { vectors } = stubStore(40);
        const docs = defineRag({
            allowSharedNamespace: true,
            embeddingModel: model,
            index: "docs",
            transformQuery: () => ["one", "two"],
        });

        const result = await docs({ vectors }).retrieve("q", { topK: 3 });

        expect(result.chunks).toHaveLength(3);
    });
});

describe("embedding batching and cache", () => {
    beforeEach(() => {
        counters.embed = 0;
        counters.embedMany = 0;
    });

    /** A store that records how many times the caller's embedder was invoked. */
    const countingStore = (): { embedCalls: () => number; vectors: RagVectors } => {
        let calls = 0;

        return {
            embedCalls: () => calls,
            vectors: {
                deleteByIds: () => Promise.resolve(undefined),
                getByIds: () => Promise.resolve([]),
                query: async (_index, input) => {
                    if (input.embed && input.input !== undefined) {
                        calls += 1;
                        await input.embed(input.input);
                    }

                    return { count: 0, matches: [] };
                },
                upsert: async (_index, input) => {
                    if (input.embed) {
                        calls += 1;
                        await input.embed(input.input);
                    }

                    return undefined;
                },
            },
        };
    };

    it("embeds a multi-chunk document in one batched call", async () => {
        expect.assertions(3);

        const { vectors } = countingStore();
        const docs = defineRag({ allowSharedNamespace: true, chunkOverlap: 0, chunkSize: 10, embeddingModel: model, index: "docs" });

        // Distinct chunk texts: identical ones dedupe to a single embed, which
        // is correct but would not exercise the batch.
        const text = ["alpha00000", "bravo11111", "charl22222", "delta33333", "echo444444"].join("");
        const result = await docs({ vectors }).index({ id: "a", text });

        expect(result.chunks).toBe(5);
        // One embedMany for all five chunks; the per-chunk callbacks are hits.
        expect(counters.embedMany).toBe(1);
        // And the batch is what they hit: a single `embed` here means the batch
        // seeded nothing and the document was paid for twice.
        expect(counters.embed).toBe(0);
    });

    it("seeds the index batch without cacheEmbeddings and beyond its bound", async () => {
        expect.assertions(2);

        const { vectors } = countingStore();
        // 12 chunks against a 2-entry cross-call bound: if the batch shared that
        // bound it would evict itself down to 2 and re-embed the other 10.
        const docs = defineRag({ allowSharedNamespace: true, cacheEmbeddings: 2, chunkOverlap: 0, chunkSize: 10, embeddingModel: model, index: "docs" });
        const text = Array.from({ length: 12 }, (_, position) => `chunk${String(position).padStart(5, "0")}`).join("");

        const result = await docs({ vectors }).index({ id: "a", text });

        expect(result.chunks).toBe(12);
        expect(counters.embed).toBe(0);
    });

    it("does not retain index-batch embeddings across calls", async () => {
        expect.assertions(1);

        const { vectors } = countingStore();
        const docs = defineRag({ allowSharedNamespace: true, chunkOverlap: 0, chunkSize: 10, embeddingModel: model, index: "docs" });
        const rag = docs({ vectors });
        const text = ["alpha00000", "bravo11111"].join("");

        await rag.index({ id: "a", text });
        counters.embedMany = 0;
        await rag.index({ id: "b", text });

        // A second batch, not a hit on the first document's retained map —
        // otherwise one long-lived bound context accumulates every chunk it
        // ever indexed.
        expect(counters.embedMany).toBe(1);
    });

    it("keeps each concurrent index() call's batch to itself", async () => {
        expect.assertions(3);

        // `defineRagSource` drives up to `concurrency` (default 4) index() calls
        // through ONE bound Rag, so a batch map shared across calls is wiped by
        // whichever sibling finishes first — every still-pending chunk then falls
        // back to a single embed and the batch is pure cost.
        let calls = 0;
        let reachedA = (): void => {};
        const aStarted = new Promise<void>((resolve) => {
            reachedA = resolve;
        });
        let releaseA = (): void => {};
        const aHeld = new Promise<void>((resolve) => {
            releaseA = resolve;
        });

        const vectors: RagVectors = {
            deleteByIds: () => Promise.resolve(undefined),
            getByIds: () => Promise.resolve([]),
            query: () => Promise.resolve({ count: 0, matches: [] }),
            upsert: async (_index, input) => {
                if (input.id.startsWith("a#")) {
                    reachedA();
                    await aHeld;
                }

                if (input.embed) {
                    calls += 1;
                    await input.embed(input.input);
                }

                return undefined;
            },
        };

        const docs = defineRag({ allowSharedNamespace: true, chunkOverlap: 0, chunkSize: 10, embeddingModel: model, index: "docs" });
        const rag = docs({ vectors });

        const first = rag.index({ id: "a", text: ["alpha00000", "bravo11111"].join("") });

        await aStarted;
        // The sibling runs to completion — including its `finally` — while `a`'s
        // upserts are still pending.
        await rag.index({ id: "b", text: ["charl22222", "delta33333"].join("") });

        releaseA();
        await first;

        expect(counters.embedMany).toBe(2);
        expect(calls).toBe(4);
        // Every chunk resolved from its OWN call's batch; a single `embed` here
        // means the sibling's `clear()` wiped this document's entries mid-flight.
        expect(counters.embed).toBe(0);
    });

    it("does not batch a single-chunk document", async () => {
        expect.assertions(1);

        const { vectors } = countingStore();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs" });

        await docs({ vectors }).index({ id: "a", text: "short" });

        expect(counters.embedMany).toBe(0);
    });

    it("retains query embeddings across calls when cacheEmbeddings is set", async () => {
        expect.assertions(2);

        const { vectors } = countingStore();
        const docs = defineRag({ allowSharedNamespace: true, cacheEmbeddings: 8, embeddingModel: model, index: "docs" });
        const rag = docs({ vectors });

        await rag.retrieve("same question");
        const afterFirst = counters.embed;

        await rag.retrieve("same question");

        expect(afterFirst).toBeGreaterThan(0);
        expect(counters.embed).toBe(afterFirst);
    });

    it("re-embeds a repeated query when no cache is configured", async () => {
        expect.assertions(1);

        const { vectors } = countingStore();
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: model, index: "docs" });
        const rag = docs({ vectors });

        await rag.retrieve("same question");
        const afterFirst = counters.embed;

        await rag.retrieve("same question");

        expect(counters.embed).toBeGreaterThan(afterFirst);
    });

    it("rejects a negative cache size at define time", () => {
        expect.assertions(1);

        expect(() => defineRag({ cacheEmbeddings: -1, index: "docs" })).toThrow(/`cacheEmbeddings` must be a non-negative integer/u);
    });
});
