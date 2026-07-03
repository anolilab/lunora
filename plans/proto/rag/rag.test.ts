/**
 * Spike 111 composition test. Drives `defineRag`'s index -> retrieve loop over the
 * REAL `@lunora/bindings/vectors` `createVectors` (imported by source path) plus:
 *   - an in-memory `VectorizeIndexLike` double (cosine similarity, honours topK,
 *     returnMetadata, namespace) standing in for a Vectorize binding, and
 *   - a deterministic token-bag `embed` (similar text -> similar vectors), standing
 *     in for `ctx.ai.embeddingModel` + AI SDK `embed`.
 *
 * Asserts the chunk<->source metadata round-trips, retrieval ranks by similarity,
 * the assembled context + source refs are well-formed, and the Vectorize topK
 * ceiling (20 with returnMetadata:"all") is enforced by the real code.
 */
import { describe, expect, it } from "vitest";

import createVectors from "../../../packages/bindings/src/vectors/create-vectors";
import type {
    VectorizeIndexLike,
    VectorizeMatch,
    VectorizeMatches,
    VectorizeQueryOptions,
    VectorizeVector,
} from "../../../packages/bindings/src/vectors/types";
import { defineRag } from "./rag";

/** Deterministic 64-dim token-bag embedder: cosine similarity ~ token overlap. */
const EMBED_DIMENSIONS = 64;

const embedText = (text: string): ReadonlyArray<number> => {
    const vector = Array.from({ length: EMBED_DIMENSIONS }, () => 0);

    for (const token of text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)) {
        let hash = 0;

        for (let index = 0; index < token.length; index += 1) {
            hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
        }

        vector[hash % EMBED_DIMENSIONS] += 1;
    }

    return vector;
};

const dot = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => a.reduce((sum, value, index) => sum + value * b[index], 0);
const norm = (a: ReadonlyArray<number>): number => Math.sqrt(dot(a, a)) || 1;
const cosine = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => dot(a, b) / (norm(a) * norm(b));

/** Minimal in-memory Vectorize index double. */
const createMemoryIndex = (): VectorizeIndexLike => {
    const store = new Map<string, VectorizeVector>();

    const upsert = async (vectors: ReadonlyArray<VectorizeVector>): Promise<{ mutationId: string }> => {
        for (const vector of vectors) {
            store.set(vector.id, vector);
        }

        return { mutationId: `m${String(store.size)}` };
    };

    const query = async (vector: ReadonlyArray<number>, options?: VectorizeQueryOptions): Promise<VectorizeMatches> => {
        const namespace = options?.namespace;
        const topK = options?.topK ?? 5;

        const scored: VectorizeMatch[] = [...store.values()]
            .filter((candidate) => namespace === undefined || candidate.namespace === namespace)
            .map((candidate) => ({
                id: candidate.id,
                metadata: options?.returnMetadata === "none" ? undefined : candidate.metadata,
                namespace: candidate.namespace,
                score: cosine(vector, candidate.values),
                values: options?.returnValues ? candidate.values : undefined,
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);

        return { count: scored.length, matches: scored };
    };

    return {
        deleteByIds: async (ids) => {
            for (const id of ids) {
                store.delete(id);
            }

            return { count: ids.length, mutationId: "d" };
        },
        getByIds: async (ids) => ids.map((id) => store.get(id)).filter((value): value is VectorizeVector => value !== undefined),
        insert: upsert,
        query,
        upsert,
    };
};

describe("spike 111: defineRag index -> retrieve composition", () => {
    const buildCtx = () => {
        const vectors = createVectors({ indexes: { docs: createMemoryIndex() } });

        return { embed: async (text: string) => embedText(text), vectors };
    };

    it("indexes a document, then retrieves ranked chunks with assembled context + source refs", async () => {
        const rag = defineRag({ chunkOverlap: 5, chunkSize: 40, index: "docs" })(buildCtx());

        const durable = await rag.index({
            id: "doc-durable",
            metadata: { title: "Durable Objects" },
            namespace: "tenant-1",
            text: "Durable Objects give Cloudflare Workers stateful single-threaded actors with persistent storage and websockets.",
        });
        await rag.index({
            id: "doc-vectorize",
            metadata: { title: "Vectorize" },
            namespace: "tenant-1",
            text: "Vectorize is an account global vector database for similarity search over embeddings.",
        });

        expect(durable.chunks).toBeGreaterThan(1);

        const result = await rag.retrieve("stateful durable objects websockets storage", { namespace: "tenant-1", topK: 3 });

        // Best match is a chunk from the durable-objects document (highest token overlap).
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.chunks[0].sourceId).toBe("doc-durable");
        // chunk <-> source metadata round-trips (id shape + user metadata preserved, internal keys stripped).
        expect(result.chunks[0].id).toMatch(/^doc-durable#\d+$/);
        expect(result.chunks[0].metadata).toEqual({ title: "Durable Objects" });
        expect(result.chunks[0].text.length).toBeGreaterThan(0);
        // assembled context carries each chunk's text under a source-attribution header,
        // and collectively covers the query's key terms across the winning document's chunks.
        expect(result.context).toMatch(/\[source:doc-durable#\d+\]/);
        expect(result.context.toLowerCase()).toContain("durable");
        expect(result.context.toLowerCase()).toContain("stateful");
        // deduped source refs, best-first.
        expect(result.sources[0]).toEqual({ id: "doc-durable", metadata: { title: "Durable Objects" } });
    });

    it("scopes retrieval by namespace (tenant isolation)", async () => {
        const rag = defineRag({ chunkSize: 200, index: "docs" })(buildCtx());

        await rag.index({ id: "a", namespace: "tenant-1", text: "alpha widgets and gadgets" });
        await rag.index({ id: "b", namespace: "tenant-2", text: "alpha widgets and gadgets" });

        const result = await rag.retrieve("alpha widgets", { namespace: "tenant-1", topK: 10 });

        expect(result.chunks.every((chunk) => chunk.sourceId === "a")).toBe(true);
    });

    it("enforces the Vectorize topK ceiling (<=20 with full metadata) via the real createVectors", async () => {
        // The helper caps its OWN default topK, but a config asking for >20 must still be
        // rejected by the real binding. Bypass the helper cap by calling the facade directly
        // with the exact args the helper would pass, to prove the ceiling is live.
        const ctx = buildCtx();

        await expect(ctx.vectors.query("docs", { embed: ctx.embed, input: "q", returnMetadata: "all", topK: 50 })).rejects.toThrow(
            /topK must be an integer in \[1, 20\]/,
        );
    });
});
