import { LunoraError } from "@lunora/errors";
import type { EmbeddingModel } from "ai";
import { embed } from "ai";
import { describe, expect, it, vi } from "vitest";

import { bm25LexicalStore, contentHash, defineRag, guessMimeTypeFromExtension } from "../src/rag";
import type { RagContext, RagLexicalStore, RagTextStore, RagVectorQueryInput, RagVectors } from "../src/rag/types";

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
            // `usage` + `providerMetadata` mirror the real AI SDK embed result so
            // the post-hoc span path (token usage / gateway cost) is exercised;
            // callers that only read `embedding` are unaffected.
            return {
                embedding: bagVector(value),
                providerMetadata: { gateway: { cost: 0.0002 } },
                usage: { tokens: value.split(/\s+/u).filter(Boolean).length },
            };
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
 */
const memoryVectors = (): { queryCalls: RagVectorQueryInput[]; store: Map<string, StoredVector>; vectors: RagVectors } => {
    const store = new Map<string, StoredVector>();
    const queryCalls: RagVectorQueryInput[] = [];

    const dot = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => a.reduce((sum, value, index) => sum + value * (b[index] as number), 0);

    const vectors: RagVectors = {
        deleteByIds: async (_indexName, ids) => {
            for (const id of ids) {
                store.delete(id);
            }
        },
        getByIds: async (_indexName, ids) =>
            ids.flatMap((id) => {
                const record = store.get(id);

                return record ? [{ id: record.id, metadata: record.metadata }] : [];
            }),
        query: async (_indexName, input) => {
            queryCalls.push(input);

            const topK = input.topK ?? 5;
            const ceiling = input.returnMetadata === "all" ? 20 : 100;

            if (!Number.isInteger(topK) || topK < 1 || topK > ceiling) {
                throw new RangeError(`topK must be an integer between 1 and ${String(ceiling)}`);
            }

            if (typeof input.input !== "string") {
                throw new TypeError("memoryVectors: query requires `input`");
            }

            if (!input.embed) {
                throw new TypeError("memoryVectors: query requires `embed`");
            }

            const embedder = input.embed as (text: string) => Promise<ReadonlyArray<number>>;
            const queryVector = await embedder(input.input);
            const matches = [...store.values()]
                .filter((record) => input.namespace === undefined || record.namespace === input.namespace)
                .map((record) => {
                    return {
                        id: record.id,
                        metadata: input.returnMetadata === "all" ? record.metadata : undefined,
                        score: dot(queryVector, record.values),
                    };
                });
            const sorted = matches.toSorted((a, b) => b.score - a.score).slice(0, topK);

            return { count: sorted.length, matches: sorted };
        },
        upsert: async (_indexName, input) => {
            if (!input.embed) {
                throw new TypeError("memoryVectors: upsert requires `embed`");
            }

            const values = await input.embed(input.input);

            store.set(input.id, { id: input.id, metadata: input.metadata, namespace: input.namespace, values });
        },
    };

    return { queryCalls, store, vectors };
};

/** Wrap a real {@link bm25LexicalStore} to record its `index`/`remove`/`search` calls for assertions. */
const recordingLexicalStore = (): {
    indexed: number[];
    removed: string[][];
    searches: { filter?: Record<string, unknown>; namespace?: string; query: string; topK: number }[];
    store: RagLexicalStore;
} => {
    const inner = bm25LexicalStore();
    const indexed: number[] = [];
    const removed: string[][] = [];
    const searches: { filter?: Record<string, unknown>; namespace?: string; query: string; topK: number }[] = [];

    return {
        indexed,
        removed,
        searches,
        store: {
            index: async (chunks, options) => {
                indexed.push(chunks.length);

                await inner.index(chunks, options);
            },
            remove: async (ids, options) => {
                removed.push([...ids]);

                await inner.remove?.(ids, options);
            },
            search: async (query, options) => {
                searches.push({ filter: options.filter, namespace: options.namespace, query, topK: options.topK });

                return inner.search(query, options);
            },
        },
    };
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

const fakeCtx = (vectors: RagVectors, auth?: unknown): RagContext & { embeddingModelCalls: unknown[] } => {
    const embeddingModelCalls: unknown[] = [];

    return {
        ai: {
            embeddingModel: (model) => {
                embeddingModelCalls.push(model);

                return { __embeddingModel: model ?? "default" } as unknown as EmbeddingModel;
            },
        },
        auth,
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
        expect(() => defineRag({ index: "" })).toThrow(LunoraError);
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

    it("embeds via a direct AI SDK EmbeddingModel object without `ctx.ai` (bring-your-own, no env.AI)", async () => {
        const { store, vectors } = memoryVectors();
        // A hand-built context carrying ONLY `vectors` — no `ai`, so no `env.AI`
        // binding is provisioned. The bring-your-own model is used as-is.
        const ownModel = { specificationVersion: "v2" } as unknown as EmbeddingModel;
        const ctx: RagContext = { vectors };
        const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, embeddingModel: ownModel, index: "docs" });

        const result = await docs(ctx).index({ id: "doc-1", text: "alpha | beta" });

        expect(result.chunks).toBe(2);
        expect([...store.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["doc-1#0", "doc-1#1"]);

        // Retrieval runs over the same object-model path — no `ctx.ai` needed.
        const { chunks } = await docs(ctx).retrieve("alpha");

        expect(chunks.length).toBeGreaterThan(0);
        // The object model was handed straight to `aiEmbed` (no `ctx.ai` indirection).
        expect((vi.mocked(embed).mock.calls.at(-1)?.[0] as { model: unknown }).model).toBe(ownModel);
    });

    it("throws a directed error for a model-id string when the context has no `ctx.ai`", async () => {
        const { vectors } = memoryVectors();
        const ctx: RagContext = { vectors };
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: "@cf/baai/bge-base-en-v1.5", index: "docs" });

        await expect(docs(ctx).index({ id: "doc-1", text: "hello" })).rejects.toThrow(/no `ai` \(env\.AI\)/u);
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
        expect(result.chunks[0]!.importance).toBe(1);
        expect(result.chunks[1]!.importance).toBe(0.2);
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

        it("hydrates importance and caller metadata (otherwise inert under `returnMetadata: indexed`)", async () => {
            const { vectors } = memoryVectors();
            const { store: textStore } = memoryTextStore();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, index: "docs", textStore });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", importance: 0.4, metadata: { title: "Weather" }, text: "rain storm cloud" });

            const result = await rag.retrieve("rain storm cloud");

            // `query()` alone (returnMetadata: "indexed") never sees `__ragImportance`
            // or caller metadata in text-store mode — without the `getByIds`
            // hydration these would read back as the default importance (1) and
            // `undefined` metadata, exactly like the bug this closes.
            expect(result.chunks[0]?.importance).toBe(0.4);
            expect(result.chunks[0]?.metadata).toStrictEqual({ title: "Weather" });

            // Importance actually weights the score (0.4x the raw cosine ~1.0 for
            // an exact-text query), not a no-op 1x.
            expect(result.chunks[0]?.score).toBeCloseTo(0.4, 5);
            expect(result.sources[0]?.metadata).toStrictEqual({ title: "Weather" });
            expect(result.sources[0]?.weight).toBe(0.4);
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

        await expect(rag.index({ id: "doc-1", text: "hello" })).rejects.toThrow(LunoraError);
        await expect(rag.retrieve("hello")).rejects.toThrow(LunoraError);
        await expect(rag.remove({ id: "doc-1" })).rejects.toThrow(LunoraError);

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

    it("throws for empty text when allowEmptySources is false", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs" });

        await expect(docs(ctx).index({ allowEmptySources: false, id: "doc-1", text: "" })).rejects.toThrow(/zero chunks/u);
        // Also catches whitespace-only text after a no-op chunker split
        await expect(docs(ctx).index({ allowEmptySources: false, id: "doc-2", text: "   " })).rejects.toThrow(LunoraError);
    });

    it("fires onRetrieve callback after retrieval with match count", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, index: "docs" });
        const rag = docs(ctx);
        const onRetrieve = vi.fn();

        await rag.index({ id: "weather", text: "rain storm cloud" });
        await rag.retrieve("rain storm cloud", { onRetrieve, topK: 5 });

        expect(onRetrieve).toHaveBeenCalledTimes(1);
        expect(onRetrieve).toHaveBeenCalledWith({ matches: 1, query: "rain storm cloud" });
    });

    it("populates source weight from chunk importance", async () => {
        const { vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, index: "docs" });
        const rag = docs(ctx);

        await rag.index({ id: "canonical", text: "rain storm cloud" });
        await rag.index({ id: "incidental", importance: 0.3, text: "rain storm cloud" });

        const result = await rag.retrieve("rain storm cloud", { topK: 2 });

        const canonicalSource = result.sources.find((source) => source.id === "canonical");
        const incidentalSource = result.sources.find((source) => source.id === "incidental");

        expect(canonicalSource?.weight).toBe(1);
        expect(incidentalSource?.weight).toBe(0.3);
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

    describe("embedding-model versioning", () => {
        it("partitions the vector space by the version tag so a model swap can't return stale vectors", async () => {
            const { store, vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const v1 = defineRag({ allowSharedNamespace: true, embeddingModelVersion: "bge-v1", index: "docs" })(ctx);
            const v2 = defineRag({ allowSharedNamespace: true, embeddingModelVersion: "bge-v2", index: "docs" })(ctx);

            await v1.index({ id: "doc-1", text: "rain storm cloud" });

            // Ids + the stored namespace carry the tag; chunk #0 records it.
            expect([...store.keys()]).toStrictEqual(["bge-v1#doc-1#0"]);
            expect(store.get("bge-v1#doc-1#0")?.namespace).toBe("bge-v1");
            expect(store.get("bge-v1#doc-1#0")?.metadata?.["__ragModel"]).toBe("bge-v1");

            // The new model's queries are partitioned away from the old vectors.
            const stale = await v2.retrieve("rain storm cloud");

            expect(stale.chunks).toStrictEqual([]);

            // The original model still sees them; the internal tag never leaks.
            const fresh = await v1.retrieve("rain storm cloud");

            expect(fresh.chunks.map((chunk) => chunk.sourceId)).toStrictEqual(["doc-1"]);
            expect(fresh.chunks[0]?.metadata).toBeUndefined();

            // Re-indexing under the new model repartitions cleanly (both coexist).
            await v2.index({ id: "doc-1", text: "rain storm cloud" });

            expect([...store.keys()].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["bge-v1#doc-1#0", "bge-v2#doc-1#0"]);

            const repartitioned = await v2.retrieve("rain storm cloud");

            expect(repartitioned.chunks.map((chunk) => chunk.sourceId)).toStrictEqual(["doc-1"]);
        });

        it("composes the version tag with the tenant namespace", async () => {
            const { queryCalls, store, vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ embeddingModelVersion: "v2", index: "docs" })(ctx);

            await docs.index({ id: "doc-1", namespace: "tenant-a", text: "rain storm cloud" });

            expect([...store.keys()]).toStrictEqual(["v2%3A%3Atenant-a#doc-1#0"]);
            expect(store.get("v2%3A%3Atenant-a#doc-1#0")?.namespace).toBe("v2::tenant-a");

            const result = await docs.retrieve("rain storm cloud", { namespace: "tenant-a" });

            expect(result.chunks.map((chunk) => chunk.sourceId)).toStrictEqual(["doc-1"]);
            expect(queryCalls.at(-1)?.namespace).toBe("v2::tenant-a");
        });

        it("rejects an invalid version tag at config time", () => {
            expect(() => defineRag({ embeddingModelVersion: "has spaces", index: "docs" })).toThrow(LunoraError);
            expect(() => defineRag({ embeddingModelVersion: "x".repeat(41), index: "docs" })).toThrow(/embeddingModelVersion/u);
        });
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

    describe("contentHash", () => {
        it("produces a consistent SHA-256 hex digest", async () => {
            const encoder = new TextEncoder();
            const hash = await contentHash(encoder.encode("hello rag world"));

            expect(hash).toBe("4e520b6e777a6501de8c6d5188bd5f2639137a6ef34a5601047fef3c68e35a12");

            // Same input yields same hash
            const hash2 = await contentHash(encoder.encode("hello rag world"));

            expect(hash2).toBe(hash);
        });

        it("produces different hashes for different inputs", async () => {
            const encoder = new TextEncoder();
            const hash1 = await contentHash(encoder.encode("alpha"));
            const hash2 = await contentHash(encoder.encode("beta"));

            expect(hash1).not.toBe(hash2);
        });

        it("accepts both ArrayBuffer and Uint8Array", async () => {
            const encoder = new TextEncoder();
            const asBuffer = await contentHash(encoder.encode("test").buffer);
            const asView = await contentHash(encoder.encode("test"));

            expect(asBuffer).toBe(asView);
        });
    });

    describe("named filters", () => {
        it("resolves a named filter from config.filters", async () => {
            const { queryCalls, vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({
                allowSharedNamespace: true,
                filters: { published: { filter: { status: "published", deleted: false }, description: "Only published content" } },
                index: "docs",
            });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "hello world" });
            await rag.retrieve("hello", { filter: "published" });

            expect(queryCalls[0]?.filter).toStrictEqual({ deleted: false, status: "published" });
        });

        it("throws for unknown named filter", async () => {
            const { vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, filters: { published: { filter: { status: "published" } } }, index: "docs" });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "hello world" });

            await expect(rag.retrieve("hello", { filter: "nonexistent" })).rejects.toThrow(LunoraError);
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

    describe("hybrid search (lexical store)", () => {
        it("mirrors chunk text into the lexical store and fuses both legs via RRF", async () => {
            const { queryCalls, vectors } = memoryVectors();
            const lexical = recordingLexicalStore();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", lexicalStore: lexical.store });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", metadata: { title: "Weather" }, text: "sunny warm bright sunshine | rain rain storm cloud" });
            await rag.index({ id: "doc-2", metadata: { title: "Cooking" }, text: "pasta tomato basil dinner" });

            // Each source mirrored its chunks into the lexical store.
            expect(lexical.indexed).toStrictEqual([2, 1]);

            const result = await rag.retrieve("rain storm cloud", { topK: 5 });

            // The vector index was queried once; the lexical leg is the separate store.
            expect(queryCalls).toHaveLength(1);
            expect(lexical.searches).toHaveLength(1);
            expect(lexical.searches[0]?.query).toBe("rain storm cloud");

            // The weather doc's storm chunk ranks first (best semantic + keyword match).
            expect(result.chunks.length).toBeGreaterThan(0);
            expect(result.chunks[0]?.sourceId).toBe("doc-1");
            expect(result.chunks[0]?.text).toBe("rain rain storm cloud");
            expect(result.sources.map((source) => source.id)).toContain("doc-1");
        });

        it("recovers an exact-term chunk the vector leg ranks below topK", async () => {
            const { vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", lexicalStore: bm25LexicalStore() });
            const rag = docs(ctx);

            // One chunk holds a rare exact term ("qwerty"); many decoys crowd it
            // out of the vector top-1, but the lexical leg pins it via RRF.
            await rag.index({
                id: "doc-1",
                text: "alpha beta gamma | delta epsilon zeta | the qwerty token lives here | eta theta iota | kappa lambda mu",
            });

            const result = await rag.retrieve("qwerty", { topK: 1 });

            expect(result.chunks[0]?.text).toBe("the qwerty token lives here");
        });

        it("keeps a lexical-only hit under a cosine-scale minScore instead of comparing its BM25 score to it", async () => {
            const { vectors } = memoryVectors();
            const ctx = fakeCtx(vectors);

            // A synthetic lexical leg: one hit that exists ONLY in the lexical
            // index (never upserted into the vector store), with a raw BM25
            // score (0.3) that is NOT on the same scale as cosine similarity —
            // `hybridRank`'s own docs note vector/lexical scores "are not
            // comparable across different search methods".
            const lexicalOnly: RagLexicalStore = {
                index: async () => {},
                search: async () => [{ id: "doc-2#0", score: 0.3, text: "gizmo contraption" }],
            };

            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", lexicalStore: lexicalOnly });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "rain storm cloud" });

            // A cosine-scale `minScore` (well above the lexical-only hit's raw
            // BM25 score) must still surface doc-2 via the lexical leg — it was
            // never subject to a cosine-scale threshold that means something
            // different for its own score.
            const result = await rag.retrieve("rain storm cloud", { minScore: 0.5 });

            expect(result.chunks.map((chunk) => chunk.sourceId)).toContain("doc-2");
            // The genuine semantic match still passes the (unaffected) vector-leg threshold.
            expect(result.chunks.map((chunk) => chunk.sourceId)).toContain("doc-1");
        });

        it("removes chunks from the lexical store on remove()", async () => {
            const { store, vectors } = memoryVectors();
            const lexical = recordingLexicalStore();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", lexicalStore: lexical.store });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "one | two | three" });

            expect(store.size).toBe(3);

            await rag.remove({ id: "doc-1" });

            // Vector store emptied AND the lexical store's remove hook fired for all chunks.
            expect(store.size).toBe(0);
            expect(lexical.removed).toStrictEqual([["doc-1#0", "doc-1#1", "doc-1#2"]]);

            const survivors = await lexical.store.search("one two three", { namespace: undefined, topK: 5 });

            expect(survivors).toStrictEqual([]);
        });

        it("cleans up stale lexical chunks when a re-index shrinks the source", async () => {
            const { vectors } = memoryVectors();
            const lexical = recordingLexicalStore();
            const ctx = fakeCtx(vectors);
            const docs = defineRag({ allowSharedNamespace: true, chunk: pipeChunker, index: "docs", lexicalStore: lexical.store });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "one | two | three" });
            await rag.index({ id: "doc-1", text: "one" });

            // The shrink deleted the two trailing chunks from the lexical store too.
            expect(lexical.removed).toStrictEqual([["doc-1#1", "doc-1#2"]]);

            const hits = await lexical.store.search("two three", { namespace: undefined, topK: 5 });

            expect(hits).toStrictEqual([]);
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

    describe("rLS-filtered retrieval", () => {
        it("derives a filter from ctx.auth and applies it to the vector query", async () => {
            const { queryCalls, vectors } = memoryVectors();
            const ctx = fakeCtx(vectors, { orgId: "org-a" });
            const docs = defineRag({
                allowSharedNamespace: true,
                index: "docs",
                rlsFilter: (auth) => {
                    return { orgId: (auth as { orgId: string }).orgId };
                },
            });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "hello world" });
            await rag.retrieve("hello");

            expect(queryCalls[0]?.filter).toStrictEqual({ orgId: "org-a" });
        });

        it("merges the RLS filter OVER the caller filter (RLS wins on key collision)", async () => {
            const { queryCalls, vectors } = memoryVectors();
            const ctx = fakeCtx(vectors, { orgId: "org-a" });
            const docs = defineRag({
                allowSharedNamespace: true,
                index: "docs",
                rlsFilter: (auth) => {
                    return { orgId: (auth as { orgId: string }).orgId };
                },
            });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "hello world" });
            // Caller tries to widen to another org + adds an orthogonal key.
            await rag.retrieve("hello", { filter: { orgId: "org-b", status: "published" } });

            // RLS orgId overrides the caller's; the orthogonal key is preserved.
            expect(queryCalls[0]?.filter).toStrictEqual({ orgId: "org-a", status: "published" });
        });

        it("supports an async rlsFilter and an undefined (no-constraint) result", async () => {
            const { queryCalls, vectors } = memoryVectors();
            const ctx = fakeCtx(vectors, { role: "admin" });
            const docs = defineRag({
                allowSharedNamespace: true,
                index: "docs",
                // Admins get no constraint; everyone else is scoped to their org.
                rlsFilter: (auth) => Promise.resolve((auth as { role: string }).role === "admin" ? undefined : { orgId: "x" }),
            });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "hello world" });
            await rag.retrieve("hello", { filter: { status: "published" } });

            // undefined RLS → only the caller filter survives.
            expect(queryCalls[0]?.filter).toStrictEqual({ status: "published" });
        });

        it("applies the RLS-merged filter to the lexical leg too", async () => {
            const { vectors } = memoryVectors();
            const lexical = recordingLexicalStore();
            const ctx = fakeCtx(vectors, { orgId: "org-a" });
            const docs = defineRag({
                allowSharedNamespace: true,
                index: "docs",
                lexicalStore: lexical.store,
                rlsFilter: (auth) => {
                    return { orgId: (auth as { orgId: string }).orgId };
                },
            });
            const rag = docs(ctx);

            await rag.index({ id: "doc-1", text: "hello world" });
            await rag.retrieve("hello");

            expect(lexical.searches[0]?.filter).toStrictEqual({ orgId: "org-a" });
        });
    });
});

describe(bm25LexicalStore, () => {
    const chunk = (id: string, text: string, chunkIndex = 0): { chunkIndex: number; id: string; sourceId: string; text: string } => {
        return {
            chunkIndex,
            id,
            sourceId: id.split("#")[0] as string,
            text,
        };
    };

    it("ranks documents by BM25 relevance and honours topK", async () => {
        const store = bm25LexicalStore();

        await store.index(
            [chunk("a#0", "the quick brown fox jumps"), chunk("b#0", "a lazy dog sleeps all day"), chunk("c#0", "quick quick quick reflexes win")],
            {},
        );

        const matches = await store.search("quick", { topK: 2 });

        expect(matches).toHaveLength(2);
        // "c" repeats "quick" three times → higher term frequency → ranks first.
        expect(matches[0]?.id).toBe("c#0");
        expect(matches[0]?.text).toBe("quick quick quick reflexes win");
        expect(matches[1]?.id).toBe("a#0");
        expect(matches[0]?.score).toBeGreaterThan(matches[1]?.score as number);
    });

    it("is idempotent across re-index and forgets removed docs", async () => {
        const store = bm25LexicalStore();

        await store.index([chunk("a#0", "storm cloud rain")], {});
        // Re-index the same id with different text — the old terms must not linger.
        await store.index([chunk("a#0", "sunshine bright warm")], {});

        await expect(store.search("storm", { topK: 5 })).resolves.toStrictEqual([]);

        const afterReindex = await store.search("sunshine", { topK: 5 });

        expect(afterReindex[0]?.id).toBe("a#0");

        await store.remove?.(["a#0"], {});

        await expect(store.search("sunshine", { topK: 5 })).resolves.toStrictEqual([]);
    });

    it("isolates namespaces", async () => {
        const store = bm25LexicalStore();

        await store.index([chunk("a#0", "tenant alpha secret")], { namespace: "org-a" });
        await store.index([chunk("a#0", "tenant beta secret")], { namespace: "org-b" });

        const inA = await store.search("secret", { namespace: "org-a", topK: 5 });

        expect(inA).toHaveLength(1);
        expect(inA[0]?.text).toBe("tenant alpha secret");

        // A namespace-less query sees neither tenant's docs.
        await expect(store.search("secret", { topK: 5 })).resolves.toStrictEqual([]);
    });

    it("fails closed when handed a metadata filter it cannot evaluate", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            const store = bm25LexicalStore();

            await store.index([chunk("a#0", "public knowledge base entry")], {});

            // An operator-object filter is beyond a metadata-less store → no hits.
            const matches = await store.search("public", { filter: { visibility: { $ne: "private" } }, topK: 5 });

            expect(matches).toStrictEqual([]);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });

    it("fails closed on a FLAT-equality filter too (the shape rlsFilter produces) — RLS bypass regression", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        try {
            const store = bm25LexicalStore();

            // "secret" is indexed WITHOUT a namespace/metadata split — a flat
            // `{ orgId }` filter (exactly the shape `rlsFilter` produces) must not
            // be exempted from the fail-closed guard, or the BM25 search runs over
            // the whole namespace and leaks this chunk's text past the RLS filter.
            await store.index([chunk("a#0", "tenant secret document")], {});

            const matches = await store.search("secret", { filter: { orgId: "org-1" }, topK: 5 });

            expect(matches).toStrictEqual([]);
            expect(warn).toHaveBeenCalledTimes(1);
        } finally {
            warn.mockRestore();
        }
    });
});

describe("defineRag ctx.trace instrumentation", () => {
    /**
     * A context whose `trace` mirrors the real `ctx.trace`: it hands the body a
     * span handle, then records the span's start attributes merged with anything
     * the body attached post-hoc (post-hoc winning), exactly like the `@lunora/do`
     * tracer does at record time.
     */
    const tracingCtx = (vectors: RagVectors): RagContext & { spans: { attributes: Record<string, unknown>; name: string }[] } => {
        const spans: { attributes: Record<string, unknown>; name: string }[] = [];

        return {
            ai: {
                // A model that carries a `modelId`, so the span picks it up.
                embeddingModel: (model) => ({ modelId: model ?? "default" }) as unknown as EmbeddingModel,
            },
            spans,
            trace: async <T>(
                name: string,
                function_: (
                    trace: unknown,
                    span: { setAttribute: (key: string, value: unknown) => void; setAttributes: (fields: Record<string, unknown>) => void },
                ) => Promise<T> | T,
                attributes?: Record<string, unknown>,
            ): Promise<T> => {
                const collected: Record<string, unknown> = {};
                const span = {
                    setAttribute: (key: string, value: unknown) => {
                        collected[key] = value;
                    },
                    setAttributes: (fields: Record<string, unknown>) => {
                        Object.assign(collected, fields);
                    },
                };

                try {
                    return await function_(undefined, span);
                } finally {
                    spans.push({ attributes: { ...attributes, ...collected }, name });
                }
            },
            vectors,
        };
    };

    it("wraps each embed in a generation span carrying the model id and post-hoc usage/cost", async () => {
        const { vectors } = memoryVectors();
        const ctx = tracingCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: "@cf/baai/bge-base-en-v1.5", index: "docs" });

        await docs(ctx).index({ id: "doc-1", text: "hello world" });
        await docs(ctx).retrieve("hello");

        expect(ctx.spans.length).toBeGreaterThan(0);

        for (const span of ctx.spans) {
            expect(span.name).toBe("ai.embed");
            expect(span.attributes["gen_ai.operation.name"]).toBe("embeddings");
            expect(span.attributes["gen_ai.request.model"]).toBe("@cf/baai/bge-base-en-v1.5");
            // Post-hoc — only knowable after the embed call resolves.
            expect(span.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
            expect(span.attributes["gen_ai.usage.cost"]).toBe(0.0002);
        }
    });

    it("embeds untraced when the context has no `trace` (a hand-built ctx)", async () => {
        const { store, vectors } = memoryVectors();
        const ctx = fakeCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, index: "docs" });

        // No `trace` on the context → the embed path runs exactly as before.
        await expect(docs(ctx).index({ id: "doc-1", text: "hello world" })).resolves.toBeDefined();
        expect(store.size).toBeGreaterThan(0);
    });

    it("emits gen_ai.conversation.id on the embed span when the context carries one", async () => {
        const { vectors } = memoryVectors();
        const ctx = { ...tracingCtx(vectors), conversationId: "thread-42" };
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: "@cf/baai/bge-base-en-v1.5", index: "docs" });

        await docs(ctx).index({ id: "doc-1", text: "hello world" });

        expect(ctx.spans.length).toBeGreaterThan(0);

        for (const span of ctx.spans) {
            expect(span.attributes["gen_ai.conversation.id"]).toBe("thread-42");
        }
    });

    it("omits gen_ai.conversation.id when no conversation id is set", async () => {
        const { vectors } = memoryVectors();
        const ctx = tracingCtx(vectors);
        const docs = defineRag({ allowSharedNamespace: true, embeddingModel: "@cf/baai/bge-base-en-v1.5", index: "docs" });

        await docs(ctx).index({ id: "doc-1", text: "hello world" });

        expect(ctx.spans.length).toBeGreaterThan(0);

        for (const span of ctx.spans) {
            expect(span.attributes).not.toHaveProperty("gen_ai.conversation.id");
        }
    });
});
