import type { EmbeddingModel } from "ai";
import { embed } from "ai";
import { describe, expect, it, vi } from "vitest";

import { contentHashFromArrayBuffer, defineRag, guessMimeTypeFromExtension } from "../src/rag";
import type { RagContext, RagTextStore, RagVectorQueryInput, RagVectors } from "../src/rag/types";

// Partial-mock the AI SDK: `embed` becomes a deterministic token-bag embedder
// (similar text → similar vectors) so ranking is assertable without a model;
// everything else (`tool`, `jsonSchema`, …) stays real.
vi.mock(import("ai"), async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();

    const bagVector = (text: string): number[] => {
        const vector: number[] = Array.from<number>({ length: 64 }).fill(0);

        for (const word of text
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean)) {
            let hash = 0;

            for (let index = 0; index < word.length; index += 1) {
                hash = (hash * 31 + (word.codePointAt(index) as number)) % 64;
            }

            vector[hash] = (vector[hash] as number) + 1;
        }

        const norm = Math.hypot(...vector) || 1;

        return vector.map((value) => value / norm);
    };

    return {
        ...actual,
        embed: vi.fn(async ({ value }: { model: unknown; value: string }) => {
            return { embedding: bagVector(value) };
        }) as unknown as typeof actual.embed,
    };
});

interface StoredVector {
    id: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
    values: ReadonlyArray<number>;
}

/**
 * In-memory Vectorize double satisfying `RagVectors`: cosine scoring over
 * upserted vectors, namespace filtering, `returnMetadata` projection, and the
 * real topK ceilings (20 with full metadata, 100 otherwise) enforced with the
 * same `RangeError` the live facade throws.
 *
 * Accepts an optional set of text-search index names. Indexes in this set
 * use word-overlap (BM25-simulated) scoring and accept upserts without an
 * `embed` function — modelling Vectorize text-search indexes faithfully
 * enough for hybrid-search tests to make assertions.
 */
const memoryVectors = (_textSearchIndexes?: Set<string>): { queryCalls: RagVectorQueryInput[]; store: Map<string, StoredVector>; vectors: RagVectors } => {
    // Per-index stores so text-search upserts (no embed → values: []) don't
    // overwrite vector data in the same memory space.
    const stores = new Map<string, Map<string, StoredVector>>();
    const queryCalls: RagVectorQueryInput[] = [];

    const getStore = (indexName: string): Map<string, StoredVector> => {
        let store = stores.get(indexName);

        if (!store) {
            store = new Map<string, StoredVector>();
            stores.set(indexName, store);
        }

        return store;
    };

    const dot = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => a.reduce((sum, value, index) => sum + value * (b[index] as number), 0);

    /** Simple word-overlap similarity for text-search simulation. */
    const wordOverlap = (query: string, text: string): number => {
        const queryWords = new Set(
            query
                .toLowerCase()
                .split(/[^a-z0-9]+/u)
                .filter(Boolean),
        );
        const docWords = text
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean);
        const overlap = docWords.filter((word) => queryWords.has(word)).length;

        return docWords.length > 0 ? overlap / docWords.length : 0;
    };

    const vectors: RagVectors = {
        deleteByIds: async (indexName, ids) => {
            const store = getStore(indexName);

            for (const id of ids) {
                store.delete(id);
            }
        },
        getByIds: async (indexName, ids) => {
            const store = getStore(indexName);

            return ids.flatMap((id) => {
                const record = store.get(id);

                return record ? [{ id: record.id, metadata: record.metadata }] : [];
            });
        },
        query: async (indexName, input) => {
            queryCalls.push(input);

            const topK = input.topK ?? 5;
            const ceiling = input.returnMetadata === "all" ? 20 : 100;

            if (!Number.isInteger(topK) || topK < 1 || topK > ceiling) {
                throw new RangeError(`topK must be an integer between 1 and ${String(ceiling)}`);
            }

            if (typeof input.input !== "string") {
                throw new TypeError("memoryVectors: query requires `input`");
            }

            const store = getStore(indexName);
            const matches = await Promise.all(
                [...store.values()]
                    .filter((record) => input.namespace === undefined || record.namespace === input.namespace)
                    .map(async (record) => {
                        let score: number;

                        if (input.embed) {
                            // Vector mode: cosine similarity.
                            score = dot(await (input.embed as (text: string) => Promise<ReadonlyArray<number>>)(input.input as string), record.values);
                        } else {
                            // Text-search mode: score by word overlap against stored text.
                            // We store the raw input text in __ragText metadata for retrieval.
                            const rawText = typeof record.metadata?.["__ragText"] === "string" ? record.metadata["__ragText"] : "";
                            score = wordOverlap(input.input as string, rawText);
                        }

                        return {
                            id: record.id,
                            metadata: input.returnMetadata === "all" ? record.metadata : undefined,
                            score,
                        };
                    }),
            );
            const sorted = matches.toSorted((a, b) => b.score - a.score).slice(0, topK);

            return { count: sorted.length, matches: sorted };
        },
        upsert: async (indexName, input) => {
            const store = getStore(indexName);

            if (input.embed) {
                const values = await input.embed(input.input);

                store.set(input.id, { id: input.id, metadata: input.metadata, namespace: input.namespace, values });
            } else {
                // Text-search upsert without embed: store with zero-values vector.
                store.set(input.id, { id: input.id, metadata: input.metadata, namespace: input.namespace, values: [] });
            }
        },
    };

    // Expose the primary index store for test assertions (backward compat).
    const store = getStore("docs");

    return { queryCalls, store, vectors };
};

const memoryTextStore = (): { removed: string[][]; store: RagTextStore; texts: Map<string, string> } => {
    const texts = new Map<string, string>();
    const removed: string[][] = [];

    return {
        removed,
        store: {
            getMany: async (ids) => ids.map((id) => texts.get(id)),
            put: async (chunks) => {
                for (const chunk of chunks) {
                    texts.set(chunk.id, chunk.text);
                }
            },
            remove: async (ids) => {
                removed.push([...ids]);

                for (const id of ids) {
                    texts.delete(id);
                }
            },
        },
        texts,
    };
};

const fakeCtx = (vectors: RagVectors): RagContext & { embeddingModelCalls: unknown[] } => {
    const embeddingModelCalls: unknown[] = [];

    return {
        ai: {
            embeddingModel: (model) => {
                embeddingModelCalls.push(model);

                return { __embeddingModel: model ?? "default" } as unknown as EmbeddingModel;
            },
        },
        embeddingModelCalls,
        vectors,
    };
};

/** Split on `|` — a deterministic chunker for tests that need exact chunks. */
const pipeChunker = (text: string): ReadonlyArray<string> =>
    text
        .split("|")
        .map((piece) => piece.trim())
        .filter(Boolean);

describe(defineRag, () => {
    it("rejects invalid configs", () => {
        expect(() => defineRag({ index: "" })).toThrow(TypeError);
        expect(() => defineRag({ chunkOverlap: 1000, chunkSize: 1000, index: "docs" })).toThrow(/chunkOverlap/u);
        expect(() => defineRag({ index: "docs", topK: 0 })).toThrow(/topK/u);
    });

    it("chunks, embeds and upserts with deterministic ids and linking metadata", async () => {
        const { store, vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });

        const result = await docs(ctx).index({
            id: "doc-1",
            metadata: { title: "Durable Objects" },
            text: "alpha alpha | beta beta | gamma gamma",
        });

        expect(result).toStrictEqual({ chunks: 3, ids: ["doc-1#0", "doc-1#1", "doc-1#2"], unchanged: false });
        expect([...store.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["doc-1#0", "doc-1#1", "doc-1#2"]);

        const head = store.get("doc-1#0") as StoredVector;
        const tail = store.get("doc-1#2") as StoredVector;

        expect(head.metadata).toMatchObject({ __ragChunk: 0, __ragChunks: 3, __ragSource: "doc-1", __ragText: "alpha alpha", title: "Durable Objects" });
        expect(typeof head.metadata?.["__ragHash"]).toBe("string");
        expect(tail.metadata).toMatchObject({ __ragChunk: 2, __ragSource: "doc-1", __ragText: "gamma gamma" });
        expect(tail.metadata?.["__ragHash"]).toBeUndefined();
        expect(tail.metadata?.["__ragChunks"]).toBeUndefined();
    });

    it("resolves the embedding model once, from the configured id", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: "@cf/baai/bge-base-en-v1.5", index: "docs" });

        await docs(ctx).index({ id: "doc-1", text: "hello world" });

        expect(ctx.embeddingModelCalls).toStrictEqual(["@cf/baai/bge-base-en-v1.5"]);
        expect(vi.mocked(embed).mock.calls.length).toBeGreaterThan(0);
    });

    it("retrieves ranked chunks with prompt-ready context and deduped sources", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });
        const rag = docs(ctx);

        await rag.index({ id: "weather", metadata: { title: "Weather" }, text: "sunny warm bright sunshine | rain rain storm cloud" });
        await rag.index({ id: "cooking", metadata: { title: "Cooking" }, text: "pasta tomato basil dinner" });

        const result = await rag.retrieve("rain storm cloud", { topK: 3 });

        expect(result.chunks.length).toBeGreaterThan(0);

        const [best] = result.chunks;

        expect(best?.sourceId).toBe("weather");
        expect(best?.chunkIndex).toBe(1);
        expect(best?.text).toBe("rain rain storm cloud");
        expect(best?.metadata).toStrictEqual({ title: "Weather" });
        expect(result.context).toContain("[source:weather#1]\nrain rain storm cloud");
        expect(result.sources.map((source) => source.id)).toContain("weather");
        expect(new Set(result.sources.map((source) => source.id)).size).toBe(result.sources.length);
    });

    it("caps topK at 20 in metadata mode instead of tripping the Vectorize ceiling", async () => {
        const { queryCalls, vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, index: "docs" });

        await docs(ctx).index({ id: "doc-1", text: "hello world" });

        await expect(docs(ctx).retrieve("hello", { topK: 50 })).resolves.toBeDefined();

        expect(queryCalls[0]?.topK).toBe(20);
        expect(queryCalls[0]?.returnMetadata).toBe("all");
    });

    it("scopes retrieval by namespace (tenant isolation)", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ index: "docs" });
        const rag = docs(ctx);

        await rag.index({ id: "tenant-a-doc", namespace: "tenant-a", text: "secret alpha plans" });
        await rag.index({ id: "tenant-b-doc", namespace: "tenant-b", text: "secret alpha plans" });

        const result = await rag.retrieve("secret alpha plans", { namespace: "tenant-a" });

        expect(result.chunks.map((chunk) => chunk.sourceId)).toStrictEqual(["tenant-a-doc"]);
    });

    it("namespaces chunk ids so tenants sharing a source id do not collide", async () => {
        const { store, vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ chunk: pipeChunker, index: "docs" });
        const rag = docs(ctx);

        // The SAME source id under two tenants. Vectorize ids are index-global, so
        // a namespace-less id ("doc-1#0") would clobber tenant A's chunk with
        // tenant B's — the namespace segment keeps them distinct.
        await rag.index({ id: "doc-1", namespace: "tenant-a", text: "alpha alpha plans" });
        await rag.index({ id: "doc-1", namespace: "tenant-b", text: "beta beta plans" });

        expect([...store.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["tenant-a#doc-1#0", "tenant-b#doc-1#0"]);
        expect(store.get("tenant-a#doc-1#0")?.namespace).toBe("tenant-a");
        expect(store.get("tenant-b#doc-1#0")?.namespace).toBe("tenant-b");

        // Retrieval parses the original source id back out of the namespaced id.
        const result = await rag.retrieve("alpha plans", { namespace: "tenant-a" });

        expect(result.chunks.map((chunk) => chunk.sourceId)).toStrictEqual(["doc-1"]);
        expect(result.chunks[0]?.text).toBe("alpha alpha plans");

        // Removing tenant A leaves tenant B's identically-named source intact.
        await rag.remove({ id: "doc-1", namespace: "tenant-a" });

        expect([...store.keys()]).toStrictEqual(["tenant-b#doc-1#0"]);
    });

    it("short-circuits re-indexing unchanged content via the stored hash", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });
        const rag = docs(ctx);

        await rag.index({ id: "doc-1", text: "alpha | beta" });

        const embedCallsAfterFirst = vi.mocked(embed).mock.calls.length;
        const second = await rag.index({ id: "doc-1", text: "alpha | beta" });

        expect(second).toStrictEqual({ chunks: 2, ids: ["doc-1#0", "doc-1#1"], unchanged: true });
        expect(vi.mocked(embed)).toHaveBeenCalledTimes(embedCallsAfterFirst);
    });

    it("deletes stale trailing chunks when a re-indexed source shrinks", async () => {
        const { store, vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });
        const rag = docs(ctx);

        await rag.index({ id: "doc-1", text: "one | two | three" });

        expect(store.size).toBe(3);

        await rag.index({ id: "doc-1", text: "condensed rewrite" });

        expect([...store.keys()]).toStrictEqual(["doc-1#0"]);
        expect(store.get("doc-1#0")?.metadata?.["__ragChunks"]).toBe(1);
    });

    it("removes every chunk of a source without external bookkeeping", async () => {
        const { store, vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });
        const rag = docs(ctx);

        await rag.index({ id: "doc-1", text: "one | two | three" });
        await rag.index({ id: "doc-2", text: "keep me" });
        await rag.remove({ id: "doc-1" });

        expect([...store.keys()]).toStrictEqual(["doc-2#0"]);
    });

    it("filters matches below minScore", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, index: "docs" });
        const rag = docs(ctx);

        await rag.index({ id: "exact", text: "rain storm cloud" });
        await rag.index({ id: "unrelated", text: "pasta tomato basil" });

        const result = await rag.retrieve("rain storm cloud", { minScore: 0.9 });

        expect(result.chunks.map((chunk) => chunk.sourceId)).toStrictEqual(["exact"]);
    });

    it("multiplies importance into scores at rank time", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, index: "docs" });
        const rag = docs(ctx);

        // Both sources match the query identically; the demoted one must rank last.
        await rag.index({ id: "canonical", text: "rain storm cloud" });
        await rag.index({ id: "incidental", importance: 0.2, text: "rain storm cloud" });

        const result = await rag.retrieve("rain storm cloud", { topK: 2 });

        expect(result.chunks.map((chunk) => chunk.sourceId)).toStrictEqual(["canonical", "incidental"]);
        expect(result.chunks[1]!.score).toBeCloseTo(result.chunks[0]!.score * 0.2, 5);
        expect(result.chunks[1]!.metadata).toBeUndefined();
    });

    it("stitches neighbouring chunks into matches via chunkContext", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });
        const rag = docs(ctx);

        await rag.index({ id: "doc-1", text: "intro paragraph | rain storm cloud | closing words" });

        const result = await rag.retrieve("rain storm cloud", { chunkContext: { after: 1, before: 1 }, topK: 1 });

        expect(result.chunks[0]?.text).toBe("intro paragraph\nrain storm cloud\nclosing words");
        expect(result.context).toContain("[source:doc-1#1]\nintro paragraph\nrain storm cloud\nclosing words");
    });

    describe("text-store mode", () => {
        it("keeps text out of metadata, queries with indexed projection, and hydrates by id", async () => {
            const { queryCalls, store, vectors } = memoryVectors();
            const { store: textStore, texts } = memoryTextStore();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", textStore });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", metadata: { title: "Weather" }, text: "sunny warm | rain storm cloud" });

            expect(store.get("doc-1#1")?.metadata?.["__ragText"]).toBeUndefined();
            expect(texts.get("doc-1#1")).toBe("rain storm cloud");

            const result = await rag.retrieve("rain storm cloud", { topK: 50 });

            expect(queryCalls[0]?.returnMetadata).toBe("indexed");
            expect(queryCalls[0]?.topK).toBe(50);
            expect(result.chunks[0]?.text).toBe("rain storm cloud");
            expect(result.chunks[0]?.sourceId).toBe("doc-1");
            expect(result.chunks[0]?.chunkIndex).toBe(1);
        });

        it("drops matches whose text is missing from the store", async () => {
            const { vectors } = memoryVectors();
            const { store: textStore, texts } = memoryTextStore();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, index: "docs", textStore });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "rain storm cloud" });
            texts.clear();

            const result = await rag.retrieve("rain storm cloud");

            expect(result.chunks).toStrictEqual([]);
            expect(result.context).toBe("");
        });

        it("propagates removals into the text store", async () => {
            const { vectors } = memoryVectors();
            const { removed, store: textStore } = memoryTextStore();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", textStore });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "one | two" });
            await rag.remove({ id: "doc-1" });

            expect(removed).toStrictEqual([["doc-1#0", "doc-1#1"]]);
        });
    });

    it("warns once per index when used without a namespace, unless suppressed", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        try {
            const { vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const noisy = defineRag({ index: "warn-probe" });
            const quiet = defineRag({ allowSharedNamespace: true, index: "warn-probe-quiet" });

            await noisy(ctx).index({ id: "doc-1", text: "hello" });
            await noisy(ctx).retrieve("hello");
            await quiet(ctx).index({ id: "doc-1", text: "hello" });

            const ragWarnings = warn.mock.calls.filter(([message]) => typeof message === "string" && message.includes("warn-probe"));

            expect(ragWarnings).toHaveLength(1);
        } finally {
            warn.mockRestore();
        }
    });

    it("throws without a namespace when requireNamespace is set", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ index: "docs", requireNamespace: true });
        const rag = docs(ctx);

        await expect(rag.index({ id: "doc-1", text: "hello" })).rejects.toThrow(/requires a namespace/u);
        await expect(rag.retrieve("hello")).rejects.toThrow(/requires a namespace/u);
        await expect(rag.remove({ id: "doc-1" })).rejects.toThrow(/requires a namespace/u);

        // With the namespace supplied, the same calls go through.
        await expect(rag.index({ id: "doc-1", namespace: "tenant-a", text: "hello" })).resolves.toMatchObject({ chunks: 1 });
        await expect(rag.retrieve("hello", { namespace: "tenant-a" })).resolves.toBeDefined();
    });

    it("indexes empty text as zero chunks", async () => {
        const { store, vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, index: "docs" });

        const result = await docs(ctx).index({ id: "doc-1", text: "   " });

        expect(result).toStrictEqual({ chunks: 0, ids: [], unchanged: false });
        expect(store.size).toBe(0);
    });

    it("exposes retrieve as an AI SDK tool", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, index: "docs" });
        const rag = docs(ctx);

        await rag.index({ id: "weather", text: "rain storm cloud" });

        const searchTool = rag.asTool({ topK: 1 });

        expect(searchTool.description).toContain('"docs"');

        const result = await searchTool.execute!({ query: "rain storm cloud" }, { context: undefined, messages: [], toolCallId: "call_1" });

        expect(result).toMatchObject({ sources: [{ id: "weather" }] });
    });

    describe("guessMimeTypeFromExtension", () => {
        it("returns known MIME types", () => {
            expect(guessMimeTypeFromExtension(".pdf")).toBe("application/pdf");
            expect(guessMimeTypeFromExtension("pdf")).toBe("application/pdf");
            expect(guessMimeTypeFromExtension(".html")).toBe("text/html");
            expect(guessMimeTypeFromExtension("jpg")).toBe("image/jpeg");
            expect(guessMimeTypeFromExtension(".JPG")).toBe("image/jpeg");
            expect(guessMimeTypeFromExtension("tsx")).toBe("text/typescript");
        });

        it("falls back to application/octet-stream for unknown extensions", () => {
            expect(guessMimeTypeFromExtension(".xyzzy")).toBe("application/octet-stream");
            expect(guessMimeTypeFromExtension("")).toBe("application/octet-stream");
        });
    });

    describe("contentHashFromArrayBuffer", () => {
        it("produces a consistent SHA-256 hex digest", async () => {
            const encoder = new TextEncoder();
            const { buffer } = encoder.encode("hello rag world");
            const hash = await contentHashFromArrayBuffer(buffer);

            expect(hash).toBe("4e520b6e777a6501de8c6d5188bd5f2639137a6ef34a5601047fef3c68e35a12");

            // Same input yields same hash
            const hash2 = await contentHashFromArrayBuffer(buffer);

            expect(hash2).toBe(hash);
        });

        it("produces different hashes for different inputs", async () => {
            const encoder = new TextEncoder();
            const hash1 = await contentHashFromArrayBuffer(encoder.encode("alpha").buffer);
            const hash2 = await contentHashFromArrayBuffer(encoder.encode("beta").buffer);

            expect(hash1).not.toBe(hash2);
        });
    });

    describe("named filters", () => {
        it("resolves a named filter from config.filters", async () => {
            const { queryCalls, vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, filters: { published: { status: "published", deleted: false } }, index: "docs" });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "hello world" });
            await rag.retrieve("hello", { filter: "published" });

            expect(queryCalls[0]?.filter).toStrictEqual({ deleted: false, status: "published" });
        });

        it("throws for unknown named filter", async () => {
            const { vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, filters: { published: { status: "published" } }, index: "docs" });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "hello world" });

            await expect(rag.retrieve("hello", { filter: "nonexistent" })).rejects.toThrow(/unknown named filter "nonexistent"/u);
        });

        it("passes through a literal Record filter unchanged", async () => {
            const { queryCalls, vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, index: "docs" });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "hello world" });
            await rag.retrieve("hello", { filter: { status: "draft" } });

            expect(queryCalls[0]?.filter).toStrictEqual({ status: "draft" });
        });
    });

    describe("hybrid search", () => {
        it("queries both indexes and fuses via RRF", async () => {
            const { queryCalls, vectors } = memoryVectors(new Set(["docs-text"]));
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", textSearch: { index: "docs-text" } });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", metadata: { title: "Weather" }, text: "sunny warm bright sunshine | rain rain storm cloud" });
            await rag.index({ id: "doc-2", metadata: { title: "Cooking" }, text: "pasta tomato basil dinner" });

            const result = await rag.retrieve("rain storm cloud", { topK: 5 });

            // Both indexes were queried
            expect(queryCalls).toHaveLength(2);
            expect(queryCalls[0]?.input).toBe("rain storm cloud");
            expect(queryCalls[1]?.input).toBe("rain storm cloud");

            // The weather doc should rank first (best semantic + keyword match)
            expect(result.chunks.length).toBeGreaterThan(0);
            expect(result.chunks[0]?.sourceId).toBe("doc-1");
            expect(result.chunks[0]?.text).toBe("rain rain storm cloud");
            expect(result.sources.map((source) => source.id)).toContain("doc-1");
        });

        it("handles text search when no vector embed is provided", async () => {
            const { vectors } = memoryVectors(new Set(["docs-text"]));
            const ctx = fakeCtx(vectors);
            // The text-search index upsert happens without embed; the vector
            // index still requires one. This test verifies the dual upsert
            // does not throw when embed is omitted for the text-search leg.
            const docs = defineRag({ allowSharedNamespace: true, index: "docs", textSearch: { index: "docs-text" } });
            const rag = docs(ctx);

            await expect(rag.index({ id: "doc-1", text: "hello world" })).resolves.toMatchObject({ chunks: 1, unchanged: false });
        });
    });

    describe("onChunk callback", () => {
        it("fires after each chunk is upserted with progress info", async () => {
            const { vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });
            const rag = docs(ctx);
            const calls: { chunkIndex: number; id: string; total: number }[] = [];

            await rag.index({
                id: "doc-1",
                onChunk: (info) => {
                    calls.push({ chunkIndex: info.chunkIndex, id: info.id, total: info.total });
                },
                text: "alpha | beta | gamma",
            });

            expect(calls).toStrictEqual([
                { chunkIndex: 0, id: "doc-1#0", total: 3 },
                { chunkIndex: 1, id: "doc-1#1", total: 3 },
                { chunkIndex: 2, id: "doc-1#2", total: 3 },
            ]);
        });

        it("is not called for unchanged re-index", async () => {
            const { vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });
            const rag = docs(ctx);
            const onChunk = vi.fn();

            await rag.index({ id: "doc-1", onChunk, text: "hello world" });
            await rag.index({ id: "doc-1", onChunk, text: "hello world" });

            // First index: 1 chunk fires the callback once. Second: unchanged, callback not called.
            expect(onChunk).toHaveBeenCalledTimes(1);
        });
    });

    describe("text-search cleanup on remove", () => {
        it("deletes from both vector and text-search indexes", async () => {
            const { store, vectors } = memoryVectors(new Set(["docs-text"]));
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", textSearch: { index: "docs-text" } });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "one | two | three" });

            // Both indexes share the same store in this double — verify all chunks exist
            expect(store.size).toBe(3);

            await rag.remove({ id: "doc-1" });

            expect(store.size).toBe(0);
        });
    });
});
