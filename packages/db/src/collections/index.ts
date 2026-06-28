export type { CheckpointRegistry, LunoraCollectionConfig, LunoraCollectionOptions } from "../collection-options";
export { createCheckpointRegistry, lunoraCollectionOptions } from "../collection-options";

/**
 * `@lunora/db/collections` — the live-sync read path: `defineCollections` (the
 * one-shot data layer) and `lunoraCollectionOptions` (its reusable
 * collection-options core) plus the checkpoint registry. Importing this subpath
 * keeps the client-mutator runtime (`@lunora/db/mutators`) out of the bundle.
 */
export type { CollectionDef, InsertBinding, LunoraDb } from "../define-collections";
export { defineCollections } from "../define-collections";
