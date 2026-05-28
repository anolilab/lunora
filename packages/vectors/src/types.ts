/**
 * Minimal structural projection of `VectorizeIndex` so unit tests can pass a
 * plain-object double and the real Cloudflare binding satisfies the same shape.
 * Mirrors the surface documented at
 * https://developers.cloudflare.com/vectorize/reference/client-api/.
 */
export interface VectorizeIndexLike {
    upsert(vectors: ReadonlyArray<VectorizeVector>): Promise<VectorizeUpsertMutation>;
    insert(vectors: ReadonlyArray<VectorizeVector>): Promise<VectorizeUpsertMutation>;
    query(vector: ReadonlyArray<number>, options?: VectorizeQueryOptions): Promise<VectorizeMatches>;
    getByIds(ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>>;
    deleteByIds(ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation>;
    describe?(): Promise<VectorizeIndexDetails>;
}

export type VectorMetric = "cosine" | "euclidean" | "dot-product";

export interface VectorizeVector {
    id: string;
    values: ReadonlyArray<number>;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

export interface VectorizeQueryOptions {
    topK?: number;
    returnValues?: boolean;
    returnMetadata?: "none" | "indexed" | "all";
    namespace?: string;
    filter?: Record<string, unknown>;
}

export interface VectorizeMatch {
    id: string;
    score: number;
    values?: ReadonlyArray<number>;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

export interface VectorizeMatches {
    matches: ReadonlyArray<VectorizeMatch>;
    count: number;
}

export interface VectorizeUpsertMutation {
    mutationId: string;
}

export interface VectorizeDeleteMutation {
    mutationId: string;
    count?: number;
}

export interface VectorizeIndexDetails {
    dimensions: number;
    vectorsCount: number;
    processedUpToMutation?: string;
    processedUpToDatetime?: string;
}

/**
 * Bring-your-own-embedder: a user-supplied async fn that converts a single
 * source value (a row, a chunk, an arbitrary string) into a numeric vector.
 * The runtime calls this at upsert time so we don't couple to any provider.
 */
export type EmbedFn<TInput = unknown> = (input: TInput) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

export interface CirrusVectorsOptions {
    /**
     * Map of logical index name -> Vectorize binding. Most apps wire one
     * binding per index; multi-index apps register all of them here so calls
     * like `vectors.query("docs-body", ...)` can resolve to the right binding.
     */
    indexes: Record<string, VectorizeIndexLike>;
}

export interface UpsertInput<TInput = unknown> {
    id: string;
    input: TInput;
    embed: EmbedFn<TInput>;
    metadata?: Record<string, unknown>;
    namespace?: string;
}

export interface QueryInput<TInput = unknown> {
    /** Either a precomputed vector or a value to embed via `embed`. */
    vector?: ReadonlyArray<number>;
    input?: TInput;
    embed?: EmbedFn<TInput>;
    topK?: number;
    returnValues?: boolean;
    returnMetadata?: "none" | "indexed" | "all";
    namespace?: string;
    filter?: Record<string, unknown>;
}

export interface CirrusVectors {
    upsert<TInput>(indexName: string, input: UpsertInput<TInput>): Promise<VectorizeUpsertMutation>;
    upsertMany<TInput>(indexName: string, inputs: ReadonlyArray<UpsertInput<TInput>>): Promise<VectorizeUpsertMutation>;
    query<TInput>(indexName: string, input: QueryInput<TInput>): Promise<VectorizeMatches>;
    getByIds(indexName: string, ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorizeVector>>;
    deleteByIds(indexName: string, ids: ReadonlyArray<string>): Promise<VectorizeDeleteMutation>;
    describe(indexName: string): Promise<VectorizeIndexDetails>;
}
