/**
 * Minimal structural projection of `VectorizeIndex` so unit tests can pass a
 * plain-object double and the real Cloudflare binding satisfies the same shape.
 * Mirrors the surface documented at
 * https://developers.cloudflare.com/vectorize/reference/client-api/.
 */
export interface VectorizeIndexLike {
    deleteByIds: (ids: ReadonlyArray<string>) => Promise<VectorizeDeleteMutation>;
    describe?: () => Promise<VectorizeIndexDetails>;
    getByIds: (ids: ReadonlyArray<string>) => Promise<ReadonlyArray<VectorizeVector>>;
    insert: (vectors: ReadonlyArray<VectorizeVector>) => Promise<VectorizeUpsertMutation>;
    query: (vector: ReadonlyArray<number>, options?: VectorizeQueryOptions) => Promise<VectorizeMatches>;
    upsert: (vectors: ReadonlyArray<VectorizeVector>) => Promise<VectorizeUpsertMutation>;
}

export type VectorMetric = "cosine" | "euclidean" | "dot-product";

export interface VectorizeVector {
    id: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
    values: ReadonlyArray<number>;
}

export interface VectorizeQueryOptions {
    filter?: Record<string, unknown>;
    namespace?: string;
    returnMetadata?: "none" | "indexed" | "all";
    returnValues?: boolean;
    topK?: number;
}

export interface VectorizeMatch {
    id: string;
    metadata?: Record<string, unknown>;
    namespace?: string;
    score: number;
    values?: ReadonlyArray<number>;
}

export interface VectorizeMatches {
    count: number;
    matches: ReadonlyArray<VectorizeMatch>;
}

export interface VectorizeUpsertMutation {
    mutationId: string;
}

export interface VectorizeDeleteMutation {
    count?: number;
    mutationId: string;
}

export interface VectorizeIndexDetails {
    dimensions: number;
    processedUpToDatetime?: string;
    processedUpToMutation?: string;
    vectorsCount: number;
}

/**
 * Bring-your-own-embedder: a user-supplied async fn that converts a single
 * source value (a row, a chunk, an arbitrary string) into a numeric vector.
 * The runtime calls this at upsert time so we don't couple to any provider.
 */
export type EmbedFunction<TInput = unknown> = (input: TInput) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

export interface CirrusVectorsOptions {
    /**
     * Map of logical index name -> Vectorize binding. Most apps wire one
     * binding per index; multi-index apps register all of them here so calls
     * like `vectors.query("docs-body", ...)` can resolve to the right binding.
     */
    indexes: Record<string, VectorizeIndexLike>;
}

export interface UpsertInput<TInput = unknown> {
    embed: EmbedFunction<TInput>;
    id: string;
    input: TInput;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

export interface QueryInput<TInput = unknown> {
    embed?: EmbedFunction<TInput>;
    filter?: Record<string, unknown>;
    input?: TInput;
    namespace?: string;
    returnMetadata?: "none" | "indexed" | "all";
    returnValues?: boolean;
    topK?: number;
    /** Either a precomputed vector or a value to embed via `embed`. */
    vector?: ReadonlyArray<number>;
}

export interface CirrusVectors {
    deleteByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<VectorizeDeleteMutation>;
    describe: (indexName: string) => Promise<VectorizeIndexDetails>;
    getByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<ReadonlyArray<VectorizeVector>>;
    query: <TInput>(indexName: string, input: QueryInput<TInput>) => Promise<VectorizeMatches>;
    upsert: <TInput>(indexName: string, input: UpsertInput<TInput>) => Promise<VectorizeUpsertMutation>;
    upsertMany: <TInput>(indexName: string, inputs: ReadonlyArray<UpsertInput<TInput>>) => Promise<VectorizeUpsertMutation>;
}
