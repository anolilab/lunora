/**
 * The pluggable vector-store seam.
 *
 * `defineRag` was written against Vectorize's semantics directly: its `topK`
 * ceilings, its 10 KiB per-vector metadata budget, and its 1536-dimension
 * limit were constants in the retrieval code. That made every RAG index a
 * Cloudflare index, and it is why `@lunora/platform-node` rates `vectorStore`
 * as `unsupported`.
 *
 * A store now declares its own limits and `defineRag` reads them, so a backend
 * without those constraints is not held to them: a pgvector index has no
 * dimension ceiling and no metadata budget, and should not inherit Vectorize's.
 *
 * The default is unchanged — a bound context with no `store` configured is
 * wrapped in {@link vectorizeStore}, which declares exactly the limits that
 * were previously hard-coded.
 * @experimental
 */
import type { RagVectorMatches, RagVectorQueryInput, RagVectorRecord, RagVectors, RagVectorUpsertInput } from "./types";

/**
 * What a store can hold and return. Every field is a hard limit `defineRag`
 * enforces locally, so a breach fails here — naming the store and the limit —
 * rather than at the backend with nothing saying why.
 */
interface RagVectorStoreCapabilities {
    /**
     * Ceiling on embedding dimensionality, or `false` for no limit.
     *
     * Vectorize stores at most 1536 at 32-bit precision, which rules out
     * `text-embedding-3-large` (3072) and Qwen3-Embedding (4096). A store with
     * no such limit declares `false` and those models just work.
     */
    maxDimensions: number | false;

    /**
     * Ceiling on the serialized metadata object per vector, in bytes, or
     * `false` for no limit. Covers the whole object — chunk text included when
     * no `textStore` moves it out.
     */
    maxMetadataBytes: number | false;

    /** Ceiling on `topK` when only indexed metadata is requested (text-store mode). */
    maxTopK: number;

    /** Ceiling on `topK` when the query asks for full metadata (the default mode). */
    maxTopKWithMetadata: number;
}

/**
 * The storage operations `defineRag` needs. Deliberately the same four
 * operations `RagVectors` already exposes — this is a capability-carrying
 * wrapper, not a new protocol, so adapting an existing implementation is a
 * one-liner.
 */
interface RagVectorStore {
    capabilities: RagVectorStoreCapabilities;
    deleteByIds: (ids: ReadonlyArray<string>, namespace?: string) => Promise<unknown>;
    getByIds: (ids: ReadonlyArray<string>, namespace?: string) => Promise<ReadonlyArray<RagVectorRecord>>;
    query: (input: RagVectorQueryInput) => Promise<RagVectorMatches>;
    upsert: (input: RagVectorUpsertInput) => Promise<unknown>;
}

/**
 * Vectorize's documented limits.
 *
 * `maxTopKWithMetadata` is 50, matching Vectorize V2. **Legacy V1 indexes cap
 * at 20** and reject a larger `topK` remotely; a binding handle does not expose
 * its index version, so this cannot branch on it.
 */
const VECTORIZE_CAPABILITIES: RagVectorStoreCapabilities = {
    maxDimensions: 1536,
    maxMetadataBytes: 10 * 1024,
    maxTopK: 100,
    maxTopKWithMetadata: 50,
};

/**
 * Wrap a `ctx.vectors` facade (or any {@link RagVectors}) as a store declaring
 * Vectorize's limits. This is the default when no `store` is configured, so the
 * behaviour of an existing `defineRag` is unchanged.
 * @experimental
 */
const vectorizeStore = (vectors: RagVectors, indexName: string): RagVectorStore => {
    return {
        capabilities: VECTORIZE_CAPABILITIES,
        deleteByIds: (ids, namespace) => vectors.deleteByIds(indexName, ids, namespace),
        getByIds: (ids, namespace) => vectors.getByIds(indexName, ids, namespace),
        query: (input) => vectors.query(indexName, input),
        upsert: (input) => vectors.upsert(indexName, input),
    };
};

export type { RagVectorStore, RagVectorStoreCapabilities };
export { VECTORIZE_CAPABILITIES, vectorizeStore };
