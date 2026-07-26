import type {
    VectorizeDeleteMutation,
    VectorizeIndexDetails,
    VectorizeIndexLike,
    VectorizeMatches,
    VectorizeUpsertMutation,
    VectorizeVector,
} from "@lunora/platform";

/**
 * Bring-your-own-embedder: a user-supplied async fn that converts a single
 * source value (a row, a chunk, an arbitrary string) into a numeric vector.
 * The runtime calls this at upsert time so we don't couple to any provider.
 */
export type EmbedFunction<TInput = unknown> = (input: TInput) => Promise<ReadonlyArray<number>> | ReadonlyArray<number>;

export interface LunoraVectorsOptions {
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

export interface LunoraVectors {
    deleteByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<VectorizeDeleteMutation>;
    describe: (indexName: string) => Promise<VectorizeIndexDetails>;
    getByIds: (indexName: string, ids: ReadonlyArray<string>) => Promise<ReadonlyArray<VectorizeVector>>;
    query: <TInput>(indexName: string, input: QueryInput<TInput>) => Promise<VectorizeMatches>;
    upsert: <TInput>(indexName: string, input: UpsertInput<TInput>) => Promise<VectorizeUpsertMutation>;
    upsertMany: <TInput>(indexName: string, inputs: ReadonlyArray<UpsertInput<TInput>>) => Promise<VectorizeUpsertMutation>;
}



export { type VectorizeDeleteMutation, type VectorizeIndexDetails, type VectorizeIndexLike, type VectorizeMatch, type VectorizeMatches, type VectorizeQueryOptions, type VectorizeUpsertMutation, type VectorizeVector,type VectorMetric } from "@lunora/platform";
