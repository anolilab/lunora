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
export type { LunoraDb, CollectionDef, InsertBinding } from "./define-collections";
export { defineCollections } from "./define-collections";
export type { Row, SyncWriter } from "./internals";
export { createOptimisticOnlineDetector, makeDiffEmit, runOutboxMutation, toMap } from "./internals";

export const VERSION = "0.0.0";
