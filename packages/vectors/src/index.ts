export type {
    SchemaLike,
    TableDefinitionLike,
    TableVectorIndexLike,
    VectorEmbedderLike,
    VectorIndexDefinitionLike,
    VectorMatchesLike,
    VectorMatchLike,
    VectorQueryInputLike,
    VectorRecordLike,
    VectorSearchLike,
    VectorUpsertInputLike,
    WriteEvent,
    WriteHook,
} from "./context";
export { createContextVectors, createVectorSyncHook } from "./context";
export { default as createVectors } from "./create-vectors";
export type {
    CirrusVectors,
    CirrusVectorsOptions,
    EmbedFunction,
    QueryInput,
    UpsertInput,
    VectorizeDeleteMutation,
    VectorizeIndexDetails,
    VectorizeIndexLike,
    VectorizeMatch,
    VectorizeMatches,
    VectorizeQueryOptions,
    VectorizeUpsertMutation,
    VectorizeVector,
    VectorMetric,
} from "./types";
