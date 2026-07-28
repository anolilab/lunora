/**
 * `@lunora/db` — a TanStack DB binding for the Lunora client.
 *
 * `defineCollections(client, { … })` wires a set of Lunora tables into live,
 * auto-indexed TanStack DB collections (reads) plus a durable, retried
 * offline-transactions outbox (writes) in one declaration. The lower-level
 * helpers are exported for testing and advanced composition.
 *
 * Peer-depends on `@tanstack/db` and `@tanstack/offline-transactions`; the
 * consuming app pins their versions and supplies React bindings
 * (`@tanstack/react-db`) itself.
 */
export type { ChangePlan, PlanDelete, PlanInsert, PlanPatch, PlanWriter } from "./apply-plan";
export { applyPlanToCollections, applyPlanToDb } from "./apply-plan";
export type {
    CheckpointFallbackEvent,
    CheckpointRegistry,
    CheckpointRegistryOptions,
    CheckpointRegistryStats,
    CheckpointWatermark,
    LunoraCollectionConfig,
    LunoraCollectionOptions,
} from "./collection-options";
export {
    CHECKPOINT_FALLBACK_MS,
    createCheckpointRegistry,
    getShardCheckpoints,
    lunoraCollectionOptions,
    releaseShardCheckpoints,
    shardCheckpointStats,
} from "./collection-options";
export type { CollectionDef, DefineCollectionsOptions, InsertBinding, LunoraDb, WriteRejectedEvent } from "./define-collections";
export { defineCollections } from "./define-collections";
export type {
    BindMutatorsContext,
    BoundMutatorApi,
    BoundMutators,
    ClientMutatorContext,
    ClientMutatorDef,
    CollectionMap,
    MutatorReference,
    MutatorRejectedEvent,
} from "./define-mutators";
export { bindMutators, defineMutator, DIRECT_TRANSACTION_METADATA_KEY, initMutators } from "./define-mutators";
export type { ExecutorOutboxSinkOptions, OutboxExecutor, OutboxMutationMetadata, Row, SyncWriter } from "./internals";
export { createExecutorOutboxSink, createOptimisticOnlineDetector, makeDiffEmit, OUTBOX_MUTATION_FN_NAME, runOutboxMutation, toMap } from "./internals";

export const VERSION = "0.0.0";
